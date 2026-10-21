# Set up Cappy in this game

Help the visitor reach one verified capture, or one verified replay if OBS is unavailable. Inspect their repository instructions, game engine, package manager, and existing Cappy configuration before changing anything. Preserve unrelated work.

## Install and connect

1. Check Node.js 24 or newer. Install the scoped package `@uppercut-labs/cappy` as a development dependency using the project's package manager. Never download the unrelated unscoped `cappy` package. Use `npx @uppercut-labs/cappy` for a one-shot command.
2. Read [getting started](https://docs.uppercut-labs.com/cappy/getting-started.md). For Godot 4.x, copy `node_modules/@uppercut-labs/cappy/addons/cappy/` into the game's `addons/cappy/` and enable the Cappy plugin. Register a scenario or replay provider using the [Godot guide](https://docs.uppercut-labs.com/cappy/godot.md).
3. Write `cappy.config.json` using the game's actual launch command. Keep OBS passwords in the environment variable named by `obs.passwordEnv`. Add `.cappy/` to the game's ignore file.
4. Run `npx cappy doctor --json`, then `npx cappy scenarios --json`, from the game project. Resolve configuration errors before capture.

Do not install system tools or modify OBS scenes without the visitor's permission. Ask the visitor to prepare an OBS scene containing only the intended game before the first capture. Do not print secrets.

## Choose an agent interface

The package includes `.agents/skills/cappy/` with operational instructions and references. Copy that folder into the visitor's repository when they want the skill installed there. For typed local tools, configure the agent's stdio MCP server to run `cappy mcp -C` with the game's absolute directory as its next argument. See [MCP setup](https://docs.uppercut-labs.com/cappy/mcp.md) for release availability and the hosted guidance alternative.

## Verify completion

Run one registered scenario with `npx cappy run` using its real name and parameters, or record a bounded freeform session and replay it. Read structured results rather than inferring success from filenames. A successful capture has `data.state: succeeded`, a verified master, and `.cappy/captures/<capture-id>/manifest.json` with artifact hashes. Without OBS, verify `replay --no-capture` and explicitly report capture as unverified.

Report the Cappy version, host, checks run, capture or session ID, output paths relative to the project, and any remaining dependency or host limitation. Do not delete captures; use `clean --dry-run` and obtain approval before deletion. Existing visitor authorization governs external actions.
