import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createLocalMcp, type LocalMcp } from "../src/mcp.js";
import { configure, createHarness, disposeHarness, type Harness, repoRoot, simulatorBin } from "./support.js";

const envelope = z.object({
  command: z.string(), ok: z.boolean(), data: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string() }).optional(),
}).passthrough();
type Envelope = z.output<typeof envelope>;

let harness: Harness;
let local: LocalMcp;
let client: Client;

async function connect(env: NodeJS.ProcessEnv = process.env, configPath?: string): Promise<void> {
  local = createLocalMcp({ projectDir: harness.project, env, ...(configPath === undefined ? {} : { configPath }) });
  client = new Client({ name: "cappy-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await local.server.connect(serverTransport);
  await client.connect(clientTransport);
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Envelope> {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  const parsed = envelope.parse(result.structuredContent);
  expect(result.isError).toBe(!parsed.ok);
  const text = result.content.find((part) => part.type === "text");
  expect(text?.type === "text" ? JSON.parse(text.text) : undefined).toEqual(result.structuredContent);
  return parsed;
}

beforeEach(async () => {
  harness = await createHarness("cappy-mcp-");
  await configure(harness);
});

afterEach(async () => {
  await local?.close();
  await client?.close();
  await disposeHarness(harness);
});

describe("local MCP", () => {
  it("discovers typed tools with honest safety annotations", async () => {
    await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "cappy_doctor", "cappy_scenarios", "cappy_inventory", "cappy_run", "cappy_record", "cappy_replay",
      "cappy_compare", "cappy_compare_builds", "cappy_timeline", "cappy_clean", "cappy_delete",
    ]);
    expect(tools.find((tool) => tool.name === "cappy_delete")?.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(tools.find((tool) => tool.name === "cappy_clean")?.annotations).toMatchObject({ destructiveHint: false, readOnlyHint: true });
    expect(tools.find((tool) => tool.name === "cappy_doctor")?.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((tool) => tool.name === "cappy_record")?.inputSchema.required).toContain("durationSeconds");
  });

  it("validates bounded recording and requires explicit deletion confirmation", async () => {
    await connect();
    for (const args of [{}, { durationSeconds: 0 }, { durationSeconds: 3601 }, { durationSeconds: 1, shell: "echo unsafe" }]) {
      expect((await client.callTool({ name: "cappy_record", arguments: args })).isError).toBe(true);
    }
    expect((await client.callTool({ name: "cappy_delete", arguments: { all: true } })).isError).toBe(true);
    expect(existsSync(path.join(harness.project, ".cappy"))).toBe(false);
  });

  it("returns configuration errors and an empty inventory without creating a workspace", async () => {
    await connect();
    expect(await call("cappy_inventory")).toMatchObject({ ok: true, data: { items: [] } });
    expect(existsSync(path.join(harness.project, ".cappy"))).toBe(false);
    await writeFile(path.join(harness.project, "cappy.config.json"), "not json");
    expect(await call("cappy_doctor")).toMatchObject({ ok: false, error: { code: "CONFIG_PARSE_ERROR" } });
  });

  it("uses a selected config and preserves missing-config errors", async () => {
    await connect(process.env, "missing.json");
    expect(await call("cappy_inventory")).toMatchObject({ ok: false, error: { code: "CONFIG_NOT_FOUND" } });
  });

  it("runs discovery, capture, recording, replay, comparison, timeline and safe cleanup in process", async () => {
    await connect();
    expect(await call("cappy_doctor")).toMatchObject({ ok: true });
    expect(await call("cappy_scenarios")).toMatchObject({ ok: true, data: { scenarios: expect.arrayContaining([expect.objectContaining({ id: "boss_intro" })]) } });
    const captured = await call("cappy_run", { scenario: "boss_intro", parameters: { difficulty: 3 } });
    expect(captured.ok).toBe(true);
    const captureA = z.string().parse(captured.data?.["captureId"]);
    const recorded = await call("cappy_record", { durationSeconds: 0.05 });
    expect(recorded.ok).toBe(true);
    const sessionId = z.object({ id: z.string() }).parse(recorded.data?.["session"]).id;
    const replayed = await call("cappy_replay", { sessionId, noCapture: true });
    expect(replayed.ok).toBe(true);
    const second = await call("cappy_run", { scenario: "boss_intro", parameters: { difficulty: 3 } });
    const captureB = z.string().parse(second.data?.["captureId"]);
    expect(await call("cappy_compare", { captureA, captureB })).toMatchObject({ ok: true });
    expect(await call("cappy_timeline", { id: sessionId, format: "csv" })).toMatchObject({ ok: true, data: { content: expect.stringContaining("seq,t_ms,type") } });
    expect(await call("cappy_inventory", { kind: "capture" })).toMatchObject({ ok: true, data: { items: expect.arrayContaining([expect.objectContaining({ id: captureA })]) } });
    expect(await call("cappy_clean", { ids: [sessionId] })).toMatchObject({ ok: true, data: { dryRun: true } });
    const sessionFile = path.join(harness.project, ".cappy/sessions", sessionId, "session.json");
    expect(existsSync(sessionFile)).toBe(true);
    expect(await call("cappy_delete", { ids: [sessionId], confirmDelete: true })).toMatchObject({ ok: true, data: { dryRun: false } });
    expect(existsSync(sessionFile)).toBe(false);
  });

  it("captures two configured builds and applies comparison gates", async () => {
    const configPath = path.join(harness.project, "cappy.config.json");
    const config = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(configPath, "utf8")));
    await writeFile(configPath, JSON.stringify({ ...config, builds: { alternate: { game: { args: [simulatorBin] } } } }));
    await connect();
    expect(await call("cappy_compare_builds", { source: "boss_intro", buildA: "base", buildB: "alternate", minSsim: 1, requireSameEvents: true })).toMatchObject({
      ok: true, data: { builds: { a: "base", b: "alternate" }, comparison: expect.any(Object) },
    });
  });

  it("prevents concurrent operations and cancels an active recording before accepting another", async () => {
    await connect();
    const controller = new AbortController();
    const recording = client.callTool({ name: "cappy_record", arguments: { durationSeconds: 30, capture: true } }, undefined, { signal: controller.signal });
    const rejected = expect(recording).rejects.toThrow();
    await expect.poll(async () => (await readdir(path.join(harness.project, ".cappy/sessions")).catch(() => [])).length).toBe(1);
    expect(await call("cappy_scenarios")).toMatchObject({ ok: false, error: { code: "OPERATION_BUSY" } });
    controller.abort();
    await rejected;
    await expect.poll(async () => {
      const ids = await readdir(path.join(harness.project, ".cappy/sessions"));
      return JSON.parse(await readFile(path.join(harness.project, ".cappy/sessions", ids[0] ?? "", "session.json"), "utf8")) as unknown;
    }).toMatchObject({ status: "cancelled" });
    await expect.poll(async () => (await call("cappy_inventory")).ok).toBe(true);
    expect(harness.obs.requests.map((request) => request.requestType)).toContain("StopRecord");
  });

  it("cancels and cleans up recording on transport disconnect", async () => {
    await connect();
    const recording = client.callTool({ name: "cappy_record", arguments: { durationSeconds: 30 } });
    const rejected = expect(recording).rejects.toThrow();
    await expect.poll(async () => (await readdir(path.join(harness.project, ".cappy/sessions")).catch(() => [])).length).toBe(1);
    await client.close();
    await rejected;
    await local.close();
    const ids = await readdir(path.join(harness.project, ".cappy/sessions"));
    expect(JSON.parse(await readFile(path.join(harness.project, ".cappy/sessions", ids[0] ?? "", "session.json"), "utf8"))).toMatchObject({ status: "cancelled" });
  });

  it("cancels a game waiting for its adapter and stops the child process", async () => {
    const pidFile = path.join(harness.project, "game-pid.txt");
    await writeFile(path.join(harness.project, "cappy.config.json"), JSON.stringify({
      schemaVersion: 1, project: { id: "sim", name: "Simulator" },
      game: { command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`] },
      adapter: { port: 0 }, timeouts: { connectMs: 30_000 },
    }));
    await connect();
    const controller = new AbortController();
    const discovery = client.callTool({ name: "cappy_scenarios", arguments: {} }, undefined, { signal: controller.signal });
    const outcome = discovery.then((result) => ({ result }), (error: unknown) => ({ error }));
    await expect.poll(() => existsSync(pidFile)).toBe(true);
    const pid = Number(await readFile(pidFile, "utf8"));
    controller.abort();
    expect(await outcome).toHaveProperty("error");
    await expect.poll(async () => (await call("cappy_inventory")).ok).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("initializes the executable over actual stdio with protocol-only stdout", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repoRoot, "packages/cli/dist/bin.js"), "mcp", "-C", harness.project],
      stderr: "pipe",
    });
    const executable = new Client({ name: "stdio-test", version: "1.0.0" });
    try {
      await executable.connect(transport);
      expect((await executable.listTools()).tools).toHaveLength(11);
      const result = await executable.callTool({ name: "cappy_record", arguments: { durationSeconds: 0.05 } });
      expect(result.isError).toBe(false);
      expect(envelope.parse(result.structuredContent)).toMatchObject({ ok: true, data: { session: { status: "completed" } } });
      // A second protocol message proves recording never attached readline to MCP stdin.
      expect((await executable.callTool({ name: "cappy_inventory", arguments: { kind: "session" } })).isError).toBe(false);
    } finally {
      await executable.close();
    }
  });

  it.each(["EOF", ...(process.platform === "win32" ? [] : ["SIGINT", "SIGTERM"])] as const)("cleans up an executable recording on %s", async (ending) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repoRoot, "packages/cli/dist/bin.js"), "mcp", "-C", harness.project],
      stderr: "pipe",
    });
    const executable = new Client({ name: "stdio-shutdown", version: "1.0.0" });
    try {
      await executable.connect(transport);
      const recording = executable.callTool({ name: "cappy_record", arguments: { durationSeconds: 30 } }).catch(() => undefined);
      await expect.poll(async () => (await readdir(path.join(harness.project, ".cappy/sessions")).catch(() => [])).length).toBe(1);
      if (ending === "EOF") {
        await executable.close();
      } else {
        expect(transport.pid).not.toBeNull();
        process.kill(transport.pid ?? 0, ending);
      }
      await recording;
      await expect.poll(async () => {
        const ids = await readdir(path.join(harness.project, ".cappy/sessions"));
        return JSON.parse(await readFile(path.join(harness.project, ".cappy/sessions", ids[0] ?? "", "session.json"), "utf8")) as unknown;
      }).toMatchObject({ status: "cancelled" });
    } finally {
      await executable.close();
    }
  });
});
