# CAP-020 - Export timelines as JSON, CSV, and WebVTT

**Status:** Complete

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

## Completion

Completed 2026-09-25 (America/Chicago).

- A capture exports its manifest timeline with `clock: "master"` and its `sync`, identical to the manifest. A freeform session exports its `timeline.json` with `clock: "session"`. Unknown IDs fail with `CAPTURE_NOT_FOUND` or `SESSION_NOT_FOUND` (exit 2). A non-ID, an unknown format, an unknown action, and a missing ID fail with `USAGE_INVALID`. Covered by `packages/cli/test/timeline.test.ts`.
- The JSON export validates against the committed `docs/schemas/timeline-export.schema.json` with ajv (6.15.0, now a declared dev dependency that was already in the lockfile), and an invalid `clock` is rejected. `packages/core/test/schemas.test.ts` fails if either committed schema differs from `publishedSchemas()`, which generates both from the runtime schemas as draft-07 (`npm run schemas`), and checks that both compile.
- The CSV has the documented header, CRLF rows, and RFC 4180 quoting of a payload containing a comma, quotes, and a newline.
- The WebVTT has a `WEBVTT` header and one cue per event. Each cue has its event ID, `HH:MM:SS.mmm` timings, at least one second's length (a 1.8 s `durationMs` is kept), and escaped `key=value` text, never containing `-->`. With `CAPPY_REAL_TOOLS=1`, FFmpeg reads the exported file as subtitles and converts every cue to SRT.
- `--out events.vtt` writes a new file and leaves the workspace registry byte-for-byte unchanged, so the file is not managed. `--out mine.csv` on an existing file exits 1 with `EXPORT_TARGET_EXISTS` and leaves it untouched. In human mode, the export itself goes to standard output, so it can be piped.
- `docs/cli.md` documents the command, formats, and schemas, and `README.md` shows an example.

Validation (macOS):

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 279 passed, 17 skipped.
- `CAPPY_REAL_TOOLS=1 npx vitest run`: 294 passed, 2 skipped (the OBS smoke tests).
- `git diff --check`: passed.
