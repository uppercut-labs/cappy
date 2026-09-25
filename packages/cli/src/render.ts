import type { CappyError, CommandResult } from "@cappy/core";
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
