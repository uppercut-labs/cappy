import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Interrupts, main } from "@cappy/cli";
import { sessionSchema } from "@cappy/core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const simulatorBin = path.join(repoRoot, "fixtures/adapter-simulator/dist/bin.js");
const cliBin = path.join(repoRoot, "packages/cli/dist/bin.js");

let project: string;

beforeEach(async () => {
  project = await realpath(await mkdtemp(path.join(tmpdir(), "cappy-sessions-")));
  await writeFile(
    path.join(project, "cappy.config.json"),
    JSON.stringify({
      schemaVersion: 1,
      project: { id: "sim", name: "Simulator Project" },
      game: { command: process.execPath, args: [simulatorBin] },
      adapter: { port: 0 },
      timeouts: { connectMs: 5_000, readyMs: 5_000 },
    }),
  );
});

afterEach(async () => {
  await rm(project, { recursive: true, force: true });
});

interface Controls {
  stop(): void;
  cancel(): void;
}

function controllable(): { controls: Controls; listen: () => Interrupts } {
  let stop!: () => void;
  let cancel!: () => void;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const cancelled = new Promise<void>((resolve) => (cancel = resolve));
  return {
    controls: { stop: () => stop(), cancel: () => cancel() },
    listen: () => ({ stop: stopped, cancel: cancelled, dispose: () => undefined }),
  };
}

async function cli(
  args: string[],
  options: { sim?: Record<string, unknown>; interrupts?: () => Interrupts } = {},
): Promise<{ code: number; result: Record<string, any>; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await main([...args, "--json", "-C", project], {
    cwd: repoRoot,
    env: { ...process.env, CAPPY_SIM_OPTIONS: JSON.stringify(options.sim ?? {}) },
    write: (text) => {
      stdout += text;
    },
    writeError: (text) => {
      stderr += text;
    },
    ...(options.interrupts === undefined ? {} : { listenForInterrupts: options.interrupts }),
  });
  return { code, result: JSON.parse(stdout) as Record<string, any>, stderr };
}

async function sessionFile(id: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(project, ".cappy/sessions", id, "session.json"), "utf8")) as Record<string, any>;
}

async function recordSession(sim: Record<string, unknown> = {}): Promise<string> {
  const recorded = await cli(["record", "--duration", "0.2"], { sim });
  expect(recorded.code).toBe(0);
  return recorded.result["data"]["session"]["id"] as string;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("cappy record", () => {
  it("stores a completed, replayable freeform session", async () => {
    const recorded = await cli(["record", "--duration", "0.2"]);
    expect(recorded.code).toBe(0);
    const { session, replayable, events } = recorded.result["data"];
    expect(replayable).toBe(true);
    expect(events).toBe(3);
    expect(session).toMatchObject({
      origin: "freeform",
      status: "completed",
      projectId: "sim",
      adapter: { name: "cappy-adapter-simulator" },
      replay: { path: `sessions/${session.id}/replay.bin`, format: "cappy-sim-replay-v1", requiredCapabilities: ["deterministic_replay", "replay"] },
    });

    const stored = await sessionFile(session.id);
    expect(sessionSchema.safeParse(stored).success).toBe(true);
    expect(stored["endedAt"]).toEqual(expect.any(String));
    const payload = await readFile(path.join(project, ".cappy", session.replay.path));
    expect(sha256(payload)).toBe(session.replay.sha256);
    expect(payload.byteLength).toBe(session.replay.bytes);
    const timeline = JSON.parse(await readFile(path.join(project, ".cappy/sessions", session.id, "timeline.json"), "utf8")) as { type: string }[];
    expect(timeline.map((event) => event.type)).toEqual(["PLAYER_SPAWN", "JUMP", "COIN"]);
  });

  it("stops when the developer asks and keeps the recording", async () => {
    const { controls, listen } = controllable();
    setTimeout(() => controls.stop(), 300);
    const recorded = await cli(["record"], { interrupts: listen });
    expect(recorded.code).toBe(0);
    expect(recorded.result["data"]).toMatchObject({ replayable: true, session: { status: "completed" } });
  });

  it("records cancellation as cancelled metadata, never success", async () => {
    const { controls, listen } = controllable();
    setTimeout(() => controls.cancel(), 300);
    const recorded = await cli(["record"], { interrupts: listen });
    expect(recorded.code).toBe(130);
    expect(recorded.result).toMatchObject({ ok: false, error: { code: "OPERATION_CANCELLED" }, data: { session: { status: "cancelled" } } });
    const id = recorded.result["data"]["session"]["id"] as string;
    const stored = await sessionFile(id);
    expect(stored["status"]).toBe("cancelled");
    expect(stored["replay"]).toBeUndefined();
    expect(existsSync(path.join(project, ".cappy/sessions", id, "replay.bin"))).toBe(false);

    const replayed = await cli(["replay", id, "--no-capture"]);
    expect(replayed.result["error"]["code"]).toBe("SESSION_NOT_REPLAYABLE");
  });

  it("fails when an adapter that advertises replay returns no payload", async () => {
    const recorded = await cli(["record", "--duration", "0.2"], { sim: { omitReplay: true } });
    expect(recorded.code).toBe(1);
    expect(recorded.result).toMatchObject({ error: { code: "REPLAY_PAYLOAD_MISSING" }, data: { session: { status: "failed" } } });
  });

  it("completes a non-replayable session with a warning when the adapter lacks replay", async () => {
    const recorded = await cli(["record", "--duration", "0.2"], { sim: { capabilities: ["freeform_recording"], omitReplay: true } });
    expect(recorded.code).toBe(0);
    expect(recorded.result["data"]).toMatchObject({ replayable: false, session: { status: "completed" } });
    expect(recorded.result["warnings"]).toEqual([expect.stringContaining("cannot be replayed")]);
  });

  it("refuses to record when the adapter lacks freeform recording", async () => {
    const recorded = await cli(["record", "--duration", "0.2"], { sim: { capabilities: ["scenarios"] } });
    expect(recorded.result).toMatchObject({ ok: false, error: { code: "CAPABILITY_MISSING" } });
    expect(existsSync(path.join(project, ".cappy/sessions")) ? await readdir(path.join(project, ".cappy/sessions")) : []).toEqual([]);
  });

  it("rejects an invalid duration", async () => {
    expect((await cli(["record", "--duration", "soon"])).code).toBe(2);
  });
});

describe("opaque replay payloads", () => {
  const opaque = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x80]), randomBytes(2048)]);

  it("stores and returns arbitrary bytes unchanged through inline handoff", async () => {
    const received = path.join(project, "received");
    await mkdir(received);
    const id = await recordSession({ replayPayloadBase64: opaque.toString("base64") });
    const stored = await readFile(path.join(project, ".cappy/sessions", id, "replay.bin"));
    expect(Buffer.compare(stored, opaque)).toBe(0);

    const replayed = await cli(["replay", id, "--no-capture"], { sim: { replayPayloadBase64: opaque.toString("base64"), receivedReplayDir: received } });
    expect(replayed.code).toBe(0);
    await expect.poll(async () => (await readdir(received)).length).toBe(1);
    expect(Buffer.compare(await readFile(path.join(received, "received-0.bin")), opaque)).toBe(0);
  });

  it("copies file handoffs without moving or deleting the adapter's file", async () => {
    const adapterDir = path.join(project, "adapter-output");
    await mkdir(adapterDir);
    const id = await recordSession({ replayPayloadBase64: opaque.toString("base64"), replayHandoff: "file", replayDir: adapterDir });
    const [source] = await readdir(adapterDir);
    expect(source).toBeDefined();
    expect(Buffer.compare(await readFile(path.join(adapterDir, source ?? "")), opaque)).toBe(0);
    expect(Buffer.compare(await readFile(path.join(project, ".cappy/sessions", id, "replay.bin")), opaque)).toBe(0);
  });

  it("returns the stored payload so the adapter reproduces the same timeline", async () => {
    const id = await recordSession();
    const replayed = await cli(["replay", id, "--no-capture"]);
    expect(replayed.code).toBe(0);
    expect(replayed.result["data"]).toMatchObject({ sessionId: id, captured: false });
    expect(replayed.result["data"]["events"].map((event: { type: string; t: number }) => [event.type, event.t])).toEqual([
      ["PLAYER_SPAWN", 0],
      ["JUMP", 250],
      ["COIN", 400],
    ]);
  });
});

describe("replay compatibility", () => {
  it("fails a capability mismatch before the payload reaches the adapter", async () => {
    const received = path.join(project, "received");
    await mkdir(received);
    const id = await recordSession();
    const replayed = await cli(["replay", id, "--no-capture"], {
      sim: { capabilities: ["freeform_recording", "replay"], receivedReplayDir: received },
    });
    expect(replayed.code).toBe(1);
    expect(replayed.result).toMatchObject({ error: { code: "CAPABILITY_MISSING", details: { missing: ["deterministic_replay"] } } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readdir(received)).toEqual([]);
  });

  it("refuses a replay recorded by a different adapter", async () => {
    const id = await recordSession();
    const replayed = await cli(["replay", id, "--no-capture"], { sim: { adapter: { name: "another-adapter", version: "1.0.0" } } });
    expect(replayed.result).toMatchObject({ error: { code: "REPLAY_INCOMPATIBLE" } });
  });

  it("warns when the game build differs from the recording", async () => {
    const id = await recordSession({ build: "build-1" });
    const replayed = await cli(["replay", id, "--no-capture"], { sim: { build: "build-2" } });
    expect(replayed.code).toBe(0);
    expect(replayed.result["warnings"]).toEqual([expect.stringContaining("build-1")]);
  });

  it("refuses a tampered payload before launching the game", async () => {
    const id = await recordSession();
    await writeFile(path.join(project, ".cappy/sessions", id, "replay.bin"), "tampered");
    const marker = path.join(project, "launched");
    await writeFile(
      path.join(project, "cappy.config.json"),
      JSON.stringify({
        schemaVersion: 1,
        project: { id: "sim", name: "Simulator Project" },
        game: { command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`] },
        adapter: { port: 0 },
      }),
    );
    const replayed = await cli(["replay", id, "--no-capture"]);
    expect(replayed.result).toMatchObject({ error: { code: "REPLAY_PAYLOAD_INVALID" } });
    expect(existsSync(marker)).toBe(false);
  });

  it("reports unknown or malformed session IDs as usage errors", async () => {
    for (const id of ["ses_00000000-0000-0000-0000-000000000000", "../../etc/passwd"]) {
      const replayed = await cli(["replay", id, "--no-capture"]);
      expect(replayed.code).toBe(2);
      expect(replayed.result["error"]["code"]).toBe("SESSION_NOT_FOUND");
    }
  });

  it("requires --no-capture until captured replay exists", async () => {
    const replayed = await cli(["replay", "ses_00000000-0000-0000-0000-000000000000"]);
    expect(replayed).toMatchObject({ code: 2, result: { error: { code: "USAGE_INVALID" } } });
  });
});

describe("interactive binary", () => {
  it.skipIf(process.platform === "win32")("cancels on Ctrl+C with exit code 130 and cancelled metadata", async () => {
    const child = spawn(process.execPath, [cliBin, "record", "--json", "-C", project], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    await expect.poll(() => existsSync(path.join(project, ".cappy/sessions")) && readdir(path.join(project, ".cappy/sessions")).then((entries) => entries.length), {
      timeout: 5_000,
    }).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.kill("SIGINT");
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(130);
    const result = JSON.parse(stdout) as Record<string, any>;
    expect(result).toMatchObject({ ok: false, error: { code: "OPERATION_CANCELLED" }, data: { session: { status: "cancelled" } } });
  });

  it.skipIf(process.platform === "win32")("stops when Enter is pressed", async () => {
    const child = spawn(process.execPath, [cliBin, "record", "--json", "-C", project], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    await expect.poll(() => existsSync(path.join(project, ".cappy/sessions")) && readdir(path.join(project, ".cappy/sessions")).then((entries) => entries.length), {
      timeout: 5_000,
    }).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    child.stdin.write("\n");
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, data: { replayable: true, session: { status: "completed" } } });
  });
});
