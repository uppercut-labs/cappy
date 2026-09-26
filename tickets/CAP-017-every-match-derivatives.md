# CAP-017 - Produce one derivative per matching event

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
