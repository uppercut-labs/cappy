# Cappy launch handoff

## Live surfaces

- [Landing and approved film](https://cappy.uppercut-labs.com)
- [Documentation](https://docs.uppercut-labs.com/cappy/)
- [Hosted guidance MCP](https://cappy.uppercut-labs.com/mcp)
- [Readable setup handoff](https://docs.uppercut-labs.com/cappy/guides/setup-cappy.md)

The hosted MCP has four guidance tools, eleven public resources, and a setup
prompt. The local stdio MCP has eleven capture and management tools. Hosted
guidance does not control a visitor's game, OBS, or files.

The docs host delegates only Cappy's namespace through a service binding to
the Cappy Worker. The existing company site and other documentation continue
using their original routes. The integration is merged in
[Uppercut Labs PR 10](https://github.com/uppercut-labs/uppercut-labs-com/pull/10).

## Source and verification

[Cappy PR 6](https://github.com/uppercut-labs/cappy/pull/6) is merged. The
release source is `dd31f21b1bc6d7d63030c6847bef833c6c05d6ea` on `main`.

- Linux, macOS, and Windows CI passed, including installed local MCP version,
  discovery, typed errors, and empty inventory checks.
- The local suite passed 312 tests, with 23 opt-in checks skipped. TypeScript,
  ESLint, the system model, six hosted protocol/HTTP/range tests, and the
  dependency audit passed.
- Production QA passed eight normal viewport checks and six actual Dark Reader
  views across both domains. First-screen agent controls, prompt parity,
  denied-clipboard recovery, keyboard behavior, and reduced motion passed.
- The approved film is 12.000 seconds, 1920x1080, 30 fps, 360 frames, silent.
  Decoded first/last and scene midpoint frames passed review. Production player
  controls, deliberate playback, and exact 6/10.5-second seeks passed on phone
  and desktop. Byte-range requests return HTTP 206 with the requested bytes.

The original artwork is retained in [brand assets](../assets/brand/README.md).
The [Blender builder](../scripts/brand/glass-logo.py) and
[film source](../marketing/video/README.md) reproduce the glass treatment while
keeping the mascot unchanged. Source capture hashes are in the film's
`SOURCES.json`; generated footage and render intermediates remain outside Git.

## Release identity

The [release preparation run](https://github.com/uppercut-labs/cappy/actions/runs/39531658158)
built and verified the exact main-branch artifact for `@uppercut-labs/cappy@1.0.1`.

- npm artifact SHA-256: `35b0e0e61d239cefdc69cab8467ab70a74fa7518b326edc6d78e779f49e05065`
- Film SHA-256: `64247a73c7a8e57ed732e261f4111eda667b46a8a5a0de1446d3ca1b29deb1da`

Published as npm `latest`. The registry tarball matches the prepared artifact byte
for byte and passes isolated normal/global installs, capture/replay fixtures,
cancellation and MCP checks. The scoped one-shot launcher reports `1.0.1`.
The [GitHub release](https://github.com/uppercut-labs/cappy/releases/tag/v1.0.1)
retains the tag, archive, checksum and source manifest.

The superseded `0.2.0` candidate was never published. Its staging record
`2fcfe63c-48c8-4f6f-9428-ea5565dcf5c4` remains visible to the publisher;
the npm rejection endpoint returned HTTP 404 with both npm 11.19.1 and 12.2.0.
Discard that obsolete entry in npm's Staged Packages interface rather than
approving it. It is separate from the verified `1.0.1` release.

## Limits

Capture still requires the configured local game and OBS/FFmpeg. Real OBS
capture on Linux remains unverified. Cancellation promptly stops recording and
game startup; existing FFmpeg finalization/comparison work and probes finish
or reach their configured timeout before server shutdown completes.
