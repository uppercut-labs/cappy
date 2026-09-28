import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveExecutable } from "@uppercut-labs/cappy-internal-core";
import { type Harness, configure, createHarness, disposeHarness, repoRoot, runCli } from "../../packages/cli/test/support.js";

/*
 * Real Godot acceptance: the demo fixture runs headless under Cappy.
 * Opt-in with CAPPY_REAL_TOOLS=1; requires `godot` (4.x) on PATH.
 */
const godot = process.env["CAPPY_REAL_TOOLS"] === "1" ? await resolveExecutable("godot", { cwd: repoRoot }) : undefined;

// Each test launches real Godot and runs simulations in real time.
describe.runIf(godot !== undefined)("Godot adapter and demo", { timeout: 120_000 }, () => {
  let demo: string;
  let harness: Harness;

  beforeAll(async () => {
    const { assembleGodotDemo } = (await import(path.join(repoRoot, "scripts/assemble-godot-demo.mjs"))) as {
      assembleGodotDemo: (destination: string) => string;
    };
    const holder = await createHarness("cappy-godot-demo-");
    demo = assembleGodotDemo(path.join(holder.project, "demo"));
  });

  afterAll(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(path.dirname(demo), { recursive: true, force: true }));
  });

  beforeEach(async () => {
    harness = await createHarness("cappy-godot-");
    await configure(harness, {}, {
      project: { id: "godot-demo", name: "Cappy Godot Demo" },
      game: { command: godot, args: ["--headless", "--path", demo] },
      timeouts: { connectMs: 30_000, readyMs: 15_000, obsMs: 2_000, processMs: 60_000 },
    });
  });

  afterEach(async () => {
    await disposeHarness(harness);
  });

  it("registers a deterministic scenario with parameters and declares its capabilities", async () => {
    const { code, result } = await runCli(harness, ["scenarios"]);
    expect(code).toBe(0);
    expect(result["data"]["adapter"]).toMatchObject({
      adapter: { name: "cappy-godot", version: "0.1.0" },
      game: { id: "cappy-godot-demo", name: "Cappy Godot Demo" },
      build: "0.1.0",
      capabilities: ["alternate_cameras", "deterministic_replay", "freeform_recording", "replay", "scenarios", "time_scale"],
    });
    expect(result["data"]["scenarios"]).toEqual([
      expect.objectContaining({
        id: "orb_launch",
        parameters: {
          power: expect.objectContaining({ type: "integer", minimum: 1, maximum: 5, default: 3 }),
          gravity: expect.objectContaining({ type: "number", minimum: 0.5, maximum: 4 }),
        },
        requiredCapabilities: ["scenarios"],
      }),
    ]);
  });

  it("runs the demo scenario with semantic events in the Cappy timeline, identically every time", async () => {
    const first = await runCli(harness, ["run", "orb_launch", "--param", "power=4"]);
    expect(first.code).toBe(0);
    const second = await runCli(harness, ["run", "orb_launch", "--param", "power=4"]);
    const timeline = (result: Record<string, any>) => result["data"]["events"].map((event: { type: string; t: number }) => [event.type, event.t]);
    const events = timeline(first.result);
    expect(events[0]).toEqual(["LAUNCH", 0]);
    expect(events.filter(([type]: [string]) => type === "BOUNCE").length).toBeGreaterThan(0);
    expect(events.at(-1)[0]).toBe("SETTLED");
    expect(timeline(second.result)).toEqual(events);
    expect([first.result["data"]["take"], second.result["data"]["take"]]).toEqual([1, 2]);
    expect(first.result["data"]["state"]).toBe("succeeded");
  });

  it("applies the game's parameter validation hook", async () => {
    const { result } = await runCli(harness, ["run", "orb_launch", "--param", "power=5", "--param", "gravity=3"]);
    expect(result).toMatchObject({ ok: false, error: { code: "ADAPTER_OPERATION_FAILED", details: { adapterCode: "INVALID_PARAMETERS" } } });
  });

  it("records a freeform replay payload and replays it with the same timeline", async () => {
    const recorded = await runCli(harness, ["record", "--duration", "1.5"]);
    expect(recorded.code).toBe(0);
    const session = recorded.result["data"]["session"];
    expect(session).toMatchObject({ status: "completed", replay: { format: "cappy-godot-demo-runner-v1" } });
    const stored = JSON.parse(await readFile(path.join(harness.project, ".cappy/sessions", session.id, "timeline.json"), "utf8")) as {
      type: string;
      t: number;
    }[];

    const replayed = await runCli(harness, ["replay", session.id, "--no-capture"]);
    expect(replayed.code).toBe(0);
    const shape = (events: { type: string; t: number }[]) => events.map((event) => [event.type, event.t]);
    expect(shape(replayed.result["data"]["events"])).toEqual(shape(stored));
    expect(stored[0]?.type).toBe("RUN_START");
    expect(stored.at(-1)?.type).toBe("RUN_END");
  });

  it("captures a stored Godot session's replay through the full capture pipeline", async () => {
    const recorded = await runCli(harness, ["record", "--duration", "1"]);
    const sessionId = recorded.result["data"]["session"]["id"] as string;
    const stored = JSON.parse(await readFile(path.join(harness.project, ".cappy/sessions", sessionId, "timeline.json"), "utf8")) as {
      type: string;
      t: number;
    }[];

    const { code, result } = await runCli(harness, ["replay", sessionId]);
    expect(code).toBe(0);
    expect(result["data"]).toMatchObject({ captured: true, state: "succeeded", take: 1, source: { kind: "replay", sessionId } });
    const manifest = JSON.parse(await readFile(path.join(harness.project, ".cappy", result["data"]["manifest"]), "utf8")) as Record<string, any>;
    expect(manifest["status"]).toBe("succeeded");
    // Game events on the master clock, shifted back, match the recording exactly.
    const offset = manifest["timing"]["sync"]["adapterOffsetMs"] as number;
    const game = (manifest["timing"]["timeline"] as { source: string; type: string; t: number }[]).filter((event) => event.source === "adapter");
    expect(game.map((event) => event.type)).toEqual(stored.map((event) => event.type));
    game.forEach((event, index) => expect(event.t - offset).toBeCloseTo(stored[index]?.t ?? NaN, 2));
  });

  it("runs the demo's variant as a second named build and compares the two builds", async () => {
    const configPath = path.join(harness.project, "cappy.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
    config["builds"] = { b: { game: { args: ["--headless", "--path", demo, "--", "--variant=b"] } } };
    await import("node:fs/promises").then(({ writeFile }) => writeFile(configPath, JSON.stringify(config)));

    const listed = await runCli(harness, ["scenarios", "--build", "b"]);
    expect(listed.result["data"]["adapter"]["build"]).toBe("0.1.0+b");
    const { code, result } = await runCli(harness, ["compare-builds", "orb_launch", "base", "b", "-pa", "power=4", "--require-same-events"]);
    expect(code, JSON.stringify(result["error"])).toBe(0);
    const { a, b, comparison } = result["data"];
    expect([a.state, b.state, comparison.status]).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect([comparison.a.gameBuild, comparison.b.gameBuild]).toEqual(["0.1.0", "0.1.0+b"]);
    const manifestB = JSON.parse(await readFile(path.join(harness.project, ".cappy", b.manifest), "utf8")) as Record<string, any>;
    expect(manifestB["build"]).toMatchObject({ name: "b", gameBuild: "0.1.0+b" });
    // Same simulation, different look: the variant only marks itself in the launch event.
    expect(manifestB["timing"]["timeline"].find((event: { type: string }) => event.type === "LAUNCH")["payload"]).toEqual({ power: 4, variant: "b" });
  });

  it("replays a recorded session at half speed through the close camera, as the same simulation", async () => {
    const configPath = path.join(harness.project, "cappy.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
    config["presets"] = { ...config["presets"], slowmo: { presentation: { timeScale: 0.5, camera: "close" } }, drone: { presentation: { camera: "drone" } } };
    await import("node:fs/promises").then(({ writeFile }) => writeFile(configPath, JSON.stringify(config)));

    const recorded = await runCli(harness, ["record", "--duration", "1"]);
    const sessionId = recorded.result["data"]["session"]["id"] as string;
    const stored = JSON.parse(await readFile(path.join(harness.project, ".cappy/sessions", sessionId, "timeline.json"), "utf8")) as { type: string; t: number }[];
    const replayed = await runCli(harness, ["replay", sessionId, "-p", "slowmo"]);
    expect(replayed.code, JSON.stringify(replayed.result["error"])).toBe(0);
    const manifest = JSON.parse(await readFile(path.join(harness.project, ".cappy", replayed.result["data"]["manifest"]), "utf8")) as Record<string, any>;
    const offset = manifest["timing"]["sync"]["adapterOffsetMs"] as number;
    const game = (manifest["timing"]["timeline"] as { source: string; type: string; t: number; payload?: { simT?: number } }[]).filter((event) => event.source === "adapter");
    expect(game.map((event) => event.type)).toEqual(stored.map((event) => event.type));
    game.forEach((event, index) => {
      expect(event.payload?.simT).toBeCloseTo(stored[index]?.t ?? NaN, 2);
      expect(event.t - offset).toBeCloseTo((stored[index]?.t ?? NaN) * 2, 1);
    });
    const unknown = await runCli(harness, ["replay", sessionId, "-p", "drone"]);
    expect(unknown.result["error"]).toMatchObject({ code: "ADAPTER_OPERATION_FAILED", details: { adapterCode: "UNKNOWN_CAMERA" } });
  });

  // Userinfo would make WebSocketPeer connect to the host after the "@".
  it.each(["ws://192.0.2.1:9", "ws://127.0.0.1:1@192.0.2.1:9/", "ws://127.0.0.1.example.com:9", "ws://localhost.example.com:9", "ws://[::1]@192.0.2.1:9"])(
    "refuses the non-loopback controller endpoint %s",
    async (endpoint) => {
      const env = { ...process.env, CAPPY_ENDPOINT: endpoint, CAPPY_SESSION_TOKEN: "token" };
      const { stdout, stderr } = await promisify(execFile)(godot ?? "godot", ["--headless", "--path", demo, "--quit-after", "30"], { env });
      expect(`${stdout}${stderr}`).toContain(`Cappy: refusing non-loopback endpoint ${endpoint}`);
    },
  );
});
