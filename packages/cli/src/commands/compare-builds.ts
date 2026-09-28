import { BASE_BUILD, type CommandResult, cappyError, commandFailure, commandSuccess, loadConfig, newCorrelationId, selectBuild } from "@uppercut-labs/cappy-internal-core";
import type { CommandContext } from "../context.js";
import { type CompareReport, compare, parseGates } from "./compare.js";
import { type ReplayReport, replay } from "./replay.js";
import { type RunReport, run } from "./run.js";

const COMMAND = "compare-builds";
const SESSION_ID = /^ses_/;
const GATE_FLAGS = ["min-ssim", "min-frame-ssim", "max-drift-ms", "require-same-events"] as const;

export interface CompareBuildsReport {
  readonly builds: { readonly a: string; readonly b: string };
  readonly a?: RunReport | ReplayReport;
  readonly b?: RunReport | ReplayReport;
  readonly comparison?: CompareReport;
}

function usage(message: string, correlationId: string): CommandResult<CompareBuildsReport> {
  return commandFailure(
    COMMAND,
    cappyError("USAGE_INVALID", message, COMMAND, {
      details: { usage: "cappy compare-builds <session-id | scenario> <build-a> <build-b> [--param key=value]... [--preset name] [gates]" },
      retryable: false,
    }),
    { correlationId },
  );
}

/**
 * Capture one session (as replays) or scenario (as runs) with two named
 * builds, then compare the captures (SPEC 11.9). Each step is the standalone
 * command, so every artifact is an ordinary capture or comparison; the first
 * failed step ends the command.
 */
export async function compareBuilds(context: CommandContext): Promise<CommandResult<CompareBuildsReport>> {
  const { correlationId } = context;
  const [source, buildA, buildB, ...extra] = context.positionals;
  if (source === undefined || buildA === undefined || buildB === undefined || extra.length > 0) {
    return usage("compare-builds takes a session ID or scenario and two build names", correlationId);
  }
  if (buildA === buildB) {
    return usage("compare-builds needs two different builds", correlationId);
  }
  if (typeof context.flags["build"] === "string") {
    return usage("compare-builds names its builds as arguments; --build does not apply", correlationId);
  }
  if (context.flags["no-capture"] === true) {
    return usage("compare-builds compares captures, so --no-capture does not apply", correlationId);
  }
  const gates = parseGates(context.flags);
  if (!gates.ok) {
    return usage(gates.error, correlationId);
  }
  const builds = { a: buildA, b: buildB };

  // Both builds must exist before anything launches.
  const loaded = await loadConfig({ projectDir: context.projectDir, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
  if (!loaded.ok) {
    return commandFailure(COMMAND, loaded.error, { correlationId, data: { builds } });
  }
  for (const name of [buildA, buildB]) {
    const selected = selectBuild(loaded.value.config, name);
    if (!selected.ok) {
      return commandFailure(COMMAND, selected.error, { correlationId, data: { builds } });
    }
  }

  const replaying = SESSION_ID.test(source);
  // Gates belong to the comparison, not to the captures.
  const captureFlags = Object.fromEntries(Object.entries(context.flags).filter(([name]) => !(GATE_FLAGS as readonly string[]).includes(name)));
  const captureWith = async (build: string): Promise<CommandResult<RunReport | ReplayReport>> => {
    const step: CommandContext = {
      ...context,
      correlationId: newCorrelationId(),
      positionals: [source],
      flags: { ...captureFlags, build: build === BASE_BUILD ? undefined : build },
    };
    context.progress(`Capturing ${replaying ? `a replay of ${source}` : `scenario ${source}`} with build ${build}.\n`);
    return replaying ? (replay(step) as Promise<CommandResult<RunReport | ReplayReport>>) : run(step);
  };

  const a = await captureWith(buildA);
  if (!a.ok) {
    return commandFailure(COMMAND, a.error, { correlationId, warnings: a.warnings, data: { builds, ...(a.data === undefined ? {} : { a: a.data }) } });
  }
  const b = await captureWith(buildB);
  if (!b.ok) {
    return commandFailure(COMMAND, b.error, {
      correlationId,
      warnings: [...a.warnings, ...b.warnings],
      data: { builds, a: a.data, ...(b.data === undefined ? {} : { b: b.data }) },
    });
  }
  const captureIdOf = (result: RunReport | ReplayReport): string | undefined => ("captureId" in result ? result.captureId : undefined);
  const idA = captureIdOf(a.data);
  const idB = captureIdOf(b.data);
  if (idA === undefined || idB === undefined) {
    return commandFailure(COMMAND, cappyError("INTERNAL_ERROR", "a build capture produced no capture ID", COMMAND), { correlationId, data: { builds, a: a.data, b: b.data } });
  }

  const compared = await compare({
    ...context,
    correlationId: newCorrelationId(),
    positionals: [idA, idB],
    flags: Object.fromEntries(GATE_FLAGS.map((gate) => [gate, context.flags[gate]])),
  });
  const data: CompareBuildsReport = { builds, a: a.data, b: b.data, ...(compared.data === undefined ? {} : { comparison: compared.data }) };
  const warnings = [...a.warnings, ...b.warnings, ...compared.warnings];
  return compared.ok ? commandSuccess(COMMAND, data, { correlationId, warnings }) : commandFailure(COMMAND, compared.error, { correlationId, warnings, data });
}
