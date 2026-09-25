# CAP-006 - Integrate OBS recording as the primary capture backend

**Status:** Complete

## Goal

Produce verified master recordings synchronized with Cappy operations.

## Scope

- OBS WebSocket client.
- Authentication via safe local secret input.
- Version/state inspection.
- Configured-scene validation.
- Start/stop recording and state verification.
- Master output resolution.
- Fake OBS backend for automated tests.
- Integrate master capture into `cappy run` and optional `cappy record --capture`.

## Acceptance Criteria

- Cappy never reports capture success merely because a start/stop request was sent.
- Authentication, scene, start, stop, timeout, and disconnect failures are tested.
- Cappy does not create/delete OBS scenes or sources.
- Verified master is registered as managed with size/hash metadata.
- Simulator scenario can drive a full fake-OBS capture job.

## Dependencies

CAP-003, CAP-004, CAP-005.

## Completion

Completed 2026-09-25 (America/Chicago).

- Cappy never reports capture success merely because a start/stop request was sent: `ObsRecorder` polls `GetRecordStatus` for confirmed output state, and `verifyMaster` checks the file on disk. An accepted StartRecord whose output never activates, an accepted StopRecord that never deactivates, and a stop that writes no file all fail (`packages/obs/test/recorder.test.ts`; `packages/cli/test/run.test.ts`).
- Authentication, scene, start, stop, timeout, and disconnect failures are tested: wrong or missing password (`OBS_AUTH_FAILED`, password never echoed), missing scene (`OBS_SCENE_MISSING`, before the game launches), refused and hung start (`OBS_START_FAILED`), refused and unconfirmed stop (`OBS_STOP_FAILED`), and OBS disconnecting mid-scenario (`OBS_UNREACHABLE`).
- Cappy does not create/delete OBS scenes or sources: the recorder enforces a request allowlist, and tests assert every request the fake OBS received is on it; scene switching happens only with `obs.switchScene`.
- Verified master is registered as managed with size/hash metadata: the master is moved to `captures/<id>/master.mkv` (or `sessions/<id>/master.mkv`) and appears in the workspace registry with matching SHA-256 and bytes.
- Simulator scenario can drive a full fake-OBS capture job: `cappy run boss_intro --param difficulty=3 --preset trailer` runs preflight, ready, recording, events, completion, confirmed stop, and verified master with the simulator as a real game process; `cappy record --capture` records a replayable session plus a master.

Also covered: cancellation stops the OBS recording Cappy started and ends `cancelled` (exit 130), and scenario parameters are validated against the adapter's schema. Until CAP-007, `run` stops at job state `processing` with a warning, because derivatives and the manifest are not produced yet.

Validation:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 11 files, 165 tests passed, 1 skipped (opt-in real-FFmpeg smoke test); the suite was run twice with no flakes.
- `git diff --check`: passed.
- Not exercised: real OBS (not installed on this Mac; covered by CAP-010).
