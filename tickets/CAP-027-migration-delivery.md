# CAP-027 - Deliver the approved migration and release scope

**Status:** Awaiting scope approval
**Depends on:** CAP-024, CAP-025, CAP-026.

## Work

Commit coherent reviewed slices and push to the confirmed Uppercut Labs remote.
Follow the approved delivery choice in SPEC section 26.7. Preparation-only:
retain the tested artifact and runbook with publication gated. Publication:
verify name/version availability, publish the tested tarball, create matching
GitHub release notes/assets, and verify the public version from a clean install.

## Done when

Requested source changes are remotely verified. Preparation-only delivery is
labeled release-ready, with remaining publisher setup documented. A requested
publication is complete only after both npm and GitHub release are verified;
partial publication is reported and reconciled explicitly.

## Verification

Confirm remote branch/commit and local status. For publication, compare registry
metadata/integrity to the tested tarball and exercise the documented
version-pinned scoped CLI command. Record actual URLs and pending checks.

## Outcome

Preparation-only delivery confirmed; scope approval pending. Nothing published.
