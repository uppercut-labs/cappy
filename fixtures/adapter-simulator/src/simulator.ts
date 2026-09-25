import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type AdapterMessage,
  type ControllerMessage,
  type ReplayHandoff,
  SUPPORTED_PROTOCOL,
  parseControllerMessage,
} from "@cappy/protocol";
import WebSocket from "ws";

export interface ScriptedEvent {
  readonly event: string;
  /** Operation-relative milliseconds. */
  readonly t: number;
  readonly durationMs?: number;
  readonly payload?: unknown;
}

export interface ParameterSpec {
  readonly type: "string" | "number" | "integer" | "boolean";
  readonly required?: boolean;
  readonly default?: string | number | boolean;
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface SimulatedScenario {
  readonly id: string;
  readonly name: string;
  readonly parameters?: Readonly<Record<string, ParameterSpec>>;
  readonly requiredCapabilities?: readonly string[];
  /** Events emitted after the scenario starts, before it completes. */
  readonly events?: readonly ScriptedEvent[];
  /** Report this failure instead of completing. */
  readonly fail?: { readonly code: string; readonly message: string };
}

export interface SimulatorOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly protocol?: { readonly min: number; readonly max: number };
  readonly adapter?: { readonly name: string; readonly version: string };
  readonly game?: { readonly id: string; readonly name?: string };
  readonly build?: string;
  readonly capabilities?: readonly string[];
  readonly scenarios?: readonly SimulatedScenario[];
  /** Events emitted while a freeform session records. */
  readonly freeformScript?: readonly ScriptedEvent[];
  /** Answer heartbeat pings. Disable to simulate a hung game. */
  readonly respondToPings?: boolean;
  /** Milliseconds of real delay per scripted millisecond; 0 emits immediately. */
  readonly timeScale?: number;
  /**
   * Opaque replay bytes to hand over instead of the simulator's own format.
   * Replays are accepted only when Cappy returns exactly these bytes.
   */
  readonly replayPayload?: Uint8Array;
  /** How replay payloads travel: inline base64 (default) or a file in `replayDir`. */
  readonly replayHandoff?: "inline" | "file";
  readonly replayDir?: string;
  /** Complete freeform recordings without a replay payload. */
  readonly omitReplay?: boolean;
}

/** JSON-serializable subset of options accepted through CAPPY_SIM_OPTIONS. */
export interface SimulatorProcessOptions {
  readonly capabilities?: readonly string[];
  readonly adapter?: { readonly name: string; readonly version: string };
  readonly game?: { readonly id: string; readonly name?: string };
  readonly build?: string;
  readonly replayPayloadBase64?: string;
  readonly replayHandoff?: "inline" | "file";
  readonly replayDir?: string;
  readonly omitReplay?: boolean;
  readonly timeScale?: number;
  /** Write every replay payload received from Cappy into this directory. */
  readonly receivedReplayDir?: string;
}

export const SIMULATOR_REPLAY_FORMAT = "cappy-sim-replay-v1";

export const DEFAULT_SCENARIOS: readonly SimulatedScenario[] = [
  {
    id: "boss_intro",
    name: "Boss intro",
    parameters: { difficulty: { type: "integer", minimum: 1, maximum: 3, default: 2 } },
    requiredCapabilities: ["scenarios"],
    events: [
      { event: "BOSS_APPEAR", t: 100 },
      { event: "SPELL_CAST", t: 350, payload: { spell: "fireball" } },
      { event: "IMPACT", t: 500, durationMs: 120 },
    ],
  },
  {
    id: "menu_idle",
    name: "Menu idle",
    events: [{ event: "MENU_SHOWN", t: 0 }],
  },
];

export const DEFAULT_FREEFORM_SCRIPT: readonly ScriptedEvent[] = [
  { event: "PLAYER_SPAWN", t: 0 },
  { event: "JUMP", t: 250 },
  { event: "COIN", t: 400, payload: { value: 10 } },
];

export const DEFAULT_CAPABILITIES = ["scenarios", "freeform_recording", "replay", "deterministic_replay"] as const;

interface ActiveOperation {
  readonly op: string;
  readonly kind: "scenario" | "freeform" | "replay";
  readonly script: readonly ScriptedEvent[];
  readonly fail?: { readonly code: string; readonly message: string };
  readonly timers: NodeJS.Timeout[];
}

export class SimulatorRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SimulatorRejectedError";
  }
}

function encodeEvents(events: readonly ScriptedEvent[]): Uint8Array {
  return Buffer.from(JSON.stringify({ format: SIMULATOR_REPLAY_FORMAT, events }), "utf8");
}

function decodeEvents(bytes: Uint8Array): readonly ScriptedEvent[] | undefined {
  try {
    const decoded = JSON.parse(Buffer.from(bytes).toString("utf8")) as { format?: unknown; events?: unknown };
    return decoded.format === SIMULATOR_REPLAY_FORMAT && Array.isArray(decoded.events) ? (decoded.events as ScriptedEvent[]) : undefined;
  } catch {
    return undefined;
  }
}

/** Bytes of a replay handoff, reading file handoffs from disk. */
function handoffBytes(replay: ReplayHandoff): Uint8Array | undefined {
  try {
    return replay.kind === "inline" ? Buffer.from(replay.data, "base64") : readFileSync(replay.path);
  } catch {
    return undefined;
  }
}

function invalidParameter(
  scenario: SimulatedScenario,
  parameters: Readonly<Record<string, string | number | boolean>>,
): string | undefined {
  const specs = scenario.parameters ?? {};
  for (const name of Object.keys(parameters)) {
    if (!(name in specs)) {
      return `unknown parameter "${name}"`;
    }
  }
  for (const [name, spec] of Object.entries(specs)) {
    const value = parameters[name];
    if (value === undefined) {
      if (spec.required === true) {
        return `missing parameter "${name}"`;
      }
      continue;
    }
    const typeOk =
      spec.type === "integer" ? Number.isInteger(value) : spec.type === "number" ? typeof value === "number" : typeof value === spec.type;
    if (!typeOk) {
      return `parameter "${name}" must be ${spec.type}`;
    }
    if (typeof value === "number" && ((spec.minimum !== undefined && value < spec.minimum) || (spec.maximum !== undefined && value > spec.maximum))) {
      return `parameter "${name}" is out of range`;
    }
  }
  return undefined;
}

/**
 * A deterministic game adapter that speaks the Cappy protocol. It proves the
 * controller/adapter boundary before a real engine is involved.
 */
export class AdapterSimulator {
  readonly received: ControllerMessage[] = [];
  /** Replay payload bytes Cappy handed back, in order. */
  readonly receivedReplays: Uint8Array[] = [];
  private active: ActiveOperation | undefined;
  private recorded: ScriptedEvent[] = [];

  private constructor(
    private readonly socket: WebSocket,
    private readonly options: SimulatorOptions,
    readonly protocolVersion: number,
  ) {}

  /** Connect, send the hello, and wait for Cappy's welcome. */
  static async connect(options: SimulatorOptions): Promise<AdapterSimulator> {
    const socket = new WebSocket(options.endpoint);
    socket.on("error", () => undefined);
    // One persistent listener from the start: Cappy may send its first request
    // in the same packet as the welcome, so nothing may be dropped between the
    // handshake and the simulator taking over.
    const queue: string[] = [];
    let wake: (() => void) | undefined;
    let deliver: ((text: string) => void) | undefined = undefined;
    socket.on("message", (data) => {
      const text = data.toString();
      if (deliver === undefined) {
        queue.push(text);
        wake?.();
      } else {
        deliver(text);
      }
    });
    const firstMessage = new Promise<string>((resolve, reject) => {
      const check = (): void => {
        const text = queue.shift();
        if (text !== undefined) {
          // Only the first message belongs to the handshake; later ones stay queued.
          wake = undefined;
          resolve(text);
        }
      };
      wake = check;
      socket.once("close", () => reject(new SimulatorRejectedError("CLOSED", "connection closed during handshake")));
    });
    firstMessage.catch(() => undefined);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const hello: AdapterMessage = {
      type: "hello",
      protocol: options.protocol ?? SUPPORTED_PROTOCOL,
      token: options.token,
      adapter: options.adapter ?? { name: "cappy-adapter-simulator", version: "0.1.0" },
      game: options.game ?? { id: "simulated-game", name: "Simulated Game" },
      ...(options.build === undefined ? {} : { build: options.build }),
      capabilities: [...(options.capabilities ?? DEFAULT_CAPABILITIES)],
    };
    socket.send(JSON.stringify(hello));
    const parsed = parseControllerMessage(await firstMessage);
    if (!parsed.ok) {
      socket.close();
      throw new Error(`unexpected reply: ${parsed.reason}`);
    }
    const message = parsed.message;
    if (message.type === "reject") {
      socket.close();
      throw new SimulatorRejectedError(message.code, message.message);
    }
    if (message.type !== "welcome") {
      socket.close();
      throw new Error(`expected welcome, received ${message.type}`);
    }
    const simulator = new AdapterSimulator(socket, options, message.protocol);
    deliver = (text) => simulator.receive(text);
    for (const text of queue.splice(0)) {
      simulator.receive(text);
    }
    simulator.registerScenarios();
    return simulator;
  }

  get scenarios(): readonly SimulatedScenario[] {
    return this.options.scenarios ?? DEFAULT_SCENARIOS;
  }

  /** Send a protocol message. */
  send(message: AdapterMessage): void {
    this.sendRaw(JSON.stringify(message));
  }

  /** Send arbitrary text, including malformed messages, for negative tests. */
  sendRaw(text: string): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(text);
    }
  }

  /** Resolves when the controller closes the connection. */
  get closed(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.socket.once("close", () => resolve()));
  }

  close(): void {
    this.clearActive();
    this.socket.close();
  }

  /** Drop the connection without a close handshake, like a crashed game. */
  crash(): void {
    this.clearActive();
    this.socket.terminate();
  }

  private registerScenarios(): void {
    this.send({
      type: "scenarios",
      scenarios: this.scenarios.map((scenario) => ({
        id: scenario.id,
        name: scenario.name,
        parameters: Object.fromEntries(
          Object.entries(scenario.parameters ?? {}).map(([name, spec]) => [name, { required: false, ...spec }]),
        ),
        requiredCapabilities: [...(scenario.requiredCapabilities ?? [])],
      })),
    });
  }

  private receive(text: string): void {
    const parsed = parseControllerMessage(text);
    if (!parsed.ok) {
      return;
    }
    const message = parsed.message;
    this.received.push(message);
    switch (message.type) {
      case "ping":
        if (this.options.respondToPings !== false) {
          this.send({ type: "pong", nonce: message.nonce });
        }
        return;
      case "list_scenarios":
        return this.registerScenarios();
      case "prepare_scenario": {
        const scenario = this.scenarios.find((candidate) => candidate.id === message.scenario);
        if (scenario === undefined) {
          return this.send({ type: "failed", op: message.op, code: "SCENARIO_NOT_FOUND", message: `unknown scenario "${message.scenario}"` });
        }
        const problem = invalidParameter(scenario, message.parameters);
        if (problem !== undefined) {
          return this.send({ type: "failed", op: message.op, code: "INVALID_PARAMETERS", message: problem });
        }
        this.active = {
          op: message.op,
          kind: "scenario",
          script: scenario.events ?? [],
          ...(scenario.fail === undefined ? {} : { fail: scenario.fail }),
          timers: [],
        };
        return this.send({ type: "ready", op: message.op });
      }
      case "record_start":
        this.recorded = [];
        this.active = { op: message.op, kind: "freeform", script: this.options.freeformScript ?? DEFAULT_FREEFORM_SCRIPT, timers: [] };
        this.send({ type: "started", op: message.op });
        return this.play(this.active);
      case "prepare_replay": {
        const bytes = handoffBytes(message.replay);
        if (bytes !== undefined) {
          this.receivedReplays.push(bytes);
        }
        const opaque = this.options.replayPayload;
        const events =
          bytes === undefined
            ? undefined
            : opaque === undefined
              ? decodeEvents(bytes)
              : Buffer.compare(Buffer.from(bytes), Buffer.from(opaque)) === 0
                ? (this.options.freeformScript ?? DEFAULT_FREEFORM_SCRIPT)
                : undefined;
        if (events === undefined) {
          return this.send({ type: "failed", op: message.op, code: "REPLAY_UNSUPPORTED", message: "replay payload is not a simulator replay" });
        }
        this.active = { op: message.op, kind: "replay", script: events, timers: [] };
        return this.send({ type: "ready", op: message.op });
      }
      case "start":
        if (this.active?.op === message.op) {
          this.send({ type: "started", op: message.op });
          this.play(this.active);
        }
        return;
      case "stop":
        if (this.active?.op === message.op) {
          this.complete(this.active);
        }
        return;
      case "cancel":
        if (this.active?.op === message.op) {
          this.clearActive();
        }
        return;
      default:
        return;
    }
  }

  /** Emit the operation's scripted events, then finish scenarios and replays. */
  private play(operation: ActiveOperation): void {
    const scale = this.options.timeScale ?? 0;
    const emit = (event: ScriptedEvent): void => {
      if (this.active !== operation) {
        return;
      }
      if (operation.kind === "freeform") {
        this.recorded.push(event);
      }
      this.send({
        type: "event",
        op: operation.op,
        t: event.t,
        event: event.event,
        ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        ...(event.payload === undefined ? {} : { payload: event.payload }),
      });
    };
    const finish = (): void => {
      if (this.active === operation && operation.kind !== "freeform") {
        this.complete(operation);
      }
    };
    if (scale === 0) {
      operation.script.forEach(emit);
      finish();
      return;
    }
    for (const event of operation.script) {
      operation.timers.push(setTimeout(() => emit(event), event.t * scale));
    }
    const end = Math.max(0, ...operation.script.map((event) => event.t + (event.durationMs ?? 0)));
    operation.timers.push(setTimeout(finish, end * scale + 1));
  }

  private complete(operation: ActiveOperation): void {
    this.clearActive();
    if (operation.fail !== undefined) {
      this.send({ type: "failed", op: operation.op, code: operation.fail.code, message: operation.fail.message });
      return;
    }
    if (operation.kind === "freeform") {
      const result = { events: this.recorded.length };
      if (this.options.omitReplay === true) {
        this.send({ type: "completed", op: operation.op, result });
        return;
      }
      this.send({ type: "completed", op: operation.op, result, replay: this.handoff(this.options.replayPayload ?? encodeEvents(this.recorded)) });
      return;
    }
    this.send({ type: "completed", op: operation.op, result: { events: operation.script.length } });
  }

  private handoff(bytes: Uint8Array): ReplayHandoff {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const format = this.options.replayPayload === undefined ? SIMULATOR_REPLAY_FORMAT : "opaque-test-bytes";
    if (this.options.replayHandoff === "file") {
      const file = path.join(this.options.replayDir ?? ".", `replay-${randomUUID()}.bin`);
      writeFileSync(file, bytes);
      return { kind: "file", path: file, sha256, bytes: bytes.byteLength, format };
    }
    return { kind: "inline", encoding: "base64", data: Buffer.from(bytes).toString("base64"), sha256, format };
  }

  private clearActive(): void {
    for (const timer of this.active?.timers ?? []) {
      clearTimeout(timer);
    }
    this.active = undefined;
  }
}
