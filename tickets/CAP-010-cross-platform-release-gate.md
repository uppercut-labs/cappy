# CAP-010 - Verify Windows/macOS behavior and document V1 release

## Goal

Turn the implementation into a repeatable tool that is honestly accepted on both supported hosts.

## Scope

- Windows process/path/signal acceptance.
- macOS process/path/signal acceptance.
- Real OBS WebSocket smoke capture.
- Real FFmpeg derivative smoke.
- Real Godot scenario and replay capture.
- CLI usage documentation.
- Config example.
- Managed-storage/cleanup documentation.
- Graphviz model validation/render command.

## Acceptance Criteria

- Repository-standard validation passes.
- Supported-host acceptance results are recorded separately, never inferred from the other OS.
- A new project can follow documentation to configure Cappy and run the Godot demo.
- `doctor`, `scenarios`, `run`, `record`, and `replay` are documented.
- Any unresolved host/tool limitation is explicit and does not masquerade as verified support.
- Planning artifacts remain synchronized with delivered behavior.

## Dependencies

CAP-009.
