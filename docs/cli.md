# Cappy CLI

```text
cappy <command> [options]
```

Run from a project directory containing `cappy.config.json`, or pass `-C <dir>`. The upcoming public npm package is `@uppercut-labs/cappy`; it is not published yet. After release, install it with `npm install --global @uppercut-labs/cappy` and run `cappy`, or use `npx @uppercut-labs/cappy`. Contributors should build the checkout with `npm run build` and invoke `node packages/cli/bin/cappy.js <command>` from the repository root.

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
| `-ms, --min-ssim <score>` | Gate: the mean SSIM must be at least this score (0 to 1). |
| `-mfs, --min-frame-ssim <score>` | Gate: every frame's SSIM must be at least this score, which catches a glitch lasting a few frames. |
| `-mdm, --max-drift-ms <ms>` | Gate: no matched game event may drift more than `ms` either way. |
| `-rse, --require-same-events` | Gate: every game event type must occur equally often in A and B. |

Without gates, scores and the timeline diff are informational, and a completed comparison exits 0. If any gate fails, the comparison is recorded as `regressed` and exits 1 with `COMPARISON_REGRESSED`, whose details list the failed gates. The manifest (`comparisonVersion: 2`) records the `gates` given and the `failedGates`. A value out of range fails with `USAGE_INVALID` (exit 2) before any media work.

What `compare` does:

- Both captures must be `succeeded` and share a source: the same replayed session, or the same scenario with the same parameters. Their masters must still match their manifests. Anything else is refused before any media work: `COMPARE_INCOMPATIBLE` or `COMPARE_INPUT_INVALID` (exit 1), and `CAPTURE_NOT_FOUND` or `USAGE_INVALID` (exit 2).
- Each capture's `SCENARIO_STARTED` or `REPLAY_STARTED` is time zero. The compared span is the shorter of the two operations.
- B is scaled to A's size, and both are sampled at A's frame rate.
- Results go under `comparisons/<cmp-id>/`:
  - `triptych.mp4`: A, B, and their difference amplified four times, side by side;
  - `frames.json`: per-frame SSIM and PSNR;
  - `worst-<n>-a.png`, `worst-<n>-b.png`, and `worst-<n>-diff.png`: A, B, and the difference at up to three lowest-SSIM moments, at least a second apart (`n` = 1 is the worst). Each shows the frame at or before the moment;
  - `manifest.json`.
- A timeline diff compares the adapter events of the two captures, by type and in order of occurrence, with times measured from each aligned start. For each type it reports the counts in A and B, the occurrences missing from B or extra in B, and the mean and largest drift (B's time minus A's). A count difference adds a warning. The timeline diff never changes the status or exit code; only `--min-ssim` does.
- It needs FFmpeg and ffprobe, and exits 4 without them. It never launches the game or touches OBS.
- FFmpeg runs inside the comparison directory. On Windows, an FFmpeg wrapper script (`.cmd`) cannot run in a network-share (UNC) directory, so use `ffmpeg.exe` itself when the managed root is on a share.
- A warning notes when both captures report the same game build, or neither reports one.

`data` carries:

- the comparison ID and `status` (`succeeded`, `regressed`, or `failed`);
- both captures, with their aligned starts;
- `alignment` and `normalization`;
- `scores`: SSIM mean, minimum, and the minimum's time; PSNR mean and minimum, which are `null` when every frame is identical;
- `worstFrames` and `timelineDiff`;
- the artifacts, and the manifest path. A failed FFmpeg run exits 1 with `COMPARISON_FAILED` and leaves only a `failed` manifest.

## Named builds and `--build`

`builds` in `cappy.config.json` names alternative launch commands for the game, for example two exports of it, or the same project with different arguments:

```json
"game": { "command": "godot", "args": ["--path", "/games/demo"] },
"builds": {
  "v1": { "game": { "args": ["--path", "/builds/v1"] } },
  "v2": { "game": { "command": "/builds/v2/Demo.x86_64", "args": [] } }
}
```

- Each field a build gives (`command`, `args`, `cwd`) replaces the base `game`'s field.
- `-b, --build <name>` on `run`, `replay`, `record`, and `scenarios` launches that build. `base` means the plain `game`, and no build may be named `base`.
- An unknown build fails with `BUILD_NOT_FOUND` (exit 2) before anything launches.
- A capture's manifest records the build as `build.name`, next to the `gameBuild` the adapter reports.
- `doctor` checks every build's command (`game.<name>`).

## `cappy compare-builds <session | scenario> <build-a> <build-b>`

Captures the same moment with two builds, then compares them:

```bash
cappy compare-builds ses_… v1 v2 --min-ssim 0.97 --require-same-events
cappy compare-builds boss_intro base v2 -pa difficulty=3
```

- A session ID (`ses_…`) is replay-captured with each build. Anything else is a scenario, run with each build and the given `--param` values.
- `--preset` applies to both captures, and the comparison gates (`-ms`, `-mfs`, `-mdm`, `-rse`) apply to the comparison.
- Each step is the ordinary command, so the result is two captures and a comparison, each with its own manifest.
- `data` holds `builds`, `a`, `b`, and `comparison`. The exit code is the comparison's (0, or 1 when it regresses).
- The first failed capture stops the command, with that capture's error and exit code.
- The two build names must differ, and `--build` and `--no-capture` do not apply.

## `cappy timeline export <capture-id | session-id>`

Exports a timeline for other tools:

```bash
cappy timeline export cap_… -fo vtt -o events.vtt   # captions over the capture's video
cappy timeline export cap_… -fo csv > events.csv
cappy timeline export ses_…                          # JSON on standard output
```

| Option | Meaning |
| --- | --- |
| `-fo, --format <format>` | `json` (the default), `csv`, or `vtt`. |
| `-o, --out <path>` | Write a new file (relative to the project) instead of standard output. An existing file is never overwritten (`EXPORT_TARGET_EXISTS`). |

The formats:

- A capture's timeline is on the master clock, so it lines up with its video. A session's timeline is on the session's clock.
- **JSON**: `{ timelineExportVersion, source, clock, sync?, events }`. It is described by [schemas/timeline-export.schema.json](schemas/timeline-export.schema.json), and each event by [schemas/timeline-event.schema.json](schemas/timeline-event.schema.json). Both are generated from Cappy's runtime schemas by `npm run schemas`.
- **CSV**: `seq,t_ms,type,source,duration_ms,id,payload`, RFC 4180 quoting, and the payload as compact JSON.
- **WebVTT**: one cue per event, lasting its `durationMs` or one second, whichever is longer. The cue is identified by the event ID, and its text is the event type followed by its payload as `key=value` pairs. Load it as subtitles in a player, or pass it to FFmpeg.

Export files belong to you: Cappy never registers, overwrites, or deletes them. With `--json`, `data` carries the format, source, event count, and either the `content` or the `path`.

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
