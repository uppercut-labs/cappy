# CAP-009 - Complete scenario and replay capture vertical slices

**Status:** Complete

## Goal

Exercise the intended product workflow end to end with the Godot fixture.

## Scope

- Full `cappy run <scenario>` state machine.
- Full `cappy replay <session-id>` capture path.
- Take allocation.
- Timeline/master synchronization.
- Manifest publication.
- Cancellation/crash reconciliation.
- End-to-end integration harness.

## Acceptance Criteria

- Scenario -> ready -> OBS -> events -> completion -> master -> derivatives -> manifest succeeds.
- Stored freeform session can later replay through the same capture pipeline.
- Existing successful takes are not overwritten.
- Failed/cancelled jobs remain clearly non-successful.
- Correlation IDs link logs, session, capture, and manifest.

## Dependencies

CAP-006, CAP-007, CAP-008.

## Completion

Completed 2026-09-25 (America/Chicago).

- Scenario -> ready -> OBS -> events -> completion -> master -> derivatives -> manifest succeeds: the shared capture job (`packages/cli/src/capture-job.ts`) drives `cappy run` end to end with the simulator (`tests/integration/capture.test.ts`, `packages/cli/test/processing.test.ts`) and with real headless Godot 4.7.2 (`tests/integration/godot.test.ts`, opt-in).
- Stored freeform session can later replay through the same capture pipeline: `cappy replay <session-id>` now captures by default, producing a master, derivatives, and a `succeeded` manifest with a replay source. This runs with the simulator and with Godot, where the replayed game events, shifted back by the sync offset, match the recording exactly.
- Existing successful takes are not overwritten: `--take 1` a second time fails with `TAKE_EXISTS` before OBS is started, and the first master's hash is unchanged; explicit take 5 is followed by take 6; failed jobs do not consume takes.
- Failed/cancelled jobs remain clearly non-successful: failed and cancelled scenario and replay captures leave `failed`/`cancelled` manifests and sessions. A session orphaned by a crashed command (dead lock PID) is reconciled to `failed` by the next command, with a warning, and is never promoted.
- Correlation IDs link logs, session, capture, and manifest: the JSON result's `correlationId` equals the manifest's `identity.correlationId`, the session's `correlationId`, every timeline event's `correlationId`, and every entry in `logs/<correlationId>.jsonl`, which also names the capture.

Timeline/master synchronization: manifests record `timing.sync` (reference `obs_recording_confirmed`, `adapterOffsetMs`, `uncertaintyMs`), with Cappy lifecycle events and adapter events on the master's clock.

Validation:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 16 files, 185 tests passed, 8 skipped (opt-in real-tool tests); run twice with no flakes.
- `CAPPY_REAL_TOOLS=1 npx vitest run`: 193 tests passed, including 5 real headless Godot 4.7.2 tests and the real FFmpeg media tests.
- `git diff --check`: passed.
- Not exercised: real OBS (not installed on this Mac) and Windows (CAP-010).
