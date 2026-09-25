# Cappy Implementation Specification

**Status:** Build-ready  
**Version:** 0.1  
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
- Linux acceptance.
- Unity/Unreal/native/emulator production adapters.
- Cross-build visual regression comparison.
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

Secrets such as an OBS WebSocket password must be supplied through environment variables or an untracked local override mechanism and must never be written into manifests.

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
- replay prepare/start/stop;
- timeline/event emission;
- completion/failure reporting;
- replay payload handoff by bounded file reference or bounded encoded payload;
- heartbeat/liveness sufficient to detect a dead adapter.

Large replay payloads should use managed file references rather than unbounded JSON blobs.

### 9.4 Ordering and timestamps

Cappy assigns/records receipt order. Adapter events include session-relative monotonic time when available. Wall-clock timestamps alone are insufficient for media synchronization.

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

Returns per-check status and overall success.

### 11.3 `cappy scenarios`

Launches/connects to the configured game if required, performs handshake, and lists registered scenarios plus parameter/capability metadata.

No recording occurs.

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

### 11.5 `cappy record`

Starts a freeform session and asks the adapter to record replay data.

Default V1 behavior does **not** require OBS recording. Optional `--capture` runs the OBS master-capture path concurrently.

The operation ends when the developer requests stop, the adapter reports completion, or a fatal failure occurs.

A successful replayable session requires a valid replay payload when the adapter advertised replay support for the operation.

### 11.6 `cappy replay <session-id>`

Loads the stored session envelope and replay payload, validates the current adapter's relevant capabilities, launches/connects to the game, and requests replay.

By default this command performs capture through OBS using the selected/default capture preset. A `--no-capture` mode may be used for replay verification/debugging.

If the current adapter/build cannot satisfy capabilities required by that replay, fail before recording.

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

## 14. Capture presets

Source-controlled config can define named presets.

Example conceptual fields:

- expected OBS scene;
- required derivatives;
- video container/codec intent passed to FFmpeg;
- thumbnail/still requirements;
- optional event-relative clip rules;
- game-side presentation parameters such as capture mode only when exposed by the adapter.

A preset cannot require a capability the current adapter does not advertise.

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

## 16. Take numbering and identity

A capture ID is unique.

For repeated captures of the same scenario/replay intent, Cappy assigns a monotonically increasing take number within the relevant project/source grouping unless the caller supplies an unused explicit take.

Existing successful takes are never overwritten implicitly.

## 17. Cleanup and destructive behavior

V1 cleanup may remove explicitly selected managed artifacts or clearly defined managed cache entries.

Rules:

- imported/external files are never deleted;
- targets outside the resolved managed root are rejected;
- symlink/path traversal must not escape the managed root;
- cleanup reports exactly what was removed;
- missing targets are non-destructive and reported;
- bulk destructive cleanup requires an explicit command/flag and cannot occur as a side effect of ordinary capture.

## 18. Logging

Each operation gets a correlation ID.

Human logs should be useful without leaking secrets. JSON mode returns bounded structured results; verbose diagnostic logs may live under the managed logs directory.

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

Path manipulation uses platform-safe APIs rather than string concatenation.

Process termination, signal behavior, executable discovery, and OBS/FFmpeg paths must be tested or abstracted separately by platform.

No V1 behavior may require PowerShell-only or macOS-only semantics in the shared core.

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
- cleanup safety.

### Real-tool smoke tests

Opt-in/local smoke tests cover:

- real OBS WebSocket recording;
- real ffprobe/FFmpeg derivative generation;
- real Godot fixture scenario;
- real Godot freeform record and replay.

The normal automated suite must not require OBS GUI availability.

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
