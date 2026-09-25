import {
  type Artifact,
  type CappyError,
  type CaptureJobState,
  type CommandResult,
  type Result,
  type ScenarioParameters,
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
import type { ObsRecorder } from "@cappy/obs";
import type { OperationOutcome } from "@cappy/protocol";
import { ManagedWorkspace } from "@cappy/workspace";
import { collectMaster, prepareRecorder, selectPreset } from "../capture.js";
import type { CommandContext } from "../context.js";
import { launchGame } from "../game.js";

export interface RunReport {
  readonly captureId: string;
  /** Job state reached. Derivatives and the manifest follow in processing. */
  readonly state: CaptureJobState;
  readonly scenario: { readonly id: string; readonly parameters: ScenarioParameters };
  readonly preset: string;
  readonly obs: { readonly version: string; readonly scene?: string };
  readonly master?: Artifact;
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

/**
 * Capture an authored scenario: preflight OBS, launch the game, prepare the
 * scenario, confirm OBS is recording, run the scenario, confirm OBS stopped,
 * and move the verified master into the managed workspace.
 */
export async function run(context: CommandContext): Promise<CommandResult<RunReport>> {
  const options = { correlationId: context.correlationId };
  const scenarioId = context.positionals[0];
  if (scenarioId === undefined || context.positionals.length > 1) {
    return commandFailure("run", cappyError("USAGE_INVALID", "usage: cappy run <scenario> [--param key=value]... [--preset name]", "run"), options);
  }
  const job = new JobState();
  const captureId = newId("cap");

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

  job.to("preflighting");
  const workspace = await ManagedWorkspace.open({ projectDir, config });
  if (!workspace.ok) {
    return commandFailure("run", workspace.error, options);
  }
  // OBS is checked before the game launches so a broken recorder never
  // costs a game start.
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
  const interrupts = context.listenForInterrupts();
  let events: readonly TimelineEvent[] = [];
  let parameters: ScenarioParameters = {};

  const report = (master?: Artifact): RunReport => ({
    captureId,
    state: job.state,
    scenario: { id: scenarioId, parameters },
    preset: presetName,
    obs: obsInfo,
    ...(master === undefined ? {} : { master }),
    events,
  });
  const fail = async (error: CappyError): Promise<CommandResult<RunReport>> => {
    await recorder.abort(config.timeouts.obsMs);
    job.to(error.code === "OPERATION_CANCELLED" && job.state !== "finalizing" && job.state !== "processing" ? "cancelled" : "failed");
    return commandFailure("run", error, { ...options, data: report() });
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
    context.progress(`Recording ${scenarioId} as ${captureId}. Ctrl+C cancels.\n`);

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

    job.to("finalizing");
    const master = await collectMaster(recorder, recording.value, workspace.value, `captures/${captureId}`, config.timeouts.obsMs);
    if (!master.ok) {
      job.to("failed");
      return commandFailure("run", master.error, { ...options, data: report() });
    }
    if (events.length > 0) {
      await workspace.value.writeManaged(`captures/${captureId}/timeline.json`, `${JSON.stringify(events, null, 2)}\n`, { role: "timeline" });
    }
    job.to("processing");
    return commandSuccess("run", report(master.value), {
      ...options,
      warnings: ["derivatives and the capture manifest are not produced yet; the master is verified and stored"],
    });
  } finally {
    await game.value.close();
    recorder.close();
    interrupts.dispose();
  }
}
