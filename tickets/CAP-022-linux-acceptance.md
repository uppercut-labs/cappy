# CAP-022 - Accept Linux as a supported host

**Status:** Complete

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

## Completion

Completed 2026-09-25 (America/Chicago).

- `scripts/acceptance/linux-container.sh` ran from macOS through OrbStack and passed (exit 0). In a `node:24-bookworm-slim` container (Debian 12, aarch64, Node.js 24.21.0), it installed FFmpeg 5.1.9 with apt and the official Godot 4.7.2 linux.arm64 build. It copied the repository's tracked and unignored files, ran `npm ci`, and passed:
  - typecheck and lint;
  - the normal suite: 284 passed, 18 skipped;
  - `CAPPY_REAL_TOOLS=1`: 300 passed, 2 skipped (the real-OBS smoke tests);
  - `npm run model:check`.
- Real headless Godot on Linux passed all 7 Godot tests: the demo scenario, freeform record and replay, replay capture, the variant build through `compare-builds` with `--require-same-events`, and the half-speed close-camera replay. CAP-017 to CAP-021 behavior that needs no OBS also passed with real FFmpeg: every-match clips and stills from a real master, comparisons with SSIM, worst frames, and gates, WebVTT export read back by FFmpeg, and slow-motion presentation.
- `docs/acceptance.md` has a separate Linux section. It records these results, marks real OBS capture on Linux as unverified, and notes that no Linux-specific fix was needed. `README.md` and `docs/getting-started.md` state Linux support and the OBS caveat.
- Repository-standard validation passes on macOS; the code is unchanged since CAP-021's validation.

Validation:

- Linux (container): the steps above, all passing.
- macOS: `git diff --check` passed. Only a script and docs changed in this ticket.
