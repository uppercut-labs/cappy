# Managed storage and cleanup

Cappy keeps everything it generates in one managed workspace per project and deletes only files it can prove it created.

## Where things go

The default root is `.cappy/` in the project. Set `workspace.root` in `cappy.config.json` to use another directory. Cappy refuses a root that is a filesystem root, the home directory or one of its ancestors, or the project directory or one of its ancestors.

```text
.cappy/
  cappy-workspace.json          ownership registry
  sessions/<session-id>/
    session.json                session metadata (freeform or scenario)
    replay.bin                  adapter replay payload, byte-for-byte
    timeline.json               events from a freeform recording
    master.<ext>                OBS master from `record --capture`
  captures/<capture-id>/
    master.<ext>                verified OBS master
    <role>.mp4|.jpg|.png        derivatives
    manifest.json               succeeded, failed, or cancelled
  comparisons/<comparison-id>/
    triptych.mp4                A | B | amplified difference
    frames.json                 per-frame SSIM and PSNR
    worst-<n>-a|b|diff.png      A, B, and difference at the worst moments
    manifest.json               succeeded, regressed, or failed
  logs/<correlation-id>.jsonl   one structured log per command
  cache/running/                run locks for in-flight commands
```

Add `.cappy/` to `.gitignore`. `cappy doctor` warns when it is not ignored; Cappy never edits `.gitignore` itself.

## Ownership

`cappy-workspace.json` records every managed file by root-relative path with its SHA-256 and size, plus imported and external files by absolute path. Since registry version 2, it also records retired take numbers (see below). A version 1 registry is upgraded the next time Cappy changes it, and older Cappy builds refuse a version 2 registry rather than reissue takes. Each change is applied to the registry as it is on disk at that moment, so commands running at the same time never drop each other's entries.

- **Managed**: created by Cappy (sessions, masters, derivatives, manifests, logs). Only these can be deleted.
- **Imported/external**: referenced by Cappy but owned by you or another system. Never deleted.

Writes are atomic and never overwrite: a file is written to a temporary sibling and linked into place only if the target does not exist. OBS writes masters into its own recording directory; Cappy moves each verified master it requested into the workspace.

If `cappy-workspace.json` is corrupt, Cappy refuses to open the workspace rather than guess ownership.

## Cleanup rules

`cappy clean` (below) and the library primitive behind it, `ManagedWorkspace.remove` in `@cappy/workspace`, delete only explicitly selected files, and report exactly what happened:

- a registered managed file inside the root is removed;
- a missing file is reported as missing and dropped from the registry;
- anything else is rejected and left in place: imported or external files, unregistered files, paths outside the root, paths through a symlink or junction, and files whose SHA-256 or size changed since Cappy wrote them.

Cleanup never runs as a side effect of a capture.

## `cappy clean`

```bash
cappy clean --failed --dry-run           # preview: failed, cancelled, and interrupted leftovers
cappy clean --failed                     # remove them
cappy clean cap_… ses_…                  # remove specific captures or sessions
cappy clean --older-than 30d             # everything older than 30 days
cappy clean --logs --older-than 7d       # old command logs only
cappy clean --all                        # every capture, session, comparison, and log
```

`clean` deletes as soon as it runs. `--dry-run` (`-dr`) runs the same selection and checks and changes nothing.

What each item covers:

- **Capture** (`cap_…`): everything Cappy wrote in `captures/<id>/`. A scenario capture also removes the scenario session it created.
- **Session** (`ses_…`): everything in `sessions/<id>/`. Replay captures of the session are kept, and a warning names them, because they can no longer be re-captured.
- **Comparison** (`cmp_…`): everything in `comparisons/<id>/`. The compared captures are never touched.
- **Log** (`--logs`): `logs/<correlation-id>.jsonl`.

Cleaning a capture never removes a session you recorded with `cappy record`.

Selectors:

- `--failed` selects captures whose manifest is `failed` or `cancelled`, capture directories with no manifest (interrupted jobs), sessions that are `failed` or `cancelled`, sessions left `active` by a command that is no longer running, and comparisons that `failed` or never wrote a manifest. A `regressed` comparison is a result, so `--failed` keeps it.
- `--logs` selects every command log.
- `--all` selects every capture, session, comparison, and log.
- `--older-than <age>` keeps only items older than `90m`, `12h`, `7d`, `2w`, and so on. On its own it applies to everything.

IDs and selectors combine, but `--older-than` works only with selectors. The registry and `cache/` are never touched.

What is protected:

- Anything a running command may still be writing is left alone: its `active` session, capture and comparison directories without a manifest while any command runs, and its log. Naming one refuses it; bulk selectors skip it with a warning.
- Files Cappy did not create in an item's directory, such as an interrupted `.partial` output, are kept and reported as `not_managed`, and that directory stays.
- A managed file that was edited or replaced by a link is refused.
- Any refusal makes the command exit 1 with `CLEAN_INCOMPLETE`. Everything else selected is still removed, and the full report is in the result.

Take numbers are never reissued. Cleaning a successful capture retires its take in the registry before any file is deleted. The next capture of that scenario (with the same parameters) or replayed session continues past it, and `--take <retired>` fails with `TAKE_EXISTS`.

## Interrupted commands

`record`, `run`, and captured `replay` hold a run lock while they may leave a session `active`, and `compare` holds one while it runs. The next such command marks sessions left `active` by a command that is no longer running as `failed`, with a warning. A capture interrupted before its manifest was written has no manifest, so it is never counted as successful. Locks from other machines are never treated as dead.

## Secrets

The OBS password is read from the environment variable named by `obs.passwordEnv` and used only to authenticate. It is never written to configuration, sessions, manifests, or logs; Cappy refuses to write a manifest that contains it.
