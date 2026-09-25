import {
  type CommandResult,
  type Result,
  type TimelineEvent,
  cappyError,
  commandFailure,
  commandSuccess,
  loadConfig,
  missingCapabilities,
} from "@cappy/core";
import type { OperationOutcome } from "@cappy/protocol";
import { ManagedWorkspace } from "@cappy/workspace";
import type { CommandContext } from "../context.js";
import { launchGame } from "../game.js";
import { SessionStore } from "../sessions.js";

export interface ReplayReport {
  readonly sessionId: string;
  readonly captured: false;
  readonly events: readonly TimelineEvent[];
  readonly result?: Readonly<Record<string, unknown>>;
}

/**
 * Hand a stored session's replay payload back to the adapter and play it.
 * The payload is verified and compatibility is checked before playback
 * starts; nothing about the payload is interpreted by Cappy.
 */
export async function replay(context: CommandContext): Promise<CommandResult<ReplayReport>> {
  const options = { correlationId: context.correlationId };
  const sessionId = context.positionals[0];
  if (sessionId === undefined || context.positionals.length > 1) {
    return commandFailure("replay", cappyError("USAGE_INVALID", "usage: cappy replay <session-id> --no-capture", "replay"), options);
  }
  if (context.flags["no-capture"] !== true) {
    return commandFailure(
      "replay",
      cappyError("USAGE_INVALID", "captured replay is not available yet; pass --no-capture to verify playback", "replay", {
        details: { hint: "cappy replay <session-id> --no-capture" },
      }),
      options,
    );
  }

  const loaded = await loadConfig({ projectDir: context.projectDir, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
  if (!loaded.ok) {
    return commandFailure("replay", loaded.error, options);
  }
  const { config, projectDir } = loaded.value;
  const workspace = await ManagedWorkspace.open({ projectDir, config });
  if (!workspace.ok) {
    return commandFailure("replay", workspace.error, options);
  }
  const store = new SessionStore(workspace.value);
  const session = await store.load(sessionId);
  if (!session.ok) {
    return commandFailure("replay", session.error, options);
  }
  if (session.value.status !== "completed" || session.value.replay === undefined) {
    return commandFailure(
      "replay",
      cappyError("SESSION_NOT_REPLAYABLE", `session ${sessionId} is ${session.value.status} and has no stored replay`, "replay", {
        details: { status: session.value.status },
        retryable: false,
      }),
      options,
    );
  }
  if (session.value.projectId !== config.project.id) {
    return commandFailure(
      "replay",
      cappyError("REPLAY_INCOMPATIBLE", `session ${sessionId} belongs to project "${session.value.projectId}"`, "replay", {
        details: { recorded: session.value.projectId, current: config.project.id },
        retryable: false,
      }),
      options,
    );
  }
  // Verify the stored payload before launching anything.
  const handoff = await store.replayHandoff(session.value);
  if (!handoff.ok) {
    return commandFailure("replay", handoff.error, options);
  }

  const game = await launchGame({ config, projectDir, env: context.env });
  if (!game.ok) {
    return commandFailure("replay", game.error, options);
  }
  const { connection } = game.value;
  const interrupts = context.listenForInterrupts();
  try {
    const recorded = session.value;
    const current = connection.negotiated;
    if (current.adapter.name !== recorded.adapter.name) {
      return commandFailure(
        "replay",
        cappyError("REPLAY_INCOMPATIBLE", `session was recorded by adapter "${recorded.adapter.name}", not "${current.adapter.name}"`, "replay", {
          details: { recorded: recorded.adapter, current: current.adapter },
          retryable: false,
        }),
        options,
      );
    }
    const missing = missingCapabilities(connection.capabilities, recorded.replay?.requiredCapabilities ?? ["replay"]);
    if (missing.length > 0) {
      return commandFailure(
        "replay",
        cappyError("CAPABILITY_MISSING", `the current adapter cannot replay this session: missing ${missing.join(", ")}`, "replay", {
          details: { missing, advertised: connection.capabilities },
          retryable: false,
        }),
        options,
      );
    }
    const warnings =
      recorded.gameBuild !== undefined && current.build !== recorded.gameBuild
        ? [`session was recorded on build ${recorded.gameBuild}; replaying on ${current.build ?? "an unidentified build"}`]
        : [];

    const prepared = await connection.prepareReplay(handoff.value, { correlationId: context.correlationId, readyTimeoutMs: config.timeouts.readyMs });
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
      },
      { ...options, warnings },
    );
  } finally {
    await game.value.close();
    interrupts.dispose();
  }
}
