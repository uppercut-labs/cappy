# Cappy Architecture Decision Record

## ADR-001 - Replay is a first-class V1 subsystem

**Status:** Accepted

**Decision:** Cappy V1 includes replay recording and replay execution as a core capability alongside capture automation.

**Rationale:** Replaying a previously observed development moment is central to re-capturing it after camera, UI, rendering, or content changes. Treating replay as deferred would weaken Cappy's most reusable advantage.

**Consequences:** The core protocol and manifest model must represent replay capability explicitly. Game adapters may differ in how replay is implemented, but the architecture cannot treat replay as an optional afterthought.

## ADR-002 - Support authored scenarios and freeform sessions

**Status:** Accepted

**Decision:** V1 supports both named, parameterized authored scenarios and spontaneous developer sessions that can be recorded for later replay.

**Rationale:** Authored scenarios provide the strongest deterministic capture path, while freeform recording preserves unexpected or naturally discovered moments worth reproducing later.

**Consequences:** Session/replay storage must identify its origin and capabilities. Tests must cover both pathways.

## ADR-003 - Windows and macOS are V1 host platforms

**Status:** Accepted

**Decision:** Cappy's controller/capture host supports Windows and macOS from the first release. Linux acceptance is deferred.

**Rationale:** The first intended projects already span Windows and macOS. Designing process control, filesystem handling, and external-tool integration for both early prevents accidental Windows-only assumptions.

**Consequences:** Cross-platform abstractions and CI/test strategy must account for both operating systems. Linux should remain architecturally possible without becoming a V1 acceptance gate.

## ADR-004 - OBS records; FFmpeg post-processes

**Status:** Accepted

**Decision:** OBS controlled through OBS WebSocket is Cappy's primary V1 recording backend. FFmpeg/ffprobe handle post-processing, inspection, derivatives, and related media operations.

**Rationale:** OBS already solves difficult real-world capture concerns. Cappy's differentiated work is game orchestration, replay, synchronization, repeatability, metadata, and artifact management rather than rebuilding a recorder.

**Consequences:** V1 depends on a usable OBS installation and an FFmpeg strategy. Capture success must be verified through their observable outputs and state.

## ADR-005 - Graphviz DOT is the living-model source

**Status:** Accepted

**Decision:** Maintain Cappy's living system model as Graphviz DOT.

**Rationale:** DOT is deterministic, diffable, agent-friendly, and appropriate for Cappy's system/process boundaries.

**Consequences:** `docs/system-model.dot` is canonical. Rendered SVG/PNG files, when generated, are derived and must not become competing sources of truth.
