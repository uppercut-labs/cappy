# CAP-022 - Accept Linux as a supported host

## Goal

Linux is a supported Cappy host, backed by repeatable container evidence, with OBS capture honestly marked unverified (SPEC section 21; ADR-021).

## Scope

- `scripts/acceptance/linux-container.sh`. It copies the repository into a `node:24-bookworm-slim` (arm64) container, installs FFmpeg with apt and Godot 4.7.2 (linux arm64), and runs typecheck, lint, the normal suite, the real-tool suite, and the model check. It exits non-zero on any failure.
- Fixes for any Linux-specific failures it reveals.
- Linux results in `docs/acceptance.md`.
- README and getting-started notes for Linux.

## Acceptance Criteria

- `scripts/acceptance/linux-container.sh` runs from macOS with OrbStack or Docker, and passes. Typecheck, lint, the normal suite, `CAPPY_REAL_TOOLS=1` (real FFmpeg and headless Godot), and `npm run model:check` all pass inside the container.
- The Godot demo scenario and a freeform record and replay run with real headless Godot on Linux, including CAP-017 to CAP-021 behavior that needs no OBS: every-match clips from a fake-OBS real master, timeline export, a slow-motion replay, and compare with gates.
- `docs/acceptance.md` has a separate Linux section. Real OBS on Linux is listed as unverified, not inferred.
- Repository-standard validation passes on macOS.

## Dependencies

CAP-017, CAP-018, CAP-019, CAP-020, CAP-021.
