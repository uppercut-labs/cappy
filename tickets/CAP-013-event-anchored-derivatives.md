# CAP-013 - Anchor derivative times to timeline events

**Status:** Complete

## Goal

Presets can cut clips and grab stills or thumbnails around semantic events instead of fixed seconds (SPEC section 13, "Event anchors"; ADR-014).

## Scope

- The anchor schema (`event`, `offset`, `occurrence`, `where`) for clip `start` and `end` and for still and thumbnail `at`.
- The clip rule of exactly one of `duration` or `end`.
- Validation before the game launches.
- A resolver over the capture's master-clock timeline: type, occurrence, dotted-path `where` equality, and an `end` search at or after the start.
- Clamping with warnings. The `DERIVATIVE_ANCHOR_UNRESOLVED` and `DERIVATIVE_WINDOW_EMPTY` failures, following the required/optional rules.
- Resolved `window` and `at` recorded on artifacts, as additive optional manifest fields, for anchored and numeric times alike.
- An anchored example in `cappy.config.example.json`. Docs in `docs/cli.md` or a preset reference.
- Fake-tool and real-FFmpeg tests.

## Acceptance Criteria

- A clip with `start: {"event": "SPELL_CAST", "offset": -2}` and `end: {"event": "IMPACT", "offset": 1}` covers from 2 s before the first `SPELL_CAST` to 1 s after the first `IMPACT` at or after it. The manifest records the resolved window and both event IDs.
- `occurrence` (n-th and `"last"`) and `where` (dot-separated payload paths, strict scalar equality, every condition must match) select the documented event. Cappy lifecycle events such as `SCENARIO_STARTED` work as anchors.
- V1 numeric `start`, `duration`, and `at` presets keep working unchanged, and their windows and times are now recorded too.
- Invalid anchors fail before the game launches with `DERIVATIVE_OPTIONS_INVALID`. This covers a bad event type, both or neither of `duration` and `end`, a non-scalar `where` value, and an occurrence of zero.
- An unmatched anchor fails a required derivative (capture `failed`, `DERIVATIVE_ANCHOR_UNRESOLVED`) and skips an optional one with a warning. An empty window fails with `DERIVATIVE_WINDOW_EMPTY`. Windows and times past the master are clamped, with a warning.
- Stills and thumbnails accept an `at` anchor with the same matching rules.
- With `CAPPY_REAL_TOOLS=1`, a real master with a timeline produces an anchored clip whose probed duration matches the resolved window within 100 ms, and an anchored still at the resolved time.
- Repository-standard validation passes, and the docs and example config show anchors.

## Dependencies

None.

## Completion

Completed 2026-09-25 (America/Chicago).

- A clip with a `SPELL_CAST` start (offset -2 s in the criterion; the unit test uses -0.5 s) and an `IMPACT` end (+1 s) covers the offset window from the first `SPELL_CAST` to the first `IMPACT` at or after it. An earlier `IMPACT` is ignored. The manifest records `window: { startMs, endMs, startEventId, endEventId }`. Covered by `packages/media/test/derivatives.test.ts` ("cuts a clip…") and end to end with the simulator in `packages/cli/test/processing.test.ts` ("cuts event-anchored clips, stills, and thumbnails…"), which also checks that FFmpeg received exactly the resolved `-ss` and `-t`.
- `occurrence` (2nd, `"last"`, out of range) and `where` (dotted path `target.kind`, strict `3` vs `"3"`, every condition must match, a missing path never matches) select the documented event. `SCENARIO_STARTED` works as an anchor.
- V1 numeric presets are unchanged: the existing processing and real-FFmpeg tests pass untouched, including the numeric still at 30 s on a 2 s master that must fail. Numeric windows and times are now recorded too (`opening` has `window: { startMs: 500, endMs: 1500 }`).
- Invalid anchors fail before the game launches with `DERIVATIVE_OPTIONS_INVALID` (exit 3, no `StartRecord`). This covers a bad event type (`1BAD`, `SPELL CAST`, empty), both or neither of `duration` and `end`, an object `where` value, occurrence 0, unknown anchor fields, and a numeric `end` not after `start`.
- A required derivative whose anchor never happened fails the capture with `DERIVATIVE_ANCHOR_UNRESOLVED`, keeping the master and a `failed` manifest. An optional one is skipped with a warning. An empty clamped window fails with `DERIVATIVE_WINDOW_EMPTY`. Anchored windows and times past the master are clamped with a warning; a still goes to the last frame, using the probed frame rate, or 100 ms before the end when ffprobe reports none.
- Stills and thumbnails accept `at` anchors (`impact` still on `IMPACT`, `thumb` on `SCENARIO_STARTED` `"last"`).
- With `CAPPY_REAL_TOOLS=1`, a real H.264 master produces an anchored clip whose probed duration is within 100 ms of its resolved window, and an anchored still (320x240 PNG) at the resolved `IMPACT` time. It passed three consecutive runs.
- Docs: a new `docs/presets.md` (derivatives and event anchors), anchored examples in `cappy.config.example.json` (validated by a test), `README.md`, `docs/getting-started.md` (an optional `SETTLED` still for the Godot demo), and `docs/cli.md`. SPEC 13 now states that clamping applies only to anchored times.

Validation (macOS):

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 226 passed, 11 skipped (opt-in).
- `CAPPY_REAL_TOOLS=1 npx vitest run`: 235 passed, 2 skipped (the OBS smoke tests), with FFmpeg 9.0.1 and headless Godot.
- `CAPPY_REAL_TOOLS=1 CAPPY_OBS_SMOKE=1 CAPPY_OBS_SCENE=Capture npx vitest run`, with the local OBS: 237 passed.
- `git diff --check`: passed.
