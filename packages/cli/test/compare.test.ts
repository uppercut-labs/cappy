import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { comparisonManifestSchema } from "@uppercut-labs/cappy-internal-core";
import { probeMedia } from "@uppercut-labs/cappy-internal-media";
import { main } from "@uppercut-labs/cappy-internal-cli";
import { hashFile } from "@uppercut-labs/cappy-internal-workspace";
import { type Harness, configure, createHarness, disposeHarness, repoRoot, runCli } from "./support.js";

let harness: Harness;
/** Master contents handed out in order by the fake OBS; the last one repeats. */
let masters: string[];

beforeEach(async () => {
  harness = await createHarness("cappy-compare-");
  masters = ["m".repeat(2048)];
  let next = 0;
  await configure(harness, {
    writeMaster: (outputPath) => {
      writeFileSync(outputPath, masters[Math.min(next, masters.length - 1)] ?? "");
      next += 1;
    },
  }, {
    presets: { trailer: { scene: "Capture" }, broken: { scene: "Capture", derivatives: [{ kind: "mp4", role: "fail-mp4" }] } },
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await disposeHarness(harness);
});

const root = (): string => path.join(harness.project, ".cappy");

/** A capture through the simulator; `timeScale` 1 plays the scenario in real time (about 620 ms). */
async function capture(args: string[] = ["run", "boss_intro"], build = "1.0.0", timeScale = 0.2): Promise<Record<string, any>> {
  const { code, result } = await runCli(harness, args, { sim: { build, timeScale } });
  expect(code, JSON.stringify(result["error"])).toBe(args.includes("broken") ? 1 : 0);
  return result["data"];
}

async function compare(args: string[]): Promise<{ code: number; result: Record<string, any> }> {
  return runCli(harness, ["compare", ...args]);
}

async function manifestAt(relative: string): Promise<Record<string, any>> {
  const parsed = JSON.parse(await readFile(path.join(root(), relative), "utf8")) as Record<string, any>;
  expect(comparisonManifestSchema.safeParse(parsed).success).toBe(true);
  return parsed;
}

async function captureManifest(data: Record<string, any>): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(root(), data["manifest"]), "utf8")) as Record<string, any>;
}

/** Every output of a completed comparison, given its worst frames (their number depends on the span). */
function outputsFor(worstFrames: readonly { rank: number }[]): string[] {
  const stills = worstFrames.flatMap(({ rank }) => [`worst-${rank}-a.png`, `worst-${rank}-b.png`, `worst-${rank}-diff.png`]);
  return ["frames.json", "manifest.json", "triptych.mp4", ...stills].sort();
}

const timelineTime = (manifest: Record<string, any>, type: string): number =>
  manifest["timing"]["timeline"].find((event: { type: string }) => event.type === type).t;

// Each test makes several simulator captures; allow for slow, heavily loaded hosts.
describe("cappy compare", { timeout: 30_000 }, () => {
  it("compares two captures of one scenario and writes a triptych, per-frame scores, and a manifest", async () => {
    const first = await capture(["run", "boss_intro"], "1.0.0", 1);
    const second = await capture(["run", "boss_intro"], "1.1.0", 1);
    const { code, result } = await compare([first["captureId"], second["captureId"]]);
    expect(code, JSON.stringify(result["error"])).toBe(0);
    expect(result["warnings"]).toEqual([]);
    const data = result["data"];
    const [manifestA, manifestB] = [await captureManifest(first), await captureManifest(second)];
    const operation = (manifest: Record<string, any>): number => timelineTime(manifest, "SCENARIO_COMPLETED") - timelineTime(manifest, "SCENARIO_STARTED");

    expect(data).toMatchObject({
      status: "succeeded",
      source: { kind: "scenario", scenarioId: "boss_intro" },
      a: { captureId: first["captureId"], take: 1, gameBuild: "1.0.0", alignedStartMs: timelineTime(manifestA, "SCENARIO_STARTED") },
      b: { captureId: second["captureId"], take: 2, gameBuild: "1.1.0", alignedStartMs: timelineTime(manifestB, "SCENARIO_STARTED") },
      alignment: { event: "SCENARIO_STARTED", spanMs: Math.round(Math.min(operation(manifestA), operation(manifestB)) * 1000) / 1000 },
      normalization: { width: 1280, height: 720, frameRate: 30, scaledB: false },
      scores: { ssim: { mean: 1, min: 1 }, psnr: { mean: null, min: null } },
    });
    expect(data["alignment"]["spanMs"]).toBeGreaterThan(500);

    const directory = `comparisons/${data["comparisonId"]}`;
    expect(data["worstFrames"].length).toBeGreaterThanOrEqual(1);
    expect((await readdir(path.join(root(), directory))).sort()).toEqual(outputsFor(data["worstFrames"]));
    const manifest = await manifestAt(data["manifest"]);
    expect(manifest).toMatchObject({ comparisonVersion: 2, status: "succeeded", gates: {}, failedGates: [], identity: { comparisonId: data["comparisonId"] }, tooling: { ffmpeg: { version: "9.9.9-fake" } } });
    for (const artifact of manifest["artifacts"]) {
      expect((await hashFile(path.join(root(), artifact.path))).sha256).toBe(artifact.sha256);
    }
    const frames = JSON.parse(await readFile(path.join(root(), directory, "frames.json"), "utf8")) as { frame: number; tMs: number; ssim: number; psnr: number | null }[];
    expect(frames).toHaveLength(data["scores"]["frames"]);
    expect(frames[1]).toEqual({ frame: 2, tMs: 33.333, ssim: 1, psnr: null });

    // FFmpeg compared exactly the aligned span of each master.
    const args = (JSON.parse(await readFile(path.join(root(), directory, "triptych.mp4"), "utf8")) as { args: string[] }).args;
    expect(args.filter((arg, index) => args[index - 1] === "-ss").map(Number)).toEqual([data["a"]["alignedStartMs"] / 1000, data["b"]["alignedStartMs"] / 1000].map((value) => expect.closeTo(value, 6)));
    expect(Number(args[args.indexOf("-t") + 1])).toBeCloseTo(data["alignment"]["spanMs"] / 1000, 6);
    // No partial files are left behind.
    expect((await readdir(path.join(root(), directory))).some((name) => name.includes("partial"))).toBe(false);
  });

  it("records a regression below --min-ssim, keeps every output, and exits 1", async () => {
    masters = ["m".repeat(2048), "n".repeat(2048)];
    const first = await capture();
    const second = await capture(["run", "boss_intro"], "1.1.0");

    const informational = await compare([first["captureId"], second["captureId"]]);
    expect(informational.code).toBe(0);
    const { mean, min, minAtMs } = informational.result["data"]["scores"]["ssim"];
    expect(mean).toBeLessThan(0.99);
    expect([min, minAtMs]).toEqual([0.5, 33.333]);
    expect(informational.result["data"]["scores"]["psnr"]).toEqual({ mean: expect.any(Number), min: 12.5 });
    const directory = `comparisons/${informational.result["data"]["comparisonId"]}`;
    // Frame 2 is the dip, so it ranks first; any later ranks are at least a second away.
    const worstFrames = informational.result["data"]["worstFrames"] as { rank: number; tMs: number }[];
    expect(worstFrames[0]).toEqual({ rank: 1, tMs: 33.333, ssim: 0.5, a: `${directory}/worst-1-a.png`, b: `${directory}/worst-1-b.png`, diff: `${directory}/worst-1-diff.png` });
    expect(worstFrames.slice(1).every((entry) => entry.tMs >= 1033.333)).toBe(true);
    // The stills show the worst moment of each master, B scaled to A.
    const stillArgs = (JSON.parse(await readFile(path.join(root(), directory, "worst-1-diff.png"), "utf8")) as { args: string[] }).args;
    const readUntil = stillArgs
      .map((arg, index) => (arg === "-ss" ? Number(stillArgs[index + 1]) + Number(stillArgs[index + 3]) : undefined))
      .filter((value): value is number => value !== undefined);
    expect(readUntil).toEqual(
      [informational.result["data"]["a"], informational.result["data"]["b"]].map((side: { alignedStartMs: number }) => expect.closeTo((side.alignedStartMs + 33.333) / 1000 + 0.001, 6)),
    );
    const informationalManifest = await manifestAt(`${directory}/manifest.json`);
    expect(informationalManifest["artifacts"].map((artifact: { role: string }) => artifact.role)).toEqual([
      "triptych",
      "frames",
      ...worstFrames.flatMap(({ rank }) => [`worst-${rank}-a`, `worst-${rank}-b`, `worst-${rank}-diff`]),
    ]);

    const passing = await compare([first["captureId"], second["captureId"], "--min-ssim", "0.5"]);
    expect(passing.code).toBe(0);
    expect(passing.result["data"]).toMatchObject({ status: "succeeded", gates: { minSsim: 0.5 }, failedGates: [] });

    const gated = await compare([first["captureId"], second["captureId"], "-ms", "0.99"]);
    expect(gated.code).toBe(1);
    expect(gated.result).toMatchObject({ ok: false, error: { code: "COMPARISON_REGRESSED", details: { failedGates: ["minSsim"] } }, data: { status: "regressed" } });
    const manifest = await manifestAt(gated.result["data"]["manifest"]);
    expect(manifest).toMatchObject({ comparisonVersion: 2, status: "regressed", gates: { minSsim: 0.99 }, failedGates: ["minSsim"] });
    expect((await readdir(path.join(root(), "comparisons", gated.result["data"]["comparisonId"]))).sort()).toEqual(outputsFor(gated.result["data"]["worstFrames"]));
  });

  it("gates on the worst single frame", async () => {
    masters = ["m".repeat(2048), "n".repeat(2048)];
    const first = await capture();
    const second = await capture(["run", "boss_intro"], "1.1.0");
    // The fake scores frame 2 at 0.5 and every other frame at 0.99, so the mean stays high.
    const tight = await compare([first["captureId"], second["captureId"], "-mfs", "0.6", "--min-ssim", "0.5"]);
    expect(tight.code).toBe(1);
    expect(tight.result["data"]).toMatchObject({ status: "regressed", gates: { minFrameSsim: 0.6, minSsim: 0.5 }, failedGates: ["minFrameSsim"] });
    const loose = await compare([first["captureId"], second["captureId"], "--min-frame-ssim", "0.4"]);
    expect(loose.code).toBe(0);
    expect(loose.result["data"]).toMatchObject({ status: "succeeded", failedGates: [] });
  });

  it("gates on event drift and event counts, and lists every failed gate", async () => {
    const first = await capture();
    const shifted = [
      {
        id: "boss_intro",
        name: "Boss intro",
        parameters: { difficulty: { type: "integer", minimum: 1, maximum: 3, default: 2 } },
        requiredCapabilities: ["scenarios"],
        events: [
          { event: "BOSS_APPEAR", t: 100 },
          { event: "SPELL_CAST", t: 390, payload: { spell: "fireball" } },
          { event: "SPELL_CAST", t: 420, payload: { spell: "frost" } },
          { event: "IMPACT", t: 500, durationMs: 120 },
        ],
      },
    ];
    const { result: run } = await runCli(harness, ["run", "boss_intro"], { sim: { build: "1.1.0", timeScale: 0.2, scenarios: shifted } });
    const second = run["data"]["captureId"] as string;
    // SPELL_CAST moved 40 ms later, and a second SPELL_CAST appeared.
    const drift = await compare([first["captureId"], second, "--max-drift-ms", "20"]);
    expect(drift.code).toBe(1);
    expect(drift.result["data"]["failedGates"]).toEqual(["maxDriftMs"]);
    expect((await compare([first["captureId"], second, "-mdm", "100"])).code).toBe(0);
    const counts = await compare([first["captureId"], second, "-rse"]);
    expect(counts.result["data"]).toMatchObject({ status: "regressed", failedGates: ["requireSameEvents"] });
    const both = await compare([first["captureId"], second, "-rse", "-mdm", "20", "-ms", "0.5"]);
    expect(both.result["error"]).toMatchObject({ code: "COMPARISON_REGRESSED", details: { failedGates: ["maxDriftMs", "requireSameEvents"] } });
    // Without timeline gates the diff stays informational.
    expect((await compare([first["captureId"], second])).code).toBe(0);
  });

  it("rejects invalid gate values before any media work", async () => {
    const first = await capture();
    const second = await capture();
    for (const args of [["-mfs", "2"], ["--min-frame-ssim", "x"], ["--max-drift-ms", "-5"], ["-mdm", "soon"], ["-ms", ""]]) {
      const { code, result } = await compare([first["captureId"], second["captureId"], ...args]);
      expect([code, result["error"]["code"]], args.join(" ")).toEqual([2, "USAGE_INVALID"]);
    }
    expect(await readdir(path.join(root(), "comparisons"))).toEqual([]);
  });

  it("normalizes a different resolution to A's and records it", async () => {
    masters = ["m".repeat(2048), `SIZE:640x360\n${"n".repeat(2048)}`];
    const first = await capture();
    const second = await capture(["run", "boss_intro"], "1.1.0");
    const { code, result } = await compare([first["captureId"], second["captureId"]]);
    expect(code).toBe(0);
    expect(result["data"]["normalization"]).toEqual({ width: 1280, height: 720, frameRate: 30, scaledB: true });
    const args = (JSON.parse(await readFile(path.join(root(), result["data"]["artifacts"][0]["path"]), "utf8")) as { args: string[] }).args;
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("[1:v]fps=30,scale=1280:720");
  });

  it("reports how the builds' events differ without changing the verdict", async () => {
    const first = await capture();
    const changed = [
      {
        id: "boss_intro",
        name: "Boss intro",
        parameters: { difficulty: { type: "integer", minimum: 1, maximum: 3, default: 2 } },
        requiredCapabilities: ["scenarios"],
        events: [
          { event: "BOSS_APPEAR", t: 130 },
          { event: "SPELL_CAST", t: 350, payload: { spell: "fireball" } },
          { event: "SPELL_CAST", t: 420, payload: { spell: "frost" } },
          { event: "IMPACT", t: 520, durationMs: 100 },
        ],
      },
    ];
    const { result: run } = await runCli(harness, ["run", "boss_intro"], { sim: { build: "1.1.0", timeScale: 0.2, scenarios: changed } });
    const { code, result } = await compare([first["captureId"], run["data"]["captureId"], "--min-ssim", "0.9"]);
    expect(code).toBe(0);
    expect(result["data"]["status"]).toBe("succeeded");
    const diff = Object.fromEntries(result["data"]["timelineDiff"].map((entry: { type: string }) => [entry.type, entry]));
    expect(Object.keys(diff)).toEqual(["BOSS_APPEAR", "SPELL_CAST", "IMPACT"]);
    expect(diff["SPELL_CAST"]).toMatchObject({ countA: 1, countB: 2, matched: 1, missingAtMs: [], extraAtMs: [expect.any(Number)] });
    expect(diff["IMPACT"]).toMatchObject({ countA: 1, countB: 1, matched: 1, missingAtMs: [], extraAtMs: [] });
    // Scripted times differ by 20 ms between the builds; B's is later.
    expect(diff["IMPACT"]["meanDriftMs"]).toBeCloseTo(20, 0);
    expect(diff["BOSS_APPEAR"]["maxDriftMs"]).toBeCloseTo(30, 0);
    expect(result["warnings"]).toEqual(["timeline differs: SPELL_CAST occurs 1 time(s) in A and 2 in B"]);
    expect((await manifestAt(result["data"]["manifest"]))["timelineDiff"]).toEqual(result["data"]["timelineDiff"]);
  });

  it("aligns replay captures of one session on REPLAY_STARTED and warns when both report the same build", async () => {
    const recorded = await runCli(harness, ["record", "--duration", "0.2"]);
    const sessionId = recorded.result["data"]["session"]["id"] as string;
    const first = await capture(["replay", sessionId]);
    const second = await capture(["replay", sessionId]);
    const { code, result } = await compare([first["captureId"], second["captureId"]]);
    expect(code).toBe(0);
    expect(result["data"]).toMatchObject({ source: { kind: "replay", sessionId }, alignment: { event: "REPLAY_STARTED" } });
    expect(result["warnings"]).toEqual(['both captures report game build "1.0.0"']);
  });

  it("refuses ineligible captures before any media work", async () => {
    const good = await capture();
    const other = await capture(["run", "boss_intro", "--param", "difficulty=3"]);
    const failed = await capture(["run", "boss_intro", "--preset", "broken"]);
    const edited = await capture();
    await writeFile(path.join(root(), "captures", edited["captureId"], "master.mkv"), "tampered");

    const cases: [string[], number, string][] = [
      [[good["captureId"], other["captureId"]], 1, "COMPARE_INCOMPATIBLE"],
      [[good["captureId"], failed["captureId"]], 1, "COMPARE_INCOMPATIBLE"],
      [[good["captureId"], good["captureId"]], 2, "USAGE_INVALID"],
      [[good["captureId"]], 2, "USAGE_INVALID"],
      [[good["captureId"], "cap_missing"], 2, "CAPTURE_NOT_FOUND"],
      [[good["captureId"], edited["captureId"]], 1, "COMPARE_INPUT_INVALID"],
      [[good["captureId"], edited["captureId"], "--min-ssim", "1.5"], 2, "USAGE_INVALID"],
    ];
    for (const [args, exit, errorCode] of cases) {
      const { code, result } = await compare(args);
      expect([code, result["error"]["code"]], args.join(" ")).toEqual([exit, errorCode]);
    }
    expect(await readdir(path.join(root(), "comparisons"))).toEqual([]);
  });

  it("exits 4 when FFmpeg is missing", async () => {
    const first = await capture();
    const second = await capture();
    const configPath = path.join(harness.project, "cappy.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
    config["tools"]["ffmpeg"] = "./missing-ffmpeg";
    await writeFile(configPath, JSON.stringify(config));
    const { code, result } = await compare([first["captureId"], second["captureId"]]);
    expect(code).toBe(4);
    expect(result["error"]["code"]).toBe("TOOL_NOT_FOUND");
    expect(await readdir(path.join(root(), "comparisons"))).toEqual([]);
  });

  it("writes a failed manifest and publishes no partial output when FFmpeg fails", async () => {
    masters = ["m".repeat(2048), "FAILCMP"];
    const first = await capture();
    const second = await capture();
    const { code, result } = await compare([first["captureId"], second["captureId"]]);
    expect(code).toBe(1);
    expect(result).toMatchObject({ ok: false, error: { code: "COMPARISON_FAILED" }, data: { status: "failed", artifacts: [] } });
    const directory = path.join(root(), "comparisons", result["data"]["comparisonId"]);
    expect(await readdir(directory)).toEqual(["manifest.json"]);
    expect(await manifestAt(result["data"]["manifest"])).toMatchObject({ status: "failed", result: { error: { code: "COMPARISON_FAILED" } } });
  });

  it("publishes nothing when a worst-frame still cannot be extracted", async () => {
    masters = ["m".repeat(2048), "FAILSTILL"];
    const first = await capture();
    const second = await capture();
    const { code, result } = await compare([first["captureId"], second["captureId"]]);
    expect(code).toBe(1);
    expect(result).toMatchObject({ error: { code: "COMPARISON_FAILED", message: expect.stringContaining("worst frame 1") }, data: { status: "failed", artifacts: [] } });
    expect(await readdir(path.join(root(), "comparisons", result["data"]["comparisonId"]))).toEqual(["manifest.json"]);
  });

  it("is cleaned by ID and by --failed, --all, and --older-than, never taking its captures with it", async () => {
    const first = await capture();
    const second = await capture();
    const kept = (await compare([first["captureId"], second["captureId"]])).result["data"]["comparisonId"] as string;
    const byId = (await compare([first["captureId"], second["captureId"]])).result["data"]["comparisonId"] as string;

    const removed = await runCli(harness, ["clean", byId]);
    expect(removed.code).toBe(0);
    expect(removed.result["data"]["items"]).toEqual([expect.objectContaining({ id: byId, kind: "comparison" })]);
    expect(await readdir(path.join(root(), "comparisons"))).toEqual([kept]);

    masters = ["m".repeat(2048), "FAILCMP"];
    const third = await capture();
    const broken = (await compare([first["captureId"], third["captureId"]])).result["data"]["comparisonId"] as string;
    // A comparison written before gates existed (version 1) is still a cleanup item.
    const legacy = `cmp_${"3".repeat(8)}-0000-0000-0000-000000000000`;
    const ws = await (await import("@uppercut-labs/cappy-internal-workspace")).ManagedWorkspace.open({ projectDir: harness.project });
    if (!ws.ok) throw new Error(ws.error.message);
    await ws.value.writeManaged(`comparisons/${legacy}/manifest.json`, JSON.stringify({ comparisonVersion: 1, status: "failed", createdAt: new Date().toISOString() }));
    const failed = await runCli(harness, ["clean", "--failed"]);
    expect(failed.result["data"]["items"].map((item: { id: string }) => item.id).sort()).toEqual([broken, legacy].sort());

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 86_400_000);
    const old = await runCli(harness, ["clean", "--older-than", "1d", "--dry-run"]);
    expect(old.result["data"]["items"].map((item: { id: string }) => item.id)).toContain(kept);
    vi.useRealTimers();

    const all = await runCli(harness, ["clean", "--all", "--dry-run"]);
    expect(all.result["data"]["items"].filter((item: { kind: string }) => item.kind === "comparison").map((item: { id: string }) => item.id)).toEqual([kept]);
    for (const data of [first, second, third]) {
      expect(await readdir(path.join(root(), "captures", data["captureId"]))).toContain("manifest.json");
    }
  });

  it("renders a human summary", async () => {
    const first = await capture();
    const second = await capture(["run", "boss_intro"], "1.1.0");
    let stdout = "";
    const code = await main(["compare", first["captureId"], second["captureId"], "-C", harness.project], {
      cwd: repoRoot,
      env: process.env,
      write: (text) => {
        stdout += text;
      },
      writeError: () => undefined,
    });
    expect(code).toBe(0);
    expect(stdout).toMatch(/^Comparison cmp_\S+: succeeded \(scenario boss_intro\)/);
    expect(stdout).toContain(`A ${first["captureId"]} (take 1, build 1.0.0)`);
    expect(stdout).toContain("Aligned on SCENARIO_STARTED");
    expect(stdout).toContain("SSIM mean 1.0000, min 1.0000");
    expect(stdout).toMatch(/worst #1 +0 ms, SSIM 1\.0000: comparisons\/cmp_\S+\/worst-1-diff\.png/);
    expect(stdout).toContain("Timeline: 3 adapter event type(s), same counts");
    expect(stdout).toMatch(/triptych +comparisons\/cmp_\S+\/triptych\.mp4/);
  });
});

describe.runIf(process.env["CAPPY_REAL_TOOLS"] === "1")("real FFmpeg comparison", { timeout: 120_000 }, () => {
  /**
   * A 3 s test pattern; `box` paints a red box over [from, to) seconds of the master. `testsrc` moves,
   * so two captures whose aligned starts straddle a frame boundary compare one frame apart; `smptebars`
   * is static, for checks that must not depend on that.
   */
  const realMaster = (size: string, box?: [number, number], source = "testsrc") => (outputPath: string): void => {
    execFileSync("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `${source}=size=${size}:rate=30:duration=3`,
      ...(box === undefined ? [] : ["-vf", `drawbox=x=0:y=0:w=iw/2:h=ih/2:color=red:t=fill:enable='between(t,${box[0]},${box[1]})'`]),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", outputPath,
    ]);
  };

  async function realCaptures(writers: ((outputPath: string) => void)[]): Promise<Record<string, any>[]> {
    await harness.obs.close();
    let next = 0;
    await configure(harness, { writeMaster: (outputPath) => writers[next++]?.(outputPath) }, { tools: {} });
    return [await capture(["run", "boss_intro"], "1.0.0", 1), await capture(["run", "boss_intro"], "1.1.0", 1)];
  }

  it("scores identical real masters as identical and encodes a three-column triptych", async () => {
    const [first, second] = await realCaptures([realMaster("320x240", undefined, "smptebars"), realMaster("320x240", undefined, "smptebars")]);
    const { code, result } = await compare([first?.["captureId"], second?.["captureId"]]);
    expect(code, JSON.stringify(result["error"])).toBe(0);
    expect(result["data"]["scores"]["ssim"]["mean"]).toBeGreaterThanOrEqual(0.999);
    const triptych = await probeMedia("ffprobe", path.join(root(), result["data"]["artifacts"][0]["path"]), { timeoutMs: 30_000 });
    expect(triptych.ok && [triptych.value.width, triptych.value.height, triptych.value.videoCodec]).toEqual([960, 240, "h264"]);
  });

  it("scores a changed, differently sized master lower, with the worst frame in the changed span", async () => {
    const [first, second] = await realCaptures([realMaster("320x240"), realMaster("640x480", [0.25, 0.45])]);
    const { code, result } = await compare([first?.["captureId"], second?.["captureId"]]);
    expect(code, JSON.stringify(result["error"])).toBe(0);
    const { scores, normalization, b } = result["data"];
    expect(normalization).toMatchObject({ width: 320, height: 240, scaledB: true });
    expect(scores["ssim"]["mean"]).toBeLessThan(0.999);
    expect(scores["ssim"]["min"]).toBeLessThan(0.9);
    // The box covers 250-450 ms of B's master; frame times count from B's aligned start.
    const worstOnMaster = b["alignedStartMs"] + scores["ssim"]["minAtMs"];
    expect(worstOnMaster).toBeGreaterThanOrEqual(250 - 34);
    expect(worstOnMaster).toBeLessThanOrEqual(450 + 34);
    const [worst] = result["data"]["worstFrames"];
    expect(worst).toMatchObject({ rank: 1, tMs: scores["ssim"]["minAtMs"], ssim: scores["ssim"]["min"] });
    for (const still of [worst.a, worst.b, worst.diff]) {
      const probed = await probeMedia("ffprobe", path.join(root(), still), { timeoutMs: 30_000 });
      expect(probed.ok && [probed.value.width, probed.value.height, probed.value.videoCodec], still).toEqual([320, 240, "png"]);
    }
  });
});

