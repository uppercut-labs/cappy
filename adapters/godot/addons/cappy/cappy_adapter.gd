extends Node

## Cappy game adapter (autoload "Cappy").
##
## When the game is launched by Cappy, CAPPY_ENDPOINT and CAPPY_SESSION_TOKEN
## are set. The adapter connects to that loopback endpoint, performs the
## version and capability handshake, and routes scenario, recording, and
## replay operations to callbacks the game registers. Without those variables
## it stays inert and the game runs normally.
##
## Release exports stay inert as well, unless the project setting
## cappy/allow_release_builds is true. The endpoint must be a loopback address.
##
## The adapter knows nothing about recording video; the controller handles that.

signal connected
signal disconnected

const CappyOperation := preload("res://addons/cappy/cappy_operation.gd")

const PROTOCOL_VERSION := 1
const ADAPTER_NAME := "cappy-godot"
const ADAPTER_VERSION := "0.1.0"
const MAX_INLINE_REPLAY_BYTES := 1024 * 1024
const PARAMETER_TYPES := ["string", "number", "integer", "boolean"]
const PARAMETER_KEYS := ["type", "description", "required", "default", "enum", "minimum", "maximum"]
const ALLOW_RELEASE_SETTING := "cappy/allow_release_builds"
const LOOPBACK_HOSTS := ["127.0.0.1", "localhost", "::1"]

## Quit the game when the controller disconnects (only applies when launched by Cappy).
var quit_on_disconnect := true
## Game identity reported in the handshake. Defaults come from project settings.
var game_id := ""
var game_name := ""
var build := ""
var _extra_capabilities: Array[String] = []

var _socket: WebSocketPeer
var _token := ""
var _state := "inert"
var _scenarios := {}
var _scenario_order: Array[String] = []
var _replay_provider := {}
var _operation: CappyOperation = null


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	var endpoint := OS.get_environment("CAPPY_ENDPOINT")
	_token = OS.get_environment("CAPPY_SESSION_TOKEN")
	if endpoint.is_empty() or _token.is_empty():
		return
	if not OS.is_debug_build() and not ProjectSettings.get_setting(ALLOW_RELEASE_SETTING, false):
		push_warning("Cappy: ignoring the controller in a release build (%s is off)" % ALLOW_RELEASE_SETTING)
		return
	if not _is_loopback(endpoint):
		push_error("Cappy: refusing non-loopback endpoint %s" % endpoint)
		return
	if game_name.is_empty():
		game_name = str(ProjectSettings.get_setting("application/config/name", "Godot Game"))
	if game_id.is_empty():
		game_id = _slug(game_name)
	if build.is_empty():
		build = str(ProjectSettings.get_setting("application/config/version", ""))
	_socket = WebSocketPeer.new()
	_socket.inbound_buffer_size = 8 * 1024 * 1024
	_socket.outbound_buffer_size = 8 * 1024 * 1024
	_socket.max_queued_packets = 4096
	var error := _socket.connect_to_url(endpoint)
	if error != OK:
		push_error("Cappy: could not connect to %s (%s)" % [endpoint, error_string(error)])
		_finish()
		return
	_state = "connecting"


## True once the handshake with the controller has completed.
func is_active() -> bool:
	return _state == "active"


## Register an authored scenario.
##
## `parameters` maps names to specs: {"type": "string"|"number"|"integer"|"boolean",
## "required", "default", "enum", "minimum", "maximum", "description"}.
## `prepare(operation)` sets up game state and calls operation.mark_ready().
## `start(operation)` begins the scenario; the game emits events and calls
## operation.complete() or operation.fail().
## `options` may contain "validate" (Callable(parameters) -> String; a non-empty
## string rejects the parameters), "required_capabilities", and "metadata".
func register_scenario(id: String, display_name: String, parameters: Dictionary, prepare: Callable, start: Callable, options: Dictionary = {}) -> void:
	for name in parameters:
		var spec: Dictionary = parameters[name]
		assert(spec.get("type", "") in PARAMETER_TYPES, "Cappy: parameter %s needs a valid type" % name)
		for key in spec:
			assert(key in PARAMETER_KEYS, "Cappy: parameter %s has unknown key %s" % [name, key])
	var definition := {
		"id": id,
		"name": display_name,
		"parameters": parameters,
		"requiredCapabilities": options.get("required_capabilities", []),
	}
	if options.has("metadata"):
		definition["metadata"] = options["metadata"]
	if not _scenarios.has(id):
		_scenario_order.append(id)
	_scenarios[id] = {
		"definition": definition,
		"prepare": prepare,
		"start": start,
		"validate": options.get("validate", Callable()),
	}
	if is_active():
		_send_scenarios()


## Declare freeform recording and replay support.
##
## `record_start(operation)`: begin recording game-owned replay data.
## `record_stop(operation)`: finish and call operation.complete(result, payload, format).
## `replay_prepare(operation)`: load operation.replay_payload, then mark_ready() or fail().
## `replay_start(operation)`: play it back, emit events, and complete().
## `deterministic`: whether replays reproduce the recording exactly.
func set_replay_provider(record_start: Callable, record_stop: Callable, replay_prepare: Callable, replay_start: Callable, deterministic := false) -> void:
	_replay_provider = {
		"record_start": record_start,
		"record_stop": record_stop,
		"replay_prepare": replay_prepare,
		"replay_start": replay_start,
		"deterministic": deterministic,
	}


func _process(_delta: float) -> void:
	if _socket == null:
		return
	_socket.poll()
	match _socket.get_ready_state():
		WebSocketPeer.STATE_OPEN:
			if _state == "connecting":
				_state = "handshaking"
				_send_hello()
			# Drain everything that arrived: the controller may send its first
			# request in the same read as the welcome.
			while _socket != null and _socket.get_available_packet_count() > 0:
				var packet := _socket.get_packet()
				if _socket.was_string_packet():
					_receive(packet.get_string_from_utf8())
		WebSocketPeer.STATE_CLOSED:
			_finish()


## Declare capabilities beyond those the adapter infers, such as
## "time_scale" or "alternate_cameras" when the game applies presentation.
func declare_capabilities(names: Array) -> void:
	for name in names:
		if not _extra_capabilities.has(str(name)):
			_extra_capabilities.append(str(name))


func _capabilities() -> Array[String]:
	var capabilities: Array[String] = _extra_capabilities.duplicate()
	if not _scenarios.is_empty():
		capabilities.append("scenarios")
	if not _replay_provider.is_empty():
		capabilities.append_array(["freeform_recording", "replay"])
		if _replay_provider["deterministic"]:
			capabilities.append("deterministic_replay")
	return capabilities


func _send_hello() -> void:
	var hello := {
		"type": "hello",
		"protocol": {"min": PROTOCOL_VERSION, "max": PROTOCOL_VERSION},
		"token": _token,
		"adapter": {"name": ADAPTER_NAME, "version": ADAPTER_VERSION},
		"game": {"id": game_id, "name": game_name},
		"capabilities": _capabilities(),
	}
	if not build.is_empty():
		hello["build"] = build
	_send(hello)


func _send_scenarios() -> void:
	var definitions: Array = []
	for id in _scenario_order:
		definitions.append(_scenarios[id]["definition"])
	_send({"type": "scenarios", "scenarios": definitions})


func _send(message: Dictionary) -> void:
	if _socket != null and _socket.get_ready_state() == WebSocketPeer.STATE_OPEN:
		_socket.send_text(JSON.stringify(message))


func _receive(text: String) -> void:
	var message: Variant = JSON.parse_string(text)
	if typeof(message) != TYPE_DICTIONARY or not message.has("type"):
		return
	var type: String = message["type"]
	if _state == "handshaking":
		if type == "welcome":
			_state = "active"
			_send_scenarios()
			connected.emit()
		elif type == "reject":
			push_error("Cappy rejected the connection: %s" % message.get("message", ""))
			_socket.close()
		return
	match type:
		"ping":
			_send({"type": "pong", "nonce": message.get("nonce", "")})
		"list_scenarios":
			_send_scenarios()
		"prepare_scenario":
			_prepare_scenario(message)
		"record_start":
			_record_start(message)
		"prepare_replay":
			_prepare_replay(message)
		"start":
			_start(str(message.get("op", "")))
		"stop":
			_stop(str(message.get("op", "")))
		"cancel":
			_cancel(str(message.get("op", "")))
		"error":
			push_warning("Cappy reported a protocol error: %s" % message.get("message", ""))


func _refuse(op: String, code: String, reason: String) -> void:
	_send({"type": "failed", "op": op, "code": code, "message": reason})


func _begin(op: String, kind: String) -> CappyOperation:
	if _operation != null and not _operation.done:
		_refuse(op, "OPERATION_BUSY", "another operation is active")
		return null
	_operation = CappyOperation.new(self, op, kind)
	return _operation


func _prepare_scenario(message: Dictionary) -> void:
	var op := str(message.get("op", ""))
	var id := str(message.get("scenario", ""))
	if not _scenarios.has(id):
		_refuse(op, "SCENARIO_NOT_FOUND", "unknown scenario \"%s\"" % id)
		return
	var scenario: Dictionary = _scenarios[id]
	var resolved := _resolve_parameters(scenario["definition"]["parameters"], message.get("parameters", {}))
	if resolved.has("error"):
		_refuse(op, "INVALID_PARAMETERS", resolved["error"])
		return
	var validate: Callable = scenario["validate"]
	if validate.is_valid():
		var problem := str(validate.call(resolved["values"]))
		if not problem.is_empty():
			_refuse(op, "INVALID_PARAMETERS", problem)
			return
	var operation := _begin(op, "scenario")
	if operation == null:
		return
	operation.scenario_id = id
	operation.parameters = resolved["values"]
	operation.presentation = message.get("presentation", {})
	scenario["prepare"].call(operation)


func _record_start(message: Dictionary) -> void:
	var op := str(message.get("op", ""))
	if _replay_provider.is_empty():
		_refuse(op, "UNSUPPORTED", "this game does not support freeform recording")
		return
	var operation := _begin(op, "freeform")
	if operation == null:
		return
	operation._state = "running"
	operation._started_msec = Time.get_ticks_msec()
	_send({"type": "started", "op": op})
	_replay_provider["record_start"].call(operation)


func _prepare_replay(message: Dictionary) -> void:
	var op := str(message.get("op", ""))
	if _replay_provider.is_empty():
		_refuse(op, "REPLAY_UNSUPPORTED", "this game does not support replay")
		return
	var handoff: Dictionary = message.get("replay", {})
	var payload := PackedByteArray()
	if handoff.get("kind", "") == "inline":
		payload = Marshalls.base64_to_raw(str(handoff.get("data", "")))
	elif handoff.get("kind", "") == "file":
		payload = FileAccess.get_file_as_bytes(str(handoff.get("path", "")))
	if _sha256(payload) != str(handoff.get("sha256", "")):
		_refuse(op, "REPLAY_INVALID", "replay payload does not match its SHA-256")
		return
	var operation := _begin(op, "replay")
	if operation == null:
		return
	operation.replay_payload = payload
	operation.replay_format = str(handoff.get("format", ""))
	operation.presentation = message.get("presentation", {})
	_replay_provider["replay_prepare"].call(operation)


func _start(op: String) -> void:
	var operation := _operation
	if operation == null or operation.id != op or operation.done or operation._state != "ready":
		return
	operation._state = "running"
	operation._started_msec = Time.get_ticks_msec()
	# "started" goes out before the game runs so its events follow it.
	_send({"type": "started", "op": op})
	if operation.kind == "scenario":
		_scenarios[operation.scenario_id]["start"].call(operation)
	else:
		_replay_provider["replay_start"].call(operation)


func _stop(op: String) -> void:
	var operation := _operation
	if operation == null or operation.id != op or operation.done:
		return
	if operation.kind == "freeform":
		_replay_provider["record_stop"].call(operation)
	else:
		operation.stop_requested.emit()


func _cancel(op: String) -> void:
	var operation := _operation
	if operation == null or operation.id != op or operation.done:
		return
	operation.done = true
	_operation = null
	operation.cancelled.emit()


func _release(operation: CappyOperation) -> void:
	if _operation == operation:
		_operation = null


## Build the handoff for a completed recording: inline when small, otherwise a
## file in the user data directory.
func _replay_handoff(op: String, payload: PackedByteArray, format: String) -> Dictionary:
	var handoff := {"sha256": _sha256(payload)}
	if payload.size() <= MAX_INLINE_REPLAY_BYTES:
		handoff["kind"] = "inline"
		handoff["encoding"] = "base64"
		handoff["data"] = Marshalls.raw_to_base64(payload)
	else:
		DirAccess.make_dir_recursive_absolute("user://cappy-replays")
		var path := "user://cappy-replays/%s.bin" % op
		var file := FileAccess.open(path, FileAccess.WRITE)
		file.store_buffer(payload)
		file.close()
		handoff["kind"] = "file"
		handoff["path"] = ProjectSettings.globalize_path(path)
		handoff["bytes"] = payload.size()
	if not format.is_empty():
		handoff["format"] = format
	return handoff


## Validate raw parameters against specs and apply defaults.
## Returns {"values": Dictionary} or {"error": String}.
func _resolve_parameters(specs: Dictionary, raw: Variant) -> Dictionary:
	if typeof(raw) != TYPE_DICTIONARY:
		return {"error": "parameters must be an object"}
	var values := {}
	for name in raw:
		if not specs.has(name):
			return {"error": "unknown parameter \"%s\"" % name}
	for name in specs:
		var spec: Dictionary = specs[name]
		if not raw.has(name):
			if spec.has("default"):
				values[name] = spec["default"]
			elif spec.get("required", false):
				return {"error": "missing parameter \"%s\"" % name}
			continue
		var value: Variant = raw[name]
		match spec["type"]:
			"integer":
				if typeof(value) not in [TYPE_INT, TYPE_FLOAT] or not is_equal_approx(float(value), roundf(float(value))):
					return {"error": "parameter \"%s\" must be an integer" % name}
				value = int(value)
			"number":
				if typeof(value) not in [TYPE_INT, TYPE_FLOAT]:
					return {"error": "parameter \"%s\" must be a number" % name}
				value = float(value)
			"boolean":
				if typeof(value) != TYPE_BOOL:
					return {"error": "parameter \"%s\" must be a boolean" % name}
			"string":
				if typeof(value) != TYPE_STRING:
					return {"error": "parameter \"%s\" must be a string" % name}
		if spec.has("enum") and not value in spec["enum"]:
			return {"error": "parameter \"%s\" is not an allowed value" % name}
		if spec.has("minimum") and float(value) < float(spec["minimum"]):
			return {"error": "parameter \"%s\" is below its minimum" % name}
		if spec.has("maximum") and float(value) > float(spec["maximum"]):
			return {"error": "parameter \"%s\" is above its maximum" % name}
		values[name] = value
	return {"values": values}


func _sha256(bytes: PackedByteArray) -> String:
	var context := HashingContext.new()
	context.start(HashingContext.HASH_SHA256)
	context.update(bytes)
	return context.finish().hex_encode()


## True when the endpoint's host is exactly a loopback host. Userinfo is refused,
## because WebSocketPeer would connect to the host after the "@".
func _is_loopback(endpoint: String) -> bool:
	if not endpoint.begins_with("ws://"):
		return false
	var authority := endpoint.substr(5).get_slice("/", 0)
	if authority.contains("@"):
		return false
	var host := ""
	if authority.begins_with("["):
		var close := authority.find("]")
		if close < 0:
			return false
		host = authority.substr(1, close - 1)
		authority = authority.substr(close + 1)
	else:
		host = authority.get_slice(":", 0)
		authority = authority.substr(host.length())
	if not authority.begins_with(":") or not authority.substr(1).is_valid_int():
		return false
	return host in LOOPBACK_HOSTS


func _slug(text: String) -> String:
	var slug := ""
	for character in text.to_lower():
		slug += character if character in "abcdefghijklmnopqrstuvwxyz0123456789" else "-"
	while slug.contains("--"):
		slug = slug.replace("--", "-")
	return slug.trim_prefix("-").trim_suffix("-")


func _finish() -> void:
	if _state == "closed":
		return
	var was_launched := _state != "inert"
	_state = "closed"
	_socket = null
	if _operation != null and not _operation.done:
		_operation.done = true
		_operation.cancelled.emit()
	_operation = null
	disconnected.emit()
	if was_launched and quit_on_disconnect:
		get_tree().quit()
