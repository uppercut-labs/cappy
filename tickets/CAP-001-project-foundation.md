# CAP-001 - Establish Cappy workspace and contracts

## Goal

Create the strict TypeScript/npm-workspace foundation and encode the configuration, result, and domain contracts needed by later vertical slices.

## Scope

- npm workspaces and strict TypeScript.
- Core package boundaries.
- Project configuration schema and loader.
- Domain types for projects, capabilities, sessions, capture jobs, timeline events, artifacts, and manifests.
- Human/JSON CLI result envelope.
- Baseline lint/typecheck/test commands.

## Acceptance Criteria

- Invalid config fails with structured errors.
- Core schemas have runtime validation tests.
- `npm test` and strict typecheck run from repository root.
- Shared core has no Godot-specific dependency.

## Dependencies

None.
