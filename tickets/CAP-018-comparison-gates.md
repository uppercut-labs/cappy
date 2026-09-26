# CAP-018 - Gate comparisons on frames and on the timeline

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
