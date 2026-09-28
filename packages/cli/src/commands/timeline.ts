import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type CommandResult,
  type Result,
  TIMELINE_EXPORT_VERSION,
  type TimelineEvent,
  type TimelineExport,
  cappyError,
  commandFailure,
  commandSuccess,
  err,
  loadConfig,
  manifestSchema,
  ok,
  timelineEventSchema,
  timelineExportSchema,
} from "@uppercut-labs/cappy-internal-core";
import { ManagedWorkspace, resolveWorkspaceRoot } from "@uppercut-labs/cappy-internal-workspace";
import { z } from "zod";
import type { CommandContext } from "../context.js";

const COMMAND = "timeline";
const FORMATS = ["json", "csv", "vtt"] as const;
type Format = (typeof FORMATS)[number];

export interface TimelineExportReport {
  readonly format: Format;
  readonly source: TimelineExport["source"];
  readonly events: number;
  /** The export itself, when it was not written to a file. */
  readonly content?: string;
  /** Where the export was written with `--out`. */
  readonly path?: string;
}

function usage(message: string, correlationId: string): CommandResult<TimelineExportReport> {
  return commandFailure(
    COMMAND,
    cappyError("USAGE_INVALID", message, COMMAND, {
      details: { usage: "cappy timeline export <capture-id | session-id> [--format json|csv|vtt] [--out <path>]" },
      retryable: false,
    }),
    { correlationId },
  );
}

function unavailable(id: string, reason: string): Result<never> {
  return err(cappyError("TIMELINE_UNAVAILABLE", `no readable timeline for ${id}: ${reason}`, COMMAND, { details: { id }, retryable: false }));
}

/** Read the timeline a capture's manifest or a session's timeline.json holds. */
async function readTimeline(workspace: ManagedWorkspace, id: string): Promise<Result<TimelineExport>> {
  const capture = id.startsWith("cap_");
  const file = workspace.managed(capture ? `captures/${id}/manifest.json` : `sessions/${id}/timeline.json`);
  if (file === undefined) {
    const exists = await stat(path.join(workspace.root, capture ? "captures" : "sessions", id)).then(
      () => true,
      () => false,
    );
    if (!exists) {
      return err(
        cappyError(capture ? "CAPTURE_NOT_FOUND" : "SESSION_NOT_FOUND", `no ${capture ? "capture" : "session"} ${id} in ${workspace.root}`, COMMAND, {
          details: { id },
          retryable: false,
        }),
      );
    }
    return unavailable(id, capture ? "it has no manifest" : "it has no timeline.json");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file.hostPath, "utf8"));
  } catch (cause) {
    return unavailable(id, String(cause));
  }
  if (capture) {
    const manifest = manifestSchema.safeParse(raw);
    if (!manifest.success) {
      return unavailable(id, "its manifest is invalid");
    }
    const { timeline, sync } = manifest.data.timing;
    if (!Array.isArray(timeline)) {
      return unavailable(id, "its manifest references an external timeline");
    }
    return ok({ timelineExportVersion: TIMELINE_EXPORT_VERSION, source: { kind: "capture", id }, clock: "master", ...(sync === undefined ? {} : { sync }), events: timeline });
  }
  const events = z.array(timelineEventSchema).safeParse(raw);
  return events.success
    ? ok({ timelineExportVersion: TIMELINE_EXPORT_VERSION, source: { kind: "session", id }, clock: "session", events: events.data })
    : unavailable(id, "its timeline.json is invalid");
}

/** RFC 4180: quote a field that holds a comma, a quote, or a line break, doubling its quotes. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function toCsv(events: readonly TimelineEvent[]): string {
  const rows = [["seq", "t_ms", "type", "source", "duration_ms", "id", "payload"]];
  for (const event of events) {
    rows.push([
      String(event.seq),
      String(event.t),
      event.type,
      event.source,
      event.durationMs === undefined ? "" : String(event.durationMs),
      event.id,
      event.payload === undefined ? "" : JSON.stringify(event.payload),
    ]);
  }
  return `${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}

/** WebVTT timestamp `HH:MM:SS.mmm`. */
function vttTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${pad(Math.floor(total / 3_600_000))}:${pad(Math.floor(total / 60_000) % 60)}:${pad(Math.floor(total / 1000) % 60)}.${pad(total % 1000, 3)}`;
}

/** Cue text must not contain "-->" or markup; payload values are shown as `key=value`. */
function vttText(event: TimelineEvent): string {
  const payload =
    event.payload !== null && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? Object.entries(event.payload).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      : event.payload === undefined
        ? []
        : [JSON.stringify(event.payload)];
  return [event.type, ...payload]
    .join(" ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\s+/g, " ");
}

export function toVtt(events: readonly TimelineEvent[]): string {
  const cues = events.map((event) => `${event.id}\n${vttTime(event.t)} --> ${vttTime(event.t + Math.max(event.durationMs ?? 0, 1000))}\n${vttText(event)}\n`);
  return `WEBVTT\n\n${cues.join("\n")}`;
}

/**
 * Export a capture's or session's timeline as JSON, CSV, or WebVTT (SPEC
 * 11.10), to standard output or to a new file that Cappy never manages.
 */
export async function timeline(context: CommandContext): Promise<CommandResult<TimelineExportReport>> {
  const { correlationId } = context;
  const [action, id, ...extra] = context.positionals;
  if (action !== "export" || id === undefined || extra.length > 0) {
    return usage("usage: cappy timeline export <capture-id | session-id>", correlationId);
  }
  if (!id.startsWith("cap_") && !id.startsWith("ses_")) {
    return usage(`"${id}" is not a capture (cap_…) or session (ses_…) ID`, correlationId);
  }
  const formatFlag = context.flags["format"] ?? "json";
  if (typeof formatFlag !== "string" || !(FORMATS as readonly string[]).includes(formatFlag)) {
    return usage(`--format must be one of ${FORMATS.join(", ")}`, correlationId);
  }
  const format = formatFlag as Format;

  const loaded = await loadConfig({ projectDir: context.projectDir, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
  if (!loaded.ok) {
    return commandFailure(COMMAND, loaded.error, { correlationId });
  }
  const { root } = resolveWorkspaceRoot(loaded.value.projectDir, loaded.value.config);
  const kind = id.startsWith("cap_") ? "capture" : "session";
  if (!(await stat(root).then(() => true, () => false))) {
    return commandFailure(
      COMMAND,
      cappyError(kind === "capture" ? "CAPTURE_NOT_FOUND" : "SESSION_NOT_FOUND", `no ${kind} ${id}: this project has no workspace yet`, COMMAND, { retryable: false }),
      { correlationId },
    );
  }
  const opened = await ManagedWorkspace.open({ projectDir: loaded.value.projectDir, config: loaded.value.config, readOnly: true });
  if (!opened.ok) {
    return commandFailure(COMMAND, opened.error, { correlationId });
  }
  const read = await readTimeline(opened.value, id);
  if (!read.ok) {
    return commandFailure(COMMAND, read.error, { correlationId });
  }
  const exported = timelineExportSchema.parse(read.value);
  const content = format === "json" ? `${JSON.stringify(exported, null, 2)}\n` : format === "csv" ? toCsv(exported.events) : toVtt(exported.events);
  const base = { format, source: exported.source, events: exported.events.length };

  const out = context.flags["out"];
  if (typeof out !== "string") {
    return commandSuccess(COMMAND, { ...base, content }, { correlationId });
  }
  const target = path.resolve(loaded.value.projectDir, out);
  try {
    // A new file that belongs to the user: never overwritten, never registered as managed.
    await writeFile(target, content, { flag: "wx" });
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    return commandFailure(
      COMMAND,
      code === "EEXIST"
        ? cappyError("EXPORT_TARGET_EXISTS", `${target} already exists; exports never overwrite a file`, COMMAND, { details: { path: target }, retryable: false })
        : cappyError("WORKSPACE_WRITE_FAILED", `could not write ${target}`, COMMAND, { details: { path: target, cause: code ?? String(cause) } }),
      { correlationId },
    );
  }
  return commandSuccess(COMMAND, { ...base, path: target }, { correlationId });
}
