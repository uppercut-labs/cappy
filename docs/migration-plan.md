# Cappy Uppercut Labs migration plan

**Status:** Approved; implementation in progress.
**Date:** 2026-09-28
**Specification:** [SPEC.md, section 26](../SPEC.md#26-uppercut-labs-ownership-and-npm-distribution)

## Intended result and first use

Move Cappy to `uppercut-labs/cappy` and ship one public CLI package,
`@uppercut-labs/cappy`, preserving the `cappy` executable and current behavior.
Devin Thomas remains the credited author and maintainer. A consumer installs
the package and runs `cappy doctor` against their own configured project without
building the repository. Empty or incomplete projects get existing diagnostics.

## Scope and devices

Keep six private implementation workspaces and two private fixtures; rename
their namespace and add one distribution workspace that bundles the internals.
Include metadata, license, consumer/contributor docs, CI, isolated installation
checks, and gated release tooling. Preserve macOS/Windows support and Linux's
unverified real OBS status. No GUI or product feature work is included.

## Delivery sequence

1. [CAP-024](../tickets/CAP-024-uppercut-ownership.md): confirm license, visibility,
   and release scope; review public contents; transfer existing GitHub ownership.
2. [CAP-025](../tickets/CAP-025-single-npm-distribution.md): rename private
   workspaces, bundle one public distribution, and update consumer documentation.
3. [CAP-026](../tickets/CAP-026-package-release-gates.md): add CI, prove tarball
   installation and CLI behavior per host, and prepare gated release automation.
4. [CAP-027](../tickets/CAP-027-migration-delivery.md): publish authorized source
   changes; either hand off a release-ready package or publish/verify `0.1.0`.

Commit coherent slices and push only to the confirmed destination. Preserve
unrelated work; do not rewrite history or replace the existing repository.

## Decisions and approval

- Product identity: `uppercut-labs/cappy`, npm `@uppercut-labs/cappy`, bin `cappy`.
- Proposed packaging: separate `packages/cappy` distribution, private internals,
  esbuild for Node ESM, registry dependencies `ws` and `zod`.
- License: MIT, confirmed by the owner on 2026-09-28.
- Visibility: make public after reviewing publish contents, confirmed by the
  owner on 2026-09-28; current GitHub repository is private.
- Delivery: transfer GitHub and prepare npm release, confirmed by the owner on
  2026-09-28. Do not publish npm `0.1.0` during this delivery.
- Scope approval: owner said "Go" on 2026-09-28, with GPT-6 Luna/high workers.

After approval, record the ownership/distribution decision in the existing ADR
file rather than creating a competing decisions document.

## Evidence and resume point

Completed: repository/package inspection, approved specification/tickets, and
MIT license. GitHub transfer succeeded: repository ID `1387786906` is now
`uppercut-labs/cappy`, with admin access retained, default branch `main`, and
origin updated. Remote `main` still resolves to the prior source commit.

Public-content review: Gitleaks 8.30.1 scanned all 46 existing commits (1.10 MB)
with no leaks found. Tracked paths and historical paths contain no environment
files, private keys, captures, dependency trees, or generated builds. Source
and project documents were reviewed; test credentials are synthetic, and OBS
credentials use environment variable names. No configured hooks or Actions
secrets were reported. Visibility change and integrated validation are next.

Completion evidence follows SPEC section 26.7. Record actual command results,
host checks, remote commit, URLs, and any remaining publisher setup here.

**Next action:** approve this concrete scope, then execute CAP-024 through
CAP-027 in order. The three consequential choices are resolved.
