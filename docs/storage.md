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
  logs/<correlation-id>.jsonl   one structured log per command
  cache/running/                run locks for in-flight commands
```

Add `.cappy/` to `.gitignore`. `cappy doctor` warns when it is not ignored; Cappy never edits `.gitignore` itself.

## Ownership

`cappy-workspace.json` records every managed file by root-relative path with its SHA-256 and size, plus imported and external files by absolute path.

- **Managed**: created by Cappy (sessions, masters, derivatives, manifests, logs). Only these can be deleted.
- **Imported/external**: referenced by Cappy but owned by you or another system. Never deleted.

Writes are atomic and never overwrite: a file is written to a temporary sibling and linked into place only if the target does not exist. OBS writes masters into its own recording directory; Cappy moves each verified master it requested into the workspace.

If `cappy-workspace.json` is corrupt, Cappy refuses to open the workspace rather than guess ownership.

## Cleanup rules

Cleanup (`ManagedWorkspace.remove` in `@cappy/workspace`) deletes only explicitly listed files, and reports exactly what happened:

- a registered managed file inside the root is removed;
- a missing file is reported as missing and dropped from the registry;
- anything else is rejected and left in place: imported or external files, unregistered files, paths outside the root, paths through a symlink or junction, and files whose SHA-256 or size changed since Cappy wrote them.

Cleanup never runs as a side effect of a capture. V1 exposes it as a library primitive; there is no bulk `cappy clean` command yet.

## Interrupted commands

`record`, `run`, and captured `replay` hold a run lock while they may leave a session `active`. The next such command marks sessions left `active` by a command that is no longer running as `failed`, with a warning. A capture interrupted before its manifest was written has no manifest, so it is never counted as successful. Locks from other machines are never treated as dead.

## Secrets

The OBS password is read from the environment variable named by `obs.passwordEnv` and used only to authenticate. It is never written to configuration, sessions, manifests, or logs; Cappy refuses to write a manifest that contains it.
