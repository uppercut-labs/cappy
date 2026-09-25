import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  type AdapterIdentity,
  CAPPY_VERSION,
  type CappyError,
  type Result,
  cappyError,
  err,
  missingCapabilities,
  ok,
} from "@cappy/core";
import WebSocket, { WebSocketServer } from "ws";
import { AdapterConnection, DEFAULT_HEARTBEAT, type HeartbeatOptions } from "./connection.js";
import { type ControllerMessage, MAX_MESSAGE_BYTES, SUPPORTED_PROTOCOL, helloSchema, negotiateVersion } from "./messages.js";

export const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"] as const;

/** Environment variables a launched game reads to find and authenticate to Cappy. */
export const ENDPOINT_ENV = "CAPPY_ENDPOINT";
export const TOKEN_ENV = "CAPPY_SESSION_TOKEN";

export interface AdapterServerOptions {
  /** Loopback host to bind. Defaults to 127.0.0.1; anything else is refused. */
  readonly host?: string;
  /** Port to bind; 0 picks a free port. */
  readonly port: number;
  /** Per-launch session token. Generated when omitted. */
  readonly token?: string;
  /** Capabilities the adapter must advertise for the handshake to succeed. */
  readonly requiredCapabilities?: readonly string[];
  readonly handshakeTimeoutMs?: number;
  readonly heartbeat?: HeartbeatOptions;
  readonly controller?: AdapterIdentity;
}

const OPERATION = "protocol.listen";

function send(socket: WebSocket, message: ControllerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function tokensMatch(expected: string, received: unknown): boolean {
  if (typeof received !== "string") {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newSessionToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Loopback WebSocket listener that accepts exactly one authenticated,
 * version-compatible adapter connection.
 */
export class AdapterServer {
  private outcome: Result<AdapterConnection> | undefined;
  private readonly waiters: ((result: Result<AdapterConnection>) => void)[] = [];

  /**
   * WebSocket URL the adapter connects to. Fixed while the server listens, so
   * it stays readable after `close()` (a late connect timeout still reports it).
   */
  readonly endpoint: string;
  readonly port: number;

  private constructor(
    private readonly server: WebSocketServer,
    readonly token: string,
    private readonly options: AdapterServerOptions,
  ) {
    const { address, family, port } = server.address() as AddressInfo;
    this.port = port;
    this.endpoint = family === "IPv6" ? `ws://[${address}]:${port}` : `ws://${address}:${port}`;
    server.on("connection", (socket) => {
      this.handshake(socket);
    });
  }

  static async listen(options: AdapterServerOptions): Promise<Result<AdapterServer>> {
    const host = options.host ?? "127.0.0.1";
    if (!(LOOPBACK_HOSTS as readonly string[]).includes(host)) {
      return err(
        cappyError("LISTENER_NOT_LOOPBACK", `refusing to listen on non-loopback host "${host}"`, OPERATION, {
          details: { host, allowed: [...LOOPBACK_HOSTS] },
          retryable: false,
        }),
      );
    }
    const server = new WebSocketServer({ host, port: options.port, maxPayload: MAX_MESSAGE_BYTES });
    const listening = await new Promise<Result<true>>((resolve) => {
      server.once("listening", () => resolve(ok(true)));
      server.once("error", (cause: NodeJS.ErrnoException) => {
        resolve(
          err(
            cappyError("LISTENER_FAILED", `could not listen on ${host}:${options.port}`, OPERATION, {
              details: { host, port: options.port, cause: cause.code ?? cause.message },
              retryable: cause.code === "EADDRINUSE",
            }),
          ),
        );
      });
    });
    if (!listening.ok) {
      server.close();
      return listening;
    }
    return ok(new AdapterServer(server, options.token ?? newSessionToken(), { ...options, host }));
  }


  /** Environment to pass to a launched game process. */
  launchEnvironment(): Record<string, string> {
    return { [ENDPOINT_ENV]: this.endpoint, [TOKEN_ENV]: this.token };
  }

  /** Wait for the adapter to connect and complete the handshake. */
  accept(timeoutMs: number): Promise<Result<AdapterConnection>> {
    if (this.outcome !== undefined) {
      return Promise.resolve(this.outcome);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve(
          err(
            cappyError("ADAPTER_CONNECT_TIMEOUT", `no game adapter connected within ${timeoutMs} ms`, OPERATION, {
              details: { endpoint: this.endpoint, timeoutMs },
              retryable: true,
            }),
          ),
        );
      }, timeoutMs);
      this.waiters.push((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  async close(): Promise<void> {
    if (this.outcome?.ok === true) {
      this.outcome.value.close();
    }
    for (const client of this.server.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private settle(result: Result<AdapterConnection>): void {
    if (this.outcome !== undefined) {
      return;
    }
    this.outcome = result;
    for (const waiter of this.waiters.splice(0)) {
      waiter(result);
    }
  }

  private fail(socket: WebSocket, error: CappyError): void {
    send(socket, { type: "reject", code: error.code, message: error.message });
    socket.close(1008, error.code);
    this.settle(err(error));
  }

  private handshake(socket: WebSocket): void {
    // Errors are always followed by "close"; an unhandled "error" would crash.
    socket.on("error", () => undefined);
    if (this.outcome !== undefined) {
      send(socket, { type: "reject", code: "OPERATION_BUSY", message: "Cappy already has an adapter connection" });
      socket.close(1013, "busy");
      return;
    }
    const timer = setTimeout(() => socket.terminate(), this.options.handshakeTimeoutMs ?? 10_000);

    socket.once("message", (data, isBinary) => {
      clearTimeout(timer);
      let raw: unknown;
      try {
        raw = isBinary ? undefined : JSON.parse(data.toString());
      } catch {
        raw = undefined;
      }
      const candidate = raw as { type?: unknown; token?: unknown } | undefined;

      // Connections that do not present this launch's token are strays, not
      // our game: turn them away and keep waiting.
      if (candidate?.type !== "hello" || !tokensMatch(this.token, candidate.token)) {
        send(socket, { type: "reject", code: "PROTOCOL_UNAUTHENTICATED", message: "unknown session token" });
        socket.close(1008, "unauthenticated");
        return;
      }

      const hello = helloSchema.safeParse(raw);
      if (!hello.success) {
        const issue = hello.error.issues[0];
        this.fail(
          socket,
          cappyError("PROTOCOL_INVALID_MESSAGE", `invalid hello: ${issue?.message ?? "schema violation"}`, OPERATION, {
            details: { path: issue?.path.join(".") ?? "" },
          }),
        );
        return;
      }

      const version = negotiateVersion(hello.data.protocol);
      if (version === undefined) {
        this.fail(
          socket,
          cappyError(
            "PROTOCOL_VERSION_INCOMPATIBLE",
            `adapter speaks protocol ${hello.data.protocol.min}-${hello.data.protocol.max}; Cappy supports ${SUPPORTED_PROTOCOL.min}-${SUPPORTED_PROTOCOL.max}`,
            OPERATION,
            { details: { adapter: hello.data.protocol, supported: SUPPORTED_PROTOCOL }, retryable: false },
          ),
        );
        return;
      }

      const missing = missingCapabilities(hello.data.capabilities, this.options.requiredCapabilities ?? []);
      if (missing.length > 0) {
        this.fail(
          socket,
          cappyError("CAPABILITY_MISSING", `adapter lacks required capabilities: ${missing.join(", ")}`, OPERATION, {
            details: { missing, advertised: hello.data.capabilities },
            retryable: false,
          }),
        );
        return;
      }

      send(socket, {
        type: "welcome",
        protocol: version,
        controller: this.options.controller ?? { name: "cappy", version: CAPPY_VERSION },
      });
      const connection = new AdapterConnection(
        socket,
        {
          protocolVersion: version,
          adapter: hello.data.adapter,
          game: hello.data.game,
          ...(hello.data.build === undefined ? {} : { build: hello.data.build }),
          capabilities: hello.data.capabilities,
        },
        this.options.heartbeat ?? DEFAULT_HEARTBEAT,
      );
      this.settle(ok(connection));
    });
  }
}
