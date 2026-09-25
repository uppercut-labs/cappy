import { type Result, cappyError, err, ok, runProcess } from "@cappy/core";

export interface MediaInfo {
  readonly formatName: string;
  /** Container duration; absent for still images. */
  readonly durationMs?: number;
  readonly width?: number;
  readonly height?: number;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
}

interface ProbeJson {
  format?: { format_name?: string; duration?: string };
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
}

/**
 * Inspect a media file with ffprobe. Fails unless ffprobe exits cleanly and
 * reports at least one video stream.
 */
export async function probeMedia(ffprobe: string, file: string, options: { timeoutMs: number }): Promise<Result<MediaInfo>> {
  const run = await runProcess(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], {
    timeoutMs: options.timeoutMs,
  });
  const fail = (reason: string) =>
    err(
      cappyError("MEDIA_PROBE_FAILED", `ffprobe could not validate ${file}: ${reason}`, "media.probe", {
        details: { file, exitCode: run.exitCode, timedOut: run.timedOut, stderr: run.stderr.slice(-500) },
      }),
    );
  if (run.exitCode !== 0) {
    return fail(run.timedOut ? "timed out" : `exit code ${String(run.exitCode)}`);
  }
  let parsed: ProbeJson;
  try {
    parsed = JSON.parse(run.stdout) as ProbeJson;
  } catch {
    return fail("unparseable output");
  }
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  if (video === undefined) {
    return fail("no video stream");
  }
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
  const seconds = Number(parsed.format?.duration);
  return ok({
    formatName: parsed.format?.format_name ?? "unknown",
    ...(Number.isFinite(seconds) && seconds > 0 ? { durationMs: Math.round(seconds * 1000) } : {}),
    ...(video.width === undefined ? {} : { width: video.width }),
    ...(video.height === undefined ? {} : { height: video.height }),
    ...(video.codec_name === undefined ? {} : { videoCodec: video.codec_name }),
    ...(audio?.codec_name === undefined ? {} : { audioCodec: audio.codec_name }),
  });
}
