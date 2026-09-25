# CAP-016 - Accept the post-V1 increments with real tools on macOS and Windows

**Status:** Complete

## Goal

The promoted features are honestly verified end to end on both supported hosts.

## Scope

- Real Godot demo runs, with real OBS and FFmpeg:
  - a scenario capture with an event-anchored clip and still (for example the orb scenario's `BOUNCE` where `bounce` is 2, through `SETTLED`);
  - two replay captures of one freeform session, compared;
  - `cappy clean` with `--dry-run` and then for real, on the comparison, a capture, and failed leftovers.
- Per-host results in `docs/acceptance.md`.
- Documentation fixes the runs reveal.

## Acceptance Criteria

- On macOS, with real OBS, FFmpeg, and Godot, each of these passes: an anchored clip and still whose manifest windows match the demo's events; a comparison of two replay captures of one session that is `succeeded`, with its outputs and scores; and a clean dry run followed by a real clean that removes exactly the previewed items. The results are recorded in `docs/acceptance.md`.
- On Windows, the same runs pass and are recorded separately, never inferred from macOS.
- The full suite, with the real-tool switches, passes on both hosts.
- Any unverified host or tool limitation is stated explicitly.
- Planning artifacts stay synchronized with delivered behavior.

## Dependencies

CAP-015.

## Completion

Completed 2026-09-25 (America/Chicago). Evidence per host is in `docs/acceptance.md` ("Post-V1 increments").

- **macOS, with real OBS 32.2.2, FFmpeg 9.0.1, and windowed Godot 4.7.2, on the final code:**
  - An anchored clip ran from `BOUNCE` (`bounce` = 2) minus 0.5 s through `SETTLED` plus 0.5 s. An anchored still at `SETTLED` and a thumbnail at `LAUNCH` were produced, and the manifest windows and event IDs match the demo's timeline.
  - Two replay captures of one recorded session compared `succeeded`: triptych, frames, three worst-frame stills, SSIM 1.0, and five event types with 0 ms drift.
  - `clean --failed` and `clean <comparison> <capture>` each removed exactly what their dry runs previewed. The replayed session was kept, take 1 was retired, and `replay -t 1` exits 2 with `TAKE_EXISTS`.
  - A dry run on a project with no workspace created nothing.
- **Windows, run separately on Titan (Windows 11), with a portable OBS 32.2.2 (port 4456), FFmpeg 6.0, and headless Godot 4.7.2:** the same flow passed and is recorded on its own. Shorthands also work when typed at a PowerShell prompt.
- **Full suites with the real-tool switches:** macOS, `CAPPY_REAL_TOOLS=1 CAPPY_OBS_SMOKE=1 CAPPY_OBS_SCENE=Capture npx vitest run`: 267 passed. Windows, the same switches: 265 passed, 2 skipped (the POSIX-only signal tests).
- **Limitations stated explicitly in `docs/acceptance.md`:**
  - Both hosts' OBS scenes are color test sources, so the pipeline is proven rather than game pixels.
  - A `.cmd` FFmpeg wrapper cannot run `compare` in a UNC workspace (untested).
  - Linux remains outside acceptance.
- **Planning artifacts are synchronized.** SPEC 7.1 (registry lock), 11.7 (link protection, ID-shaped items, dry run creates nothing, active-session rule), 11.8 (UNC note in docs), and 13 (frame at or before a still's time) reflect delivered behavior, as do `docs/presets.md`, `docs/cli.md`, `docs/storage.md`, and `docs/acceptance.md`.

Found and fixed during acceptance, each with a regression test:

- Anchored stills and thumbnails, and comparison worst-frame stills, near the end of an OBS master got no frame. Recorders end their video a frame or two before the reported duration. Stills now take the frame at or before their time.
- These came from an independent review of CAP-011 to CAP-015:
  - `clean` walking or emptying linked or junctioned item directories and storage areas;
  - registry updates overwritten by concurrent commands (now an exclusive lock file, with stale-lock recovery);
  - option values starting with `-` rejected;
  - `clean --dry-run` creating folders;
  - active sessions protected more narrowly than SPEC 11.7.
- These surfaced on Windows:
  - a V1 adapter-server timeout that threw after close (the endpoint is now fixed at listen time);
  - concurrent workspace creation and Windows' transient `EPERM`/`EACCES`/`EBUSY` on registry reads and renames (creation now takes the lock, and those operations retry briefly).
- Test robustness under load: a global 30 s test timeout, an event-driven OBS-disconnect test, `obsMs` 30 s in the real-OBS smoke config, and a static pattern for the identical-masters comparison.

Validation (macOS, final code):

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 253 passed, 14 skipped (opt-in).
- `CAPPY_REAL_TOOLS=1 CAPPY_OBS_SMOKE=1 CAPPY_OBS_SCENE=Capture npx vitest run`: 267 passed.
- `npm run model:check`: valid.
- `git diff --check`: passed.

Validation (Windows):

- typecheck and lint passed.
- `npx vitest run`: 251 passed, 16 skipped.
- The OBS smoke file on its own: 2 passed.
- Every real tool: 265 passed, 2 skipped.
- The final `compare.test.ts` with real FFmpeg: 13 passed.
- `npm run model:check`: valid.

A macOS filesystem stall unrelated to Cappy interrupted this pass: a full-disk `bfs` search from another session hung on network mounts. The Mac was restarted, and the final macOS runs above were made afterwards.
