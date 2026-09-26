# CAP-023 - Accept the second post-V1 batch on macOS and Windows

## Goal

The second batch is verified end to end with real OBS, FFmpeg, and Godot on both original hosts.

## Scope

On each of macOS and Windows (Titan, portable OBS), with the Godot demo:

- an `"every"` clip preset over `BOUNCE` events;
- `compare-builds` between the base build and the demo variant, with gates;
- timeline export of a capture as WebVTT, checked with FFmpeg;
- a slow-motion, close-camera replay capture compared against a normal-speed replay (presentation warning).

Record the per-host results in `docs/acceptance.md`.

## Acceptance Criteria

- On macOS with real tools, each of the following passes, and the evidence is recorded:
  - one clip per bounce, with each window matching its event;
  - `compare-builds` producing two captures and a comparison that regresses under `--min-ssim 0.999` because the variant renders differently, and succeeds without gates;
  - a VTT export that FFmpeg reads;
  - a half-speed replay whose timeline is about twice as long, with the same events.
- On Windows, the same, recorded separately and never inferred.
- The full suites with the real-tool switches pass on both hosts.
- Planning artifacts stay synchronized with delivered behavior.

## Dependencies

CAP-022.
