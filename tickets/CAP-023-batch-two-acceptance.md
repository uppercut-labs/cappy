# CAP-023 - Accept the second post-V1 batch on macOS and Windows

**Status:** Complete

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

## Completion

Completed 2026-09-25 (America/Chicago). Evidence per host is in `docs/acceptance.md` ("Second post-V1 batch").

- **macOS, with real OBS 32.2.2, FFmpeg 9.0.1, and windowed Godot 4.7.2.** The owner granted OBS Screen Recording and approved a separate "Cappy Game" scene; "Capture" was not changed.
  - The `bounces` preset produced one clip per `BOUNCE` (four), each window matching its event.
  - `compare-builds orb_launch base b -pa power=4 --min-ssim 0.999` produced two captures and a comparison that regressed (`failedGates: ["minSsim"]`, mean SSIM 0.9971), because the variant draws a larger green orb. The worst-frame stills show exactly that. Without gates it succeeds.
  - A WebVTT export of the capture was read by FFmpeg (10 of 10 cues).
  - A half-speed, close-camera replay has the same 13 events over twice the span, with matching `simT`, and comparing it with the normal-speed replay warns about the presentation.
- **Windows, run separately on Titan with the portable OBS and headless Godot.** The same flow passed and is recorded separately. Titan's OBS scene is a color source, so `compare-builds` there proves the pipeline (builds `0.1.0` and `0.1.0+b`, `succeeded`), and the visual-regression check is recorded as verified on macOS only.
- **Full suites with the real-tool switches:**
  - macOS: 302 passed (every real tool, including OBS); `npm test`: 284 passed, 18 skipped.
  - Windows: 300 passed, 2 skipped (the POSIX-only signal tests); `npx vitest run`: 282 passed, 20 skipped.
  - Typecheck, lint, and `npm run model:check` passed on both hosts.
- **Planning artifacts** match delivered behavior. `docs/acceptance.md` and `docs/getting-started.md` (how to capture the game window on macOS) were updated. No code changed in this ticket.

Found during acceptance, outside Cappy:

- OBS 32.2.2 on macOS crashed when asked over WebSocket for a Screen Capture source's display list (`GetInputPropertiesListPropertyItems` for `display_uuid`).
- macOS application capture of Godot produced no frames of the demo window, so display capture cropped to the window is used.
- A hard-stopped OBS waits on its crash prompt at the next start until its `.sentinel` markers are cleared.
