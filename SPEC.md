# Cappy Implementation Specification

**Status:** Build-ready  
**Version:** 0.3 (V1 plus the post-V1 increments in section 25)\
**Date:** 2026-09-25  
**Context:** [Context.md](Context.md)  
**Decisions:** [ADR.md](ADR.md)  
**Deferred work:** [Ideas.md](Ideas.md)  
**Living model:** [docs/system-model.dot](docs/system-model.dot)

## 1. Objective

Cappy is a local, reusable developer system for reproducible game capture.

It connects an instrumented game to a controller that can:

- request authored scenarios;
- record freeform replayable sessions;
- replay prior sessions;
- receive semantic game events;
- synchronize OBS recording with game lifecycle events;
- create media derivatives with FFmpeg;
- write inspectable manifests and hashes for every successful capture.

The first production adapter is Godot, but no core package may depend on Godot-specific types or behavior.

## 2. V1 success criteria

V1 is successful when all of the following are true:

1. On Windows and macOS, a developer can initialize/configure a project and run `cappy doctor`.
2. A deterministic fixture adapter can complete the full scenario flow without OBS by using test doubles.
3. A real Godot fixture can connect over the local protocol, register a scenario, run it, emit timeline events, and return completion.
4. Cappy can record a freeform session and persist an adapter-owned replay payload without interpreting the payload.
5. Cappy can later request replay of that stored session.
6. With OBS running and configured, Cappy can start and stop recording around a scenario or replay and verify the resulting master file.
7. Cappy can invoke ffprobe/FFmpeg to validate the master and create configured derivatives.
8. Every successful capture produces a machine-readable manifest with project, source, timing, capability, tool, file, ownership, and hash information.
9. Failure paths do not publish a capture as successful or delete files Cappy does not own.
10. The CLI has stable human-readable behavior and a structured JSON mode suitable for agents/scripts.
11. Automated tests exercise protocol validation, state transitions, managed-file safety, subprocess failure, OBS failure, and end-to-end fixture flows.

## 3. V1 non-goals

- Desktop GUI.
- Video editing timeline.
- OBS scene/profile authoring.
- Direct FFmpeg/window capture as a recorder.
- Cloud account, remote worker, or distributed capture.
- Linux acceptance. (Post-V1, Linux is a supported host with real OBS capture unverified; see section 21.)
- Unity/Unreal/native/emulator production adapters.
- Cross-build visual regression comparison. (Post-V1, `cappy compare` compares two existing captures, section 11.8; Cappy still does not switch builds itself.)
- Universal replay encoding.
- AI gameplay analysis.
- Automatic cinematic camera creation.
- Trailer editing beyond deterministic capture and configured media derivatives.

## 4. Technology

### 4.1 Core

- Node.js LTS.
- TypeScript with strict type checking.
- npm workspaces.
- ESM unless a dependency forces a bounded compatibility exception.
- JSON Schema or an equivalent runtime schema system for external/config/protocol validation.
- Vitest for unit/integration tests.
- A subprocess abstraction for game, FFmpeg, and test-fixture process control.

### 4.2 External dependencies

- OBS Studio with OBS WebSocket available.
- FFmpeg and ffprobe available on PATH or through configured executable paths.
- A configured game executable/editor command.
- Adapter-specific runtime requirements.

Cappy must not silently download or mutate external tools in V1.

## 5. Intended repository structure

```text
packages/
  protocol/
  core/
  cli/
  obs/
  media/
  workspace/
adapters/
  godot/
fixtures/
  adapter-simulator/
  godot-demo/
docs/
  system-model.dot
tests/
  integration/
Context.md
ADR.md
Ideas.md
SPEC.md
cappy.config.example.json
tickets/
```

Exact internal filenames may vary without changing product behavior.

## 6. Project configuration

A project stores source-controlled configuration outside `.cappy/`.

Default filename:

```text
cappy.config.json
```

Required conceptual fields:

- schema/config version;
- project ID/name;
- game launch command and arguments;
- optional working directory;
- adapter connection expectations;
- default artifact root or project-local default;
- OBS connection settings that are safe to store;
- expected OBS scene name when capture is used;
- FFmpeg/ffprobe executable overrides;
- capture presets;
- timeouts.

Secrets such as an OBS WebSocket password must be supplied through environment variables or an untracked local override mechanism and must never be written into manifests. In V1, `obs.passwordEnv` names the environment variable that holds the OBS password; a literal `obs.password` is rejected by config validation.

`adapter.port` may be `0` to let each launch pick a free loopback port.

Named builds (post-V1). `builds` maps a build name (same syntax as a preset name) to a `game` override: `{ "builds": { "v1": { "game": { "args": [...] } }, "v2": { "game": { "command": "...", "args": [...] } } } }`. Each field a build gives (`command`, `args`, `cwd`) replaces that field of the base `game`; the others come from the base. `run`, `replay`, `record`, and `scenarios` accept `--build <name>` (`-b`) to launch that build instead of the base game; an unknown name fails with `BUILD_NOT_FOUND` (exit 2) before anything launches. `doctor` checks the base game command and every build's command (check IDs `game` and `game.<name>`). Without `--build`, the base `game` is used, exactly as in V1.

Configuration validation fails before launching capture work when a required field is invalid.

## 7. Managed workspace and ownership

Default root:

```text
<project>/.cappy/
```

Recommended semantic layout:

```text
.cappy/
  sessions/
  captures/
  comparisons/
  cache/
  logs/
```

The physical structure may evolve, but ownership is mandatory.

### 7.1 Ownership classes

- `managed`: created by Cappy and eligible for explicit Cappy cleanup.
- `imported`: provided/referenced by the user and never deleted by Cappy.
- `external`: owned by another system and never deleted by Cappy.

Every file Cappy may delete must be provably managed by metadata associated with the current workspace.

Path traversal outside the resolved managed root must be rejected for managed writes and cleanup.

Ownership is recorded in a registry file, `cappy-workspace.json`, at the managed root. It lists each managed file by root-relative path with its SHA-256 and byte size, and each imported/external reference by absolute path. If the registry is unreadable, Cappy refuses to open the workspace rather than guess ownership.

Registry schema version 2 adds `retiredTakes`: take numbers retired by cleanup, keyed by take source (section 16). A version 1 registry is read as having no retired takes and is written as version 2 on its next change.

Every registry change runs under an exclusive lock file, `cappy-workspace.json.lock`, created with no-clobber semantics. It is applied to the registry as it is on disk at that moment, not to a command's in-memory copy, so concurrent commands do not drop each other's entries or retired takes. A lock older than 10 seconds was left by a crashed command and is broken. Take allocation reads retired takes from disk.

Managed files are published atomically: written to a sibling temp file, then linked into place without overwriting. Replacing an existing managed file requires an explicit replace request; files Cappy did not create are never replaced.

Before deleting a managed file, cleanup verifies that no path component is a symlink or junction, that the file's real location is inside the managed root, and that its current SHA-256 and size still match the registry. A file modified since Cappy wrote it is reported as rejected and left in place.

### 7.2 Source control

Cappy should warn when the default `.cappy/` path is not ignored by Git. It must not edit `.gitignore` without explicit command/user action.

## 8. Core domain model

### Project

One configured game project using Cappy.

### Adapter Connection

One live connection between Cappy and an instrumented game instance.

### Capability Set

Adapter-declared capabilities for the current build/runtime.

Initial capability vocabulary:

- `scenarios`
- `freeform_recording`
- `replay`
- `deterministic_replay`
- `seek`
- `snapshots`
- `alternate_cameras`
- `time_scale` (post-V1: presentation slower or faster than real time)
- `telemetry`

Unknown future capabilities must not crash an older controller; unsupported required capabilities block the requested operation.

### Scenario

Game-owned named setup with:

- stable ID;
- display name;
- parameter schema;
- required capabilities;
- optional descriptive metadata.

### Session

One gameplay execution under Cappy.

Minimum metadata:

- ID;
- project;
- origin: `scenario` or `freeform`;
- scenario ID/parameters when applicable;
- start/end timestamps;
- adapter version/build identity;
- capability snapshot;
- replay payload reference when produced;
- completion status.

### Replay

An adapter-owned payload plus Cappy-owned envelope metadata.

Cappy may copy, hash, store, reference, and return the payload but must not interpret game-specific replay bytes.

### Comparison

One comparison of two successful captures of the same source, usually replay captures of one session made with two game builds (section 11.8). It has a comparison ID (`cmp_…`), references both captures without owning them, and stores its own outputs and manifest under `comparisons/<comparison-id>/`.

Statuses: `succeeded` (completed, and at or above any `--min-ssim` threshold), `regressed` (completed, below the threshold), and `failed`. A `regressed` comparison is a valid result, not an error in the comparison itself.

### Capture Job

One attempt to capture a scenario or replay.

States:

```text
created
  -> preflighting
  -> preparing_game
  -> ready
  -> recording
  -> finalizing
  -> processing
  -> succeeded

Any active state -> failed
Any user-cancellable active state -> cancelled
```

User-cancellable states are `created`, `preflighting`, `preparing_game`, `ready`, and `recording`. Once recording has stopped (`finalizing`, `processing`), the job runs to `succeeded` or `failed` so a verified master is never abandoned half-processed.

A job is not `succeeded` until the master and every required derivative/manifest check passes.

### Timeline Event

Normalized envelope:

- event ID;
- source;
- monotonic/session-relative timestamp;
- type;
- optional duration/end;
- optional adapter payload;
- optional correlation ID.

Cappy-defined lifecycle events and game-defined semantic events share the envelope but not necessarily a common event taxonomy.

### Artifact

A concrete file with:

- role;
- path;
- ownership class;
- media/type information;
- byte size;
- SHA-256;
- creation source/tool;
- optional duration/dimensions.

## 9. Local adapter protocol

### 9.1 Transport

- WebSocket.
- Bound to loopback only by default.
- Versioned JSON messages.
- One Cappy controller coordinates one active game connection per capture job in V1.
- Message schemas are validated at runtime.
- Cappy is the listener; the game adapter connects as a client. A launched game receives `CAPPY_ENDPOINT` and a random per-launch `CAPPY_SESSION_TOKEN`, which it echoes in its hello. Connections without the token are turned away (local-session isolation, ADR-010).
- The adapter-facing message reference is [docs/protocol.md](docs/protocol.md).

### 9.2 Handshake

The first valid adapter message identifies:

- protocol version range;
- adapter name/version;
- game/project identity;
- game build identity if available;
- capabilities.

Cappy chooses a compatible protocol version or closes with a clear incompatibility error. Protocol versions are integer majors; V1 implements version 1. Unknown hello fields are ignored so newer adapters can still negotiate.

### 9.3 Required operation families

The protocol must support:

- handshake/capability negotiation;
- scenario registration/listing;
- scenario prepare/start/cancel;
- freeform record start/stop;
- replay prepare/start/stop, optionally with presentation parameters (post-V1);
- timeline/event emission;
- completion/failure reporting;
- replay payload handoff by bounded file reference or bounded encoded payload;
- heartbeat/liveness sufficient to detect a dead adapter.

Large replay payloads should use managed file references rather than unbounded JSON blobs.

### 9.4 Ordering and timestamps

Cappy assigns/records receipt order. Adapter events include session-relative monotonic time when available. Wall-clock timestamps alone are insufficient for media synchronization.

Capture timelines are placed on the master's clock, measured on the controller's monotonic clock. `t = 0` is the moment OBS confirmed recording (`RECORDING_STARTED`). The adapter's operation clock starts at its `started` acknowledgement, so adapter events are shifted by `adapterOffsetMs` (confirmed-recording to started). Cappy adds `SCENARIO_STARTED`/`REPLAY_STARTED`, `SCENARIO_COMPLETED`/`REPLAY_COMPLETED`, and `RECORDING_STOPPED` lifecycle events, and renumbers `seq` in receipt order. The manifest's `timing.sync` records the reference, the offset, and `uncertaintyMs`, the gap between requesting and confirming the recording, within which the true first frame lies. Raw adapter times remain recoverable as `t - adapterOffsetMs`.

Presented time (post-V1). Adapter event times are presented time: milliseconds of what is shown on screen since the operation started, which is the recorder's clock. When presentation runs at a time scale other than 1 (slow motion), an adapter still reports presented time, so anchors, clips, and comparisons line up with the master at any speed. An adapter may add the simulation time to the event payload (for example `simT`). Before this rule, presented and simulated time were the same.

### 9.5 Failure

Malformed, schema-invalid, out-of-state, or incompatible messages fail the active operation with a structured protocol error. They must not be silently ignored when doing so could produce a false successful capture.

## 10. Godot adapter

The first production adapter is a reusable Godot 4.x addon.

It must:

- connect only to the configured local Cappy endpoint;
- perform version/capability handshake;
- expose an API for scenario registration;
- expose lifecycle methods/signals for freeform replay recording and replay playback;
- emit semantic timeline events;
- provide an adapter-owned replay storage interface;
- avoid requiring game code to know OBS or FFmpeg details.

Cappy does not prescribe a universal replay implementation inside Godot. The fixture implementation may use deterministic inputs/state suitable for demonstrating the contract.

V1 implementation: the addon is `adapters/godot/addons/cappy/` (autoload `Cappy`; API documented in `adapters/godot/README.md`). It stays inert unless launched by Cappy, validates scenario parameters against their specs before the game's own validation hook, sends `started` before invoking the game so events follow it, and quits a Cappy-launched game when the controller disconnects. Scripts use `preload` rather than `class_name` so a freshly assembled project runs without an editor import. The demo (`fixtures/godot-demo`) derives every event time from the 60 Hz physics tick. Because Godot cannot load files outside its project, `scripts/assemble-godot-demo.mjs` combines the demo and addon into a runnable directory.

## 11. CLI contract

### 11.1 Global behavior

Every command supports:

- human-readable default output;
- `--json` for structured output;
- stable non-zero exit on failure;
- no ANSI requirement in JSON mode.

Structured errors include at minimum:

- machine-readable error code;
- message;
- operation/command;
- relevant bounded details;
- whether retry is plausibly useful when known.

Every result, success or failure, is wrapped in one envelope carrying a result schema version, the command name, a correlation ID, `ok`, warnings, and either `data` or `error`.

Exit codes are stable:

| Code | Meaning |
| --- | --- |
| 0 | success |
| 1 | operation failed |
| 2 | invalid usage |
| 3 | invalid or missing configuration |
| 4 | missing or unusable external dependency |
| 70 | internal error |
| 130 | cancelled |

Every long flag has a whole-token shorthand:

- A flag made of several words uses their initials (`--dry-run` is `-dr`, `--no-capture` is `-nc`).
- A one-word flag uses its first letter. When two flags would share a shorthand, the less frequently used one takes its first two letters (`--preset` is `-p`, `--param` is `-pa`). `-C` for `--project` predates the rule and is kept.
- A shorthand is one token. `-dr` never means `-d -r`, and single-letter flags cannot be grouped.
- A shorthand's value follows as the next argument (`-ot 7d`). Option values are never translated, even when they start with `-`.
- An unknown shorthand fails with `USAGE_INVALID` (exit 2).
- A new flag must follow the rule without colliding with an existing shorthand.

| Flag | Shorthand | Flag | Shorthand |
| --- | --- | --- | --- |
| `--json` | `-j` | `--capture` | `-ca` |
| `--project <dir>` | `-C` | `--no-capture` | `-nc` |
| `--config <path>` | `-c` | `--duration <seconds>` | `-d` |
| `--help` | `-h` | `--dry-run` | `-dr` |
| `--version` | `-v` | `--failed` | `-f` |
| `--preset <name>` | `-p` | `--older-than <age>` | `-ot` |
| `--param <key=value>` | `-pa` | `--logs` | `-l` |
| `--take <n>` | `-t` | `--all` | `-a` |
| `--min-ssim <score>` | `-ms` | `--build <name>` | `-b` |
| `--min-frame-ssim <score>` | `-mfs` | `--max-drift-ms <ms>` | `-mdm` |
| `--require-same-events` | `-rse` | `--format <format>` | `-fo` |
| `--out <path>` | `-o` | | |

### 11.2 `cappy doctor`

Checks, without performing capture:

- configuration validity;
- workspace writability;
- managed-root safety;
- game launch command resolution where possible;
- FFmpeg/ffprobe availability and versions;
- OBS WebSocket reachability when OBS is configured;
- configured OBS scene existence;
- Graphviz is not a runtime dependency and is not part of doctor.

Returns per-check status and overall success. Each check has a stable ID (`config`, `workspace.root`, `workspace`, `workspace.gitignore`, `game`, `ffmpeg`, `ffprobe`, `obs`, `obs.scenes`) and a status of `pass`, `warn`, `fail`, or `skip`. Warnings, such as an un-ignored `.cappy/`, do not fail doctor. Any failed check makes the command fail (exit 4, or 3 when configuration itself is invalid), and the JSON result still carries every check. Doctor reads OBS state only (`GetVersion`, `GetSceneList`) and never changes it.

A managed root that is a filesystem root, the home directory or one of its ancestors, or the project directory or one of its ancestors is refused by every command.

### 11.3 `cappy scenarios`

Launches/connects to the configured game if required, performs handshake, and lists registered scenarios plus parameter/capability metadata.

No recording occurs. The game is launched with `CAPPY_ENDPOINT` and `CAPPY_SESSION_TOKEN` in its environment, and its process tree is stopped when the command finishes. A game that exits before connecting fails with `GAME_EXITED`; one that never connects fails with `ADAPTER_CONNECT_TIMEOUT` after `timeouts.connectMs`.

### 11.4 `cappy run <scenario>`

Workflow:

1. validate project and requested preset;
2. perform required preflight;
3. launch/connect game;
4. negotiate capabilities;
5. validate scenario and parameters;
6. request scenario preparation;
7. wait for ready;
8. start OBS recording and verify recording state;
9. request scenario start;
10. ingest timeline events;
11. on scenario completion, stop/verify OBS;
12. locate and verify the master;
13. process required derivatives;
14. write manifest;
15. mark capture succeeded.

A failure before successful recording must not create a successful capture. Partial data remains clearly marked failed/cancelled for diagnostics.

Scenario parameters are passed as repeated `--param key=value`, parsed and validated against the adapter-registered schema (type, enum, range, required), with schema defaults applied. `--preset` selects a capture preset (default: `defaultPreset`, or an empty implicit preset when none is configured).

### 11.5 `cappy record`

Starts a freeform session and asks the adapter to record replay data.

Default V1 behavior does **not** require OBS recording. Optional `--capture` runs the OBS master-capture path concurrently.

The operation ends when the developer requests stop, the adapter reports completion, or a fatal failure occurs.

A successful replayable session requires a valid replay payload when the adapter advertised replay support for the operation.

Operator controls: Enter stops the recording normally; `--duration <seconds>` stops it automatically; Ctrl+C (or SIGTERM) cancels it. A cancelled session is persisted with status `cancelled` and no replay payload, and the command exits 130. An adapter that advertises `replay` but completes without a payload fails the session with `REPLAY_PAYLOAD_MISSING`. An adapter without `replay` produces a completed, non-replayable session and a warning.

Sessions are stored under `sessions/<session-id>/` in the managed workspace: `session.json` (metadata), `replay.bin` (the adapter's payload, byte-for-byte), and `timeline.json` (normalized events). Inline payloads are decoded and verified against their SHA-256. File payloads must be an absolute path to a regular, non-symlink file whose size and SHA-256 match the handoff; Cappy copies them and never moves or deletes the adapter's file.

### 11.6 `cappy replay <session-id>`

Loads the stored session envelope and replay payload, validates the current adapter's relevant capabilities, launches/connects to the game, and requests replay.

By default this command performs capture through OBS using the selected/default capture preset. A `--no-capture` mode may be used for replay verification/debugging.

If the current adapter/build cannot satisfy capabilities required by that replay, fail before recording.

Compatibility rules, all checked before the payload reaches the adapter:

- The stored payload must still match its recorded SHA-256 and size (`REPLAY_PAYLOAD_INVALID` otherwise); this is checked before the game is launched.
- The session must belong to the configured project and have been recorded by the same adapter name (`REPLAY_INCOMPATIBLE`).
- A replay requires `replay`, plus `deterministic_replay` when the recording adapter advertised it (`CAPABILITY_MISSING`).
- A different game build is allowed with a warning; replay fidelity across builds is the adapter's responsibility (ADR-008).

Payloads up to 1 MiB are returned inline; larger ones are handed over as a path inside the managed root.

A captured replay runs through the same pipeline as `cappy run`: preflight (including the session and payload checks above) before the game launches, a confirmed OBS start before playback, a confirmed stop, a verified master, derivatives, and a manifest whose source is `{ "kind": "replay", "sessionId": ... }` and whose `identity.sessionId` is the replayed session. `--no-capture` plays the session back without OBS or media tools.

### 11.7 `cappy clean`

```text
cappy clean [<id>...] [--failed] [--older-than <age>] [--logs] [--all] [--dry-run]
```

Deletes selected managed items immediately and reports exactly what happened. `--dry-run` resolves the same selection, performs the same ownership and hash checks, reports the predicted outcome, and changes nothing: no file, no directory, no registry entry, no retired take. `clean` never creates a missing workspace; with none, nothing is selected. Cleanup never runs as a side effect of another command.

Selection:

- Explicit targets are item IDs: captures (`cap_…`), sessions (`ses_…`), and comparisons (`cmp_…`). Raw paths are not accepted. An ID that is not in this workspace is refused with reason `not_found`.
- `--failed` selects every capture whose manifest status is `failed` or `cancelled`, every capture directory without a manifest (an interrupted job), every session with status `failed` or `cancelled`, every orphaned `active` session (one no live command owns), every comparison with status `failed`, and every comparison directory without a manifest. A `regressed` comparison is a result and is not selected. A capture whose manifest cannot be read is never selected by `--failed`; a warning names it, and it can still be cleaned by ID or with `--all`.
- `--logs` selects every command log in `logs/`.
- `--all` selects every capture, session, comparison, and log.
- `--older-than <age>` keeps only bulk-selected items created more than `<age>` ago. `<age>` is a positive integer followed by `m`, `h`, `d`, or `w` (minutes, hours, days, weeks), for example `90m` or `7d`. On its own it filters `--all`. Combined with explicit IDs it fails with `USAGE_INVALID`.
- IDs and bulk selectors combine as a union. A command with no selector fails with `USAGE_INVALID`.
- Item age comes from a capture's manifest `timing.startedAt`, a session's `startedAt`, and a comparison manifest's `createdAt`. Items without these (a manifest-less directory or a log) use the earliest registry `createdAt` among their files.
- The registry, `cache/` (run locks), and anything outside `sessions/`, `captures/`, `comparisons/`, and `logs/` are never selected.
- Only directories named like Cappy's own IDs (`cap_<uuid>`, `ses_<uuid>`, `cmp_<uuid>`) are items. Anything else someone puts in those areas is never selected.

What an item includes:

- A capture: every managed file under `captures/<id>/`. A scenario capture also includes the scenario session its manifest names in `identity.sessionId`, when that session's origin is `scenario`. Cleaning a capture never removes a replayed session.
- A session: every managed file under `sessions/<id>/`. Replay captures of that session are kept, and the result warns with their IDs, because they can no longer be re-captured.
- A comparison: every managed file under `comparisons/<id>/`. The compared captures are kept.
- A log: `logs/<correlation-id>.jsonl`.

In-progress protection. An item is in progress when any run lock is live on this host, or any lock from another host exists, and the item is one of these: an `active` session (any live command may be writing or reconciling it), a capture or comparison directory without a manifest, or the log of a command that holds a lock.

Link protection. An item whose directory is reached through a symbolic link or junction, or whose real location is outside the managed root, is refused with reason `symlink` or `escapes_root`. That applies whether it was named or bulk-selected, and whether the link is on the item itself or on its storage area. Such an item is never walked, emptied, or deleted, and never retires a take. Within an item, links are listed as kept files and never followed. An explicitly named item that is in progress is refused with reason `in_progress`. Bulk selectors skip in-progress items with a warning.

Deletion follows the workspace cleanup rules in sections 7.1 and 17. Each managed file is removed, reported missing, or refused with a reason. Once an item's managed files are gone, Cappy removes any of its directories that are left empty. Unregistered files in an item's directory, such as the `.partial` output of an interrupted job, are kept and reported with reason `not_managed`, and their directory stays.

Retiring takes. Removing a `succeeded` capture retires its take for its source (section 16). The take is recorded in the registry before any file is removed, so a failure part-way never frees the take number for reuse.

Result data: `dryRun`, the selected `items` (ID, kind, files, bytes), `removed`, `missing`, `refused` (target and reason), `kept` (path and reason), `skipped` (ID and reason), `retiredTakes`, and `bytesFreed`. Human output summarizes the same report.

Exit: 0 when nothing was refused. When any selected file or explicit ID was refused, every other selected file is still removed, and the command exits 1 with `CLEAN_INCOMPLETE`. The result still carries the full report as `data`, and the error details list the refused targets. Missing files are not failures. Kept unregistered files and skipped in-progress items are warnings.

`clean` does not write a command log.

### 11.8 `cappy compare <capture-a> <capture-b>`

```text
cappy compare <capture-a> <capture-b> [--min-ssim <score>]
```

Compares two existing captures of the same source, usually replay captures of one session made with two game builds, and produces an aligned visual comparison. It needs FFmpeg and ffprobe (exit 4 when either is unavailable) but not the game, adapter, or OBS. A is the reference; B is compared against it.

Eligibility, checked before any media work:

- The two IDs must be different (`USAGE_INVALID`, exit 2), and each must name a capture in this workspace (`CAPTURE_NOT_FOUND`, exit 2). `--min-ssim` outside 0 to 1 is `USAGE_INVALID`.
- Both captures must have `succeeded` manifests, with the same source: replay captures of the same session, or scenario captures with the same scenario ID and resolved parameters (the take-grouping key of section 16). Otherwise the command fails with `COMPARE_INCOMPATIBLE`.
- Each master must still match its manifest's SHA-256 and size, and each timeline must hold its operation's start and completion events (`COMPARE_INPUT_INVALID`).
- `COMPARE_INCOMPATIBLE` and `COMPARE_INPUT_INVALID` exit 1. None of these checks creates a comparison directory.
- When both captures report the same `gameBuild`, or neither reports one, the result carries a warning.

Alignment: in each capture, the operation's start event (`SCENARIO_STARTED` or `REPLAY_STARTED`) is time zero. The compared span is the shorter of the two operations, measured from `<LABEL>_STARTED` to `<LABEL>_COMPLETED`, and also bounded by each master's remaining duration. A span that is not positive fails with `COMPARE_INPUT_INVALID`.

Normalization: B is scaled to A's width and height, and both are sampled at A's frame rate (30 when ffprobe reports none). The manifest records the resulting size and rate, and whether B was scaled.

Outputs, in `comparisons/<comparison-id>/`, all published as managed files:

- `triptych.mp4`: A, B, and their absolute per-pixel difference amplified four times, side by side over the span (H.264, CRF 20, x264 preset `medium`, no audio).
- `frames.json`: per compared frame, its time from the aligned start, its SSIM (the "All" value, 0 to 1), and its PSNR in dB (`null` for identical frames).
- `worst-<n>-a.png`, `worst-<n>-b.png`, `worst-<n>-diff.png`: A, B normalized to A, and the amplified difference, for up to three lowest-SSIM frames at least one second apart (`n` = 1 is the lowest).
- `manifest.json`: the comparison manifest.

Scores: mean and minimum SSIM, with the time of the minimum, and mean and minimum PSNR over frames with a finite PSNR (`null` when every frame is identical).

Timeline diff: the adapter events (`source: "adapter"`) of the two captures, with times measured from each capture's aligned start. Events are matched by type and occurrence order, so the n-th `SPELL_CAST` in A is matched with the n-th in B. For each type the diff reports the counts in A and B, the occurrences missing from B and extra in B, and the mean and maximum drift of matched occurrences (B's time minus A's). A count difference adds a warning. The timeline diff never changes the status or exit code.

Gates: without a gate, a completed comparison is `succeeded` and exits 0. Each gate that is given is checked once the comparison completes:

- `--min-ssim <score>` (0 to 1): the mean SSIM must be at least the score.
- `--min-frame-ssim <score>` (0 to 1, post-V1): every frame's SSIM must be at least the score, which catches a glitch confined to a few frames.
- `--max-drift-ms <ms>` (post-V1): no matched adapter event may drift by more than `ms` in either direction (the largest `maxDriftMs` magnitude across event types).
- `--require-same-events` (post-V1): every adapter event type must occur the same number of times in A and B.

A comparison that fails any gate is recorded as `regressed`, keeps every output, and exits 1 with `COMPARISON_REGRESSED`, whose details list the failed gates, the scores, and the manifest path. With gates given, the timeline diff can change the outcome; without timeline gates it stays informational. When the two captures were made with different presentation parameters (section 14), the result warns, because their frames and timings are not expected to match.

Failure: once media work starts, a failed ffprobe of a master (`MEDIA_PROBE_FAILED`) or a failed FFmpeg run, missing or unprobeable triptych, or unreadable statistics (`COMPARISON_FAILED`) writes a `failed` comparison manifest with the error and the checks that ran, and exits 1. No partial output is published. Partial files, which Cappy itself just created, are removed. FFmpeg runs inside the comparison directory and writes its statistics there under unique partial names.

The comparison manifest (`comparisonVersion: 2` post-V1; version 1 had a single `threshold`) records:

- the comparison ID, status, `createdAt`, and correlation ID;
- the project, and the shared source;
- for A and B: the capture ID, take, `gameBuild` when reported, the master's SHA-256, and the aligned start on that master;
- the alignment event and the span;
- the normalization;
- the scores, the `gates` that were given (`minSsim`, `minFrameSsim`, `maxDriftMs`, `requireSameEvents`), and `failedGates`;
- the worst frames (time, SSIM, and paths), and the timeline diff;
- artifacts with SHA-256 and size;
- FFmpeg and ffprobe versions;
- warnings, checks, and, when not `succeeded`, the error.

`compare` holds a run lock while it runs and writes a command log, like `run`.

### 11.9 `cappy compare-builds` (post-V1)

```text
cappy compare-builds <session-id | scenario> <build-a> <build-b> [--param key=value]... [--preset <name>] [gates]
```

Captures the same moment with two named builds (section 6) and compares them, in one command:

1. Capture A: when the first argument is a session ID (`ses_…`), a replay capture of that session with build A, exactly as `cappy replay <session> --build <build-a>`; otherwise a scenario capture, exactly as `cappy run <scenario> --build <build-a>` with the given `--param` values.
2. Capture B: the same with build B.
3. `cappy compare <capture-a> <capture-b>` with the given gates (section 11.8).

- The name `base` means the base `game`; a `builds` entry may not be named `base`. The two builds must differ, and both must exist (`BUILD_NOT_FOUND`), or the command fails before anything launches (exit 2).
- Each step is the standalone command, so the captures and the comparison are ordinary items with their own takes, manifests, logs, and run locks.
- It stops at the first failed step. A failed or cancelled capture ends the command with that capture's error and exit code, and nothing after it runs. Ctrl+C cancels the step in progress (exit 130).
- The result data holds `a` and `b` (the two capture reports) and `comparison` (the compare report). The exit code is the comparison's: 0 when `succeeded`, 1 when `regressed` or `failed`.
- The same-build warning from `compare` still applies: two named builds whose adapters report the same `gameBuild` may not differ.

### 11.10 `cappy timeline export` (post-V1)

```text
cappy timeline export <capture-id | session-id> [--format json|csv|vtt] [--out <path>]
```

Exports a timeline for other tools, without Cappy depending on them.

- A capture's timeline is the one in its manifest, on the master's clock, so it lines up with the capture's video. A session's timeline is its `timeline.json`, on the session's clock. An unknown ID fails with `CAPTURE_NOT_FOUND` or `SESSION_NOT_FOUND` (exit 2). An item with no readable timeline fails with `TIMELINE_UNAVAILABLE` (exit 1).
- `json` (the default) writes `{ "timelineExportVersion": 1, "source": { "kind", "id" }, "clock": "master" | "session", "sync"?, "events": [...] }`. The events use the normalized envelope (section 8, Timeline Event).
- `csv` writes the header `seq,t_ms,type,source,duration_ms,id,payload`, one row per event, with RFC 4180 quoting and the payload as compact JSON.
- `vtt` writes WebVTT: one cue per event, from `t` to `t` plus `durationMs` or one second, whichever is longer. The cue identifier is the event ID, and the cue text is the event type followed by its payload as `key=value` pairs. Players can show it over the capture's video.
- Without `--out`, the export goes to standard output. With `--json`, the result's `data` carries the format, the source, the event count, and the content.
- With `--out <path>` (relative to the project directory), Cappy writes a new file there. It never overwrites (`EXPORT_TARGET_EXISTS`, exit 1). The file is the user's, not managed, and Cappy never deletes it.
- The published JSON Schemas, `docs/schemas/timeline-event.schema.json` and `docs/schemas/timeline-export.schema.json`, are generated from the runtime schemas. A test fails if the committed files differ from the generated ones.

## 12. OBS integration

Use OBS WebSocket.

Cappy V1 may:

- connect/authenticate;
- inspect version/state;
- validate configured scene existence;
- switch to the configured capture scene if explicitly enabled by project config;
- start recording;
- verify recording became active;
- stop recording;
- verify recording stopped;
- obtain or resolve the output file path using supported OBS information/configuration;
- include OBS version and recording metadata in the manifest.

Cappy must not:

- create/delete scenes;
- create/delete sources;
- rewrite arbitrary profiles;
- overwrite user OBS configuration.

On timeout, disconnect, authentication failure, or unexpected recorder state, the capture job fails visibly.

V1 implementation rules:

- Cappy sends only `GetVersion`, `GetSceneList`, `GetRecordStatus`, `GetRecordDirectory`, `StartRecord`, `StopRecord`, and, when `obs.switchScene` is true, `SetCurrentProgramScene`. The recorder enforces this allowlist.
- OBS is checked before the game launches: reachable, authenticated, capture scene present, and not already recording. Cappy never takes over a recording it did not start.
- Start and stop are confirmed by polling `GetRecordStatus` until the output is active or inactive within `timeouts.obsMs`. An accepted request alone is never success.
- The master is the path OBS reports from `StopRecord` (or its `RecordStateChanged` event). It must be an absolute path to a regular, non-empty file modified after the recording was requested, with a size that has stopped changing.
- The verified master was produced by a recording Cappy started, so Cappy moves it into the managed workspace (`captures/<capture-id>/master.<ext>`, or `sessions/<session-id>/master.<ext>` for `record --capture`) and registers it with SHA-256 and size. Cappy does not redirect OBS output directories, because that would change OBS configuration.
- On cancellation or failure after recording started, Cappy stops the recording it started. Partial OBS output from a failed stop is left where OBS wrote it.

## 13. FFmpeg integration

Use ffprobe to inspect the completed master before derivatives are accepted.

A capture preset may request derivatives such as:

- MP4 delivery encode;
- trimmed clip by explicit/timeline range;
- thumbnail;
- still frame.

Each required derivative is produced atomically where practical: write to a temporary path, validate, then move into its final managed path.

A non-zero process exit, missing output, zero-length output, or invalid required probe result fails processing.

Do not delete the verified master merely because derivative creation failed.

V1 derivative options (`presets.<name>.derivatives[].options`), validated before the game launches (`DERIVATIVE_OPTIONS_INVALID`):

| Kind | Output | Options |
| --- | --- | --- |
| `mp4` | `<role>.mp4` (H.264/AAC, faststart) | `crf` (0-51, default 20), `preset` (x264 preset, default `medium`), `audio` (default true) |
| `clip` | `<role>.mp4` | `start` (required), and exactly one of `duration` (seconds, positive) or `end`, plus the `mp4` options. `start` and `end` are seconds from the start of the master, or event anchors |
| `thumbnail` | `<role>.jpg` | `at`, seconds or an event anchor (default 0), and `width` in pixels (default 640, aspect preserved) |
| `still` | `<role>.png` (full resolution) | `at`, seconds or an event anchor (default 0) |

FFmpeg writes each output to a uniquely named `.<role>.<uuid>.partial.<ext>` file beside its final path. The output is accepted only after a zero exit, a non-empty file, and an ffprobe result with a video stream; it is then published as a managed file. A rejected partial output, which Cappy itself just created, is removed. A failed required derivative fails the job. A failed optional derivative (`required: false`) is reported as a warning and left out of the manifest's checks and artifacts.

#### Event anchors

An event anchor places a derivative time relative to a timeline event instead of at a fixed second:

```json
{ "event": "SPELL_CAST", "offset": -2, "occurrence": 1, "where": { "spell": "fireball" } }
```

- `event` (required) is a timeline event type, using the timeline event type syntax. Any event on the capture's timeline qualifies, including Cappy lifecycle events such as `SCENARIO_STARTED`.
- `offset` is in seconds and may be negative (default 0).
- `occurrence` is a 1-based index, `"last"`, or `"every"` (default 1). `"every"` is post-V1 and allowed only on a clip's `start` and a still's or thumbnail's `at`.
- In `where`, each key is a dot-separated path into the event's payload object (`"target.kind"`), and each value is a JSON string, number, boolean, or `null`. An event matches only when every path exists and equals its value strictly. `where` is optional.

Anchors resolve during processing, against the capture's timeline on the master clock (section 15). The candidates are the events whose type matches and whose payload satisfies `where`, ordered by `t` and then `seq`. `occurrence` picks one of them. For a clip's `end` anchor, candidates are limited to events at or after the start event, or at or after the numeric `start`. The resolved time is the event's `t` plus `offset`. Cappy does not pad for `timing.sync.uncertaintyMs`; use `offset`.

Resolution rules:

- An anchor with no matching event fails the derivative with `DERIVATIVE_ANCHOR_UNRESOLVED`.
- A clip window that extends past either end of the master is clamped to it, with a warning.
- A clamped window that is not positive fails with `DERIVATIVE_WINDOW_EMPTY`.
- A still or thumbnail shows the last frame at or before its time. FFmpeg reads the second of video that ends at that time and keeps the last frame it decodes. Recorders often end their video a frame or two before the duration they report, so seeking to the time itself can find nothing near the end. An anchored time past the master is clamped to the master's duration, with a warning, which yields the last frame.
- Clamping applies only to times that involve an anchor. Times given only in seconds are used exactly as written, as in V1, so a numeric still past the end of the master still fails.
- These failures follow the required/optional rule above: they fail the job for a required derivative and become a warning for an optional one.
- Each preset derivative produces at most one output, except with `occurrence: "every"` (post-V1): one output per matching event, in timeline order, named `<role>-1`, `<role>-2`, and so on. Each clip's `end` anchor pairs with the first qualifying event at or after that clip's own start event. At most 100 outputs are made; further matches are skipped with a warning. Each output is resolved, clamped, produced, and recorded on its own. For a required derivative, no match fails the job (`DERIVATIVE_ANCHOR_UNRESOLVED`), and any failed output fails it; for an optional one, each failed output is a warning. Config validation rejects a preset in which another role would collide with a generated name (`<role>-<digits>`).

Anchor syntax is validated with the other options before the game launches (`DERIVATIVE_OPTIONS_INVALID`): the event type syntax, `occurrence`, `where` values, and exactly one of `duration` or `end`.

Every clip artifact records its resolved window (`window: { startMs, endMs }`, plus `startEventId` and `endEventId` when anchored). Every still and thumbnail artifact records its frame time (`at: { ms }`, plus `eventId` when anchored). Numeric times are recorded the same way. These are additive, optional artifact fields in manifest version 1.

## 14. Capture presets

Source-controlled config can define named presets.

Example conceptual fields:

- expected OBS scene;
- required derivatives;
- video container/codec intent passed to FFmpeg;
- thumbnail/still requirements;
- event-anchored clip, thumbnail, and still times (section 13);
- game-side presentation parameters such as capture mode only when exposed by the adapter.

A preset cannot require a capability the current adapter does not advertise.

Presentation parameters (post-V1). `presentation` is passed to the adapter for scenarios and, post-V1, for replay captures. Two keys are defined by Cappy; the rest are adapter-defined:

- `timeScale`: a number from 0.1 to 4 (0.5 is half speed). It requires the `time_scale` capability.
- `camera`: an adapter-defined camera name. It requires `alternate_cameras`. An adapter that does not know the name fails the operation.

Cappy adds the capabilities these keys require to the preset's required capabilities and checks them after the handshake, before anything is recorded (`CAPABILITY_MISSING`). The manifest records the presentation that was requested (`identity.presentation`). A replay played with a presentation reproduces the same simulation; only what is shown, and when, changes.

## 15. Artifact manifest

Each successful capture writes a versioned JSON manifest.

Required categories:

### Identity

- manifest schema version;
- capture ID;
- session ID;
- take number;
- project identity;
- scenario ID/parameters or replay source.

### Source/build

- Cappy version;
- the configured build name when `--build` was used (`build.name`, post-V1);
- adapter name/version;
- game build identity when supplied;
- protocol version;
- capability snapshot.

### Timing

- wall-clock start/end;
- monotonic/session timing where available;
- timeline events or a referenced timeline file.

### Recorder/tooling

- OBS version and relevant capture metadata;
- FFmpeg/ffprobe versions;
- preset name/config fingerprint.

### Artifacts

For every artifact:

- role;
- path relative to managed root where possible;
- ownership;
- SHA-256;
- bytes;
- media metadata where applicable.

### Result

- status;
- warnings;
- verification checks.

Secrets must never appear in the manifest.

Failed/cancelled jobs may have diagnostic manifests, but they are explicitly non-successful and cannot be mistaken for successful evidence.

V1 writes `captures/<capture-id>/manifest.json` for every job that reached a game session: `succeeded` only when OBS start and stop were confirmed, the master was verified and probed, and every required derivative passed; otherwise `failed` or `cancelled` with the error, the checks that ran, and the artifacts that exist. The preset fingerprint is the SHA-256 of the preset's canonical JSON. A scenario capture also records a scenario session (`sessions/<session-id>/session.json`), which the manifest references. Before writing, Cappy refuses any manifest whose text contains the configured OBS password.

## 16. Take numbering and identity

A capture ID is unique.

For repeated captures of the same scenario/replay intent, Cappy assigns a monotonically increasing take number within the relevant project/source grouping unless the caller supplies an unused explicit take.

Existing successful takes are never overwritten implicitly.

`--take <n>` requests an explicit take; if a successful capture of the same source already has that take, the job fails with `TAKE_EXISTS` before anything is recorded. Failed and cancelled jobs do not consume take numbers.

Takes are grouped by source: the scenario ID plus its resolved parameters, or the replayed session ID. The next take is one past the highest take for that source among successful manifests in the workspace and the takes retired by cleanup. Every capture has its own `captures/<capture-id>/` directory.

Take numbers are never reissued. Cleaning a successful capture retires its take (section 11.7): automatic numbering continues past it, and `--take <n>` for a retired take fails with `TAKE_EXISTS`.

## 17. Cleanup and destructive behavior

V1 cleanup may remove explicitly selected managed artifacts or clearly defined managed cache entries.

Rules:

- imported/external files are never deleted;
- targets outside the resolved managed root are rejected;
- symlink/path traversal must not escape the managed root;
- cleanup reports exactly what was removed;
- missing targets are non-destructive and reported;
- bulk destructive cleanup requires an explicit command/flag and cannot occur as a side effect of ordinary capture.

`cappy clean` (section 11.7) is the command-line surface for these rules. `ManagedWorkspace.remove` in `@cappy/workspace` is the primitive that enforces them.

## 18. Logging

Each operation gets a correlation ID.

Human logs should be useful without leaking secrets. JSON mode returns bounded structured results; verbose diagnostic logs may live under the managed logs directory.

V1 writes one structured log per command, `logs/<correlation-id>.jsonl`, for `record`, `run`, `replay`, and `compare`. `clean` writes none; its result is the record of what it did. Every entry, session, manifest, and timeline event carries the command's correlation ID. Entries hold events, IDs, paths, states, and error codes only.

Do not log:

- OBS passwords;
- environment secrets;
- arbitrary replay contents.

## 19. Cancellation and crash behavior

Ctrl+C or an explicit cancellation request should:

1. tell the game adapter to cancel/stop when connected;
2. stop OBS recording if Cappy started it;
3. terminate/clean child processes Cappy owns;
4. preserve useful partial diagnostics;
5. mark the operation cancelled, not succeeded.

After an unclean controller crash, the next command may detect orphaned in-progress metadata and mark/reconcile it, but must not guess that a capture succeeded.

V1: `record`, `run`, and captured `replay` hold a run lock (`cache/running/<correlation-id>.json`, with PID and host) while they may leave `active` state. `compare` also holds one while it runs, so `clean` treats its unfinished directory as in progress. Each of those commands first marks as `failed` every session still `active` whose command holds no live lock on this host, and reports the reconciled sessions as a warning. A capture interrupted before its manifest was written has no manifest and is therefore never successful. Locks from other hosts are never treated as dead.

## 20. Security boundary

- Bind the game protocol server to loopback by default.
- Reject non-loopback binding unless a future explicit feature permits it.
- Validate all adapter messages.
- Treat file paths received from adapters as untrusted.
- Never allow an adapter-provided path to grant deletion authority.
- Keep secrets out of project config committed to source control, manifests, and normal logs.
- Execute subprocesses without shell interpolation where possible.

## 21. Cross-platform behavior

Required host acceptance:

- Windows.
- macOS.
- Linux (post-V1, ADR-021): supported for every command and verified in a Debian bookworm (arm64) container with Node.js 24, FFmpeg, and headless Godot. Real OBS capture on Linux is unverified; `scripts/acceptance/linux-container.sh` reruns the container acceptance.

Path manipulation uses platform-safe APIs rather than string concatenation.

Process termination, signal behavior, executable discovery, and OBS/FFmpeg paths must be tested or abstracted separately by platform.

No V1 behavior may require PowerShell-only, macOS-only, or Linux-only semantics in the shared core.

## 22. Testing strategy

### Unit

- config schemas;
- protocol schemas;
- capability gating;
- job state machine;
- take allocation;
- manifest generation;
- ownership/path safety;
- hash/media metadata helpers;
- CLI result/error serialization.

### Integration with fakes

A deterministic adapter simulator and fake OBS/media backends must prove:

- authored scenario success;
- freeform session success;
- replay success;
- capability mismatch;
- malformed protocol messages;
- game disconnect;
- OBS start failure;
- OBS stop failure;
- missing master;
- FFmpeg derivative failure;
- cancellation;
- cleanup safety;
- `cappy clean` selection, dry run, in-progress protection, and take retirement;
- event-anchored derivative resolution and its failures;
- comparison eligibility, alignment, gating, and failure.

### Real-tool smoke tests

Opt-in/local smoke tests cover:

- real OBS WebSocket recording;
- real ffprobe/FFmpeg derivative generation;
- real Godot fixture scenario;
- real Godot freeform record and replay;
- real FFmpeg event-anchored clips and comparisons (SSIM, triptych, worst-frame stills).

The normal automated suite must not require OBS GUI availability.

V1 switches: `CAPPY_REAL_TOOLS=1` enables the real FFmpeg/ffprobe and headless Godot tests; `CAPPY_OBS_SMOKE=1` with `CAPPY_OBS_SCENE` (and optionally `CAPPY_OBS_URL`, `CAPPY_OBS_PASSWORD`) enables the real OBS capture. `npm run model:check` validates `docs/system-model.dot` with Graphviz and `npm run model:render` writes the derived `docs/system-model.svg`. Both use Graphviz compiled to WebAssembly (`@hpcc-js/wasm-graphviz`, a pinned dev dependency), so no system install is needed on any host; Graphviz is a documentation tool, never a runtime dependency. Per-host results are recorded in `docs/acceptance.md`; `scripts/acceptance/windows-ctrl-c.ps1` checks console Ctrl+C cancellation on Windows from an interactive console.

## 23. Fixture quality bar

The Godot demo is not decorative. It is an acceptance fixture and must contain at least:

- one deterministic authored scenario;
- one parameterized scenario input;
- semantic timeline events;
- a freeform replay recording path;
- replay execution;
- a visible result that makes replay/capture verification practical.

## 24. Definition of done

Cappy V1 is done when:

- all tickets required by this specification are complete;
- strict TypeScript, lint, unit, and integration suites pass;
- Windows and macOS acceptance commands are documented and exercised;
- the Godot fixture proves scenario, freeform replay, and replay capture;
- real OBS + FFmpeg smoke evidence exists for each supported host or any unavailable host gate is explicitly documented as unresolved rather than inferred;
- cleanup safety tests prove Cappy cannot delete imported/external files;
- `Context.md`, `ADR.md`, `SPEC.md`, `Ideas.md`, tickets, and `docs/system-model.dot` remain synchronized.

## 25. Post-V1 increments

After V1 was accepted, these ideas were promoted from `Ideas.md` on 2026-09-25 (ADR-012 to ADR-016):

- whole-token flag shorthands across the CLI (section 11.1);
- `cappy clean`, with retired take numbers (sections 11.7, 16, and 17);
- event-anchored clip, thumbnail, and still times (section 13);
- `cappy compare` for two captures of the same source, with a triptych video, SSIM/PSNR scores, worst-frame stills, and a timeline diff (section 11.8).

They keep the V1 host platforms (Windows and macOS) and every V1 rule on ownership and safety. Their tickets are CAP-011 to CAP-016.

A second batch was promoted the same day (ADR-017 to ADR-022; tickets CAP-017 to CAP-023):

- `occurrence: "every"` for event-anchored derivatives (section 13);
- comparison gates on single frames and on the timeline diff (section 11.8);
- named builds and `cappy compare-builds` (sections 6 and 11.9);
- `cappy timeline export` with published JSON Schemas (section 11.10);
- presentation parameters for replays, with slow motion and alternate cameras in the Godot adapter and demo (sections 9.4 and 14);
- Linux as a supported host, with OBS capture unverified (section 21).

## 26. Uppercut Labs ownership and npm distribution

**Status:** Approved for implementation on 2026-09-28.
**Date:** 2026-09-28
**Execution plan:** [docs/migration-plan.md](docs/migration-plan.md)
**Tickets:** CAP-024 to CAP-027.

This section specifies the migration and distribution work. Sections 1-25 remain
the product behavior contract; ownership and packaging changes must preserve it.

### 26.1 Audience, purpose, and first use

Cappy becomes a reusable developer product distributed by Uppercut Labs, with
Devin Thomas credited as its author and maintainer.

| Surface | Intended identity |
| --- | --- |
| GitHub | `uppercut-labs/cappy` |
| npm | `@uppercut-labs/cappy` |
| Executable | `cappy` |
| First public release | `v0.1.0`, npm version `0.1.0` |
| Author/maintainer | Devin Thomas |
| Product/publisher | Uppercut Labs |

A developer installs the tool, supplies their own `cappy.config.json`, and runs:

```bash
npm install -g @uppercut-labs/cappy
cappy doctor -C /path/to/project
```

The equivalent one-shot command is:

```bash
npx @uppercut-labs/cappy doctor -C /path/to/project
```

Installation requires no repository checkout, TypeScript compiler, or consumer
build step. Node.js 24 or newer remains required. Missing configuration or
external tools produce the existing actionable diagnostics and exit codes;
installation must not silently install OBS, FFmpeg, or Godot. An empty directory
must behave as a configuration error, not a broken installation.

Do not advertise `npx cappy` as the public installation path. Public examples
use the scoped package or the installed `cappy` executable. Contributor examples
use an explicit checkout launcher where local resolution could be ambiguous.

### 26.2 Verified starting point

Inspection on 2026-09-28 found:

- `origin` points to `git@github.com:devin-thomas/cappy.git`; the branch is `main`
  and the worktree was clean before this planning change.
- GitHub reports the repository as private. The intended public visibility is
  a decision to confirm, not an existing property of the repository.
- The root, six implementation packages, and two fixture packages are private.
- The CLI launcher is `packages/cli/bin/cappy.js`; it loads the TypeScript build
  from `dist/bin.js` and currently tells users to build when it is missing.
- Internal imports and workspace dependencies use `@cappy/*`.
- No tracked license, GitHub workflow, or Git tag was found.
- Existing acceptance covers source-checkout behavior on macOS and Windows,
  and Linux with real OBS unverified. It does not prove npm installation works.

Organization transfer rights, npm scope ownership, package/version availability,
and publishing credentials remain implementation preflight checks. No public
release or ownership transfer is claimed by this specification.

### 26.3 Repository migration

Transfer the existing repository to `uppercut-labs`, retaining the name `cappy`.
Preserve Git history, issues, pull requests, and existing repository resources;
do not substitute a newly created repository or rewrite authorship.

Before transfer, inspect destination-name conflicts, organization permissions,
repository settings, and any workflows, secrets, webhooks, or integrations that
need attention after transfer. A name conflict or rejected transfer must surface
explicitly; do not delete a destination repository or bypass an organization
policy. Recheck organization access after transfer.

Update `origin` to `git@github.com:uppercut-labs/cappy.git` and verify it resolves
to the transferred repository. Verify the default branch remains `main` and
the intended commits are present remotely. Do not rely on the old URL redirect
as the final configuration.

The target is an open-source repository. Before changing the currently private
repository to public, review the tracked tree and history for credentials,
private data, generated captures, and material not intended for public release.
A consequential finding blocks public visibility until resolved with the owner;
do not rewrite history automatically. License choice and visibility need explicit
confirmation. Preserve personal authorship and add Uppercut Labs publisher credit.

### 26.4 One public package; private implementation workspaces

Keep the existing source boundaries. Add `packages/cappy/` as a distribution-only
workspace named `@uppercut-labs/cappy`, with `private: false`. The root remains
private. No implementation or fixture package is published independently.

Rename private workspaces and all active imports/dependency references as follows:

| Current | Private workspace identity |
| --- | --- |
| `@cappy/core` | `@uppercut-labs/cappy-internal-core` |
| `@cappy/workspace` | `@uppercut-labs/cappy-internal-workspace` |
| `@cappy/protocol` | `@uppercut-labs/cappy-internal-protocol` |
| `@cappy/obs` | `@uppercut-labs/cappy-internal-obs` |
| `@cappy/media` | `@uppercut-labs/cappy-internal-media` |
| `@cappy/cli` | `@uppercut-labs/cappy-internal-cli` |
| `@cappy/adapter-simulator` | `@uppercut-labs/cappy-fixture-adapter-simulator` |
| `@cappy/fake-obs` | `@uppercut-labs/cappy-fixture-fake-obs` |

All eight retain `private: true`. Regenerate the npm lockfile through npm;
update tests, fixtures, development tooling, and current architecture docs.
Historical ticket evidence may retain the names used when it was recorded.

Build the public CLI from `packages/cli/src/bin.ts` with a project-local bundler
(proposed: esbuild), bundling all internal modules into a Node ESM executable.
Preserve its shebang, signal handling, argument forwarding, and current-directory
behavior. Keep Node built-ins external. Initially keep `ws` and `zod` as declared
registry runtime dependencies; their transitive installation must work normally.
No published dependency may reference a private workspace, local file, or link.

The public manifest maps `bin.cappy` to the built executable. Use an explicit
files allowlist for the executable, package README, license, and necessary
third-party notices. Exclude tests, fixtures, caches, captures, local config,
credentials, and development tooling. Do not introduce a public JavaScript
library API in this release; retain internal source exports for development.

The Godot addon remains available from the versioned GitHub source tree, with
installation instructions pinned to the release tag. npm distributes the
controller CLI, not the Godot editor or demo. A future addon archive is optional
and does not block this migration.

Set public metadata deliberately: description, `engines.node: >=24`, license,
author, repository URL and package directory, homepage, bugs URL, keywords, and
`publishConfig.access: public`. Keep the release version and `CAPPY_VERSION`
synchronized so CLI output and capture manifests identify the released version.

### 26.5 Documentation, checks, and release automation

Update README and getting-started instructions for global and scoped one-shot
installation, runtime prerequisites, configuration, and Godot addon retrieval.
Separate contributor builds from consumer installation. Update ownership links,
package tables, relevant Context/ADR/model references, and license information.
Preserve the existing host limitations and historical acceptance evidence.

Add CI for macOS, Windows, and Linux using Node.js 24 and `npm ci`. Required
checks are typecheck, lint, tests, model validation, and distribution build.
Add a reproducible package check that packs only `packages/cappy`, inspects its
contents and dependency closure, and installs the resulting tarball into a clean
directory outside the checkout with no workspace links or developer dependencies.

Exercise both a normal local installation and an isolated global prefix. Verify
the actual npm-generated `cappy` launcher on macOS/Linux and Windows, not only
`node` invoked against the bundle. Verify `--help`, `--version`, JSON diagnostics,
missing-config errors, and `doctor` against a controlled project. A successful
doctor requires configured prerequisites; the missing-tools case must return the
expected diagnostic, not be treated as a packaging failure.

Run at least one no-capture scenario and record/replay fixture flow through the
installed CLI. Fixtures can be separately built test processes but must not
supply hidden runtime dependencies to the installed package. Check subprocess
cleanup and cancellation. Record new per-host installation evidence separately
from previous real OBS/Godot capture acceptance.

Prepare a manually initiated release workflow with an approval gate and a
runbook. Before enabling publication, verify current npm/GitHub requirements
from their official documentation, organization rights, and authentication
availability. Prefer supported trusted publishing; keep any required bootstrap
or credential configuration explicit and never commit tokens.

Publication must select only the public package, validate that tag, manifest,
and CLI versions match, and publish the exact tested tarball. Retain its checksum
and commit association. Create the matching GitHub release with notes, package
artifact/checksum, prerequisites, and support limitations. A failure between
GitHub release creation and npm publication is a partial release to reconcile,
not success. Check for an existing version before publishing; never overwrite a
published version or blindly retry an ambiguous publish result.

### 26.6 Boundaries and consequential decisions

No new CLI commands, capture features, protocol changes, workspace format
changes, GUI, library releases, executable rename, or external-tool downloads
are part of this migration. Future standalone libraries may use names such as
`@uppercut-labs/cappy-core` only when external demand justifies a supported API.

The owner confirmed on 2026-09-28:

1. Transfer GitHub and prepare npm publication; do not publish npm `0.1.0` yet.
2. Use the MIT license.
3. Make the transferred repository public after reviewing publish contents.

Reversible packaging choices above are proposed implementation defaults. The
overall scope was approved on 2026-09-28 under the invoked quick-build workflow.
Record the approved scope in the execution plan and ADR before implementation.

### 26.7 Acceptance and completion evidence

| Evidence | Required check | Current result |
| --- | --- | --- |
| Ownership | Transferred repo, correct origin, preserved history and resources | Pending |
| Visibility/license | Confirmed choice, public-content review if applicable, matching license metadata | Pending |
| Build/types | Typecheck, lint, tests, model, distribution build, `git diff --check` | Pending implementation |
| Package isolation | Inspected tarball, no private dependency references, clean local/global installation | Pending |
| Primary behavior | Installed help/version, doctor JSON, missing config/tools, no-capture scenario and record/replay | Pending |
| Platforms | Installed npm launchers on macOS, Windows, Linux; cancellation evidence labeled by host | Pending |
| Layout/accessibility | No GUI changes; preserve existing human and JSON CLI output | Not applicable to layout |
| Release availability | Release-ready artifact and gated publication runbook; no npm publication | Pending implementation |

For a preparation-only delivery, completion means transferred ownership,
approved visibility/license, passing package checks, documented remaining
publisher setup, and publication disabled until authorized. Do not describe it
as an npm release. For a publication delivery, additionally verify registry
metadata and integrity against the tested artifact and run the documented
version-pinned scoped command from a clean environment. Record the branch,
commit, repository URL, actual release/package URLs, and unresolved checks.
