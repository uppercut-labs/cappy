# CAP-018 - Gate comparisons on frames and on the timeline

**Status:** Complete

## Goal

CI can fail a comparison on a glitch confined to a few frames or on a logic regression visible in the events (SPEC section 11.8; ADR-018).

## Scope

- `--min-frame-ssim <score>` (`-mfs`), `--max-drift-ms <ms>` (`-mdm`), and `--require-same-events` (`-rse`), alongside `--min-ssim`.
- The `regressed` status whenever any gate fails.
- `COMPARISON_REGRESSED` details listing the failed gates.
- Comparison manifest version 2, with `gates` and `failedGates` replacing `threshold`.
- A warning when the captures' presentations differ.
- Human rendering, docs, and tests.

## Acceptance Criteria

- Each gate, given alone, records `regressed` and exits 1 exactly when its condition fails, and `succeeded` (exit 0) when it holds. This is shown with fake tools for a per-frame dip, event drift beyond the limit, and unequal event counts.
- Several gates combine: `failedGates` lists every failed gate, and the result details carry them.
- Without gates, the timeline diff never changes the outcome (CAP-015 behavior kept).
- Invalid gate values (a score outside 0 to 1, a negative or non-numeric drift) fail with `USAGE_INVALID` (exit 2) before any media work.
- Manifests validate as `comparisonVersion: 2`. `clean` still selects version 1 and version 2 comparisons.
- `docs/cli.md` documents the gates. Repository-standard validation passes.

## Dependencies

None.

## Completion

Completed 2026-09-25 (America/Chicago).

- Each gate, given alone, regresses exactly when its condition fails (`packages/cli/test/compare.test.ts`):
  - `-mfs 0.6` regresses on a single-frame dip to 0.5 while `--min-ssim 0.5` passes; `--min-frame-ssim 0.4` succeeds.
  - `--max-drift-ms 20` regresses on a 40 ms `SPELL_CAST` drift; `-mdm 100` succeeds.
  - `-rse` regresses on an extra `SPELL_CAST`.
  - The existing `--min-ssim` behavior is kept.
- Gates combine: `-rse -mdm 20 -ms 0.5` gives `COMPARISON_REGRESSED` with `failedGates: ["maxDriftMs", "requireSameEvents"]`, in `GATE_NAMES` order.
- Without gates, the same differing timeline exits 0 (CAP-015 behavior kept).
- `-mfs 2`, `--min-frame-ssim x`, `--max-drift-ms -5`, `-mdm soon`, and an empty `-ms` fail with `USAGE_INVALID` (exit 2), and no comparison directory is created.
- Manifests validate as `comparisonVersion: 2`, with `gates` and `failedGates`. The schema recomputes the failed gates with `evaluateGates` and requires `failedGates` and `regressed` to match (`packages/core/test/domain.test.ts`). `clean --failed` selects both a version 1 comparison and a version 2 one.
- `docs/cli.md` documents the four gates. `cappy --help` lists `-mfs`, `-mdm`, and `-rse`, which the shorthand-rule test covers.
- The comparison warning for differing presentations named in this ticket's scope is delivered with CAP-021, which introduces the recorded presentation it compares.

Validation (macOS):

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 263 passed, 15 skipped.
- `CAPPY_REAL_TOOLS=1 npx vitest run`: 276 passed, 2 skipped (the OBS smoke tests).
- `git diff --check`: passed.
