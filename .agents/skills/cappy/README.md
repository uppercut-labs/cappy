# cappy skill

Helps an agent set up and run Cappy, the reproducible game capture tool: install the Godot addon, write `cappy.config.json` and presets, register scenarios and replay providers, run `doctor`, `scenarios`, `run`, `record`, `replay`, `compare`, `timeline export`, and `clean`, and explain Cappy error codes.

Example: `Use the cappy skill to connect this Godot game to Cappy and capture the boss_intro scenario.`

Outputs: a working configuration, verified captures or replays with their IDs and locations, and an honest list of what was not verified (for example, no OBS or no display).

Requires Node.js 24+, the Cappy npm package (`@uppercut-labs/cappy`), and the game's engine. FFmpeg/ffprobe and OBS Studio 28+ are needed for capture; `doctor`, `scenarios`, and `replay --no-capture` work without OBS. The skill never edits OBS scenes, stores the OBS password, or deletes files without approval.

Install by copying this directory (`SKILL.md`, `references/`, `agents/`) into your agent's skills folder, or point your agent at `node_modules/@uppercut-labs/cappy/.agents/skills/cappy/SKILL.md` once the package is installed. Cappy's test suite keeps the skill's commands, flags, error codes, exit codes, and addon API in sync with the code.

Read [SKILL.md](SKILL.md) for the execution contract.
