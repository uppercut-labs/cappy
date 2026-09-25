# CAP-013 - Anchor derivative times to timeline events

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
