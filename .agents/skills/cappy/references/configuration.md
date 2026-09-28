# Configuration

`cappy.config.json` lives in the project directory. Pass another file with `--config <path>` (`-c`), relative to the project. Every field is validated before the game launches.

## Top level

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | yes | Always `1`. |
| `project` | yes | `{ "id", "name" }`. The ID ties sessions and captures to this project. |
| `game` | yes | `{ "command", "args", "cwd" }`. How to launch the game. Prefer absolute paths. |
| `adapter` | no | `{ "host", "port", "requiredCapabilities" }`. The host must be loopback; `port: 0` picks a free port. |
| `obs` | for capture | `{ "url", "passwordEnv", "scene", "switchScene" }`. |
| `tools` | no | `{ "ffmpeg", "ffprobe" }` paths when they are not on PATH. |
| `workspace` | no | `{ "root" }` to move the managed `.cappy/` folder. |
| `presets` | no | Named capture presets (below). |
| `defaultPreset` | no | Preset used when `--preset` is not given. Without one, a capture keeps only the master. |
| `builds` | no | Named alternative launch commands (below). |
| `timeouts` | no | `connectMs`, `readyMs`, `obsMs`, `processMs`. Raise `connectMs` for a slow first import. |

## OBS

- The user creates the scene in OBS with a Game, Window, or Display Capture source that shows the game window. Cappy checks that the scene exists and never creates or edits it.
- `passwordEnv` names an environment variable; the password is read from it at run time and never written anywhere by Cappy. Remove the field only when OBS authentication is off.
- On a fresh OBS install, finish or close first-launch dialogs (permissions review, auto-configuration wizard) before running Cappy. While one is open, OBS can stop answering WebSocket requests, which shows up as `OBS_START_FAILED` or a timeout.

## Presets

A preset names the OBS scene to expect and the derivatives FFmpeg makes from each verified master.

```json
"presets": {
  "trailer": {
    "scene": "Capture",
    "derivatives": [
      { "kind": "mp4", "role": "delivery" },
      { "kind": "clip", "role": "moment", "options": {
        "start": { "event": "SPELL_CAST", "offset": -2 },
        "end": { "event": "IMPACT", "offset": 1 } } },
      { "kind": "thumbnail", "role": "thumb", "required": false, "options": { "at": 2 } }
    ]
  },
  "slowmo": { "presentation": { "timeScale": 0.5, "camera": "close" } }
}
```

| Kind | Output | Options |
| --- | --- | --- |
| `mp4` | `<role>.mp4` | `crf` (0-51), `preset` (x264), `audio` |
| `clip` | `<role>.mp4` | `start` (required), and exactly one of `duration` or `end`, plus the `mp4` options |
| `thumbnail` | `<role>.jpg` | `at`, `width` |
| `still` | `<role>.png` | `at` |

- `role` names the output and must be unique in the preset. A derivative is required unless it sets `"required": false`; a failed required derivative fails the capture but keeps the master.
- `start`, `end`, and `at` are seconds from the start of the master, or an **event anchor**: `{ "event": "IMPACT", "offset": 0.5, "occurrence": 2, "where": { "target.kind": "boss" } }`. `occurrence` is a number, `"last"`, or `"every"` (one output per matching event). Cappy's own `SCENARIO_STARTED` and `REPLAY_STARTED` events work as anchors too.
- An anchor with no matching event fails with `DERIVATIVE_ANCHOR_UNRESOLVED`. Make an anchored derivative optional when only some scenarios emit its event.
- `presentation.timeScale` (0.1 to 4) needs the game's `time_scale` capability; `presentation.camera` needs `alternate_cameras`.

## Builds

```json
"builds": {
  "b": { "game": { "args": ["--path", "/absolute/path/to/game", "--", "--variant=b"] } }
}
```

Each field a build gives replaces the base `game` field. Select one with `--build <name>` (`-b`) on `run`, `replay`, `record`, and `scenarios`; `base` means the plain `game`. `compare-builds` takes two build names directly.

## Workspace

Everything Cappy makes goes under `.cappy/` in the project: `sessions/`, `captures/`, `comparisons/`, and `logs/`, plus an ownership registry. Add `.cappy/` to `.gitignore`. Cappy deletes only files it registered and whose hash still matches, and only through `cappy clean`.
