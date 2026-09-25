extends Node2D

## Deterministic demo game for Cappy.
##
## - Scenario "orb_launch": an orb is launched with `power` under `gravity`,
##   bounces, and settles. Same parameters, same timeline, every time.
## - Freeform recording: a runner jumps (keyboard or an autopilot) while the
##   jump ticks are recorded; the replay feeds them back and reproduces the
##   same events at the same simulation times.
##
## All timeline times come from the fixed 60 Hz physics tick, never the wall clock.

const CappyOperation := preload("res://addons/cappy/cappy_operation.gd")

const TICK_MSEC := 1000.0 / 60.0
const GROUND_Y := 420.0
const REPLAY_FORMAT := "cappy-godot-demo-runner-v1"
const COIN_SPACING := 120
const MAX_ORB_TICKS := 900

var _orb: CappyOperation = null
var _orb_tick := 0
var _orb_gravity := 1.0
var _orb_position := Vector2.ZERO
var _orb_velocity := Vector2.ZERO
var _orb_bounces := 0

var _runner: CappyOperation = null
var _runner_replaying := false
var _runner_tick := 0
var _runner_height := 0.0
var _runner_speed := 0.0
var _runner_grounded := true
var _runner_coins := 0
var _recorded_jumps: Array[int] = []
var _replay_jumps := {}
var _replay_ticks := 0
var _autopilot := RandomNumberGenerator.new()
var _status := "Idle"


func _ready() -> void:
	Cappy.register_scenario(
		"orb_launch",
		"Orb launch",
		{
			"power": {"type": "integer", "minimum": 1, "maximum": 5, "default": 3, "description": "Launch strength"},
			"gravity": {"type": "number", "minimum": 0.5, "maximum": 4.0, "default": 1.0, "description": "Gravity multiplier"},
		},
		_prepare_orb,
		_start_orb,
		{"validate": _validate_orb, "required_capabilities": ["scenarios"]}
	)
	Cappy.set_replay_provider(_start_recording, _stop_recording, _prepare_replay, _start_replay, true)


func _physics_process(_delta: float) -> void:
	if _orb != null and not _orb.done:
		_step_orb()
	if _runner != null and not _runner.done:
		_step_runner()
	queue_redraw()


# --- Scenario: orb launch -----------------------------------------------------


func _validate_orb(parameters: Dictionary) -> String:
	if float(parameters["power"]) * float(parameters["gravity"]) > 12.0:
		return "power x gravity above 12 would throw the orb out of the arena"
	return ""


func _prepare_orb(operation: CappyOperation) -> void:
	_orb = null
	_orb_tick = 0
	_orb_gravity = float(operation.parameters["gravity"])
	_orb_position = Vector2(120.0, GROUND_Y)
	_orb_velocity = Vector2(2.0 + operation.parameters["power"], -6.0 - 2.0 * operation.parameters["power"])
	_orb_bounces = 0
	_status = "Orb ready (power %d)" % operation.parameters["power"]
	operation.cancelled.connect(func() -> void: _status = "Orb cancelled")
	operation.mark_ready()
	_orb = operation
	# Hold still until the controller starts the scenario.
	_orb.set_meta("waiting", true)


func _start_orb(operation: CappyOperation) -> void:
	operation.set_meta("waiting", false)
	_status = "Orb launched"
	operation.event("LAUNCH", 0.0, {"power": operation.parameters["power"]})


func _step_orb() -> void:
	if _orb.get_meta("waiting", false):
		return
	_orb_tick += 1
	_orb_velocity.y += 0.4 * _orb_gravity
	_orb_position += _orb_velocity
	if _orb_position.y >= GROUND_Y and _orb_velocity.y > 0.0:
		_orb_position.y = GROUND_Y
		_orb_velocity.y = -_orb_velocity.y * 0.55
		_orb_velocity.x *= 0.8
		_orb_bounces += 1
		_orb.event("BOUNCE", _orb_tick * TICK_MSEC, {"bounce": _orb_bounces})
	if (_orb_bounces > 0 and absf(_orb_velocity.y) < 1.5 and _orb_position.y >= GROUND_Y - 1.0) or _orb_tick >= MAX_ORB_TICKS:
		_orb.event("SETTLED", _orb_tick * TICK_MSEC, {"x": snappedf(_orb_position.x, 0.01)})
		_status = "Orb settled after %d bounces" % _orb_bounces
		var finished := _orb
		_orb = null
		finished.complete({"bounces": _orb_bounces, "ticks": _orb_tick})


# --- Freeform recording and replay: runner ----------------------------------


func _reset_runner() -> void:
	_runner_tick = 0
	_runner_height = 0.0
	_runner_speed = 0.0
	_runner_grounded = true
	_runner_coins = 0


func _start_recording(operation: CappyOperation) -> void:
	_reset_runner()
	_runner_replaying = false
	_recorded_jumps = []
	# Recording is live play, so the autopilot is intentionally unseeded.
	_autopilot.randomize()
	_status = "Recording"
	_runner = operation
	operation.cancelled.connect(func() -> void: _status = "Recording cancelled")
	operation.event("RUN_START", 0.0)


func _stop_recording(operation: CappyOperation) -> void:
	operation.event("RUN_END", _runner_tick * TICK_MSEC, {"coins": _runner_coins})
	var payload := JSON.stringify({"format": REPLAY_FORMAT, "ticks": _runner_tick, "jumps": _recorded_jumps}).to_utf8_buffer()
	_status = "Recorded %d ticks" % _runner_tick
	_runner = null
	operation.complete({"ticks": _runner_tick, "jumps": _recorded_jumps.size()}, payload, REPLAY_FORMAT)


func _prepare_replay(operation: CappyOperation) -> void:
	var decoded: Variant = JSON.parse_string(operation.replay_payload.get_string_from_utf8())
	if typeof(decoded) != TYPE_DICTIONARY or decoded.get("format", "") != REPLAY_FORMAT:
		operation.fail("REPLAY_UNSUPPORTED", "not a %s replay" % REPLAY_FORMAT)
		return
	_replay_jumps = {}
	for tick in decoded["jumps"]:
		_replay_jumps[int(tick)] = true
	_replay_ticks = int(decoded["ticks"])
	_status = "Replay ready (%d ticks)" % _replay_ticks
	operation.mark_ready()


func _start_replay(operation: CappyOperation) -> void:
	_reset_runner()
	_runner_replaying = true
	_status = "Replaying"
	_runner = operation
	operation.stop_requested.connect(func() -> void: _finish_replay())
	operation.event("RUN_START", 0.0)
	if _replay_ticks == 0:
		_finish_replay()


func _finish_replay() -> void:
	if _runner == null or _runner.done:
		return
	_runner.event("RUN_END", _runner_tick * TICK_MSEC, {"coins": _runner_coins})
	_status = "Replay finished"
	var finished := _runner
	_runner = null
	finished.complete({"ticks": _runner_tick})


func _step_runner() -> void:
	_runner_tick += 1
	var jump := false
	if _runner_replaying:
		jump = _replay_jumps.has(_runner_tick)
	elif _runner_grounded:
		jump = Input.is_action_just_pressed("ui_accept") or _autopilot.randf() < 0.08
	if jump and _runner_grounded:
		if not _runner_replaying:
			_recorded_jumps.append(_runner_tick)
		_runner_speed = -9.0
		_runner_grounded = false
		_runner.event("JUMP", _runner_tick * TICK_MSEC)
	if not _runner_grounded:
		_runner_height += _runner_speed
		_runner_speed += 0.6
		if _runner_height >= 0.0:
			_runner_height = 0.0
			_runner_grounded = true
			_runner.event("LAND", _runner_tick * TICK_MSEC)
	if (_runner_tick * 2) % COIN_SPACING == 0:
		_runner_coins += 1
		_runner.event("COIN", _runner_tick * TICK_MSEC, {"total": _runner_coins})
	if _runner_replaying and _runner_tick >= _replay_ticks:
		_finish_replay()


func _draw() -> void:
	draw_rect(Rect2(0.0, GROUND_Y + 12.0, 960.0, 8.0), Color(0.3, 0.3, 0.35))
	draw_circle(_orb_position, 12.0, Color(0.95, 0.55, 0.2))
	var runner_x := 60.0 + float(_runner_tick * 2 % 840)
	draw_rect(Rect2(runner_x, GROUND_Y - 24.0 + _runner_height, 18.0, 36.0), Color(0.3, 0.7, 0.95))
	draw_string(ThemeDB.fallback_font, Vector2(24.0, 40.0), "Cappy demo: %s" % _status, HORIZONTAL_ALIGNMENT_LEFT, -1, 22)
	draw_string(ThemeDB.fallback_font, Vector2(24.0, 70.0), "tick %d  coins %d" % [_runner_tick, _runner_coins], HORIZONTAL_ALIGNMENT_LEFT, -1, 18)
