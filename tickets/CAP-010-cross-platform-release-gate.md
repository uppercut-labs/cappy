# CAP-010 - Verify Windows/macOS behavior and document V1 release

**Status:** Complete

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

## Completion

Completed 2026-09-25 (America/Chicago).

- Repository-standard validation passes: typecheck, lint, `git diff --check`, `npm run model:check`, and the full suite on macOS (189 passed, 10 opt-in skipped; 199 passed with every real tool) and Windows (187 passed; 197 with every real tool, the 2 POSIX-only signal tests skipped).
- Supported-host acceptance results are recorded separately, never inferred from the other OS: `docs/acceptance.md` has separate macOS 27.0 (arm64) and Windows 11 (x64) tables with the evidence for each row.
- A new project can follow documentation to configure Cappy and run the Godot demo: `docs/getting-started.md` was followed literally in a fresh project on both hosts, with steps 1-7 (doctor, scenarios, record, replay, run, and replay capture with real Godot and OBS) producing `succeeded` manifests.
- `doctor`, `scenarios`, `run`, `record`, and `replay` are documented: `docs/cli.md`, plus `docs/storage.md` (managed storage and cleanup) and `cappy.config.example.json`, which a test validates.
- Any unresolved host/tool limitation is explicit and does not masquerade as verified support: `docs/acceptance.md` lists Linux as out of scope and explains why the Windows Ctrl+C check runs as a script in an interactive console.
- Planning artifacts remain synchronized with delivered behavior: SPEC.md, Ideas.md, README.md, and `docs/system-model.dot` are updated; the model validates and renders with Graphviz 16.1.0 (WebAssembly).

Covered: Windows and macOS process, path, and signal acceptance (including a real console Ctrl+C on Windows via `scripts/acceptance/windows-ctrl-c.ps1`); real OBS 32.2.2 smoke capture on both hosts (`tests/integration/obs-smoke.test.ts`); real FFmpeg derivatives; and real Godot scenario and replay captures.

Fixed during acceptance: the `cappy` bin is now a committed launcher (`packages/cli/bin/cappy.js`), because npm on Windows skipped creating the command shim when `dist/` did not exist at install time. Fake media tools in tests are now Node scripts behind `.cmd`/shell launchers, so the fake-tool suite runs on Windows.

Validation:

- macOS: `npm run typecheck`, `npm run lint`, `npm run model:check` passed; `npm test` 189 passed, 10 skipped; `CAPPY_REAL_TOOLS=1 CAPPY_OBS_SMOKE=1 CAPPY_OBS_SCENE=Capture npx vitest run` 199 passed; `git diff --check` passed.
- Windows (Titan): typecheck and lint passed; `npx vitest run` 187 passed, 12 skipped; with every real tool 197 passed, 2 skipped; `npm run model:check` passed; the Ctrl+C script passed.
