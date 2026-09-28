# CAP-024 - Ship a public agent skill for using Cappy

**Status:** Complete

## Goal

An agent helping someone use Cappy can load one skill from this repository and reach a verified capture, or an honest account of what could not be verified, without inventing commands, flags, error codes, or addon calls.

## Scope

- A skill at `.agents/skills/cappy/`: `SKILL.md` (entry point), `README.md`, `agents/openai.yaml`, and references for the Godot adapter, configuration, and troubleshooting.
- The skill is self-contained: its links stay inside its folder, so it works when copied into an agent's skills directory.
- The skill reaches people through Cappy's npm package, not this repository, which stays private: it installs and runs Cappy through the package (`npx cappy`) and never links to or clones the source repository.
- A Vitest suite that keeps the skill true to the code: commands, flags and shorthands, error codes, exit codes, the Godot addon's members and files, a starting configuration the schema accepts, and the first steps it prescribes.
- The Godot guidance covers CAP-025's release-build gate: release exports stay inert unless `cappy/allow_release_builds` is on, the `override.cfg` that turns it on for one capture build, and the loopback-only endpoint.
- A link from `README.md`.

Out of scope: publishing the skill elsewhere, and any change to Cappy's behavior.

## Acceptance Criteria

- `SKILL.md` has frontmatter whose `name` matches its folder and whose `description` says when to use it, and stays under 500 lines.
- Every relative link in the skill resolves to a file inside the skill folder, and the skill contains no machine-specific paths or secret values.
- The suite fails if the skill links to GitHub or tells people to clone, check out, or build Cappy's source.
- The suite fails if the skill names a command, flag, shorthand, error code, or addon member that does not exist, or states exit codes that differ from the CLI's.
- The skill's starting configuration passes `parseConfig`, and with the simulator, fake OBS, and fake media tools substituted for the real ones, `doctor`, `scenarios`, `record`, and `replay --no-capture` succeed from it.
- The skill states its safety boundary: read-only commands first, approval before recording or deleting, no OBS scene edits, and the OBS password only in the environment.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run model:check`, and `git diff --check` pass.

## Dependencies

CAP-023, CAP-025.

## Completion

Completed 2026-09-27 (America/Chicago), in a Linux container with Node.js 24.21.0. No real FFmpeg, Godot, or OBS was available there.

- **Frontmatter and length:** `tests/skill.test.ts` "has an entry point whose frontmatter names its folder and says when to use it" passes; `SKILL.md` is 115 lines.
- **Links, paths, secrets:** "links only to files inside the skill" and "contains no machine-specific paths or secret values" pass.
- **Package delivery:** "points people at the npm package, never at Cappy's private source repository" passes; the skill installs through the package and never guesses its name.
- **Drift detection:** the command, flag, error-code, exit-code, and addon-member tests pass, and each failed when a nonexistent command (`frobnicate`), flag (`--nope`, `-zz`), error code, and addon method were introduced by hand, then passed again once reverted.
- **Starting configuration and first steps:** "gives a starting configuration the schema accepts" and "runs doctor, scenarios, record, and replay --no-capture from the skill's starting configuration" pass against the simulator, fake OBS, and fake FFmpeg/ffprobe. This proves the commands and configuration shape, not a real capture.
- **Release-build gate:** "names the addon's release-build setting as the addon reads it" passes against CAP-025's `ALLOW_RELEASE_SETTING`, and failed when the guide's `override.cfg` key was misspelled by hand.
- **Safety boundary:** stated in `SKILL.md` under "Safety boundary"; reviewed against the text, not simulated.
- **Validation:** `npm run typecheck` pass; `npm run lint` pass; `npm test` 299 passed, 19 skipped (opt-in real-tool tests), with CAP-025 merged in; `npm run model:check` pass; `git diff --check` clean.

Not yet decided, so not in this ticket: the published package's name and first version, and which package ships the skill and the Godot addon. When publishing is set up, that package's `files` must include `.agents/skills/cappy/` and the addon.

Not verified: an agent following the skill end to end against real Godot, FFmpeg, and OBS on macOS, Windows, or Linux. Real capture itself remains as accepted in CAP-023.
