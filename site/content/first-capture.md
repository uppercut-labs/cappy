# First capture

Cappy needs Node.js 24+, an instrumented game, FFmpeg/ffprobe, and OBS Studio 28+ with its WebSocket server enabled. Godot games use the included Godot 4.x addon. Cappy does not install these system applications or create OBS scenes.

## Install

```bash
npm install --save-dev @uppercut-labs/cappy
npx cappy --version
```

Only run `npx cappy` after installing the scoped dependency. For one-shot use, run `npx @uppercut-labs/cappy` instead.

For Godot, copy `node_modules/@uppercut-labs/cappy/addons/cappy/` to your game's `addons/cappy/`, then enable Cappy in Project Settings > Plugins. Register your scenario using the [Godot guide](godot.md).

## Configure

Create `cappy.config.json` in the game project. Replace the example game directory and scene name with your actual configuration:

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

Set `CAPPY_OBS_PASSWORD` privately in your shell. Omit `passwordEnv` only if OBS authentication is off. Add `.cappy/` to `.gitignore`.

In OBS, create the named scene and a source showing only the intended game. Finish any first-run permission or setup dialogs. On macOS, allow Screen Recording when your source needs it.

## Check and record

```bash
npx cappy doctor --json
npx cappy scenarios --json
```

Fix every failed check. `scenarios` launches the game and returns the actual names and parameter schemas. Run one of those scenarios with `npx cappy run`, followed by its name. Add `--param key=value` only for parameters the scenario exposes.

For freeform replay, record a bounded session, then use the returned session ID:

```bash
npx cappy record --duration 10 --json
npx cappy replay <session-id> --no-capture --json
npx cappy replay <session-id> --json
```

The last command records through OBS. A successful capture reports `data.state: succeeded` and leaves a master plus `manifest.json` under `.cappy/captures/<capture-id>/`. Repeating a capture allocates the next take; existing takes are never overwritten. Ctrl+C cancels and stops a recording Cappy started.

Only freeform sessions made by `record` can be replayed. A scenario session from `run` has no replay payload.

## Without OBS

You can inspect scenarios and verify `replay --no-capture`. That verifies playback, not recording. macOS and Windows have historical real-OBS acceptance; Linux real-OBS capture remains unverified. See [host acceptance](acceptance.md).
