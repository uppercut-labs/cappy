# Cappy CLI

```text
cappy <command> [options]
```

Run from a project directory containing `cappy.config.json`, or pass `-C <dir>`. Build once with `npm run build`; `npx cappy` then resolves the workspace binary.

## Global options

| Option | Meaning |
| --- | --- |
| `-j, --json` | Print exactly one JSON document on stdout. Progress text is suppressed; nothing contains ANSI escapes. |
| `-C, --project <dir>` | Project directory (default: the current directory). |
| `-c, --config <path>` | Configuration file, relative to the project (default: `cappy.config.json`). |
| `-h, --help` | Show help. |
| `-v, --version` | Show the Cappy version. |

### Shorthands

Every flag has a shorthand, and each shorthand is one whole token:

- A multi-word flag uses its initials, so `--no-capture` is `-nc`.
- A one-word flag uses its first letter, or its first two letters when the first letter is taken. For example, `--preset` is `-p` and `--param` is `-pa`.
- `-C` is kept for `--project`.

Shorthands never group: `-nc` is not `-n -c`, and `-jh` is an error. A value follows as the next argument (`-pa difficulty=3`) and is never translated, even when it starts with `-`. An unknown shorthand fails with `USAGE_INVALID` (exit 2).

```bash
cappy run boss_intro -pa difficulty=3 -p trailer -t 4 -j
```

## Result envelope

Every command returns the same envelope, printed as JSON with `--json`:

```json
{
  "schemaVersion": 1,
  "command": "run",
  "correlationId": "op_…",
  "ok": true,
  "data": { },
  "warnings": []
}
```

On failure, `ok` is `false` and `error` carries `code`, `message`, `operation`, bounded `details`, and `retryable` when known. `data` may still carry partial results, such as doctor checks or the state a capture reached.

| Exit code | Meaning |
| --- | --- |
| 0 | success |
| 1 | operation failed |
| 2 | invalid usage (bad flags, unknown session, existing take, invalid parameters) |
| 3 | invalid or missing configuration |
| 4 | missing or unusable external dependency (game command, FFmpeg, OBS) |
| 70 | internal error |
| 130 | cancelled |

## `cappy doctor`

Checks configuration, the managed workspace, the game command, FFmpeg/ffprobe, and OBS without launching the game or recording. Each check reports `pass`, `warn`, `fail`, or `skip`:

`config`, `workspace.root`, `workspace`, `workspace.gitignore`, `game`, `ffmpeg`, `ffprobe`, `obs`, `obs.scenes`

Warnings (such as an un-ignored `.cappy/`) do not fail doctor. OBS is only read (`GetVersion`, `GetSceneList`).

## `cappy scenarios`

Launches the game, completes the handshake, and lists registered scenarios with their parameter schemas and required capabilities, plus the adapter's identity, build, and capabilities. Nothing is recorded. The game is stopped afterwards.

## `cappy run <scenario>`

Captures an authored scenario.

| Option | Meaning |
| --- | --- |
| `-pa, --param key=value` | Scenario parameter; repeatable. Parsed and validated against the adapter's schema; defaults are applied. |
| `-p, --preset <name>` | Capture preset (default: `defaultPreset`, or a master-only preset). |
| `-t, --take <n>` | Explicit take number. Fails with `TAKE_EXISTS` if that take already succeeded. |

Pipeline: preflight (config, preset options, FFmpeg/ffprobe, workspace, OBS scene and idle state) before the game launches; scenario and parameter validation; take allocation; scenario session record; `ready`; confirmed OBS start; scenario start; events; completion; confirmed OBS stop; verified master moved into `captures/<capture-id>/`; ffprobe; derivatives; manifest. `data.state` is `succeeded` only when everything passed. Ctrl+C cancels (exit 130) and stops the recording Cappy started.

## `cappy record`

Records a freeform, replayable session while you play.

| Option | Meaning |
| --- | --- |
| `-d, --duration <seconds>` | Stop automatically. |
| `-ca, --capture` | Also record an OBS master into the session. |
| `-p, --preset <name>` | Preset whose scene `--capture` uses. |

Press Enter to stop and keep the session; Ctrl+C cancels it (status `cancelled`, exit 130). The adapter's replay payload is stored byte-for-byte in `sessions/<session-id>/replay.bin`.

## `cappy replay <session-id>`

Captures a stored session's replay through the same pipeline as `run`, with a manifest whose source is the replayed session. Options: `-p, --preset`, `-t, --take`, and:

| Option | Meaning |
| --- | --- |
| `-nc, --no-capture` | Play the session back without OBS or FFmpeg, to verify it. |

Before anything launches, the stored payload must still match its SHA-256 and the session must belong to this project. After the handshake, the adapter must match the recording adapter and advertise the capabilities the replay needs (`replay`, plus `deterministic_replay` when the recording had it). A different game build only warns.

## Logs and correlation

`record`, `run`, and `replay` write `logs/<correlation-id>.jsonl` in the managed workspace. The same correlation ID is in the JSON result, the session, the manifest, and every timeline event.
