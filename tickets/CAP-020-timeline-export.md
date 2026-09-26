# CAP-020 - Export timelines as JSON, CSV, and WebVTT

## Goal

Other tools can consume Cappy timelines through documented formats, without Cappy depending on them (SPEC section 11.10; ADR-020).

## Scope

- `cappy timeline export <capture | session> [--format json|csv|vtt] [--out <path>]`, with shorthands `-fo` and `-o`.
- The JSON export envelope (`timelineExportVersion: 1`).
- CSV with RFC 4180 quoting.
- WebVTT cues.
- Output to stdout, to the `--json` result data, or to a new unmanaged file that is never overwritten (`EXPORT_TARGET_EXISTS`).
- `docs/schemas/timeline-event.schema.json` and `timeline-export.schema.json`, generated from the runtime schemas, with a sync test.
- Docs and tests.

## Acceptance Criteria

- A capture exports its manifest timeline on the master clock, with `sync`. A freeform session exports its `timeline.json` on the session clock. Unknown IDs fail with `CAPTURE_NOT_FOUND` or `SESSION_NOT_FOUND` (exit 2).
- The JSON export validates against the committed `timeline-export.schema.json` (checked with a JSON Schema validator in tests). A test fails if either committed schema differs from the one generated from the runtime schemas.
- The CSV has the documented header, one row per event, and correct quoting of payloads with commas, quotes, and newlines.
- The WebVTT passes a structural check: a `WEBVTT` header, one cue per event, `HH:MM:SS.mmm` timestamps, a minimum one-second cue, the event ID as the cue identifier, and `key=value` payload text. With `CAPPY_REAL_TOOLS=1`, FFmpeg accepts it as a subtitle input.
- `--out` writes a new file and refuses an existing one without modifying it. The file is not registered as managed.
- `docs/cli.md` documents the command and formats. Repository-standard validation passes.

## Dependencies

None.
