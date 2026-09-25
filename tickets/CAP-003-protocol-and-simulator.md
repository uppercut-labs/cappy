# CAP-003 - Build the versioned adapter protocol and simulator

**Status:** Complete

## Goal

Prove the engine-neutral controller/adapter boundary before integrating a real game engine.

## Scope

- Loopback WebSocket server/client contract.
- Version handshake.
- Capability negotiation.
- Scenario registration.
- Scenario/freeform/replay operation messages.
- Timeline events, completion/failure, heartbeat.
- Runtime schema validation.
- Deterministic adapter simulator fixture.

## Acceptance Criteria

- Incompatible versions fail before operations start.
- Malformed/out-of-state messages create structured protocol failures.
- Unknown non-required capabilities do not break negotiation.
- Simulator can execute scenario, freeform-record, and replay flows.
- Listener binds to loopback by default.

## Dependencies

CAP-001, CAP-002.

## Completion

Completed 2026-09-25 (America/Chicago).

- Incompatible versions fail before operations start: a simulator speaking protocol 2-3 is rejected at handshake and `accept()` returns `PROTOCOL_VERSION_INCOMPATIBLE` with both ranges (`packages/protocol/test/protocol.test.ts`, "handshake").
- Malformed/out-of-state messages create structured protocol failures: malformed JSON and schema violations fail the active operation with `PROTOCOL_INVALID_MESSAGE`; `completed` before `started` and messages for another operation fail it with `PROTOCOL_OUT_OF_STATE`; idle violations are recorded ("protocol violations").
- Unknown non-required capabilities do not break negotiation: unknown capabilities and unknown hello fields are kept or ignored; only project-required capabilities fail with `CAPABILITY_MISSING`.
- Simulator can execute scenario, freeform-record, and replay flows: `@cappy/adapter-simulator` runs `boss_intro` with an ordered timeline, records a freeform session with an inline replay payload, and replays it with an identical event timeline ("scenario flow", "freeform and replay flows").
- Listener binds to loopback by default: the server binds `127.0.0.1` and refuses `0.0.0.0` with `LISTENER_NOT_LOOPBACK` ("listener").

Also covered: session-token isolation, single-connection busy rejection, cancellation (never success), ready timeouts, disconnects, and heartbeat-detected hangs. Adapter reference: `docs/protocol.md`.

Validation:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 6 files, 93 tests passed.
- `git diff --check`: passed.
