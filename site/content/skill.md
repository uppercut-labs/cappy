# Cappy skill

The npm package includes the Cappy skill, its configuration reference, Godot examples, and troubleshooting. It guides an agent through a first verified capture and the existing CLI.

Install Cappy in your game project:

```bash
npm install --save-dev @uppercut-labs/cappy
```

Copy `node_modules/@uppercut-labs/cappy/.agents/skills/cappy/` to `.agents/skills/cappy/` in your repository. Keep the `references/` folder with `SKILL.md`. Tell your agent to use the Cappy skill; discovery paths depend on the client.

You can also read the [public skill](skill/SKILL.md) directly. An agent can use the [setup guide](https://docs.uppercut-labs.com/cappy/guides/setup-cappy.md) without installing a skill.

The skill covers installation, game integration, diagnostics, scenarios, recording, replay, comparison, timeline export, and cleanup. It does not grant access to your computer or install the CLI automatically. Use [local MCP](mcp.md) when your client needs typed tools for these operations.
