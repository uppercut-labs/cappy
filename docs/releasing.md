# Release preparation and publication

This runbook covers the npm CLI package `@uppercut-labs/cappy`. A release prep
run builds and tests one tarball, installs that exact tarball in isolated local
and global prefixes, computes its SHA-256, and retains the tarball and a manifest
with its version, expected tag, and source commit as a workflow artifact. It does
not publish or create a tag. No npm release was made by this preparation work.

## Before release preparation

- Confirm the selected source commit is on `main`, all required CI checks pass,
  and the package version, `CAPPY_VERSION`, and expected `v<version>` tag agree.
- Inspect the public package contents with `npm pack --workspace
  @uppercut-labs/cappy --dry-run --json` and the isolated package checker.
- Review the matching source tree and release notes. The public tarball contains
  the CLI; the Godot addon remains in the versioned source tree.
- Start **Actions → Release preparation → Run workflow** with `publish` left
  false. The run records whether the expected tag already exists and associates
  the artifact with the dispatched commit. An absent tag is allowed for this
  preparation-only run.

The artifact name includes the package version and commit. Download the `.tgz`,
`.sha256`, and `release-manifest.json` together. Keep that artifact as the exact
candidate for review; do not rebuild it on a different commit when publishing.

## Publisher setup

Set up the publisher before enabling publication:

1. Confirm Uppercut Labs controls the npm scope and has publish rights. The
   package currently returns `E404`; npm trusted-publisher settings are attached
   to a package, so the first `0.1.0` publication requires a separately approved
   bootstrap. After that initial package exists, configure a trusted publisher
   for GitHub Actions repository `uppercut-labs/cappy`, workflow filename
   `release.yml`, and environment `npm-production`. Trusted publishing uses
   short-lived OIDC credentials. The current npm requirements are npm CLI
   11.5.1 or newer and Node.js 22.14 or newer; the publish job upgrades npm and
   uses Node.js 24.
2. In GitHub, create the `npm-production` environment. Require an independent
   reviewer, restrict deployment branches to `main`, and prevent bypass where
   repository settings allow it. Required-reviewer availability for private
   repositories depends on the GitHub plan.
3. Keep the repository variable `CAPPY_NPM_PUBLISH_ENABLED` unset or `false`
   until npm trusted publishing and the protected environment are confirmed.
   The workflow deliberately fails a requested publish unless this variable is
   exactly `true`.
4. Confirm the workflow has `id-token: write` only on the gated publication job.
   Do not add a long-lived npm token to the repository or environment.

For the first public version, an authorized maintainer must use npm's interactive
authentication and required MFA to publish the exact prepared `.tgz` from a
secure workstation, then create the matching GitHub release with that artifact
and checksum. Do not create a token or store credentials in GitHub for bootstrap.
Once the package exists and its trusted publisher is configured, later releases
can use the gated workflow job. Verify npm's current staged-publishing support
and organization settings before choosing a different bootstrap method.

npm trusted publishing configuration and provenance requirements are described
in the official [trusted publishers guide](https://docs.npmjs.com/trusted-publishers/)
and [provenance guide](https://docs.npmjs.com/generating-provenance-statements/).
GitHub environments pause jobs for configured protection rules; see the official
[deployment environments guide](https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments).

## Publishing

Publishing requires a separately authorized release action. Before enabling the
workflow variable or selecting `publish: true`, confirm all of the following:

- The expected annotated or lightweight tag exists and resolves to the exact
  commit recorded in the prepared manifest. Create and push the tag from the
  reviewed commit as a separate release decision.
- The npm version is absent. The workflow treats only npm's explicit `E404` as
  evidence that a version is unused; network or authentication errors stop the
  release.
- The tarball checksum and manifest match the artifact from the preparation
  run. The publication job installs the artifact by name, never repacks source.
- The `npm-production` environment approval is configured and has been granted.

Set `CAPPY_NPM_PUBLISH_ENABLED=true` only for an approved release window after
the package's trusted publisher is ready, then run the workflow against the
tagged commit with the matching tag input and `publish: true`. The gated job publishes the tested tarball with npm provenance,
downloads the published version again, and compares its bytes and registry
integrity to the candidate. It then creates the GitHub release with the same
tarball and checksum attached. A failed step after npm accepts the package is a
partial release: inspect the registry and GitHub state before any recovery, and
never retry an ambiguous publish or attempt to replace an existing version.
Return the repository variable to `false` after the release window.

The workflow uses GitHub workflow artifacts to retain and transfer the prepared
tarball between jobs; GitHub documents their storage and retention in
[workflow artifacts](https://docs.github.com/en/actions/tutorials/store-and-share-data).
npm's [`npm pack`](https://docs.npmjs.com/cli/v11/commands/npm-pack/) uses the
same package selection rules as publishing, so the isolated check tests the
actual archive.

## Support notes for release records

- Node.js 24 or newer is required.
- OBS and FFmpeg/ffprobe are external prerequisites for video capture. Cappy
  does not download them.
- The Godot addon is installed from the matching GitHub source tag; npm contains
  the controller CLI.
- Linux is supported, but real OBS capture on Linux remains unverified.
- Package checks exercise the npm-generated local and global launchers on
  macOS, Windows, and Linux. Windows cancellation uses a fresh console to
  deliver Ctrl+C and verifies the cancelled session and child cleanup.
