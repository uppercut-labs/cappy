import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";

/*
 * A fake OBS WebSocket v5 server for automated tests. It implements the real
 * wire protocol (Hello/Identify/Identified, requests, events, password
 * authentication) so the production client is exercised unchanged.
 */

export interface FakeObsOptions {
  readonly password?: string;
  readonly scenes?: readonly string[];
  readonly currentScene?: string;
  readonly obsVersion?: string;
  readonly obsWebSocketVersion?: string;
  /** Per-request overrides: return a failure status or never answer. */
  readonly failRequests?: Readonly<Record<string, { code: number; comment: string } | "hang">>;
  /** Where StopRecord writes the master; required for recording. */
  readonly recordDirectory?: string;
  /** Master file contents written on StopRecord. */
  readonly masterBytes?: Uint8Array;
  /** Produce the master file with this function instead (for real media). */
  readonly writeMaster?: (outputPath: string) => void;
  /** Misbehaviors for failure tests. */
  readonly recording?: {
    /** StartRecord succeeds but the output never becomes active. */
    readonly neverActivates?: boolean;
    /** StopRecord succeeds but the output never becomes inactive. */
    readonly neverStops?: boolean;
    /** StopRecord reports a path but writes no file. */
    readonly noOutputFile?: boolean;
    /** Drop every connection when this request arrives. */
    readonly disconnectOn?: string;
  };
}

export interface FakeObsRequest {
  readonly requestType: string;
  readonly requestData?: Record<string, unknown>;
}

type RequestHandler = (data: Record<string, unknown> | undefined, server: FakeObsServer) => Record<string, unknown> | undefined;

export class FakeObsServer {
  /** Every request received, in order. */
  readonly requests: FakeObsRequest[] = [];
  readonly scenes: string[];
  currentScene: string;
  /** Whether the record output is active. */
  recording = false;
  /** Paths of masters written by StopRecord. */
  readonly outputs: string[] = [];
  private readonly handlers = new Map<string, RequestHandler>();
  private readonly sockets = new Set<WebSocket>();

  private constructor(
    private readonly server: WebSocketServer,
    private readonly options: FakeObsOptions,
  ) {
    this.scenes = [...(options.scenes ?? ["Scene"])];
    this.currentScene = options.currentScene ?? this.scenes[0] ?? "Scene";
    this.handle("GetVersion", () => ({
      obsVersion: this.options.obsVersion ?? "31.0.0",
      obsWebSocketVersion: this.options.obsWebSocketVersion ?? "5.5.0",
      rpcVersion: 1,
    }));
    this.handle("GetSceneList", () => ({
      currentProgramSceneName: this.currentScene,
      scenes: this.scenes.map((sceneName, sceneIndex) => ({ sceneName, sceneIndex })),
    }));
    this.handle("SetCurrentProgramScene", (data) => {
      const name = String(data?.["sceneName"]);
      if (!this.scenes.includes(name)) {
        return undefined;
      }
      this.currentScene = name;
      return {};
    });
    this.handle("GetRecordStatus", () => ({
      outputActive: this.recording,
      outputPaused: false,
      outputTimecode: "00:00:00.000",
      outputDuration: 0,
      outputBytes: 0,
    }));
    this.handle("GetRecordDirectory", () => ({ recordDirectory: this.options.recordDirectory ?? "" }));
    this.handle("StartRecord", () => {
      if (this.recording || this.options.recordDirectory === undefined) {
        return undefined;
      }
      this.emit("RecordStateChanged", { outputActive: false, outputState: "OBS_WEBSOCKET_OUTPUT_STARTING", outputPath: null });
      if (this.options.recording?.neverActivates !== true) {
        this.recording = true;
        this.emit("RecordStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_STARTED", outputPath: null });
      }
      return {};
    });
    this.handle("StopRecord", () => {
      if (!this.recording) {
        return undefined;
      }
      const directory = this.options.recordDirectory ?? ".";
      const outputPath = path.join(directory, `fake-obs-${Date.now()}-${this.outputs.length}.mkv`);
      if (this.options.recording?.noOutputFile !== true) {
        mkdirSync(directory, { recursive: true });
        if (this.options.writeMaster === undefined) {
          writeFileSync(outputPath, this.options.masterBytes ?? Buffer.from("fake master recording"));
        } else {
          this.options.writeMaster(outputPath);
        }
      }
      this.outputs.push(outputPath);
      this.emit("RecordStateChanged", { outputActive: true, outputState: "OBS_WEBSOCKET_OUTPUT_STOPPING", outputPath: null });
      if (this.options.recording?.neverStops !== true) {
        this.recording = false;
        this.emit("RecordStateChanged", { outputActive: false, outputState: "OBS_WEBSOCKET_OUTPUT_STOPPED", outputPath });
      }
      return { outputPath };
    });
    server.on("connection", (socket) => this.accept(socket));
  }

  static async start(options: FakeObsOptions = {}): Promise<FakeObsServer> {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    return new FakeObsServer(server, options);
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** Register or replace a request handler. Returning undefined fails the request. */
  handle(requestType: string, handler: RequestHandler): void {
    this.handlers.set(requestType, handler);
  }

  /** Broadcast an OBS event to identified clients. */
  emit(eventType: string, eventData: Record<string, unknown>): void {
    for (const socket of this.sockets) {
      socket.send(JSON.stringify({ op: 5, d: { eventType, eventIntent: 64, eventData } }));
    }
  }

  /** Drop every client connection abruptly. */
  disconnectAll(): void {
    for (const socket of this.sockets) {
      socket.terminate();
    }
  }

  async close(): Promise<void> {
    for (const client of this.server.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private accept(socket: WebSocket): void {
    socket.on("error", () => undefined);
    const salt = randomBytes(16).toString("base64");
    const challenge = randomBytes(16).toString("base64");
    const authentication = this.options.password === undefined ? undefined : { salt, challenge };
    socket.send(
      JSON.stringify({
        op: 0,
        d: {
          obsWebSocketVersion: this.options.obsWebSocketVersion ?? "5.5.0",
          rpcVersion: 1,
          ...(authentication === undefined ? {} : { authentication }),
        },
      }),
    );
    let identified = false;
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { op: number; d: Record<string, unknown> };
      if (!identified) {
        if (frame.op !== 1) {
          socket.close(4007, "not identified");
          return;
        }
        if (this.options.password !== undefined) {
          const secret = createHash("sha256").update(this.options.password + salt).digest("base64");
          const expected = createHash("sha256").update(secret + challenge).digest("base64");
          if (frame.d["authentication"] !== expected) {
            socket.close(4009, "authentication failed");
            return;
          }
        }
        identified = true;
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
        socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      if (frame.op === 6) {
        this.request(socket, frame.d);
      }
    });
  }

  private request(socket: WebSocket, d: Record<string, unknown>): void {
    const requestType = String(d["requestType"]);
    const requestId = d["requestId"];
    const requestData = d["requestData"] as Record<string, unknown> | undefined;
    this.requests.push({ requestType, ...(requestData === undefined ? {} : { requestData }) });

    const reply = (status: { result: boolean; code: number; comment?: string }, responseData?: Record<string, unknown>): void => {
      socket.send(
        JSON.stringify({
          op: 7,
          d: { requestType, requestId, requestStatus: status, ...(responseData === undefined ? {} : { responseData }) },
        }),
      );
    };

    if (this.options.recording?.disconnectOn === requestType) {
      this.disconnectAll();
      return;
    }
    const override = this.options.failRequests?.[requestType];
    if (override === "hang") {
      return;
    }
    if (override !== undefined) {
      reply({ result: false, ...override });
      return;
    }
    const handler = this.handlers.get(requestType);
    if (handler === undefined) {
      reply({ result: false, code: 204, comment: `Unknown request type ${requestType}` });
      return;
    }
    const response = handler(requestData, this);
    if (response === undefined) {
      reply({ result: false, code: 600, comment: `${requestType} could not be completed` });
      return;
    }
    reply({ result: true, code: 100 }, response);
  }
}
