import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const executable = process.argv[2];
const { version } = JSON.parse(await readFile(new URL("../packages/cappy/package.json", import.meta.url), "utf8"));
if (!executable) {
  throw new Error("Usage: node scripts/check-mcp-package.mjs <installed-cappy-executable>");
}
const project = await mkdtemp(path.join(os.tmpdir(), "cappy-installed-mcp-"));
const transport = new StdioClientTransport({ command: process.execPath, args: [executable, "mcp", "-C", project], stderr: "pipe" });
const client = new Client({ name: "cappy-package-check", version: "1.0.0" });
try {
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, version);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 11);
  const missing = await client.callTool({ name: "cappy_doctor", arguments: {} });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error.code, "CONFIG_NOT_FOUND");
  await writeFile(path.join(project, "cappy.config.json"), JSON.stringify({
    schemaVersion: 1, project: { id: "package-check", name: "Package Check" }, game: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    adapter: { port: 0 },
  }));
  const empty = await client.callTool({ name: "cappy_inventory", arguments: {} });
  assert.equal(empty.isError, false);
  assert.deepEqual(empty.structuredContent.data.items, []);
  process.stdout.write("Installed Cappy MCP: initialize, discovery, typed errors, and empty inventory passed.\n");
} finally {
  await client.close();
  await rm(project, { recursive: true, force: true });
}
