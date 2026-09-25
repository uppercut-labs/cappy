# CAP-009 - Complete scenario and replay capture vertical slices

## Goal

Exercise the intended product workflow end to end with the Godot fixture.

## Scope

- Full `cappy run <scenario>` state machine.
- Full `cappy replay <session-id>` capture path.
- Take allocation.
- Timeline/master synchronization.
- Manifest publication.
- Cancellation/crash reconciliation.
- End-to-end integration harness.

## Acceptance Criteria

- Scenario -> ready -> OBS -> events -> completion -> master -> derivatives -> manifest succeeds.
- Stored freeform session can later replay through the same capture pipeline.
- Existing successful takes are not overwritten.
- Failed/cancelled jobs remain clearly non-successful.
- Correlation IDs link logs, session, capture, and manifest.

## Dependencies

CAP-006, CAP-007, CAP-008.
