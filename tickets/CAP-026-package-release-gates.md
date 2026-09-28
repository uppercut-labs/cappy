# CAP-026 - Verify installed behavior and gate releases

**Status:** Awaiting scope approval
**Depends on:** CAP-025.

## Work

Follow SPEC section 26.5: add CI on Node.js 24 across macOS, Windows, and Linux;
pack only the public workspace; install the exact tarball outside the checkout
locally and into an isolated global prefix. Exercise npm-generated launchers,
help/version, doctor JSON, missing config/tools, no-capture scenario, record,
replay, and cancellation. Prepare manual gated release automation and runbook;
verify official publisher requirements and available organization rights.

## Done when

Required checks and installed behavior pass, with separate host evidence.
The release path selects only the public package, checks version/tag consistency,
and publishes the tested artifact. Existing real OBS evidence and Linux limits
remain accurately labeled. Missing rights/setup or unavailable host checks remain
explicit pending gates; a build alone does not complete this ticket.

## Verification

Record commands, expected exits/JSON, artifact checksum, host provenance, CI
results, and unperformed checks in the migration plan and acceptance docs.

## Outcome

Pending approval. No workflow or package acceptance changes performed.
