# cappy

Cappy is a local developer system for reproducible game capture: authored scenarios, replayable freeform sessions, OBS recording, FFmpeg derivatives, and verifiable capture manifests.

- Product and domain context: [Context.md](Context.md)
- Implementation specification: [SPEC.md](SPEC.md)
- Architecture decisions: [ADR.md](ADR.md)
- Deferred ideas: [Ideas.md](Ideas.md)
- Living system model: [docs/system-model.dot](docs/system-model.dot)
- Tickets: [tickets/](tickets/)

## Development

Requires Node.js 24 or newer.

```bash
npm install
npm run typecheck   # strict TypeScript for packages and tests
npm run lint
npm test            # Vitest unit and integration suites
```

## Packages

| Package | Purpose |
| --- | --- |
| `@cappy/core` | Engine-neutral domain contracts, configuration schema and loader, structured errors, and the CLI result envelope. |
