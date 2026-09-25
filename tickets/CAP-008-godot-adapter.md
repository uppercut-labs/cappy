# CAP-008 - Build the first production Godot adapter

## Goal

Prove Cappy against a real engine while preserving the engine-neutral core.

## Scope

- Reusable Godot 4.x addon.
- Protocol handshake/capabilities.
- Scenario registration API.
- Parameter validation hooks.
- Timeline event API.
- Freeform replay recording interface.
- Replay execution interface.
- Deterministic Godot demo fixture.

## Acceptance Criteria

- Demo registers at least one deterministic scenario and one parameter.
- Cappy can list and run the demo scenario.
- Demo emits semantic events visible in the Cappy timeline.
- Demo can record a freeform replay payload and replay it.
- Godot code contains no OBS/FFmpeg integration.
- Core TypeScript packages contain no Godot dependency.

## Dependencies

CAP-003, CAP-005.
