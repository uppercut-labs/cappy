import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import {
  type CappyError,
  type CappyConfig,
  type CommandResult,
  type LoadedConfig,
  cappyError,
  commandFailure,
  commandSuccess,
  loadConfig,
  resolveExecutable,
  selectBuild,
} from "@cappy/core";
import { locateTool } from "@cappy/media";
import { expectedScenes, probeObs } from "@cappy/obs";
import { ManagedWorkspace, checkGitIgnore, resolveWorkspaceRoot, unsafeRootReason } from "@cappy/workspace";
import { gameWorkingDirectory } from "../game.js";
import type { CommandContext } from "../context.js";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly summary: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface DoctorReport {
  readonly project?: { readonly id: string; readonly name: string };
  readonly checks: readonly DoctorCheck[];
}

function check(id: string, status: CheckStatus, summary: string, details?: Record<string, unknown>): DoctorCheck {
  return { id, status, summary, ...(details === undefined ? {} : { details }) };
}

function fromError(id: string, error: CappyError): DoctorCheck {
  return check(id, "fail", error.message, { code: error.code, ...(error.details ?? {}) });
}

/**
 * Check configuration, workspace, game command, FFmpeg/ffprobe, and OBS
 * without launching the game or recording anything.
 */
export async function doctor(context: CommandContext): Promise<CommandResult<DoctorReport>> {
  const checks: DoctorCheck[] = [];
  const loaded = await loadConfig({ projectDir: context.projectDir, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
  if (!loaded.ok) {
    checks.push(fromError("config", loaded.error));
    return commandFailure("doctor", loaded.error, { correlationId: context.correlationId, data: { checks } });
  }
  const { config, configPath, projectDir }: LoadedConfig = loaded.value;
  checks.push(check("config", "pass", `${configPath} is valid`, { configPath }));

  // Managed workspace.
  const { root, isDefault } = resolveWorkspaceRoot(projectDir, config);
  const unsafe = unsafeRootReason(projectDir, root);
  if (unsafe !== undefined) {
    checks.push(check("workspace.root", "fail", unsafe, { root }));
    checks.push(check("workspace", "skip", "skipped because the managed root is unsafe"));
  } else {
    checks.push(check("workspace.root", "pass", `managed root is ${root}`, { root, default: isDefault }));
    const opened = await ManagedWorkspace.open({ projectDir, config });
    if (!opened.ok) {
      checks.push(fromError("workspace", opened.error));
    } else {
      try {
        await access(opened.value.root, constants.W_OK);
        checks.push(check("workspace", "pass", `${opened.value.root} is writable`));
      } catch {
        checks.push(check("workspace", "fail", `${opened.value.root} is not writable`));
      }
      if (isDefault) {
        const ignored = await checkGitIgnore(projectDir, opened.value.root);
        checks.push(
          ignored.warning === undefined
            ? check("workspace.gitignore", "pass", `Git ignore status: ${ignored.status.replaceAll("_", " ")}`)
            : check("workspace.gitignore", "warn", ignored.warning),
        );
      }
    }
  }

  // Game launch command: the base game, then every named build (SPEC 6).
  const gameCheck = async (id: string, launched: CappyConfig): Promise<DoctorCheck> => {
    const cwd = gameWorkingDirectory(launched, projectDir);
    const cwdOk = await stat(cwd).then(
      (stats) => stats.isDirectory(),
      () => false,
    );
    const executable = cwdOk ? await resolveExecutable(launched.game.command, { cwd, env: context.env }) : undefined;
    return !cwdOk
      ? check(id, "fail", `game working directory ${cwd} does not exist`, { cwd })
      : executable === undefined
        ? check(id, "fail", `game command "${launched.game.command}" was not found`, { command: launched.game.command, cwd })
        : check(id, "pass", `game command resolves to ${executable}`, { path: executable });
  };
  checks.push(await gameCheck("game", config));
  for (const name of Object.keys(config.builds)) {
    const selected = selectBuild(config, name);
    if (selected.ok) {
      checks.push(await gameCheck(`game.${name}`, selected.value));
    }
  }

  // FFmpeg and ffprobe.
  for (const tool of ["ffmpeg", "ffprobe"] as const) {
    const located = await locateTool(tool, config.tools, { projectDir, env: context.env });
    checks.push(
      located.ok
        ? check(tool, "pass", `${tool} ${located.value.version}`, { path: located.value.path, version: located.value.version })
        : fromError(tool, located.error),
    );
  }

  // OBS.
  const scenes = expectedScenes(config);
  if (config.obs === undefined) {
    checks.push(check("obs", "skip", "OBS is not configured"));
  } else {
    const probe = await probeObs(config.obs, { env: context.env, timeoutMs: config.timeouts.obsMs });
    if (!probe.ok) {
      checks.push(fromError("obs", probe.error));
      if (scenes.length > 0) {
        checks.push(check("obs.scenes", "skip", "skipped because OBS is unavailable"));
      }
    } else {
      checks.push(
        check("obs", "pass", `OBS ${probe.value.obsVersion} (WebSocket ${probe.value.obsWebSocketVersion}) at ${config.obs.url}`, {
          obsVersion: probe.value.obsVersion,
          obsWebSocketVersion: probe.value.obsWebSocketVersion,
        }),
      );
      if (scenes.length > 0) {
        const missing = scenes.filter((scene) => !probe.value.scenes.includes(scene));
        checks.push(
          missing.length === 0
            ? check("obs.scenes", "pass", `OBS has scene${scenes.length === 1 ? "" : "s"} ${scenes.map((scene) => `"${scene}"`).join(", ")}`)
            : check("obs.scenes", "fail", `OBS is missing scene${missing.length === 1 ? "" : "s"} ${missing.map((scene) => `"${scene}"`).join(", ")}`, {
                missing,
                available: probe.value.scenes,
              }),
        );
      }
    }
  }

  const report: DoctorReport = { project: { id: config.project.id, name: config.project.name }, checks };
  const failed = checks.filter((entry) => entry.status === "fail");
  const warnings = checks.filter((entry) => entry.status === "warn").map((entry) => entry.summary);
  if (failed.length > 0) {
    const error = cappyError("DOCTOR_CHECKS_FAILED", `${failed.length} check(s) failed: ${failed.map((entry) => entry.id).join(", ")}`, "doctor", {
      details: { failed: failed.map((entry) => entry.id) },
    });
    return commandFailure("doctor", error, { correlationId: context.correlationId, warnings, data: report });
  }
  return commandSuccess("doctor", report, { correlationId: context.correlationId, warnings });
}
