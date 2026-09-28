import {
  type CommandResult,
  type Result,
  type Session,
  cappyError,
  commandFailure,
  err,
  missingCapabilities,
  presentationCapabilities,
  ok,
  resolveScenarioParameters,
} from "@uppercut-labs/cappy-internal-core";
import type { AdapterConnection } from "@uppercut-labs/cappy-internal-protocol";
import { type CaptureReport, type CapturePlan, JobState, type CaptureSetup, executeCapture, preflightCapture } from "../capture-job.js";
import type { CommandContext } from "../context.js";
import { newSessionId } from "../sessions.js";

export type RunReport = CaptureReport;

/**
 * Capture an authored scenario through the full pipeline. The scenario and
 * its parameters are validated against the adapter's registry, and the run
 * is recorded as a scenario session that the manifest references.
 */
export async function run(context: CommandContext): Promise<CommandResult<RunReport>> {
  const options = { correlationId: context.correlationId };
  const scenarioId = context.positionals[0];
  if (scenarioId === undefined || context.positionals.length > 1) {
    return commandFailure(
      "run",
      cappyError("USAGE_INVALID", "usage: cappy run <scenario> [--param key=value]... [--preset name] [--take n]", "run"),
      options,
    );
  }
  const job = new JobState();
  const setup = await preflightCapture(context, "run", job);
  if (!setup.ok) {
    return commandFailure("run", setup.error, options);
  }
  return executeCapture(context, "run", setup.value, job, (connection) => planScenario(context, setup.value, connection, scenarioId));
}

async function planScenario(context: CommandContext, setup: CaptureSetup, connection: AdapterConnection, scenarioId: string): Promise<Result<CapturePlan>> {
  const { config, preset, sessions } = setup;
  const missing = missingCapabilities(connection.capabilities, ["scenarios", ...preset.requiredCapabilities, ...presentationCapabilities(preset.presentation)]);
  if (missing.length > 0) {
    return err(cappyError("CAPABILITY_MISSING", `the adapter lacks ${missing.join(", ")}`, "run", { details: { missing, advertised: connection.capabilities } }));
  }
  const listed = await connection.listScenarios(config.timeouts.readyMs);
  if (!listed.ok) {
    return listed;
  }
  const scenario = listed.value.find((candidate) => candidate.id === scenarioId);
  if (scenario === undefined) {
    return err(
      cappyError("SCENARIO_NOT_FOUND", `the game has no scenario "${scenarioId}"`, "run", {
        details: { available: listed.value.map((candidate) => candidate.id) },
        retryable: false,
      }),
    );
  }
  const scenarioMissing = missingCapabilities(connection.capabilities, scenario.requiredCapabilities);
  if (scenarioMissing.length > 0) {
    return err(cappyError("CAPABILITY_MISSING", `scenario "${scenarioId}" needs ${scenarioMissing.join(", ")}`, "run", { details: { missing: scenarioMissing } }));
  }
  const assignments = context.flags["param"];
  const parameters = resolveScenarioParameters(scenario, Array.isArray(assignments) ? assignments : []);
  if (!parameters.ok) {
    return parameters;
  }

  const negotiated = connection.negotiated;
  const created = await sessions.save({
    schemaVersion: 1,
    id: newSessionId(),
    projectId: config.project.id,
    origin: "scenario",
    scenario: { id: scenarioId, parameters: parameters.value },
    startedAt: new Date().toISOString(),
    adapter: negotiated.adapter,
    ...(negotiated.build === undefined ? {} : { gameBuild: negotiated.build }),
    capabilities: [...negotiated.capabilities],
    status: "active",
    correlationId: context.correlationId,
  });
  if (!created.ok) {
    return created;
  }
  let session: Session = created.value;

  return ok({
    source: { kind: "scenario", scenarioId, parameters: parameters.value },
    sessionId: session.id,
    label: "SCENARIO",
    prepare: () =>
      connection.prepareScenario(scenarioId, parameters.value, {
        correlationId: context.correlationId,
        readyTimeoutMs: config.timeouts.readyMs,
        ...(Object.keys(preset.presentation).length === 0 ? {} : { presentation: preset.presentation }),
      }),
    async finish(status) {
      session = { ...session, status, endedAt: new Date().toISOString() };
      await sessions.save(session);
    },
  });
}
