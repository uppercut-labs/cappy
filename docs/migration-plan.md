# Cappy Uppercut Labs migration plan

**Status:** Complete for the approved preparation-only delivery.
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
- Implemented packaging: separate `packages/cappy` distribution, private internals,
  esbuild for Node ESM, registry dependencies `ws` and `zod`.
- License: MIT, confirmed by the owner on 2026-09-28.
- Visibility: make public after reviewing publish contents, confirmed by the
  owner on 2026-09-28; GitHub repository is now public.
- Delivery: transfer GitHub and prepare npm release, confirmed by the owner on
  2026-09-28. Do not publish npm `0.1.0` during this delivery.
- Scope approval: owner said "Go" on 2026-09-28, with GPT-6 Luna/high workers.

ADR-023 records the approved ownership/distribution decision.

## Evidence and resume point

Completed: repository/package inspection, approved specification/tickets, and
MIT license. GitHub transfer succeeded: repository ID `1387786906` is now
`uppercut-labs/cappy`, with admin access retained, default branch `main`, and
origin updated. Source slices were committed and pushed on `main`: `410d4aa`
(plan/license), `8ab022a` (package distribution), `ca6fac9` (verification and
release tooling), `50b5eb1` (archive/console-fixture hardening).

Public-content review: Gitleaks 8.30.1 scanned all 46 existing commits (1.10 MB)
with no leaks found. Tracked paths and historical paths contain no environment
files, private keys, captures, dependency trees, or generated builds. Source
and project documents were reviewed; test credentials are synthetic, and OBS
credentials use environment variable names. No configured hooks or Actions
secrets were reported. The repository is now public.

Implementation: eight private workspaces renamed, one public distribution
added, consumer/contributor docs updated, cross-platform CI and manual gated
release preparation added. Publication requires a separate decision and the
explicit enable variable; it remains disabled. No npm version or tag was created.

Validation: Node 24 source checks passed on macOS and Linux (284 tests / 18
skipped) and Windows (282 / 20 skipped, four workers). Model, typecheck, lint,
and distribution builds pass. Isolated local/global installs, diagnostics,
scenario discovery, no-capture record/replay, and cancellation pass on each
host. Windows uses actual npm `.cmd` launchers for normal commands and an
automated native console event against the installed entrypoint for Ctrl+C.
See [acceptance.md](acceptance.md) for provenance and the initial Windows
parallel-load timeout repaired by limiting fixture concurrency.

Candidate tarball SHA-256:
`276e64cd7a4b6cc1072229f079aba69363103ffa816e2297a4783a70ab25f237`.
The four-file archive has only `ws` and `zod` as runtime dependencies. The same
archive passed macOS and Windows installation; Linux independently produced
the same checksum. The local candidate is generated at
`packages/cappy/uppercut-labs-cappy-0.1.0.tgz` (ignored by Git).

Publisher setup remains deliberately unperformed: verify Uppercut Labs npm
scope rights, authorize the initial interactive publication, then configure
trusted publishing and protect `npm-production` before enabling future CI
publication. [releasing.md](releasing.md) documents this bootstrap and recovery.
Real-tool capture acceptance is historical and was not rerun for packaging.

Remote verification on `50b5eb1`:

- [CI](https://github.com/uppercut-labs/cappy/actions/runs/36431049845) passed on
  macOS, Windows, and Linux.
- [Release preparation](https://github.com/uppercut-labs/cappy/actions/runs/36431184220)
  passed and retained the tarball, checksum, and source manifest. Its publish
  job was skipped; `tagPresent` is false.
- The first CI run exposed Git Bash GNU tar treating a Windows drive letter
  as a remote archive host. The checker now lists by basename from the archive
  directory; the corrected run passes. The Windows test helper explicitly
  writes UTF-8, and publication checks the manifest digest against the archive.
- A documentation-only closeout commit follows; runtime/tooling evidence is
  associated with the immutable source revision above.

**Next action:** when the owner authorizes the first npm release, follow
[releasing.md](releasing.md) to confirm npm scope rights and bootstrap the tested
artifact. No approval or implementation work remains for this migration.
