import { type LoadedConfig, type Result, loadConfig, ok, selectBuild } from "@uppercut-labs/cappy-internal-core";
import type { CommandContext } from "./context.js";

/** The build named with `--build`, if any. */
export function requestedBuild(context: CommandContext): string | undefined {
  const build = context.flags["build"];
  return typeof build === "string" ? build : undefined;
}

/**
 * Load the project configuration for a command that launches the game, with
 * the build named by `--build` applied to `game` (SPEC 6). An unknown build
 * fails with `BUILD_NOT_FOUND` before anything launches.
 */
export async function loadCommandConfig(context: CommandContext): Promise<Result<LoadedConfig>> {
  const loaded = await loadConfig({ projectDir: context.projectDir, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
  if (!loaded.ok) {
    return loaded;
  }
  const selected = selectBuild(loaded.value.config, requestedBuild(context));
  return selected.ok ? ok({ ...loaded.value, config: selected.value }) : selected;
}
