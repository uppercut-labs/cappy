# CAP-019 - Name builds in the config and compare them in one command

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
