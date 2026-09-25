import path from "node:path";
import {
  type CappyConfig,
  type ChildExit,
  ManagedProcess,
  type Result,
  cappyError,
  err,
  ok,
  resolveExecutable,
} from "@cappy/core";
import { type AdapterConnection, AdapterServer, type HeartbeatOptions } from "@cappy/protocol";

/** A launched game with a negotiated adapter connection. */
export interface GameSession {
  readonly connection: AdapterConnection;
  readonly process: ManagedProcess;
  /** Disconnect, stop the game process tree, and close the listener. */
  close(): Promise<ChildExit>;
}

export interface LaunchOptions {
  readonly config: CappyConfig;
  readonly projectDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly heartbeat?: HeartbeatOptions;
}

export function gameWorkingDirectory(config: CappyConfig, projectDir: string): string {
  return config.game.cwd === undefined ? projectDir : path.resolve(projectDir, config.game.cwd);
}

/**
 * Start the adapter listener, launch the configured game with the endpoint
 * and session token in its environment, and wait for the handshake.
 */
export async function launchGame(options: LaunchOptions): Promise<Result<GameSession>> {
  const { config, projectDir, env } = options;
  const cwd = gameWorkingDirectory(config, projectDir);
  const executable = await resolveExecutable(config.game.command, { cwd, env });
  if (executable === undefined) {
    return err(
      cappyError("GAME_LAUNCH_FAILED", `game command "${config.game.command}" was not found`, "game.launch", {
        details: { command: config.game.command, cwd },
        retryable: false,
      }),
    );
  }

  const listening = await AdapterServer.listen({
    host: config.adapter.host,
    port: config.adapter.port,
    requiredCapabilities: config.adapter.requiredCapabilities,
    ...(options.heartbeat === undefined ? {} : { heartbeat: options.heartbeat }),
  });
  if (!listening.ok) {
    return listening;
  }
  const server = listening.value;

  let game: ManagedProcess;
  try {
    game = ManagedProcess.start(executable, config.game.args, { cwd, env: { ...env, ...server.launchEnvironment() } });
  } catch (cause) {
    await server.close();
    return err(
      cappyError("GAME_LAUNCH_FAILED", `could not start "${executable}"`, "game.launch", {
        details: { command: executable, cause: String(cause) },
      }),
    );
  }

  const outcome = await Promise.race([
    server.accept(config.timeouts.connectMs).then((result) => ({ kind: "accepted" as const, result })),
    game.exited.then((exit) => ({ kind: "exited" as const, exit })),
  ]);

  if (outcome.kind === "exited" || !outcome.result.ok) {
    await game.stop(0);
    await server.close();
    if (outcome.kind === "accepted" && !outcome.result.ok) {
      return outcome.result;
    }
    const exit = outcome.kind === "exited" ? outcome.exit : await game.exited;
    if (exit.spawnError !== undefined) {
      return err(
        cappyError("GAME_LAUNCH_FAILED", `could not start "${executable}": ${exit.spawnError}`, "game.launch", {
          details: { command: executable, spawnError: exit.spawnError },
        }),
      );
    }
    return err(
      cappyError("GAME_EXITED", "the game exited before its adapter connected", "game.launch", {
        details: { command: executable, exitCode: exit.exitCode, signal: exit.signal, stderr: exit.stderrTail.slice(-1000) },
      }),
    );
  }

  const connection = outcome.result.value;
  return ok({
    connection,
    process: game,
    async close() {
      connection.close();
      const exit = await game.stop();
      await server.close();
      return exit;
    },
  });
}
