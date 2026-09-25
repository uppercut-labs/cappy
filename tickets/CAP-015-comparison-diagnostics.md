# CAP-015 - Add worst-frame stills and a timeline diff to comparisons

**Status:** Complete

## Goal

A comparison shows where the two captures differ visually and how their game events differ (SPEC section 11.8).

## Scope

- Choose the three lowest-SSIM frames at least one second apart.
- Extract, for each, the A frame, the B frame normalized to A, and the amplified difference as PNGs.
- Timeline diff of adapter events, matched by type and occurrence order, relative to each aligned start: counts, missing and extra occurrences, mean and maximum drift.
- Warnings for count differences.
- Manifest fields, rendering, and docs.

## Acceptance Criteria

- Every `succeeded` or `regressed` comparison includes `worst-<n>-a.png`, `worst-<n>-b.png`, and `worst-<n>-diff.png` for up to three lowest-SSIM frames at least one second apart. The manifest lists each with its time, SSIM, and paths.
- The timeline diff reports, per adapter event type, the counts in A and B, the occurrences missing from B and extra in B, and the mean and maximum drift of matched occurrences.
- A count difference adds a warning. The timeline diff never changes the status or the exit code.
- Tests cover frame selection and spacing, and timeline diff edge cases: no adapter events, a type present in only one capture, and unequal counts.
- With `CAPPY_REAL_TOOLS=1`, the worst frame of a master with a changed region lies within the changed span, and its PNGs are valid images.
- Docs are updated, and repository-standard validation passes.

## Dependencies

CAP-014.

## Completion

Completed 2026-09-25 (America/Chicago).

- Every `succeeded` or `regressed` comparison includes `worst-<n>-a.png`, `worst-<n>-b.png`, and `worst-<n>-diff.png` for up to three lowest-SSIM frames at least one second apart. The manifest lists each with rank, time, SSIM, and paths, and records every still as a hashed artifact. `comparisonManifestSchema` now requires worst frames and a timeline diff on any completed comparison. The stills show each master at its aligned start plus the frame time, with B scaled to A (checked through the fake FFmpeg's recorded `-ss`). Covered by `packages/cli/test/compare.test.ts` and `packages/core/test/domain.test.ts`.
- The timeline diff (`diffTimelines` in `@cappy/core`) reports, per adapter event type, the counts in A and B, `matched`, `missingAtMs` and `extraAtMs`, and the mean and largest (signed) drift of matched occurrences, measured from each aligned start. End to end, a simulated build B with an extra `SPELL_CAST` and events shifted 20-30 ms reports exactly that.
- A count difference adds a warning ("timeline differs: SPELL_CAST occurs 1 time(s) in A and 2 in B"). That comparison still exits 0 and is `succeeded` under `--min-ssim 0.9`.
- Tests: frame selection and spacing (three dips across 4 s; fewer when the span is short; ties), stats parsing (`inf`, mismatched logs), and argument building in `packages/media/test/compare.test.ts`. Timeline diff edge cases in `packages/core/test/timeline.test.ts`: paired drift, missing and extra occurrences, types present in only one capture, the sign of the largest drift, lifecycle events ignored, and no adapter events. A failed still extraction exits 1 with `COMPARISON_FAILED` and publishes nothing but the `failed` manifest, because every output is staged and validated before any is published.
- With `CAPPY_REAL_TOOLS=1`, the worst frame of the 640x480 master with a red box over 250-450 ms lies inside that span. Its A, B, and difference stills probe as 320x240 PNGs.
- Docs: `docs/cli.md` (outputs, timeline diff, `data` fields) and `docs/storage.md` (layout). The fixture simulator now accepts `scenarios` through `CAPPY_SIM_OPTIONS`, to simulate a build whose events differ.

Validation (macOS):

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 247 passed, 13 skipped (opt-in).
- `CAPPY_REAL_TOOLS=1 npx vitest run`: 258 passed, 2 skipped (the OBS smoke tests), with FFmpeg 9.0.1 and Godot.
- `git diff --check`: passed.
