# CAP-027 - Deliver the approved migration and release scope

**Status:** Complete (preparation-only delivery)
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

Completed 2026-09-28. Coherent source slices are pushed to public
`https://github.com/uppercut-labs/cappy` on `main`. Runtime/tooling revision
`50b5eb1f1373c3f4e3ccb5f78081901287f747f3` passed
[all three CI hosts](https://github.com/uppercut-labs/cappy/actions/runs/36431049845).
[Release preparation](https://github.com/uppercut-labs/cappy/actions/runs/36431184220)
succeeded and retained the tested artifact, checksum, and source association;
the publication job was skipped. No npm package, tag, or GitHub release was
created. A documentation-only closeout commit follows this verification.

The four-file candidate also exists locally at
`packages/cappy/uppercut-labs-cappy-0.1.0.tgz`, ignored by Git. Publisher setup
and first-publication authorization remain deliberate future release work,
documented in [releasing.md](../docs/releasing.md). All migration tickets are
complete; historical real-tool limitations remain explicit.
