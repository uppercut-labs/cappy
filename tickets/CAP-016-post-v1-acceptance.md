# CAP-016 - Accept the post-V1 increments with real tools on macOS and Windows

## Goal

The promoted features are honestly verified end to end on both supported hosts.

## Scope

- Real Godot demo runs, with real OBS and FFmpeg:
  - a scenario capture with an event-anchored clip and still (for example the orb scenario's `BOUNCE` where `bounce` is 2, through `SETTLED`);
  - two replay captures of one freeform session, compared;
  - `cappy clean` with `--dry-run` and then for real, on the comparison, a capture, and failed leftovers.
- Per-host results in `docs/acceptance.md`.
- Documentation fixes the runs reveal.

## Acceptance Criteria

- On macOS, with real OBS, FFmpeg, and Godot, each of these passes: an anchored clip and still whose manifest windows match the demo's events; a comparison of two replay captures of one session that is `succeeded`, with its outputs and scores; and a clean dry run followed by a real clean that removes exactly the previewed items. The results are recorded in `docs/acceptance.md`.
- On Windows, the same runs pass and are recorded separately, never inferred from macOS.
- The full suite, with the real-tool switches, passes on both hosts.
- Any unverified host or tool limitation is stated explicitly.
- Planning artifacts stay synchronized with delivered behavior.

## Dependencies

CAP-015.
