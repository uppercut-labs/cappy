# CAP-021 - Replay in slow motion or through another camera

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
