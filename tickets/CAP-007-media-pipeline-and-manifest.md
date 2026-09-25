# CAP-007 - Add FFmpeg derivatives and authoritative capture manifests

**Status:** Complete

## Goal

Turn a verified master into reproducible, inspectable capture artifacts.

## Scope

- ffprobe validation.
- FFmpeg subprocess wrapper.
- Named capture presets.
- MP4, clip, thumbnail, and still derivative primitives.
- Atomic derivative publication.
- Versioned successful/failed manifest generation.
- Tool versions, hashes, timing, timeline, capabilities, and ownership records.

## Acceptance Criteria

- Required invalid/missing derivatives fail processing.
- A derivative failure never deletes the verified master.
- Successful artifacts have SHA-256 and byte metadata.
- Secrets are absent from manifests.
- Fake and real-media fixture tests cover success and failure.

## Dependencies

CAP-002, CAP-006.

## Completion

Completed 2026-09-25 (America/Chicago).

- Required invalid/missing derivatives fail processing: FFmpeg exiting non-zero, empty output, missing output, and output ffprobe rejects each fail the job with `DERIVATIVE_FAILED` and leave a `failed` manifest recording the failed check (`packages/cli/test/processing.test.ts`). A real zero-frame still also fails. Invalid options fail before the game launches.
- A derivative failure never deletes the verified master: after each failure, the capture directory still holds `master.mkv` (and its manifest) with no partial outputs; a master ffprobe rejects is kept for diagnosis.
- Successful artifacts have SHA-256 and byte metadata: every master and derivative artifact carries `sha256` and `bytes` matching the file on disk and its workspace registry entry.
- Secrets are absent from manifests: a capture authenticated with an OBS password from the environment writes a manifest containing neither the password nor its variable name, and the writer refuses any manifest containing it.
- Fake and real-media fixture tests cover success and failure: fake ffmpeg/ffprobe scripts cover every failure mode in the normal suite; with `CAPPY_REAL_TOOLS=1`, a real H.264/AAC master is probed and real mp4, clip, thumbnail, and still derivatives are produced and checked for dimensions and duration.

Manifests record identity (capture, session, take, project, source), build (Cappy, adapter, protocol, capabilities), timing and timeline, tooling (OBS, FFmpeg, ffprobe versions, preset fingerprint), artifacts with ownership, and verification checks. Takes are numbered per source.

Validation:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 13 files, 175 tests passed, 3 skipped (opt-in real-tool tests); run twice with no flakes.
- `CAPPY_REAL_TOOLS=1 npx vitest run`: 178 tests passed against FFmpeg/ffprobe 9.0.1.
- `git diff --check`: passed.
