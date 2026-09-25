import { stat } from "node:fs/promises";
import path from "node:path";
import { type CappyConfig, type CappyError, type Result, cappyError, err, ok } from "@cappy/core";
import { OBS_EVENTS_OUTPUTS, ObsClient } from "./client.js";
import { resolveObsPassword } from "./probe.js";

/**
 * Every OBS request Cappy may send. Nothing here creates, deletes, or edits
 * scenes, sources, profiles, or settings (ADR-011).
 */
export const ALLOWED_OBS_REQUESTS = new Set([
  "GetVersion",
  "GetSceneList",
  "GetRecordStatus",
  "GetRecordDirectory",
  "StartRecord",
  "StopRecord",
  "SetCurrentProgramScene",
]);

const OPERATION = "obs.record";
const POLL_MS = 50;

function recordError(
  code: "OBS_ALREADY_RECORDING" | "OBS_START_FAILED" | "OBS_STOP_FAILED" | "OBS_SCENE_MISSING" | "MASTER_MISSING" | "MASTER_INVALID",
  message: string,
  details?: Record<string, unknown>,
): CappyError {
  return cappyError(code, message, OPERATION, details === undefined ? {} : { details });
}

export interface RecordingStarted {
  /** Wall-clock time Cappy asked OBS to start; the master must be newer. */
  readonly requestedAt: Date;
  /** Wall-clock time OBS confirmed the output active. */
  readonly confirmedAt: Date;
}

export interface VerifiedMaster {
  readonly path: string;
  readonly bytes: number;
}

/**
 * Controls OBS recording for one capture. Success is never inferred from a
 * request being sent: start and stop are confirmed through OBS output state,
 * and the master file is verified on disk.
 */
export class ObsRecorder {
  /** Set once this recorder started a recording that it has not stopped. */
  private owned = false;
  private lastOutputPath: string | undefined;

  private constructor(
    private readonly client: ObsClient,
    readonly obsVersion: string,
    readonly obsWebSocketVersion: string,
  ) {
    client.onEvent((event) => {
      if (event.eventType === "RecordStateChanged" && typeof event.eventData?.["outputPath"] === "string") {
        this.lastOutputPath = event.eventData["outputPath"];
      }
    });
  }

  static async connect(obs: NonNullable<CappyConfig["obs"]>, options: { env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<Result<ObsRecorder>> {
    const password = resolveObsPassword(obs, options.env);
    if (!password.ok) {
      return password;
    }
    const connected = await ObsClient.connect({
      url: obs.url,
      timeoutMs: options.timeoutMs,
      eventSubscriptions: OBS_EVENTS_OUTPUTS,
      ...(password.value === undefined ? {} : { password: password.value }),
    });
    if (!connected.ok) {
      return connected;
    }
    const version = await connected.value.request<{ obsVersion?: string; obsWebSocketVersion?: string }>("GetVersion", undefined, options.timeoutMs);
    if (!version.ok) {
      connected.value.close();
      return version;
    }
    return ok(
      new ObsRecorder(
        connected.value,
        version.value.obsVersion ?? "unknown",
        version.value.obsWebSocketVersion ?? connected.value.obsWebSocketVersion,
      ),
    );
  }

  /** True while a recording this recorder started is still running. */
  get recording(): boolean {
    return this.owned;
  }

  get disconnected(): Promise<CappyError> {
    return this.client.disconnected;
  }

  /**
   * Check that the capture scene exists and OBS is idle, and switch to the
   * scene only when the project explicitly enables it.
   */
  async prepare(scene: string | undefined, options: { switchScene: boolean; timeoutMs: number }): Promise<Result<{ scene?: string }>> {
    const scenes = await this.request<{ scenes?: { sceneName: string }[]; currentProgramSceneName?: string }>("GetSceneList", undefined, options.timeoutMs);
    if (!scenes.ok) {
      return scenes;
    }
    const available = (scenes.value.scenes ?? []).map((entry) => entry.sceneName);
    if (scene !== undefined && !available.includes(scene)) {
      return err(recordError("OBS_SCENE_MISSING", `OBS has no scene named "${scene}"`, { scene, available }));
    }
    const status = await this.request<{ outputActive?: boolean }>("GetRecordStatus", undefined, options.timeoutMs);
    if (!status.ok) {
      return status;
    }
    if (status.value.outputActive === true) {
      return err(recordError("OBS_ALREADY_RECORDING", "OBS is already recording; Cappy will not take over a recording it did not start"));
    }
    if (scene !== undefined && options.switchScene && scenes.value.currentProgramSceneName !== scene) {
      const switched = await this.request("SetCurrentProgramScene", { sceneName: scene }, options.timeoutMs);
      if (!switched.ok) {
        return switched;
      }
    }
    const current = scene ?? scenes.value.currentProgramSceneName;
    return ok(current === undefined ? {} : { scene: current });
  }

  /** Start recording and wait until OBS reports the output active. */
  async start(timeoutMs: number): Promise<Result<RecordingStarted>> {
    this.lastOutputPath = undefined;
    const requestedAt = new Date();
    const started = await this.request("StartRecord", undefined, timeoutMs);
    if (!started.ok) {
      return err(recordError("OBS_START_FAILED", `OBS refused to start recording: ${started.error.message}`, { cause: started.error.code }));
    }
    // From here the recording may be running; make sure stop() attempts cleanup.
    this.owned = true;
    const active = await this.waitForActive(true, timeoutMs);
    if (!active.ok) {
      return err(recordError("OBS_START_FAILED", `OBS did not confirm recording within ${timeoutMs} ms`, { cause: active.error.code }));
    }
    return ok({ requestedAt, confirmedAt: new Date() });
  }

  /** Stop recording, wait until OBS reports the output inactive, and return the master path. */
  async stop(timeoutMs: number): Promise<Result<string>> {
    const stopped = await this.request<{ outputPath?: string }>("StopRecord", undefined, timeoutMs);
    if (!stopped.ok) {
      return err(recordError("OBS_STOP_FAILED", `OBS refused to stop recording: ${stopped.error.message}`, { cause: stopped.error.code }));
    }
    const inactive = await this.waitForActive(false, timeoutMs);
    if (!inactive.ok) {
      return err(recordError("OBS_STOP_FAILED", `OBS did not confirm the recording stopped within ${timeoutMs} ms`, { cause: inactive.error.code }));
    }
    this.owned = false;
    const outputPath = stopped.value.outputPath ?? this.lastOutputPath;
    if (outputPath === undefined || outputPath === "") {
      return err(recordError("MASTER_MISSING", "OBS did not report where it wrote the recording"));
    }
    return ok(outputPath);
  }

  /**
   * Best-effort stop for cancellation and failure paths. Only stops a
   * recording this recorder started.
   */
  async abort(timeoutMs: number): Promise<void> {
    if (this.owned) {
      await this.stop(timeoutMs);
    }
  }

  close(): void {
    this.client.close();
  }

  private async waitForActive(active: boolean, timeoutMs: number): Promise<Result<true>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.request<{ outputActive?: boolean }>("GetRecordStatus", undefined, Math.max(1, deadline - Date.now()));
      if (!status.ok) {
        return status;
      }
      if (status.value.outputActive === active) {
        return ok(true);
      }
      if (Date.now() + POLL_MS > deadline) {
        return err(recordError(active ? "OBS_START_FAILED" : "OBS_STOP_FAILED", "timed out waiting for OBS output state"));
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  private request<T extends Record<string, unknown>>(requestType: string, data: Record<string, unknown> | undefined, timeoutMs: number): Promise<Result<T>> {
    if (!ALLOWED_OBS_REQUESTS.has(requestType)) {
      throw new Error(`OBS request ${requestType} is not allowed`);
    }
    return this.client.request<T>(requestType, data, timeoutMs);
  }
}

/**
 * Verify the master OBS wrote: an absolute path to a regular, non-empty file
 * written during this recording whose size has stopped changing.
 */
export async function verifyMaster(outputPath: string, recordingStartedAt: Date, options: { settleMs?: number } = {}): Promise<Result<VerifiedMaster>> {
  if (!path.isAbsolute(outputPath)) {
    return err(recordError("MASTER_INVALID", "OBS reported a relative recording path", { path: outputPath }));
  }
  const first = await stat(outputPath).catch(() => undefined);
  if (first === undefined) {
    return err(recordError("MASTER_MISSING", `the recording OBS reported does not exist: ${outputPath}`, { path: outputPath }));
  }
  if (!first.isFile() || first.size === 0) {
    return err(recordError("MASTER_INVALID", "the recording OBS reported is empty or not a file", { path: outputPath, bytes: first.size }));
  }
  // Allow for filesystem timestamp granularity.
  if (first.mtimeMs < recordingStartedAt.getTime() - 2_000) {
    return err(recordError("MASTER_INVALID", "the recording OBS reported predates this capture", { path: outputPath }));
  }
  await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 200));
  const second = await stat(outputPath).catch(() => undefined);
  if (second?.size !== first.size) {
    return err(recordError("MASTER_INVALID", "the recording is still being written", { path: outputPath }));
  }
  return ok({ path: outputPath, bytes: second.size });
}
