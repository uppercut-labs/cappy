import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manifestSchema } from "@cappy/core";
import { hashFile } from "@cappy/workspace";
import { type Harness, configure, createHarness, disposeHarness, runCli } from "./support.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness("cappy-processing-");
});

afterEach(async () => {
  await disposeHarness(harness);
});

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

  it("fails a real required derivative that yields no frames, keeping the master", async () => {
    await configure(harness, { writeMaster: writeRealMaster }, { tools: {}, ...presetWith([{ kind: "still", role: "poster", options: { at: 30 } }]) });
    const { result } = await runCli(harness, ["run", "boss_intro"]);
    expect(result).toMatchObject({ ok: false, error: { code: "DERIVATIVE_FAILED" } });
    expect(await captureFiles(result["data"]["captureId"])).toEqual(["manifest.json", "master.mkv"]);
  });
});
