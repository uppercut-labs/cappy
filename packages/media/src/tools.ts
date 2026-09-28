import { type CappyConfig, type Result, cappyError, err, ok, resolveExecutable, runProcess } from "@uppercut-labs/cappy-internal-core";

export type MediaTool = "ffmpeg" | "ffprobe";

export interface ToolInfo {
  readonly tool: MediaTool;
  /** Resolved executable path. */
  readonly path: string;
  readonly version: string;
}

/**
 * Find FFmpeg or ffprobe (a configured override, else PATH) and read its
 * version. Cappy never downloads or installs these tools.
 */
export async function locateTool(
  tool: MediaTool,
  tools: CappyConfig["tools"],
  options: { projectDir: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<Result<ToolInfo>> {
  const configured = tools[tool];
  const command = configured ?? tool;
  const env = options.env ?? process.env;
  const executable = await resolveExecutable(command, { cwd: options.projectDir, env });
  if (executable === undefined) {
    return err(
      cappyError(
        "TOOL_NOT_FOUND",
        configured === undefined ? `${tool} was not found on PATH` : `configured ${tool} "${configured}" does not exist or is not executable`,
        "media.locate",
        { details: { tool, command }, retryable: false },
      ),
    );
  }
  const run = await runProcess(executable, ["-hide_banner", "-version"], { env, timeoutMs: options.timeoutMs ?? 10_000 });
  const match = new RegExp(`^${tool} version (\\S+)`, "m").exec(run.stdout);
  if (run.exitCode !== 0 || match?.[1] === undefined) {
    return err(
      cappyError("TOOL_FAILED", `${executable} did not report a ${tool} version`, "media.locate", {
        details: {
          tool,
          path: executable,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          ...(run.spawnError === undefined ? {} : { spawnError: run.spawnError }),
          stderr: run.stderr.slice(-500),
        },
      }),
    );
  }
  return ok({ tool, path: executable, version: match[1] });
}
