# cappy

Cappy is a local developer system for reproducible game capture: authored scenarios, replayable freeform sessions, OBS recording, FFmpeg derivatives, and verifiable capture manifests.

Maintained and published by Uppercut Labs. Created and maintained by Devin Thomas; licensed under MIT.

- Product and domain context: [Context.md](Context.md)
- Implementation specification: [SPEC.md](SPEC.md)
- Uppercut Labs migration plan: [docs/migration-plan.md](docs/migration-plan.md)
- Release preparation and publishing: [docs/releasing.md](docs/releasing.md)
- Architecture decisions: [ADR.md](ADR.md)
- Deferred ideas: [Ideas.md](Ideas.md)
- Living system model: [docs/system-model.dot](docs/system-model.dot)
- Getting started (new project and Godot demo): [docs/getting-started.md](docs/getting-started.md)
- CLI reference: [docs/cli.md](docs/cli.md)
- Managed storage and cleanup: [docs/storage.md](docs/storage.md)
- Capture presets and event anchors: [docs/presets.md](docs/presets.md)
- Host acceptance status: [docs/acceptance.md](docs/acceptance.md)
- Configuration example: [cappy.config.example.json](cappy.config.example.json)
- Adapter protocol reference: [docs/protocol.md](docs/protocol.md)
- Tickets: [tickets/](tickets/)
- Agent skill for using Cappy: [.agents/skills/cappy](.agents/skills/cappy/SKILL.md)

## Status

V1 is implemented. Historical acceptance covers macOS and Windows; Linux acceptance is recorded separately, with real OBS capture on Linux unverified. See [docs/acceptance.md](docs/acceptance.md). The CLI is published on npm as `@uppercut-labs/cappy`.

## Development

Requires Node.js 24 or newer.

```bash
npm install
npm run typecheck   # strict TypeScript for packages and tests
npm run lint
npm test            # Vitest unit and integration suites
```

Supported hosts: macOS and Windows (V1), and Linux (post-V1, with real OBS capture unverified; `scripts/acceptance/linux-container.sh` reruns the Linux acceptance in a container). See [docs/acceptance.md](docs/acceptance.md).

## Using the CLI

Install globally or use the scoped one-shot command:

```bash
npm install --global @uppercut-labs/cappy
cappy doctor -C /path/to/project
npx @uppercut-labs/cappy doctor -C /path/to/project
```

For contributors using this checkout, build the workspace and invoke its launcher explicitly from the repository root. This avoids resolving another package named `cappy` from npm:

```bash
npm run build
node packages/cli/bin/cappy.js doctor              # check config, workspace, game command, FFmpeg/ffprobe, and OBS
node packages/cli/bin/cappy.js scenarios           # launch the game and list the scenarios its adapter registers
node packages/cli/bin/cappy.js doctor --json       # one structured JSON result on stdout
node packages/cli/bin/cappy.js run boss_intro --param difficulty=3 --preset trailer   # capture a scenario with OBS
node packages/cli/bin/cappy.js record              # record a freeform session; Enter stops, Ctrl+C cancels
node packages/cli/bin/cappy.js record --capture    # also record an OBS master
node packages/cli/bin/cappy.js record --duration 30
node packages/cli/bin/cappy.js replay <session-id>              # capture the replay: OBS master, derivatives, manifest
node packages/cli/bin/cappy.js replay <session-id> --no-capture # only play it back
node packages/cli/bin/cappy.js run boss_intro --take 3          # explicit take; never overwrites an existing one
node packages/cli/bin/cappy.js run boss_intro -pa difficulty=3 -p trailer -j   # every flag has a whole-token shorthand
node packages/cli/bin/cappy.js compare <capture-a> <capture-b> --min-ssim 0.97  # triptych video + SSIM/PSNR; exit 1 if regressed
node packages/cli/bin/cappy.js compare-builds <session-id> v1 v2 -rse           # replay one session on two named builds and compare
node packages/cli/bin/cappy.js timeline export <capture-id> -fo vtt -o events.vtt  # event captions for the capture's video (also json, csv)
node packages/cli/bin/cappy.js clean --failed --dry-run         # preview removing failed and interrupted leftovers
node packages/cli/bin/cappy.js clean cap_…                      # remove a capture; its take number is never reissued
```

Shorthands use initials for multi-word flags (`-nc` is `--no-capture`) and are never grouped; [docs/cli.md](docs/cli.md#shorthands) lists them all.

Every `record`, `run`, `replay`, and `compare` writes `logs/<correlation-id>.jsonl` in the managed workspace; the same correlation ID appears in the command's JSON result, sessions, manifest, and timeline events.

Exit codes: 0 success, 1 operation failed, 2 invalid usage, 3 configuration, 4 missing dependency, 70 internal error, 130 cancelled.

A capture preset lists the derivatives FFmpeg makes from the verified master. Times can be fixed seconds or event anchors on the capture's timeline, as described in [docs/presets.md](docs/presets.md):

```json
"presets": {
  "trailer": {
    "scene": "Capture",
    "derivatives": [
      { "kind": "mp4", "role": "delivery" },
      { "kind": "clip", "role": "highlight", "options": { "start": 2, "duration": 5 } },
      { "kind": "clip", "role": "moment", "options": { "start": { "event": "SPELL_CAST", "offset": -2 }, "end": { "event": "IMPACT", "offset": 1 } } },
      { "kind": "thumbnail", "role": "thumb", "options": { "at": 3 } },
      { "kind": "still", "role": "impact", "required": false, "options": { "at": { "event": "IMPACT" } } }
    ]
  }
}
```

Each successful `cappy run` leaves `captures/<capture-id>/` with the master, its derivatives, and `manifest.json`, which records identity, take, tool versions, timing, timeline, and the SHA-256 and size of every artifact.

The OBS WebSocket password is never stored in config. Set `obs.passwordEnv` to the name of an environment variable and export the password there.

Opt-in smoke tests against real tools:

```bash
CAPPY_REAL_TOOLS=1 npm test                          # FFmpeg/ffprobe and Godot 4.x on PATH
CAPPY_OBS_SMOKE=1 CAPPY_OBS_SCENE=Capture npm test   # a running OBS with WebSocket enabled
npm run model:check                                  # validate docs/system-model.dot (Graphviz via WebAssembly)
```

## Godot

The Godot addon lives in [adapters/godot](adapters/godot/README.md). `npm run godot:demo` assembles the demo fixture with the addon into `.godot-demo/`.

## Packages

| Package | Purpose |
| --- | --- |
| `@uppercut-labs/cappy` | Public npm distribution package for the `cappy` CLI. |
| `@uppercut-labs/cappy-internal-core` | Private engine-neutral contracts, config schema and loader, structured errors, and CLI result envelope. |
| `@uppercut-labs/cappy-internal-workspace` | Private managed `.cappy/` workspace, ownership registry, atomic writes, hashing, and safe cleanup. |
| `@uppercut-labs/cappy-internal-protocol` | Private versioned loopback WebSocket protocol, schemas, negotiation, operation state, and heartbeats. |
| `@uppercut-labs/cappy-fixture-adapter-simulator` (`fixtures/`) | Private deterministic protocol-speaking acceptance fixture. |
| `@uppercut-labs/cappy-internal-obs` | Private OBS WebSocket v5 client and recorder. |
| `@uppercut-labs/cappy-internal-media` | Private FFmpeg/ffprobe discovery, derivatives, event anchors, and capture comparison. |
| `@uppercut-labs/cappy-internal-cli` | Private CLI implementation used to build the public executable. |
| `@uppercut-labs/cappy-fixture-fake-obs` (`fixtures/`) | Private fake OBS WebSocket v5 server for automated tests. |
