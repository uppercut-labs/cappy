import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Interrupts, main } from "@cappy/cli";
import { FakeObsServer, type FakeObsOptions } from "@cappy/fake-obs";
import { ALLOWED_OBS_REQUESTS } from "@cappy/obs";
import { hashFile } from "@cappy/workspace";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const simulatorBin = path.join(repoRoot, "fixtures/adapter-simulator/dist/bin.js");

let project: string;
let obsOutput: string;
let obs: FakeObsServer;

beforeEach(async () => {
  project = await realpath(await mkdtemp(path.join(tmpdir(), "cappy-run-")));
  obsOutput = path.join(project, "obs-recordings");
  await mkdir(obsOutput);
});

afterEach(async () => {
  await obs.close();
  await rm(project, { recursive: true, force: true });
});

async function setup(obsOptions: FakeObsOptions = {}, config: Record<string, unknown> = {}): Promise<void> {
  obs = await FakeObsServer.start({ recordDirectory: obsOutput, scenes: ["Gameplay", "Capture"], masterBytes: Buffer.from("m".repeat(2048)), ...obsOptions });
  await writeFile(
    path.join(project, "cappy.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      project: { id: "sim", name: "Simulator Project" },
      game: { command: process.execPath, args: [simulatorBin] },
      adapter: { port: 0 },
      obs: { url: obs.url, scene: "Capture" },
      presets: { trailer: { scene: "Capture" } },
      timeouts: { connectMs: 5_000, readyMs: 5_000, obsMs: 1_000 },
      ...config,
    }),
  );
}

async function cli(args: string[], options: { sim?: Record<string, unknown>; interrupts?: () => Interrupts } = {}) {
  let stdout = "";
  const code = await main([...args, "--json", "-C", project], {
    cwd: repoRoot,
    env: { ...process.env, CAPPY_SIM_OPTIONS: JSON.stringify(options.sim ?? {}) },
    write: (text) => {
      stdout += text;
    },
    writeError: () => undefined,
    ...(options.interrupts === undefined ? {} : { listenForInterrupts: options.interrupts }),
  });
  return { code, result: JSON.parse(stdout) as Record<string, any> };
}

function requestTypes(): string[] {
  return obs.requests.map((request) => request.requestType);
}

async function managedCaptures(): Promise<string[]> {
  const dir = path.join(project, ".cappy/captures");
  return existsSync(dir) ? readdir(dir) : [];
}

describe("cappy run", () => {
  it("drives a full fake-OBS capture of a simulator scenario", async () => {
    await setup();
    const { code, result } = await cli(["run", "boss_intro", "--param", "difficulty=3", "--preset", "trailer"]);
    expect(code).toBe(0);
    const data = result["data"];
    expect(data).toMatchObject({
      state: "processing",
      scenario: { id: "boss_intro", parameters: { difficulty: 3 } },
      preset: "trailer",
      obs: { version: "31.0.0", scene: "Capture" },
      master: { role: "master", ownership: "managed", mediaType: "video/x-matroska", bytes: 2048, source: { tool: "obs", version: "31.0.0" } },
    });
    expect(data.master.path).toBe(`captures/${data.captureId}/master.mkv`);
    expect(data.events.map((event: { type: string }) => event.type)).toEqual(["BOSS_APPEAR", "SPELL_CAST", "IMPACT"]);

    // The verified master was moved into the managed workspace and registered with its hash.
    const stored = path.join(project, ".cappy", data.master.path);
    expect((await hashFile(stored)).sha256).toBe(data.master.sha256);
    expect(await readdir(obsOutput)).toEqual([]);
    const registry = JSON.parse(await readFile(path.join(project, ".cappy/cappy-workspace.json"), "utf8")) as Record<string, any>;
    expect(registry["managed"][data.master.path]).toMatchObject({ ownership: "managed", sha256: data.master.sha256, bytes: 2048 });

    // OBS was only ever inspected and started/stopped.
    expect(requestTypes().every((type) => ALLOWED_OBS_REQUESTS.has(type))).toBe(true);
    expect(requestTypes()).toEqual(expect.arrayContaining(["StartRecord", "StopRecord", "GetRecordStatus"]));
    expect(result["warnings"]).toEqual([expect.stringContaining("manifest")]);
  });

  it("applies scenario parameter defaults", async () => {
    await setup();
    const { result } = await cli(["run", "boss_intro"]);
    expect(result["data"]["scenario"]["parameters"]).toEqual({ difficulty: 2 });
    expect(result["data"]["preset"]).toBe("default");
  });

  it("requires OBS to be configured and fails before launching the game", async () => {
    await setup({}, { obs: undefined });
    const { code, result } = await cli(["run", "boss_intro"]);
    expect(code).toBe(3);
    expect(result["error"]["code"]).toBe("OBS_NOT_CONFIGURED");
  });

  it("fails a missing OBS scene before launching the game", async () => {
    const marker = path.join(project, "launched");
    await setup({}, {
      obs: { url: "placeholder", scene: "Missing" },
      game: { command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`] },
    });
    // Patch in the real fake-OBS URL.
    const config = JSON.parse(await readFile(path.join(project, "cappy.config.json"), "utf8")) as Record<string, any>;
    config["obs"]["url"] = obs.url;
    await writeFile(path.join(project, "cappy.config.json"), JSON.stringify(config));
    const { result } = await cli(["run", "boss_intro"]);
    expect(result["error"]["code"]).toBe("OBS_SCENE_MISSING");
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects an unknown preset, scenario, or invalid parameters without recording", async () => {
    await setup();
    expect((await cli(["run", "boss_intro", "--preset", "nope"])).result["error"]["code"]).toBe("PRESET_NOT_FOUND");
    expect((await cli(["run", "no_such_scenario"])).result["error"]["code"]).toBe("SCENARIO_NOT_FOUND");
    const invalid = await cli(["run", "boss_intro", "--param", "difficulty=7"]);
    expect(invalid.code).toBe(2);
    expect(invalid.result["error"]["code"]).toBe("PARAMETER_INVALID");
    expect(requestTypes()).not.toContain("StartRecord");
    expect(await managedCaptures()).toEqual([]);
  });

  it("fails when OBS never confirms the recording started, and cancels the scenario", async () => {
    await setup({ recording: { neverActivates: true } });
    const { code, result } = await cli(["run", "boss_intro"]);
    expect(code).toBe(1);
    expect(result).toMatchObject({ ok: false, error: { code: "OBS_START_FAILED" }, data: { state: "failed" } });
    expect(result["data"]["master"]).toBeUndefined();
  });

  it("fails when OBS refuses to stop, and publishes no master", async () => {
    await setup({ failRequests: { StopRecord: { code: 501, comment: "OutputNotRunning" } } });
    const { result } = await cli(["run", "boss_intro"]);
    expect(result).toMatchObject({ ok: false, error: { code: "OBS_STOP_FAILED" }, data: { state: "failed" } });
    expect(await managedCaptures()).toEqual([]);
  });

  it("fails when OBS reports a recording that was never written", async () => {
    await setup({ recording: { noOutputFile: true } });
    const { result } = await cli(["run", "boss_intro"]);
    expect(result).toMatchObject({ ok: false, error: { code: "MASTER_MISSING" }, data: { state: "failed" } });
  });

  it("fails when OBS disconnects during the scenario", async () => {
    await setup();
    setTimeout(() => obs.disconnectAll(), 400);
    const { result } = await cli(["run", "boss_intro"], { sim: { timeScale: 3 } });
    expect(result).toMatchObject({ ok: false, error: { code: "OBS_UNREACHABLE" }, data: { state: "failed" } });
  });

  it("stops OBS and ends cancelled when the developer cancels", async () => {
    await setup();
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolve) => (cancel = resolve));
    const never = new Promise<void>(() => undefined);
    setTimeout(() => cancel(), 500);
    const { code, result } = await cli(["run", "boss_intro"], {
      sim: { timeScale: 5 },
      interrupts: () => ({ stop: never, cancel: cancelled, dispose: () => undefined }),
    });
    expect(code).toBe(130);
    expect(result).toMatchObject({ ok: false, error: { code: "OPERATION_CANCELLED" }, data: { state: "cancelled" } });
    expect(requestTypes()).toContain("StopRecord");
    expect(obs.recording).toBe(false);
  });
});

describe("cappy record --capture", () => {
  it("records a replayable session and a verified OBS master together", async () => {
    await setup();
    const { code, result } = await cli(["record", "--capture", "--duration", "0.3"]);
    expect(code).toBe(0);
    const { session, master, replayable } = result["data"];
    expect(replayable).toBe(true);
    expect(master).toMatchObject({ role: "master", path: `sessions/${session.id}/master.mkv`, ownership: "managed", bytes: 2048 });
    expect(session.replay.path).toBe(`sessions/${session.id}/replay.bin`);
    expect((await hashFile(path.join(project, ".cappy", master.path))).sha256).toBe(master.sha256);
  });

  it("does not require OBS without --capture", async () => {
    await setup({}, { obs: undefined });
    const { code, result } = await cli(["record", "--duration", "0.2"]);
    expect(code).toBe(0);
    expect(result["data"]["master"]).toBeUndefined();
  });
});
