# Release preparation and publication

This runbook covers the npm CLI package `@uppercut-labs/cappy`. A release prep
run builds and tests one tarball, installs that exact tarball in isolated local
and global prefixes, computes its SHA-256, and retains the tarball and a manifest
with its version, expected tag, and source commit as a workflow artifact. It does
not publish or create a tag.

`0.1.0` was published to npm on 2026-09-28 by the `uppercut-labs` npm user,
tagged `v0.1.0` at `6d0835f`, and released on GitHub with its tarball and
checksum (see [First release record](#first-release-record)).

## Before release preparation

- Confirm the selected source commit is on `main`, all required CI checks pass,
  and the package version, `CAPPY_VERSION`, and expected `v<version>` tag agree.
- Inspect the public package contents with `npm pack --workspace
  @uppercut-labs/cappy --dry-run --json` and the isolated package checker.
- Review the matching source tree and release notes. The public tarball contains
  the CLI, the Godot addon (`addons/cappy/`), and the agent skill
  (`.agents/skills/cappy/`). The package checker fails if either is missing, if the
  manifest does not link `uppercut-labs/cappy`, or if any packaged file links
  another repository.
- Start **Actions → Release preparation → Run workflow** with `publish` left
  false. The run records whether the expected tag already exists and associates
  the artifact with the dispatched commit. An absent tag is allowed for this
  preparation-only run.

The artifact name includes the package version and commit. Download the `.tgz`,
`.sha256`, and `release-manifest.json` together. Keep that artifact as the exact
candidate for review; do not rebuild it on a different commit when publishing.

## Publisher setup

Set up the publisher before enabling publication:

1. Confirm the `uppercut-labs` npm user still has publish rights. The package
   exists since `0.1.0`, so configure a trusted publisher
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

Until trusted publishing is configured, a maintainer publishes the prepared
`.tgz` from a workstation. The npm scope `@uppercut-labs` is owned by the npm
user `uppercut-labs`; the user and scope names must match, so another account
cannot publish this package.

### First release record

`0.1.0` was published from a workstation on 2026-09-28. npm refused the first
attempt with `E403` because the access token did not bypass two-factor
authentication; npm only lets a token publish when it does. The working token
was a granular access token with **Bypass two-factor authentication** ticked,
**Read and write (publish and stage)** permission, and **All Packages** selected
(a package that does not exist yet cannot be selected by name). It was deleted
right after publishing. Interactive `npm login` with MFA avoids tokens entirely.

The published tarball was checked byte for byte against the tested one, and
`npx @uppercut-labs/cappy@0.1.0 --version` returned `0.1.0`. A new package can
return `E404` for several minutes after npm accepts it; this one took about four.

### Later releases with staged publishing

Now that the package exists, a token without 2FA bypass can stage a version for a
maintainer to approve. Staging needs npm CLI 11.15.0 or newer and Node.js 22.14
or newer, and the account must have 2FA enabled.

1. Prepare and download the release artifact as above, and check its checksum.
2. Update npm with `npm install --global npm@latest`.
3. Stage the tested tarball with the maintainer's token. Staging does not ask
   for 2FA:

   ```sh
   npm stage publish uppercut-labs-cappy-<version>.tgz --access public
   ```

4. Check it with `npm stage list @uppercut-labs/cappy` and
   `npm stage view <stage-id>`, then approve it on npmjs.com under
   **Staged Packages** or with `npm stage approve <stage-id>`. Approval always
   asks for 2FA.
5. Tag the manifest's commit as `v<version>`, push the tag, and create the
   GitHub release with the tarball and checksum.

The steps are described in npm's [staged publishing guide](https://docs.npmjs.com/staged-publishing).
Staging a tarball file (instead of the package folder) has not been tried yet;
if npm rejects it, extract the tarball and stage its `package/` folder.

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
- The Godot addon and the agent skill ship inside the npm package, next to the
  CLI, so the addon always matches the CLI version it came with.
- Linux is supported, but real OBS capture on Linux remains unverified.
- Package checks exercise the npm-generated local and global launchers on
  macOS, Windows, and Linux. Windows cancellation uses a fresh console to
  deliver Ctrl+C and verifies the cancelled session and child cleanup.
