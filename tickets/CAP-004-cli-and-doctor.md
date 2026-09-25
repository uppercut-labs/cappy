# CAP-004 - Deliver CLI shell and dependency preflight

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
