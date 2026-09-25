# Cappy Task Execution Loop

## Autostart Instruction

When this file is referenced or supplied without additional task text, execute the embedded workflow immediately. Do not ask for a ticket ID or provide a plan instead of beginning. Read fresh repository and ticket state, mechanically select one executable ticket, complete exactly one bounded pass, record a terminal result, and stop. Ask only when a real ambiguity or required owner decision cannot be resolved from authoritative sources.

## Prompt

```text
Complete exactly one next executable ticket for Cappy.

Repository: devin-thomas/cappy, at the local repository root
Task source of truth: the ticket files tickets/CAP-*.md in this repository. GitHub Issues and pull requests are never tasks.
Target branch: main. Commit directly to main; do not create feature branches or pull requests.
Host: this macOS machine only. No other host is used during a pass.

Do not ask for a ticket ID. Resolve one ticket from fresh repository state, complete only that ticket, record the result, and stop.

Before changing anything:

1. Record start-time evidence in America/Chicago: the zone identifier, the local ISO-8601 time with numeric offset, and the UTC time. Never ask for or change the reporting zone.
2. Read Context.md, SPEC.md, ADR.md, Ideas.md, docs/system-model.dot, and README.md, plus any AGENTS.md or CLAUDE.md that exists in the repository.
3. Inspect Git: git status --porcelain, the current branch, and git fetch origin main. Work only on main. Fast-forward local main to origin/main when the worktree is clean. If local main has commits that are not on origin/main, or has diverged, stop with Inconsistent state; never push commits this pass did not create. Leave pre-existing uncommitted changes untouched and never stage them. If they overlap files the selected ticket must change, stop with Blocked.
4. Read every tickets/CAP-*.md file completely.
5. Inspect the code, tests, fixtures, and documentation relevant to candidate tickets.

Ticket state:

- A ticket is complete if and only if the line immediately below its title reads exactly "**Status:** Complete". A ticket without that line is incomplete. There are no other statuses; do not invent any.
- A ticket's "## Dependencies" section lists its blockers as CAP IDs, or "None.".

Select the ticket mechanically:

1. Form the eligible set: incomplete tickets whose listed dependencies are all complete.
2. Order eligible tickets by ascending CAP number.
3. If nothing is eligible: stop with No executable task when every ticket is complete. Otherwise stop with Inconsistent state and name each incomplete ticket and its incomplete dependencies.
4. Read the selected ticket completely, including the SPEC.md sections its scope refers to and the completion evidence of its dependencies.
5. If the ticket has no verifiable acceptance criteria, stop with Blocked and state the precise question.
6. Announce the selected ticket, the selection evidence, and its goal before implementation.

Authority order:

1. The selected ticket's goal, scope, and acceptance criteria.
2. SPEC.md for product behavior and Context.md for domain vocabulary. Use Context.md's ubiquitous language in code and docs.
3. ADR.md and docs/system-model.dot.
4. Ideas.md, which lists deferred work that must not be built unless a ticket promotes it.
5. Existing code and tests.

Execution rules:

- Own only the selected ticket and implement the smallest complete vertical slice that satisfies its acceptance criteria. Do not implement sibling or successor tickets, Ideas.md work, SPEC non-goals, speculative features, broad refactors, or unrelated cleanup. Report discovered follow-up work instead.
- Follow the SPEC technology: Node.js LTS, strict TypeScript, npm workspaces, ESM, runtime schema validation, and Vitest. Keep the intended repository structure in SPEC section 5. Core packages never depend on Godot.
- Keep shared code cross-platform for Windows and macOS: platform-safe path APIs, subprocesses without shell interpolation, and no PowerShell-only or macOS-only semantics in shared core.
- The normal automated suite must not require the OBS GUI, a running game, or network access beyond loopback. Real-tool smoke tests are opt-in.
- Project-local npm dependencies may be added when the ticket needs them. Do not install system software, Homebrew packages, OBS, or Graphviz, and do not change OBS scenes, profiles, or settings. If a ticket's acceptance requires a tool or host that is not available on this Mac, including Windows host acceptance, a real configured OBS instance, or Graphviz, complete everything else in scope, record exactly what the owner must provide, and stop with Needs owner. Never record a real-tool or host pass from fakes, mocks, or the other operating system.
- Never read, print, or commit secret values. The OBS WebSocket password comes only from an environment variable or an untracked local override and never appears in config examples, manifests, logs, test fixtures, or commit content.
- Behavior discovered during implementation that SPEC.md does not define must be reflected in Context.md or SPEC.md rather than silently invented. Keep docs/system-model.dot synchronized when the system's components or flows change.

Validation:

- From the repository root, run npm run typecheck, npm run lint, and npm test. CAP-001 establishes these scripts; every later ticket keeps them passing. Also run git diff --check.
- Run each acceptance-criterion check the ticket names. When the ticket touches FFmpeg/ffprobe or the Godot fixture and that tool is on PATH, run the relevant opt-in real-tool smoke test as well.
- A required check that fails or is skipped blocks completion. Record exact commands and results, including expected skips and their reasons.

Completion gate:

Mark the ticket complete only when every acceptance criterion has recorded evidence, all required checks pass, documentation reflects changed behavior and commands, and planning artifacts remain synchronized with delivered behavior.

To mark it complete, in the same commit as the implementation:

1. Insert "**Status:** Complete" on its own line immediately below the ticket's title, separated by blank lines.
2. Append a "## Completion" section at the end of the ticket file listing the completion date (America/Chicago), each acceptance criterion with its evidence, and the exact validation commands and results.

Change no other ticket file's status. Do not alter the ticket's goal, scope, acceptance criteria, or dependencies.

If work is incomplete, blocked, or failing validation, do not add the Status line and do not commit. Leave this pass's changes uncommitted in the worktree for inspection, and stop with Incomplete, Blocked, or Needs owner.

Git and publication:

- Stage exact paths only, review git diff --cached, and scan the staged diff for secrets before committing.
- Commit subject: "<CAP-ID>: <summary>". Verify the commit with git log -1 --stat.
- Push with git push origin main. If the push is rejected because origin moved, rebase onto origin/main, rerun the affected checks, and push again. Never force-push.
- Do not create tags, releases, GitHub issues, or pull requests, and do not publish packages.

At the end:

1. Capture end-time evidence the same way and calculate elapsed time from the UTC instants.
2. Report:
   - Selected ticket (ID and title) and execution result: Complete, Incomplete, Blocked, Needs owner, No executable task, or Inconsistent state.
   - Ticket state after the pass and the selection evidence.
   - Implemented outcomes.
   - Exact validation commands and results, including failures and skips.
   - Commit hash and push result.
   - Changed files.
   - Residual risks, blockers, owner follow-ups, and discovered follow-up work.
   - Start and end times (zone identifier, local time with numeric offset, and UTC) and elapsed time.
3. Stop. Do not start another ticket.
```

## Selection Invariant

No current ticket ID is hard-coded in this prompt. Resolve the selected ticket from fresh repository state on every pass, preserve existing work, and stop after one ticket-level result.
