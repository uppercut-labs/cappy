# Troubleshooting

Run the failing command again with `--json` and read `error.code`, `error.message`, and `error.details`. The exit code gives the category: 1 operation failed, 2 invalid usage, 3 configuration, 4 missing dependency, 70 internal error, 130 cancelled. Each command writes `.cappy/logs/<correlation-id>.jsonl` with the full sequence.

## Before any code

- `node -v` must report 24 or newer. Older Node fails at startup, before Cappy can report a code.
- `npx cappy --version` must print a version. If it does not, the Cappy package is not installed where the command runs; install it as its README describes.
- Every command needs the project: run it from the folder with `cappy.config.json`, or pass `-C <project-dir>`.

## Error codes

| Code | Usual cause | What to do |
| --- | --- | --- |
| `USAGE_INVALID` | Unknown command or flag, grouped shorthands (`-jh`), or a bad value. | Check `npx cappy --help`. Shorthands are whole tokens: `-nc`, not `-n -c`. |
| `CONFIG_NOT_FOUND` | No `cappy.config.json` in the project directory. | Pass `-C <project-dir>` or create the file. |
| `CONFIG_PARSE_ERROR` | The file is not valid JSON. | Fix the JSON; comments and trailing commas are not allowed. |
| `CONFIG_INVALID` | A field is missing or out of range. | `error.details` lists every problem with its path. |
| `DOCTOR_CHECKS_FAILED` | At least one doctor check failed. | Read each `fail` check in `data.checks`; each carries its own code. |
| `GAME_LAUNCH_FAILED` | `game.command` was not found or could not start. | Use an absolute path, or put the engine on PATH. `doctor` checks this without launching. |
| `GAME_EXITED` | The game quit before its adapter connected. | Run the same command and arguments by hand and read the engine's error. A wrong `--path` is common. |
| `ADAPTER_CONNECT_TIMEOUT` | The game started but never connected. | The addon is missing or disabled, the autoload is not named `Cappy`, or the command launched the editor or another project. A slow first import may need a larger `timeouts.connectMs`. |
| `CAPABILITY_MISSING` | The game did not advertise a capability the command, preset, or `adapter.requiredCapabilities` needs. | Register a scenario (`scenarios`), a replay provider (`replay`), or declare `time_scale` and `alternate_cameras` for presentation. Register during startup, before the handshake. |
| `SCENARIO_NOT_FOUND` | The scenario ID is not registered. | Run `cappy scenarios` and use an ID it lists. |
| `PARAMETER_INVALID` | A `--param` value fails the scenario's spec or its validate hook. | Check types and ranges shown by `cappy scenarios`. |
| `OPERATION_TIMEOUT` | The game never called `mark_ready()`, `complete()`, or `fail()`. | Make every operation end exactly once, including on error paths. |
| `ADAPTER_OPERATION_FAILED` | The game called `op.fail(code, message)`. | `error.message` carries the game's message and `error.details.adapterCode` its code. |
| `TOOL_NOT_FOUND` | FFmpeg or ffprobe is not on PATH. | Install it with the user's approval, or set `tools.ffmpeg` and `tools.ffprobe`. |
| `OBS_NOT_CONFIGURED` | A capture command ran without an `obs` section. | Add one, or use `replay --no-capture` to verify without OBS. |
| `OBS_SECRET_MISSING` | The variable named by `obs.passwordEnv` is not set in this shell. | Have the user export it in the same shell. Never put the password in the config file. |
| `OBS_UNREACHABLE` | OBS is not running, or its WebSocket server is off or on another port. | Start OBS, enable Tools > WebSocket Server Settings, and match `obs.url`. |
| `OBS_AUTH_FAILED` | The password in the environment variable is wrong. | Have the user re-export the password from OBS's WebSocket settings. |
| `OBS_SCENE_MISSING` | The preset's or `obs.scene` scene does not exist in OBS. | The user creates it in OBS; Cappy never creates scenes. Names are case-sensitive. |
| `OBS_ALREADY_RECORDING` | OBS was already recording. | Stop that recording in OBS. Cappy never takes over a recording it did not start. |
| `OBS_START_FAILED` | OBS refused or did not confirm recording. | Close OBS first-launch dialogs and permission prompts, check free disk space and the output folder, and try again. |
| `MASTER_MISSING`, `MASTER_INVALID` | OBS did not leave a usable recording where it reported. | Check OBS's recording path and format settings and that the disk is not full. |
| `DERIVATIVE_OPTIONS_INVALID` | A preset option is invalid (exit 3, before launch). | `error.details` lists every problem. |
| `DERIVATIVE_ANCHOR_UNRESOLVED` | No event matched an anchor. | Check the event name and `where` against the capture's timeline (`cappy timeline export <capture-id>`), or mark that derivative optional. |
| `DERIVATIVE_WINDOW_EMPTY` | An anchored window falls entirely outside the master. | Adjust the offsets. |
| `TAKE_EXISTS` | `--take <n>` names a take that already succeeded or was retired by `clean`. | Omit `--take` to get the next number. |
| `SESSION_NOT_FOUND` | The session ID does not exist in this project's workspace. | Use the ID `record` printed, with the same `-C`. |
| `SESSION_NOT_REPLAYABLE` | The session has no replay payload: it came from `run`, or it was cancelled. | Replay only sessions that `record` finished. |
| `REPLAY_INCOMPATIBLE` | The session belongs to another project or adapter, or the game no longer advertises `replay` or `deterministic_replay`. | Replay with the same game and adapter; a different game build only warns. |
| `REPLAY_PAYLOAD_INVALID` | The stored payload no longer matches its hash. | The session was modified on disk; record a new one. |
| `CAPTURE_NOT_FOUND` | A capture ID given to `compare`, `timeline export`, or `clean` does not exist. | List `.cappy/captures/`. |
| `COMPARE_INCOMPATIBLE` | The two captures do not share a source. | Compare replays of one session, or runs of one scenario with the same parameters. |
| `COMPARISON_REGRESSED` | A gate failed (exit 1). | Expected when builds differ; `error.details` lists the failed gates. Inspect `worst-*` stills and the triptych. |
| `EXPORT_TARGET_EXISTS` | `timeline export --out` names an existing file. | Choose a new path; Cappy never overwrites exports. |
| `CLEAN_INCOMPLETE` | Some selected files were refused. | Cappy removed what it could prove it owns; `data.refused` says why the rest stayed. |
| `WORKSPACE_REGISTRY_INVALID` | `.cappy/cappy-workspace.json` is unreadable. | Cappy refuses to guess ownership. Ask the user before touching the workspace. |
| `OPERATION_CANCELLED` | Ctrl+C (exit 130). | Cappy stopped any recording it started; `clean --failed --dry-run` shows leftovers. |

## Symptoms without a code

- **Nothing happens when pressing Play in the Godot editor.** Expected: the adapter is inert unless Cappy launched the game.
- **The capture is black or shows the wrong window.** The OBS scene's source does not show the game. Launching with `--headless` also leaves nothing to capture. On macOS, OBS needs Screen Recording permission for display or window capture.
- **Clips start at the wrong moment.** Event times must be simulation milliseconds from the operation's start, not wall-clock or engine uptime.
- **A replay drifts from the recording.** The game's simulation is not deterministic for that payload: unseeded randomness, frame-rate-dependent logic, or input read outside the recorded log.
