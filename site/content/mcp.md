# MCP

Cappy offers a hosted guidance server and a local capture server. They serve different environments.

| | Hosted | Local |
| --- | --- | --- |
| Address | `https://cappy.uppercut-labs.com/mcp` | `cappy mcp -C` followed by your game directory |
| Transport | Streamable HTTP | stdio |
| Requires installation | No | Cappy and Node.js 24+ |
| Retrieves documentation and skill over MCP | Yes | No; skill ships separately in the package |
| Drives your game, OBS, and FFmpeg | No | Yes |
| Accesses your project files | No | The selected project |

## Hosted guidance

Add `https://cappy.uppercut-labs.com/mcp` as a remote MCP server in a compatible agent. No account or token is required. The server supplies documentation, the Cappy skill, setup guidance, and client configuration. It does not connect to your computer, accept OBS passwords, launch games, or record your screen. Agent clients vary in remote MCP support.

For agents without remote MCP, use the [setup guide](https://docs.uppercut-labs.com/cappy/guides/setup-cappy.md) directly or install the [skill](skill.md).

## Local capture tools

The local MCP command is introduced in Cappy 0.2.0. Check the installed version with `npx @uppercut-labs/cappy --version`; 0.1.0 does not include it. Until 0.2.0 is published, use a built source checkout and the CLI launcher described in the repository README.

Install Cappy in the game project:

```bash
npm install --save-dev @uppercut-labs/cappy
```

Configure your agent's stdio server. Replace the sample directory with the absolute path to the game containing `cappy.config.json`:

```json
{
  "mcpServers": {
    "cappy": {
      "command": "npx",
      "args": ["@uppercut-labs/cappy", "mcp", "-C", "/absolute/path/to/game"]
    }
  }
}
```

The exact configuration file and launch environment depend on your MCP client. Provide the OBS password through the server process's environment using the variable named in `obs.passwordEnv`; never put the password in JSON or a copied prompt. Restart or reconnect the client after changing server configuration.

Start with diagnostics and scenario discovery. A real capture requires a visible game, a running OBS instance, a prepared scene, and FFmpeg/ffprobe. The agent should ask you to confirm the scene before its first recording. Cleanup is a preview by default; confirm deletion separately. Local MCP access grants the agent tools that can launch the configured game and write capture artifacts inside the selected project.

## Verify

Connect the server and inspect its tool list. Run diagnostics, inspect any failures, and list the game's registered scenarios. Capture one scenario only after confirming the OBS scene. Check the final result and manifest. A hosted tool response or a successful stdio connection alone does not verify local capture.
