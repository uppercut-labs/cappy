# CAP-024 - Transfer Cappy ownership to Uppercut Labs

**Status:** Complete
**Depends on:** Scope approval in [migration-plan.md](../docs/migration-plan.md).

## Work

Follow SPEC sections 26.1-26.3: confirm release scope, visibility, and license;
inspect transfer rights and destination conflicts; review tree/history before
any public visibility change; transfer the existing repository and update origin.
Add the confirmed license and author/publisher credit. Record the approved
ownership and distribution decision in ADR.md and the migration plan.

## Done when

`uppercut-labs/cappy` is the existing repository under its new owner, with history
and resources preserved, default branch `main`, correct origin, and confirmed
license/visibility. Consequential conflicts or public-content concerns are
resolved explicitly rather than bypassed.

## Verification

Inspect repository identity/settings before and after transfer; verify remote
refs and local origin. Record actual results and any integration follow-up.

## Outcome

Completed 2026-09-28. Transferred the existing GitHub repository (ID
`1387786906`) to `uppercut-labs/cappy`, retained admin access and `main`, updated
origin, and made it public after reviewing tree/history and scanning all 46
prior commits with Gitleaks 8.30.1 (no leaks). Added MIT copyright Devin Thomas.
Approved choices are recorded in ADR-023 and the migration plan. No destination
conflict, configured webhooks, or Actions secrets were reported.
