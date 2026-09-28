# Cappy Context

## Project

Cappy is a reusable local developer system for automated game capture, replayable development sessions, and repeatable media production.

The name references Cappy from Super Mario Odyssey and the act of capturing moments in games.

Cappy is not a game, video editor, or general screen recorder. It coordinates an instrumented game, replay/scenario execution, OBS capture, FFmpeg post-processing, and evidence/artifact generation so useful gameplay moments can be reproduced without manually rebuilding the situation each time.

The first serious consumer is expected to be a Godot game such as Fantasy Party, but the core protocol is engine-neutral.

The product is maintained and published by Uppercut Labs (`uppercut-labs/cappy`) and credits Devin Thomas as author and maintainer. The consumer package is `@uppercut-labs/cappy`, with the `cappy` executable; `0.1.0` was published to npm on 2026-09-28. The Godot addon remains distributed from versioned GitHub source.

## Objective

Make gameplay moments durable and reproducible.

A developer should be able to:

- author a named scenario and ask Cappy to launch and capture it;
- play a spontaneous development session and save it as a replayable session;
- replay a previously recorded session later;
- capture the same moment again after visual, UI, camera, or rendering changes;
- receive synchronized video, screenshots, event timelines, manifests, and telemetry;
- automate repeatable captures for devlogs, trailers, regression evidence, and debugging.

## Agreed V1 Boundaries

- Replay is a first-class V1 subsystem, not a later add-on.
- V1 supports both authored deterministic scenarios and spontaneous developer sessions.
- Windows and macOS are supported Cappy host platforms from the first release.
- Linux compatibility should not be intentionally blocked, but Linux acceptance is outside V1. (Post-V1, Linux became a supported host with OBS capture unverified; ADR-021.)
- OBS controlled through OBS WebSocket is the primary recording backend.
- FFmpeg owns post-processing such as transcodes, clips, thumbnails, stills, and media inspection.
- Cappy orchestrates external tools rather than reimplementing a recorder or video editor.
- TypeScript + Node.js is the V1 implementation stack for the controller, CLI, protocol tooling, and tests.
- The primary V1 operator surface is CLI-first with human-readable output plus machine-readable JSON output for agents, scripts, and CI.
- A desktop GUI is not required for V1.
- The architecture is engine-neutral; the first production adapter is Godot.
- The game adapter owns replay semantics and payloads. Cappy owns the lifecycle, protocol, capability negotiation, normalized timeline/event envelope, storage envelope, and capture orchestration.
- Each project defaults to an ignored local `.cappy/` workspace for generated sessions, recordings, manifests, and derivatives.
- Project configuration intended for source control lives outside `.cappy/`.
- An external artifact root may override the default project-local managed workspace.
- Cappy may delete only artifacts it created and tracks as managed. Imported/external files are never deleted by Cappy.
- The generalized commentary/replay practice viewer discussed separately is not part of Cappy.

## Post-V1 Increments

V1 was accepted on 2026-09-25. These ideas were then promoted from `Ideas.md` (ADR-012 to ADR-016):

- **Cleanup command.** `cappy clean` deletes selected managed items at once; `--dry-run` previews. Items are selected by ID or by the explicit bulk selectors `--failed`, `--older-than`, `--logs`, and `--all`. A scenario capture takes its own scenario session with it. A replayed session is never removed as a side effect. Take numbers of cleaned captures are retired and never reissued.
- **Event-anchored derivatives.** Clip start and end, and still and thumbnail times, can be tied to timeline events by type, occurrence, and payload conditions, plus an offset. Each preset derivative still produces one output.
- **Capture comparison.** `cappy compare` compares two successful captures of the same source, usually replays of one session made with two builds. It produces a triptych video, SSIM/PSNR scores, worst-frame stills, and a timeline diff, and can gate on mean SSIM.
- **CLI shorthands.** Every flag has a whole-token shorthand made of initials, such as `-dr` for `--dry-run`.

A second batch was promoted the same day (ADR-017 to ADR-022):

- **Every-match derivatives.** `occurrence: "every"` makes one clip or still per matching event (`highlight-1`, `highlight-2`, …).
- **Comparison gates.** Beyond mean SSIM, a comparison can require a per-frame minimum, a maximum event drift, and equal event counts.
- **Named builds.** `builds` in the config names game launch overrides. `--build` picks one, and `cappy compare-builds` captures one moment with two builds and compares them.
- **Timeline export.** `cappy timeline export` writes JSON (with published schemas), CSV, or WebVTT for other tools.
- **Presentation for replays.** Replay captures can run in slow motion (`timeScale`) or through another camera (`camera`). Event times are what is on screen.
- **Linux.** Linux is a supported host, verified in a container; real OBS capture on Linux is unverified.

## Working System Model

The editable living model is stored in `docs/system-model.dot` and is maintained as Graphviz DOT. SVG/PNG renders are derived artifacts.

At a high level:

1. A developer invokes Cappy through the CLI or an automation caller using JSON mode.
2. Cappy loads project configuration and prepares the managed workspace.
3. Cappy launches the configured game or waits for an instrumented game to connect.
4. Cappy and the game adapter negotiate protocol version and capabilities over a localhost WebSocket connection.
5. The game adapter registers scenarios and exposes replay/session capabilities.
6. For authored scenarios, Cappy requests a named scenario with validated parameters.
7. For freeform sessions, Cappy requests recording while the developer plays normally.
8. The game emits semantic synchronization events such as ready, action start, impact, and completion.
9. Cappy coordinates OBS recording around the requested lifecycle and verifies recorder state.
10. Cappy stores adapter-owned replay/session material without interpreting its internal payload.
11. FFmpeg/ffprobe inspect the master and create requested derivatives.
12. Cappy writes a manifest binding project version, scenario/replay identity, capabilities, timeline, recorder state, media outputs, and hashes.

## Product Modes

### Authored Scenario

A named, parameterizable setup owned by the game project.

Example:

```text
cappy run boss_intro --take 3 --preset trailer
```

The adapter creates the requested game state and reports readiness. A scenario may declare parameters and required capabilities.

### Freeform Session

A developer starts normal gameplay under Cappy:

```text
cappy record
```

The adapter records enough game-owned data to support the replay capability it advertises. Cappy stores the opaque replay payload plus normalized metadata and timeline events.

### Replay Capture

Cappy later asks the adapter to reproduce a stored session:

```text
cappy replay <session-id> --preset trailer
```

Cappy may capture the replay again with different capture settings, cameras, UI presentation, or derivatives only when the adapter advertises the corresponding capability.

### Comparison

After two replay captures of one session, typically made with two game builds, the developer compares them:

```text
cappy compare <capture-a> <capture-b> --min-ssim 0.97
```

Cappy aligns the two masters at the operation start and writes a comparison, with its own manifest, beside the captures. It never switches builds itself.

### Cleanup

The developer reclaims workspace space explicitly:

```text
cappy clean --failed --older-than 7d --dry-run
cappy clean cap_… ses_…
```

## External Systems

### Instrumented Game

Owns game-specific setup, simulation semantics, state restoration, replay fidelity, and game-side timing.

### Game Adapter

Bridges a particular engine/project to the Cappy protocol. It declares capabilities, registers scenarios, owns replay payload creation/consumption, and emits normalized lifecycle/timeline messages.

### Local Protocol Transport

V1 uses a localhost WebSocket connection with versioned JSON messages. Transport details are implementation-level; product semantics must not depend on Godot or Node-specific types.

### OBS

Primary V1 recorder. Cappy controls recording through OBS WebSocket, verifies state transitions, and verifies that the expected master output exists.

OBS remains responsible for scene/profile construction and source composition. Cappy project configuration references the intended OBS scene/profile expectations and fails clearly when they are unavailable.

### FFmpeg / ffprobe

Post-processing and media inspection backend invoked as subprocesses. Cappy validates availability before media work and treats non-zero exits or invalid outputs as capture-job failures.

## State Classification

### Stored

- source-controlled Cappy project configuration;
- adapter-owned replay/session payloads;
- normalized session metadata;
- capture job manifests;
- timeline events;
- master capture metadata and hashes;
- derivative metadata and hashes;
- managed ownership records needed for safe deletion;
- retired take numbers, per take source;
- comparison manifests, per-frame comparison scores, and timeline diffs.

### Derived

- MP4 delivery copies derived from a master capture;
- clips, thumbnails, and still frames derived from a master;
- clip windows and still times resolved from event anchors on the master timeline;
- comparison triptych videos and worst-frame stills derived from two masters;
- rendered Graphviz previews derived from DOT source.

### External

- OBS installation, scenes, profiles, and runtime state;
- FFmpeg/ffprobe installation unless a later version manages binaries;
- game executable/editor/runtime;
- adapter-specific replay implementation;
- imported files that Cappy did not create.

## Storage Boundary

Default generated workspace:

```text
.cappy/
  sessions/
  captures/
  comparisons/
  cache/
  logs/
```

The exact internal layout is implementation-owned but must preserve these semantic ownership classes:

- **Managed** — created by Cappy; eligible for deletion through Cappy.
- **Imported** — user-provided or referenced; never deleted by Cappy.
- **External** — owned by another system, such as OBS configuration or the game build; never deleted by Cappy.

A project may configure an external managed artifact root. The manifest records actual resolved locations.

## Ubiquitous Language

**Scenario** — A named game-authored setup requestable by Cappy with validated parameters.

**Session** — One execution of gameplay under Cappy, authored or freeform.

**Replay** — Adapter-owned stored information sufficient to reproduce a session or supported portion of it.

**Capture Job** — One attempt to produce media/evidence from a scenario or replay.

**Take** — A numbered capture attempt for the same intended moment. Take numbers are never reissued, even after cleanup.

**Retired Take** — The take number of a successful capture removed by cleanup; it stays used for its source.

**Timeline Event** — A timestamped semantic event emitted by the game adapter or Cappy, such as `SCENARIO_READY`, `SPELL_CAST`, or `CAPTURE_STARTED`.

**Master** — The primary OBS recording for a successful capture job.

**Derivative** — Media created from a master, such as an MP4, clip, thumbnail, or still.

**Artifact Manifest** — Machine-readable record tying together source scenario/replay, versions, timing, capture configuration, outputs, ownership, and hashes.

**Adapter Capability** — An explicitly declared behavior supported by a game adapter, such as scenarios, freeform recording, deterministic replay, seeking, alternate cameras, or telemetry.

**Managed Artifact** — A file created and tracked by Cappy that Cappy may delete through an explicit cleanup operation.

**Event Anchor** — A derivative time given as a timeline event (type, occurrence, optional payload conditions) plus an offset, instead of a fixed second.

**Comparison** — One aligned comparison of two successful captures of the same source, with its own outputs and manifest. Its status is `succeeded`, `regressed` (below the requested mean-SSIM threshold), or `failed`.

**Aligned Start** — The operation start event (`SCENARIO_STARTED` or `REPLAY_STARTED`) that a comparison treats as time zero in each capture.

**Cleanup Item** — The unit `cappy clean` selects: a capture, session, comparison, or command log.

**Build** (named build) — A named game launch override in the project configuration, such as `v1` or `v2`. `base` is the plain `game`. Distinct from the adapter-reported `gameBuild` string.

**Presentation** — How an operation is shown rather than simulated: time scale, camera, and adapter-defined options. It changes what the master looks like, never the replayed simulation.

**Presented Time** — Event time as shown on screen, the recorder's clock, which adapters report even in slow motion.

**Gate** — A pass/fail condition on a comparison (mean SSIM, per-frame SSIM, event drift, event counts). A failed gate makes the comparison `regressed`.

**Timeline Export** — A copy of a timeline in JSON, CSV, or WebVTT for other tools. It belongs to the user and is never managed.

## Workflow Preferences

- Preferred living-model format: Graphviz DOT.
- Preference source: explicit user selection on 2026-09-25.
- Active format: Graphviz DOT.
- Canonical model path: `docs/system-model.dot`.

## Discovery Progress

- V1 discovery: 2 rounds, 8 product questions. Diagram setup question answered separately. Closed.
- Post-V1 promotion discovery (2026-09-25): 4 rounds, 12 product questions (which ideas to promote; cleanup confirmation, bulk selectors, cascade, and take reuse; shorthand scope, anchor matching, multiple matches, and still anchors; comparison eligibility, outputs, and gate). Closed.
- Second post-V1 promotion (2026-09-25): 2 rounds, 7 product questions (which ideas to promote, in three groups; build naming; viewer scope, then the viewer was deferred; Linux support level; slow-motion clock). Closed.
- Remaining uncertainty is implementation-level, inexpensive, and reversible.

## Build-Pack Status

Discovery is stable enough for an implementation-ready specification and ordered tickets. New product behavior discovered during implementation must feed back into this context and the specification rather than being silently invented.

The approved migration prepares the repository and npm distribution for review without publishing a package or changing product features. The implementation scope is recorded in ADR-023.
