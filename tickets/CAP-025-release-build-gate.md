# CAP-025 - Keep the Godot adapter inert in release exports

**Status:** Complete

## Goal

A shipped game that carries the Cappy addon cannot be driven through the adapter by someone who sets its environment variables (ADR-023). Raised by Fantasy Party's review of its vendored addon.

## Scope

- `cappy_adapter.gd`: stay inert in release exports unless `cappy/allow_release_builds` is true; refuse non-loopback endpoints.
- Adapter README: release exports and the setting.
- A real-Godot test for the loopback refusal.

## Acceptance Criteria

- A release export launched with `CAPPY_ENDPOINT` and `CAPPY_SESSION_TOKEN` set does not connect and logs why.
- A non-loopback `CAPPY_ENDPOINT` is refused in every build.
- The existing Godot suite passes unchanged.

## Dependencies

CAP-008.

## Completion

Completed 2026-09-28.

- `CAPPY_REAL_TOOLS=1` Godot suite on Linux (Node.js 24.21.0, Godot 4.7.2): 8 passed, including the new loopback-refusal test. Normal suite: 284 passed, 19 skipped. Typecheck and lint pass.
- Release gate checked by hand with a Godot 4.7.2 Linux release export of Fantasy Party launched with both variables set: it logs `Cappy: ignoring the controller in a release build` and does not connect. With `cappy/allow_release_builds=true` in an `override.cfg` beside the executable, the gate opens, and a non-loopback endpoint is still refused. The editor binary always runs as a debug build, so the suite cannot cover this case.
