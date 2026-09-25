import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manifestSchema, sessionSchema } from "@cappy/core";
import { hashFile } from "@cappy/workspace";
import { type Harness, configure, createHarness, disposeHarness, runCli } from "../../packages/cli/test/support.js";

/*
 * End-to-end capture harness: the simulator runs as a real game process,
 * the fake OBS speaks the real WebSocket protocol, and fake FFmpeg/ffprobe
 * stand in for media tools. Covers scenario and replay capture through the
 * same pipeline.
 */
const posixIt = process.platform === "win32" ? it.skip : it;
let harness: Harness;

beforeEach(async () => {
  harness = await createHarness("cappy-e2e-");
  await configure(harness, {}, {
    presets: { trailer: { scene: "Capture", derivatives: [{ kind: "mp4", role: "delivery" }] } },
    defaultPreset: "trailer",
  });
});

afterEach(async () => {
  await disposeHarness(harness);
});

async function readJson(relative: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(harness.project, ".cappy", relative), "utf8")) as Record<string, any>;
}

function startRecordCount(): number {
  return harness.obs.requests.filter((request) => request.requestType === "StartRecord").length;
}

describe("replay capture", () => {
  posixIt("captures a stored freeform session through the same pipeline as scenarios", async () => {
    const recorded = await runCli(harness, ["record", "--duration", "0.2"]);
    expect(recorded.code).toBe(0);
    const sessionId = recorded.result["data"]["session"]["id"] as string;

    const { code, result } = await runCli(harness, ["replay", sessionId]);
    expect(code).toBe(0);
    const data = result["data"];
    expect(data).toMatchObject({ captured: true, state: "succeeded", take: 1, sessionId, source: { kind: "replay", sessionId } });
    expect(data.artifacts.map((artifact: { role: string }) => artifact.role)).toEqual(["master", "delivery"]);

    const manifest = await readJson(data.manifest);
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest).toMatchObject({ status: "succeeded", identity: { sessionId, take: 1, source: { kind: "replay", sessionId } } });
    expect(manifest["timing"]["timeline"].map((event: { type: string }) => event.type)).toEqual([
      "RECORDING_STARTED",
      "REPLAY_STARTED",
      "PLAYER_SPAWN",
      "JUMP",
      "COIN",
      "REPLAY_COMPLETED",
      "RECORDING_STOPPED",
    ]);

    const again = await runCli(harness, ["replay", sessionId]);
    expect(again.result["data"]["take"]).toBe(2);
  });

  posixIt("checks replay compatibility before recording", async () => {
    const recorded = await runCli(harness, ["record", "--duration", "0.2"]);
    const sessionId = recorded.result["data"]["session"]["id"] as string;
    const { result } = await runCli(harness, ["replay", sessionId], { sim: { capabilities: ["freeform_recording", "replay"] } });
    expect(result).toMatchObject({ ok: false, error: { code: "CAPABILITY_MISSING" }, data: { state: "failed", captured: true } });
    expect(startRecordCount()).toBe(0);
  });

  posixIt("keeps a failed replay capture clearly non-successful", async () => {
    await harness.obs.close();
    await configure(harness, { recording: { neverActivates: true } }, {
      presets: { trailer: { scene: "Capture", derivatives: [{ kind: "mp4", role: "delivery" }] } },
      defaultPreset: "trailer",
    });
    const recorded = await runCli(harness, ["record", "--duration", "0.2"]);
    const sessionId = recorded.result["data"]["session"]["id"] as string;
    const { code, result } = await runCli(harness, ["replay", sessionId]);
    expect(code).toBe(1);
    expect(result).toMatchObject({ ok: false, error: { code: "OBS_START_FAILED" }, data: { state: "failed" } });
    expect((await readJson(result["data"]["manifest"]))["status"]).toBe("failed");
  });
});

describe("takes", () => {
  posixIt("never overwrites an existing successful take", async () => {
    const first = await runCli(harness, ["run", "boss_intro", "--take", "1"]);
    expect(first.code).toBe(0);
    const master = first.result["data"]["artifacts"][0];
    const before = await hashFile(path.join(harness.project, ".cappy", master.path));

    const second = await runCli(harness, ["run", "boss_intro", "--take", "1"]);
    expect(second.code).toBe(2);
    expect(second.result).toMatchObject({ ok: false, error: { code: "TAKE_EXISTS" } });
    expect(startRecordCount()).toBe(1);
    expect(await hashFile(path.join(harness.project, ".cappy", master.path))).toEqual(before);

    const explicit = await runCli(harness, ["run", "boss_intro", "--take", "5"]);
    expect(explicit.result["data"]["take"]).toBe(5);
    const next = await runCli(harness, ["run", "boss_intro"]);
    expect(next.result["data"]["take"]).toBe(6);
  });

  posixIt("does not let failed jobs consume take numbers", async () => {
    await harness.obs.close();
    await configure(harness, { failRequests: { StopRecord: { code: 501, comment: "OutputNotRunning" } } });
    const failed = await runCli(harness, ["run", "boss_intro"]);
    expect(failed.result).toMatchObject({ ok: false, data: { state: "failed", take: 1 } });
    await harness.obs.close();
    await configure(harness);
    const succeeded = await runCli(harness, ["run", "boss_intro"]);
    expect(succeeded.result["data"]).toMatchObject({ state: "succeeded", take: 1 });
  });

  posixIt("rejects an invalid take", async () => {
    expect((await runCli(harness, ["run", "boss_intro", "--take", "0"])).code).toBe(2);
  });
});

describe("cancellation and crash reconciliation", () => {
  posixIt("leaves a cancelled capture, its session, and its manifest non-successful", async () => {
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolve) => (cancel = resolve));
    const never = new Promise<void>(() => undefined);
    setTimeout(() => cancel(), 400);
    const { code, result } = await runCli(harness, ["run", "boss_intro"], {
      sim: { timeScale: 5 },
      interrupts: () => ({ stop: never, cancel: cancelled, dispose: () => undefined }),
    });
    expect(code).toBe(130);
    const manifest = await readJson(result["data"]["manifest"]);
    expect(manifest).toMatchObject({ status: "cancelled", result: { error: { code: "OPERATION_CANCELLED" } } });
    const session = await readJson(`sessions/${manifest["identity"]["sessionId"]}/session.json`);
    expect(session["status"]).toBe("cancelled");
  });

  posixIt("marks sessions orphaned by a crashed command as failed, never succeeded", async () => {
    // A command that crashed: its session is still active and its lock names a dead process.
    const recorded = await runCli(harness, ["record", "--duration", "0.2"]);
    const crashedId = recorded.result["data"]["session"]["id"] as string;
    const sessionPath = `sessions/${crashedId}/session.json`;
    const crashed = { ...(await readJson(sessionPath)), status: "active", correlationId: "op_crashed" } as Record<string, any>;
    delete crashed["endedAt"];
    delete crashed["replay"];
    expect(sessionSchema.safeParse(crashed).success).toBe(true);
    await writeFile(path.join(harness.project, ".cappy", sessionPath), JSON.stringify(crashed));
    // Keep the registry hash in step so the edit looks like Cappy wrote it.
    const registryPath = path.join(harness.project, ".cappy/cappy-workspace.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as Record<string, any>;
    const digest = await hashFile(path.join(harness.project, ".cappy", sessionPath));
    registry["managed"][sessionPath] = { ...registry["managed"][sessionPath], sha256: digest.sha256, bytes: digest.bytes };
    await writeFile(registryPath, JSON.stringify(registry));
    await mkdir(path.join(harness.project, ".cappy/cache/running"), { recursive: true });
    await writeFile(
      path.join(harness.project, ".cappy/cache/running/op_crashed.json"),
      JSON.stringify({ correlationId: "op_crashed", pid: 2 ** 22 + 12345, host: (await import("node:os")).hostname(), startedAt: new Date().toISOString() }),
    );

    const { code, result } = await runCli(harness, ["run", "boss_intro"]);
    expect(code).toBe(0);
    expect(result["warnings"]).toEqual([expect.stringContaining(crashedId)]);
    expect((await readJson(sessionPath))["status"]).toBe("failed");
  });
});

describe("correlation and timeline synchronization", () => {
  posixIt("links the log, session, capture, manifest, and timeline by one correlation ID", async () => {
    const { result } = await runCli(harness, ["run", "boss_intro"], { sim: { timeScale: 1 } });
    const correlationId = result["correlationId"] as string;
    const data = result["data"];
    const manifest = await readJson(data.manifest);
    const session = await readJson(`sessions/${data.sessionId}/session.json`);
    expect(manifest["identity"]["correlationId"]).toBe(correlationId);
    expect(session["correlationId"]).toBe(correlationId);
    expect(manifest["timing"]["timeline"].every((event: { correlationId: string }) => event.correlationId === correlationId)).toBe(true);

    expect(data.log).toBe(`logs/${correlationId}.jsonl`);
    const lines = (await readFile(path.join(harness.project, ".cappy", data.log), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.every((line: { correlationId: string }) => line.correlationId === correlationId)).toBe(true);
    expect(lines.map((line: { event: string }) => line.event)).toEqual(
      expect.arrayContaining(["command.started", "game.connected", "take.allocated", "recording.started", "master.published", "job.succeeded"]),
    );
    expect(JSON.stringify(lines)).toContain(data.captureId);
  });

  posixIt("places adapter events on the master's clock", async () => {
    const { result } = await runCli(harness, ["run", "boss_intro"], { sim: { timeScale: 1 } });
    const data = result["data"];
    const manifest = await readJson(data.manifest);
    const sync = manifest["timing"]["sync"];
    expect(sync).toMatchObject({ reference: "obs_recording_confirmed", adapterOffsetMs: expect.any(Number), uncertaintyMs: expect.any(Number) });
    expect(sync.adapterOffsetMs).toBeGreaterThanOrEqual(0);

    const timeline = manifest["timing"]["timeline"] as { type: string; t: number; seq: number; source: string }[];
    expect(timeline.map((event) => event.seq)).toEqual(timeline.map((_event, index) => index));
    expect(timeline[0]).toMatchObject({ type: "RECORDING_STARTED", t: 0, source: "cappy" });
    const adapterEvents = timeline.filter((event) => event.source === "adapter");
    const raw = data.events as { type: string; t: number }[];
    expect(adapterEvents.map((event) => event.type)).toEqual(raw.map((event) => event.type));
    adapterEvents.forEach((event, index) => {
      expect(event.t).toBeCloseTo((raw[index]?.t ?? 0) + sync.adapterOffsetMs, 2);
    });
    const completed = timeline.find((event) => event.type === "SCENARIO_COMPLETED");
    const stopped = timeline.find((event) => event.type === "RECORDING_STOPPED");
    expect(stopped?.t ?? 0).toBeGreaterThanOrEqual(completed?.t ?? Infinity);
  });
});
