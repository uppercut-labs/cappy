# Cappy Godot adapter

A Godot 4.x addon that connects a game to Cappy. It implements the [adapter protocol](../../docs/protocol.md): handshake, capabilities, scenario registration, timeline events, freeform recording, and replay. The game never talks to a recorder or media tools; Cappy handles capture.

## Install

The addon is distributed with the versioned GitHub source tree. Once a release tag exists, obtain that tagged source (for example, `v0.1.0`) and copy `adapters/godot/addons/cappy/` into your project's `addons/` folder. The tag has not been published yet; with the current checkout, copy `adapters/godot/addons/cappy/` from this repository.

1. Copy `addons/cappy/` into your project's `addons/` folder.
2. Enable **Cappy** under Project Settings > Plugins, or add the autoload yourself:

   ```ini
   [autoload]
   Cappy="*res://addons/cappy/cappy_adapter.gd"
   ```

The adapter is inert unless Cappy launched the game (`CAPPY_ENDPOINT` and `CAPPY_SESSION_TOKEN` are set). When Cappy disconnects, a game it launched quits; set `Cappy.quit_on_disconnect = false` to keep running.

Release exports stay inert even when those variables are set, so a shipped game cannot be driven by anyone who sets them. To capture a release export, set the project setting `cappy/allow_release_builds` to `true` for that build only. The simplest way is an `override.cfg` next to the exported executable, which Godot reads at startup:

```ini
[cappy]

allow_release_builds=true
```

The adapter also refuses any endpoint that is not on loopback.

## Register a scenario

```gdscript
const CappyOperation := preload("res://addons/cappy/cappy_operation.gd")

func _ready() -> void:
	Cappy.register_scenario(
		"boss_intro", "Boss intro",
		{"difficulty": {"type": "integer", "minimum": 1, "maximum": 3, "default": 2}},
		_prepare_boss, _start_boss,
		{"validate": _validate_boss})

func _validate_boss(parameters: Dictionary) -> String:
	return ""  # A non-empty string rejects the parameters.

func _prepare_boss(op: CappyOperation) -> void:
	# Build the scene for op.parameters, then:
	op.mark_ready()

func _start_boss(op: CappyOperation) -> void:
	op.event("BOSS_APPEAR", 0.0)
	# ... later, from gameplay:
	op.event("SPELL_CAST", tick * 1000.0 / 60.0, {"spell": "fireball"})
	op.complete({"result": "win"})  # or op.fail("CODE", "why")
```

Parameters are validated against their specs (type, enum, range, required) before `prepare` runs, with defaults applied. Event times are operation-relative milliseconds; deterministic games should derive them from their simulation tick.

## Freeform recording and replay

```gdscript
Cappy.set_replay_provider(_record_start, _record_stop, _replay_prepare, _replay_start, true)
```

- `_record_start(op)`: start recording your own replay data.
- `_record_stop(op)`: call `op.complete(result, payload_bytes, "your-format")`.
- `_replay_prepare(op)`: decode `op.replay_payload` (the exact bytes you recorded), then `op.mark_ready()` or `op.fail(...)`.
- `_replay_start(op)`: play it back, emit events, and `op.complete()`.

The last argument declares `deterministic_replay`. Cappy stores the payload byte-for-byte and never interprets it. `op.cancelled` fires if Cappy cancels; `op.stop_requested` fires when a running replay should end early.

## Presentation: slow motion and cameras

Scenarios and replays receive the capture preset's `op.presentation`, for example `{"timeScale": 0.5, "camera": "close"}`. The game applies it, and declares that it can:

```gdscript
Cappy.declare_capabilities(["time_scale", "alternate_cameras"])

func _replay_prepare(op: CappyOperation) -> void:
	Engine.time_scale = op.time_scale()   # 1.0 unless presentation.timeScale is set
	# ...switch to op.presentation.get("camera", "default"), or op.fail("UNKNOWN_CAMERA", ...)
	op.mark_ready()
```

Keep passing simulation time to `op.event()`. Cappy's timeline needs presented time, meaning what is on screen, so at a time scale other than 1 the addon sends `t / time_scale()` and adds `simT` (the simulation time) to a dictionary payload. `op.elapsed_msec()` returns simulation time as well. Put the time scale back to 1 when the operation ends.

## Demo

`fixtures/godot-demo` is the acceptance fixture: a deterministic orb-launch scenario with a validation hook, and a runner whose jumps are recorded and replayed exactly. Assemble a runnable copy with the addon included:

```bash
npm run godot:demo
```

That writes `.godot-demo/` (ignored by Git). Point `game.command` at `godot` and `game.args` at `["--headless", "--path", "<absolute path to .godot-demo>"]`, or drop `--headless` to watch it.

The demo also supports presentation (`timeScale`, and the cameras `default` and `close`) and a second-build variant: the user argument `--variant=b`, after `--`.
