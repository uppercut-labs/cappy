import path from "node:path";
import {
  type Artifact,
  type CappyConfig,
  type CapturePreset,
  type Result,
  cappyError,
  err,
  ok,
} from "@cappy/core";
import { ObsRecorder, type RecordingStarted, verifyMaster } from "@cappy/obs";
import type { ManagedWorkspace } from "@cappy/workspace";

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".mkv": "video/x-matroska",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".flv": "video/x-flv",
  ".ts": "video/mp2t",
  ".webm": "video/webm",
};

export function mediaTypeFor(file: string): string {
  return MEDIA_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** The preset selected for a capture; an empty implicit preset when none are configured. */
export function selectPreset(config: CappyConfig, requested: string | undefined): Result<{ name: string; preset: CapturePreset }> {
  const name = requested ?? config.defaultPreset;
  if (name === undefined) {
    return ok({ name: "default", preset: { derivatives: [], requiredCapabilities: [], presentation: {} } });
  }
  const preset = config.presets[name];
  if (preset === undefined) {
    return err(
      cappyError("PRESET_NOT_FOUND", `capture preset "${name}" is not defined`, "capture", {
        details: { preset: name, available: Object.keys(config.presets) },
        retryable: false,
      }),
    );
  }
  return ok({ name, preset });
}

/** OBS preflight: connect, validate the scene, and confirm OBS is idle. */
export async function prepareRecorder(
  config: CappyConfig,
  preset: CapturePreset,
  env: NodeJS.ProcessEnv,
): Promise<Result<{ recorder: ObsRecorder; scene?: string }>> {
  const obs = config.obs;
  if (obs === undefined) {
    return err(cappyError("OBS_NOT_CONFIGURED", "capture needs an obs section in cappy.config.json", "capture", { retryable: false }));
  }
  const connected = await ObsRecorder.connect(obs, { env, timeoutMs: config.timeouts.obsMs });
  if (!connected.ok) {
    return connected;
  }
  const prepared = await connected.value.prepare(preset.scene ?? obs.scene, { switchScene: obs.switchScene, timeoutMs: config.timeouts.obsMs });
  if (!prepared.ok) {
    connected.value.close();
    return prepared;
  }
  return ok({ recorder: connected.value, ...(prepared.value.scene === undefined ? {} : { scene: prepared.value.scene }) });
}

/**
 * Stop OBS, verify the master it wrote, and move it into the managed
 * workspace as `<directory>/master<ext>`, registered with size and hash.
 */
export async function collectMaster(
  recorder: ObsRecorder,
  started: RecordingStarted,
  workspace: ManagedWorkspace,
  directory: string,
  timeoutMs: number,
): Promise<Result<Artifact>> {
  const stopped = await recorder.stop(timeoutMs);
  if (!stopped.ok) {
    return stopped;
  }
  const verified = await verifyMaster(stopped.value, started.requestedAt);
  if (!verified.ok) {
    return verified;
  }
  const published = await workspace.publishFile(verified.value.path, `${directory}/master${path.extname(verified.value.path).toLowerCase()}`, {
    move: true,
    role: "master",
  });
  if (!published.ok) {
    return published;
  }
  return ok({
    role: "master",
    path: published.value.path,
    ownership: "managed",
    mediaType: mediaTypeFor(published.value.path),
    bytes: published.value.entry.bytes,
    sha256: published.value.entry.sha256,
    source: { tool: "obs", version: recorder.obsVersion },
  });
}
