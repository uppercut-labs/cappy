# CAP-007 - Add FFmpeg derivatives and authoritative capture manifests

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
