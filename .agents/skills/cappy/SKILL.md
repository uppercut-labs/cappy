---
name: cappy
description: Set up, run, and troubleshoot Cappy, a local tool that captures reproducible game footage by launching an instrumented game, recording through OBS, cutting FFmpeg derivatives, and writing verified manifests. Use when installing the Cappy Godot addon, writing cappy.config.json or capture presets, registering scenarios or replay providers, running cappy doctor, scenarios, run, record, replay, compare, compare-builds, timeline export, or clean, or reading a Cappy error code. Not for general screen recording, video editing, or OBS configuration.
---

# Cappy

Cappy turns a moment in a game into repeatable, verifiable footage. It launches the game, talks to an adapter inside it over a loopback WebSocket, drives OBS to record, makes FFmpeg derivatives from the verified master, and writes a manifest with hashes, timing, and the game's event timeline.

Help the user reach one verified capture (or one verified replay, if they have no OBS) with the smallest correct setup. Do not treat Cappy as a UI, test, or gameplay framework: the game owns its simulation, replay data, and cameras; Cappy owns launch, recording, media, and storage.

## Safety boundary

- `doctor`, `scenarios`, `replay --no-capture`, `timeline export` to standard output, and `clean --dry-run` only read or play back. Run them freely.
- `run`, `replay` (with capture), `record --capture`, and `compare-builds` record the screen through OBS. Confirm the scene shows only what the user intends before the first one.
- `clean` without `--dry-run` deletes files. Show the dry-run result and get approval first.
- Never create, edit, or switch OBS scenes, profiles, or settings for the user. Cappy never does either; the user makes the scene.
- Never write the OBS WebSocket password into `cappy.config.json`, a script, a log, or a commit. It lives only in the environment variable that `obs.passwordEnv` names. Do not print its value.
- Do not install Node.js, Godot, FFmpeg, or OBS without the user's approval. Report what is missing instead.
- Real captures need a desktop session with a visible game window and a running OBS. In CI or a headless container, stop at `doctor`, `scenarios`, and `replay --no-capture`, and say that capture was not verified.

## Workflow

### 1. Locate Cappy and the project

- Cappy is delivered as an npm package whose command is `cappy`. Install it the way the package's README says, usually as a dev dependency of the game project, then run it with `npx cappy`. `npx cappy --version` confirms which version runs.
- Take the package name from the user or the package's own README. Never guess a name or install a similarly named package. If the package is not published yet, or the user cannot reach it, stop and say so.
- It needs Node.js 24 or newer. Check `node -v` first; an older Node is the most common failure.
- The *project* is the directory holding `cappy.config.json`, usually the game's own folder. Run commands from there, or pass `-C <project-dir>` from anywhere else.
- Supported hosts: macOS and Windows (accepted with real OBS), and Linux (accepted, real OBS capture unverified). Do not claim a host result you did not observe.

### 2. Connect the game

Cappy needs an adapter in the game. For Godot 4.x, copy the `addons/cappy/` folder that ships with Cappy into the game's `addons/` and enable the **Cappy** plugin (it registers the `Cappy` autoload). Then register at least one scenario or a replay provider. See [the Godot adapter reference](references/godot-adapter.md) for the API and patterns.

Other engines speak the same versioned protocol; point the user at Cappy's adapter protocol reference rather than inventing an adapter.

### 3. Write `cappy.config.json`

Start small and add presets later:

```json
{
  "schemaVersion": 1,
  "project": { "id": "my-game", "name": "My Game" },
  "game": { "command": "godot", "args": ["--path", "/absolute/path/to/my-game"] },
  "adapter": { "port": 0 },
  "obs": { "url": "ws://127.0.0.1:4455", "passwordEnv": "CAPPY_OBS_PASSWORD", "scene": "Capture" },
  "presets": { "master-only": {} },
  "defaultPreset": "master-only"
}
```

- Use absolute paths in `game.args`. `port: 0` lets Cappy pick a free loopback port.
- Remove `passwordEnv` only when OBS authentication is off. Have the user export the password themselves in their shell.
- Add `.cappy/` to the project's `.gitignore`; `doctor` warns until it is ignored.
- `adapter.requiredCapabilities` (for example `["scenarios"]`) makes every command that launches the game fail with `CAPABILITY_MISSING` until the game advertises that capability. Leave it out while the game is still being wired up.

Presets, event-anchored clips, presentation (slow motion, named cameras), and named builds are in [the configuration reference](references/configuration.md).

### 4. Check, then explore

```bash
npx cappy doctor -C <project-dir>
npx cappy scenarios -C <project-dir>
```

`doctor` checks config, workspace, the game command, FFmpeg/ffprobe, and OBS without launching the game. Fix every `FAIL`; `WARN` is advisory. `scenarios` launches the game, completes the handshake, lists registered scenarios with their parameters, and stops the game. If `scenarios` hangs until `ADAPTER_CONNECT_TIMEOUT`, the addon is not installed, not enabled, or the command launched something other than the game.

Add `--json` (`-j`) whenever you need to read a result: stdout is then exactly one JSON envelope with `ok`, `data`, `warnings`, and, on failure, `error.code`. Decide from `error.code` and the exit code, not from human text.

### 5. Capture

Authored scenario:

```bash
npx cappy run <scenario> --param key=value --preset <name> -C <project-dir>
```

Freeform play, then replay:

```bash
npx cappy record --duration 10 -C <project-dir>      # prints the session ID
npx cappy replay <session-id> --no-capture -C <project-dir>   # verify the playback first
npx cappy replay <session-id> -C <project-dir>                # then capture it
```

- A capture is done only when `data.state` is `succeeded`. Its folder, `.cappy/captures/<capture-id>/`, holds the master, derivatives, and `manifest.json`.
- Takes never overwrite. Run the command again for the next take, or pass `--take <n>`; an existing take fails with `TAKE_EXISTS`.
- Only sessions made by `record` can be replayed. `--headless` in `game.args` is fine for `scenarios`, `record`, and `replay --no-capture`, but OBS needs a visible window to capture.
- Ctrl+C cancels (exit 130) and stops any recording Cappy started. During `record`, Enter stops and keeps the session.

### 6. Compare and export (when asked)

- `cappy compare <capture-a> <capture-b>` scores two captures of the same source (SSIM/PSNR, triptych, timeline diff). Gates such as `--min-ssim 0.97` or `--require-same-events` turn a difference into exit 1 with `COMPARISON_REGRESSED`.
- `cappy compare-builds <session-or-scenario> <build-a> <build-b>` captures the same moment on two named builds and compares them in one step.
- `cappy timeline export <capture-or-session> --format vtt --out events.vtt` writes event captions (also `json`, `csv`). It never overwrites a file.
- `cappy clean --failed --dry-run` previews removing leftovers from failed or cancelled runs. Cappy deletes only files it can prove it created.

Every flag has a whole-token shorthand (`--no-capture` is `-nc`, `--param` is `-pa`); shorthands never group. `npx cappy --help` lists them.

## When something fails

Read `error.code` from `--json` output, then look it up in [troubleshooting](references/troubleshooting.md). Exit codes are stable: 0 success, 1 operation failed, 2 invalid usage, 3 configuration, 4 missing dependency, 70 internal error, 130 cancelled. Each command also writes `.cappy/logs/<correlation-id>.jsonl`; the correlation ID is in the JSON result.

## Report

Finish with:

- what ran, on which host, with the Cappy version (`npx cappy --version`), `node -v`, the engine version (for Godot, `godot --version`), and the FFmpeg, ffprobe, and OBS versions that `doctor --json` reported;
- the capture, session, or comparison IDs and their final state;
- where the outputs are, relative to the project;
- what was not verified and why (for example: no OBS, no display, a host you did not run on).

Never report a capture as working from fake tools, mocks, `--no-capture`, or another operating system's result.
