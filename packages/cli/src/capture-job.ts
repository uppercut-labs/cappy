import { performance } from "node:perf_hooks";
import {
  type Artifact,
  type ArtifactManifest,
  CAPPY_VERSION,
  type CappyConfig,
  type CappyError,
  type CaptureJobState,
  type CapturePreset,
  type CaptureSource,
  type CommandResult,
  type Result,
  type ScenarioParameters,
  type TimelineEvent,
  canTransition,
  cappyError,
  commandFailure,
  commandSuccess,
  loadConfig,
  newId,
} from "@cappy/core";
import { type ToolInfo, locateTool, probeMedia, produceDerivative, validateDerivatives } from "@cappy/media";
import type { ObsRecorder } from "@cappy/obs";
import type { AdapterConnection, AdapterOperation, OperationOutcome } from "@cappy/protocol";
import { ManagedWorkspace } from "@cappy/workspace";
import { prepareRecorder, publishMaster, selectPreset } from "./capture.js";
import type { CommandContext, Interrupts } from "./context.js";
import { type GameSession, launchGame } from "./game.js";
import { CommandLog, acquireRunLock, liveCorrelationIds } from "./log.js";
import { nextTake, presetFingerprint, sourceKey, successfulManifests, writeManifest } from "./manifest.js";
import { SessionStore, reconcileOrphanedSessions } from "./sessions.js";

export interface CaptureSync {
  readonly reference: "obs_recording_confirmed";
  readonly adapterOffsetMs: number;
  readonly uncertaintyMs: number;
}

export interface CaptureReport {
  readonly captureId: string;
  readonly state: CaptureJobState;
  readonly source?: CaptureSource;
  /** Present for scenario captures. */
  readonly scenario?: { readonly id: string; readonly parameters: ScenarioParameters };
  /** Session the manifest identifies: the scenario session, or the replayed session. */
  readonly sessionId?: string;
  readonly take?: number;
  readonly preset: string;
  readonly obs: { readonly version: string; readonly scene?: string };
  readonly artifacts: readonly Artifact[];
  readonly manifest?: string;
  readonly log: string;
  /** Adapter events as reported, with operation-relative times. */
  readonly events: readonly TimelineEvent[];
  /** Controller and adapter events on the master's clock. */
  readonly timeline: readonly TimelineEvent[];
  readonly sync?: CaptureSync;
}

/** Tracks the capture job state machine; illegal transitions are programming errors. */
export class JobState {
  private current: CaptureJobState = "created";
  get state(): CaptureJobState {
    return this.current;
  }
  to(next: CaptureJobState): void {
    if (!canTransition(this.current, next)) {
      throw new Error(`illegal capture job transition ${this.current} -> ${next}`);
    }
    this.current = next;
  }
}

export interface CaptureSetup {
  readonly config: CappyConfig;
  readonly projectDir: string;
  readonly workspace: ManagedWorkspace;
  readonly sessions: SessionStore;
  readonly presetName: string;
  readonly preset: CapturePreset;
  readonly tools: { readonly ffmpeg?: ToolInfo; readonly ffprobe?: ToolInfo };
  readonly recorder: ObsRecorder;
  readonly obs: { readonly version: string; readonly scene?: string };
  readonly secrets: readonly string[];
  readonly log: CommandLog;
  readonly warnings: string[];
  release(): Promise<void>;
}

/**
 * Everything a capture needs that can fail before the game launches:
 * configuration, preset and derivative options, media tools, workspace,
 * crash reconciliation, and OBS.
 */
export async function preflightCapture(
  context: CommandContext,
  command: string,
  job: JobState,
  before?: (config: CappyConfig, workspace: ManagedWorkspace, sessions: SessionStore) => Promise<Result<unknown>>,
): Promise<Result<CaptureSetup>> {
  const loaded = await loadConfig({ projectDir: context.projectDir, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
  if (!loaded.ok) {
    return loaded;
  }
  const { config, projectDir } = loaded.value;
  const selected = selectPreset(config, typeof context.flags["preset"] === "string" ? context.flags["preset"] : undefined);
  if (!selected.ok) {
    return selected;
  }
  const { name: presetName, preset } = selected.value;

  job.to("preflighting");
  const derivativeOptions = validateDerivatives(preset.derivatives);
  if (!derivativeOptions.ok) {
    return derivativeOptions;
  }
  const tools: { ffmpeg?: ToolInfo; ffprobe?: ToolInfo } = {};
  for (const tool of preset.derivatives.length > 0 ? (["ffprobe", "ffmpeg"] as const) : (["ffprobe"] as const)) {
    const located = await locateTool(tool, config.tools, { projectDir, env: context.env });
    if (!located.ok) {
      return located;
    }
    tools[tool] = located.value;
  }
  const workspace = await ManagedWorkspace.open({ projectDir, config });
  if (!workspace.ok) {
    return workspace;
  }
  const sessions = new SessionStore(workspace.value);
  const log = new CommandLog(context.correlationId);
  log.record("command.started", { command, preset: presetName });

  const warnings: string[] = [];
  const reconciled = await reconcileOrphanedSessions(sessions, workspace.value, await liveCorrelationIds(workspace.value));
  if (reconciled.length > 0) {
    warnings.push(`marked ${reconciled.length} session(s) left active by an interrupted command as failed: ${reconciled.join(", ")}`);
    log.record("sessions.reconciled", { sessions: reconciled });
  }
  if (before !== undefined) {
    const checked = await before(config, workspace.value, sessions);
    if (!checked.ok) {
      return checked;
    }
  }

  const prepared = await prepareRecorder(config, preset, context.env);
  if (!prepared.ok) {
    return prepared;
  }
  const recorder = prepared.value.recorder;
  const release = await acquireRunLock(workspace.value, context.correlationId);
  log.record("preflight.passed", { obs: recorder.obsVersion, ffprobe: tools.ffprobe?.version, ffmpeg: tools.ffmpeg?.version });
  return {
    ok: true,
    value: {
      config,
      projectDir,
      workspace: workspace.value,
      sessions,
      presetName,
      preset,
      tools,
      recorder,
      obs: { version: recorder.obsVersion, ...(prepared.value.scene === undefined ? {} : { scene: prepared.value.scene }) },
      secrets: config.obs?.passwordEnv === undefined ? [] : [context.env[config.obs.passwordEnv] ?? ""],
      log,
      warnings,
      release,
    },
  };
}

/** What a command contributes once the game is connected. */
export interface CapturePlan {
  readonly source: CaptureSource;
  readonly sessionId: string;
  /** Lifecycle event names on the master timeline, such as SCENARIO. */
  readonly label: "SCENARIO" | "REPLAY";
  /** Ask the adapter to prepare; resolves once it reports ready. */
  prepare(): Promise<Result<AdapterOperation>>;
  /** Record the job's terminal outcome, such as updating a scenario session. */
  finish?(status: "completed" | "failed" | "cancelled"): Promise<void>;
}

function parseTake(value: unknown): Result<number | undefined> {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  const take = Number(value);
  if (typeof value !== "string" || !Number.isInteger(take) || take < 1) {
    return { ok: false, error: cappyError("USAGE_INVALID", "--take must be a positive integer", "capture") };
  }
  return { ok: true, value: take };
}

/**
 * Launch the game and run one capture job end to end: plan, take, ready,
 * confirmed OBS start, operation, confirmed stop, verified master, probe,
 * derivatives, and manifest. Every exit path stops the recording Cappy
 * started, writes a diagnostic manifest once a session is known, closes the
 * game, and flushes the log.
 */
export async function executeCapture(
  context: CommandContext,
  command: string,
  setup: CaptureSetup,
  job: JobState,
  plan: (connection: AdapterConnection) => Promise<Result<CapturePlan>>,
): Promise<CommandResult<CaptureReport>> {
  const { config, workspace, recorder, log, warnings } = setup;
  const options = { correlationId: context.correlationId };
  const captureId = newId("cap");
  const directory = `captures/${captureId}`;
  const startedAt = new Date().toISOString();
  const artifacts: Artifact[] = [];
  const checks: { name: string; passed: boolean; detail?: string }[] = [];
  let events: readonly TimelineEvent[] = [];
  let timeline: TimelineEvent[] = [];
  let sync: CaptureSync | undefined;
  let captured: CapturePlan | undefined;
  let take: number | undefined;
  let manifestPath: string | undefined;
  let game: GameSession | undefined;
  let interrupts: Interrupts | undefined;
  let negotiated: AdapterConnection["negotiated"] | undefined;

  const report = (): CaptureReport => ({
    captureId,
    state: job.state,
    ...(captured === undefined ? {} : { source: captured.source, sessionId: captured.sessionId }),
    ...(captured?.source.kind === "scenario" ? { scenario: { id: captured.source.scenarioId, parameters: captured.source.parameters } } : {}),
    ...(take === undefined ? {} : { take }),
    preset: setup.presetName,
    obs: setup.obs,
    artifacts,
    ...(manifestPath === undefined ? {} : { manifest: manifestPath }),
    log: log.path,
    events,
    timeline,
    ...(sync === undefined ? {} : { sync }),
  });

  const manifest = (status: ArtifactManifest["status"], plan: CapturePlan, adapter: NonNullable<typeof negotiated>, error?: CappyError): ArtifactManifest => ({
    manifestVersion: 1,
    status,
    identity: {
      captureId,
      sessionId: plan.sessionId,
      take: take ?? 1,
      project: { id: config.project.id, name: config.project.name },
      source: plan.source,
      correlationId: context.correlationId,
    },
    build: {
      cappyVersion: CAPPY_VERSION,
      adapter: adapter.adapter,
      ...(adapter.build === undefined ? {} : { gameBuild: adapter.build }),
      protocolVersion: String(adapter.protocolVersion),
      capabilities: [...adapter.capabilities],
    },
    timing: {
      startedAt,
      endedAt: new Date().toISOString(),
      ...(sync === undefined ? {} : { sync }),
      timeline: timeline.length > 0 ? timeline : [...events],
    },
    tooling: {
      obs: { version: recorder.obsVersion, obsWebSocketVersion: recorder.obsWebSocketVersion, ...(setup.obs.scene === undefined ? {} : { scene: setup.obs.scene }) },
      ...(setup.tools.ffmpeg === undefined ? {} : { ffmpeg: { version: setup.tools.ffmpeg.version } }),
      ...(setup.tools.ffprobe === undefined ? {} : { ffprobe: { version: setup.tools.ffprobe.version } }),
      preset: { name: setup.presetName, fingerprint: presetFingerprint(setup.preset) },
    },
    artifacts,
    result: { warnings, checks, ...(error === undefined ? {} : { error: { code: error.code, message: error.message } }) },
  });

  const fail = async (error: CappyError): Promise<CommandResult<CaptureReport>> => {
    await recorder.abort(config.timeouts.obsMs);
    const cancelled = error.code === "OPERATION_CANCELLED" && job.state !== "finalizing" && job.state !== "processing";
    job.to(cancelled ? "cancelled" : "failed");
    log.record(`job.${job.state}`, { code: error.code, message: error.message });
    if (captured !== undefined && negotiated !== undefined) {
      await captured.finish?.(cancelled ? "cancelled" : "failed");
      const written = await writeManifest(workspace, directory, manifest(cancelled ? "cancelled" : "failed", captured, negotiated, error), setup.secrets);
      if (written.ok) {
        manifestPath = `${directory}/manifest.json`;
        log.record("manifest.written", { path: manifestPath, status: written.value.status });
      }
    }
    return commandFailure(command, error, { ...options, warnings, data: report() });
  };

  try {
    const takeFlag = parseTake(context.flags["take"]);
    if (!takeFlag.ok) {
      return await fail(takeFlag.error);
    }
    job.to("preparing_game");
    const launched = await launchGame({ config, projectDir: setup.projectDir, env: context.env });
    if (!launched.ok) {
      return await fail(launched.error);
    }
    game = launched.value;
    const { connection } = game;
    negotiated = connection.negotiated;
    log.record("game.connected", { adapter: negotiated.adapter, protocol: negotiated.protocolVersion, capabilities: negotiated.capabilities });
    interrupts = context.listenForInterrupts();

    const planned = await plan(connection);
    if (!planned.ok) {
      return await fail(planned.error);
    }
    captured = planned.value;

    // Takes: explicit takes must be unused; otherwise one past the highest.
    if (takeFlag.value !== undefined) {
      const key = sourceKey(captured.source);
      const used = (await successfulManifests(workspace)).some(
        (existing) => sourceKey(existing.identity.source) === key && existing.identity.take === takeFlag.value,
      );
      if (used) {
        return await fail(
          cappyError("TAKE_EXISTS", `take ${takeFlag.value} already has a successful capture; takes are never overwritten`, command, {
            details: { take: takeFlag.value },
            retryable: false,
          }),
        );
      }
      take = takeFlag.value;
    } else {
      take = await nextTake(workspace, captured.source);
    }
    log.record("take.allocated", { captureId, take, source: captured.source, sessionId: captured.sessionId });

    const prepared = await captured.prepare();
    if (!prepared.ok) {
      return await fail(prepared.error);
    }
    const operation = prepared.value;
    job.to("ready");
    log.record("operation.ready", { op: operation.id, kind: operation.kind });

    const recording = await recorder.start(config.timeouts.obsMs);
    if (!recording.ok) {
      await operation.cancel("OBS did not start recording");
      return await fail(recording.error);
    }
    const recordingConfirmed = performance.now();
    job.to("recording");
    checks.push({ name: "obs.recording.started", passed: true });
    log.record("recording.started", { requestedAt: recording.value.requestedAt.toISOString(), confirmedAt: recording.value.confirmedAt.toISOString() });
    context.progress(`Recording ${captureId} (take ${take}). Ctrl+C cancels.\n`);

    const started = await operation.start(config.timeouts.readyMs);
    if (!started.ok) {
      return await fail(started.error);
    }
    const operationStarted = performance.now();
    log.record("operation.started", { op: operation.id });

    const ending = await Promise.race([
      operation.completion.then((result) => ({ kind: "settled" as const, result })),
      interrupts.cancel.then(() => ({ kind: "cancel" as const })),
      interrupts.stop.then(() => ({ kind: "stop" as const })),
      recorder.disconnected.then((error) => ({ kind: "obs" as const, error })),
    ]);
    let outcome: Result<OperationOutcome>;
    if (ending.kind === "cancel") {
      outcome = await operation.cancel("capture cancelled by the developer");
    } else if (ending.kind === "stop") {
      operation.stop();
      outcome = await operation.completion;
    } else if (ending.kind === "obs") {
      // The recorder is gone, so the operation cannot be captured; report why.
      await operation.cancel("OBS disconnected");
      outcome = { ok: false, error: ending.error };
    } else {
      outcome = ending.result;
    }
    const operationEnded = performance.now();
    events = operation.events;
    if (!outcome.ok) {
      return await fail(outcome.error);
    }
    checks.push({ name: `${captured.label.toLowerCase()}.completed`, passed: true });
    log.record("operation.completed", { op: operation.id, events: events.length });

    job.to("finalizing");
    const stopped = await recorder.stop(config.timeouts.obsMs);
    if (!stopped.ok) {
      return await fail(stopped.error);
    }
    const recordingStopped = performance.now();
    log.record("recording.stopped", { outputPath: stopped.value });

    // Put controller and adapter events on the master's clock.
    const offset = operationStarted - recordingConfirmed;
    sync = {
      reference: "obs_recording_confirmed",
      adapterOffsetMs: round(offset),
      uncertaintyMs: Math.max(0, recording.value.confirmedAt.getTime() - recording.value.requestedAt.getTime()),
    };
    const lifecycle = (type: string, at: number): TimelineEvent => ({
      id: newId("evt"),
      source: "cappy",
      seq: 0,
      t: round(Math.max(0, at - recordingConfirmed)),
      type,
      correlationId: context.correlationId,
    });
    timeline = [
      lifecycle("RECORDING_STARTED", recordingConfirmed),
      lifecycle(`${captured.label}_STARTED`, operationStarted),
      ...events.map((event) => ({ ...event, t: round(offset + event.t) })),
      lifecycle(`${captured.label}_COMPLETED`, operationEnded),
      lifecycle("RECORDING_STOPPED", recordingStopped),
    ].map((event, seq) => ({ ...event, seq }));

    const master = await publishMaster(stopped.value, recording.value, recorder.obsVersion, workspace, directory);
    if (!master.ok) {
      return await fail(master.error);
    }
    checks.push({ name: "obs.recording.stopped", passed: true }, { name: "master.file", passed: true });
    log.record("master.published", { path: master.value.path, bytes: master.value.bytes, sha256: master.value.sha256 });

    job.to("processing");
    const masterHost = workspace.managed(master.value.path)?.hostPath ?? "";
    const probe = await probeMedia(setup.tools.ffprobe?.path ?? "ffprobe", masterHost, { timeoutMs: config.timeouts.processMs });
    if (!probe.ok) {
      artifacts.push(master.value);
      return await fail(probe.error);
    }
    artifacts.push({
      ...master.value,
      ...(probe.value.durationMs === undefined ? {} : { durationMs: probe.value.durationMs }),
      ...(probe.value.width === undefined ? {} : { width: probe.value.width }),
      ...(probe.value.height === undefined ? {} : { height: probe.value.height }),
    });
    checks.push({ name: "master.probe", passed: true, detail: `${probe.value.formatName}, ${probe.value.videoCodec ?? "unknown codec"}` });

    for (const derivative of setup.preset.derivatives) {
      const produced = await produceDerivative(derivative, { hostPath: masterHost }, workspace, directory, {
        ffmpeg: { path: setup.tools.ffmpeg?.path ?? "ffmpeg", version: setup.tools.ffmpeg?.version ?? "unknown" },
        ffprobe: setup.tools.ffprobe?.path ?? "ffprobe",
        timeoutMs: config.timeouts.processMs,
      });
      if (!produced.ok) {
        log.record("derivative.failed", { role: derivative.role, required: derivative.required, code: produced.error.code });
        if (derivative.required) {
          checks.push({ name: `derivative.${derivative.role}`, passed: false, detail: produced.error.message });
          return await fail(produced.error);
        }
        warnings.push(`optional derivative "${derivative.role}" was skipped: ${produced.error.message}`);
        continue;
      }
      const { media, ...artifact } = produced.value;
      artifacts.push(artifact);
      checks.push({ name: `derivative.${derivative.role}`, passed: true });
      log.record("derivative.published", { role: derivative.role, path: artifact.path, format: media.formatName });
    }

    await captured.finish?.("completed");
    const written = await writeManifest(workspace, directory, manifest("succeeded", captured, negotiated), setup.secrets);
    if (!written.ok) {
      return await fail(written.error);
    }
    manifestPath = `${directory}/manifest.json`;
    job.to("succeeded");
    log.record("job.succeeded", { captureId, manifest: manifestPath });
    return commandSuccess(command, report(), { ...options, warnings });
  } finally {
    await game?.close();
    recorder.close();
    interrupts?.dispose();
    log.record("command.finished", { state: job.state });
    await log.flush(workspace);
    await setup.release();
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
