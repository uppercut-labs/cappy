# CAP-012 - Add `cappy clean` with retired takes

**Status:** Complete

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

## Completion

Completed 2026-09-25 (America/Chicago).

- `cappy clean <cap-id>` removes the capture and its own scenario session, never a replayed session, and reports removed paths and freed bytes. Covered by "removes a scenario capture with the scenario session it created and retires its take" and "keeps a replayed session when its capture is cleaned…" in `packages/cli/test/clean.test.ts`.
- `cappy clean <ses-id>` removes the session and warns with the IDs of replay captures that referenced it, which remain (same replay test).
- The selectors pick exactly the SPEC 11.7 sets. `--failed` selects a failed capture and its failed scenario session, a cancelled session, an orphaned `active` session, and a manifest-less capture directory, and leaves a succeeded capture and a completed session alone. `--logs` selects only logs. `--all` selects captures, sessions, and logs, leaving an empty registry. `--older-than 7d` selects nothing at first and everything once the clock is 8 days ahead, and `-f -ot 7d` then selects nothing. A missing selector, IDs with `--older-than`, `7x`, `0d`, and `-1d` each exit 2 with `USAGE_INVALID`.
- `--dry-run` (`--all -dr`) leaves every file under the managed root, including the registry, byte-for-byte unchanged (snapshot comparison). Its report equals the report of the real run that follows.
- Safety: an edited manifest (`modified_since_managed_write`), a master replaced by a real symlink (`symlink`, and the link target is untouched), an unregistered `.partial` file and a file registered as external (both kept as `not_managed`), and an unknown ID (`not_found`) are never deleted. The command exits 1 with `CLEAN_INCOMPLETE` and still removes every other selected file.
- With a live run lock: the lock's active session named explicitly is refused (`in_progress`). `--all` skips that session, a manifest-less capture directory, and the lock's log, with a warning, and all three remain.
- Retired takes: after take 1 is cleaned, `--take 1` fails with `TAKE_EXISTS` (`retired: true`), and after take 2 is also cleaned, the next capture is take 3. A version 1 registry is read and written as version 2 with `retiredTakes` when a take is retired (CLI test plus a workspace unit test). Registry changes now apply to the on-disk registry, so two workspace instances keep each other's entries and retired takes, and take allocation reads retired takes from disk.
- Empty item directories are removed (for example the interrupted capture's directory). Unregistered leftovers stay, with their directory, reported as `not_managed`.
- Docs: `docs/cli.md` (the command and its options), `docs/storage.md` (the new "`cappy clean`" section, registry version 2, retired takes), and `README.md`. SPEC 7.1 and 11.7 now also record on-disk registry updates, the `--failed` rule for unreadable manifests, and the report returned as `data` on `CLEAN_INCOMPLETE`.

Validation (macOS):

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 215 passed, 10 skipped (opt-in real-tool and OBS tests).
- `git diff --check`: passed.
- Real binary: `node packages/cli/bin/cappy.js clean -a -dr` printed "Nothing to clean." (exit 0), and `clean cap_nope` exited 1 with `CLEAN_INCOMPLETE`.
- Real-tool runs: not required, because this ticket touches neither FFmpeg nor Godot. CAP-016 exercises clean on real captures.
