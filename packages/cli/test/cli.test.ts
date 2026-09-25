import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeObsServer } from "@cappy/fake-obs";
import { main } from "@cappy/cli";
import { writeFakeTool } from "./support.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const simulatorBin = path.join(repoRoot, "fixtures/adapter-simulator/dist/bin.js");
const cliBin = path.join(repoRoot, "packages/cli/dist/bin.js");

let project: string;
let obs: FakeObsServer | undefined;

beforeEach(async () => {
  project = await realpath(await mkdtemp(path.join(tmpdir(), "cappy-cli-")));
});

afterEach(async () => {
  await obs?.close();
  obs = undefined;
  await rm(project, { recursive: true, force: true });
});

/** A stand-in for ffmpeg/ffprobe that prints a version banner. */
function fakeTool(name: "ffmpeg" | "ffprobe"): Promise<string> {
  return writeFakeTool(project, name);
}

async function writeConfig(overrides: Record<string, unknown> = {}): Promise<void> {
  const config = {
    schemaVersion: 1,
    project: { id: "sim", name: "Simulator Project" },
    game: { command: process.execPath, args: [simulatorBin] },
    adapter: { port: 0 },
    tools: { ffmpeg: await fakeTool("ffmpeg"), ffprobe: await fakeTool("ffprobe") },
    timeouts: { connectMs: 5_000, readyMs: 5_000, obsMs: 1_000 },
    ...overrides,
  };
  await writeFile(path.join(project, "cappy.config.json"), JSON.stringify(config, null, 2));
}

async function cli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await main([...args, "-C", project], {
    cwd: repoRoot,
    env,
    write: (text) => {
      stdout += text;
    },
    writeError: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

function json(stdout: string): Record<string, any> {
  const lines = stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "") as Record<string, any>;
}

function checks(result: Record<string, any>): Record<string, string> {
  return Object.fromEntries((result["data"]["checks"] as { id: string; status: string }[]).map((entry) => [entry.id, entry.status]));
}

describe("CLI shell", () => {
  it("prints help and version", async () => {
    const help = await cli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: cappy <command>");
    expect((await cli(["--version"])).stdout.trim()).toBe("0.1.0");
  });

  it("rejects unknown commands and flags with exit code 2", async () => {
    expect((await cli(["bogus"])).code).toBe(2);
    const flag = await cli(["doctor", "--nope", "--json"]);
    expect(flag.code).toBe(2);
    expect(json(flag.stdout)).toMatchObject({ ok: false, error: { code: "USAGE_INVALID" } });
    expect((await cli([])).code).toBe(2);
  });

  it("accepts whole-token shorthands for global flags", async () => {
    expect((await cli(["-h"])).stdout).toContain("Usage: cappy <command>");
    expect((await cli(["-v"])).stdout.trim()).toBe("0.1.0");
    await writeConfig();
    await writeFile(path.join(project, "alt.json"), await readFile(path.join(project, "cappy.config.json"), "utf8"));
    const long = json((await cli(["doctor", "--json", "--config", "alt.json"])).stdout);
    const short = await cli(["doctor", "-j", "-c", "alt.json"]);
    expect(short.code).toBe(0);
    expect(json(short.stdout)["data"]).toEqual(long["data"]);
  });

  it("rejects an unknown shorthand with exit code 2 in human and JSON mode", async () => {
    const human = await cli(["doctor", "-zz"]);
    expect(human.code).toBe(2);
    expect(human.stderr).toContain('unknown option "-zz"');
    const machine = await cli(["doctor", "-zz", "-j"]);
    expect(machine.code).toBe(2);
    expect(json(machine.stdout)).toMatchObject({ ok: false, error: { code: "USAGE_INVALID" } });
  });

  it("fails with a configuration exit code when config is missing or invalid", async () => {
    const missing = await cli(["doctor", "--json"]);
    expect(missing.code).toBe(3);
    expect(json(missing.stdout)).toMatchObject({ error: { code: "CONFIG_NOT_FOUND" }, data: { checks: [{ id: "config", status: "fail" }] } });

    await writeFile(path.join(project, "cappy.config.json"), JSON.stringify({ schemaVersion: 1, adapter: { port: "x" } }));
    const invalid = await cli(["doctor"]);
    expect(invalid.code).toBe(3);
    expect(invalid.stderr).toContain("error [CONFIG_INVALID]");
    expect(invalid.stderr).toContain("adapter.port");
  });
});

describe("cappy doctor", () => {
  it("emits exactly one parseable JSON document with no ANSI", async () => {
    await writeConfig();
    const result = await cli(["doctor", "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("\u001b");
    const parsed = json(result.stdout);
    expect(parsed).toMatchObject({ schemaVersion: 1, command: "doctor", ok: true });
    expect(checks(parsed)).toEqual({
      config: "pass",
      "workspace.root": "pass",
      workspace: "pass",
      "workspace.gitignore": "pass",
      game: "pass",
      ffmpeg: "pass",
      ffprobe: "pass",
      obs: "skip",
    });
    expect(parsed["data"]["checks"].find((entry: { id: string }) => entry.id === "ffmpeg").details.version).toBe("9.9.9-fake");
  });

  it("reports each failing check and an overall dependency failure", async () => {
    await writeConfig({ tools: { ffmpeg: "./missing-ffmpeg", ffprobe: await fakeTool("ffprobe") }, game: { command: "not-a-real-game-binary" } });
    const result = await cli(["doctor", "--json"]);
    expect(result.code).toBe(4);
    const parsed = json(result.stdout);
    expect(parsed["error"]).toMatchObject({ code: "DOCTOR_CHECKS_FAILED", details: { failed: ["game", "ffmpeg"] } });
    expect(checks(parsed)).toMatchObject({ game: "fail", ffmpeg: "fail", ffprobe: "pass" });
  });

  it("renders a readable human report", async () => {
    await writeConfig();
    const result = await cli(["doctor"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/PASS {2}ffmpeg +ffmpeg 9\.9\.9-fake/);
    expect(result.stdout).toContain("All checks passed.");
  });

  it("verifies OBS reachability, authentication, and configured scenes", async () => {
    obs = await FakeObsServer.start({ password: "s3cret-pass", scenes: ["Gameplay", "Capture"] });
    await writeConfig({ obs: { url: obs.url, passwordEnv: "TEST_OBS_PASSWORD", scene: "Capture" } });
    const result = await cli(["doctor", "--json"], { ...process.env, TEST_OBS_PASSWORD: "s3cret-pass" });
    expect(result.code).toBe(0);
    expect(checks(json(result.stdout))).toMatchObject({ obs: "pass", "obs.scenes": "pass" });
    expect(obs.requests.map((request) => request.requestType)).toEqual(["GetVersion", "GetSceneList"]);
  });

  it("fails a missing OBS scene without mutating OBS", async () => {
    obs = await FakeObsServer.start({ scenes: ["Gameplay"] });
    await writeConfig({ obs: { url: obs.url, scene: "Capture" } });
    const result = await cli(["doctor", "--json"]);
    expect(result.code).toBe(4);
    const parsed = json(result.stdout);
    expect(checks(parsed)).toMatchObject({ obs: "pass", "obs.scenes": "fail" });
    expect(obs.requests.every((request) => request.requestType.startsWith("Get"))).toBe(true);
  });

  it("reports a wrong OBS password without revealing it", async () => {
    obs = await FakeObsServer.start({ password: "right-password" });
    await writeConfig({ obs: { url: obs.url, passwordEnv: "TEST_OBS_PASSWORD" } });
    const result = await cli(["doctor", "--json"], { ...process.env, TEST_OBS_PASSWORD: "wrong-password" });
    expect(result.code).toBe(4);
    expect(result.stdout).toContain("OBS_AUTH_FAILED");
    expect(result.stdout).not.toContain("wrong-password");
    expect(result.stdout).not.toContain("right-password");
  });

  it("fails clearly when the OBS password variable is unset", async () => {
    obs = await FakeObsServer.start({ password: "right-password" });
    await writeConfig({ obs: { url: obs.url, passwordEnv: "TEST_OBS_PASSWORD_UNSET" } });
    const env = { ...process.env };
    delete env["TEST_OBS_PASSWORD_UNSET"];
    const result = await cli(["doctor", "--json"], env);
    expect(json(result.stdout)["data"]["checks"]).toContainEqual(
      expect.objectContaining({ id: "obs", status: "fail", details: expect.objectContaining({ code: "OBS_SECRET_MISSING" }) }),
    );
  });

  it("reports unreachable OBS", async () => {
    await writeConfig({ obs: { url: "ws://127.0.0.1:1" } });
    const result = await cli(["doctor", "--json"]);
    expect(checks(json(result.stdout))).toMatchObject({ obs: "fail" });
  });

  it("refuses an unsafe managed root without creating anything", async () => {
    await writeConfig({ workspace: { root: "." } });
    const result = await cli(["doctor", "--json"]);
    expect(checks(json(result.stdout))).toMatchObject({ "workspace.root": "fail", workspace: "skip" });
    expect(existsSync(path.join(project, "cappy-workspace.json"))).toBe(false);
  });
});

describe("cappy scenarios", () => {
  it("launches the game, negotiates, and lists simulator scenarios as JSON", async () => {
    await writeConfig();
    const result = await cli(["scenarios", "--json"]);
    expect(result.code).toBe(0);
    const parsed = json(result.stdout);
    expect(parsed["data"]["adapter"]).toMatchObject({
      protocolVersion: 1,
      adapter: { name: "cappy-adapter-simulator" },
      capabilities: ["deterministic_replay", "freeform_recording", "replay", "scenarios"],
    });
    expect(parsed["data"]["scenarios"]).toEqual([
      expect.objectContaining({
        id: "boss_intro",
        parameters: { difficulty: expect.objectContaining({ type: "integer", minimum: 1, maximum: 3, default: 2 }) },
        requiredCapabilities: ["scenarios"],
      }),
      expect.objectContaining({ id: "menu_idle" }),
    ]);
  });

  it("renders scenarios for humans", async () => {
    await writeConfig();
    const result = await cli(["scenarios"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("boss_intro  Boss intro");
    expect(result.stdout).toContain("difficulty: integer 1..3 (default 2)");
  });

  it("fails clearly when the game command does not exist", async () => {
    await writeConfig({ game: { command: "not-a-real-game-binary" } });
    const result = await cli(["scenarios", "--json"]);
    expect(result.code).toBe(4);
    expect(json(result.stdout)).toMatchObject({ error: { code: "GAME_LAUNCH_FAILED" } });
  });

  it("reports a game that exits before its adapter connects", async () => {
    await writeConfig({ game: { command: process.execPath, args: ["-e", "process.stderr.write('boom'); process.exit(3)"] } });
    const result = await cli(["scenarios", "--json"]);
    expect(result.code).toBe(1);
    expect(json(result.stdout)).toMatchObject({ error: { code: "GAME_EXITED", details: { exitCode: 3, stderr: "boom" } } });
  });

  it("times out a game that never connects and stops its process", async () => {
    const pidFile = path.join(project, "game.pid");
    await writeConfig({
      game: { command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`] },
      timeouts: { connectMs: 500 },
    });
    const result = await cli(["scenarios", "--json"]);
    expect(result.code).toBe(1);
    expect(json(result.stdout)).toMatchObject({ error: { code: "ADAPTER_CONNECT_TIMEOUT" } });
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("does not launch the game when configuration is invalid", async () => {
    const marker = path.join(project, "launched");
    await writeFile(
      path.join(project, "cappy.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { id: "sim", name: "Sim" },
        game: { command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`] },
        adapter: { port: 0, host: "0.0.0.0" },
      }),
    );
    const result = await cli(["scenarios", "--json"]);
    expect(result.code).toBe(3);
    expect(existsSync(marker)).toBe(false);
  });

  it("stops the game process after listing", async () => {
    const pidFile = path.join(project, "game.pid");
    const script = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); import(${JSON.stringify(pathToFileURL(simulatorBin).href)});`;
    await writeConfig({ game: { command: process.execPath, args: ["-e", script] } });
    const result = await cli(["scenarios", "--json"]);
    expect(result.code).toBe(0);
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("cappy binary", () => {
  it("runs as a real process with stable exit codes and JSON on stdout", async () => {
    await writeConfig();
    const run = spawnSync(process.execPath, [cliBin, "doctor", "--json", "-C", project], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ command: "doctor", ok: true });

    const bad = spawnSync(process.execPath, [cliBin, "scenarios", "--json", "-C", path.join(project, "nope")], { encoding: "utf8" });
    expect(bad.status).toBe(3);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, error: { code: "CONFIG_NOT_FOUND" } });
  });
});

describe.runIf(process.env["CAPPY_REAL_TOOLS"] === "1")("real FFmpeg smoke", () => {
  it("finds FFmpeg and ffprobe on PATH", async () => {
    await writeConfig({ tools: {} });
    const result = await cli(["doctor", "--json"]);
    const parsed = json(result.stdout);
    expect(checks(parsed)).toMatchObject({ ffmpeg: "pass", ffprobe: "pass" });
  });
});
