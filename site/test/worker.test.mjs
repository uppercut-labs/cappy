/* global URL, Request, Response */
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'artifacts/qa/worker-test.mjs');
await mkdir(path.dirname(output), { recursive: true });
await build({ entryPoints: [path.join(root, 'site/src/worker.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
const { handleRequest, GUIDES } = await import(pathToFileURL(output));

const assets = {
  async fetch(request) {
    const url = new URL(request.url);
    const file = path.join(root, 'site/dist', url.pathname);
    try {
      return new Response(await readFile(file), { headers: { 'Content-Type': file.endsWith('.md') ? 'text/markdown' : 'text/html' } });
    } catch (error) {
      if (error.code === 'ENOENT') return new Response('Not found', { status: 404 });
      throw error;
    }
  },
};

test('a real SDK HTTP client initializes, searches, reads guides and discovers resources', async () => {
  const client = new Client({ name: 'cappy-guidance-check', version: '1.0.0' });
  let getRequests = 0;
  const transport = new StreamableHTTPClientTransport(new URL('https://cappy.uppercut-labs.com/mcp'), {
    fetch: (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'GET') getRequests += 1;
      return handleRequest(request, assets);
    },
    reconnectionOptions: { initialReconnectionDelay: 20, maxReconnectionDelay: 20, reconnectionDelayGrowFactor: 1, maxRetries: 3 },
  });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['read_guide', 'read_skill', 'search_docs', 'setup_cappy']);
    const search = await client.callTool({ name: 'search_docs', arguments: { query: 'OBS', limit: 3 } });
    assert.equal(search.isError, undefined);
    assert(search.structuredContent.guides.length > 0 && search.structuredContent.guides.length <= 3);
    const empty = await client.callTool({ name: 'search_docs', arguments: { query: 'nonexistent-unique-cappy-term' } });
    assert.deepEqual(empty.structuredContent.guides, []);
    for (const guide of GUIDES) {
      const read = await client.callTool({ name: 'read_guide', arguments: { topic: guide.id } });
      assert.match(read.structuredContent.markdown, /^#/);
      assert.equal(read.structuredContent.url, `https://docs.uppercut-labs.com/cappy/${guide.id}.md`);
    }
    const resources = await client.listResources();
    assert.equal(resources.resources.length, GUIDES.length + 4);
    const resource = await client.readResource({ uri: resources.resources[0].uri });
    assert.match(resource.contents[0].text, /^#/);
    const skill = await client.callTool({ name: 'read_skill', arguments: { reference: 'main' } });
    assert.match(skill.structuredContent.markdown, /## Safety boundary/);
    assert.match(skill.structuredContent.markdown, /## Workflow/);
    const skillResource = await client.readResource({ uri: 'https://docs.uppercut-labs.com/cappy/skill/SKILL.md' });
    assert.equal(skillResource.contents[0].text, skill.structuredContent.markdown);
    for (const reference of ['configuration', 'godot-adapter', 'troubleshooting']) {
      const read = await client.callTool({ name: 'read_skill', arguments: { reference } });
      assert(read.structuredContent.markdown.length > 500);
    }
    const prompts = await client.listPrompts();
    const prompt = await client.getPrompt({ name: prompts.prompts[0].name });
    assert.match(prompt.messages[0].content.text, /\/cappy\/guides\/setup-cappy.md/);
    const hosted = await client.callTool({ name: 'setup_cappy', arguments: { mode: 'hosted' } });
    assert.equal(hosted.structuredContent.server.url, 'https://cappy.uppercut-labs.com/mcp');
    assert.match(hosted.structuredContent.capabilities, /no access/i);
    const invalid = await client.callTool({ name: 'setup_cappy', arguments: { mode: 'local', projectPath: 'relative/game' } });
    assert.equal(invalid.isError, true);
    const local = await client.callTool({ name: 'setup_cappy', arguments: { mode: 'local', projectPath: '/games/example' } });
    assert.deepEqual(local.structuredContent.server.args.slice(-3), ['mcp', '-C', '/games/example']);
    const unknown = await client.callTool({ name: 'read_guide', arguments: { topic: '../../secrets' } });
    assert.equal(unknown.isError, true);
    await delay(120);
    assert(getRequests <= 1, 'unsupported SSE must not trigger a reconnect loop');
  } finally {
    await client.close();
  }
});

test('HTTP boundary enforces body limits, methods and document redirects', async () => {
  const oversized = await handleRequest(new Request('https://cappy.uppercut-labs.com/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: 'x'.repeat(65_537),
  }), assets);
  assert.equal(oversized.status, 413);
  const preflight = await handleRequest(new Request('https://cappy.uppercut-labs.com/mcp', { method: 'OPTIONS' }), assets);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*');
  for (const method of ['GET', 'DELETE']) {
    const unsupported = await handleRequest(new Request('https://cappy.uppercut-labs.com/mcp', { method }), assets);
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.get('Allow'), 'POST, OPTIONS');
  }
  const redirect = await handleRequest(new Request('https://docs.uppercut-labs.com/cappy'), assets);
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('Location'), 'https://docs.uppercut-labs.com/cappy/');
  const denied = await handleRequest(new Request('https://docs.uppercut-labs.com/cappy/cli.md', { method: 'POST' }), assets);
  assert.equal(denied.status, 405);
});
