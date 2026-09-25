# CAP-004 - Deliver CLI shell and dependency preflight

**Status:** Complete

## Goal

Make Cappy operable by humans, agents, and CI before real capture is introduced.

## Scope

- CLI command router.
- Human output and `--json`.
- Stable exit behavior and error codes.
- `cappy doctor`.
- `cappy scenarios`.
- Game launch/connect orchestration against the simulator.
- FFmpeg/ffprobe and OBS reachability checks.

## Acceptance Criteria

- JSON mode emits parseable structured output with no ANSI contamination.
- Doctor reports individual checks and overall status.
- Scenarios lists simulator-registered schemas/capabilities.
- Missing tools/configuration fail clearly without partially starting a capture.

## Dependencies

CAP-001, CAP-003.

## Completion

Completed 2026-09-25 (America/Chicago).

- JSON mode emits parseable structured output with no ANSI contamination: `--json` writes exactly one JSON document to stdout with no ESC bytes, for success, command failure, and usage errors (`packages/cli/test/cli.test.ts`, "CLI shell" and "cappy doctor"); the built `cappy` binary was also run as a real process.
- Doctor reports individual checks and overall status: stable check IDs with pass/warn/fail/skip, `DOCTOR_CHECKS_FAILED` listing failed IDs, and exit 4 (or 3 for invalid config). Covered: fake tools, missing tools and game command, OBS reachability, password authentication, missing scene, unset password variable, and an unsafe managed root.
- Scenarios lists simulator-registered schemas/capabilities: `cappy scenarios` launches the simulator as a real child process with endpoint and token, negotiates, and lists `boss_intro`/`menu_idle` with parameter schemas and capabilities; the game process is stopped afterward.
- Missing tools/configuration fail clearly without partially starting a capture: invalid config never launches the game; a missing game command fails with `GAME_LAUNCH_FAILED`, an early exit with `GAME_EXITED`, and a silent game with `ADAPTER_CONNECT_TIMEOUT` after its process is stopped.

Validation:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 7 files, 117 tests passed, 1 skipped (the opt-in real-FFmpeg smoke test).
- `CAPPY_REAL_TOOLS=1 npx vitest run packages/cli -t "real FFmpeg"`: passed against FFmpeg/ffprobe 9.0.1 on PATH.
- `git diff --check`: passed.
- Not exercised: real OBS (not installed on this Mac; covered by CAP-010) and Windows process behavior (CAP-010).
