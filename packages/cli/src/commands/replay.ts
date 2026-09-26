import {
  type CappyConfig,
  type CommandResult,
  type Result,
  type Session,
  type TimelineEvent,
  cappyError,
  commandFailure,
  commandSuccess,
  err,
  missingCapabilities,
  ok,
} from "@cappy/core";
import type { AdapterConnection, OperationOutcome, ReplayHandoff } from "@cappy/protocol";
import { ManagedWorkspace } from "@cappy/workspace";
import { type CaptureReport, JobState, executeCapture, preflightCapture } from "../capture-job.js";
import type { CommandContext } from "../context.js";
import { launchGame } from "../game.js";
import { CommandLog } from "../log.js";
import { SessionStore } from "../sessions.js";
import { loadCommandConfig } from "../project.js";

export interface PlaybackReport {
  readonly sessionId: string;
  readonly captured: false;
  readonly events: readonly TimelineEvent[];
  readonly result?: Readonly<Record<string, unknown>>;
  readonly log: string;
}

export type ReplayReport = PlaybackReport | (CaptureReport & { readonly captured: true });

interface Replayable {
  readonly session: Session;
  readonly handoff: ReplayHandoff;
}

/**
 * Load a stored session and verify it can be replayed: completed, owned by
 * this project, and with a payload that still matches its SHA-256. Runs
 * before the game launches.
 */
async function loadReplayable(store: SessionStore, sessionId: string, config: CappyConfig): Promise<Result<Replayable>> {
  const session = await store.load(sessionId);
  if (!session.ok) {
    return session;
  }
  if (session.value.status !== "completed" || session.value.replay === undefined) {
    return err(
      cappyError("SESSION_NOT_REPLAYABLE", `session ${sessionId} is ${session.value.status} and has no stored replay`, "replay", {
        details: { status: session.value.status },
        retryable: false,
      }),
    );
  }
  if (session.value.projectId !== config.project.id) {
    return err(
      cappyError("REPLAY_INCOMPATIBLE", `session ${sessionId} belongs to project "${session.value.projectId}"`, "replay", {
        details: { recorded: session.value.projectId, current: config.project.id },
        retryable: false,
      }),
    );
  }
  const handoff = await store.replayHandoff(session.value);
  return handoff.ok ? ok({ session: session.value, handoff: handoff.value }) : handoff;
}

/** Check the connected adapter can replay the session; returns warnings. */
function checkCompatibility(recorded: Session, connection: AdapterConnection): Result<string[]> {
  const current = connection.negotiated;
  if (current.adapter.name !== recorded.adapter.name) {
    return err(
      cappyError("REPLAY_INCOMPATIBLE", `session was recorded by adapter "${recorded.adapter.name}", not "${current.adapter.name}"`, "replay", {
        details: { recorded: recorded.adapter, current: current.adapter },
        retryable: false,
      }),
    );
  }
  const missing = missingCapabilities(connection.capabilities, recorded.replay?.requiredCapabilities ?? ["replay"]);
  if (missing.length > 0) {
    return err(
      cappyError("CAPABILITY_MISSING", `the current adapter cannot replay this session: missing ${missing.join(", ")}`, "replay", {
        details: { missing, advertised: connection.capabilities },
        retryable: false,
      }),
    );
  }
  return ok(
    recorded.gameBuild !== undefined && current.build !== recorded.gameBuild
      ? [`session was recorded on build ${recorded.gameBuild}; replaying on ${current.build ?? "an unidentified build"}`]
      : [],
  );
}

/**
 * Replay a stored session. By default the replay is captured through the
 * same pipeline as `run`; `--no-capture` only verifies playback.
 */
export async function replay(context: CommandContext): Promise<CommandResult<ReplayReport>> {
  const sessionId = context.positionals[0];
  if (sessionId === undefined || context.positionals.length > 1) {
    return commandFailure(
      "replay",
      cappyError("USAGE_INVALID", "usage: cappy replay <session-id> [--preset name] [--take n] [--no-capture]", "replay"),
      { correlationId: context.correlationId },
    );
  }
  return context.flags["no-capture"] === true ? playback(context, sessionId) : capture(context, sessionId);
}

async function capture(context: CommandContext, sessionId: string): Promise<CommandResult<ReplayReport>> {
  const job = new JobState();
  let replayable: Replayable | undefined;
  const setup = await preflightCapture(context, "replay", job, async (config, _workspace, sessions) => {
    const loaded = await loadReplayable(sessions, sessionId, config);
    if (loaded.ok) {
      replayable = loaded.value;
    }
    return loaded;
  });
  if (!setup.ok) {
    return commandFailure("replay", setup.error, { correlationId: context.correlationId });
  }
  if (replayable === undefined) {
    return commandFailure("replay", cappyError("INTERNAL_ERROR", "replay preflight produced no session", "replay"), {
      correlationId: context.correlationId,
    });
  }
  const { session, handoff } = replayable;
  const result = await executeCapture(context, "replay", setup.value, job, async (connection) => {
    const compatible = checkCompatibility(session, connection);
    if (!compatible.ok) {
      return compatible;
    }
    setup.value.warnings.push(...compatible.value);
    return ok({
      source: { kind: "replay" as const, sessionId },
      sessionId,
      label: "REPLAY" as const,
      prepare: () => connection.prepareReplay(handoff, { correlationId: context.correlationId, readyTimeoutMs: setup.value.config.timeouts.readyMs }),
    });
  });
  const options = { correlationId: result.correlationId, warnings: result.warnings };
  if (result.ok) {
    return commandSuccess("replay", { ...result.data, captured: true }, options);
  }
  return commandFailure("replay", result.error, { ...options, ...(result.data === undefined ? {} : { data: { ...result.data, captured: true as const } }) });
}

async function playback(context: CommandContext, sessionId: string): Promise<CommandResult<ReplayReport>> {
  const options = { correlationId: context.correlationId };
  const loaded = await loadCommandConfig(context);
  if (!loaded.ok) {
    return commandFailure("replay", loaded.error, options);
  }
  const { config, projectDir } = loaded.value;
  const workspace = await ManagedWorkspace.open({ projectDir, config });
  if (!workspace.ok) {
    return commandFailure("replay", workspace.error, options);
  }
  const replayable = await loadReplayable(new SessionStore(workspace.value), sessionId, config);
  if (!replayable.ok) {
    return commandFailure("replay", replayable.error, options);
  }
  const log = new CommandLog(context.correlationId);
  log.record("command.started", { command: "replay", sessionId, capture: false });

  const game = await launchGame({ config, projectDir, env: context.env });
  if (!game.ok) {
    return commandFailure("replay", game.error, options);
  }
  const { connection } = game.value;
  const interrupts = context.listenForInterrupts();
  try {
    const compatible = checkCompatibility(replayable.value.session, connection);
    if (!compatible.ok) {
      return commandFailure("replay", compatible.error, options);
    }
    const warnings = compatible.value;
    const prepared = await connection.prepareReplay(replayable.value.handoff, {
      correlationId: context.correlationId,
      readyTimeoutMs: config.timeouts.readyMs,
    });
    if (!prepared.ok) {
      return commandFailure("replay", prepared.error, { ...options, warnings });
    }
    const operation = prepared.value;
    const started = await operation.start(config.timeouts.readyMs);
    if (!started.ok) {
      return commandFailure("replay", started.error, { ...options, warnings });
    }
    context.progress(`Replaying session ${sessionId}. Press Enter to stop, Ctrl+C to cancel.\n`);

    const outcome = await Promise.race<Result<OperationOutcome>>([
      operation.completion,
      interrupts.cancel.then(() => operation.cancel("replay cancelled by the developer")),
      interrupts.stop.then(() => {
        operation.stop();
        return operation.completion;
      }),
    ]);
    log.record(outcome.ok ? "replay.completed" : "replay.failed", outcome.ok ? { events: outcome.value.events.length } : { code: outcome.error.code });
    if (!outcome.ok) {
      return commandFailure("replay", outcome.error, { ...options, warnings });
    }
    return commandSuccess(
      "replay",
      {
        sessionId,
        captured: false,
        events: outcome.value.events,
        ...(outcome.value.result === undefined ? {} : { result: outcome.value.result }),
        log: log.path,
      },
      { ...options, warnings },
    );
  } finally {
    await game.value.close();
    interrupts.dispose();
    log.record("command.finished", {});
    await log.flush(workspace.value);
  }
}
