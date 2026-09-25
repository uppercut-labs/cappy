# CAP-001 - Establish Cappy workspace and contracts

**Status:** Complete

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

## Completion

Completed 2026-09-25 (America/Chicago).

- Invalid config fails with structured errors: `parseConfig`/`loadConfig` return `CONFIG_NOT_FOUND`, `CONFIG_UNREADABLE`, `CONFIG_PARSE_ERROR`, or `CONFIG_INVALID` with dotted-path issues (`packages/core/test/config.test.ts`).
- Core schemas have runtime validation tests: Zod schemas for config, capabilities, scenarios, sessions, timeline events, capture jobs, artifacts, and manifests (`packages/core/test/domain.test.ts`, `packages/core/test/result.test.ts`).
- `npm test` and strict typecheck run from repository root: `npm run typecheck` (`tsc -b && tsc -p tsconfig.test.json`), `npm run lint`, and `npm test` all pass.
- Shared core has no Godot-specific dependency: `tests/boundaries.test.ts` rejects any Godot reference under `packages/`.

Validation:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 4 files, 35 tests passed.
- `git diff --check`: passed.
