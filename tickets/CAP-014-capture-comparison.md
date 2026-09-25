# CAP-014 - Compare two captures of the same source

**Status:** Complete

## Goal

A developer can compare two captures of the same moment, typically replay captures of one session made with two builds, and get an aligned visual result and an optional gate (SPEC section 11.8; ADR-015).

## Scope

- `cappy compare <capture-a> <capture-b> [--min-ssim <score>]`, with shorthand `-ms`.
- Eligibility checks: distinct IDs, the captures exist, both succeeded, same source, masters match their hashes. A warning for the same or an unknown build.
- Alignment on `SCENARIO_STARTED` or `REPLAY_STARTED` over the shorter operation span. Normalization of B to A's size and frame rate.
- The FFmpeg triptych (A | B | amplified difference). Per-frame SSIM and PSNR in `frames.json`, with summary scores.
- The `comparisons/` storage area, `cmp_…` IDs, and a comparison manifest (`comparisonVersion: 1`) with statuses `succeeded`, `regressed`, and `failed`.
- A run lock and a command log.
- The `--min-ssim` gate on mean SSIM, with `COMPARISON_REGRESSED`.
- `cappy clean` support for comparisons: by ID, and in `--failed`, `--all`, and `--older-than`.
- Human and JSON rendering. Docs.

Worst-frame stills and the timeline diff are CAP-015.

## Acceptance Criteria

- Two succeeded captures of the same source produce `comparisons/<cmp-id>/triptych.mp4`, `frames.json`, and `manifest.json`. The manifest records alignment, normalization, SSIM and PSNR summaries, the capture identities, and artifact hashes.
- With `CAPPY_REAL_TOOLS=1`, identical masters score a mean SSIM of at least 0.999, and a master with a changed region scores lower, with the minimum located in the changed span.
- Different sources (`COMPARE_INCOMPATIBLE`), a non-succeeded capture (`COMPARE_INCOMPATIBLE`), the same capture twice (`USAGE_INVALID`), an unknown ID (`CAPTURE_NOT_FOUND`), and a master that no longer matches its manifest (`COMPARE_INPUT_INVALID`) are refused before any media work.
- Alignment uses each capture's operation start event, and the span is the shorter operation. A different resolution or frame rate is normalized to A and recorded.
- Below `--min-ssim`, the comparison is recorded as `regressed`, keeps every output, and exits 1 with `COMPARISON_REGRESSED`. Without the flag, a completed comparison exits 0.
- Missing FFmpeg or ffprobe exits 4. A failed FFmpeg step writes a `failed` manifest and publishes no partial output.
- `cappy clean` removes comparisons by ID and through `--failed`, `--all`, and `--older-than`, and never removes the compared captures.
- `docs/cli.md`, `docs/storage.md`, and `README.md` document comparison. Repository-standard validation passes.

## Dependencies

CAP-012, CAP-013.

## Completion

Completed 2026-09-25 (America/Chicago).

- Two succeeded captures of one source produce `comparisons/<cmp-id>/triptych.mp4`, `frames.json`, and `manifest.json`. The manifest validates against `comparisonManifestSchema` and records alignment, normalization, SSIM/PSNR summaries, both capture identities (ID, take, game build, master path and SHA-256, aligned start), and hashed artifacts, and every artifact hash matches its file. No partial files remain. Covered by the first test in `packages/cli/test/compare.test.ts`.
- With `CAPPY_REAL_TOOLS=1`: identical real 320x240 masters score a mean SSIM of at least 0.999, and the triptych probes as 960x240 H.264. A 640x480 master with a red box over 250-450 ms scores lower (min SSIM under 0.9), is scaled to 320x240, and its worst frame falls inside the box's span.
- Refusals happen before any media work, and no comparison directory is created: different sources and a failed capture give `COMPARE_INCOMPATIBLE` (exit 1); the same ID twice, a single ID, and `--min-ssim 1.5` give `USAGE_INVALID` (exit 2); an unknown ID gives `CAPTURE_NOT_FOUND` (exit 2); a tampered master gives `COMPARE_INPUT_INVALID` (exit 1).
- Alignment uses `SCENARIO_STARTED` for scenario captures and `REPLAY_STARTED` for replay captures of one session. The span is the shorter operation, and FFmpeg receives exactly each aligned `-ss` and the span `-t`. A different resolution is normalized to A's size and recorded (`scaledB: true`, `scale=1280:720` in the graph). A's frame rate is used, or 30 when ffprobe reports none.
- `-ms 0.99` below the mean SSIM records `regressed`, keeps all three outputs, and exits 1 with `COMPARISON_REGRESSED`. `--min-ssim 0.5` passes, and no flag exits 0.
- Missing FFmpeg exits 4 (`TOOL_NOT_FOUND`) and creates no comparison. A failing FFmpeg run exits 1 with `COMPARISON_FAILED` and leaves only a `failed` `manifest.json`.
- `cappy clean` removes a comparison by ID. `--failed` selects exactly the failed comparison. `--older-than 1d` (two days on) and `--all` include comparisons. The compared captures are never touched.
- Also: a same-build (or no-build) warning; `compare` holds a run lock and writes a command log; `ensureDirectory` creates the comparison directory with the workspace's link and escape checks; a manifest that cannot be written fails the command.
- Docs: `docs/cli.md` (the new `cappy compare` section, and clean's `cmp_` IDs), `docs/storage.md` (the `comparisons/` layout, clean rules, run lock), and `README.md`. SPEC 11.8 now records exit codes, the 30 fps fallback, and the failure codes.

Validation (macOS):

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 235 passed, 13 skipped (opt-in).
- `CAPPY_REAL_TOOLS=1 npx vitest run`: 246 passed, 2 skipped (the OBS smoke tests), with FFmpeg 9.0.1 and Godot.
- `git diff --check`: passed.
