# CAP-005 - Implement freeform sessions and opaque replay storage

**Status:** Complete

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

## Completion

Completed 2026-09-25 (America/Chicago).

- A simulator freeform session produces a stored replayable session: `cappy record` launches the simulator, records, and persists `session.json` (schema-valid, `completed`), `replay.bin` (SHA-256 and size verified), and `timeline.json` (`packages/cli/test/sessions.test.ts`, "cappy record").
- Cappy never parses the replay payload as game state: arbitrary binary bytes, including invalid UTF-8, are stored byte-for-byte through both inline and file handoff; file handoffs are copied, never moved or deleted ("opaque replay payloads").
- Replay returns the stored payload to the adapter: the bytes the simulator receives in `prepare_replay` are identical to what it recorded, and the replayed timeline matches the recording.
- Capability mismatch fails before replay starts: a missing `deterministic_replay` fails with `CAPABILITY_MISSING`, and the adapter receives no payload; a different adapter fails with `REPLAY_INCOMPATIBLE`; a tampered payload fails with `REPLAY_PAYLOAD_INVALID` before the game is launched; a build difference warns ("replay compatibility").
- Cancellation yields cancelled session metadata, never success: an in-process cancel and a real SIGINT to the `cappy` binary both exit 130 and leave `status: "cancelled"` with no replay; the cancelled session is not replayable.

Also fixed: the simulator could drop a request that arrived in the same packet as the welcome. `docs/protocol.md` now tells adapter authors to handle this case.

Validation:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 8 files, 135 tests passed, 1 skipped (opt-in real-FFmpeg smoke test); the suite was run 3 times with no flakes.
- `git diff --check`: passed.
