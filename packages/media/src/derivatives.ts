import { randomUUID } from "node:crypto";
import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import { type Artifact, type CappyError, type DerivativeSpec, type Result, cappyError, err, ok, runProcess } from "@cappy/core";
import type { ManagedWorkspace } from "@cappy/workspace";
import { z } from "zod";
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
  clip: z.strictObject({
    ...encode,
    /** Seconds from the start of the master. */
    start: z.number().nonnegative(),
    /** Clip length in seconds. */
    duration: z.number().positive(),
  }),
  thumbnail: z.strictObject({ at: z.number().nonnegative().default(0), width: z.int().positive().max(7680).default(640) }),
  still: z.strictObject({ at: z.number().nonnegative().default(0) }),
} as const;

const EXTENSIONS = { mp4: ".mp4", clip: ".mp4", thumbnail: ".jpg", still: ".png" } as const;
const MEDIA_TYPES = { mp4: "video/mp4", clip: "video/mp4", thumbnail: "image/jpeg", still: "image/png" } as const;

type Options<K extends keyof typeof OPTION_SCHEMAS> = z.output<(typeof OPTION_SCHEMAS)[K]>;

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

/** FFmpeg arguments for one derivative. Inputs and outputs are never interpolated into a shell. */
export function ffmpegArguments(derivative: DerivativeSpec, input: string, output: string): string[] {
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
      return [...base, "-ss", String(options.start), "-i", input, "-t", String(options.duration), ...h264(options), output];
    }
    case "thumbnail": {
      const options = OPTION_SCHEMAS.thumbnail.parse(derivative.options);
      return [...base, "-ss", String(options.at), "-i", input, "-frames:v", "1", "-vf", `scale=${options.width}:-2`, "-q:v", "3", output];
    }
    case "still": {
      const options = OPTION_SCHEMAS.still.parse(derivative.options);
      return [...base, "-ss", String(options.at), "-i", input, "-frames:v", "1", output];
    }
  }
}

export interface DeriveOptions {
  readonly ffmpeg: { readonly path: string; readonly version: string };
  readonly ffprobe: string;
  readonly timeoutMs: number;
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
): Promise<Result<Artifact & { readonly media: MediaInfo }>> {
  const extension = EXTENSIONS[derivative.kind];
  const target = workspace.resolve(`${directory}/${derivative.role}${extension}`);
  if (!target.ok) {
    return target;
  }
  const temp = path.join(path.dirname(target.value.hostPath), `.${derivative.role}.${randomUUID()}.partial${extension}`);
  const discard = (): Promise<void> => unlink(temp).catch(() => undefined);

  const run = await runProcess(options.ffmpeg.path, ffmpegArguments(derivative, master.hostPath, temp), { timeoutMs: options.timeoutMs });
  if (run.exitCode !== 0) {
    await discard();
    return err(derivativeError(derivative, run.timedOut ? "FFmpeg timed out" : `FFmpeg exited with ${String(run.exitCode)}`, { stderr: run.stderr.slice(-800) }));
  }
  const produced = await stat(temp).catch(() => undefined);
  if (produced === undefined || produced.size === 0) {
    await discard();
    return err(derivativeError(derivative, produced === undefined ? "FFmpeg produced no output" : "FFmpeg produced an empty file"));
  }
  const media = await probeMedia(options.ffprobe, temp, { timeoutMs: options.timeoutMs });
  if (!media.ok) {
    await discard();
    return err(derivativeError(derivative, "the output is not valid media", { probe: media.error.message }));
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
    media: media.value,
  });
}
