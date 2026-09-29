# CAP-031 - Tidy the repository for public visibility

**Status:** Complete
**Depends on:** CAP-030.

## Goal

The repository is public (ADR-026), so published material links it, nothing still names the pre-transfer `devin-thomas/cappy`, and a package packed on Windows matches one packed on Linux.

## Scope

- `packages/cappy/package.json` links `uppercut-labs/cappy` (`repository`, `homepage`, `bugs`).
- `scripts/check-package.mjs` requires that link and fails on a link to any other repository.
- Schema `$id`s and the agent task prompt use `uppercut-labs/cappy`.
- `.gitattributes` keeps text files LF in every checkout.

SPEC section 26.2 still records `devin-thomas/cappy` as the origin found on 2026-09-28; it is a dated observation and stays as written.

## Evidence (Linux container, Node.js 24.21.0)

- `npm run typecheck`, `npm run lint`, `npm test` (299 passed, 23 skipped opt-in real-tool tests), `npm run model:check`, `npm run build:distribution`, and `npm run package:check` pass; `npm run schemas` changes only the two `$id`s.
- Negative controls: a `github.com/devin-thomas/cappy` link in the package README fails the checker (`package/README.md references another repository: devin-thomas/cappy`); a `github.com/uppercut-labs/cappy` link passes; removing `repository` from the manifest fails it (`package manifest must link the uppercut-labs/cappy source repository`).
