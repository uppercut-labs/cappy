# Cappy Architecture Decision Record

## ADR-001 - Replay is a first-class V1 subsystem

**Status:** Accepted

**Decision:** Cappy V1 includes replay recording and replay execution as a core capability alongside capture automation.

**Rationale:** Replaying a previously observed development moment is central to re-capturing it after camera, UI, rendering, or content changes.

**Consequences:** The core protocol and manifest model represent replay capability explicitly.

## ADR-002 - Support authored scenarios and freeform sessions

**Status:** Accepted

**Decision:** V1 supports both named, parameterized authored scenarios and spontaneous developer sessions that can be recorded for later replay.

**Rationale:** Authored scenarios provide the strongest deterministic capture path, while freeform recording preserves naturally discovered moments.

**Consequences:** Session/replay storage identifies its origin and capabilities. Tests cover both pathways.

## ADR-003 - Windows and macOS are V1 host platforms

**Status:** Accepted

**Decision:** Cappy's controller/capture host supports Windows and macOS from the first release. Linux acceptance is deferred.

**Rationale:** Intended projects already span Windows and macOS.

**Consequences:** Process, path, subprocess, and tool-discovery abstractions must work on both hosts.

## ADR-004 - OBS records; FFmpeg post-processes

**Status:** Accepted

**Decision:** OBS controlled through OBS WebSocket is Cappy's primary V1 recording backend. FFmpeg/ffprobe handle post-processing, inspection, derivatives, and related media operations.

**Rationale:** Cappy's differentiated value is game orchestration, replay, synchronization, repeatability, metadata, and artifact management rather than rebuilding a recorder.

**Consequences:** V1 validates OBS and FFmpeg dependencies and verifies their observable outputs.

## ADR-005 - Graphviz DOT is the living-model source

**Status:** Accepted

**Decision:** Maintain Cappy's living system model as Graphviz DOT.

**Rationale:** DOT is deterministic, diffable, agent-friendly, and appropriate for Cappy's system/process boundaries.

**Consequences:** `docs/system-model.dot` is canonical; rendered previews are derived.

## ADR-006 - TypeScript and Node.js implement the V1 controller

**Status:** Accepted

**Decision:** Use TypeScript and Node.js for Cappy's core packages, CLI, protocol tooling, orchestration, and automated tests.

**Rationale:** The system is dominated by cross-platform process orchestration, JSON/schema work, WebSockets, filesystem operations, and CLI automation, all of which fit the existing TypeScript toolchain well.

**Consequences:** Engine adapters may use their native language while conforming to the protocol. Core packages use strict TypeScript.

## ADR-007 - V1 is CLI-first with machine-readable output

**Status:** Accepted

**Decision:** The primary operator surface is a CLI with concise human output and an explicit structured JSON mode for agents, scripts, and CI.

**Rationale:** Automation and composability matter more than a GUI in the first release.

**Consequences:** Commands and errors require stable exit behavior and structured result schemas. A desktop GUI is deferred.

## ADR-008 - Game adapters own replay semantics

**Status:** Accepted

**Decision:** Cappy defines replay lifecycle, capability negotiation, metadata, storage envelope, and commands, while each game adapter owns the actual replay representation and fidelity guarantees.

**Rationale:** A universal replay encoding would incorrectly assume common simulation semantics across engines and games.

**Consequences:** Replay payloads are opaque to core Cappy. Features such as seeking or alternate cameras are capability-gated.

## ADR-009 - Generated artifacts default to a managed per-project workspace

**Status:** Accepted

**Decision:** Cappy defaults generated state to an ignored `.cappy/` workspace, supports a configurable external artifact root, and deletes only artifacts it created and tracks as managed.

**Rationale:** This keeps project use simple while protecting user-owned and externally owned files.

**Consequences:** Source-controlled configuration lives outside `.cappy/`. Cleanup requires ownership metadata and never deletes imported/external files.

## ADR-010 - V1 game transport is localhost WebSocket with versioned JSON

**Status:** Accepted

**Decision:** Use a local WebSocket connection with versioned JSON protocol messages between Cappy and game adapters.

**Rationale:** Bidirectional event flow is required; WebSockets are available across Godot and common future engine/runtime targets and avoid coupling protocol semantics to Node IPC.

**Consequences:** Protocol schemas are versioned and validated on both sides. Authentication is limited to local-session isolation in V1; the listener must bind only to loopback by default.

## ADR-011 - OBS configuration remains OBS-owned

**Status:** Accepted

**Decision:** Cappy references and validates expected OBS configuration but does not author or mutate OBS scenes/profiles as part of normal V1 operation.

**Rationale:** OBS already owns capture composition. Automatically rewriting its project state would expand scope and introduce destructive configuration risk.

**Consequences:** Preflight fails clearly when configured OBS expectations are unavailable. Cappy controls recording state, not scene construction.
