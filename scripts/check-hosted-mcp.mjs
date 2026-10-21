import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = new URL(process.argv[2] ?? "https://cappy.uppercut-labs.com/mcp");
const { version } = JSON.parse(await readFile(new URL("../packages/cappy/package.json", import.meta.url), "utf8"));
const client = new Client({ name: "cappy-live-check", version: "1.0.0" });
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  assert.equal(client.getServerVersion().version, version);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["read_guide", "read_skill", "search_docs", "setup_cappy"]);
  const guide = await client.callTool({ name: "read_guide", arguments: { topic: "getting-started" } });
  assert.match(guide.structuredContent.markdown, /Cappy/);
  const skill = await client.callTool({ name: "read_skill", arguments: { reference: "main" } });
  assert.match(skill.structuredContent.markdown, /## Safety boundary/);
  const setup = await client.callTool({ name: "setup_cappy", arguments: { mode: "hosted" } });
  assert.equal(setup.structuredContent.server.url, "https://cappy.uppercut-labs.com/mcp");
  const { resources } = await client.listResources();
  assert.equal(resources.length, 11);
  process.stdout.write(JSON.stringify({ endpoint: endpoint.href, version, tools: tools.length, resources: resources.length, guide: "passed", fullSkill: "passed", setup: "passed" }, null, 2) + "\n");
} finally {
  await client.close();
}
