import { readFile } from "node:fs/promises";
import {
  type Artifact,
  type ArtifactManifest,
  type CappyError,
  type CaptureSource,
  type CommandResult,
  type ComparisonManifest,
  type ComparisonStatus,
  type Result,
  type TimelineDiffEntry,
  type TimelineEvent,
  COMPARISON_MANIFEST_VERSION,
  cappyError,
  commandFailure,
  commandSuccess,
  comparisonManifestSchema,
  diffTimelines,
  err,
  loadConfig,
  manifestSchema,
  newId,
  ok,
} from "@cappy/core";
import {
  type ComparisonScores,
  DEFAULT_COMPARISON_FRAME_RATE,
  type Normalization,
  type WorstFrame,
  locateTool,
  probeMedia,
  produceComparison,
} from "@cappy/media";
import { ManagedWorkspace, hashFile } from "@cappy/workspace";
import type { CommandContext } from "../context.js";
import { CommandLog, acquireRunLock } from "../log.js";
import { sourceKey } from "../manifest.js";

const COMMAND = "compare";
const CAPTURE_ID = /^cap_[A-Za-z0-9-]+$/;

export interface ComparedCapture {
  readonly captureId: string;
  readonly take: number;
  readonly gameBuild?: string;
  readonly master: { readonly path: string; readonly sha256: string };
  readonly alignedStartMs: number;
}

export interface CompareReport {
  readonly comparisonId?: string;
  readonly status?: ComparisonStatus;
  readonly source: CaptureSource;
  readonly a: ComparedCapture;
  readonly b: ComparedCapture;
  readonly alignment: { readonly event: string; readonly spanMs: number };
  readonly normalization?: Normalization & { readonly scaledB: boolean };
  readonly scores?: ComparisonScores;
  readonly threshold?: { readonly minSsim: number };
  readonly worstFrames?: readonly (WorstFrame & { readonly a: string; readonly b: string; readonly diff: string })[];
  readonly timelineDiff: readonly TimelineDiffEntry[];
  readonly artifacts: readonly Artifact[];
  readonly manifest?: string;
  readonly log?: string;
}

function usage(message: string, correlationId: string): CommandResult<CompareReport> {
  return commandFailure(
    COMMAND,
    cappyError("USAGE_INVALID", message, COMMAND, { details: { usage: "cappy compare <capture-a> <capture-b> [--min-ssim <score>]" }, retryable: false }),
    { correlationId },
  );
}

/** Read a capture's manifest; only a successful capture of this workspace can be compared. */
async function loadCapture(workspace: ManagedWorkspace, id: string): Promise<Result<ArtifactManifest>> {
  const file = CAPTURE_ID.test(id) ? workspace.managed(`captures/${id}/manifest.json`) : undefined;
  if (file === undefined) {
    return err(cappyError("CAPTURE_NOT_FOUND", `no capture ${id} in ${workspace.root}`, COMMAND, { details: { captureId: id }, retryable: false }));
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file.hostPath, "utf8"));
  } catch (cause) {
    return err(cappyError("COMPARE_INPUT_INVALID", `capture ${id} has an unreadable manifest`, COMMAND, { details: { captureId: id, cause: String(cause) }, retryable: false }));
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    return err(cappyError("COMPARE_INPUT_INVALID", `capture ${id} has an invalid manifest`, COMMAND, { details: { captureId: id, reason: parsed.error.message }, retryable: false }));
  }
  if (parsed.data.status !== "succeeded") {
    return err(
      cappyError("COMPARE_INCOMPATIBLE", `capture ${id} is ${parsed.data.status}; only successful captures can be compared`, COMMAND, {
        details: { captureId: id, status: parsed.data.status },
        retryable: false,
      }),
    );
  }
  return ok(parsed.data);
}

interface Aligned {
  readonly event: string;
  readonly startMs: number;
  readonly operationMs: number;
  readonly timeline: readonly TimelineEvent[];
}

/** Find a capture's operation start and length on its master clock. */
function alignmentOf(manifest: ArtifactManifest): Result<Aligned> {
  const label = manifest.identity.source.kind === "scenario" ? "SCENARIO" : "REPLAY";
  const timeline = manifest.timing.timeline;
  const invalid = (message: string): Result<never> =>
    err(cappyError("COMPARE_INPUT_INVALID", `capture ${manifest.identity.captureId} ${message}`, COMMAND, { details: { captureId: manifest.identity.captureId }, retryable: false }));
  if (!Array.isArray(timeline)) {
    return invalid("references an external timeline, which comparison does not read");
  }
  const started = timeline.find((event) => event.source === "cappy" && event.type === `${label}_STARTED`);
  const completed = timeline.find((event) => event.source === "cappy" && event.type === `${label}_COMPLETED`);
  if (started === undefined || completed === undefined) {
    return invalid(`has no ${label}_STARTED/${label}_COMPLETED events to align on`);
  }
  return ok({ event: `${label}_STARTED`, startMs: started.t, operationMs: completed.t - started.t, timeline });
}

function masterOf(manifest: ArtifactManifest): Artifact | undefined {
  return manifest.artifacts.find((artifact) => artifact.role === "master");
}

/**
 * Compare two successful captures of the same source (SPEC 11.8): align them
 * on the operation start, normalize B to A, score every frame, and write a
 * triptych, per-frame scores, and a comparison manifest under
 * `comparisons/<comparison-id>/`.
 */
export async function compare(context: CommandContext): Promise<CommandResult<CompareReport>> {
  const { correlationId } = context;
  const [idA, idB, ...extra] = context.positionals;
  if (idA === undefined || idB === undefined || extra.length > 0) {
    return usage("compare takes exactly two capture IDs", correlationId);
  }
  if (idA === idB) {
    return usage("compare needs two different captures", correlationId);
  }
  let threshold: { minSsim: number } | undefined;
  const minSsim = context.flags["min-ssim"];
  if (typeof minSsim === "string") {
    const value = Number(minSsim);
    if (minSsim.trim() === "" || !Number.isFinite(value) || value < 0 || value > 1) {
      return usage(`--min-ssim needs a score from 0 to 1, not "${minSsim}"`, correlationId);
    }
    threshold = { minSsim: value };
  }

  const loaded = await loadConfig({ projectDir: context.projectDir, ...(context.configPath === undefined ? {} : { configPath: context.configPath }) });
  if (!loaded.ok) {
    return commandFailure(COMMAND, loaded.error, { correlationId });
  }
  const { config, projectDir } = loaded.value;
  const opened = await ManagedWorkspace.open({ projectDir, config });
  if (!opened.ok) {
    return commandFailure(COMMAND, opened.error, { correlationId });
  }
  const workspace = opened.value;

  // Eligibility, before any media work.
  const manifests: ArtifactManifest[] = [];
  for (const id of [idA, idB]) {
    const manifest = await loadCapture(workspace, id);
    if (!manifest.ok) {
      return commandFailure(COMMAND, manifest.error, { correlationId });
    }
    manifests.push(manifest.value);
  }
  const [manifestA, manifestB] = manifests as [ArtifactManifest, ArtifactManifest];
  if (sourceKey(manifestA.identity.source) !== sourceKey(manifestB.identity.source)) {
    return commandFailure(
      COMMAND,
      cappyError("COMPARE_INCOMPATIBLE", "the captures have different sources; compare captures of the same scenario and parameters, or of the same replayed session", COMMAND, {
        details: { a: manifestA.identity.source, b: manifestB.identity.source },
        retryable: false,
      }),
      { correlationId },
    );
  }
  const compared: ComparedCapture[] = [];
  const masters: string[] = [];
  const aligned: Aligned[] = [];
  const durations: (number | undefined)[] = [];
  for (const manifest of manifests) {
    const id = manifest.identity.captureId;
    const master = masterOf(manifest);
    const file = master === undefined ? undefined : workspace.managed(master.path);
    const digest = file === undefined ? undefined : await hashFile(file.hostPath).catch(() => undefined);
    if (master === undefined || file === undefined || digest?.sha256 !== master.sha256 || digest.bytes !== master.bytes) {
      return commandFailure(
        COMMAND,
        cappyError("COMPARE_INPUT_INVALID", `capture ${id}'s master is missing or no longer matches its manifest`, COMMAND, {
          details: { captureId: id, path: master?.path },
          retryable: false,
        }),
        { correlationId },
      );
    }
    const alignment = alignmentOf(manifest);
    if (!alignment.ok) {
      return commandFailure(COMMAND, alignment.error, { correlationId });
    }
    masters.push(file.hostPath);
    aligned.push(alignment.value);
    durations.push(master.durationMs);
    compared.push({
      captureId: id,
      take: manifest.identity.take,
      ...(manifest.build.gameBuild === undefined ? {} : { gameBuild: manifest.build.gameBuild }),
      master: { path: master.path, sha256: master.sha256 },
      alignedStartMs: alignment.value.startMs,
    });
  }
  const [a, b] = compared as [ComparedCapture, ComparedCapture];
  const spans = aligned.map((entry, index) => {
    const duration = durations[index];
    return Math.min(entry.operationMs, duration === undefined ? Number.POSITIVE_INFINITY : duration - entry.startMs);
  });
  const spanMs = Math.round(Math.min(...spans) * 1000) / 1000;
  const alignment = { event: aligned[0]?.event ?? "", spanMs };
  const source = manifestA.identity.source;
  const [alignedA, alignedB] = aligned as [Aligned, Aligned];
  const timelineDiff = diffTimelines(alignedA.timeline, alignedA.startMs, alignedB.timeline, alignedB.startMs);
  const report = (extra: Partial<CompareReport> = {}): CompareReport => ({ source, a, b, alignment, timelineDiff, artifacts: [], ...extra });
  if (!(spanMs > 0)) {
    return commandFailure(
      COMMAND,
      cappyError("COMPARE_INPUT_INVALID", "the captures have no overlapping span to compare after alignment", COMMAND, { details: { spanMs }, retryable: false }),
      { correlationId, data: report() },
    );
  }
  const warnings: string[] = [];
  for (const entry of timelineDiff.filter((difference) => difference.countA !== difference.countB)) {
    warnings.push(`timeline differs: ${entry.type} occurs ${entry.countA} time(s) in A and ${entry.countB} in B`);
  }
  if (a.gameBuild === b.gameBuild) {
    warnings.push(
      a.gameBuild === undefined
        ? "neither capture reports a game build, so this may not compare two builds"
        : `both captures report game build "${a.gameBuild}"`,
    );
  }

  const tools: { ffmpeg?: { path: string; version: string }; ffprobe?: { path: string; version: string } } = {};
  for (const tool of ["ffmpeg", "ffprobe"] as const) {
    const located = await locateTool(tool, config.tools, { projectDir, env: context.env });
    if (!located.ok) {
      return commandFailure(COMMAND, located.error, { correlationId, warnings, data: report() });
    }
    tools[tool] = located.value;
  }
  const ffmpeg = tools.ffmpeg ?? { path: "ffmpeg", version: "unknown" };
  const ffprobe = tools.ffprobe ?? { path: "ffprobe", version: "unknown" };

  // Media work: from here on, every outcome is recorded in a comparison manifest.
  const comparisonId = newId("cmp");
  const directory = `comparisons/${comparisonId}`;
  const createdAt = new Date().toISOString();
  const log = new CommandLog(correlationId);
  log.record("command.started", { command: COMMAND, a: a.captureId, b: b.captureId });
  const release = await acquireRunLock(workspace, correlationId);
  const checks: { name: string; passed: boolean; detail?: string }[] = [
    { name: "captures.eligible", passed: true },
    { name: "masters.verified", passed: true },
  ];
  const artifacts: Artifact[] = [];
  let normalization: (Normalization & { scaledB: boolean }) | undefined;
  let scores: ComparisonScores | undefined;
  let worstFrames: CompareReport["worstFrames"];

  const finish = async (status: ComparisonStatus, error?: CappyError): Promise<CommandResult<CompareReport>> => {
    const manifest: ComparisonManifest = {
      comparisonVersion: COMPARISON_MANIFEST_VERSION,
      status,
      identity: { comparisonId, project: { id: config.project.id, name: config.project.name }, source, correlationId },
      createdAt,
      a,
      b,
      alignment,
      ...(normalization === undefined ? {} : { normalization }),
      ...(scores === undefined ? {} : { scores }),
      ...(threshold === undefined ? {} : { threshold }),
      ...(worstFrames === undefined ? {} : { worstFrames: [...worstFrames] }),
      timelineDiff,
      artifacts,
      tooling: { ffmpeg: { version: ffmpeg.version }, ffprobe: { version: ffprobe.version } },
      result: { warnings, checks, ...(error === undefined ? {} : { error: { code: error.code, message: error.message } }) },
    };
    const parsed = comparisonManifestSchema.safeParse(manifest);
    let manifestPath: string | undefined;
    let writeError: CappyError | undefined;
    if (parsed.success) {
      const written = await workspace.writeManaged(`${directory}/manifest.json`, `${JSON.stringify(parsed.data, null, 2)}\n`, { role: "manifest" });
      if (written.ok) {
        manifestPath = written.value.path;
      } else {
        writeError = written.error;
      }
    }
    log.record(`comparison.${status}`, { comparisonId, ...(error === undefined ? {} : { code: error.code }) });
    await log.flush(workspace);
    await release();
    const data = report({
      comparisonId,
      status,
      ...(normalization === undefined ? {} : { normalization }),
      ...(scores === undefined ? {} : { scores }),
      ...(threshold === undefined ? {} : { threshold }),
      ...(worstFrames === undefined ? {} : { worstFrames }),
      artifacts,
      ...(manifestPath === undefined ? {} : { manifest: manifestPath }),
      log: log.path,
    });
    if (!parsed.success) {
      return commandFailure(COMMAND, cappyError("MANIFEST_INVALID", "comparison manifest failed validation", COMMAND, { details: { reason: parsed.error.message } }), {
        correlationId,
        warnings,
        data,
      });
    }
    if (error !== undefined || writeError !== undefined) {
      return commandFailure(COMMAND, error ?? writeError ?? cappyError("INTERNAL_ERROR", "comparison failed", COMMAND), { correlationId, warnings, data });
    }
    if (status === "regressed") {
      return commandFailure(
        COMMAND,
        cappyError("COMPARISON_REGRESSED", `mean SSIM ${scores?.ssim.mean ?? 0} is below --min-ssim ${threshold?.minSsim ?? 0}`, COMMAND, {
          details: { ssim: scores?.ssim, minSsim: threshold?.minSsim, manifest: manifestPath },
          retryable: false,
        }),
        { correlationId, warnings, data },
      );
    }
    return commandSuccess(COMMAND, data, { correlationId, warnings });
  };

  try {
    const [probeA, probeB] = await Promise.all(masters.map((master) => probeMedia(ffprobe.path, master, { timeoutMs: config.timeouts.processMs })));
    if (probeA === undefined || probeB === undefined || !probeA.ok || !probeB.ok) {
      const failed = [probeA, probeB].find((probe) => probe !== undefined && !probe.ok);
      checks.push({ name: "masters.probe", passed: false });
      return await finish("failed", failed !== undefined && !failed.ok ? failed.error : cappyError("MEDIA_PROBE_FAILED", "could not probe the masters", COMMAND));
    }
    const width = probeA.value.width;
    const height = probeA.value.height;
    if (width === undefined || height === undefined) {
      checks.push({ name: "masters.probe", passed: false });
      return await finish("failed", cappyError("MEDIA_PROBE_FAILED", `capture ${a.captureId}'s master reports no video size`, COMMAND));
    }
    checks.push({ name: "masters.probe", passed: true });
    normalization = {
      width,
      height,
      frameRate: probeA.value.frameRate ?? DEFAULT_COMPARISON_FRAME_RATE,
      scaledB: probeB.value.width !== width || probeB.value.height !== height,
    };
    log.record("comparison.aligned", { ...alignment, ...normalization });

    const produced = await produceComparison(
      { path: masters[0] ?? "", startMs: a.alignedStartMs },
      { path: masters[1] ?? "", startMs: b.alignedStartMs },
      spanMs,
      normalization,
      workspace,
      directory,
      { ffmpeg, ffprobe: ffprobe.path, timeoutMs: config.timeouts.processMs },
    );
    if (!produced.ok) {
      checks.push({ name: "comparison.media", passed: false, detail: produced.error.message });
      return await finish("failed", produced.error);
    }
    const { media: _media, ...triptych } = produced.value.triptych;
    artifacts.push(triptych, produced.value.framesFile, ...produced.value.stills);
    scores = produced.value.scores;
    worstFrames = produced.value.worstFrames;
    checks.push({ name: "comparison.media", passed: true, detail: `${scores.frames} frame(s)` });
    const regressed = threshold !== undefined && scores.ssim.mean < threshold.minSsim;
    return await finish(regressed ? "regressed" : "succeeded");
  } catch (cause) {
    await log.flush(workspace).catch(() => undefined);
    await release();
    throw cause;
  }
}
