# cappy

Cappy is a local developer system for reproducible game capture: authored scenarios, replayable freeform sessions, OBS recording, FFmpeg derivatives, and verifiable capture manifests.

- Product and domain context: [Context.md](Context.md)
- Implementation specification: [SPEC.md](SPEC.md)
- Architecture decisions: [ADR.md](ADR.md)
- Deferred ideas: [Ideas.md](Ideas.md)
- Living system model: [docs/system-model.dot](docs/system-model.dot)
- Getting started (new project and Godot demo): [docs/getting-started.md](docs/getting-started.md)
- CLI reference: [docs/cli.md](docs/cli.md)
- Managed storage and cleanup: [docs/storage.md](docs/storage.md)
- Host acceptance status: [docs/acceptance.md](docs/acceptance.md)
- Configuration example: [cappy.config.example.json](cappy.config.example.json)
- Adapter protocol reference: [docs/protocol.md](docs/protocol.md)
- Tickets: [tickets/](tickets/)

## Status

V1 is implemented and accepted on macOS and Windows, including real OBS, FFmpeg, and Godot captures; see [docs/acceptance.md](docs/acceptance.md) for the evidence.

## Development

Requires Node.js 24 or newer.

```bash
npm install
npm run typecheck   # strict TypeScript for packages and tests
npm run lint
npm test            # Vitest unit and integration suites
```

## Using the CLI

Build once, then run `npx cappy` from a project directory that contains `cappy.config.json` (or pass `-C <dir>`):

```bash
npm run build
npx cappy doctor              # check config, workspace, game command, FFmpeg/ffprobe, and OBS
npx cappy scenarios           # launch the game and list the scenarios its adapter registers
npx cappy doctor --json       # one structured JSON result on stdout
npx cappy run boss_intro --param difficulty=3 --preset trailer   # capture a scenario with OBS
npx cappy record              # record a freeform session; Enter stops, Ctrl+C cancels
npx cappy record --capture    # also record an OBS master
npx cappy record --duration 30
npx cappy replay <session-id>              # capture the replay: OBS master, derivatives, manifest
npx cappy replay <session-id> --no-capture # only play it back
npx cappy run boss_intro --take 3          # explicit take; never overwrites an existing one
```

Every `record`, `run`, and `replay` writes `logs/<correlation-id>.jsonl` in the managed workspace; the same correlation ID appears in the command's JSON result, sessions, manifest, and timeline events.

Exit codes: 0 success, 1 operation failed, 2 invalid usage, 3 configuration, 4 missing dependency, 70 internal error, 130 cancelled.

A capture preset lists the derivatives FFmpeg makes from the verified master:

```json
"presets": {
  "trailer": {
    "scene": "Capture",
    "derivatives": [
      { "kind": "mp4", "role": "delivery" },
      { "kind": "clip", "role": "highlight", "options": { "start": 2, "duration": 5 } },
      { "kind": "thumbnail", "role": "thumb", "options": { "at": 3 } },
      { "kind": "still", "role": "poster", "required": false }
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
| `@cappy/core` | Engine-neutral domain contracts, configuration schema and loader, structured errors, and the CLI result envelope. |
| `@cappy/workspace` | Managed `.cappy/` workspace: storage areas, ownership registry, atomic writes, hashing, safe cleanup, and the Git-ignore warning. |
| `@cappy/protocol` | Versioned loopback WebSocket protocol: message schemas, handshake and capability negotiation, operation state, heartbeats. |
| `@cappy/adapter-simulator` (`fixtures/`) | Deterministic protocol-speaking adapter used as an acceptance fixture. |
| `@cappy/obs` | OBS WebSocket v5 client and recorder: password authentication, the doctor probe, confirmed start/stop, and master verification. |
| `@cappy/media` | FFmpeg/ffprobe discovery, ffprobe validation, and atomic derivative production. |
| `@cappy/cli` | The `cappy` command: argument parsing, human and `--json` output, `doctor`, `scenarios`, and game launch. |
| `@cappy/fake-obs` (`fixtures/`) | Fake OBS WebSocket v5 server for automated tests. |
