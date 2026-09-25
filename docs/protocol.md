# Cappy Adapter Protocol

Version 1. This is the contract a game adapter implements to be driven by Cappy. The schemas in `packages/protocol/src/messages.ts` are authoritative; this page explains them.

## Transport

- Cappy listens on a loopback WebSocket (`127.0.0.1` by default). It refuses to bind anything else.
- The game connects as a client. When Cappy launches the game it sets two environment variables:
  - `CAPPY_ENDPOINT`: the WebSocket URL, for example `ws://127.0.0.1:47100`.
  - `CAPPY_SESSION_TOKEN`: a random per-launch token that the adapter echoes in its hello.
- Every message is one UTF-8 JSON text frame with a `type` field. Binary frames are protocol violations.
- A message may not exceed 4 MiB.

## Handshake

The adapter's first message is `hello`:

```json
{
  "type": "hello",
  "protocol": { "min": 1, "max": 1 },
  "token": "<CAPPY_SESSION_TOKEN>",
  "adapter": { "name": "cappy-godot", "version": "0.1.0" },
  "game": { "id": "fantasy-party", "name": "Fantasy Party" },
  "build": "optional build identity",
  "capabilities": ["scenarios", "freeform_recording", "replay"]
}
```

Cappy replies with one of:

- `{ "type": "welcome", "protocol": 1, "controller": { "name": "cappy", "version": "0.1.0" } }`: negotiation succeeded, at the highest shared version.
- `{ "type": "reject", "code": "...", "message": "..." }`, followed by a close. Codes include `PROTOCOL_UNAUTHENTICATED` (wrong token), `PROTOCOL_VERSION_INCOMPATIBLE`, `PROTOCOL_INVALID_MESSAGE`, `CAPABILITY_MISSING`, and `OPERATION_BUSY` (another adapter is already connected).

Unknown hello fields and unknown capability names are accepted, so newer adapters work with older controllers. A missing capability fails the handshake only when the project requires it.

After `welcome`, the adapter should send its scenario registry (`scenarios`).

Cappy may send its first request immediately after `welcome`, often in the same network read. Adapters must keep reading and processing messages from the moment the socket opens; a message that arrives right behind the welcome must not be dropped.

## Operations

At most one operation is active at a time. Cappy creates an operation ID (`op`), and every message about that operation carries it.

| Operation | Cappy sends | Adapter replies |
| --- | --- | --- |
| Authored scenario | `prepare_scenario` {op, scenario, parameters, presentation?} | `ready`, then after `start`: `started`, `event`*, `completed` or `failed` |
| Freeform recording | `record_start` {op} | `started`, `event`*, then after `stop`: `completed` with `replay` |
| Replay | `prepare_replay` {op, replay} | `ready`, then after `start`: `started`, `event`*, `completed` or `failed` |

- `stop` {op} asks a running freeform recording or replay to finish.
- `cancel` {op} aborts the operation. The adapter should tear down and may stay silent.
- `failed` {op, code, message} reports adapter-side failure at any point, for example `SCENARIO_NOT_FOUND`, `INVALID_PARAMETERS`, or `REPLAY_UNSUPPORTED`.

### Events

```json
{ "type": "event", "op": "op_…", "t": 350, "event": "SPELL_CAST", "durationMs": 120, "payload": { "spell": "fireball" } }
```

`t` is operation-relative monotonic milliseconds, never wall-clock time. Cappy stamps each event with its receipt order (`seq`) and the operation's correlation ID.

### Replay payloads

Replay payloads belong to the adapter. Cappy stores and returns them without interpreting them.

- Inline: `{ "kind": "inline", "encoding": "base64", "data": "…", "sha256": "…", "format": "…" }`, up to 1 MiB decoded. Cappy verifies the SHA-256.
- File: `{ "kind": "file", "path": "…", "sha256": "…", "bytes": 123, "format": "…" }`, for larger payloads. Adapter-supplied paths are untrusted and never grant deletion authority.

## Scenario registry

```json
{
  "type": "scenarios",
  "scenarios": [
    {
      "id": "boss_intro",
      "name": "Boss intro",
      "parameters": { "difficulty": { "type": "integer", "minimum": 1, "maximum": 3, "default": 2 } },
      "requiredCapabilities": ["scenarios"]
    }
  ]
}
```

Parameter types are `string`, `number`, `integer`, and `boolean`, with optional `required`, `default`, `enum`, `minimum`, and `maximum`. Cappy may request the registry again at any time with `list_scenarios`.

## Liveness

Cappy sends `{ "type": "ping", "nonce": "…" }` every 2 seconds. The adapter must answer `{ "type": "pong", "nonce": "…" }`. If no pong arrives for 6 seconds, the adapter is treated as unresponsive: the active operation fails and the connection is dropped.

## Failures

Malformed JSON, schema violations, and messages that do not fit the current operation state fail the active operation with a structured error (`PROTOCOL_INVALID_MESSAGE` or `PROTOCOL_OUT_OF_STATE`). Cappy also tells the adapter with `{ "type": "error", "code", "message", "op"? }`. A `completed` before `started` can never count as success. A disconnect fails the active operation with `ADAPTER_DISCONNECTED`.
