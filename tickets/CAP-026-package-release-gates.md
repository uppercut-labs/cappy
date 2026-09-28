# CAP-026 - Verify installed behavior and gate releases

**Status:** Complete
**Depends on:** CAP-025.

## Work

Follow SPEC section 26.5: add CI on Node.js 24 across macOS, Windows, and Linux;
pack only the public workspace; install the exact tarball outside the checkout
locally and into an isolated global prefix. Exercise npm-generated launchers,
help/version, doctor JSON, missing config/tools, scenario discovery, record,
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

Completed for preparation-only scope on 2026-09-28. CI targets Node 24 on
macOS/Windows/Linux. The isolated checker verifies exact tarballs with actual
local/global npm launchers, help/version, JSON diagnostics, discovery,
record/replay without capture, and cancellation. All three hosts passed; Windows
Ctrl+C uses a fresh native console against the installed entrypoint and verifies
child cleanup. Windows suite concurrency is bounded at four after a transient
fake-OBS timeout under the first full parallel run. See docs/acceptance.md.

Manual release preparation retains the tested tarball, checksum, and source
manifest. Publication is disabled by default and requires an explicit flag,
existing matching tag, protected environment, and npm setup. The first npm
publication/bootstrap remains separately authorized future work; see
[releasing.md](../docs/releasing.md). No npm package or tag was published.
