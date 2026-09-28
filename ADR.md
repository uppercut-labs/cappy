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

**Decision:** Cappy's controller/capture host supports Windows and macOS from the first release. Linux acceptance is deferred. (Amended by ADR-021: Linux is supported post-V1, with OBS capture unverified.)

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

**Consequences:** An unresolved anchor follows the existing required/optional derivative semantics. Resolved windows and event IDs are recorded in the manifest. Producing one clip per match was deferred, then promoted as ADR-017.

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

## ADR-017 - One output per matching event, on request

**Status:** Accepted (2026-09-25, post-V1). Amends the "one output per role" part of ADR-014.

**Decision:** `occurrence: "every"` on a clip's `start`, or on a still's or thumbnail's `at`, produces one output per matching event, named `<role>-1`, `<role>-2`, and so on in timeline order, capped at 100. Each clip's `end` pairs with the first qualifying event after its own start. Config validation rejects role names that would collide with generated names.

**Rationale:** Montages and per-event evidence (every coin, every hit) are common, and writing one derivative per occurrence by hand does not scale when the count varies. Numbering outputs keeps each one a separate, hashed artifact, and the cap bounds the work.

**Consequences:** Manifest roles are no longer one-to-one with preset derivatives when `"every"` is used, but each generated role is predictable. Required/optional semantics apply per output.

## ADR-018 - Comparisons can gate on frames and on the timeline

**Status:** Accepted (2026-09-25, post-V1). Extends ADR-015.

**Decision:** Besides `--min-ssim` (mean), `cappy compare` accepts `--min-frame-ssim`, `--max-drift-ms`, and `--require-same-events`. Failing any gate records `regressed` and exits 1, and the manifest (`comparisonVersion: 2`) lists the `gates` given and the `failedGates`.

**Rationale:** The mean hides a glitch that lasts a few frames, and pixels miss logic regressions such as an event that no longer fires. Explicit, opt-in gates let CI choose its strictness. The defaults stay informational, which keeps the one-frame capture jitter from producing false failures.

**Consequences:** Comparison manifests move to version 2, replacing `threshold` with `gates`. Timeline gates look only at adapter events.

## ADR-019 - Named builds in configuration

**Status:** Accepted (2026-09-25, post-V1)

**Decision:** `builds` in `cappy.config.json` names game overrides (`command`, `args`, `cwd`, each replacing the base `game` field). `run`, `replay`, `record`, and `scenarios` take `--build <name>`. `cappy compare-builds` captures one session or scenario with two builds and compares them, as the sequence of the standalone commands. `base` names the base game. Manifests record `build.name`.

**Rationale:** Comparing builds is the main use of `compare`, and one configuration that names each build is simpler than juggling config files. It keeps build switching declarative and source-controlled. Composing the existing commands, rather than a new pipeline, keeps every artifact ordinary and every safety rule in force.

**Consequences:** Cappy still never builds games. A build is just another launch command. `compare-builds` stops at the first failed step.

## ADR-020 - Timelines are exported, not consumed

**Status:** Accepted (2026-09-25, post-V1)

**Decision:** `cappy timeline export` writes a capture's or session's timeline as JSON (with published JSON Schemas generated from the runtime schemas), CSV, or WebVTT, to standard output or to a new, unmanaged file.

**Rationale:** Other tools, such as review or commentary tools, can read Cappy timelines without Cappy depending on them, which is what `Ideas.md` asked for: an exportable envelope with no coupling. WebVTT makes events visible over the video in any player. Generating the schemas from the runtime schemas keeps them honest.

**Consequences:** The exported JSON is versioned (`timelineExportVersion`). Export files belong to the user, and Cappy never overwrites or deletes them.

## ADR-021 - Linux is a supported host, with OBS unverified

**Status:** Accepted (2026-09-25, post-V1). Amends ADR-003.

**Decision:** Linux is a supported Cappy host. Acceptance runs in a Debian bookworm (arm64) container on the owner's Mac (OrbStack), with Node.js 24, FFmpeg, and headless Godot 4.7.2, through `scripts/acceptance/linux-container.sh`. Real OBS capture on Linux is recorded as unverified.

**Rationale:** The shared core already avoids platform-specific semantics and uses POSIX process groups. A container gives repeatable evidence without a separate Linux machine. Linux hosts are also where CI and headless capture run.

**Consequences:** Linux results are recorded separately in `docs/acceptance.md` and never inferred from macOS. Verifying real OBS on Linux (for example with a virtual display) stays in `Ideas.md`.

## ADR-022 - Presentation for replays; event times are presented time

**Status:** Accepted (2026-09-25, post-V1)

**Decision:** Replay captures carry presentation parameters, as scenarios already did. Cappy defines two keys: `timeScale` (0.1 to 4), which needs the new `time_scale` capability, and `camera`, which needs `alternate_cameras`. Cappy adds those capabilities to the preset's requirements. Adapter event times are presented time, meaning what is on screen. Simulation time may be added to the payload. The Godot adapter and demo implement slow motion and a close camera.

**Rationale:** Re-capturing a moment at another speed or from another camera is the first step toward cinematic replay. Presented time keeps anchors, clips, and comparisons aligned with the master at any speed. The alternative, simulation time plus a declared scale, would push conversion into every consumer.

**Consequences:** The protocol gains an optional `presentation` on replay requests, an additive change within protocol version 1. Comparisons warn when presentations differ. Camera rails, free camera, shot lists, and multi-angle passes remain in `Ideas.md`.

## ADR-023 - Prepare Uppercut Labs ownership and npm distribution

**Status:** Accepted (2026-09-28).

**Decision:** Maintain and publish the project as `uppercut-labs/cappy`, crediting Devin Thomas as author and maintainer. Use the MIT license. Prepare one public npm package, `@uppercut-labs/cappy`, exposing the existing `cappy` CLI, and keep implementation and fixture workspaces private under their `@uppercut-labs/cappy-internal-*` and `@uppercut-labs/cappy-fixture-*` names. The npm package is not published as part of this work. The Godot addon remains available from versioned GitHub source; until a release tag exists, documentation must describe the current checkout accurately rather than imply a released addon.

**Approved scope:** Transfer the existing GitHub repository and prepare its public contents and npm package for review. Do not publish to npm and do not add or change product features. Preserve existing acceptance limits: macOS and Windows acceptance remains historical evidence, and real OBS capture on Linux remains unverified.

**Rationale:** A single executable package gives consumers a stable scoped install while keeping the implementation modular for contributors. Repository transfer preserves history and authorship; separating release preparation from publication leaves the package ready for a deliberate release decision.

**Consequences:** Consumer instructions use `npm install --global @uppercut-labs/cappy` or `npx @uppercut-labs/cappy` after publication. Contributor instructions use `node packages/cli/bin/cappy.js` from the checkout and never rely on unscoped `npx cappy`. Documentation must state that publication is pending and distinguish packaging checks from prior host acceptance evidence.
