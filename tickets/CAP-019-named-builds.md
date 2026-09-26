# CAP-019 - Name builds in the config and compare them in one command

**Status:** Complete

## Goal

A developer names game builds once and captures and compares the same moment across two of them with one command (SPEC sections 6, 11.9, 15; ADR-019).

## Scope

- The `builds` config map, with field-wise overrides of `game` and `base` reserved as a name.
- `--build <name>` (`-b`) for `run`, `replay`, `record`, and `scenarios`, failing with `BUILD_NOT_FOUND`.
- `doctor` checks every build's command.
- `build.name` in manifests.
- `cappy compare-builds <session | scenario> <build-a> <build-b>`, with `--param`, `--preset`, and every compare gate; it stops at the first failed step.
- Simulator command-line options so two builds can differ in tests.
- A Godot demo variant (a user argument) that changes visuals and reports a distinct build, so two real builds can be compared.
- Docs and tests.

## Acceptance Criteria

- With `builds` configured, `run --build v2` launches the v2 command, merged with the base game, and its manifest records `build.name: "v2"`. Without `--build`, behavior is unchanged. An unknown build fails with `BUILD_NOT_FOUND` (exit 2) before launch.
- `doctor` reports a check per build (`game.<name>`) and fails when a build's command does not resolve.
- `compare-builds <session> v1 v2` produces two replay captures and a comparison, and returns all three reports. `compare-builds <scenario> v1 v2 --param key=value` does the same with scenario captures.
- A failing capture A stops the command with its error, and no capture B or comparison exists. `base` works as a build name. Identical build names fail with `USAGE_INVALID`.
- Gates pass through: two simulator builds that emit different events regress under `--require-same-events`.
- The Godot demo run with its variant argument reports a different build and renders differently. This is proven by a headless Godot test with `CAPPY_REAL_TOOLS=1`.
- `docs/cli.md`, `docs/getting-started.md` (builds), and the example config are updated. Repository-standard validation passes.

## Dependencies

CAP-018.

## Completion

Completed 2026-09-25 (America/Chicago).

- `run -b v2` launches the v2 build: the base game with v2's `args`, here the simulator with `--options {"build":"2.0.0"}`. Its manifest records `build: { name: "v2", gameBuild: "2.0.0" }`. Without `--build`, `build.name` is absent. `scenarios --build v1` and `record -b v1` launch v1. An unknown build fails with `BUILD_NOT_FOUND` (exit 2), listing the available names, before any OBS `StartRecord`. A `builds.base` entry fails config validation (exit 3). Covered by `packages/cli/test/builds.test.ts`.
- `doctor` reports `game.v1`, `game.v2`, `game.v3`, and `game.broken`. A build whose command does not resolve fails doctor (exit 4, `failed: ["game.broken"]`).
- `compare-builds <session> v1 v2` produced two replay captures (takes 1 and 2) and a `succeeded` comparison of builds 1.0.0 and 2.0.0. The data holds `builds`, `a`, `b`, and `comparison`. `compare-builds boss_intro base v2 -pa difficulty=3` did the same with scenario captures, using `base` as a build name.
- A failing build A (`broken`) stops the command with `GAME_LAUNCH_FAILED` (exit 4), and no capture or comparison exists. Identical names, a missing name, an unknown build, `--build`, `--no-capture`, and an invalid gate each fail with exit 2 before anything launches.
- Gates pass through: builds v1 and v3, whose simulated events differ, regress under `--require-same-events`, with `failedGates: ["requireSameEvents"]`.
- The Godot demo's `--variant=b` user argument reports build `0.1.0+b` and draws a larger green orb. With `CAPPY_REAL_TOOLS=1` and headless Godot, `scenarios --build b` reports `0.1.0+b`, and `compare-builds orb_launch base b -pa power=4 --require-same-events` succeeds with gameBuilds `0.1.0` and `0.1.0+b`. The variant's `LAUNCH` payload carries `variant: "b"`. Its rendering difference can only be observed through an OBS scene that captures the game window; that is checked in CAP-023.
- Docs: `docs/cli.md` (named builds, `--build`, `compare-builds`), `docs/getting-started.md` (step 8, comparing two builds with the demo variant), `cappy.config.example.json` (a `builds` entry, parsed by a test), and `README.md`.

Validation (macOS):

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 271 passed, 16 skipped.
- `CAPPY_REAL_TOOLS=1 npx vitest run`: 285 passed, 2 skipped (the OBS smoke tests).
- `git diff --check`: passed.
