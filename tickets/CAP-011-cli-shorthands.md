# CAP-011 - Add whole-token flag shorthands across the CLI

**Status:** Complete

## Goal

Every CLI flag can be typed as the whole-token shorthand defined in SPEC section 11.1 (ADR-016).

## Scope

- One alias table for every current flag: `-j`, `-C`, `-c`, `-h`, `-v`, `-p`, `-pa`, `-t`, `-ca`, `-nc`, and `-d`.
- Translate whole tokens before strict argument parsing. Option values are never translated.
- Reject unknown shorthands with `USAGE_INVALID`.
- List the shorthands in `cappy --help` and `docs/cli.md`.
- Tests.

Flags added by later tickets (`clean`, `compare`) join the same table in those tickets.

## Acceptance Criteria

- Each shorthand for an existing flag behaves exactly like its long flag, including for flags that take values, proven by tests.
- A multi-letter shorthand is a single token: `-nc` is `--no-capture`, never `-n -c`.
- An unknown shorthand such as `-zz` fails with `USAGE_INVALID` and exit 2, in human and JSON mode.
- A string option's value is passed through untranslated even when it starts with `-`.
- The alias table is defined once. A test fails if two flags share a shorthand, or if a shorthand breaks the initials rule without being a documented exception (`-C`).
- `cappy --help` and `docs/cli.md` list every shorthand.
- Repository-standard validation passes.

## Dependencies

None.

## Completion

Completed 2026-09-25 (America/Chicago).

- Each shorthand behaves exactly like its long flag: `translateShorthands` maps every entry in the single table (`packages/cli/src/flags.ts`) to its long flag and keeps any value (`packages/cli/test/flags.test.ts`). End-to-end runs cover global flags (`doctor -j -c alt.json` returns the same data as `--json --config alt.json`; `-h`, `-v`), value flags (`run boss_intro -pa difficulty=3 -p trailer -t 4`), and booleans (`record -ca -d 0.3`, `replay <id> -nc`).
- A multi-letter shorthand is one token: `-nc` becomes `--no-capture`, and the grouped form `-jh` is rejected.
- An unknown shorthand fails with `USAGE_INVALID` and exit 2: `doctor -zz` in human mode (message on stderr) and with `-j` (one JSON document). Also checked through the real binary, `node packages/cli/bin/cappy.js doctor -zz -j` (exit 2).
- A string option's value is never translated, even with a leading `-`: `-pa -d`, `--param -nc`, `--config -c`, `--preset=-p`, and anything after `--` pass through unchanged.
- The table is defined once. Tests fail on a duplicate shorthand, or on one that breaks the initials rule (initials for multi-word flags; first letter, or two letters only after a first-letter collision) without being the documented `-C` exception.
- `cappy --help` lists every shorthand (a test checks each), as do `docs/cli.md` (new "Shorthands" section and every option table) and a `README.md` example.
- Repository-standard validation passes (below).

Validation (macOS):

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test`: 200 passed, 10 skipped (the opt-in real-tool and OBS tests).
- `git diff --check`: passed.
- Real-tool runs: not required, because this ticket touches neither FFmpeg nor Godot.
