import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdapterSimulator,
  type SimulatorOptions,
  SimulatorRejectedError,
} from "@cappy/adapter-simulator";
import {
  type AdapterConnection,
  AdapterServer,
  type AdapterServerOptions,
  ENDPOINT_ENV,
  TOKEN_ENV,
  negotiateVersion,
  parseAdapterMessage,
} from "@cappy/protocol";

const servers: AdapterServer[] = [];
const simulators: AdapterSimulator[] = [];

afterEach(async () => {
  for (const simulator of simulators.splice(0)) {
    simulator.close();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

async function listen(options: Partial<AdapterServerOptions> = {}): Promise<AdapterServer> {
  const result = await AdapterServer.listen({ port: 0, ...options });
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  servers.push(result.value);
  return result.value;
}

async function connect(
  server: AdapterServer,
  options: Partial<SimulatorOptions> = {},
): Promise<{ simulator: AdapterSimulator; connection: AdapterConnection }> {
  const [simulator, accepted] = await Promise.all([
    AdapterSimulator.connect({ endpoint: server.endpoint, token: server.token, ...options }),
    server.accept(2_000),
  ]);
  simulators.push(simulator);
  if (!accepted.ok) {
    throw new Error(accepted.error.message);
  }
  return { simulator, connection: accepted.value };
}

const timing = { correlationId: "op_test", readyTimeoutMs: 1_000 };

describe("listener", () => {
  it("binds to loopback by default and publishes the launch environment", async () => {
    const server = await listen();
    expect(server.address.address).toBe("127.0.0.1");
    expect(server.endpoint).toBe(`ws://127.0.0.1:${server.port}`);
    expect(server.token.length).toBeGreaterThanOrEqual(32);
    expect(server.launchEnvironment()).toEqual({ [ENDPOINT_ENV]: server.endpoint, [TOKEN_ENV]: server.token });
  });

  it("refuses to bind a non-loopback host", async () => {
    const result = await AdapterServer.listen({ host: "0.0.0.0", port: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: "LISTENER_NOT_LOOPBACK", retryable: false });
  });

  it("reports a port conflict as a structured listener failure", async () => {
    const first = await listen();
    const result = await AdapterServer.listen({ port: first.port });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: "LISTENER_FAILED", retryable: true });
  });

  it("times out when no adapter connects", async () => {
    const server = await listen();
    const result = await server.accept(50);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ADAPTER_CONNECT_TIMEOUT");
  });
});

describe("handshake", () => {
  it("negotiates the highest shared protocol version", () => {
    expect(negotiateVersion({ min: 1, max: 5 })).toBe(1);
    expect(negotiateVersion({ min: 2, max: 3 })).toBeUndefined();
  });

  it("completes version and capability negotiation", async () => {
    const server = await listen();
    const { simulator, connection } = await connect(server, { build: "demo-2026.09.25" });
    expect(simulator.protocolVersion).toBe(1);
    expect(connection.negotiated).toMatchObject({
      protocolVersion: 1,
      adapter: { name: "cappy-adapter-simulator" },
      game: { id: "simulated-game" },
      build: "demo-2026.09.25",
    });
  });

  it("fails incompatible versions before any operation starts", async () => {
    const server = await listen();
    const accepted = server.accept(2_000);
    const simulator = AdapterSimulator.connect({ endpoint: server.endpoint, token: server.token, protocol: { min: 2, max: 3 } });
    await expect(simulator).rejects.toMatchObject({ code: "PROTOCOL_VERSION_INCOMPATIBLE" });
    const result = await accepted;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      code: "PROTOCOL_VERSION_INCOMPATIBLE",
      details: { adapter: { min: 2, max: 3 }, supported: { min: 1, max: 1 } },
    });
  });

  it("keeps unknown non-required capabilities without breaking negotiation", async () => {
    const server = await listen({ requiredCapabilities: ["scenarios"] });
    const { connection } = await connect(server, { capabilities: ["scenarios", "time_travel", "hologram_mode"] });
    expect(connection.capabilities).toEqual(["hologram_mode", "scenarios", "time_travel"]);
  });

  it("rejects an adapter that lacks a required capability", async () => {
    const server = await listen({ requiredCapabilities: ["replay"] });
    const accepted = server.accept(2_000);
    await expect(
      AdapterSimulator.connect({ endpoint: server.endpoint, token: server.token, capabilities: ["scenarios"] }),
    ).rejects.toBeInstanceOf(SimulatorRejectedError);
    const result = await accepted;
    expect(!result.ok && result.error).toMatchObject({ code: "CAPABILITY_MISSING", details: { missing: ["replay"] } });
  });

  it("turns away connections with the wrong session token and keeps waiting", async () => {
    const server = await listen();
    const accepted = server.accept(2_000);
    await expect(AdapterSimulator.connect({ endpoint: server.endpoint, token: "x".repeat(32) })).rejects.toMatchObject({
      code: "PROTOCOL_UNAUTHENTICATED",
    });
    const simulator = await AdapterSimulator.connect({ endpoint: server.endpoint, token: server.token });
    simulators.push(simulator);
    expect((await accepted).ok).toBe(true);
  });

  it("rejects a second adapter while one is connected", async () => {
    const server = await listen();
    await connect(server);
    await expect(AdapterSimulator.connect({ endpoint: server.endpoint, token: server.token })).rejects.toMatchObject({
      code: "OPERATION_BUSY",
    });
  });

  it("forwards-compatibly ignores unknown hello fields", () => {
    const parsed = parseAdapterMessage(
      JSON.stringify({
        type: "hello",
        protocol: { min: 1, max: 2 },
        token: "t".repeat(32),
        adapter: { name: "future", version: "9.0.0" },
        game: { id: "g", engine: "future-engine" },
        capabilities: [],
        telemetryChannels: ["fps"],
      }),
    );
    expect(parsed.ok).toBe(true);
  });
});

describe("scenario flow", () => {
  it("lists registered scenarios with parameter and capability metadata", async () => {
    const server = await listen();
    const { connection } = await connect(server);
    const listed = await connection.listScenarios(1_000);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value.map((scenario) => scenario.id)).toEqual(["boss_intro", "menu_idle"]);
    expect(listed.value[0]).toMatchObject({
      parameters: { difficulty: { type: "integer", minimum: 1, maximum: 3 } },
      requiredCapabilities: ["scenarios"],
    });
  });

  it("prepares, starts, and completes a scenario with an ordered timeline", async () => {
    const server = await listen();
    const { simulator, connection } = await connect(server);
    const prepared = await connection.prepareScenario("boss_intro", { difficulty: 3 }, timing);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const operation = prepared.value;
    expect(operation.state).toBe("ready");

    expect((await operation.start(1_000)).ok).toBe(true);
    const outcome = await operation.completion;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.events.map((event) => [event.type, event.t])).toEqual([
      ["BOSS_APPEAR", 100],
      ["SPELL_CAST", 350],
      ["IMPACT", 500],
    ]);
    expect(outcome.value.events.map((event) => event.seq)).toEqual([0, 1, 2]);
    expect(outcome.value.events.every((event) => event.source === "adapter" && event.correlationId === "op_test")).toBe(true);
    expect(simulator.received.find((message) => message.type === "prepare_scenario")).toMatchObject({ parameters: { difficulty: 3 } });
  });

  it("surfaces adapter-side failures as structured errors", async () => {
    const server = await listen();
    const { connection } = await connect(server);
    const unknown = await connection.prepareScenario("missing", {}, timing);
    expect(!unknown.ok && unknown.error).toMatchObject({ code: "ADAPTER_OPERATION_FAILED", details: { adapterCode: "SCENARIO_NOT_FOUND" } });
    const invalid = await connection.prepareScenario("boss_intro", { difficulty: 9 }, timing);
    expect(!invalid.ok && invalid.error).toMatchObject({ details: { adapterCode: "INVALID_PARAMETERS" } });
  });

  it("allows only one active operation", async () => {
    const server = await listen();
    const { connection } = await connect(server);
    const first = await connection.prepareScenario("boss_intro", {}, timing);
    expect(first.ok).toBe(true);
    const second = await connection.prepareScenario("menu_idle", {}, timing);
    expect(!second.ok && second.error.code).toBe("OPERATION_BUSY");
  });

  it("settles a cancelled operation as cancelled, never as success", async () => {
    const server = await listen();
    const { simulator, connection } = await connect(server);
    const prepared = await connection.prepareScenario("boss_intro", {}, timing);
    if (!prepared.ok) throw new Error(prepared.error.message);
    const outcome = await prepared.value.cancel();
    expect(!outcome.ok && outcome.error.code).toBe("OPERATION_CANCELLED");
    await expect.poll(() => simulator.received.some((message) => message.type === "cancel")).toBe(true);
  });

  it("times out and cancels an adapter that never reports ready", async () => {
    const server = await listen();
    // A hand-rolled adapter that completes the handshake and then goes silent.
    const socket = new WebSocket(server.endpoint);
    const received: string[] = [];
    socket.on("message", (data) => received.push(data.toString()));
    await new Promise((resolve) => socket.once("open", resolve));
    socket.send(
      JSON.stringify({
        type: "hello",
        protocol: { min: 1, max: 1 },
        token: server.token,
        adapter: { name: "silent", version: "1.0.0" },
        game: { id: "silent" },
        capabilities: ["scenarios"],
      }),
    );
    const accepted = await server.accept(1_000);
    if (!accepted.ok) throw new Error(accepted.error.message);
    const result = await accepted.value.prepareScenario("boss_intro", {}, { ...timing, readyTimeoutMs: 30 });
    expect(!result.ok && result.error.code).toBe("OPERATION_TIMEOUT");
    await expect.poll(() => received.some((text) => text.includes('"cancel"'))).toBe(true);
    socket.terminate();
  });
});

describe("freeform and replay flows", () => {
  it("records a freeform session and replays it with the same timeline", async () => {
    const server = await listen();
    const { connection } = await connect(server);

    const recording = await connection.startFreeform({ correlationId: "op_rec", startTimeoutMs: 1_000 });
    if (!recording.ok) throw new Error(recording.error.message);
    await expect.poll(() => recording.value.events.length).toBe(3);
    expect(recording.value.stop().ok).toBe(true);
    const recorded = await recording.value.completion;
    if (!recorded.ok) throw new Error(recorded.error.message);
    expect(recorded.value.replay).toMatchObject({ kind: "inline", format: "cappy-sim-replay-v1" });

    const replay = recorded.value.replay;
    if (replay === undefined) throw new Error("no replay");
    const prepared = await connection.prepareReplay(replay, { correlationId: "op_replay", readyTimeoutMs: 1_000 });
    if (!prepared.ok) throw new Error(prepared.error.message);
    expect((await prepared.value.start(1_000)).ok).toBe(true);
    const replayed = await prepared.value.completion;
    if (!replayed.ok) throw new Error(replayed.error.message);

    const shape = (events: readonly { type: string; t: number }[]) => events.map((event) => [event.type, event.t]);
    expect(shape(replayed.value.events)).toEqual(shape(recorded.value.events));
    expect(replayed.value.events[0]?.seq).toBeGreaterThan(recorded.value.events.at(-1)?.seq ?? Infinity);
  });

  it("fails a replay the adapter cannot load", async () => {
    const server = await listen();
    const { connection } = await connect(server);
    const bogus = Buffer.from("not a replay");
    const { createHash } = await import("node:crypto");
    const result = await connection.prepareReplay(
      { kind: "inline", encoding: "base64", data: bogus.toString("base64"), sha256: createHash("sha256").update(bogus).digest("hex") },
      { correlationId: "op_x", readyTimeoutMs: 1_000 },
    );
    expect(!result.ok && result.error).toMatchObject({ code: "ADAPTER_OPERATION_FAILED", details: { adapterCode: "REPLAY_UNSUPPORTED" } });
  });
});

describe("protocol violations", () => {
  async function readyScenario() {
    const server = await listen();
    const { simulator, connection } = await connect(server);
    const prepared = await connection.prepareScenario("boss_intro", {}, timing);
    if (!prepared.ok) throw new Error(prepared.error.message);
    return { simulator, connection, operation: prepared.value };
  }

  it("fails the active operation on malformed JSON", async () => {
    const { simulator, operation } = await readyScenario();
    simulator.sendRaw("{ this is not json");
    const outcome = await operation.completion;
    expect(!outcome.ok && outcome.error).toMatchObject({ code: "PROTOCOL_INVALID_MESSAGE", operation: "protocol" });
  });

  it("fails the active operation on schema-invalid messages", async () => {
    const { simulator, operation } = await readyScenario();
    simulator.sendRaw(JSON.stringify({ type: "event", op: operation.id, t: -5, event: "IMPACT" }));
    const outcome = await operation.completion;
    expect(!outcome.ok && outcome.error.code).toBe("PROTOCOL_INVALID_MESSAGE");
  });

  it("never accepts completion before the operation started", async () => {
    const { simulator, operation } = await readyScenario();
    simulator.send({ type: "completed", op: operation.id });
    const outcome = await operation.completion;
    expect(!outcome.ok && outcome.error.code).toBe("PROTOCOL_OUT_OF_STATE");
    await expect.poll(() => simulator.received.some((message) => message.type === "error")).toBe(true);
  });

  it("fails on messages addressed to another operation", async () => {
    const { simulator, operation } = await readyScenario();
    simulator.send({ type: "started", op: "op_somebody_else" });
    const outcome = await operation.completion;
    expect(!outcome.ok && outcome.error.code).toBe("PROTOCOL_OUT_OF_STATE");
  });

  it("rejects an inline replay whose digest does not match", async () => {
    const server = await listen();
    const { simulator, connection } = await connect(server);
    const recording = await connection.startFreeform({ correlationId: "op_rec", startTimeoutMs: 1_000 });
    if (!recording.ok) throw new Error(recording.error.message);
    simulator.send({
      type: "completed",
      op: recording.value.id,
      replay: { kind: "inline", encoding: "base64", data: Buffer.from("abc").toString("base64"), sha256: "0".repeat(64) },
    });
    const outcome = await recording.value.completion;
    expect(!outcome.ok && outcome.error.code).toBe("PROTOCOL_INVALID_MESSAGE");
  });

  it("records violations that arrive while idle", async () => {
    const server = await listen();
    const { simulator, connection } = await connect(server);
    simulator.send({ type: "ready", op: "op_stray" });
    simulator.sendRaw("[]");
    await expect.poll(() => connection.protocolIssues.map((issue) => issue.code)).toEqual([
      "PROTOCOL_OUT_OF_STATE",
      "PROTOCOL_INVALID_MESSAGE",
    ]);
  });
});

describe("liveness", () => {
  it("fails the active operation when the adapter disconnects", async () => {
    const server = await listen();
    const { simulator, connection } = await connect(server);
    const prepared = await connection.prepareScenario("boss_intro", {}, timing);
    if (!prepared.ok) throw new Error(prepared.error.message);
    simulator.crash();
    const outcome = await prepared.value.completion;
    expect(!outcome.ok && outcome.error.code).toBe("ADAPTER_DISCONNECTED");
    expect((await connection.disconnected).code).toBe("ADAPTER_DISCONNECTED");
  });

  it("detects a hung adapter through missed heartbeats", async () => {
    const server = await listen({ heartbeat: { intervalMs: 20, timeoutMs: 60 } });
    const { connection } = await connect(server, { respondToPings: false });
    const prepared = await connection.prepareScenario("boss_intro", {}, timing);
    if (!prepared.ok) throw new Error(prepared.error.message);
    const outcome = await prepared.value.completion;
    expect(!outcome.ok && outcome.error.code).toBe("ADAPTER_UNRESPONSIVE");
  });

  it("keeps a responsive adapter alive across heartbeats", async () => {
    const server = await listen({ heartbeat: { intervalMs: 10, timeoutMs: 40 } });
    const { connection } = await connect(server);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const listed = await connection.listScenarios(500);
    expect(listed.ok).toBe(true);
  });
});
