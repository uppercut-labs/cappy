# Cappy

Cappy captures reproducible gameplay sessions from the command line. It can run
authored scenarios, record and replay sessions, coordinate OBS recording, and
produce validated media derivatives with FFmpeg.

## Requirements

- Node.js 24 or newer
- OBS Studio with OBS WebSocket for recording
- FFmpeg and ffprobe for media validation and derivatives
- A configured game and Cappy adapter

Cappy does not install these external tools.

## Install

```sh
npm install -g @uppercut-labs/cappy
cappy doctor -C /path/to/project
```

Or run once without a global install:

```sh
npx @uppercut-labs/cappy doctor -C /path/to/project
```

Do not run `npx cappy` without installing this package first: the unscoped
`cappy` name on npm belongs to an unrelated project.

## What the package contains

- `dist/cappy.js`: the `cappy` command.
- `addons/cappy/`: the Godot 4 adapter. Copy it into your game so the game has
  `res://addons/cappy/`, then enable **Cappy** under Project Settings > Plugins.
  Copy it again after upgrading, so the addon matches the CLI.
- `.agents/skills/cappy/`: an agent skill that walks an agent through setup, the
  configuration file, capture, replay, and Cappy's error codes. Point your agent
  at `.agents/skills/cappy/SKILL.md` inside the installed package, or copy the
  folder into your agent's skills directory.

Start with `cappy doctor`, which checks the configuration, workspace, game command,
FFmpeg, and OBS before running capture commands.
