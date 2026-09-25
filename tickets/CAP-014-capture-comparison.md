# CAP-014 - Compare two captures of the same source

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
