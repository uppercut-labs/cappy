import { createHash, randomUUID } from "node:crypto";
import {
  type AdapterIdentity,
  type CappyError,
  type ErrorCode,
  type Result,
  type Scenario,
  type ScenarioParameters,
  type TimelineEvent,
  cappyError,
  err,
  newId,
  ok,
} from "@cappy/core";
import type WebSocket from "ws";
import { type AdapterMessage, type ControllerMessage, type ReplayHandoff, parseAdapterMessage } from "./messages.js";

export type OperationKind = "scenario" | "freeform" | "replay";

/**
 * Controller-side view of one adapter operation.
 *
 * scenario/replay: preparing -> ready -> starting -> running -> (stopping) -> done
 * freeform:        starting -> running -> stopping -> done
 */
export type OperationState = "preparing" | "ready" | "starting" | "running" | "stopping" | "done";

export interface OperationOutcome {
  readonly result?: Readonly<Record<string, unknown>>;
  readonly replay?: ReplayHandoff;
  readonly events: readonly TimelineEvent[];
}

export interface HeartbeatOptions {
  readonly intervalMs: number;
  readonly timeoutMs: number;
}

export const DEFAULT_HEARTBEAT: HeartbeatOptions = { intervalMs: 2_000, timeoutMs: 6_000 };

export interface NegotiatedAdapter {
  readonly protocolVersion: number;
  readonly adapter: AdapterIdentity;
  readonly game: { readonly id: string; readonly name?: string };
  readonly build?: string;
  readonly capabilities: readonly string[];
}

const OPERATION = "protocol";

function protocolError(code: ErrorCode, message: string, details?: Record<string, unknown>): CappyError {
  return cappyError(code, message, OPERATION, details === undefined ? {} : { details });
}

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolve = resolve;
    });
  }
}

function inlineDigestMatches(replay: ReplayHandoff): boolean {
  if (replay.kind !== "inline") {
    return true;
  }
  return createHash("sha256").update(Buffer.from(replay.data, "base64")).digest("hex") === replay.sha256;
}

/** One adapter operation: an authored scenario, a freeform recording, or a replay. */
export class AdapterOperation {
  readonly id = `op_${randomUUID()}`;
  private currentState: OperationState;
  private readonly timeline: TimelineEvent[] = [];
  private readonly settled = new Deferred<Result<OperationOutcome>>();
  private waiter: { expect: "ready" | "started"; deferred: Deferred<Result<void>>; timer: NodeJS.Timeout } | undefined;

  /** Resolves once the operation completes, fails, or is cancelled. */
  readonly completion: Promise<Result<OperationOutcome>> = this.settled.promise;

  constructor(
    private readonly connection: AdapterConnection,
    readonly kind: OperationKind,
    readonly correlationId: string,
  ) {
    this.currentState = kind === "freeform" ? "starting" : "preparing";
  }

  get state(): OperationState {
    return this.currentState;
  }

  get events(): readonly TimelineEvent[] {
    return this.timeline;
  }

  /** Begin a prepared scenario or replay and wait for the adapter to confirm. */
  async start(timeoutMs: number): Promise<Result<void>> {
    if (this.currentState !== "ready") {
      return err(protocolError("PROTOCOL_OUT_OF_STATE", `cannot start operation in state "${this.currentState}"`, { op: this.id }));
    }
    this.currentState = "starting";
    const waiting = this.await("started", timeoutMs);
    this.connection.send({ type: "start", op: this.id });
    return waiting;
  }

  /** Ask the adapter to finish a running freeform recording or replay. */
  stop(): Result<void> {
    if (this.currentState !== "running") {
      return err(protocolError("PROTOCOL_OUT_OF_STATE", `cannot stop operation in state "${this.currentState}"`, { op: this.id }));
    }
    this.currentState = "stopping";
    this.connection.send({ type: "stop", op: this.id });
    return ok(undefined);
  }

  /** Cancel the operation. It settles as cancelled, never as success. */
  cancel(reason = "cancelled by controller"): Promise<Result<OperationOutcome>> {
    if (this.currentState !== "done") {
      this.connection.send({ type: "cancel", op: this.id });
      this.finish(err(cappyError("OPERATION_CANCELLED", reason, OPERATION, { details: { op: this.id } })));
    }
    return this.completion;
  }

  /** Wait for an adapter acknowledgement (`ready` or `started`). */
  await(expect: "ready" | "started", timeoutMs: number): Promise<Result<void>> {
    const deferred = new Deferred<Result<void>>();
    const timer = setTimeout(() => {
      const error = protocolError("OPERATION_TIMEOUT", `adapter did not report ${expect} within ${timeoutMs} ms`, { op: this.id });
      this.connection.send({ type: "cancel", op: this.id });
      this.finish(err(error));
    }, timeoutMs);
    this.waiter = { expect, deferred, timer };
    return deferred.promise;
  }

  /** Route an adapter message addressed to this operation. */
  handle(message: Extract<AdapterMessage, { op: string }>): void {
    switch (message.type) {
      case "ready":
        if (this.currentState !== "preparing") {
          return this.violation(`"ready" is not valid in state "${this.currentState}"`);
        }
        this.currentState = "ready";
        return this.acknowledge("ready");
      case "started":
        if (this.currentState !== "starting") {
          return this.violation(`"started" is not valid in state "${this.currentState}"`);
        }
        this.currentState = "running";
        return this.acknowledge("started");
      case "event":
        this.timeline.push({
          id: newId("evt"),
          source: "adapter",
          seq: this.connection.nextSequence(),
          t: message.t,
          type: message.event,
          ...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
          ...(message.payload === undefined ? {} : { payload: message.payload }),
          correlationId: this.correlationId,
        });
        return;
      case "completed":
        if (this.currentState !== "running" && this.currentState !== "stopping") {
          return this.violation(`"completed" is not valid in state "${this.currentState}"`);
        }
        if (message.replay !== undefined && !inlineDigestMatches(message.replay)) {
          return this.fail(protocolError("PROTOCOL_INVALID_MESSAGE", "inline replay payload does not match its SHA-256", { op: this.id }));
        }
        return this.finish(
          ok({
            ...(message.result === undefined ? {} : { result: message.result }),
            ...(message.replay === undefined ? {} : { replay: message.replay }),
            events: this.timeline,
          }),
        );
      case "failed":
        return this.finish(
          err(
            cappyError("ADAPTER_OPERATION_FAILED", `adapter reported failure: ${message.message}`, OPERATION, {
              details: { op: this.id, adapterCode: message.code },
            }),
          ),
        );
    }
  }

  /** Fail the operation with a structured error. */
  fail(error: CappyError): void {
    if (this.currentState !== "done") {
      this.connection.send({ type: "error", code: error.code, message: error.message, op: this.id });
      this.finish(err(error));
    }
  }

  get done(): boolean {
    return this.currentState === "done";
  }

  private violation(reason: string): void {
    this.fail(protocolError("PROTOCOL_OUT_OF_STATE", reason, { op: this.id }));
  }

  private acknowledge(expect: "ready" | "started"): void {
    const waiter = this.waiter;
    if (waiter?.expect === expect) {
      clearTimeout(waiter.timer);
      this.waiter = undefined;
      waiter.deferred.resolve(ok(undefined));
    }
  }

  private finish(result: Result<OperationOutcome>): void {
    if (this.currentState === "done") {
      return;
    }
    this.currentState = "done";
    const waiter = this.waiter;
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      this.waiter = undefined;
      waiter.deferred.resolve(result.ok ? err(protocolError("PROTOCOL_OUT_OF_STATE", "operation ended early", { op: this.id })) : result);
    }
    this.settled.resolve(result);
    this.connection.release(this);
  }
}

/**
 * A negotiated connection to one game adapter. At most one operation is
 * active at a time.
 */
export class AdapterConnection {
  private active: AdapterOperation | undefined;
  private registered: readonly Scenario[] = [];
  private scenarioWaiters: Deferred<readonly Scenario[]>[] = [];
  private sequence = 0;
  private closedWith: CappyError | undefined;
  private readonly closed = new Deferred<CappyError>();
  private readonly issues: CappyError[] = [];
  /** Operations that already settled; late messages for them cannot change the outcome. */
  private readonly finished = new Set<string>();
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private lastPong = Date.now();
  private nonce = 0;

  constructor(
    private readonly socket: WebSocket,
    readonly negotiated: NegotiatedAdapter,
    heartbeat: HeartbeatOptions = DEFAULT_HEARTBEAT,
  ) {
    socket.on("message", (data, isBinary) => {
      this.receive(isBinary ? undefined : data.toString());
    });
    socket.on("close", () => {
      this.shutdown(protocolError("ADAPTER_DISCONNECTED", "the game adapter disconnected"));
    });
    socket.on("error", () => {
      this.shutdown(protocolError("ADAPTER_DISCONNECTED", "the game adapter connection failed"));
    });
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastPong > heartbeat.timeoutMs) {
        this.shutdown(protocolError("ADAPTER_UNRESPONSIVE", `no heartbeat from the game adapter for ${heartbeat.timeoutMs} ms`));
        socket.terminate();
        return;
      }
      this.send({ type: "ping", nonce: String(++this.nonce) });
    }, heartbeat.intervalMs);
  }

  get capabilities(): readonly string[] {
    return this.negotiated.capabilities;
  }

  /** Scenarios most recently registered by the adapter. */
  get scenarios(): readonly Scenario[] {
    return this.registered;
  }

  /** Protocol violations that occurred while no operation was active. */
  get protocolIssues(): readonly CappyError[] {
    return this.issues;
  }

  /** Resolves with the reason once the connection is gone. */
  get disconnected(): Promise<CappyError> {
    return this.closed.promise;
  }

  /** Request the adapter's scenario registry. */
  async listScenarios(timeoutMs: number): Promise<Result<readonly Scenario[]>> {
    if (this.closedWith !== undefined) {
      return err(this.closedWith);
    }
    const waiter = new Deferred<readonly Scenario[]>();
    this.scenarioWaiters.push(waiter);
    this.send({ type: "list_scenarios" });
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs).unref());
    const outcome = await Promise.race([waiter.promise, timeout, this.closed.promise]);
    this.scenarioWaiters = this.scenarioWaiters.filter((entry) => entry !== waiter);
    if (outcome === "timeout") {
      return err(protocolError("OPERATION_TIMEOUT", `adapter did not list scenarios within ${timeoutMs} ms`));
    }
    return Array.isArray(outcome) ? ok(outcome) : err(outcome as CappyError);
  }

  /** Ask the adapter to prepare an authored scenario and wait until it is ready. */
  async prepareScenario(
    scenario: string,
    parameters: ScenarioParameters,
    options: { correlationId: string; readyTimeoutMs: number; presentation?: Record<string, unknown> },
  ): Promise<Result<AdapterOperation>> {
    return this.begin("scenario", options.correlationId, "ready", options.readyTimeoutMs, (op) => ({
      type: "prepare_scenario",
      op,
      scenario,
      parameters,
      ...(options.presentation === undefined ? {} : { presentation: options.presentation }),
    }));
  }

  /** Start a freeform recording and wait until the adapter confirms it began. */
  async startFreeform(options: { correlationId: string; startTimeoutMs: number }): Promise<Result<AdapterOperation>> {
    return this.begin("freeform", options.correlationId, "started", options.startTimeoutMs, (op) => ({ type: "record_start", op }));
  }

  /** Hand a stored replay to the adapter and wait until it is ready to play. */
  async prepareReplay(
    replay: ReplayHandoff,
    options: { correlationId: string; readyTimeoutMs: number },
  ): Promise<Result<AdapterOperation>> {
    return this.begin("replay", options.correlationId, "ready", options.readyTimeoutMs, (op) => ({ type: "prepare_replay", op, replay }));
  }

  close(): void {
    this.shutdown(protocolError("ADAPTER_DISCONNECTED", "connection closed by controller"));
    this.socket.close(1000, "closed by controller");
  }

  send(message: ControllerMessage): void {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  nextSequence(): number {
    return this.sequence++;
  }

  release(operation: AdapterOperation): void {
    this.finished.add(operation.id);
    if (this.active === operation) {
      this.active = undefined;
    }
  }

  private async begin(
    kind: OperationKind,
    correlationId: string,
    expect: "ready" | "started",
    timeoutMs: number,
    request: (op: string) => ControllerMessage,
  ): Promise<Result<AdapterOperation>> {
    if (this.closedWith !== undefined) {
      return err(this.closedWith);
    }
    if (this.active !== undefined) {
      return err(protocolError("OPERATION_BUSY", "another adapter operation is already active", { op: this.active.id }));
    }
    const operation = new AdapterOperation(this, kind, correlationId);
    this.active = operation;
    const acknowledged = operation.await(expect, timeoutMs);
    this.send(request(operation.id));
    const result = await acknowledged;
    return result.ok ? ok(operation) : result;
  }

  private receive(text: string | undefined): void {
    if (text === undefined) {
      return this.violation(protocolError("PROTOCOL_INVALID_MESSAGE", "binary frames are not part of the protocol"));
    }
    const parsed = parseAdapterMessage(text);
    if (!parsed.ok) {
      return this.violation(protocolError("PROTOCOL_INVALID_MESSAGE", parsed.reason));
    }
    const message = parsed.message;
    switch (message.type) {
      case "hello":
        return this.violation(protocolError("PROTOCOL_OUT_OF_STATE", "handshake already completed"));
      case "pong":
        this.lastPong = Date.now();
        return;
      case "scenarios":
        this.registered = message.scenarios;
        for (const waiter of this.scenarioWaiters) {
          waiter.resolve(message.scenarios);
        }
        this.scenarioWaiters = [];
        return;
      default:
        if (this.finished.has(message.op)) {
          return;
        }
        if (this.active === undefined || this.active.id !== message.op) {
          return this.violation(
            protocolError("PROTOCOL_OUT_OF_STATE", `"${message.type}" refers to operation "${message.op}", which is not active`, {
              op: message.op,
            }),
          );
        }
        return this.active.handle(message);
    }
  }

  /** Fail the active operation, or record the issue when idle. */
  private violation(error: CappyError): void {
    if (this.active !== undefined && !this.active.done) {
      this.active.fail(error);
      return;
    }
    this.issues.push(error);
    this.send({ type: "error", code: error.code, message: error.message });
  }

  private shutdown(reason: CappyError): void {
    if (this.closedWith !== undefined) {
      return;
    }
    this.closedWith = reason;
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.active?.fail(reason);
    this.closed.resolve(reason);
  }
}
