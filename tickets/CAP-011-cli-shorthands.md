# CAP-011 - Add whole-token flag shorthands across the CLI

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
