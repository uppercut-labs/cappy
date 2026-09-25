# Cappy Context

## Project

Cappy is a reusable local developer system for automated game capture, replayable development sessions, and repeatable media production.

The name references Cappy from Super Mario Odyssey and the act of capturing moments in games.

Cappy is not a game, video editor, or general screen recorder. It coordinates an instrumented game, replay/scenario execution, OBS capture, FFmpeg post-processing, and evidence/artifact generation so useful gameplay moments can be reproduced without manually rebuilding the situation each time.

The first serious consumer is expected to be a Godot game such as Fantasy Party, but the core protocol must remain engine-neutral.

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
- Linux compatibility should not be intentionally blocked, but Linux acceptance is outside V1.
- OBS controlled through OBS WebSocket is the primary recording backend.
- FFmpeg owns post-processing work such as transcodes, derived clips, thumbnails, and media inspection.
- Cappy orchestrates external tools rather than reimplementing a video recorder.
- The system architecture remains engine-neutral while the first production adapter is expected to target Godot.
- Replay and capture are related but separable capabilities: a game adapter reports what it supports.
- The generalized commentary/replay practice viewer discussed separately is not part of Cappy.

## Working System Model

The editable living model is stored in `docs/system-model.dot` and is maintained as Graphviz DOT. SVG/PNG renders may be generated from that source but are derived artifacts.

At a high level:

1. A developer invokes Cappy.
2. Cappy launches or attaches to an instrumented game through a game adapter.
3. The game registers scenarios and/or exposes replay capabilities.
4. The game emits synchronization events such as ready, action start, impact, and completion.
5. Cappy coordinates OBS recording around those events.
6. Cappy records the game timeline/replay metadata and capture metadata.
7. FFmpeg derives requested delivery artifacts from the captured master.
8. Cappy writes a manifest that binds the replay/session, timeline, capture configuration, and generated artifacts.

## Product Modes

### Authored Scenario

A named, parameterizable setup owned by the game project.

Example conceptual invocation:

```text
cappy run boss_intro --take 3 --preset trailer
```

The game adapter is responsible for creating the requested game state and reporting when the scenario is ready.

### Freeform Session

A developer starts normal gameplay under Cappy recording. The game adapter records enough information to support later replay according to its declared replay capability.

The resulting session is reusable input to later capture jobs.

### Replay Capture

Cappy replays a prior session and can capture it again with different capture settings, cameras, UI presentation, or derived-output presets when supported by the game adapter.

## External Systems

### Instrumented Game

Owns game-specific setup and simulation semantics. Cappy must not assume Godot APIs in its core protocol.

### Game Adapter

Bridges a particular engine/project to the Cappy protocol. It registers capabilities, scenarios, replay operations, synchronization events, and supported controls.

### OBS

Primary V1 recorder. Cappy controls recording through OBS WebSocket and must verify whether capture actually began/stopped rather than assuming success.

### FFmpeg

Post-processing and media inspection backend. Cappy may invoke FFmpeg/ffprobe as subprocesses.

## State Classification

### Stored

- Cappy project configuration.
- Scenario definitions or references exposed by the game project.
- Freeform replay/session data.
- Capture job manifests.
- Timeline events emitted during a run.
- Master capture metadata and artifact hashes.
- User-selected capture presets and output policy.

### Derived

- MP4 delivery copies derived from a master capture.
- thumbnails and still frames derived from media;
- clip ranges derived from timeline markers;
- rendered Graphviz previews derived from DOT source.

### External

- OBS installation and runtime state.
- FFmpeg/ffprobe installation unless Cappy later chooses to manage binaries.
- the game executable/editor/runtime;
- engine/toolchain-specific replay implementation.

## Ubiquitous Language

**Scenario** — A named game-authored setup that can be requested by Cappy with validated parameters.

**Session** — One execution of gameplay under Cappy, authored or freeform.

**Replay** — Stored information sufficient for a game adapter to reproduce a prior session or supported portion of it.

**Capture Job** — One attempt to produce media/evidence from a scenario or replay.

**Take** — A numbered capture attempt for the same intended moment.

**Timeline Event** — A timestamped semantic event emitted by the game or Cappy, such as `SCENARIO_READY`, `SPELL_CAST`, or `CAPTURE_STARTED`.

**Master** — The primary OBS recording for a successful capture job.

**Derivative** — Media created from a master, such as an MP4, clip, thumbnail, or still.

**Artifact Manifest** — Machine-readable record tying together the source scenario/replay, versions, timing, capture configuration, outputs, and hashes.

**Adapter Capability** — An explicitly declared behavior supported by a game adapter, such as authored scenarios, freeform recording, replay, seeking, alternate cameras, or telemetry.

## Workflow Preferences

- Preferred living-model format: Graphviz DOT.
- Preference source: explicit user selection on 2026-09-25.
- Active format: Graphviz DOT.
- Canonical model path: `docs/system-model.dot`.

## Discovery Progress

- Completed rounds: 1
- Product questions answered: 4
- Diagram setup question: answered separately and does not count toward the product-question allowance.
- Default discovery ceiling: 5 rounds / 20 product questions.
- Expected remaining discovery: one compact round unless answers expose a new material uncertainty.

## Open Material Questions

- Cappy's primary operator surface in V1: CLI-only, CLI plus minimal local UI, or another shape.
- Exact ownership boundary for replay fidelity: what Cappy guarantees versus what each game adapter guarantees.
- Where large recordings/replays/artifacts live by default and what Cappy is allowed to delete.
- How much OBS configuration Cappy owns versus requiring a preconfigured OBS scene/profile.
