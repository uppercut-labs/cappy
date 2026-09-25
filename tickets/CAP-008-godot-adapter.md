# CAP-008 - Build the first production Godot adapter

**Status:** Complete

## Goal

Prove Cappy against a real engine while preserving the engine-neutral core.

## Scope

- Reusable Godot 4.x addon.
- Protocol handshake/capabilities.
- Scenario registration API.
- Parameter validation hooks.
- Timeline event API.
- Freeform replay recording interface.
- Replay execution interface.
- Deterministic Godot demo fixture.

## Acceptance Criteria

- Demo registers at least one deterministic scenario and one parameter.
- Cappy can list and run the demo scenario.
- Demo emits semantic events visible in the Cappy timeline.
- Demo can record a freeform replay payload and replay it.
- Godot code contains no OBS/FFmpeg integration.
- Core TypeScript packages contain no Godot dependency.

## Dependencies

CAP-003, CAP-005.

## Completion

Completed 2026-09-25 (America/Chicago).

- Demo registers at least one deterministic scenario and one parameter: `orb_launch` registers `power` (integer 1-5, default 3) and `gravity` (number 0.5-4) with required capability `scenarios`, and the adapter declares `scenarios`, `freeform_recording`, `replay`, and `deterministic_replay` (`tests/integration/godot.test.ts`, real headless Godot 4.7.2).
- Cappy can list and run the demo scenario: `cappy scenarios` lists it; `cappy run orb_launch --param power=4` succeeds through the full capture pipeline (fake OBS and media tools), and a second run is take 2.
- Demo emits semantic events visible in the Cappy timeline: `LAUNCH`, `BOUNCE`..., `SETTLED` appear in the run's timeline with tick-derived times, identical across repeated runs. The game's validation hook rejects `power=5 gravity=3` with `INVALID_PARAMETERS`.
- Demo can record a freeform replay payload and replay it: `cappy record --duration 1.5` stores a `cappy-godot-demo-runner-v1` payload, and `cappy replay --no-capture` reproduces the recorded timeline (`RUN_START`, `JUMP`, `LAND`, `COIN`, `RUN_END`) event for event, time for time.
- Godot code contains no OBS/FFmpeg integration: `tests/boundaries.test.ts` rejects any recorder or media-tool reference in `adapters/godot` and `fixtures/godot-demo`.
- Core TypeScript packages contain no Godot dependency: the existing boundary test over `packages/` still passes.

Addon: `adapters/godot/addons/cappy` (API in `adapters/godot/README.md`). `npm run godot:demo` assembles the demo with the addon.

Validation:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 14 files, 176 tests passed, 7 skipped (opt-in real-tool tests); run twice with no flakes.
- `CAPPY_REAL_TOOLS=1 npx vitest run`: 183 tests passed, including 4 real headless Godot 4.7.2 tests and the real FFmpeg tests.
- `git diff --check`: passed.
