# CAP-015 - Add worst-frame stills and a timeline diff to comparisons

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
