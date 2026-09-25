# CAP-003 - Build the versioned adapter protocol and simulator

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
