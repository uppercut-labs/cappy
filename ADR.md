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

## ADR-012 - Cleanup is an explicit command that deletes immediately

**Status:** Accepted (2026-09-25, post-V1)

**Decision:** `cappy clean` deletes the managed items it selects when it runs. `--dry-run` previews the same selection without changing anything. Items are selected by ID (capture, session, comparison) or by the explicit bulk selectors `--failed`, `--older-than`, `--logs`, and `--all`; raw paths are not accepted. Cleaning a scenario capture also removes the scenario session it created. Cleaning a capture never removes a replayed session.

**Rationale:** The owner chose conventional CLI behavior over a confirm-by-default flow. Destructive safety already lives in the workspace primitive: only registered, unmodified, managed files inside the root can be deleted, whatever the command asks. Explicit selectors satisfy the rule that bulk cleanup needs an explicit command or flag. Selecting by item ID matches how people and manifests refer to captures and sessions.

**Consequences:** Agents and scripts should run `--dry-run` first when a selection is broad. Anything a live command owns is protected by the run locks. Refusals make the command exit 1 while still removing what it safely can.

## ADR-013 - Take numbers are never reissued

**Status:** Accepted (2026-09-25, post-V1)

**Decision:** Removing a successful capture retires its take number for its source. Retired takes are recorded in the workspace registry (schema version 2), and take allocation treats them as used.

**Rationale:** Takes are cited outside Cappy, in bug reports, devlogs, and review notes. If take 3 could later mean a different capture, those citations would silently change meaning. SPEC section 16 already promised monotonic takes. The registry is the one file that already records what cleanup did, so the ledger lives there.

**Consequences:** Take numbering can have gaps. A version 1 registry is upgraded on its next write, and older Cappy builds refuse a version 2 registry instead of reissuing takes.

## ADR-014 - Derivative times may be anchored to timeline events

**Status:** Accepted (2026-09-25, post-V1)

**Decision:** Clip start and end times, and still and thumbnail times, may be event anchors. An anchor names an event type, an occurrence (n-th or last), optional payload equality conditions (`where`, with dot-separated paths), and an offset in seconds. Anchors resolve against the capture's master-clock timeline during processing. Each preset derivative produces at most one output.

**Rationale:** Cappy's value is capturing semantic moments, and the synchronized timeline already exists by processing time. Payload conditions make an anchor precise without Cappy interpreting game semantics. Keeping one output per role keeps manifest roles one-to-one with preset derivatives.

**Consequences:** An unresolved anchor follows the existing required/optional derivative semantics. Resolved windows and event IDs are recorded in the manifest. Producing one clip per match is deferred to `Ideas.md`.

## ADR-015 - Comparison works on existing captures of the same source

**Status:** Accepted (2026-09-25, post-V1). Narrows the V1 non-goal on cross-build comparison.

**Decision:** `cappy compare <a> <b>` compares two successful captures of the same source, aligned at their operation start events. It produces a triptych video (A, B, and the difference), per-frame SSIM/PSNR, worst-frame stills, and a timeline diff under a new managed `comparisons/` area, with its own manifest. `--min-ssim` gates on mean SSIM, recording `regressed` and exiting 1. The timeline diff is informational.

**Rationale:** How a build is switched is project-specific, and replay capture already produces the inputs. Comparing existing captures reuses FFmpeg, which is already a dependency, and needs no change to orchestration. Mean SSIM is robust to the one-frame capture jitter that a per-frame minimum would flag as a regression.

**Consequences:** Cappy does not launch two builds itself; that orchestration stays in `Ideas.md`, as do per-frame and timeline gates. A comparison references its captures but never owns them, so cleaning a comparison keeps them.

## ADR-016 - CLI shorthands are whole-token initials

**Status:** Accepted (2026-09-25, post-V1)

**Decision:** Every long flag has a single-dash shorthand. A multi-word flag uses its initials (`--dry-run` is `-dr`). A one-word flag uses its first letter, and on a collision the less-used flag takes two letters. Shorthands are whole tokens, so POSIX grouping is not supported. `-C` is kept for `--project`.

**Rationale:** The owner prefers memorable initials-style shorthands (`--full-command` as `-fc`) across the whole CLI. Node's `parseArgs` supports only single-letter shorts, so an alias layer that translates whole tokens keeps parsing strict and predictable.

**Consequences:** One alias table, checked by tests for collisions and for following the rule, is translated before argument parsing. Every new flag must fit the rule.
