import { randomUUID } from "node:crypto";
import { readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { type Artifact, type CappyError, type Result, cappyError, err, ok, runProcess } from "@cappy/core";
import type { ManagedWorkspace } from "@cappy/workspace";
import { type MediaInfo, probeMedia } from "./probe.js";

/** Frame rate used when ffprobe reports none for the reference master. */
export const DEFAULT_COMPARISON_FRAME_RATE = 30;

/** How much the per-pixel difference is amplified in the triptych's third column. */
export const DIFFERENCE_GAIN = 4;

export interface ComparisonInput {
  /** Host path of a verified master. */
  readonly path: string;
  /** Aligned start on that master, in milliseconds. */
  readonly startMs: number;
}

export interface Normalization {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
}

export interface FrameScore {
  /** 1-based frame number within the compared span. */
  readonly frame: number;
  /** Time from the aligned start, in milliseconds. */
  readonly tMs: number;
  readonly ssim: number;
  /** PSNR in dB; null for identical frames. */
  readonly psnr: number | null;
}

const seconds = (ms: number): string => String(Math.round(ms * 1000) / 1_000_000);

/**
 * One FFmpeg pass over the aligned span: B is scaled to A's size, both are
 * sampled at A's frame rate, per-frame SSIM and PSNR go to stats files
 * (relative to FFmpeg's working directory, so no path needs filter escaping),
 * and the triptych A | B | amplified difference is encoded.
 */
export function comparisonArguments(
  a: ComparisonInput,
  b: ComparisonInput,
  spanMs: number,
  normalization: Normalization,
  files: { readonly ssimLog: string; readonly psnrLog: string; readonly triptych: string },
): string[] {
  const { width, height, frameRate } = normalization;
  const prepare = `fps=${frameRate},scale=${width}:${height}:flags=bicubic,format=yuv420p,setpts=PTS-STARTPTS`;
  const graph = [
    `[0:v]${prepare},split=2[a0][a1]`,
    `[1:v]${prepare},split=4[b0][b1][b2][b3]`,
    `[a0][b0]ssim=stats_file=${files.ssimLog}[scored]`,
    `[scored][b1]psnr=stats_file=${files.psnrLog}[acol]`,
    "[a1]format=gray[ag]",
    "[b2]format=gray[bg]",
    `[ag][bg]blend=all_mode=difference,lutyuv=y='min(val*${DIFFERENCE_GAIN},255)',format=yuv420p[dcol]`,
    "[acol][b3][dcol]hstack=inputs=3[out]",
  ].join(";");
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
    "-ss", seconds(a.startMs), "-t", seconds(spanMs), "-i", a.path,
    "-ss", seconds(b.startMs), "-t", seconds(spanMs), "-i", b.path,
    "-filter_complex", graph,
    "-map", "[out]", "-an",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    files.triptych,
  ];
}

/** Parse FFmpeg `ssim` and `psnr` stats files into per-frame scores. */
export function parseFrameScores(ssimLog: string, psnrLog: string, frameRate: number): FrameScore[] | undefined {
  const byFrame = (text: string, field: RegExp): Map<number, string> => {
    const values = new Map<number, string>();
    for (const line of text.split(/\r?\n/)) {
      const frame = /^n:(\d+)\s/.exec(line);
      const value = field.exec(line);
      if (frame !== null && value !== null) {
        values.set(Number(frame[1]), value[1] ?? "");
      }
    }
    return values;
  };
  const ssim = byFrame(ssimLog, /\bAll:([0-9.]+)/);
  const psnr = byFrame(psnrLog, /\bpsnr_avg:(inf|[0-9.]+)/);
  if (ssim.size === 0 || ssim.size !== psnr.size) {
    return undefined;
  }
  const frames: FrameScore[] = [];
  for (const [frame, value] of [...ssim].sort(([x], [y]) => x - y)) {
    const quality = psnr.get(frame);
    const score = Number(value);
    if (quality === undefined || !Number.isFinite(score)) {
      return undefined;
    }
    frames.push({
      frame,
      tMs: Math.round(((frame - 1) * 1000 * 1000) / frameRate) / 1000,
      ssim: Math.min(1, Math.max(0, score)),
      psnr: quality === "inf" ? null : Number(quality),
    });
  }
  return frames;
}

export interface ComparisonScores {
  readonly frames: number;
  readonly ssim: { readonly mean: number; readonly min: number; readonly minAtMs: number };
  readonly psnr: { readonly mean: number | null; readonly min: number | null };
}

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

export function summarizeScores(frames: readonly FrameScore[]): ComparisonScores {
  const lowest = frames.reduce((worst, frame) => (frame.ssim < worst.ssim ? frame : worst));
  const finite = frames.map((frame) => frame.psnr).filter((value): value is number => value !== null);
  return {
    frames: frames.length,
    ssim: { mean: round6(frames.reduce((total, frame) => total + frame.ssim, 0) / frames.length), min: lowest.ssim, minAtMs: lowest.tMs },
    psnr: {
      mean: finite.length === 0 ? null : round6(finite.reduce((total, value) => total + value, 0) / finite.length),
      min: finite.length === 0 ? null : Math.min(...finite),
    },
  };
}

export interface CompareOptions {
  readonly ffmpeg: { readonly path: string; readonly version: string };
  readonly ffprobe: string;
  readonly timeoutMs: number;
}

export interface ComparisonOutput {
  readonly frames: readonly FrameScore[];
  readonly scores: ComparisonScores;
  readonly triptych: Artifact & { readonly media: MediaInfo };
  readonly framesFile: Artifact;
}

function comparisonError(reason: string, details: Record<string, unknown> = {}): CappyError {
  return cappyError("COMPARISON_FAILED", `comparison failed: ${reason}`, "media.compare", { details });
}

/**
 * Run the comparison and publish `triptych.mp4` and `frames.json` into
 * `directory` as managed files. FFmpeg writes only uniquely named partial
 * files beside the outputs; nothing is published unless FFmpeg exits cleanly,
 * the triptych probes as video, and both stats files parse. Partial files are
 * always removed. The masters are only ever read.
 */
export async function produceComparison(
  a: ComparisonInput,
  b: ComparisonInput,
  spanMs: number,
  normalization: Normalization,
  workspace: ManagedWorkspace,
  directory: string,
  options: CompareOptions,
): Promise<Result<ComparisonOutput>> {
  const target = workspace.resolve(`${directory}/triptych.mp4`);
  if (!target.ok) {
    return target;
  }
  const created = await workspace.ensureDirectory(directory);
  if (!created.ok) {
    return created;
  }
  const hostDir = created.value;
  const id = randomUUID();
  const files = { ssimLog: `.ssim.${id}.partial.log`, psnrLog: `.psnr.${id}.partial.log`, triptych: `.triptych.${id}.partial.mp4` };
  const partials = Object.values(files).map((name) => path.join(hostDir, name));
  const discard = (): Promise<unknown> => Promise.all(partials.map((file) => unlink(file).catch(() => undefined)));
  try {
    const run = await runProcess(options.ffmpeg.path, comparisonArguments(a, b, spanMs, normalization, files), {
      cwd: hostDir,
      timeoutMs: options.timeoutMs,
    });
    if (run.exitCode !== 0) {
      return err(comparisonError(run.timedOut ? "FFmpeg timed out" : `FFmpeg exited with ${String(run.exitCode)}`, { stderr: run.stderr.slice(-800) }));
    }
    const triptychPath = path.join(hostDir, files.triptych);
    const produced = await stat(triptychPath).catch(() => undefined);
    if (produced === undefined || produced.size === 0) {
      return err(comparisonError(produced === undefined ? "FFmpeg produced no triptych" : "FFmpeg produced an empty triptych"));
    }
    const media = await probeMedia(options.ffprobe, triptychPath, { timeoutMs: options.timeoutMs });
    if (!media.ok) {
      return err(comparisonError("the triptych is not valid media", { probe: media.error.message }));
    }
    const [ssimLog, psnrLog] = await Promise.all(
      [files.ssimLog, files.psnrLog].map((name) => readFile(path.join(hostDir, name), "utf8").catch(() => "")),
    );
    const frames = parseFrameScores(ssimLog ?? "", psnrLog ?? "", normalization.frameRate);
    if (frames === undefined) {
      return err(comparisonError("FFmpeg's SSIM/PSNR statistics are missing or unreadable"));
    }

    const published = await workspace.publishFile(triptychPath, target.value.path, { move: true, role: "triptych" });
    if (!published.ok) {
      return published;
    }
    const framesWritten = await workspace.writeManaged(`${directory}/frames.json`, `${JSON.stringify(frames, null, 2)}\n`, { role: "frames" });
    if (!framesWritten.ok) {
      return framesWritten;
    }
    return ok({
      frames,
      scores: summarizeScores(frames),
      triptych: {
        role: "triptych",
        path: published.value.path,
        ownership: "managed",
        mediaType: "video/mp4",
        bytes: published.value.entry.bytes,
        sha256: published.value.entry.sha256,
        source: { tool: "ffmpeg", version: options.ffmpeg.version },
        ...(media.value.durationMs === undefined ? {} : { durationMs: media.value.durationMs }),
        ...(media.value.width === undefined ? {} : { width: media.value.width }),
        ...(media.value.height === undefined ? {} : { height: media.value.height }),
        media: media.value,
      },
      framesFile: {
        role: "frames",
        path: framesWritten.value.path,
        ownership: "managed",
        mediaType: "application/json",
        bytes: framesWritten.value.entry.bytes,
        sha256: framesWritten.value.entry.sha256,
        source: { tool: "cappy" },
      },
    });
  } finally {
    await discard();
  }
}
