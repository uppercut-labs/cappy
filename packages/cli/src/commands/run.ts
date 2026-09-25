import {
  type Artifact,
  type ArtifactManifest,
  CAPPY_VERSION,
  type CappyError,
  type CaptureJobState,
  type CaptureSource,
  type CommandResult,
  type Result,
  type ScenarioParameters,
  type Session,
  type TimelineEvent,
  canTransition,
  cappyError,
  commandFailure,
  commandSuccess,
  loadConfig,
  missingCapabilities,
  newId,
  resolveScenarioParameters,
} from "@cappy/core";
import { type ToolInfo, locateTool, probeMedia, produceDerivative, validateDerivatives } from "@cappy/media";
import type { ObsRecorder } from "@cappy/obs";
import type { NegotiatedAdapter, OperationOutcome } from "@cappy/protocol";
import { ManagedWorkspace } from "@cappy/workspace";
import { collectMaster, prepareRecorder, selectPreset } from "../capture.js";
import type { CommandContext } from "../context.js";
import { launchGame } from "../game.js";
import { nextTake, presetFingerprint, writeManifest } from "../manifest.js";
import { SessionStore, newSessionId } from "../sessions.js";

export interface RunReport {
  readonly captureId: string;
  readonly state: CaptureJobState;
  readonly sessionId?: string;
  readonly take?: number;
  readonly scenario: { readonly id: string; readonly parameters: ScenarioParameters };
  readonly preset: string;
  readonly obs: { readonly version: string; readonly scene?: string };
  readonly artifacts: readonly Artifact[];
  /** Path of the written manifest, relative to the managed root. */
  readonly manifest?: string;
  readonly events: readonly TimelineEvent[];
}

/** Tracks the capture job state machine; illegal transitions are programming errors. */
class JobState {
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

interface Check {
  name: string;
  passed: boolean;
  detail?: string;
}

/**
 * Capture an authored scenario: preflight OBS and media tools, launch the
 * game, prepare the scenario, confirm OBS is recording, run the scenario,
 * confirm OBS stopped, verify the master, produce derivatives, and write the
 * manifest. The job succeeds only when every required step passes.
 */
export async function run(context: CommandContext): Promise<CommandResult<RunReport>> {
  const options = { correlationId: context.correlationId };
  const scenarioId = context.positionals[0];
  if (scenarioId === undefined || context.positionals.length > 1) {
    return commandFailure("run", cappyError("USAGE_INVALID", "usage: cappy run <scenario> [--param key=value]... [--preset name]", "run"), options);
  }
  const job = new JobState();
  const captureId = newId("cap");
  const directory = `captures/${captureId}`;
  const startedAt = new Date().toISOString();

  const loaded = await loadConfig({ projectDir: context.projectDir, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
  if (!loaded.ok) {
    return commandFailure("run", loaded.error, options);
  }
  const { config, projectDir } = loaded.value;
  const selected = selectPreset(config, typeof context.flags["preset"] === "string" ? context.flags["preset"] : undefined);
  if (!selected.ok) {
    return commandFailure("run", selected.error, options);
  }
  const { name: presetName, preset } = selected.value;
  const secrets = config.obs?.passwordEnv === undefined ? [] : [context.env[config.obs.passwordEnv] ?? ""];

  // Preflight everything that can fail without the game: derivative options,
  // media tools, workspace, and OBS.
  job.to("preflighting");
  const derivativeOptions = validateDerivatives(preset.derivatives);
  if (!derivativeOptions.ok) {
    return commandFailure("run", derivativeOptions.error, options);
  }
  const tools: { ffmpeg?: ToolInfo; ffprobe?: ToolInfo } = {};
  for (const tool of preset.derivatives.length > 0 ? (["ffprobe", "ffmpeg"] as const) : (["ffprobe"] as const)) {
    const located = await locateTool(tool, config.tools, { projectDir, env: context.env });
    if (!located.ok) {
      return commandFailure("run", located.error, options);
    }
    tools[tool] = located.value;
  }
  const workspace = await ManagedWorkspace.open({ projectDir, config });
  if (!workspace.ok) {
    return commandFailure("run", workspace.error, options);
  }
  const sessions = new SessionStore(workspace.value);
  const prepared = await prepareRecorder(config, preset, context.env);
  if (!prepared.ok) {
    return commandFailure("run", prepared.error, options);
  }
  const recorder: ObsRecorder = prepared.value.recorder;
  const obsInfo = { version: recorder.obsVersion, ...(prepared.value.scene === undefined ? {} : { scene: prepared.value.scene }) };

  job.to("preparing_game");
  const game = await launchGame({ config, projectDir, env: context.env });
  if (!game.ok) {
    recorder.close();
    return commandFailure("run", game.error, options);
  }
  const { connection } = game.value;
  const negotiated: NegotiatedAdapter = connection.negotiated;
  const interrupts = context.listenForInterrupts();

  let events: readonly TimelineEvent[] = [];
  let parameters: ScenarioParameters = {};
  let session: Session | undefined;
  let take: number | undefined;
  const artifacts: Artifact[] = [];
  const checks: Check[] = [];
  const warnings: string[] = [];
  let manifestPath: string | undefined;

  const source = (): CaptureSource => ({ kind: "scenario", scenarioId, parameters });
  const report = (): RunReport => ({
    captureId,
    state: job.state,
    ...(session === undefined ? {} : { sessionId: session.id }),
    ...(take === undefined ? {} : { take }),
    scenario: { id: scenarioId, parameters },
    preset: presetName,
    obs: obsInfo,
    artifacts,
    ...(manifestPath === undefined ? {} : { manifest: manifestPath }),
    events,
  });

  const manifest = (status: ArtifactManifest["status"], error?: CappyError): ArtifactManifest => ({
    manifestVersion: 1,
    status,
    identity: {
      captureId,
      sessionId: session?.id ?? "none",
      take: take ?? 1,
      project: { id: config.project.id, name: config.project.name },
      source: source(),
      correlationId: context.correlationId,
    },
    build: {
      cappyVersion: CAPPY_VERSION,
      adapter: negotiated.adapter,
      ...(negotiated.build === undefined ? {} : { gameBuild: negotiated.build }),
      protocolVersion: String(negotiated.protocolVersion),
      capabilities: [...negotiated.capabilities],
    },
    timing: { startedAt, endedAt: new Date().toISOString(), timeline: [...events] },
    tooling: {
      obs: { version: recorder.obsVersion, obsWebSocketVersion: recorder.obsWebSocketVersion, ...(obsInfo.scene === undefined ? {} : { scene: obsInfo.scene }) },
      ...(tools.ffmpeg === undefined ? {} : { ffmpeg: { version: tools.ffmpeg.version } }),
      ...(tools.ffprobe === undefined ? {} : { ffprobe: { version: tools.ffprobe.version } }),
      preset: { name: presetName, fingerprint: presetFingerprint(preset) },
    },
    artifacts,
    result: {
      warnings,
      checks,
      ...(error === undefined ? {} : { error: { code: error.code, message: error.message } }),
    },
  });

  /** End the job non-successfully, leaving a diagnostic manifest once a session exists. */
  const fail = async (error: CappyError): Promise<CommandResult<RunReport>> => {
    await recorder.abort(config.timeouts.obsMs);
    const cancelled = error.code === "OPERATION_CANCELLED" && job.state !== "finalizing" && job.state !== "processing";
    job.to(cancelled ? "cancelled" : "failed");
    if (session !== undefined) {
      session = { ...session, status: cancelled ? "cancelled" : "failed", endedAt: new Date().toISOString() };
      await sessions.save(session);
      const written = await writeManifest(workspace.value, directory, manifest(cancelled ? "cancelled" : "failed", error), secrets);
      if (written.ok) {
        manifestPath = `${directory}/manifest.json`;
      }
    }
    return commandFailure("run", error, { ...options, warnings, data: report() });
  };

  try {
    const missing = missingCapabilities(connection.capabilities, ["scenarios", ...preset.requiredCapabilities]);
    if (missing.length > 0) {
      return await fail(
        cappyError("CAPABILITY_MISSING", `the adapter lacks ${missing.join(", ")}`, "run", { details: { missing, advertised: connection.capabilities } }),
      );
    }
    const listed = await connection.listScenarios(config.timeouts.readyMs);
    if (!listed.ok) {
      return await fail(listed.error);
    }
    const scenario = listed.value.find((candidate) => candidate.id === scenarioId);
    if (scenario === undefined) {
      return await fail(
        cappyError("SCENARIO_NOT_FOUND", `the game has no scenario "${scenarioId}"`, "run", {
          details: { available: listed.value.map((candidate) => candidate.id) },
          retryable: false,
        }),
      );
    }
    const scenarioMissing = missingCapabilities(connection.capabilities, scenario.requiredCapabilities);
    if (scenarioMissing.length > 0) {
      return await fail(
        cappyError("CAPABILITY_MISSING", `scenario "${scenarioId}" needs ${scenarioMissing.join(", ")}`, "run", { details: { missing: scenarioMissing } }),
      );
    }
    const assignments = context.flags["param"];
    const resolved = resolveScenarioParameters(scenario, Array.isArray(assignments) ? assignments : []);
    if (!resolved.ok) {
      return await fail(resolved.error);
    }
    parameters = resolved.value;
    take = await nextTake(workspace.value, source());

    const created = await sessions.save({
      schemaVersion: 1,
      id: newSessionId(),
      projectId: config.project.id,
      origin: "scenario",
      scenario: { id: scenarioId, parameters },
      startedAt,
      adapter: negotiated.adapter,
      ...(negotiated.build === undefined ? {} : { gameBuild: negotiated.build }),
      capabilities: [...negotiated.capabilities],
      status: "active",
      correlationId: context.correlationId,
    });
    if (!created.ok) {
      return await fail(created.error);
    }
    session = created.value;

    const preparedScenario = await connection.prepareScenario(scenarioId, parameters, {
      correlationId: context.correlationId,
      readyTimeoutMs: config.timeouts.readyMs,
      ...(Object.keys(preset.presentation).length === 0 ? {} : { presentation: preset.presentation }),
    });
    if (!preparedScenario.ok) {
      return await fail(preparedScenario.error);
    }
    const operation = preparedScenario.value;
    job.to("ready");

    const recording = await recorder.start(config.timeouts.obsMs);
    if (!recording.ok) {
      await operation.cancel("OBS did not start recording");
      return await fail(recording.error);
    }
    job.to("recording");
    checks.push({ name: "obs.recording.started", passed: true });
    context.progress(`Recording ${scenarioId} as ${captureId} (take ${take}). Ctrl+C cancels.\n`);

    const startedScenario = await operation.start(config.timeouts.readyMs);
    if (!startedScenario.ok) {
      return await fail(startedScenario.error);
    }
    const ending = await Promise.race([
      operation.completion.then((result) => ({ kind: "settled" as const, result })),
      interrupts.cancel.then(() => ({ kind: "cancel" as const })),
      recorder.disconnected.then((error) => ({ kind: "obs" as const, error })),
    ]);
    let outcome: Result<OperationOutcome>;
    if (ending.kind === "cancel") {
      outcome = await operation.cancel("capture cancelled by the developer");
    } else if (ending.kind === "obs") {
      // The recorder is gone, so the scenario cannot be captured; report why.
      await operation.cancel("OBS disconnected");
      outcome = { ok: false, error: ending.error };
    } else {
      outcome = ending.result;
    }
    events = operation.events;
    if (!outcome.ok) {
      return await fail(outcome.error);
    }
    checks.push({ name: "scenario.completed", passed: true });

    job.to("finalizing");
    const master = await collectMaster(recorder, recording.value, workspace.value, directory, config.timeouts.obsMs);
    if (!master.ok) {
      return await fail(master.error);
    }
    checks.push({ name: "obs.recording.stopped", passed: true }, { name: "master.file", passed: true });

    job.to("processing");
    const masterHost = workspace.value.managed(master.value.path)?.hostPath ?? "";
    const probe = await probeMedia(tools.ffprobe?.path ?? "ffprobe", masterHost, { timeoutMs: config.timeouts.processMs });
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

    for (const derivative of preset.derivatives) {
      const produced = await produceDerivative(derivative, { hostPath: masterHost }, workspace.value, directory, {
        ffmpeg: { path: tools.ffmpeg?.path ?? "ffmpeg", version: tools.ffmpeg?.version ?? "unknown" },
        ffprobe: tools.ffprobe?.path ?? "ffprobe",
        timeoutMs: config.timeouts.processMs,
      });
      if (!produced.ok) {
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
    }

    session = { ...session, status: "completed", endedAt: new Date().toISOString() };
    await sessions.save(session);
    const written = await writeManifest(workspace.value, directory, manifest("succeeded"), secrets);
    if (!written.ok) {
      return await fail(written.error);
    }
    manifestPath = `${directory}/manifest.json`;
    job.to("succeeded");
    return commandSuccess("run", report(), { ...options, warnings });
  } finally {
    await game.value.close();
    recorder.close();
    interrupts.dispose();
  }
}
