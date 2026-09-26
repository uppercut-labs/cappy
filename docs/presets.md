# Capture presets

A preset in `cappy.config.json` names the OBS scene to expect and the derivatives FFmpeg makes from each verified master. `--preset <name>` (`-p`) selects one; `defaultPreset` applies otherwise.

```json
"presets": {
  "trailer": {
    "scene": "Capture",
    "derivatives": [
      { "kind": "mp4", "role": "delivery" },
      { "kind": "clip", "role": "moment", "options": {
        "start": { "event": "SPELL_CAST", "offset": -2, "where": { "spell": "fireball" } },
        "end": { "event": "IMPACT", "offset": 1 } } },
      { "kind": "still", "role": "impact", "options": { "at": { "event": "IMPACT" } } },
      { "kind": "thumbnail", "role": "thumb", "required": false, "options": { "at": 2 } }
    ]
  }
}
```

Every option is validated before the game launches. An invalid option fails with `DERIVATIVE_OPTIONS_INVALID` (exit 3), and every problem is listed.

## Derivatives

| Kind | Output | Options |
| --- | --- | --- |
| `mp4` | `<role>.mp4` (H.264/AAC, faststart) | `crf` (0-51, default 20), `preset` (x264 preset, default `medium`), `audio` (default `true`) |
| `clip` | `<role>.mp4` | `start` (required), and exactly one of `duration` (seconds) or `end`, plus the `mp4` options |
| `thumbnail` | `<role>.jpg` | `at` (default 0), `width` in pixels (default 640, aspect ratio kept) |
| `still` | `<role>.png` (full resolution) | `at` (default 0) |

`role` names the output and its manifest entry, and must be unique within the preset. A derivative is `required` unless it sets `"required": false`. A failed required derivative fails the capture but keeps the verified master. A failed optional one becomes a warning.

`start`, `end`, and `at` are either seconds from the start of the master, or an event anchor.

## Event anchors

An anchor places a time relative to an event on the capture's timeline, instead of at a fixed second:

```json
{ "event": "IMPACT", "offset": 0.5, "occurrence": 2, "where": { "target.kind": "boss" } }
```

| Field | Meaning |
| --- | --- |
| `event` | Event type (required). Any timeline event works, including Cappy's `SCENARIO_STARTED`, `REPLAY_STARTED`, and `*_COMPLETED`. |
| `offset` | Seconds after the event. Negative means before it. Default 0. |
| `occurrence` | Which match to use: `1` for the first (the default), `2` for the second, and so on, `"last"`, or `"every"` (see below). |
| `where` | Payload conditions. Each key is a dot-separated path into the event's payload (`"target.kind"`), and each value is a string, number, boolean, or `null`. Every condition must match exactly, so `3` does not match `"3"`. |

How anchors resolve:

- Anchors resolve after recording, against the capture's timeline on the master's clock. That is the same timeline recorded in `manifest.json`.
- A clip's `end` anchor matches the first qualifying event at or after the start event, or at or after a numeric `start`.
- The manifest records what was used. Each clip has `window: { startMs, endMs, startEventId, endEventId }`, and each still or thumbnail has `at: { ms, eventId }`. Times given in seconds are recorded the same way, without event IDs.
- If no event matches, the derivative fails with `DERIVATIVE_ANCHOR_UNRESOLVED`. This fails the capture for a required derivative, and is a warning for an optional one.
- An anchored window that runs past either end of the master is clamped to the master, with a warning. If nothing is left, it fails with `DERIVATIVE_WINDOW_EMPTY`.
- A still or thumbnail shows the frame at or before its time. An anchored time past the end is moved to the end, with a warning, and so shows the master's last frame. That frame can be a frame or two earlier than the reported duration, as OBS masters often are.
- Times given only in seconds are used exactly as written, as before anchors existed.
- Each derivative produces one output, unless it uses `occurrence: "every"`.

## Presentation

`presentation` asks the game to show a capture differently, without changing what happens. It applies to scenario captures and replay captures:

```json
"slowmo": { "presentation": { "timeScale": 0.5, "camera": "close" } }
```

- `timeScale` is a number from 0.1 to 4 (0.5 is half speed). It requires the adapter's `time_scale` capability.
- `camera` is a camera name the adapter defines. It requires `alternate_cameras`.
- Other keys are passed to the adapter as they are.

Cappy checks those capabilities after connecting and before recording (`CAPABILITY_MISSING`). The manifest records the presentation as `identity.presentation`. Event times are what is on screen, so anchors and clips line up with the slowed-down video. The simulation time rides along in each event's payload as `simT`. `cappy compare` warns when two captures were presented differently.

## One output per event

`occurrence: "every"` on a clip's `start`, or on a still's or thumbnail's `at`, makes one output per matching event, numbered in timeline order:

```json
{ "kind": "clip", "role": "hit", "options": {
  "start": { "event": "HIT", "occurrence": "every", "offset": -0.5 },
  "end": { "event": "HIT", "offset": 1 } } }
```

This produces `hit-1.mp4`, `hit-2.mp4`, and so on.

- Each clip's `end` is the first qualifying event at or after that clip's own start event. Here that is the same `HIT` plus 1 s.
- `where` narrows the matches as usual.
- Each output is recorded in the manifest with its own window or time and event IDs.
- At most 100 outputs are made. Any further matches are skipped, with a warning saying how many.
- A required derivative that matches nothing fails the capture (`DERIVATIVE_ANCHOR_UNRESOLVED`). So does any of its outputs that fails. For an optional one, each problem is a warning.
- `"every"` is not allowed on a clip's `end`, and a clip that uses it needs an `end` anchor or a `duration`, not a fixed `end` time.
- Another derivative in the same preset may not be named like a generated output (`hit-2`).

Event times carry the recorder synchronization uncertainty recorded in the manifest (`timing.sync.uncertaintyMs`). Cappy does not pad for it; widen `offset` if you need margin.
