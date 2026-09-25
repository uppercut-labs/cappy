# CAP-002 - Implement managed workspace and safe artifact ownership

**Status:** Complete

## Goal

Create Cappy's per-project storage model without risking user-owned files.

## Scope

- Resolve default `.cappy/` or configured external artifact root.
- Session/capture/cache/log storage primitives.
- Managed/imported/external ownership metadata.
- SHA-256 and atomic managed writes.
- Safe cleanup primitives.
- Git-ignore warning for default workspace.

## Acceptance Criteria

- Managed writes cannot escape the resolved root.
- Imported/external paths can be referenced but never deleted.
- Symlink/path-traversal cleanup attempts are rejected.
- Existing successful artifacts are not implicitly overwritten.
- Unit tests cover destructive boundaries.

## Dependencies

CAP-001.

## Completion

Completed 2026-09-25 (America/Chicago).

- Managed writes cannot escape the resolved root: absolute, drive-letter, `..`, control-character, reserved-name, and symlinked-directory targets are rejected with `WORKSPACE_PATH_REJECTED` (`packages/workspace/test/workspace.test.ts`, "managed writes").
- Imported/external paths can be referenced but never deleted: `referenceFile` records them; `remove` rejects them and the files remain ("safe cleanup").
- Symlink/path-traversal cleanup attempts are rejected: traversal, out-of-root absolute paths, a managed file replaced by a symlink, and a managed parent directory replaced by a symlink are all rejected with the target untouched.
- Existing successful artifacts are not implicitly overwritten: a second write to a managed path fails with `WORKSPACE_TARGET_EXISTS`; replacement requires `replace: true` and never applies to unmanaged files.
- Unit tests cover destructive boundaries: 29 workspace tests, including hash-verified cleanup that rejects files modified since Cappy wrote them, and the Git-ignore warning that never edits `.gitignore`.

Validation:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 5 files, 64 tests passed.
- `git diff --check`: passed.
