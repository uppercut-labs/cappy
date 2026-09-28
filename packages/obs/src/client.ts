import { createHash, randomUUID } from "node:crypto";
import { type CappyError, type Result, cappyError, err, ok } from "@uppercut-labs/cappy-internal-core";
import WebSocket from "ws";

/*
 * Minimal OBS WebSocket v5 client. Cappy controls recorder state and reads
 * scene information; it never creates, deletes, or rewrites scenes, sources,
 * or profiles (ADR-011).
 */

export const OBS_RPC_VERSION = 1;

/** OBS WebSocket opcodes. */
const Op = { Hello: 0, Identify: 1, Identified: 2, Event: 5, Request: 6, RequestResponse: 7 } as const;

/** Event subscription bit for output (recording) events. */
export const OBS_EVENTS_OUTPUTS = 1 << 6;

const CLOSE_AUTHENTICATION_FAILED = 4009;
const CLOSE_UNSUPPORTED_RPC_VERSION = 4010;

export interface ObsConnectOptions {
  readonly url: string;
  /** Resolved from the environment by the caller; never logged or returned. */
  readonly password?: string;
  readonly timeoutMs: number;
  readonly eventSubscriptions?: number;
}

export interface ObsEvent {
  readonly eventType: string;
  readonly eventData?: Record<string, unknown>;
}

interface Frame {
  op: number;
  d: Record<string, unknown>;
}

const OPERATION = "obs";

function obsError(code: "OBS_UNREACHABLE" | "OBS_AUTH_FAILED" | "OBS_REQUEST_FAILED", message: string, details?: Record<string, unknown>): CappyError {
  return cappyError(code, message, OPERATION, {
    ...(details === undefined ? {} : { details }),
    retryable: code !== "OBS_AUTH_FAILED",
  });
}

/** OBS v5 authentication string: base64(sha256(base64(sha256(password + salt)) + challenge)). */
export function obsAuthentication(password: string, salt: string, challenge: string): string {
  const secret = createHash("sha256").update(password + salt).digest("base64");
  return createHash("sha256").update(secret + challenge).digest("base64");
}

export class ObsClient {
  private readonly pending = new Map<string, (frame: Frame["d"]) => void>();
  private readonly listeners = new Set<(event: ObsEvent) => void>();
  private closeReason: CappyError | undefined;
  private readonly closeWaiters = new Set<(reason: CappyError) => void>();

  private constructor(
    private readonly socket: WebSocket,
    readonly obsWebSocketVersion: string,
    readonly rpcVersion: number,
  ) {
    socket.on("message", (data) => this.receive(data.toString()));
    socket.on("close", (code) => {
      this.closeReason = obsError("OBS_UNREACHABLE", `OBS closed the connection (${code})`, { closeCode: code });
      for (const waiter of this.closeWaiters) {
        waiter(this.closeReason);
      }
      for (const resolve of this.pending.values()) {
        resolve({ requestStatus: { result: false, code: -1, comment: "connection closed" } });
      }
      this.pending.clear();
    });
  }

  /** Connect and identify, authenticating when OBS requires it. */
  static async connect(options: ObsConnectOptions): Promise<Result<ObsClient>> {
    const socket = new WebSocket(options.url, "obswebsocket.json");
    // Errors are always followed by "close"; an unhandled "error" would crash.
    socket.on("error", () => undefined);
    const frames: Frame[] = [];
    let wake: (() => void) | undefined;
    socket.on("message", (data) => {
      try {
        frames.push(JSON.parse(data.toString()) as Frame);
      } catch {
        // Ignored: a non-JSON frame fails the handshake below by timing out.
      }
      wake?.();
    });

    let closeCode: number | undefined;
    const closed = new Promise<void>((resolve) => {
      socket.once("close", (code) => {
        closeCode = code;
        resolve();
      });
    });
    const deadline = Date.now() + options.timeoutMs;
    const nextFrame = async (op: number): Promise<Frame | undefined> => {
      for (;;) {
        const index = frames.findIndex((frame) => frame.op === op);
        if (index >= 0) {
          return frames.splice(index, 1)[0];
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0 || closeCode !== undefined || socket.readyState >= WebSocket.CLOSING) {
          return undefined;
        }
        await Promise.race([
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
          closed,
          new Promise<void>((resolve) => setTimeout(resolve, remaining).unref()),
        ]);
      }
    };

    const fail = (error: CappyError): Result<ObsClient> => {
      socket.terminate();
      return err(error);
    };

    const hello = await nextFrame(Op.Hello);
    if (hello === undefined) {
      return fail(obsError("OBS_UNREACHABLE", `OBS WebSocket is not reachable at ${options.url}`, { url: options.url, timeoutMs: options.timeoutMs }));
    }
    const auth = hello.d["authentication"] as { challenge: string; salt: string } | undefined;
    if (auth !== undefined && (options.password === undefined || options.password === "")) {
      return fail(obsError("OBS_AUTH_FAILED", "OBS requires a password; set obs.passwordEnv and export that variable", { url: options.url }));
    }
    socket.send(
      JSON.stringify({
        op: Op.Identify,
        d: {
          rpcVersion: OBS_RPC_VERSION,
          eventSubscriptions: options.eventSubscriptions ?? OBS_EVENTS_OUTPUTS,
          ...(auth === undefined || options.password === undefined
            ? {}
            : { authentication: obsAuthentication(options.password, auth.salt, auth.challenge) }),
        },
      }),
    );
    const identified = await nextFrame(Op.Identified);
    if (identified === undefined) {
      if (closeCode === CLOSE_AUTHENTICATION_FAILED) {
        return fail(obsError("OBS_AUTH_FAILED", "OBS rejected the WebSocket password", { url: options.url }));
      }
      if (closeCode === CLOSE_UNSUPPORTED_RPC_VERSION) {
        return fail(obsError("OBS_UNREACHABLE", "OBS does not support WebSocket RPC version 1", { url: options.url }));
      }
      return fail(obsError("OBS_UNREACHABLE", "OBS did not complete identification", { url: options.url, closeCode }));
    }
    socket.removeAllListeners("message");
    const client = new ObsClient(
      socket,
      String(hello.d["obsWebSocketVersion"] ?? "unknown"),
      Number(identified.d["negotiatedRpcVersion"] ?? OBS_RPC_VERSION),
    );
    // Frames that arrived between Identified and handing the socket over.
    for (const frame of frames) {
      client.dispatch(frame);
    }
    return ok(client);
  }

  /** Send a request and wait for its response. */
  async request<T extends Record<string, unknown> = Record<string, unknown>>(
    requestType: string,
    requestData?: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<Result<T>> {
    if (this.closeReason !== undefined) {
      return err(this.closeReason);
    }
    const requestId = randomUUID();
    const response = new Promise<Frame["d"] | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(undefined);
      }, timeoutMs);
      this.pending.set(requestId, (d) => {
        clearTimeout(timer);
        resolve(d);
      });
    });
    this.socket.send(
      JSON.stringify({ op: Op.Request, d: { requestType, requestId, ...(requestData === undefined ? {} : { requestData }) } }),
    );
    const d = await response;
    if (d === undefined) {
      return err(obsError("OBS_REQUEST_FAILED", `OBS did not answer ${requestType} within ${timeoutMs} ms`, { requestType }));
    }
    const status = d["requestStatus"] as { result: boolean; code: number; comment?: string } | undefined;
    if (status?.result !== true) {
      return err(
        obsError("OBS_REQUEST_FAILED", `OBS ${requestType} failed${status?.comment === undefined ? "" : `: ${status.comment}`}`, {
          requestType,
          obsCode: status?.code,
        }),
      );
    }
    return ok((d["responseData"] ?? {}) as T);
  }

  onEvent(listener: (event: ObsEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves when the OBS connection drops. */
  get disconnected(): Promise<CappyError> {
    if (this.closeReason !== undefined) {
      return Promise.resolve(this.closeReason);
    }
    return new Promise((resolve) => this.closeWaiters.add(resolve));
  }

  close(): void {
    this.socket.close(1000);
  }

  private receive(text: string): void {
    try {
      this.dispatch(JSON.parse(text) as Frame);
    } catch {
      // Non-JSON frames are not part of the OBS protocol; ignore them.
    }
  }

  private dispatch(frame: Frame): void {
    if (frame.op === Op.RequestResponse) {
      const resolve = this.pending.get(String(frame.d["requestId"]));
      if (resolve !== undefined) {
        this.pending.delete(String(frame.d["requestId"]));
        resolve(frame.d);
      }
    } else if (frame.op === Op.Event) {
      const event: ObsEvent = {
        eventType: String(frame.d["eventType"]),
        ...(frame.d["eventData"] === undefined ? {} : { eventData: frame.d["eventData"] as Record<string, unknown> }),
      };
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }
}
