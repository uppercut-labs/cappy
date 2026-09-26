import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, configure, createHarness, disposeHarness, runCli, simulatorBin } from "./support.js";

let harness: Harness;

/** Simulator launch arguments for a build that reports `build` (and optionally different scenarios). */
const simulator = (options: Record<string, unknown>): string[] => [simulatorBin, "--options", JSON.stringify(options)];

const SHIFTED = [
  {
    id: "boss_intro",
    name: "Boss intro",
    parameters: { difficulty: { type: "integer", minimum: 1, maximum: 3, default: 2 } },
    requiredCapabilities: ["scenarios"],
    events: [
      { event: "BOSS_APPEAR", t: 100 },
      { event: "SPELL_CAST", t: 350, payload: { spell: "fireball" } },
      { event: "SPELL_CAST", t: 380, payload: { spell: "frost" } },
      { event: "IMPACT", t: 500, durationMs: 120 },
    ],
  },
];

beforeEach(async () => {
  harness = await createHarness("cappy-builds-");
  await configure(harness, {}, {
    builds: {
      v1: { game: { args: simulator({ build: "1.0.0" }) } },
      v2: { game: { args: simulator({ build: "2.0.0" }) } },
      v3: { game: { args: simulator({ build: "3.0.0", scenarios: SHIFTED }) } },
      broken: { game: { command: "not-a-real-game-binary" } },
    },
  });
});

afterEach(async () => {
  await disposeHarness(harness);
});

async function manifestOf(data: Record<string, any>): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(harness.project, ".cappy", data["manifest"]), "utf8")) as Record<string, any>;
}

const captures = async (): Promise<string[]> => readdir(path.join(harness.project, ".cappy/captures")).catch(() => []);

describe("named builds", () => {
  it("launches a named build, merged with the base game, and records its name", async () => {
    const { code, result } = await runCli(harness, ["run", "boss_intro", "-b", "v2"]);
    expect(code).toBe(0);
    expect((await manifestOf(result["data"]))["build"]).toMatchObject({ name: "v2", gameBuild: "2.0.0" });
    const plain = await runCli(harness, ["run", "boss_intro"]);
    expect((await manifestOf(plain.result["data"]))["build"]["name"]).toBeUndefined();
    expect((await runCli(harness, ["scenarios", "--build", "v1"])).result["data"]["adapter"]["build"]).toBe("1.0.0");
    const recorded = await runCli(harness, ["record", "-d", "0.2", "-b", "v1"]);
    expect(recorded.result["data"]["session"]["gameBuild"]).toBe("1.0.0");
  });

  it("refuses an unknown build before launching and reserves the name base", async () => {
    const unknown = await runCli(harness, ["run", "boss_intro", "--build", "v9"]);
    expect(unknown.code).toBe(2);
    expect(unknown.result["error"]).toMatchObject({ code: "BUILD_NOT_FOUND", details: { available: ["base", "v1", "v2", "v3", "broken"] } });
    expect(harness.obs.requests.map((request) => request.requestType)).not.toContain("StartRecord");

    const configPath = path.join(harness.project, "cappy.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, any>;
    config["builds"]["base"] = { game: { args: [] } };
    await writeFile(configPath, JSON.stringify(config));
    const reserved = await runCli(harness, ["run", "boss_intro"]);
    expect(reserved.code).toBe(3);
    expect(reserved.result["error"]["code"]).toBe("CONFIG_INVALID");
  });

  it("checks every build's command in doctor", async () => {
    const { code, result } = await runCli(harness, ["doctor"]);
    expect(code).toBe(4);
    const checks = Object.fromEntries(result["data"]["checks"].map((entry: { id: string; status: string }) => [entry.id, entry.status]));
    expect(checks).toMatchObject({ game: "pass", "game.v1": "pass", "game.v2": "pass", "game.v3": "pass", "game.broken": "fail" });
    expect(result["error"]["details"]["failed"]).toEqual(["game.broken"]);
  });
});

describe("cappy compare-builds", () => {
  it("replays one session with two builds and compares the captures", async () => {
    const recorded = await runCli(harness, ["record", "-d", "0.2"]);
    const sessionId = recorded.result["data"]["session"]["id"] as string;
    const { code, result } = await runCli(harness, ["compare-builds", sessionId, "v1", "v2"]);
    expect(code, JSON.stringify(result["error"])).toBe(0);
    const { builds, a, b, comparison } = result["data"];
    expect(builds).toEqual({ a: "v1", b: "v2" });
    expect([a.source, b.source]).toEqual([{ kind: "replay", sessionId }, { kind: "replay", sessionId }]);
    expect([a.take, b.take]).toEqual([1, 2]);
    expect(comparison).toMatchObject({ status: "succeeded", a: { captureId: a.captureId, gameBuild: "1.0.0" }, b: { captureId: b.captureId, gameBuild: "2.0.0" } });
    expect((await manifestOf(a))["build"]["name"]).toBe("v1");
    expect(result["warnings"]).not.toContain(expect.stringContaining("same game build"));
  });

  it("captures a scenario with parameters on each build, including the base game", async () => {
    const { code, result } = await runCli(harness, ["compare-builds", "boss_intro", "base", "v2", "-pa", "difficulty=3"]);
    expect(code).toBe(0);
    expect(result["data"]["a"]).toMatchObject({ scenario: { id: "boss_intro", parameters: { difficulty: 3 } }, state: "succeeded" });
    expect((await manifestOf(result["data"]["b"]))["build"]["name"]).toBe("v2");
    expect(result["data"]["comparison"]["status"]).toBe("succeeded");
  });

  it("passes gates through, so builds whose events differ regress", async () => {
    const { code, result } = await runCli(harness, ["compare-builds", "boss_intro", "v1", "v3", "--require-same-events"]);
    expect(code).toBe(1);
    expect(result["error"]).toMatchObject({ code: "COMPARISON_REGRESSED", details: { failedGates: ["requireSameEvents"] } });
    expect(result["data"]["comparison"]["timelineDiff"]).toContainEqual(expect.objectContaining({ type: "SPELL_CAST", countA: 1, countB: 2 }));
  });

  it("stops at the first failed capture", async () => {
    const { code, result } = await runCli(harness, ["compare-builds", "boss_intro", "broken", "v1"]);
    expect(code).toBe(4);
    expect(result["error"]["code"]).toBe("GAME_LAUNCH_FAILED");
    expect(result["data"]["b"]).toBeUndefined();
    expect(result["data"]["comparison"]).toBeUndefined();
    expect(await captures()).toEqual([]);
  });

  it("rejects bad arguments before anything launches", async () => {
    const cases: [string[], number, string][] = [
      [["boss_intro", "v1", "v1"], 2, "USAGE_INVALID"],
      [["boss_intro", "v1"], 2, "USAGE_INVALID"],
      [["boss_intro", "v1", "v9"], 2, "BUILD_NOT_FOUND"],
      [["boss_intro", "v1", "v2", "--build", "v1"], 2, "USAGE_INVALID"],
      [["boss_intro", "v1", "v2", "--no-capture"], 2, "USAGE_INVALID"],
      [["boss_intro", "v1", "v2", "-mfs", "3"], 2, "USAGE_INVALID"],
    ];
    for (const [args, exit, errorCode] of cases) {
      const { code, result } = await runCli(harness, ["compare-builds", ...args]);
      expect([code, result["error"]["code"]], args.join(" ")).toEqual([exit, errorCode]);
    }
    expect(await captures()).toEqual([]);
  });
});
