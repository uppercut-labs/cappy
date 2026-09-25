import {
  type Artifact,
  type CappyError,
  type CommandResult,
  type Result,
  type Session,
  cappyError,
  commandFailure,
  commandSuccess,
  loadConfig,
  missingCapabilities,
} from "@cappy/core";
import type { ObsRecorder, RecordingStarted } from "@cappy/obs";
import type { AdapterOperation, OperationOutcome } from "@cappy/protocol";
import { ManagedWorkspace } from "@cappy/workspace";
import { collectMaster, prepareRecorder, selectPreset } from "../capture.js";
import type { CommandContext } from "../context.js";
import { launchGame } from "../game.js";
import { SessionStore, newSessionId, replayRequirements } from "../sessions.js";

export interface RecordReport {
  readonly session: Session;
  readonly replayable: boolean;
  readonly events: number;
  /** The verified OBS master when recorded with --capture. */
  readonly master?: Artifact;
}

function parseDuration(value: string | boolean | readonly string[] | undefined): Result<number | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  const seconds = Number(value);
  if (typeof value !== "string" || !Number.isFinite(seconds) || seconds <= 0) {
    return { ok: false, error: cappyError("USAGE_INVALID", "--duration must be a positive number of seconds", "record") };
  }
  return { ok: true, value: Math.round(seconds * 1000) };
}

type Ending = { kind: "stop" } | { kind: "cancel" } | { kind: "settled"; result: Result<OperationOutcome> };

/**
 * Record a freeform session: the developer plays normally while the adapter
 * records its own replay data. Ends on stop (Enter or --duration), adapter
 * completion, cancellation (Ctrl+C), or failure.
 */
export async function record(context: CommandContext): Promise<CommandResult<RecordReport>> {
  const options = { correlationId: context.correlationId };
  const duration = parseDuration(context.flags["duration"]);
  if (!duration.ok) {
    return commandFailure("record", duration.error, options);
  }
  const loaded = await loadConfig({ projectDir: context.projectDir, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
  if (!loaded.ok) {
    return commandFailure("record", loaded.error, options);
  }
  const { config, projectDir } = loaded.value;
  const workspace = await ManagedWorkspace.open({ projectDir, config });
  if (!workspace.ok) {
    return commandFailure("record", workspace.error, options);
  }
  const store = new SessionStore(workspace.value);

  // Optional OBS master capture, preflighted before the game launches.
  let recorder: ObsRecorder | undefined;
  if (context.flags["capture"] === true) {
    const selected = selectPreset(config, typeof context.flags["preset"] === "string" ? context.flags["preset"] : undefined);
    if (!selected.ok) {
      return commandFailure("record", selected.error, options);
    }
    const prepared = await prepareRecorder(config, selected.value.preset, context.env);
    if (!prepared.ok) {
      return commandFailure("record", prepared.error, options);
    }
    recorder = prepared.value.recorder;
  }

  const game = await launchGame({ config, projectDir, env: context.env });
  if (!game.ok) {
    recorder?.close();
    return commandFailure("record", game.error, options);
  }
  const { connection } = game.value;
  const interrupts = context.listenForInterrupts();
  try {
    const missing = missingCapabilities(connection.capabilities, ["freeform_recording"]);
    if (missing.length > 0) {
      return commandFailure(
        "record",
        cappyError("CAPABILITY_MISSING", "the adapter does not support freeform recording", "record", {
          details: { missing, advertised: connection.capabilities },
          retryable: false,
        }),
        options,
      );
    }

    const negotiated = connection.negotiated;
    let session: Session = {
      schemaVersion: 1,
      id: newSessionId(),
      projectId: config.project.id,
      origin: "freeform",
      startedAt: new Date().toISOString(),
      adapter: negotiated.adapter,
      ...(negotiated.build === undefined ? {} : { gameBuild: negotiated.build }),
      capabilities: [...negotiated.capabilities],
      status: "active",
      correlationId: context.correlationId,
    };
    const created = await store.save(session);
    if (!created.ok) {
      return commandFailure("record", created.error, options);
    }

    const finish = async (status: "completed" | "failed" | "cancelled", operation?: AdapterOperation, extra: Partial<Session> = {}): Promise<Session> => {
      if (operation !== undefined && operation.events.length > 0) {
        await store.saveTimeline(session.id, operation.events);
      }
      session = { ...session, ...extra, status, endedAt: new Date().toISOString() };
      await store.save(session);
      return session;
    };
    const fail = async (error: CappyError, operation?: AdapterOperation): Promise<CommandResult<RecordReport>> => {
      await recorder?.abort(config.timeouts.obsMs);
      const status = error.code === "OPERATION_CANCELLED" ? "cancelled" : "failed";
      const saved = await finish(status, operation);
      return commandFailure("record", error, {
        ...options,
        data: { session: saved, replayable: false, events: operation?.events.length ?? 0 },
      });
    };

    let recording: RecordingStarted | undefined;
    if (recorder !== undefined) {
      const confirmed = await recorder.start(config.timeouts.obsMs);
      if (!confirmed.ok) {
        return await fail(confirmed.error);
      }
      recording = confirmed.value;
    }

    const started = await connection.startFreeform({ correlationId: context.correlationId, startTimeoutMs: config.timeouts.readyMs });
    if (!started.ok) {
      return await fail(started.error);
    }
    const operation = started.value;
    context.progress(
      `Recording session ${session.id}${duration.value === undefined ? "" : ` for ${duration.value / 1000}s`}. Press Enter to stop, Ctrl+C to cancel.\n`,
    );

    const timers: NodeJS.Timeout[] = [];
    const ending = await Promise.race<Ending>([
      interrupts.stop.then(() => ({ kind: "stop" as const })),
      interrupts.cancel.then(() => ({ kind: "cancel" as const })),
      operation.completion.then((result) => ({ kind: "settled" as const, result })),
      ...(duration.value === undefined
        ? []
        : [new Promise<Ending>((resolve) => timers.push(setTimeout(() => resolve({ kind: "stop" }), duration.value)))]),
    ]);
    timers.forEach(clearTimeout);

    let outcome: Result<OperationOutcome>;
    if (ending.kind === "cancel") {
      outcome = await operation.cancel("recording cancelled by the developer");
    } else if (ending.kind === "stop") {
      operation.stop();
      const timeout = new Promise<"timeout">((resolve) => timers.push(setTimeout(() => resolve("timeout"), config.timeouts.readyMs)));
      const settled = await Promise.race([operation.completion, interrupts.cancel.then(() => "cancel" as const), timeout]);
      timers.forEach(clearTimeout);
      if (settled === "cancel") {
        outcome = await operation.cancel("recording cancelled by the developer");
      } else if (settled === "timeout") {
        await operation.cancel("adapter did not finish the recording");
        outcome = {
          ok: false,
          error: cappyError("OPERATION_TIMEOUT", `adapter did not finish the recording within ${config.timeouts.readyMs} ms`, "record"),
        };
      } else {
        outcome = settled;
      }
    } else {
      outcome = ending.result;
    }
    if (!outcome.ok) {
      return await fail(outcome.error, operation);
    }

    let master: Artifact | undefined;
    if (recorder !== undefined && recording !== undefined) {
      const collected = await collectMaster(recorder, recording, workspace.value, `sessions/${session.id}`, config.timeouts.obsMs);
      if (!collected.ok) {
        return await fail(collected.error, operation);
      }
      master = collected.value;
    }
    const withMaster = master === undefined ? {} : { master };

    const handoff = outcome.value.replay;
    const advertisesReplay = connection.capabilities.includes("replay");
    if (handoff === undefined) {
      if (advertisesReplay) {
        return await fail(
          cappyError("REPLAY_PAYLOAD_MISSING", "the adapter advertises replay but returned no replay payload", "record", { retryable: false }),
          operation,
        );
      }
      const saved = await finish("completed", operation);
      return commandSuccess(
        "record",
        { session: saved, replayable: false, events: operation.events.length, ...withMaster },
        { ...options, warnings: ["the adapter does not support replay; this session cannot be replayed"] },
      );
    }
    const stored = await store.storeReplay(session.id, handoff, replayRequirements(connection.capabilities));
    if (!stored.ok) {
      return await fail(stored.error, operation);
    }
    const saved = await finish("completed", operation, { replay: stored.value });
    return commandSuccess("record", { session: saved, replayable: true, events: operation.events.length, ...withMaster }, options);
  } finally {
    await game.value.close();
    recorder?.close();
    interrupts.dispose();
  }
}
