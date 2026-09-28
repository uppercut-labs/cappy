# Godot adapter

The addon connects a Godot 4.x game to Cappy. The game never talks to OBS or FFmpeg; it registers what Cappy can ask for and reports what happened.

## Install

1. Copy the `addons/cappy/` folder that ships with Cappy into the game's `addons/` folder. It is four files: `cappy_adapter.gd`, `cappy_operation.gd`, `plugin.cfg`, and `plugin.gd`.
2. Enable **Cappy** under Project Settings > Plugins, or add the autoload yourself:

   ```ini
   [autoload]
   Cappy="*res://addons/cappy/cappy_adapter.gd"
   ```

3. Register scenarios and a replay provider during startup, for example in the main scene's `_ready()`. The adapter sends its handshake after the first frames, so anything registered in `_ready()` is included; anything registered later is not.

The adapter is inert unless Cappy launched the game (`CAPPY_ENDPOINT` and `CAPPY_SESSION_TOKEN` are set). Pressing Play in the editor therefore does nothing visible: that is expected, not a bug. To test the wiring, run `npx cappy scenarios -C <project-dir>`.

When Cappy disconnects, a game it launched quits. Set `Cappy.quit_on_disconnect = false` to keep it running.

## Release exports

Editor runs and debug exports connect as usual. A release export ignores Cappy, even when Cappy launched it, unless the project setting `cappy/allow_release_builds` is `true`; it logs `ignoring the controller in a release build` instead. This keeps a shipped game from being driven by anyone who sets the environment variables.

To capture a release export on purpose, turn the setting on for that build only, with an `override.cfg` next to the exported executable:

```ini
[cappy]

allow_release_builds=true
```

Never turn the setting on in the project itself, and never ship that `override.cfg`. Every build, debug or release, also refuses an endpoint that is not on loopback.

## Register a scenario

A scenario is a named, parameterized moment Cappy can reproduce on demand.

```gdscript
const CappyOperation := preload("res://addons/cappy/cappy_operation.gd")


func _ready() -> void:
	Cappy.register_scenario(
		"boss_intro",
		"Boss intro",
		{"difficulty": {"type": "integer", "minimum": 1, "maximum": 3, "default": 2}},
		_prepare_boss,
		_start_boss,
		{"validate": _validate_boss}
	)


func _validate_boss(parameters: Dictionary) -> String:
	return ""  # A non-empty string rejects the parameters.


func _prepare_boss(op: CappyOperation) -> void:
	# Build the scene for op.parameters, hold still, then:
	op.mark_ready()


func _start_boss(op: CappyOperation) -> void:
	op.event("BOSS_APPEAR", 0.0)
	# Later, from gameplay:
	op.event("SPELL_CAST", tick * 1000.0 / 60.0, {"spell": "fireball"})
	op.complete({"result": "win"})  # or op.fail("CODE", "why")
```

- Parameter specs support `type` (`string`, `number`, `integer`, `boolean`), `description`, `required`, `default`, `enum`, `minimum`, and `maximum`. The adapter validates them and applies defaults before `prepare` runs.
- Cappy starts recording between `mark_ready()` and `start`, so `prepare` must leave the game still and ready to show.
- Every operation must end in exactly one `op.complete(...)` or `op.fail(code, message)`. An operation that never ends hits Cappy's timeouts.

## Events and time

`op.event(name, t_msec, payload, duration_msec)` adds an event to the capture's timeline. Presets anchor clips and stills to these names, and `compare` diffs them.

- `t_msec` is **simulation time in milliseconds since the operation started**, not wall-clock time. Derive it from the game's fixed tick (`tick * 1000.0 / 60.0`) so the same input gives the same timeline. `op.elapsed_msec()` is a fallback for games without a simulation clock.
- Use stable UPPER_SNAKE names and small dictionary payloads. Presets can filter on payload fields with `where`.

## Freeform recording and replay

```gdscript
Cappy.set_replay_provider(_record_start, _record_stop, _replay_prepare, _replay_start, true)
```

- `_record_start(op)`: start capturing the game's own replay data (inputs per tick, a seed, an action log).
- `_record_stop(op)`: call `op.complete(result, payload_bytes, "your-format-v1")`.
- `_replay_prepare(op)`: decode `op.replay_payload` (the exact bytes recorded), then `op.mark_ready()` or `op.fail(...)`.
- `_replay_start(op)`: play it back, emit the same events, and `op.complete()`.

The last argument declares `deterministic_replay`: only pass `true` when the same payload always produces the same simulation. Cappy stores the payload byte-for-byte and never interprets it, so version the format string. `op.cancelled` fires if Cappy cancels; `op.stop_requested` fires when a running replay should end early.

A good replay payload is small and owned by the game: a seed plus the input or action log, and stable IDs for anything spawned. Recording rendered frames or full state snapshots every tick is a sign the game is not deterministic yet; fix that first.

## Presentation: slow motion and cameras

Presets can ask for `"presentation": {"timeScale": 0.5, "camera": "close"}`. The game applies it and declares that it can:

```gdscript
Cappy.declare_capabilities(["time_scale", "alternate_cameras"])


func _replay_prepare(op: CappyOperation) -> void:
	Engine.time_scale = op.time_scale()  # 1.0 unless presentation.timeScale is set
	var camera := str(op.presentation.get("camera", "default"))
	# Switch to that named camera, or:
	# op.fail("UNKNOWN_CAMERA", "no camera named %s" % camera)
	op.mark_ready()
```

- Keep passing simulation time to `op.event()`. At a time scale other than 1 the addon converts it to on-screen time and adds `simT` to dictionary payloads.
- Name cameras once and keep the names stable; presets refer to them.
- Put `Engine.time_scale` back to 1 and restore the camera when the operation ends or is cancelled.
- HUD and UI animations should behave correctly at a slowed time scale, or be hidden for capture.

## Identity and builds

The handshake reports `Cappy.game_id`, `Cappy.game_name`, and `Cappy.build`. They default to project settings (`application/config/name` and `application/config/version`). Set them before the handshake, in `_ready()`, when a build needs a distinct name, for example a variant launched with a user argument after `--`.

## Boundaries

- The addon and game code must not reference OBS, FFmpeg, or ffprobe. Capture belongs to Cappy.
- Keep Cappy hooks thin: scenarios call the game's own setup code, and the replay provider serializes the game's own input log. Do not build gameplay around Cappy.
- The addon only connects to a loopback endpoint. Shipping builds can keep the addon: release exports stay inert unless `cappy/allow_release_builds` is on.

Other engines: follow Cappy's adapter protocol reference.
