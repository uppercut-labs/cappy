import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, configure, createHarness, disposeHarness, runCli } from "./support.js";

let harness: Harness;
/** Simulator capabilities that include presentation. */
const PRESENTING = { capabilities: ["scenarios", "freeform_recording", "replay", "deterministic_replay", "time_scale", "alternate_cameras"] };

beforeEach(async () => {
  harness = await createHarness("cappy-presentation-");
  await configure(harness, {}, {
    presets: {
      trailer: { scene: "Capture" },
      slowmo: {
        scene: "Capture",
        presentation: { timeScale: 0.5, camera: "close" },
        derivatives: [{ kind: "still", role: "jump", options: { at: { event: "JUMP" } } }],
      },
      drone: { scene: "Capture", presentation: { camera: "drone" } },
    },
  });
});

afterEach(async () => {
  await disposeHarness(harness);
});

async function manifestOf(data: Record<string, any>): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(harness.project, ".cappy", data["manifest"]), "utf8")) as Record<string, any>;
}

async function recordSession(): Promise<string> {
  const recorded = await runCli(harness, ["record", "--duration", "0.2"], { sim: PRESENTING });
  return recorded.result["data"]["session"]["id"] as string;
}

describe("presentation for replays", () => {
  it("rejects an invalid time scale or camera in the config", async () => {
    const configPath = path.join(harness.project, "cappy.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
    config["presets"]["slowmo"]["presentation"] = { timeScale: 10, camera: "" };
    await writeFile(configPath, JSON.stringify(config));
    const { code, result } = await runCli(harness, ["run", "boss_intro"]);
    expect(code).toBe(3);
    expect(result["error"]["details"]["issues"].map((issue: { path: string }) => issue.path)).toEqual([
      "presets.slowmo.presentation.timeScale",
      "presets.slowmo.presentation.camera",
    ]);
  });

  it("requires the capabilities a presentation implies, before recording", async () => {
    const run = await runCli(harness, ["run", "boss_intro", "-p", "slowmo"]);
    expect(run.result["error"]).toMatchObject({ code: "CAPABILITY_MISSING", details: { missing: ["alternate_cameras", "time_scale"] } });
    const sessionId = await recordSession();
    const replay = await runCli(harness, ["replay", sessionId, "-p", "slowmo"]);
    expect(replay.result["error"]).toMatchObject({ code: "CAPABILITY_MISSING", details: { missing: ["alternate_cameras", "time_scale"] } });
    expect(harness.obs.requests.map((request) => request.requestType)).not.toContain("StartRecord");
  });

  it("replays in slow motion with presented event times, records the presentation, and anchors to it", async () => {
    const sessionId = await recordSession();
    const stored = JSON.parse(await readFile(path.join(harness.project, ".cappy/sessions", sessionId, "timeline.json"), "utf8")) as { type: string; t: number }[];
    const { code, result } = await runCli(harness, ["replay", sessionId, "-p", "slowmo"], { sim: PRESENTING });
    expect(code, JSON.stringify(result["error"])).toBe(0);
    const manifest = await manifestOf(result["data"]);
    expect(manifest["identity"]["presentation"]).toEqual({ timeScale: 0.5, camera: "close" });
    const offset = manifest["timing"]["sync"]["adapterOffsetMs"] as number;
    const game = manifest["timing"]["timeline"].filter((event: { source: string }) => event.source === "adapter") as { type: string; t: number; payload: { simT: number } }[];
    expect(game.map((event) => event.type)).toEqual(stored.map((event) => event.type));
    game.forEach((event, index) => {
      expect(event.payload.simT).toBe(stored[index]?.t);
      expect(event.t - offset).toBeCloseTo((stored[index]?.t ?? NaN) * 2, 2);
    });
    const jump = game.find((event) => event.type === "JUMP");
    expect(manifest["artifacts"].find((artifact: { role: string }) => artifact.role === "jump")["at"]["ms"]).toBe(jump?.t);
  });

  it("fails an operation that asks for a camera the adapter does not have", async () => {
    const sessionId = await recordSession();
    const { code, result } = await runCli(harness, ["replay", sessionId, "-p", "drone"], { sim: PRESENTING });
    expect(code).toBe(1);
    expect(result["error"]).toMatchObject({ code: "ADAPTER_OPERATION_FAILED", details: { adapterCode: "UNKNOWN_CAMERA" } });
  });

  it("warns when compared captures were presented differently", async () => {
    const sessionId = await recordSession();
    const normal = await runCli(harness, ["replay", sessionId, "-p", "trailer"], { sim: PRESENTING });
    const slow = await runCli(harness, ["replay", sessionId, "-p", "slowmo"], { sim: PRESENTING });
    const { result } = await runCli(harness, ["compare", normal.result["data"]["captureId"], slow.result["data"]["captureId"]]);
    expect(result["warnings"]).toEqual(expect.arrayContaining([expect.stringContaining("different presentation")]));
  });
});
