# V1 host acceptance

Each supported host is accepted separately. A result on one operating system is never taken as evidence for another. Items not yet run are listed as unresolved, not as supported. Both V1 hosts, macOS and Windows, are accepted. Linux was accepted post-V1, with real OBS capture unverified (see [Linux](#linux-accepted-obs-unverified)).

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

## Post-V1 increments (CAP-011 to CAP-015)

These cover whole-token flag shorthands, `cappy clean` with retired takes, event-anchored derivatives, and `cappy compare`. Each host is accepted separately, as for V1. Both hosts ran the Godot demo with real Godot 4.7.2, real FFmpeg, and a real OBS whose `Capture` scene is a color test source. The masters therefore prove the capture, anchoring, comparison, and cleanup pipeline, not the game's pixels. Cappy never changes OBS scenes.

Run the same flow on a host with a project configured like the one below, then run the commands in order:

```json
"presets": {
  "accept": { "derivatives": [
    { "kind": "mp4", "role": "delivery" },
    { "kind": "clip", "role": "second-bounce", "options": { "start": { "event": "BOUNCE", "offset": -0.5, "where": { "bounce": 2 } }, "end": { "event": "SETTLED", "offset": 0.5 } } },
    { "kind": "still", "role": "settled", "required": false, "options": { "at": { "event": "SETTLED" } } },
    { "kind": "thumbnail", "role": "launch", "options": { "at": { "event": "LAUNCH" } } } ] },
  "replay": { "derivatives": [ { "kind": "thumbnail", "role": "thumb", "options": { "at": { "event": "REPLAY_STARTED" } } } ] },
  "broken": { "derivatives": [ { "kind": "clip", "role": "finale", "options": { "start": { "event": "BOSS_DEFEATED" }, "duration": 1 } } ] }
}
```

```bash
cappy run orb_launch -pa power=4 -p accept   # anchored clip, still, and thumbnail
cappy record -d 3
cappy replay <session> -p replay             # twice
cappy compare <capture-1> <capture-2> -ms 0.95
cappy run orb_launch -p broken               # fails: its anchor never happens
cappy clean --failed -dr                     # then without -dr
cappy clean <comparison> <capture-1> -dr     # then without -dr
cappy replay <session> -p replay -t 1        # refused: take 1 is retired
```

### macOS: accepted

Host: macOS 27.0 (arm64), Node.js 24.18.0, Godot 4.7.2 (windowed), FFmpeg/ffprobe 9.0.1, OBS Studio 32.2.2 (WebSocket 5.7.4). Run 2026-09-25 (America/Chicago) with the final code, after every fix listed on this page.

| Area | Result | Evidence |
| --- | --- | --- |
| Typecheck, lint, whitespace, model | Pass | `npm run typecheck`, `npm run lint`, `git diff --check`, `npm run model:check` |
| Normal suite | Pass | `npm test`: 253 passed, 14 skipped (opt-in) |
| Every real tool | Pass | `CAPPY_REAL_TOOLS=1 CAPPY_OBS_SMOKE=1 CAPPY_OBS_SCENE=Capture npx vitest run`: 267 passed |
| Anchored derivatives | Pass | The `second-bounce` clip ran from `BOUNCE` (`bounce` = 2) minus 0.5 s (1322.9 ms) through `SETTLED` plus 0.5 s, and was clamped to the master's end (2300 ms) with a warning. This master ended before `SETTLED` (2322.9 ms), so the `settled` still was clamped to 2300 ms, with a warning, and still got the master's last frame (1280x720 PNG). The `launch` thumbnail is at `LAUNCH`. The manifest records every window and event ID. |
| Comparison | Pass | Two replay captures of one recorded session compared `succeeded`, aligned on `REPLAY_STARTED` over 2984 ms at 1280x720 and 30 fps (89 frames, SSIM 1.0 against the static test scene). Worst frames at 0, 1000, and 2000 ms. The timeline diff shows five event types with equal counts and 0 ms drift (deterministic replay). The same-build warning appeared. |
| Cleanup | Pass | `clean --all -dr` on a project with no workspace created nothing. `clean --failed -dr` previewed the failed capture (`DERIVATIVE_ANCHOR_UNRESOLVED`) and its scenario session, and the real run removed exactly those files. `clean <comparison> <capture-1>` removed both, exactly as previewed, retired take 1 of the replayed session, and kept the session. Repeating it exits 1 with `not_found`. Registry schema 2. `replay … -t 1` exits 2 with `TAKE_EXISTS` (retired). No registry lock file was left behind. |
| Shorthands | Pass | Every command above used shorthands (`-pa`, `-p`, `-d`, `-ms`, `-dr`, `-t`, `-j`) |

Found and fixed during this run: an anchored still at `SETTLED` got no frame. The OBS master reported 2333 ms, but its last decodable frame was at 2267 ms, and seeking past it yields nothing. Stills, thumbnails, and comparison worst-frame stills now read the second of video that ends at the requested time and keep its last frame, the frame at or before that time. A real-FFmpeg regression test with a master whose audio outlasts its video covers this.

Found and fixed after an independent review of CAP-011 to CAP-015, before the final runs on both hosts:

- `clean` could walk into an item directory, or a whole storage area, that was a link or junction, and remove empty directories outside the managed root. Such items are now refused as `symlink` and never walked. Only folders named like Cappy IDs count as items.
- Registry updates from concurrent commands could overwrite each other. Every update now holds an exclusive lock file, and a stale lock is broken after 10 s. A test with four concurrent writers keeps all 40 entries and every retired take.
- Option values starting with `-` (`--config -c`) were rejected by strict parsing. They now pass as values.
- `clean --dry-run` could create `.cappy/` or a missing storage area. It now opens the workspace read-only.
- Any live command now protects every `active` session from `clean`, as SPEC 11.7 says.
- The V1 "OBS disconnects during the scenario" test fired on a fixed 400 ms timer, which made it fragile under Windows' heavier parallel load. It now disconnects just after OBS receives `StartRecord`.
- The real-FFmpeg "identical masters" comparison test failed once on macOS right after a restart. Its test pattern moves, and the two captures' aligned starts differ by a few milliseconds. When they land on either side of a frame boundary, the frames compare one apart, which scored 0.9984 against the test's 0.999. The test now uses a static pattern, which scores 0.99997 in the same case. Product behavior is unchanged: that one-frame capture jitter is why the gate uses mean SSIM (ADR-015).

### Windows: accepted

Host: Windows 11 (NT 10.0.26200, x64), Node.js 24.18.0, Godot 4.7.2 (headless), FFmpeg/ffprobe 6.0, portable OBS Studio 32.2.2 (WebSocket 5.7.4, port 4456, color test scene). Run 2026-09-25 (America/Chicago) over SSH, with the tree synced from macOS.

| Area | Result | Evidence |
| --- | --- | --- |
| Typecheck, lint, model | Pass | `npm run typecheck`, `npm run lint`, `npm run model:check` |
| Normal suite | Pass | `npx vitest run`: 251 passed, 16 skipped (opt-in and POSIX-only) |
| Every real tool | Pass | `CAPPY_REAL_TOOLS=1 CAPPY_OBS_SMOKE=1` with real FFmpeg, Godot, and OBS: 265 passed, 2 skipped (the POSIX-only signal tests). The OBS smoke file also passes on its own (2 passed), and the final version of `compare.test.ts` passes with real FFmpeg (13 passed). |
| Anchored derivatives | Pass | The `second-bounce` clip ran from `BOUNCE` (`bounce` = 2) minus 0.5 s (1300.9 ms) through `SETTLED` plus 0.5 s, and was clamped to the master's end (2333 ms) with a warning. The `settled` still is at `SETTLED` (2300.9 ms), 1280x720, and the `launch` thumbnail is at `LAUNCH`. |
| Comparison | Pass | Two replay captures of one recorded session compared `succeeded`, aligned on `REPLAY_STARTED` over 3014 ms at 1280x720 and 30 fps (90 frames, SSIM 1.0). Worst frames at 0, 1000, and 2000 ms, and all 12 outputs present. The timeline diff shows five event types with equal counts and at most 0.001 ms drift. The same-build warning appeared. |
| Cleanup | Pass | `clean --failed -dr` previewed the failed capture (`DERIVATIVE_ANCHOR_UNRESOLVED`) and its scenario session, and the real run removed exactly the previewed files. `clean <comparison> <capture-1>` did the same, retired take 1 of the replayed session, and kept the session. Repeating it exits 1 with `CLEAN_INCOMPLETE`. Registry schema 2. `replay … -t 1` exits 2 with `TAKE_EXISTS`. No master was left in `Videos`. |
| Shorthands in PowerShell | Pass | Typed at a prompt, `npx cappy clean --all -dr -C <dir> -j` and `npx cappy doctor -j -c missing.json` behave as documented. (A PowerShell script function must call `node packages/cli/bin/cappy.js @args`, because npm's `npx.ps1` shim drops splatted arguments there.) |

Found and fixed during the Windows runs:

- An adapter-server connect timeout that fired after the server closed threw an uncaught `TypeError` while reading the closed socket's address. This was a V1 latent bug that the heavier parallel load exposed. The endpoint is now fixed when the server starts listening.
- Four workspaces opened at once on a fresh root could fail with "not writable": Windows refuses to rename over a file another handle is reading. Creating a missing registry now takes the registry lock too, and registry reads and renames retry briefly on Windows' transient `EPERM`, `EACCES`, and `EBUSY`.
- Under the full parallel real-tool load, several V1 integration tests exceeded Vitest's 5 s default. The suite timeout is now 30 s.
- The real OBS took more than 10 s to identify under that load, so the smoke test's own config now allows `obsMs` 30 s.

## Linux: accepted, OBS unverified

Linux became a supported host post-V1 (ADR-021, amending ADR-003). It is accepted in a throwaway container, rerun with `scripts/acceptance/linux-container.sh`. The script copies the repository into the container, installs FFmpeg and Godot there, and runs the full validation, so it needs only Docker or OrbStack on the host.

Host: Debian GNU/Linux 12 (bookworm), aarch64 (OrbStack on the owner's Mac, kernel 7.0.11), Node.js 24.21.0, npm 11.19.0, FFmpeg 5.1.9 (Debian), Godot 4.7.2 (official linux.arm64, headless). Run 2026-09-25 (America/Chicago) at CAP-021's code.

| Area | Result | Evidence |
| --- | --- | --- |
| Typecheck, lint, model | Pass | `npm run typecheck`, `npm run lint`, `npm run model:check` |
| Normal suite | Pass | `npx vitest run`: 284 passed, 18 skipped (opt-in) |
| Real FFmpeg and Godot | Pass | `CAPPY_REAL_TOOLS=1 npx vitest run`: 300 passed, 2 skipped (the real-OBS smoke tests). This includes all 7 headless Godot tests: scenarios, record and replay, replay capture, the variant build through `compare-builds`, and half-speed close-camera replay. It also includes real-FFmpeg derivatives and every-match clips, comparisons with SSIM and worst frames, and WebVTT export read back by FFmpeg. |
| POSIX processes and signals | Pass | The process-group, signal, and Ctrl+C-cancellation tests (skipped on Windows) pass on Linux. |
| Real OBS capture | Unverified | Not run. OBS on a headless Linux host needs a virtual display (for example Xvfb) or a Linux desktop; `Ideas.md` keeps this. Capture tests on Linux use the fake OBS with real masters. |

No Linux-specific fix was needed.

## Remaining limitations

- Real OBS capture on Linux is unverified (see above).
- The acceptance OBS scenes are color test sources on both hosts, so the comparisons prove the pipeline, not visual differences in the game. Visual scoring against real changes is covered by the real-FFmpeg tests: a changed region lowers SSIM, and the worst frame falls inside it.
- On Windows, `compare` cannot use an FFmpeg wrapper script (`.cmd`) when the managed root is on a network share (UNC path), because `cmd.exe` refuses a UNC working directory. Point `tools.ffmpeg` at `ffmpeg.exe` in that case. This is untested on a share.
- The Windows Ctrl+C check is a script, not part of `npm test`: it must run in an interactive console, because processes started over SSH inherit an "ignore Ctrl+C" attribute that Node does not clear.
