# CAP-021 - Replay in slow motion or through another camera

**Status:** Complete

## Goal

A stored session can be re-captured at another speed or from another camera, with the timeline still aligned to the video (SPEC sections 8, 9, 14; ADR-022).

## Scope

- The `time_scale` capability.
- Presentation keys `timeScale` (0.1 to 4) and `camera`, with the capabilities they require derived and checked before recording.
- An optional `presentation` on replay requests (protocol, `docs/protocol.md`, and simulator).
- `identity.presentation` in manifests.
- A comparison warning when presentations differ.
- The Godot adapter passes presentation to replay handlers.
- The Godot demo implements `timeScale` (`Engine.time_scale`) and a `close` camera, reports presented time, and puts `simT` in payloads.
- Docs and tests.

## Acceptance Criteria

- A preset with `presentation: {timeScale: 0.5}` requires `time_scale`. An adapter without it fails with `CAPABILITY_MISSING` before recording, and so does `camera` without `alternate_cameras`. An invalid `timeScale` fails config validation.
- `replay <session> --preset slowmo` sends the presentation to the adapter (simulator) and records it in the manifest. The simulator reports presented times, so a 0.5 time scale doubles event times, and anchors resolve against them.
- With `CAPPY_REAL_TOOLS=1` and headless Godot, a demo replay at `timeScale` 0.5 reproduces the recorded events with the same count and order and the same `simT`. Their `t` values are about double the normal-speed replay's. The `close` camera is accepted, and an unknown camera fails the operation.
- `compare` warns when two captures' presentations differ.
- `docs/protocol.md`, `adapters/godot/README.md`, and `docs/presets.md` document presentation for replays. Repository-standard validation passes.

## Dependencies

None.

## Completion

Completed 2026-09-25 (America/Chicago).

- A preset with `presentation: {timeScale: 0.5, camera: "close"}` requires `alternate_cameras` and `time_scale`, now derived by `presentationCapabilities`. An adapter without them fails with `CAPABILITY_MISSING` before recording, for both `run` and `replay`, and OBS never receives `StartRecord`. Replay captures now also check the preset's `requiredCapabilities`, which they did not before. `timeScale: 10` and an empty `camera` fail config validation (exit 3) at `presets.<name>.presentation.*`. Covered by `packages/cli/test/presentation.test.ts`.
- `replay <session> -p slowmo` sends the presentation in `prepare_replay`, an additive protocol field. The manifest records `identity.presentation`. The simulator reports presented times, so every event's `t` doubles relative to the stored timeline (shifted by the offset), and each payload carries `simT` equal to the stored time. An anchored still at `JUMP` resolves to the presented `JUMP` time.
- An unknown camera (`drone`) fails the operation with `ADAPTER_OPERATION_FAILED` and `adapterCode: UNKNOWN_CAMERA`, in both the simulator and Godot.
- With `CAPPY_REAL_TOOLS=1` and headless Godot 4.7.2, a recorded demo session replayed with the half-speed, close-camera preset reproduces the recorded events in the same order and count, with `simT` equal to the recorded times and `t` about double. The demo now advertises `alternate_cameras` and `time_scale` through the addon's new `declare_capabilities()`. The addon converts `event()` times to presented time and adds `simT`. `elapsed_msec()` returns simulation time.
- `compare` warns ("…different presentation…") when a normal-speed replay capture is compared with a slow-motion one. This is the CAP-018 scope item delivered here.
- Docs: `docs/protocol.md` (presented time, and a Presentation section), `adapters/godot/README.md` (a "Presentation: slow motion and cameras" section and the demo), and `docs/presets.md` (a Presentation section).

Validation (macOS):

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 284 passed, 18 skipped.
- `CAPPY_REAL_TOOLS=1 npx vitest run`: 300 passed, 2 skipped (the OBS smoke tests).
- `git diff --check`: passed.
