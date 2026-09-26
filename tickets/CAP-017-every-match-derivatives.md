# CAP-017 - Produce one derivative per matching event

**Status:** Complete

## Goal

A preset derivative can produce one clip, still, or thumbnail for every matching event, not just one (SPEC section 13; ADR-017).

## Scope

- `occurrence: "every"`, allowed on a clip's `start` and on a still's or thumbnail's `at`, rejected elsewhere.
- Outputs `<role>-1`, `<role>-2`, and so on, in timeline order.
- Each clip's `end` pairs with the first qualifying event at or after its own start event.
- A cap of 100 outputs, with a warning for the matches skipped.
- Per-output resolution, clamping, production, and manifest recording.
- Required and optional semantics per output.
- Config validation of generated-name collisions.
- Docs (`docs/presets.md`), example config, and tests with fake tools and real FFmpeg.

## Acceptance Criteria

- A clip with `start: {"event": "BOUNCE", "occurrence": "every", "offset": -0.2}` and `end: {"event": "BOUNCE", "offset": 0.2}` produces `<role>-1` through `<role>-N`, one per `BOUNCE` in timeline order. Each manifest artifact records its own window and event IDs.
- `"every"` on a clip's `end`, or together with a numeric time, fails before launch with `DERIVATIVE_OPTIONS_INVALID`. So does a preset with a role such as `highlight-2` next to an `"every"` role `highlight`.
- A required `"every"` derivative with no match fails the capture with `DERIVATIVE_ANCHOR_UNRESOLVED`. An optional one warns. A failed output of a required derivative fails the capture, and of an optional one warns.
- More than 100 matches produce 100 outputs and a warning naming how many were skipped.
- `"every"` with `where` selects only matching events.
- With `CAPPY_REAL_TOOLS=1`, a real master yields every clip and still, and each clip's probed duration matches its window within 100 ms.
- Docs and the example config show `"every"`. Repository-standard validation passes.

## Dependencies

None.

## Completion

Completed 2026-09-25 (America/Chicago).

- A `BOUNCE` `"every"` clip with a `BOUNCE` end expands to `hop-1` through `hop-3`, one per bounce in timeline order. Each window is `[bounce - 200 ms, bounce + 200 ms]`, with its own start and end event IDs (`expandDerivative` plus `resolveTiming` in `packages/media/test/derivatives.test.ts`). End to end, a simulator scenario with three `HIT` events produces `hit-1` to `hit-3`. Each window starts at its own hit, and the manifest records every window (`packages/cli/test/processing.test.ts`). An `"every"` clip ending at `SETTLED` pairs each start with the first `SETTLED` after it.
- These are rejected before launch with `DERIVATIVE_OPTIONS_INVALID`: `"every"` on a clip's `end`, an `"every"` start with a fixed numeric `end`, and a `hit-2` role beside an `"every"` role `hit`. `hit-x` is allowed. `"every"` on a thumbnail's or still's `at` is valid.
- A required `"every"` derivative with no match fails the capture with `DERIVATIVE_ANCHOR_UNRESOLVED` (exit 1), and an optional one warns. Per-output failures follow the existing required/optional loop, now applied to each generated output.
- 130 matches produce 100 outputs and the warning "…only the first 100 were produced (30 skipped)".
- `"every"` with `where: { crit: true }` produced only `crit-1`, at the critical hit.
- With `CAPPY_REAL_TOOLS=1`, a real master yields three clips, each within 100 ms of its window, and three 320-pixel PNG stills.
- `docs/presets.md` has a new "One output per event" section. `cappy.config.example.json` has an `"every"` thumbnail and is validated by a test.

Validation (macOS):

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 259 passed, 15 skipped.
- `CAPPY_REAL_TOOLS=1 npx vitest run`: 272 passed, 2 skipped (the OBS smoke tests).
- `git diff --check`: passed.
