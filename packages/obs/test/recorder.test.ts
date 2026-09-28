import { mkdtemp, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeObsServer, type FakeObsOptions } from "@uppercut-labs/cappy-fixture-fake-obs";
import { ALLOWED_OBS_REQUESTS, ObsRecorder, verifyMaster } from "@uppercut-labs/cappy-internal-obs";

let dir: string;
let obs: FakeObsServer | undefined;
const recorders: ObsRecorder[] = [];

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "cappy-obs-")));
});

afterEach(async () => {
  recorders.splice(0).forEach((recorder) => recorder.close());
  await obs?.close();
  obs = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function connect(options: FakeObsOptions = {}, config: { passwordEnv?: string } = {}, env: NodeJS.ProcessEnv = {}) {
  obs = await FakeObsServer.start({ recordDirectory: dir, scenes: ["Gameplay", "Capture"], ...options });
  const result = await ObsRecorder.connect({ url: obs.url, switchScene: false, ...config }, { env, timeoutMs: 1_000 });
  if (result.ok) {
    recorders.push(result.value);
  }
  return result;
}

async function recorder(options: FakeObsOptions = {}): Promise<ObsRecorder> {
  const result = await connect(options);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("connection and authentication", () => {
  it("authenticates with the password from the configured environment variable", async () => {
    const result = await connect({ password: "pw-123" }, { passwordEnv: "OBS_PW" }, { OBS_PW: "pw-123" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.obsVersion).toBe("31.0.0");
  });

  it("fails authentication cleanly and never echoes the password", async () => {
    const wrong = await connect({ password: "pw-123" }, { passwordEnv: "OBS_PW" }, { OBS_PW: "not-it" });
    expect(!wrong.ok && wrong.error.code).toBe("OBS_AUTH_FAILED");
    expect(JSON.stringify(wrong)).not.toContain("not-it");
    await obs?.close();
    const missing = await connect({ password: "pw-123" });
    expect(!missing.ok && missing.error.code).toBe("OBS_AUTH_FAILED");
  });

  it("reports an unreachable OBS", async () => {
    const result = await ObsRecorder.connect({ url: "ws://127.0.0.1:1", switchScene: false }, { env: {}, timeoutMs: 300 });
    expect(!result.ok && result.error.code).toBe("OBS_UNREACHABLE");
  });
});

describe("preparation", () => {
  it("fails when the configured scene does not exist", async () => {
    const rec = await recorder();
    const result = await rec.prepare("Missing", { switchScene: false, timeoutMs: 500 });
    expect(!result.ok && result.error).toMatchObject({ code: "OBS_SCENE_MISSING", details: { available: ["Gameplay", "Capture"] } });
  });

  it("refuses to take over a recording it did not start", async () => {
    const rec = await recorder();
    if (obs !== undefined) obs.recording = true;
    const result = await rec.prepare("Capture", { switchScene: false, timeoutMs: 500 });
    expect(!result.ok && result.error.code).toBe("OBS_ALREADY_RECORDING");
  });

  it("switches scenes only when explicitly enabled", async () => {
    const rec = await recorder();
    await rec.prepare("Capture", { switchScene: false, timeoutMs: 500 });
    expect(obs?.currentScene).toBe("Gameplay");
    await rec.prepare("Capture", { switchScene: true, timeoutMs: 500 });
    expect(obs?.currentScene).toBe("Capture");
  });
});

describe("recording", () => {
  it("confirms start and stop through OBS state and returns a verified master", async () => {
    const rec = await recorder({ masterBytes: Buffer.from("x".repeat(4096)) });
    const started = await rec.start(1_000);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(rec.recording).toBe(true);
    const stopped = await rec.stop(1_000);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(rec.recording).toBe(false);
    const master = await verifyMaster(stopped.value, started.value.requestedAt, { settleMs: 20 });
    expect(master).toEqual({ ok: true, value: { path: stopped.value, bytes: 4096 } });
  });

  it("does not treat an accepted StartRecord as success until OBS reports the output active", async () => {
    const rec = await recorder({ recording: { neverActivates: true } });
    const started = await rec.start(300);
    expect(!started.ok && started.error.code).toBe("OBS_START_FAILED");
  });

  it("does not treat an accepted StopRecord as success until OBS reports the output inactive", async () => {
    const rec = await recorder({ recording: { neverStops: true } });
    await rec.start(500);
    const stopped = await rec.stop(300);
    expect(!stopped.ok && stopped.error.code).toBe("OBS_STOP_FAILED");
  });

  it("reports OBS refusing to start or stop", async () => {
    const refusesStart = await recorder({ failRequests: { StartRecord: { code: 500, comment: "OutputRunning" } } });
    expect(await refusesStart.start(300)).toMatchObject({ ok: false, error: { code: "OBS_START_FAILED" } });
    await obs?.close();
    const refusesStop = await recorder({ failRequests: { StopRecord: { code: 501, comment: "OutputNotRunning" } } });
    await refusesStop.start(300);
    expect(await refusesStop.stop(300)).toMatchObject({ ok: false, error: { code: "OBS_STOP_FAILED" } });
  });

  it("times out when OBS never answers", async () => {
    const rec = await recorder({ failRequests: { StartRecord: "hang" } });
    const started = await rec.start(200);
    expect(!started.ok && started.error.code).toBe("OBS_START_FAILED");
  });

  it("fails when OBS disconnects mid-recording", async () => {
    const rec = await recorder({ recording: { disconnectOn: "StopRecord" } });
    await rec.start(500);
    const stopped = await rec.stop(500);
    expect(stopped.ok).toBe(false);
    expect((await rec.disconnected).code).toBe("OBS_UNREACHABLE");
  });

  it("never sends requests outside the allowlist", async () => {
    const rec = await recorder();
    await rec.prepare("Capture", { switchScene: true, timeoutMs: 500 });
    await rec.start(500);
    await rec.stop(500);
    const sent = new Set(obs?.requests.map((request) => request.requestType));
    expect([...sent].every((type) => ALLOWED_OBS_REQUESTS.has(type))).toBe(true);
    expect([...ALLOWED_OBS_REQUESTS].some((type) => /Create|Remove|Delete|Set(?!CurrentProgramScene)/.test(type))).toBe(false);
  });
});

describe("master verification", () => {
  const since = new Date(Date.now() - 1_000);

  it("rejects a missing, empty, relative, or stale master", async () => {
    expect(await verifyMaster(path.join(dir, "absent.mkv"), since)).toMatchObject({ ok: false, error: { code: "MASTER_MISSING" } });
    const empty = path.join(dir, "empty.mkv");
    await writeFile(empty, "");
    expect(await verifyMaster(empty, since)).toMatchObject({ ok: false, error: { code: "MASTER_INVALID" } });
    expect(await verifyMaster("relative.mkv", since)).toMatchObject({ ok: false, error: { code: "MASTER_INVALID" } });
    const stale = path.join(dir, "stale.mkv");
    await writeFile(stale, "old recording");
    const old = new Date(Date.now() - 60_000);
    await utimes(stale, old, old);
    expect(await verifyMaster(stale, since)).toMatchObject({ ok: false, error: { code: "MASTER_INVALID" } });
  });

  it("reports a stop that produced no file", async () => {
    const rec = await recorder({ recording: { noOutputFile: true } });
    const started = await rec.start(500);
    const stopped = await rec.stop(500);
    if (!started.ok || !stopped.ok) throw new Error("recording failed");
    expect(await verifyMaster(stopped.value, started.value.requestedAt)).toMatchObject({ ok: false, error: { code: "MASTER_MISSING" } });
    expect(await readdir(dir)).toEqual([]);
  });
});
