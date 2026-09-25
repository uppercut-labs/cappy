# CAP-012 - Add `cappy clean` with retired takes

## Goal

Developers can reclaim workspace space from the command line, with the V1 ownership guarantees intact and take numbers never reissued (SPEC sections 11.7, 16, 17; ADR-012, ADR-013).

## Scope

- `cappy clean [<id>...] [--failed] [--older-than <age>] [--logs] [--all] [--dry-run]`, with shorthands `-f`, `-ot`, `-l`, `-a`, and `-dr`.
- Selection by capture and session ID, plus the bulk selectors, the age filter, and its age syntax.
- Expanding each item: a capture with its own scenario session; a session with a warning about the replay captures that remain; a log.
- In-progress protection from run locks.
- Immediate deletion through `ManagedWorkspace.remove`, removing directories left empty and reporting unregistered leftovers.
- Registry schema version 2 with `retiredTakes`, the upgrade from version 1, and take allocation honoring retired takes for both automatic and explicit `--take`.
- `--dry-run` with no side effects.
- The result report, `CLEAN_INCOMPLETE`, human and JSON rendering.
- Update `docs/cli.md`, `docs/storage.md`, and `README.md`.

Comparison items (`cmp_…`) are added by CAP-014.

## Acceptance Criteria

- `cappy clean <cap-id>` removes every managed file of that capture and, for a scenario capture, the scenario session named by its manifest. It never removes a replayed session. The removed paths and freed bytes are reported.
- `cappy clean <ses-id>` removes the session and warns with the IDs of replay captures that referenced it. Those captures remain.
- `--failed`, `--logs`, `--all`, and `--older-than` select exactly the sets defined in SPEC section 11.7. `--older-than` alone filters `--all`. Combining it with explicit IDs, giving no selector, or giving a malformed age fails with `USAGE_INVALID` and exit 2.
- `--dry-run` reports the same selection and predicted outcome, and leaves every file and the registry byte-for-byte unchanged.
- Imported and external files, unregistered files, files modified since Cappy wrote them, and paths through symlinks are never deleted. A refused file or explicit ID produces exit 1 with `CLEAN_INCOMPLETE`, while the other selected files are still removed.
- While a run lock is live, active sessions, manifest-less capture directories, and the locked command's log are never deleted: refused when named explicitly, skipped with a warning by bulk selectors.
- After a successful take is cleaned, the next automatic take for that source is one past the retired take, and `--take <retired>` fails with `TAKE_EXISTS`. A version 1 registry is read and upgraded to version 2 on its next write.
- Empty item directories are removed. Unregistered leftovers are kept and reported with reason `not_managed`.
- Tests cover every criterion above, including a real filesystem symlink case on the host.
- `docs/cli.md`, `docs/storage.md`, and `README.md` document the command. Repository-standard validation passes.

## Dependencies

CAP-011.
