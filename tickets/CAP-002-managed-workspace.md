# CAP-002 - Implement managed workspace and safe artifact ownership

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
