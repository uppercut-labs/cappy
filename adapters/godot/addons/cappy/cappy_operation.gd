extends RefCounted

## One Cappy operation: an authored scenario, a freeform recording, or a
## replay. The game reports progress through this object; the adapter turns
## those calls into protocol messages.

## Emitted when the controller cancels the operation. Tear down and stay quiet.
signal cancelled
## Emitted when the controller asks a running replay or scenario to finish early.
signal stop_requested

## Operation ID assigned by the controller.
var id: String
## "scenario", "freeform", or "replay".
var kind: String
var scenario_id := ""
## Validated scenario parameters with defaults applied.
var parameters: Dictionary = {}
## Presentation options from the capture preset, when any.
var presentation: Dictionary = {}
## For replays: the adapter-owned payload recorded earlier, byte for byte.
var replay_payload := PackedByteArray()
var replay_format := ""
## True once the operation completed, failed, or was cancelled.
var done := false

var _adapter: Object
var _state := "preparing"
var _started_msec := 0


func _init(adapter: Object, operation_id: String, operation_kind: String) -> void:
	_adapter = adapter
	id = operation_id
	kind = operation_kind


## Report that a scenario or replay is prepared and ready to start.
func mark_ready() -> void:
	if done or _state != "preparing":
		return
	_state = "ready"
	_adapter.call("_send", {"type": "ready", "op": id})


## Emit a semantic timeline event. `t_msec` is operation-relative monotonic
## time; deterministic games should derive it from their simulation clock.
func event(name: String, t_msec: float, payload: Variant = null, duration_msec: float = -1.0) -> void:
	if done:
		return
	var message := {"type": "event", "op": id, "t": maxf(t_msec, 0.0), "event": name}
	if duration_msec >= 0.0:
		message["durationMs"] = duration_msec
	if payload != null:
		message["payload"] = payload
	_adapter.call("_send", message)


## Wall-clock milliseconds since the operation started, for games without a
## simulation clock.
func elapsed_msec() -> float:
	return float(Time.get_ticks_msec() - _started_msec)


## Finish successfully. A freeform recording passes its replay payload here.
func complete(result: Dictionary = {}, replay: PackedByteArray = PackedByteArray(), format := "") -> void:
	if done:
		return
	done = true
	var message := {"type": "completed", "op": id}
	if not result.is_empty():
		message["result"] = result
	if not replay.is_empty():
		message["replay"] = _adapter.call("_replay_handoff", id, replay, format)
	_adapter.call("_send", message)
	_adapter.call("_release", self)


## Report failure with a machine-readable code and a human message.
func fail(code: String, message: String) -> void:
	if done:
		return
	done = true
	_adapter.call("_send", {"type": "failed", "op": id, "code": code, "message": message})
	_adapter.call("_release", self)
