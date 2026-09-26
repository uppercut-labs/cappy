import { randomUUID } from "node:crypto";
import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  type Artifact,
  type CappyError,
  type DerivativeSpec,
  type Result,
  type TimelineEvent,
  cappyError,
  err,
  ok,
  runProcess,
} from "@cappy/core";
import type { ManagedWorkspace } from "@cappy/workspace";
import { z } from "zod";
import { type DerivativeTime, type EventAnchor, derivativeTimeSchema, describeAnchor, findAnchorEvent, findAnchorEvents } from "./anchors.js";
import { type MediaInfo, probeMedia } from "./probe.js";

const X264_PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"] as const;

const encode = {
  crf: z.int().min(0).max(51).default(20),
  preset: z.enum(X264_PRESETS).default("medium"),
  audio: z.boolean().default(true),
};

/** Kind-specific derivative options, validated before any capture starts. */
const OPTION_SCHEMAS = {
  mp4: z.strictObject({ ...encode }),
  clip: z
    .strictObject({
      ...encode,
      /** Seconds from the start of the master, or an event anchor. */
      start: derivativeTimeSchema,
      /** Clip length in seconds; exactly one of `duration` and `end`. */
      duration: z.number().positive().optional(),
      /** Seconds from the start of the master, or an event anchor. */
      end: derivativeTimeSchema.optional(),
    })
    .refine((options) => (options.duration === undefined) !== (options.end === undefined), {
      message: "set exactly one of duration or end",
      path: ["duration"],
    })
    .refine((options) => typeof options.start !== "number" || typeof options.end !== "number" || options.end > options.start, {
      message: "must be after start",
      path: ["end"],
    })
    .refine((options) => typeof options.end !== "object" || options.end.occurrence !== "every", {
      message: 'occurrence "every" is allowed only on start; each clip ends at the first qualifying event after its own start',
      path: ["end"],
    })
    .refine((options) => !isEvery(options.start) || typeof options.end !== "number", {
      message: 'a clip with occurrence "every" needs an end anchor or a duration, not a fixed end time',
      path: ["end"],
    }),
  thumbnail: z.strictObject({ at: derivativeTimeSchema.default(0), width: z.int().positive().max(7680).default(640) }),
  still: z.strictObject({ at: derivativeTimeSchema.default(0) }),
} as const;

const EXTENSIONS = { mp4: ".mp4", clip: ".mp4", thumbnail: ".jpg", still: ".png" } as const;
const MEDIA_TYPES = { mp4: "video/mp4", clip: "video/mp4", thumbnail: "image/jpeg", still: "image/png" } as const;

type Options<K extends keyof typeof OPTION_SCHEMAS> = z.output<(typeof OPTION_SCHEMAS)[K]>;

/** At most this many outputs come from one `occurrence: "every"` derivative. */
export const MAX_EVERY_OUTPUTS = 100;

function isEvery(time: unknown): boolean {
  return typeof time === "object" && time !== null && (time as { occurrence?: unknown }).occurrence === "every";
}

/** The anchored time an `occurrence: "every"` derivative repeats over, if it has one. */
function everyKey(derivative: DerivativeSpec): "start" | "at" | undefined {
  const options = derivative.options as Record<string, unknown>;
  if (derivative.kind === "clip" && isEvery(options["start"])) {
    return "start";
  }
  if ((derivative.kind === "still" || derivative.kind === "thumbnail") && isEvery(options["at"])) {
    return "at";
  }
  return undefined;
}

/** Validate every derivative's options; reports all problems at once. */
export function validateDerivatives(derivatives: readonly DerivativeSpec[]): Result<true> {
  const problems: string[] = [];
  for (const derivative of derivatives) {
    const parsed = OPTION_SCHEMAS[derivative.kind].safeParse(derivative.options);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        problems.push(`${derivative.role}: ${issue.path.length === 0 ? "" : `${issue.path.join(".")}: `}${issue.message}`);
      }
    }
    if (everyKey(derivative) !== undefined) {
      const generated = new RegExp(`^${derivative.role.replace(/[-]/g, "\\-")}-[0-9]+$`);
      for (const other of derivatives.filter((entry) => entry !== derivative && generated.test(entry.role))) {
        problems.push(`${other.role}: collides with the outputs of "${derivative.role}", which uses occurrence "every"`);
      }
    }
  }
  return problems.length === 0
    ? ok(true)
    : err(
        cappyError("DERIVATIVE_OPTIONS_INVALID", `invalid derivative options: ${problems.join("; ")}`, "media.derive", {
          details: { problems },
          retryable: false,
        }),
      );
}

/**
 * Turn a preset derivative into the concrete derivatives it produces: itself,
 * or for `occurrence: "every"` one per matching event (`<role>-1`, `<role>-2`,
 * ...), each pinned to its occurrence. At most MAX_EVERY_OUTPUTS are made.
 */
export function expandDerivative(derivative: DerivativeSpec, context: TimingContext): Result<{ derivatives: DerivativeSpec[]; warnings: string[] }> {
  const key = everyKey(derivative);
  if (key === undefined) {
    return ok({ derivatives: [derivative], warnings: [] });
  }
  const options = derivative.options as Record<string, unknown>;
  const anchor = eventAnchorOf(options[key]);
  const matches = findAnchorEvents(context.timeline, anchor);
  if (matches.length === 0) {
    return err(anchorError(derivative, key, anchor));
  }
  const count = Math.min(matches.length, MAX_EVERY_OUTPUTS);
  const warnings =
    matches.length > MAX_EVERY_OUTPUTS
      ? [`derivative "${derivative.role}" matched ${matches.length} events; only the first ${MAX_EVERY_OUTPUTS} were produced (${matches.length - MAX_EVERY_OUTPUTS} skipped)`]
      : [];
  const derivatives = Array.from({ length: count }, (_, index) => ({
    ...derivative,
    role: `${derivative.role}-${index + 1}`,
    options: { ...options, [key]: { ...(options[key] as object), occurrence: index + 1 } },
  }));
  return ok({ derivatives, warnings });
}

function eventAnchorOf(value: unknown): EventAnchor {
  const anchor = value as Partial<EventAnchor> & { event: string };
  return { offset: 0, occurrence: 1, ...anchor } as EventAnchor;
}

/** Where on the master a derivative comes from, once any anchors are resolved. */
export interface ResolvedTiming {
  /** A clip's window, in milliseconds from the start of the master. */
  readonly window?: { readonly startMs: number; readonly endMs: number; readonly startEventId?: string; readonly endEventId?: string };
  /** A still's or thumbnail's frame time, in milliseconds from the start of the master. */
  readonly at?: { readonly ms: number; readonly eventId?: string };
  readonly warnings: readonly string[];
}

export interface TimingContext {
  /** The capture's timeline on the master clock. */
  readonly timeline: readonly TimelineEvent[];
  readonly masterDurationMs?: number;
}

const round = (ms: number): number => Math.round(ms * 1000) / 1000;

/** FFmpeg's seconds for a millisecond time, to the microsecond and without float noise. */
function seconds(ms: number): string {
  return String(Math.round(ms * 1000) / 1_000_000);
}

/** How far before a frame time FFmpeg starts reading, to find the frame at or before it. */
export const FRAME_LOOKBEHIND_MS = 1000;

/**
 * Input options that read the stretch of video ending at `ms`. With the
 * image muxer's `-update 1`, the output keeps the last frame read: the frame
 * at or before `ms`. Unlike seeking to `ms` itself, this still finds a frame
 * when `ms` falls after a master's last decodable frame but within its
 * reported duration, which recorders commonly leave a frame or two apart.
 */
export function frameAtOrBefore(ms: number): string[] {
  const start = Math.max(0, ms - FRAME_LOOKBEHIND_MS);
  return ["-ss", seconds(start), "-t", seconds(ms - start + 1)];
}

function anchorError(derivative: DerivativeSpec, which: string, anchor: EventAnchor): CappyError {
  return cappyError(
    "DERIVATIVE_ANCHOR_UNRESOLVED",
    `derivative "${derivative.role}": no ${describeAnchor(anchor)} event on the timeline for its ${which}`,
    "media.derive",
    { details: { role: derivative.role, kind: derivative.kind, [which]: anchor }, retryable: false },
  );
}

/**
 * Resolve a derivative's times against the capture's timeline (SPEC 13).
 * Anchored times that fall outside the master are clamped with a warning;
 * times given only in seconds behave exactly as written.
 */
export function resolveTiming(derivative: DerivativeSpec, context: TimingContext): Result<ResolvedTiming> {
  const at = (time: DerivativeTime, which: string, notBeforeMs = 0): Result<{ ms: number; eventId?: string; anchorMs?: number }> => {
    if (typeof time === "number") {
      return ok({ ms: time * 1000 });
    }
    const event = findAnchorEvent(context.timeline, time, notBeforeMs);
    return event === undefined ? err(anchorError(derivative, which, time)) : ok({ ms: event.t + time.offset * 1000, eventId: event.id, anchorMs: event.t });
  };
  switch (derivative.kind) {
    case "mp4":
      return ok({ warnings: [] });
    case "clip": {
      const options = OPTION_SCHEMAS.clip.parse(derivative.options);
      const start = at(options.start, "start");
      if (!start.ok) {
        return start;
      }
      let end: Result<{ ms: number; eventId?: string }>;
      if (options.end === undefined) {
        end = ok({ ms: start.value.ms + (options.duration ?? 0) * 1000 });
      } else {
        end = at(options.end, "end", start.value.anchorMs ?? start.value.ms);
      }
      if (!end.ok) {
        return end;
      }
      const anchored = typeof options.start !== "number" || (options.end !== undefined && typeof options.end !== "number");
      let startMs = round(start.value.ms);
      let endMs = round(end.value.ms);
      const warnings: string[] = [];
      if (anchored) {
        const clampedStart = Math.max(0, startMs);
        const clampedEnd = context.masterDurationMs === undefined ? endMs : Math.min(context.masterDurationMs, endMs);
        if (clampedStart !== startMs || clampedEnd !== endMs) {
          warnings.push(`clip "${derivative.role}" window ${startMs}-${endMs} ms was clamped to the master (${clampedStart}-${clampedEnd} ms)`);
        }
        [startMs, endMs] = [clampedStart, clampedEnd];
        if (endMs <= startMs) {
          return err(
            cappyError("DERIVATIVE_WINDOW_EMPTY", `derivative "${derivative.role}": its window is empty once clamped to the master`, "media.derive", {
              details: { role: derivative.role, startMs, endMs, masterDurationMs: context.masterDurationMs },
              retryable: false,
            }),
          );
        }
      }
      return ok({
        window: {
          startMs,
          endMs,
          ...(start.value.eventId === undefined ? {} : { startEventId: start.value.eventId }),
          ...(end.value.eventId === undefined ? {} : { endEventId: end.value.eventId }),
        },
        warnings,
      });
    }
    case "thumbnail":
    case "still": {
      const options = OPTION_SCHEMAS[derivative.kind].parse(derivative.options);
      const frame = at(options.at, "at");
      if (!frame.ok) {
        return frame;
      }
      let ms = round(frame.value.ms);
      const warnings: string[] = [];
      if (typeof options.at !== "number") {
        // The frame at or before the master's end is its last frame.
        const clamped = Math.min(Math.max(0, ms), context.masterDurationMs ?? Number.POSITIVE_INFINITY);
        if (clamped !== ms) {
          warnings.push(`${derivative.kind} "${derivative.role}" time ${ms} ms was clamped to the master (${clamped} ms)`);
          ms = clamped;
        }
      }
      return ok({ at: { ms, ...(frame.value.eventId === undefined ? {} : { eventId: frame.value.eventId }) }, warnings });
    }
  }
}

/** FFmpeg arguments for one derivative. Inputs and outputs are never interpolated into a shell. */
export function ffmpegArguments(
  derivative: DerivativeSpec,
  input: string,
  output: string,
  timing: ResolvedTiming = numericTiming(derivative),
): string[] {
  const base = ["-nostdin", "-hide_banner", "-loglevel", "error", "-n"];
  const h264 = (options: Options<"mp4">): string[] => [
    "-c:v",
    "libx264",
    "-preset",
    options.preset,
    "-crf",
    String(options.crf),
    "-pix_fmt",
    "yuv420p",
    ...(options.audio ? ["-c:a", "aac"] : ["-an"]),
    "-movflags",
    "+faststart",
  ];
  switch (derivative.kind) {
    case "mp4": {
      const options = OPTION_SCHEMAS.mp4.parse(derivative.options);
      return [...base, "-i", input, ...h264(options), output];
    }
    case "clip": {
      const options = OPTION_SCHEMAS.clip.parse(derivative.options);
      const window = timing.window ?? { startMs: 0, endMs: 0 };
      return [...base, "-ss", seconds(window.startMs), "-i", input, "-t", seconds(window.endMs - window.startMs), ...h264(options), output];
    }
    case "thumbnail": {
      const options = OPTION_SCHEMAS.thumbnail.parse(derivative.options);
      return [...base, ...frameAtOrBefore(timing.at?.ms ?? 0), "-i", input, "-vf", `scale=${options.width}:-2`, "-q:v", "3", "-update", "1", output];
    }
    case "still": {
      return [...base, ...frameAtOrBefore(timing.at?.ms ?? 0), "-i", input, "-update", "1", output];
    }
  }
}

/** Timing for a derivative whose times are all given in seconds. */
function numericTiming(derivative: DerivativeSpec): ResolvedTiming {
  const resolved = resolveTiming(derivative, { timeline: [] });
  if (!resolved.ok) {
    throw new Error(`derivative "${derivative.role}" has event anchors; resolve its timing against the timeline first`);
  }
  return resolved.value;
}

export interface DeriveOptions {
  readonly ffmpeg: { readonly path: string; readonly version: string };
  readonly ffprobe: string;
  readonly timeoutMs: number;
  /** The capture's timeline and master facts that event anchors resolve against. */
  readonly timing?: TimingContext;
}

function derivativeError(derivative: DerivativeSpec, reason: string, details: Record<string, unknown> = {}): CappyError {
  return cappyError("DERIVATIVE_FAILED", `derivative "${derivative.role}" failed: ${reason}`, "media.derive", {
    details: { role: derivative.role, kind: derivative.kind, ...details },
  });
}

/**
 * Produce one derivative atomically: FFmpeg writes a uniquely named temp file
 * beside the final path, the output is validated (non-zero exit, missing
 * output, empty output, and failed probes all fail), and only then is it
 * published as a managed file. The master is only ever read.
 */
export async function produceDerivative(
  derivative: DerivativeSpec,
  master: { readonly hostPath: string },
  workspace: ManagedWorkspace,
  directory: string,
  options: DeriveOptions,
): Promise<Result<Artifact & { readonly media: MediaInfo; readonly warnings: readonly string[] }>> {
  const timing = resolveTiming(derivative, options.timing ?? { timeline: [] });
  if (!timing.ok) {
    return timing;
  }
  const extension = EXTENSIONS[derivative.kind];
  const target = workspace.resolve(`${directory}/${derivative.role}${extension}`);
  if (!target.ok) {
    return target;
  }
  const temp = path.join(path.dirname(target.value.hostPath), `.${derivative.role}.${randomUUID()}.partial${extension}`);
  const discard = (): Promise<void> => unlink(temp).catch(() => undefined);

  // The resolved times (and any clamping) explain most failures, so every failure carries them.
  const resolved = {
    ...(timing.value.window === undefined ? {} : { window: timing.value.window }),
    ...(timing.value.at === undefined ? {} : { at: timing.value.at }),
    ...(timing.value.warnings.length === 0 ? {} : { timingWarnings: timing.value.warnings }),
  };
  const run = await runProcess(options.ffmpeg.path, ffmpegArguments(derivative, master.hostPath, temp, timing.value), { timeoutMs: options.timeoutMs });
  if (run.exitCode !== 0) {
    await discard();
    return err(derivativeError(derivative, run.timedOut ? "FFmpeg timed out" : `FFmpeg exited with ${String(run.exitCode)}`, { stderr: run.stderr.slice(-800), ...resolved }));
  }
  const produced = await stat(temp).catch(() => undefined);
  if (produced === undefined || produced.size === 0) {
    await discard();
    return err(derivativeError(derivative, produced === undefined ? "FFmpeg produced no output" : "FFmpeg produced an empty file", resolved));
  }
  const media = await probeMedia(options.ffprobe, temp, { timeoutMs: options.timeoutMs });
  if (!media.ok) {
    await discard();
    return err(derivativeError(derivative, "the output is not valid media", { probe: media.error.message, ...resolved }));
  }
  const published = await workspace.publishFile(temp, target.value.path, { move: true, role: derivative.role });
  if (!published.ok) {
    await discard();
    return published;
  }
  return ok({
    role: derivative.role,
    path: published.value.path,
    ownership: "managed",
    mediaType: MEDIA_TYPES[derivative.kind],
    bytes: published.value.entry.bytes,
    sha256: published.value.entry.sha256,
    source: { tool: "ffmpeg", version: options.ffmpeg.version },
    ...(media.value.durationMs === undefined || derivative.kind === "thumbnail" || derivative.kind === "still"
      ? {}
      : { durationMs: media.value.durationMs }),
    ...(media.value.width === undefined ? {} : { width: media.value.width }),
    ...(media.value.height === undefined ? {} : { height: media.value.height }),
    ...(timing.value.window === undefined ? {} : { window: timing.value.window }),
    ...(timing.value.at === undefined ? {} : { at: timing.value.at }),
    media: media.value,
    warnings: timing.value.warnings,
  });
}
