# V1 host acceptance

Each supported host is accepted separately. A result on one operating system is never taken as evidence for another. Items not yet run are listed as unresolved, not as supported. Both V1 hosts, macOS and Windows, are accepted.

## How to run acceptance on a host

```bash
npm install
npm run typecheck
npm run lint
npm test                                   # normal suite; needs no OBS, Godot, or FFmpeg
CAPPY_REAL_TOOLS=1 npm test                # adds real FFmpeg/ffprobe and headless Godot 4.x
CAPPY_OBS_SMOKE=1 CAPPY_OBS_SCENE=Capture npm test   # adds real OBS capture (OBS running, WebSocket on)
npm run model:check                        # Graphviz (WebAssembly) model validation
```

On Windows, also run `pwsh -NoProfile -File scripts/acceptance/windows-ctrl-c.ps1` from an interactive console.

Then follow [getting-started.md](getting-started.md) end to end with the Godot demo, including step 7 (captures with OBS).

## macOS: accepted

Host: macOS 27.0 (arm64), Node.js 24.18.0, Godot 4.7.2, FFmpeg/ffprobe 9.0.1, OBS Studio 32.2.2 (WebSocket 5.7.4). Run 2026-09-25 (America/Chicago).

| Area | Result | Evidence |
| --- | --- | --- |
| Typecheck, lint, whitespace | Pass | `npm run typecheck`, `npm run lint`, `git diff --check` |
| Normal suite | Pass | `npm test`: 189 passed, 10 skipped (opt-in real-tool tests) |
| Real FFmpeg/ffprobe | Pass | `CAPPY_REAL_TOOLS=1 npm test`: a real H.264/AAC master probed; real mp4, clip, thumbnail, and still derivatives; a zero-frame still fails and keeps the master |
| Real Godot scenario and replay | Pass | headless Godot 4.7.2: scenario registry, deterministic `orb_launch` timelines, validation hook, freeform record and replay, replay captured through the full pipeline (with the fake OBS) |
| Processes | Pass | game launched with endpoint and token; process group stopped after `scenarios`; a game that never connects is killed after `connectMs`; a game that exits early is reported |
| Signals | Pass | the real `cappy` binary exits 130 on SIGINT with cancelled metadata; Enter stops a recording |
| Paths | Pass | traversal, absolute, drive-letter, symlinked-directory, and swapped-symlink cases rejected; real paths used for Git-ignore checks under `/private/var` temp folders |
| Getting started, steps 1-6 | Pass | build, `godot:demo`, config, `doctor`, `scenarios`, `record`, `replay --no-capture` followed literally in a new project |
| Real OBS capture | Pass | `CAPPY_OBS_SMOKE=1 CAPPY_OBS_SCENE=Capture npm test`: doctor passes against real OBS with password authentication; a real recording is confirmed started and stopped, verified, moved out of `~/Movies`, probed, and processed; the manifest does not contain the password |
| Getting started, step 7 | Pass | with real OBS and real Godot: `run orb_launch --param power=4` produced a 1280x720 QuickTime master, MP4 and thumbnail derivatives, and a manifest with `timing.sync`; `replay <session-id>` captured the recorded Godot run the same way |
| Graphviz model check | Pass | `npm run model:check` with Graphviz 16.1.0 (WebAssembly); a malformed model is rejected; `npm run model:render` writes `docs/system-model.svg` |

## Windows: accepted

Host: Windows 11 (NT 10.0.26200, x64), Node.js 24.18.0, Godot 4.7.2, FFmpeg/ffprobe 6.0, OBS Studio 32.2.2 (WebSocket 5.7.4). Run 2026-09-25 (America/Chicago).

| Area | Result | Evidence |
| --- | --- | --- |
| Typecheck, lint | Pass | `npm run typecheck`, `npm run lint` |
| Normal suite | Pass | `npm test`: 187 passed, 12 skipped (10 opt-in real-tool tests, 2 POSIX-only signal tests) |
| Real FFmpeg, Godot, and OBS | Pass | with every opt-in switch on: 197 passed, 2 skipped (the POSIX-only signal tests) |
| `cmd.exe` launches | Pass | fake FFmpeg/ffprobe run through `.cmd` launchers across the doctor, capture, derivative, and failure tests |
| Processes | Pass | a game that never connects is stopped with `taskkill /T /F`; game processes end after each command |
| Paths | Pass | drive-letter, traversal, and junction cases rejected; masters moved from `C:\Users\<user>\Videos` into the workspace; nothing left behind |
| Getting started, steps 1-7 | Pass | `doctor` (all checks pass), `scenarios`, `record`, `replay --no-capture`, `run orb_launch --param power=4`, and `replay <session-id>` with real Godot and OBS; both manifests `succeeded` with 1280x720 MP4 masters, MP4 and thumbnail derivatives, and `timing.sync` |
| Graphviz model check | Pass | `npm run model:check` (WebAssembly Graphviz 16.1.0) |
| Ctrl+C from a Windows console | Pass | `scripts/acceptance/windows-ctrl-c.ps1`, run in an interactive console: exit 130, `OPERATION_CANCELLED`, session `cancelled`, no processes left |

The OBS run used a separate portable OBS (`--portable`, WebSocket port 4456) with a color-source test scene, so the host's own OBS configuration was not touched.

Found and fixed during the Windows run: npm on Windows does not create the `cappy` command shim when the bin target does not exist at install time, so `npx cappy` failed after `npm install` followed by `npm run build`. The bin is now a committed launcher (`packages/cli/bin/cappy.js`) that loads the build and explains when it is missing.

## Remaining limitations

- Linux is outside V1 acceptance (ADR-003).
- The Windows Ctrl+C check is a script, not part of `npm test`: it must run in an interactive console, because processes started over SSH inherit an "ignore Ctrl+C" attribute that Node does not clear.
