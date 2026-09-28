import type { CappyError, CommandResult } from "@uppercut-labs/cappy-internal-core";
import type { CleanReport } from "./commands/clean.js";
import type { CompareBuildsReport } from "./commands/compare-builds.js";
import type { CompareReport } from "./commands/compare.js";
import type { DoctorReport } from "./commands/doctor.js";
import type { RecordReport } from "./commands/record.js";
import type { ReplayReport } from "./commands/replay.js";
import type { RunReport } from "./commands/run.js";
import type { ScenariosReport } from "./commands/scenarios.js";

/** Plain-text renderers for human mode. No ANSI styling is ever emitted. */

export function renderError(error: CappyError): string {
  const lines = [`error [${error.code}]: ${error.message}`];
  for (const [key, value] of Object.entries(error.details ?? {})) {
    if (key === "issues" && Array.isArray(value)) {
      for (const issue of value as { path: string; message: string }[]) {
        lines.push(`  ${issue.path}: ${issue.message}`);
      }
    } else if (value !== undefined && value !== "") {
      lines.push(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderDoctor(result: CommandResult<DoctorReport>): string {
  const report = result.data;
  if (report === undefined) {
    return "";
  }
  const lines: string[] = [];
  if (report.project !== undefined) {
    lines.push(`Cappy doctor: ${report.project.name} (${report.project.id})`);
  }
  const width = Math.max(...report.checks.map((entry) => entry.id.length));
  for (const entry of report.checks) {
    lines.push(`  ${entry.status.toUpperCase().padEnd(4)}  ${entry.id.padEnd(width)}  ${entry.summary}`);
  }
  if (result.ok) {
    const warnings = report.checks.filter((entry) => entry.status === "warn").length;
    lines.push(warnings === 0 ? "All checks passed." : `All checks passed with ${warnings} warning(s).`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderScenarios(report: ScenariosReport): string {
  const { adapter } = report;
  const lines = [
    `${adapter.game.name ?? adapter.game.id}: ${adapter.adapter.name} ${adapter.adapter.version}, protocol ${adapter.protocolVersion}${
      adapter.build === undefined ? "" : `, build ${adapter.build}`
    }`,
    `Capabilities: ${adapter.capabilities.length === 0 ? "(none)" : adapter.capabilities.join(", ")}`,
  ];
  if (report.scenarios.length === 0) {
    lines.push("No scenarios registered.");
  } else {
    lines.push("Scenarios:");
    for (const scenario of report.scenarios) {
      lines.push(`  ${scenario.id}  ${scenario.name}`);
      for (const [name, spec] of Object.entries(scenario.parameters)) {
        const range =
          spec.minimum !== undefined || spec.maximum !== undefined ? ` ${spec.minimum ?? ""}..${spec.maximum ?? ""}` : "";
        const choices = spec.enum === undefined ? "" : ` one of ${spec.enum.join("|")}`;
        const fallback = spec.default === undefined ? "" : ` (default ${String(spec.default)})`;
        lines.push(`    ${name}: ${spec.type}${range}${choices}${spec.required ? ", required" : ""}${fallback}`);
      }
      if (scenario.requiredCapabilities.length > 0) {
        lines.push(`    requires: ${scenario.requiredCapabilities.join(", ")}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderRecord(result: CommandResult<RecordReport>): string {
  const report = result.data;
  if (report === undefined) {
    return "";
  }
  const { session } = report;
  const lines = [`Session ${session.id}: ${session.status}, ${report.events} event(s)`];
  if (report.master !== undefined) {
    lines.push(`Master: ${report.master.path} (${report.master.bytes} bytes, sha256 ${report.master.sha256})`);
  }
  if (session.replay !== undefined) {
    lines.push(`Replay payload: ${session.replay.path} (${session.replay.bytes} bytes, sha256 ${session.replay.sha256})`);
    lines.push(`Replay it with: cappy replay ${session.id} --no-capture`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderReplay(report: ReplayReport): string {
  if (report.captured) {
    return renderCapture(report);
  }
  const lines = [`Replayed session ${report.sessionId}: ${report.events.length} event(s)`];
  for (const event of report.events) {
    lines.push(`  ${String(event.t).padStart(8)} ms  ${event.type}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderRun(result: CommandResult<RunReport>): string {
  return result.data === undefined ? "" : renderCapture(result.data);
}

function renderCapture(report: RunReport): string {
  const subject =
    report.scenario !== undefined
      ? `${report.scenario.id}${
          Object.keys(report.scenario.parameters).length === 0
            ? ""
            : ` (${Object.entries(report.scenario.parameters)
                .map(([name, value]) => `${name}=${String(value)}`)
                .join(" ")})`
        }`
      : report.source?.kind === "replay"
        ? `replay of ${report.source.sessionId}`
        : "capture";
  const lines = [
    `Capture ${report.captureId}: ${subject}${report.take === undefined ? "" : `, take ${report.take}`}, preset ${report.preset}, ${report.state}`,
    `OBS ${report.obs.version}${report.obs.scene === undefined ? "" : `, scene "${report.obs.scene}"`}; ${report.events.length} game event(s)`,
  ];
  for (const artifact of report.artifacts) {
    lines.push(`  ${artifact.role.padEnd(10)} ${artifact.path} (${artifact.bytes} bytes, sha256 ${artifact.sha256})`);
  }
  if (report.manifest !== undefined) {
    lines.push(`Manifest: ${report.manifest}`);
  }
  lines.push(`Log: ${report.log}`);
  return `${lines.join("\n")}\n`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? "TB"}`;
}

export function renderClean(result: CommandResult<CleanReport>): string {
  const report = result.data;
  if (report === undefined) {
    return "";
  }
  if (report.items.length === 0 && report.refused.length === 0) {
    return "Nothing to clean.\n";
  }
  const verb = report.dryRun ? "Would remove" : "Removed";
  const lines = [`${verb} ${report.removed.length} file(s) from ${report.items.length} item(s), ${formatBytes(report.bytesFreed)}${report.dryRun ? " (dry run; nothing was changed)" : ""}`];
  for (const item of report.items) {
    lines.push(`  ${item.kind.padEnd(10)}  ${item.id}  ${item.files.length} file(s), ${formatBytes(item.bytes)}`);
  }
  for (const { source, take } of report.retiredTakes) {
    const subject = source.kind === "scenario" ? `scenario ${source.scenarioId}` : `replay of ${source.sessionId}`;
    lines.push(`${report.dryRun ? "Would retire" : "Retired"} take ${take} of ${subject}; it will not be reissued.`);
  }
  for (const missing of report.missing) {
    lines.push(`Missing (already gone): ${missing}`);
  }
  for (const { path, reason } of report.kept) {
    lines.push(`Kept: ${path} (${reason})`);
  }
  for (const { target, reason } of report.refused) {
    lines.push(`Refused: ${target} (${reason})`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderCompare(result: CommandResult<CompareReport>): string {
  const report = result.data;
  if (report?.comparisonId === undefined) {
    return "";
  }
  const subject = report.source.kind === "scenario" ? `scenario ${report.source.scenarioId}` : `replay of ${report.source.sessionId}`;
  const build = (build?: string): string => (build === undefined ? "" : `, build ${build}`);
  const lines = [
    `Comparison ${report.comparisonId}: ${report.status ?? "failed"} (${subject})`,
    `  A ${report.a.captureId} (take ${report.a.take}${build(report.a.gameBuild)})`,
    `  B ${report.b.captureId} (take ${report.b.take}${build(report.b.gameBuild)})`,
  ];
  const normalization = report.normalization;
  lines.push(
    `Aligned on ${report.alignment.event}, ${report.alignment.spanMs} ms${
      normalization === undefined ? "" : ` at ${normalization.width}x${normalization.height}, ${Math.round(normalization.frameRate * 100) / 100} fps${normalization.scaledB ? " (B scaled to A)" : ""}`
    }`,
  );
  const scores = report.scores;
  if (scores !== undefined) {
    const psnr = scores.psnr.mean === null ? "identical frames" : `mean ${scores.psnr.mean.toFixed(2)} dB, min ${String(scores.psnr.min?.toFixed(2))} dB`;
    lines.push(`SSIM mean ${scores.ssim.mean.toFixed(4)}, min ${scores.ssim.min.toFixed(4)} at ${scores.ssim.minAtMs} ms; PSNR ${psnr} over ${scores.frames} frame(s)`);
  }
  const gates = Object.entries(report.gates).map(([name, value]) => (value === true ? name : `${name} ${String(value)}`));
  if (gates.length > 0) {
    const failed = report.failedGates ?? [];
    lines.push(`Gates: ${gates.join(", ")}; ${failed.length === 0 ? "all passed" : `failed: ${failed.join(", ")}`}`);
  }
  for (const frame of report.worstFrames ?? []) {
    lines.push(`  worst #${frame.rank}  ${frame.tMs} ms, SSIM ${frame.ssim.toFixed(4)}: ${frame.diff}`);
  }
  const differing = report.timelineDiff.filter((entry) => entry.countA !== entry.countB);
  const drift = report.timelineDiff.reduce<number | null>(
    (max, entry) => (entry.maxDriftMs === null || (max !== null && Math.abs(max) >= Math.abs(entry.maxDriftMs)) ? max : entry.maxDriftMs),
    null,
  );
  lines.push(
    `Timeline: ${report.timelineDiff.length} adapter event type(s), ${differing.length === 0 ? "same counts" : `${differing.length} with different counts (${differing.map((entry) => `${entry.type} ${entry.countA}->${entry.countB}`).join(", ")})`}${drift === null ? "" : `, largest drift ${drift} ms`}`,
  );
  for (const artifact of report.artifacts.filter((entry) => !entry.role.startsWith("worst-"))) {
    lines.push(`  ${artifact.role.padEnd(9)} ${artifact.path}`);
  }
  if (report.manifest !== undefined) {
    lines.push(`Manifest: ${report.manifest}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderCompareBuilds(result: CommandResult<CompareBuildsReport>): string {
  const report = result.data;
  if (report === undefined) {
    return "";
  }
  const lines = [`Builds ${report.builds.a} vs ${report.builds.b}`];
  for (const [label, capture] of [
    ["A", report.a],
    ["B", report.b],
  ] as const) {
    if (capture !== undefined && "captureId" in capture) {
      lines.push(`  ${label} (${label === "A" ? report.builds.a : report.builds.b}): capture ${capture.captureId}, take ${String(capture.take ?? "?")}, ${capture.state}`);
    }
  }
  const header = `${lines.join("\n")}\n`;
  if (report.comparison === undefined) {
    return header;
  }
  return header + renderCompare({ ...result, data: report.comparison } as CommandResult<CompareReport>);
}
