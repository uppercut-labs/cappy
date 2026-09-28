# Getting started

This walks a contributor through configuring Cappy and capturing the Godot demo. The same steps apply to your own Godot game once the [Cappy addon](../adapters/godot/README.md) is installed. Historical acceptance covers macOS and Windows; Linux support is documented separately, with real OBS capture on Linux unverified (see [acceptance.md](acceptance.md)). The npm package is upcoming and is not published yet.

## 1. Install the tools

| Tool | Needed for | Notes |
| --- | --- | --- |
| Node.js 24+ | Cappy itself | |
| Godot 4.x | the demo and Godot games | `godot` (or `godot.exe`) on PATH, or an absolute path in config |
| FFmpeg and ffprobe | `run`, `replay`, `doctor` | on PATH, or set `tools.ffmpeg` / `tools.ffprobe` |
| OBS Studio 28+ | `run`, `replay`, `record --capture` | enable **Tools > WebSocket Server Settings**; note the port and password |

The first time OBS opens, macOS asks you to confirm opening a downloaded app, and OBS may show a permissions review and an auto-configuration wizard. Finish or close these first: while one of them is open, OBS can stop answering WebSocket requests and Cappy reports `OBS_START_FAILED` or a timeout. Screen Recording permission is only needed for capture sources that read the screen or other windows.

In OBS, create the scene Cappy should record (for example `Capture`) with a Game Capture, Window Capture, or Display Capture source for the game. Cappy never creates or edits OBS scenes.

## 2. Install Cappy

When the first npm release is available, install the public package globally or invoke it once with its scoped name:

```bash
npm install --global @uppercut-labs/cappy
cappy doctor -C /path/to/project
npx @uppercut-labs/cappy doctor -C /path/to/project
```

The package requires Node.js 24 or newer. It does not install Godot, FFmpeg, or OBS for you. Until that release, use the contributor checkout steps below.

## 3. Build Cappy and the demo

```bash
git clone https://github.com/uppercut-labs/cappy.git
cd cappy
npm install
npm run build
npm run godot:demo
```

`npm run godot:demo` writes `.godot-demo/`: the demo game with the Cappy addon installed.

## 4. Create a project

Make a project directory anywhere and add `cappy.config.json`. Start from [cappy.config.example.json](../cappy.config.example.json); for the demo:

```json
{
  "schemaVersion": 1,
  "project": { "id": "godot-demo", "name": "Cappy Godot Demo" },
  "game": { "command": "godot", "args": ["--path", "/absolute/path/to/cappy/.godot-demo"] },
  "adapter": { "port": 0 },
  "obs": { "url": "ws://127.0.0.1:4455", "passwordEnv": "CAPPY_OBS_PASSWORD", "scene": "Capture" },
  "presets": {
    "trailer": {
      "derivatives": [
        { "kind": "mp4", "role": "delivery" },
        { "kind": "thumbnail", "role": "thumb", "options": { "at": 1 } },
        { "kind": "still", "role": "settled", "required": false, "options": { "at": { "event": "SETTLED" } } }
      ]
    }
  },
  "defaultPreset": "trailer"
}
```

- Add `--headless` to `game.args` to run without a window (useful for `scenarios`, `record`, and `replay --no-capture`; OBS needs a visible window to capture).
- Put the OBS password in the environment, never in the file:
  - macOS/Linux: `export CAPPY_OBS_PASSWORD='…'`
  - Windows PowerShell: `$env:CAPPY_OBS_PASSWORD = '…'`
- If OBS authentication is off, remove `passwordEnv`.
- Add `.cappy/` to the project's `.gitignore`.
- The `settled` still is anchored to the demo's `SETTLED` event rather than a fixed second. It is optional because only `orb_launch` emits that event. See [presets.md](presets.md) for anchors.

## 5. Check the setup

Run commands from the Cappy repository with `-C` pointing at your project:

```bash
node packages/cli/bin/cappy.js doctor -C /path/to/project
```

Every check should pass. Fix anything marked `FAIL`; `WARN` is advisory.

## 6. Explore the game

```bash
node packages/cli/bin/cappy.js scenarios -C /path/to/project
```

The demo registers `orb_launch` with `power` (integer 1-5) and `gravity` (number 0.5-4).

## 7. Record and replay a freeform session

```bash
node packages/cli/bin/cappy.js record --duration 3 -C /path/to/project
node packages/cli/bin/cappy.js replay <session-id> --no-capture -C /path/to/project
```

`record` prints the session ID. Only freeform sessions made by `record` can be replayed; `run` also creates a scenario session, which has no replay payload. The replay reproduces the recorded jumps, landings, and coins at the same simulation times. Without `--duration`, press Enter to stop or Ctrl+C to cancel.

## 8. Capture

```bash
node packages/cli/bin/cappy.js run orb_launch --param power=4 -C /path/to/project
node packages/cli/bin/cappy.js replay <session-id> -C /path/to/project
```

Each capture leaves `.cappy/captures/<capture-id>/` with `master.<ext>` (OBS 32 records Hybrid MOV by default, so `master.mov`), the preset's derivatives, and `manifest.json`. Run the same command again for take 2; use `--take <n>` to choose a take explicitly.

## 9. Compare two builds

Name builds in the config, then capture the same moment with each and compare. The demo has a variant for this: the user argument `--variant=b` reports build `0.1.0+b` and draws a larger green orb.

```json
"builds": {
  "b": { "game": { "args": ["--path", "/absolute/path/to/cappy/.godot-demo", "--", "--variant=b"] } }
}
```

```bash
node packages/cli/bin/cappy.js compare-builds orb_launch base b -pa power=4 -C /path/to/project
```

The result holds both captures and a comparison with its triptych, scores, and timeline diff. Add gates such as `--min-ssim 0.999` to fail on a visual difference (the variant's orb is one), or `--require-same-events` to fail on a logic difference.

The OBS scene must show the game window for a visual difference to register. On macOS, give OBS Screen Recording permission, then add a **macOS Screen Capture** source for the display. Launch the game at a fixed place with Godot's `--position 240,240 --always-on-top` in `game.args` (before any `--`), and crop the source to the window (Edit Transform, Crop). With that window position on a 2x display, the demo's content spans pixels 240 to 1200 by 240 to 780.

Use `--json` on any command for machine-readable output. See [cli.md](cli.md) for every command and [storage.md](storage.md) for the workspace layout and cleanup rules.
