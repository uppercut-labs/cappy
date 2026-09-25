# CAP-005 - Implement freeform sessions and opaque replay storage

## Goal

Make spontaneous gameplay durable without Cappy interpreting game-specific replay data.

## Scope

- `cappy record` without OBS capture.
- Session lifecycle and persistence.
- Adapter replay-payload handoff.
- Opaque payload storage/reference and hashing.
- `cappy replay <session-id> --no-capture`.
- Capability/build compatibility checks.

## Acceptance Criteria

- A simulator freeform session produces a stored replayable session.
- Cappy never parses the replay payload as game state.
- Replay returns the stored payload to the adapter.
- Capability mismatch fails before replay starts.
- Cancellation yields cancelled session metadata, never success.

## Dependencies

CAP-002, CAP-003, CAP-004.
