# Cappy

Cappy captures reproducible gameplay sessions from the command line. It can run
authored scenarios, record and replay sessions, coordinate OBS recording, and
produce validated media derivatives with FFmpeg.

## Requirements

- Node.js 24 or newer
- OBS Studio with OBS WebSocket for recording
- FFmpeg and ffprobe for media validation and derivatives
- A configured game and Cappy adapter

Cappy does not install these external tools. The Godot adapter is available from
the versioned source repository.

## Install

```sh
npm install -g @uppercut-labs/cappy
cappy doctor -C /path/to/project
```

Or run once without a global install:

```sh
npx @uppercut-labs/cappy doctor -C /path/to/project
```

Create and configure a project using the instructions in the repository README
before running capture commands.
