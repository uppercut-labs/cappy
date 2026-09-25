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
| `-p, --preset <name>` | Capture preset (default: `defaultPreset`, or a master-only preset). See [presets.md](presets.md) for derivatives and event anchors. |
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

## `cappy compare <capture-a> <capture-b>`

Compares two successful captures of the same source. Usually these are replay captures of one session, made with two game builds. A is the reference.

```bash
cappy replay ses_…                       # with build 1
cappy replay ses_…                       # with build 2
cappy compare cap_A cap_B --min-ssim 0.97
```

| Option | Meaning |
| --- | --- |
| `-ms, --min-ssim <score>` | Record the comparison as `regressed`, and exit 1 with `COMPARISON_REGRESSED`, when mean SSIM is below this score (0 to 1). Without it, scores are informational. |

What `compare` does:

- Both captures must be `succeeded` and share a source: the same replayed session, or the same scenario with the same parameters. Their masters must still match their manifests. Anything else is refused before any media work: `COMPARE_INCOMPATIBLE` or `COMPARE_INPUT_INVALID` (exit 1), and `CAPTURE_NOT_FOUND` or `USAGE_INVALID` (exit 2).
- Each capture's `SCENARIO_STARTED` or `REPLAY_STARTED` is time zero. The compared span is the shorter of the two operations.
- B is scaled to A's size, and both are sampled at A's frame rate.
- Results go under `comparisons/<cmp-id>/`:
  - `triptych.mp4`: A, B, and their difference amplified four times, side by side;
  - `frames.json`: per-frame SSIM and PSNR;
  - `manifest.json`.
- It needs FFmpeg and ffprobe, and exits 4 without them. It never launches the game or touches OBS.
- A warning notes when both captures report the same game build, or neither reports one.

`data` carries the comparison ID, `status` (`succeeded`, `regressed`, or `failed`), both captures with their aligned starts, `alignment`, `normalization`, `scores` (SSIM mean, min and its time; PSNR mean and min, `null` when every frame is identical), the artifacts, and the manifest path. A failed FFmpeg run exits 1 with `COMPARISON_FAILED` and leaves only a `failed` manifest.

## `cappy clean [<id>...]`

Deletes captures, sessions, comparisons, and logs that Cappy created, at once. See [storage.md](storage.md#cappy-clean) for exactly what each item covers and what is protected.

| Option | Meaning |
| --- | --- |
| `<id>...` | Capture (`cap_…`), session (`ses_…`), or comparison (`cmp_…`) IDs. |
| `-f, --failed` | Failed, cancelled, and interrupted captures, sessions, and comparisons. |
| `-l, --logs` | Every command log. |
| `-a, --all` | Every capture, session, comparison, and log. |
| `-ot, --older-than <age>` | Only bulk-selected items older than an age such as `90m`, `12h`, `7d`, or `2w`. Alone, it applies to `--all`. It cannot be combined with IDs. |
| `-dr, --dry-run` | Report what would be removed and change nothing. |

`data` reports `items` (ID, kind, files, bytes), `removed`, `missing`, `refused`, `kept`, `skipped`, `retiredTakes`, and `bytesFreed`. With `--dry-run`, `removed` and `bytesFreed` describe what would happen. A refused file or ID makes the command exit 1 with `CLEAN_INCOMPLETE`, after everything else selected has been removed. A command with no selector, or with `--older-than` and IDs, exits 2.

## Logs and correlation

`record`, `run`, and `replay` write `logs/<correlation-id>.jsonl` in the managed workspace. The same correlation ID is in the JSON result, the session, the manifest, and every timeline event.
