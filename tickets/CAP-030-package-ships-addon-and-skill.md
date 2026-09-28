# CAP-030 - Ship the Godot addon and the agent skill in the npm package

**Status:** Complete
**Depends on:** CAP-026, CAP-028, CAP-029.

## Goal

Someone who installs `@uppercut-labs/cappy` from npm gets everything they need without access to the private source repository: the CLI, the Godot addon, and the agent skill (ADR-025).

## Scope

- `packages/cappy/package.json`: `files` adds `.agents/skills/cappy/` and `addons/cappy/`; the `repository`, `homepage`, and `bugs` fields that pointed at the private repository are removed.
- `scripts/build-distribution.mjs` copies the skill and addon into the package folder.
- `scripts/check-package.mjs` fails if the addon or skill is missing, or if any packaged file mentions `github.com` or a git URL.
- The skill, package README, and release runbook name `@uppercut-labs/cappy`, warn that the unscoped `cappy` on npm is an unrelated package, and describe the first publication step by step.

## Evidence (Linux container, Node.js 24.21.0)

- `npm run typecheck`, `npm run lint`, `npm test` (299 passed, 23 skipped opt-in real-tool tests), `npm run model:check`, `npm run build:distribution`, and `npm run package:check` pass. The tarball has 14 files: the CLI, the four addon files, the six skill files, README, LICENSE, and package.json.
- Negative controls: removing `addons/cappy/` from `files` fails the checker with `tarball is missing package/addons/cappy/cappy_adapter.gd`; adding a GitHub link to the package README fails it with `package/README.md references a source repository`.

Not done here: publication. `@uppercut-labs/cappy` returned E404 on 2026-09-28 and the unscoped `cappy` is taken (an unrelated 0.0.6 from 2022).
