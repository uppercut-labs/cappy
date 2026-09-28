import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manifestSchema } from "@uppercut-labs/cappy-internal-core";
import { hashFile } from "@uppercut-labs/cappy-internal-workspace";
import { type Harness, configure, createHarness, disposeHarness, runCli } from "./support.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness("cappy-processing-");
});

afterEach(async () => {
  await disposeHarness(harness);
});

/** A simulator scenario with three hits, the second critical. */
const HITS = {
  id: "brawl",
  name: "Brawl",
  events: [
    { event: "HIT", t: 200, payload: { crit: false } },
    { event: "HIT", t: 600, payload: { crit: true } },
    { event: "HIT", t: 1200, payload: { crit: false } },
  ],
};

function presetWith(derivatives: Record<string, unknown>[]): Record<string, unknown> {
  return { presets: { trailer: { scene: "Capture", derivatives } }, defaultPreset: "trailer" };
}

async function manifestOf(result: Record<string, any>): Promise<Record<string, any>> {
  const text = await readFile(path.join(harness.project, ".cappy", result["data"]["manifest"]), "utf8");
  const parsed = JSON.parse(text) as Record<string, any>;
  expect(manifestSchema.safeParse(parsed).success).toBe(true);
  return parsed;
}

async function captureFiles(captureId: string): Promise<string[]> {
  return (await readdir(path.join(harness.project, ".cappy/captures", captureId))).sort();
}

describe("derivatives and manifests", () => {
  it("publishes every derivative with hashes and writes a successful manifest", async () => {
    await configure(
      harness,
      {},
      presetWith([
        { kind: "mp4", role: "delivery" },
        { kind: "clip", role: "highlight", options: { start: 0.5, duration: 1 } },
        { kind: "thumbnail", role: "thumb", options: { at: 1 } },
        { kind: "still", role: "poster", required: false },
      ]),
    );
    const { code, result } = await runCli(harness, ["run", "boss_intro"]);
    expect(code).toBe(0);
    const { captureId, artifacts } = result["data"];
    expect(artifacts.map((artifact: { role: string; path: string }) => [artifact.role, artifact.path])).toEqual([
      ["master", `captures/${captureId}/master.mkv`],
      ["delivery", `captures/${captureId}/delivery.mp4`],
      ["highlight", `captures/${captureId}/highlight.mp4`],
      ["thumb", `captures/${captureId}/thumb.jpg`],
      ["poster", `captures/${captureId}/poster.png`],
    ]);
    for (const artifact of artifacts) {
      expect(artifact).toMatchObject({ ownership: "managed", bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect((await hashFile(path.join(harness.project, ".cappy", artifact.path))).sha256).toBe(artifact.sha256);
    }
    expect(await captureFiles(captureId)).toEqual(["delivery.mp4", "highlight.mp4", "manifest.json", "master.mkv", "poster.png", "thumb.jpg"]);

    const manifest = await manifestOf(result);
    expect(manifest).toMatchObject({
      manifestVersion: 1,
      status: "succeeded",
      identity: { captureId, take: 1, project: { id: "sim" }, source: { kind: "scenario", scenarioId: "boss_intro", parameters: { difficulty: 2 } } },
      build: { cappyVersion: "0.1.0", adapter: { name: "cappy-adapter-simulator" }, protocolVersion: "1", capabilities: expect.arrayContaining(["scenarios"]) },
      tooling: { obs: { version: "31.0.0" }, ffmpeg: { version: "9.9.9-fake" }, ffprobe: { version: "9.9.9-fake" }, preset: { name: "trailer" } },
      result: { warnings: [], checks: expect.arrayContaining([{ name: "master.probe", passed: true, detail: "matroska,webm, h264" }]) },
    });
    expect(manifest["timing"]["timeline"].map((event: { type: string }) => event.type)).toEqual([
      "RECORDING_STARTED",
      "SCENARIO_STARTED",
      "BOSS_APPEAR",
      "SPELL_CAST",
      "IMPACT",
      "SCENARIO_COMPLETED",
      "RECORDING_STOPPED",
    ]);
    expect(manifest["artifacts"][0]).toMatchObject({ role: "master", durationMs: 2000, width: 1280, height: 720 });
    expect(manifest["result"]["checks"].every((check: { passed: boolean }) => check.passed)).toBe(true);

    // The session behind the capture is recorded too.
    const session = JSON.parse(await readFile(path.join(harness.project, ".cappy/sessions", manifest["identity"]["sessionId"], "session.json"), "utf8"));
    expect(session).toMatchObject({ origin: "scenario", status: "completed", scenario: { id: "boss_intro" } });
  });

  it.each([
    ["exits non-zero", "fail-delivery"],
    ["writes an empty file", "empty-delivery"],
    ["writes nothing", "missing-delivery"],
    ["writes invalid media", "corrupt-delivery"],
  ])("fails processing when a required derivative %s, and keeps the master", async (_label, role) => {
    await configure(harness, {}, presetWith([{ kind: "mp4", role }]));
    const { code, result } = await runCli(harness, ["run", "boss_intro"]);
    expect(code).toBe(1);
    expect(result).toMatchObject({ ok: false, error: { code: "DERIVATIVE_FAILED", details: { role } }, data: { state: "failed" } });
    const { captureId, artifacts } = result["data"];
    // The verified master survives the failure; no partial output is left behind.
    expect(artifacts.map((artifact: { role: string }) => artifact.role)).toEqual(["master"]);
    expect(await captureFiles(captureId)).toEqual(["manifest.json", "master.mkv"]);
    const manifest = await manifestOf(result);
    expect(manifest).toMatchObject({ status: "failed", result: { error: { code: "DERIVATIVE_FAILED" } } });
    expect(manifest["result"]["checks"]).toContainEqual(expect.objectContaining({ name: `derivative.${role}`, passed: false }));
  });

  it("warns about a failed optional derivative and still succeeds", async () => {
    await configure(harness, {}, presetWith([{ kind: "mp4", role: "delivery" }, { kind: "thumbnail", role: "fail-thumb", required: false }]));
    const { code, result } = await runCli(harness, ["run", "boss_intro"]);
    expect(code).toBe(0);
    expect(result["warnings"]).toEqual([expect.stringContaining('optional derivative "fail-thumb"')]);
    const manifest = await manifestOf(result);
    expect(manifest["status"]).toBe("succeeded");
    expect(manifest["artifacts"].map((artifact: { role: string }) => artifact.role)).toEqual(["master", "delivery"]);
  });

  it("fails when ffprobe rejects the master, and keeps it for diagnosis", async () => {
    await configure(harness, { masterBytes: Buffer.from("CORRUPT recording") });
    const { result } = await runCli(harness, ["run", "boss_intro"]);
    expect(result).toMatchObject({ ok: false, error: { code: "MEDIA_PROBE_FAILED" }, data: { state: "failed" } });
    expect(await captureFiles(result["data"]["captureId"])).toEqual(["manifest.json", "master.mkv"]);
    expect((await manifestOf(result))["status"]).toBe("failed");
  });

  it("rejects invalid derivative options before launching the game", async () => {
    await configure(harness, {}, presetWith([{ kind: "clip", role: "highlight", options: { start: -1 } }]));
    const { code, result } = await runCli(harness, ["run", "boss_intro"]);
    expect(code).toBe(3);
    expect(result["error"]).toMatchObject({ code: "DERIVATIVE_OPTIONS_INVALID", details: { problems: expect.arrayContaining([expect.stringContaining("highlight")]) } });
    expect(harness.obs.requests.map((request) => request.requestType)).not.toContain("StartRecord");
  });

  it("cuts event-anchored clips, stills, and thumbnails and records their resolved times", async () => {
    await configure(
      harness,
      {},
      presetWith([
        { kind: "clip", role: "highlight", options: { start: { event: "SPELL_CAST", offset: -0.2, where: { spell: "fireball" } }, end: { event: "IMPACT", offset: 0.3 } } },
        { kind: "clip", role: "opening", options: { start: 0.5, duration: 1 } },
        { kind: "still", role: "impact", options: { at: { event: "IMPACT" } } },
        { kind: "thumbnail", role: "thumb", options: { at: { event: "SCENARIO_STARTED", occurrence: "last" } } },
      ]),
    );
    const { code, result } = await runCli(harness, ["run", "boss_intro"]);
    expect(code).toBe(0);
    expect(result["warnings"]).toEqual([]);
    const manifest = await manifestOf(result);
    const byType = Object.fromEntries(manifest["timing"]["timeline"].map((event: { type: string }) => [event.type, event]));
    const byRole = Object.fromEntries(manifest["artifacts"].map((artifact: { role: string }) => [artifact.role, artifact]));
    const spell = byType["SPELL_CAST"];
    const impact = byType["IMPACT"];
    const round = (ms: number): number => Math.round(ms * 1000) / 1000;

    expect(byRole["highlight"]["window"]).toEqual({ startMs: round(spell.t - 200), endMs: round(impact.t + 300), startEventId: spell.id, endEventId: impact.id });
    expect(byRole["opening"]["window"]).toEqual({ startMs: 500, endMs: 1500 });
    expect(byRole["impact"]["at"]).toEqual({ ms: impact.t, eventId: impact.id });
    expect(byRole["thumb"]["at"]).toEqual({ ms: byType["SCENARIO_STARTED"].t, eventId: byType["SCENARIO_STARTED"].id });

    // FFmpeg was asked for exactly the resolved window.
    const args = async (role: string, extension: string): Promise<string[]> =>
      (JSON.parse(await readFile(path.join(harness.project, ".cappy/captures", result["data"]["captureId"], `${role}.${extension}`), "utf8")) as { args: string[] }).args;
    const highlight = await args("highlight", "mp4");
    expect(Number(highlight[highlight.indexOf("-ss") + 1])).toBeCloseTo((spell.t - 200) / 1000, 6);
    expect(Number(highlight[highlight.indexOf("-t") + 1])).toBeCloseTo((impact.t + 300 - (spell.t - 200)) / 1000, 6);
    // The still reads video up to the IMPACT and keeps its last frame.
    const still = await args("impact", "png");
    expect(Number(still[still.indexOf("-ss") + 1]) + Number(still[still.indexOf("-t") + 1])).toBeCloseTo(impact.t / 1000 + 0.001, 6);
  });

  it("fails a required derivative whose anchor never happened, and keeps the master", async () => {
    await configure(harness, {}, presetWith([{ kind: "clip", role: "finale", options: { start: { event: "BOSS_DEFEATED" }, duration: 1 } }]));
    const { code, result } = await runCli(harness, ["run", "boss_intro"]);
    expect(code).toBe(1);
    expect(result).toMatchObject({ ok: false, error: { code: "DERIVATIVE_ANCHOR_UNRESOLVED", details: { role: "finale" } }, data: { state: "failed" } });
    expect(await captureFiles(result["data"]["captureId"])).toEqual(["manifest.json", "master.mkv"]);
    const manifest = await manifestOf(result);
    expect(manifest["result"]["checks"]).toContainEqual(expect.objectContaining({ name: "derivative.finale", passed: false }));
  });

  it("skips an optional derivative whose anchor never happened, with a warning", async () => {
    await configure(
      harness,
      {},
      presetWith([
        { kind: "still", role: "finale", required: false, options: { at: { event: "IMPACT", occurrence: 2 } } },
        { kind: "still", role: "impact", options: { at: { event: "IMPACT", offset: 60 } } },
      ]),
    );
    const { code, result } = await runCli(harness, ["run", "boss_intro"]);
    expect(code).toBe(0);
    expect(result["warnings"]).toEqual([
      expect.stringContaining('optional derivative "finale" was skipped: derivative "finale": no IMPACT #2 event'),
      expect.stringMatching(/still "impact" time .* was clamped to the master \(2000 ms\)/),
    ]);
    const manifest = await manifestOf(result);
    expect(manifest["artifacts"].map((artifact: { role: string }) => artifact.role)).toEqual(["master", "impact"]);
    // Clamped to the end of the fake master (2 s), where FFmpeg takes its last frame.
    expect(manifest["artifacts"][1]["at"]["ms"]).toBe(2000);
  });

  it("rejects invalid anchors before launching the game", async () => {
    await configure(harness, {}, presetWith([{ kind: "clip", role: "highlight", options: { start: { event: "SPELL CAST" }, duration: 1, end: 2 } }]));
    const { code, result } = await runCli(harness, ["run", "boss_intro"]);
    expect(code).toBe(3);
    expect(result["error"]).toMatchObject({
      code: "DERIVATIVE_OPTIONS_INVALID",
      details: { problems: expect.arrayContaining([expect.stringContaining("highlight: start"), expect.stringContaining("exactly one of duration or end")]) },
    });
    expect(harness.obs.requests.map((request) => request.requestType)).not.toContain("StartRecord");
  });

  it("produces one output per matching event with occurrence every", async () => {
    await configure(
      harness,
      {},
      presetWith([
        { kind: "clip", role: "hit", options: { start: { event: "HIT", occurrence: "every", offset: -0.05 }, duration: 0.1 } },
        { kind: "still", role: "crit", options: { at: { event: "HIT", occurrence: "every", where: { crit: true } } } },
        { kind: "still", role: "miss", required: false, options: { at: { event: "MISS", occurrence: "every" } } },
      ]),
    );
    const { code, result } = await runCli(harness, ["run", "brawl"], { sim: { scenarios: [HITS] } });
    expect(code, JSON.stringify(result["error"])).toBe(0);
    const manifest = await manifestOf(result);
    const hits = manifest["timing"]["timeline"].filter((event: { type: string }) => event.type === "HIT");
    const roles = manifest["artifacts"].map((artifact: { role: string }) => artifact.role);
    expect(roles).toEqual(["master", "hit-1", "hit-2", "hit-3", "crit-1"]);
    hits.forEach((hit: { id: string; t: number }, index: number) => {
      const artifact = manifest["artifacts"].find((entry: { role: string }) => entry.role === `hit-${index + 1}`);
      expect(artifact["window"]).toMatchObject({ startEventId: hit.id, startMs: Math.round((hit.t - 50) * 1000) / 1000 });
    });
    expect(manifest["artifacts"][4]["at"]).toEqual({ ms: hits[1].t, eventId: hits[1].id });
    expect(result["warnings"]).toEqual([expect.stringContaining('optional derivative "miss" was skipped')]);
  });

  it("fails a required every-derivative that matches nothing", async () => {
    await configure(harness, {}, presetWith([{ kind: "still", role: "miss", options: { at: { event: "MISS", occurrence: "every" } } }]));
    const { code, result } = await runCli(harness, ["run", "brawl"], { sim: { scenarios: [HITS] } });
    expect(code).toBe(1);
    expect(result["error"]).toMatchObject({ code: "DERIVATIVE_ANCHOR_UNRESOLVED", details: { role: "miss" } });
  });

  it("numbers takes per scenario and parameters without overwriting earlier takes", async () => {
    await configure(harness);
    const first = await runCli(harness, ["run", "boss_intro"]);
    const second = await runCli(harness, ["run", "boss_intro"]);
    const other = await runCli(harness, ["run", "boss_intro", "--param", "difficulty=3"]);
    expect([first.result["data"]["take"], second.result["data"]["take"], other.result["data"]["take"]]).toEqual([1, 2, 1]);
    expect(first.result["data"]["captureId"]).not.toBe(second.result["data"]["captureId"]);
    expect(existsSync(path.join(harness.project, ".cappy", first.result["data"]["manifest"]))).toBe(true);
  });

  it("keeps secrets out of manifests", async () => {
    await configure(harness, { password: "super-secret-obs-pw" }, { obs: { url: "placeholder", scene: "Capture", passwordEnv: "TEST_OBS_PW" } });
    const config = JSON.parse(await readFile(path.join(harness.project, "cappy.config.json"), "utf8")) as Record<string, any>;
    config["obs"]["url"] = harness.obs.url;
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(harness.project, "cappy.config.json"), JSON.stringify(config)));
    const { code, result } = await runCli(harness, ["run", "boss_intro"], { env: { TEST_OBS_PW: "super-secret-obs-pw" } });
    expect(code).toBe(0);
    const text = await readFile(path.join(harness.project, ".cappy", result["data"]["manifest"]), "utf8");
    expect(text).not.toContain("super-secret-obs-pw");
    expect(text).not.toContain("TEST_OBS_PW");
  });
});

describe.runIf(process.env["CAPPY_REAL_TOOLS"] === "1")("real FFmpeg media", () => {
  const writeRealMaster = (outputPath: string): void => {
    execFileSync("ffmpeg", [
      "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", outputPath,
    ]);
  };

  it("probes a real master and produces real derivatives", async () => {
    await configure(
      harness,
      { writeMaster: writeRealMaster },
      {
        tools: {},
        ...presetWith([
          { kind: "mp4", role: "delivery", options: { preset: "ultrafast" } },
          { kind: "clip", role: "highlight", options: { start: 0.5, duration: 1, preset: "ultrafast" } },
          { kind: "thumbnail", role: "thumb", options: { at: 1, width: 160 } },
          { kind: "still", role: "poster", options: { at: 1.5 } },
        ]),
      },
    );
    const { code, result } = await runCli(harness, ["run", "boss_intro"]);
    expect(code).toBe(0);
    const manifest = await manifestOf(result);
    const byRole = Object.fromEntries(manifest["artifacts"].map((artifact: { role: string }) => [artifact.role, artifact]));
    expect(byRole["master"]).toMatchObject({ width: 320, height: 240, durationMs: expect.any(Number) });
    expect(byRole["delivery"]).toMatchObject({ mediaType: "video/mp4", width: 320, height: 240 });
    expect(byRole["highlight"]["durationMs"]).toBeGreaterThan(800);
    expect(byRole["highlight"]["durationMs"]).toBeLessThan(1300);
    expect(byRole["thumb"]).toMatchObject({ mediaType: "image/jpeg", width: 160, height: 120 });
    expect(byRole["poster"]).toMatchObject({ mediaType: "image/png", width: 320, height: 240 });
    expect(manifest["tooling"]["ffmpeg"]["version"]).not.toContain("fake");
  });

  it("cuts a real anchored clip and still at the resolved times", async () => {
    await configure(
      harness,
      { writeMaster: writeRealMaster },
      {
        tools: {},
        ...presetWith([
          { kind: "clip", role: "highlight", options: { start: { event: "SPELL_CAST", offset: -0.2 }, end: { event: "IMPACT", offset: 1 }, preset: "ultrafast" } },
          { kind: "still", role: "impact", options: { at: { event: "IMPACT" } } },
        ]),
      },
    );
    const { code, result } = await runCli(harness, ["run", "boss_intro"]);
    expect(code).toBe(0);
    const manifest = await manifestOf(result);
    const byRole = Object.fromEntries(manifest["artifacts"].map((artifact: { role: string }) => [artifact.role, artifact]));
    const impact = manifest["timing"]["timeline"].find((event: { type: string }) => event.type === "IMPACT");
    const { startMs, endMs } = byRole["highlight"]["window"];
    expect(Math.abs(byRole["highlight"]["durationMs"] - (endMs - startMs))).toBeLessThanOrEqual(100);
    expect(byRole["impact"]).toMatchObject({ mediaType: "image/png", width: 320, height: 240, at: { ms: impact.t, eventId: impact.id } });
  });

  it("takes an anchored still at a master's end even when its video stops before its reported duration", async () => {
    // Like OBS masters, the audio outlasts the video, so the reported duration runs past the last frame.
    const unevenMaster = (outputPath: string): void => {
      execFileSync("ffmpeg", [
        "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=2",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=2.4", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", outputPath,
      ]);
    };
    await configure(harness, { writeMaster: unevenMaster }, { tools: {}, ...presetWith([{ kind: "still", role: "last", options: { at: { event: "IMPACT", offset: 30 } } }]) });
    const { code, result } = await runCli(harness, ["run", "boss_intro"]);
    expect(code, JSON.stringify(result["error"])).toBe(0);
    const manifest = await manifestOf(result);
    const master = manifest["artifacts"][0];
    expect(master["durationMs"]).toBeGreaterThan(2300);
    expect(manifest["artifacts"][1]).toMatchObject({ role: "last", mediaType: "image/png", width: 320, height: 240, at: { ms: master["durationMs"] } });
    expect(result["warnings"]).toEqual([expect.stringContaining('still "last" time')]);
  });

  it("cuts a real clip and still for every matching event", async () => {
    await configure(
      harness,
      { writeMaster: writeRealMaster },
      {
        tools: {},
        ...presetWith([
          { kind: "clip", role: "hit", options: { start: { event: "HIT", occurrence: "every", offset: -0.1 }, duration: 0.3, preset: "ultrafast" } },
          { kind: "still", role: "impact", options: { at: { event: "HIT", occurrence: "every" } } },
        ]),
      },
    );
    const { code, result } = await runCli(harness, ["run", "brawl"], { sim: { scenarios: [HITS] } });
    expect(code, JSON.stringify(result["error"])).toBe(0);
    const manifest = await manifestOf(result);
    const clips = manifest["artifacts"].filter((artifact: { role: string }) => artifact.role.startsWith("hit-"));
    expect(clips).toHaveLength(3);
    for (const clip of clips) {
      expect(Math.abs(clip["durationMs"] - (clip["window"]["endMs"] - clip["window"]["startMs"]))).toBeLessThanOrEqual(100);
    }
    const stills = manifest["artifacts"].filter((artifact: { role: string }) => artifact.role.startsWith("impact-"));
    expect(stills.map((still: { mediaType: string; width: number }) => [still.mediaType, still.width])).toEqual([
      ["image/png", 320],
      ["image/png", 320],
      ["image/png", 320],
    ]);
  });

  it("fails a real required derivative that yields no frames, keeping the master", async () => {
    await configure(harness, { writeMaster: writeRealMaster }, { tools: {}, ...presetWith([{ kind: "still", role: "poster", options: { at: 30 } }]) });
    const { result } = await runCli(harness, ["run", "boss_intro"]);
    expect(result).toMatchObject({ ok: false, error: { code: "DERIVATIVE_FAILED" } });
    expect(await captureFiles(result["data"]["captureId"])).toEqual(["manifest.json", "master.mkv"]);
  });
});
