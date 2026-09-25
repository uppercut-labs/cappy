# CAP-006 - Integrate OBS recording as the primary capture backend

## Goal

Produce verified master recordings synchronized with Cappy operations.

## Scope

- OBS WebSocket client.
- Authentication via safe local secret input.
- Version/state inspection.
- Configured-scene validation.
- Start/stop recording and state verification.
- Master output resolution.
- Fake OBS backend for automated tests.
- Integrate master capture into `cappy run` and optional `cappy record --capture`.

## Acceptance Criteria

- Cappy never reports capture success merely because a start/stop request was sent.
- Authentication, scene, start, stop, timeout, and disconnect failures are tested.
- Cappy does not create/delete OBS scenes or sources.
- Verified master is registered as managed with size/hash metadata.
- Simulator scenario can drive a full fake-OBS capture job.

## Dependencies

CAP-003, CAP-004, CAP-005.
