import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALLOWED_OBS_REQUESTS } from "@cappy/obs";
import { hashFile } from "@cappy/workspace";
import { type Harness, configure, createHarness, disposeHarness, runCli } from "./support.js";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness("cappy-run-");
});

afterEach(async () => {
  await disposeHarness(harness);
});

function requestTypes(): string[] {
  return harness.obs.requests.map((request) => request.requestType);
}

async function managedCaptures(): Promise<string[]> {
  const dir = path.join(harness.project, ".cappy/captures");
  return existsSync(dir) ? readdir(dir) : [];
}

describe("cappy run", () => {
  it("drives a full fake-OBS capture of a simulator scenario", async () => {
    await configure(harness);
    const { code, result } = await runCli(harness, ["run", "boss_intro", "--param", "difficulty=3", "--preset", "trailer"]);
    expect(code).toBe(0);
    const data = result["data"];
    expect(data).toMatchObject({
      state: "succeeded",
      take: 1,
      scenario: { id: "boss_intro", parameters: { difficulty: 3 } },
      preset: "trailer",
      obs: { version: "31.0.0", scene: "Capture" },
      manifest: `captures/${data.captureId}/manifest.json`,
    });
    const master = data.artifacts[0];
    expect(master).toMatchObject({
      role: "master",
      path: `captures/${data.captureId}/master.mkv`,
      ownership: "managed",
      mediaType: "video/x-matroska",
      bytes: 2048,
      source: { tool: "obs", version: "31.0.0" },
    });
    expect(data.events.map((event: { type: string }) => event.type)).toEqual(["BOSS_APPEAR", "SPELL_CAST", "IMPACT"]);

    // The verified master was moved into the managed workspace and registered with its hash.
    const stored = path.join(harness.project, ".cappy", master.path);
    expect((await hashFile(stored)).sha256).toBe(master.sha256);
    expect(await readdir(harness.obsOutput)).toEqual([]);
    const registry = JSON.parse(await readFile(path.join(harness.project, ".cappy/cappy-workspace.json"), "utf8")) as Record<string, any>;
    expect(registry["managed"][master.path]).toMatchObject({ ownership: "managed", sha256: master.sha256, bytes: 2048 });

    // OBS was only ever inspected and started/stopped.
    expect(requestTypes().every((type) => ALLOWED_OBS_REQUESTS.has(type))).toBe(true);
    expect(requestTypes()).toEqual(expect.arrayContaining(["StartRecord", "StopRecord", "GetRecordStatus"]));
    expect(result["warnings"]).toEqual([]);
  });

  it("applies scenario parameter defaults", async () => {
    await configure(harness);
    const { result } = await runCli(harness, ["run", "boss_intro"]);
    expect(result["data"]["scenario"]["parameters"]).toEqual({ difficulty: 2 });
    expect(result["data"]["preset"]).toBe("default");
  });

  it("requires OBS to be configured", async () => {
    await configure(harness, {}, { obs: undefined });
    const { code, result } = await runCli(harness, ["run", "boss_intro"]);
    expect(code).toBe(3);
    expect(result["error"]["code"]).toBe("OBS_NOT_CONFIGURED");
  });

  it("fails a missing OBS scene before launching the game", async () => {
    const marker = path.join(harness.project, "launched");
    await configure(harness, {}, { game: { command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`] } });
    const config = JSON.parse(await readFile(path.join(harness.project, "cappy.config.json"), "utf8")) as Record<string, any>;
    config["obs"]["scene"] = "Missing";
    await writeFile(path.join(harness.project, "cappy.config.json"), JSON.stringify(config));
    const { result } = await runCli(harness, ["run", "boss_intro"]);
    expect(result["error"]["code"]).toBe("OBS_SCENE_MISSING");
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects an unknown preset, scenario, or invalid parameters without recording", async () => {
    await configure(harness);
    expect((await runCli(harness, ["run", "boss_intro", "--preset", "nope"])).result["error"]["code"]).toBe("PRESET_NOT_FOUND");
    expect((await runCli(harness, ["run", "no_such_scenario"])).result["error"]["code"]).toBe("SCENARIO_NOT_FOUND");
    const invalid = await runCli(harness, ["run", "boss_intro", "--param", "difficulty=7"]);
    expect(invalid.code).toBe(2);
    expect(invalid.result["error"]["code"]).toBe("PARAMETER_INVALID");
    expect(requestTypes()).not.toContain("StartRecord");
    expect(await managedCaptures()).toEqual([]);
  });

  it("fails when OBS never confirms the recording started, and cancels the scenario", async () => {
    await configure(harness, { recording: { neverActivates: true } });
    const { code, result } = await runCli(harness, ["run", "boss_intro"]);
    expect(code).toBe(1);
    expect(result).toMatchObject({ ok: false, error: { code: "OBS_START_FAILED" }, data: { state: "failed", artifacts: [] } });
  });

  it("fails when OBS refuses to stop, and publishes no master", async () => {
    await configure(harness, { failRequests: { StopRecord: { code: 501, comment: "OutputNotRunning" } } });
    const { result } = await runCli(harness, ["run", "boss_intro"]);
    expect(result).toMatchObject({ ok: false, error: { code: "OBS_STOP_FAILED" }, data: { state: "failed", artifacts: [] } });
  });

  it("fails when OBS reports a recording that was never written", async () => {
    await configure(harness, { recording: { noOutputFile: true } });
    const { result } = await runCli(harness, ["run", "boss_intro"]);
    expect(result).toMatchObject({ ok: false, error: { code: "MASTER_MISSING" }, data: { state: "failed" } });
  });

  it("fails when OBS disconnects during the scenario", async () => {
    await configure(harness);
    setTimeout(() => harness.obs.disconnectAll(), 400);
    const { result } = await runCli(harness, ["run", "boss_intro"], { sim: { timeScale: 3 } });
    expect(result).toMatchObject({ ok: false, error: { code: "OBS_UNREACHABLE" }, data: { state: "failed" } });
  });

  it("stops OBS and ends cancelled when the developer cancels", async () => {
    await configure(harness);
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolve) => (cancel = resolve));
    const never = new Promise<void>(() => undefined);
    setTimeout(() => cancel(), 500);
    const { code, result } = await runCli(harness, ["run", "boss_intro"], {
      sim: { timeScale: 5 },
      interrupts: () => ({ stop: never, cancel: cancelled, dispose: () => undefined }),
    });
    expect(code).toBe(130);
    expect(result).toMatchObject({ ok: false, error: { code: "OPERATION_CANCELLED" }, data: { state: "cancelled" } });
    expect(requestTypes()).toContain("StopRecord");
    expect(harness.obs.recording).toBe(false);
  });
});

describe("cappy record --capture", () => {
  it("records a replayable session and a verified OBS master together", async () => {
    await configure(harness);
    const { code, result } = await runCli(harness, ["record", "--capture", "--duration", "0.3"]);
    expect(code).toBe(0);
    const { session, master, replayable } = result["data"];
    expect(replayable).toBe(true);
    expect(master).toMatchObject({ role: "master", path: `sessions/${session.id}/master.mkv`, ownership: "managed", bytes: 2048 });
    expect(session.replay.path).toBe(`sessions/${session.id}/replay.bin`);
    expect((await hashFile(path.join(harness.project, ".cappy", master.path))).sha256).toBe(master.sha256);
  });

  it("does not require OBS without --capture", async () => {
    await configure(harness, {}, { obs: undefined });
    const { code, result } = await runCli(harness, ["record", "--duration", "0.2"]);
    expect(code).toBe(0);
    expect(result["data"]["master"]).toBeUndefined();
  });
});
