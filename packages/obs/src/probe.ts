import { type CappyConfig, type CappyError, type Result, cappyError, err, ok } from "@cappy/core";
import { ObsClient } from "./client.js";

export interface ObsProbe {
  readonly obsVersion: string;
  readonly obsWebSocketVersion: string;
  readonly scenes: readonly string[];
  readonly currentScene?: string;
}

/**
 * Read the OBS password from the environment variable named in config.
 * The value never leaves this function except to authenticate.
 */
export function resolveObsPassword(
  obs: NonNullable<CappyConfig["obs"]>,
  env: NodeJS.ProcessEnv,
): Result<string | undefined> {
  if (obs.passwordEnv === undefined) {
    return ok(undefined);
  }
  const value = env[obs.passwordEnv];
  if (value === undefined || value === "") {
    return err(
      cappyError("OBS_SECRET_MISSING", `environment variable ${obs.passwordEnv} is not set`, "obs", {
        details: { passwordEnv: obs.passwordEnv },
        retryable: false,
      }),
    );
  }
  return ok(value);
}

/** Connect to OBS, read versions and scenes, and disconnect. Never mutates OBS. */
export async function probeObs(
  obs: NonNullable<CappyConfig["obs"]>,
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<Result<ObsProbe>> {
  const password = resolveObsPassword(obs, options.env);
  if (!password.ok) {
    return password;
  }
  const connected = await ObsClient.connect({
    url: obs.url,
    timeoutMs: options.timeoutMs,
    eventSubscriptions: 0,
    ...(password.value === undefined ? {} : { password: password.value }),
  });
  if (!connected.ok) {
    return connected;
  }
  const client = connected.value;
  try {
    const version = await client.request<{ obsVersion?: string; obsWebSocketVersion?: string }>("GetVersion", undefined, options.timeoutMs);
    if (!version.ok) {
      return version;
    }
    const scenes = await client.request<{ scenes?: { sceneName: string }[]; currentProgramSceneName?: string }>(
      "GetSceneList",
      undefined,
      options.timeoutMs,
    );
    if (!scenes.ok) {
      return scenes;
    }
    return ok({
      obsVersion: version.value.obsVersion ?? "unknown",
      obsWebSocketVersion: version.value.obsWebSocketVersion ?? client.obsWebSocketVersion,
      scenes: (scenes.value.scenes ?? []).map((scene) => scene.sceneName),
      ...(scenes.value.currentProgramSceneName === undefined ? {} : { currentScene: scenes.value.currentProgramSceneName }),
    });
  } finally {
    client.close();
  }
}

/** Scenes the project config expects OBS to provide. */
export function expectedScenes(config: Pick<CappyConfig, "obs" | "presets">): string[] {
  const scenes = new Set<string>();
  if (config.obs?.scene !== undefined) {
    scenes.add(config.obs.scene);
  }
  for (const preset of Object.values(config.presets)) {
    if (preset.scene !== undefined) {
      scenes.add(preset.scene);
    }
  }
  return [...scenes];
}

export function missingScenesError(missing: readonly string[], available: readonly string[]): CappyError {
  return cappyError("OBS_SCENE_MISSING", `OBS has no scene named ${missing.map((scene) => `"${scene}"`).join(", ")}`, "obs", {
    details: { missing, available },
    retryable: false,
  });
}
