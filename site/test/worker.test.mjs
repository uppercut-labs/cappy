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
  const redirect = await handleRequest(new Request('https://docs.uppercut-labs.com/cappy?ref=agent'), assets);
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('Location'), 'https://docs.uppercut-labs.com/cappy/?ref=agent');
  const denied = await handleRequest(new Request('https://docs.uppercut-labs.com/cappy/cli.md', { method: 'POST' }), assets);
  assert.equal(denied.status, 405);
});

test('the film serves exact byte ranges, full HEAD metadata and bounded suffixes', async () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const forwarded = [];
  const filmAssets = { fetch: async request => {
    forwarded.push(request);
    return new Response(bytes, { headers: { 'Content-Type': 'video/mp4', ETag: '"film-v1"', 'Last-Modified': 'Tue, 20 Oct 2026 12:00:00 GMT' } });
  } };
  const film = (headers = {}, method = 'GET') => handleRequest(new Request('https://cappy.uppercut-labs.com/cappy/assets/cappy-film.mp4?rev=1', { method, headers }), filmAssets);
  const full = await film();
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('Content-Type'), 'video/mp4');
  assert.equal(full.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(full.headers.get('Content-Length'), '10');
  assert.equal(full.headers.get('Content-Range'), null);
  assert.deepEqual(new Uint8Array(await full.arrayBuffer()), bytes);
  for (const [range, expected, contentRange] of [
    ['bytes=2-5', [2, 3, 4, 5], 'bytes 2-5/10'],
    ['bytes=7-', [7, 8, 9], 'bytes 7-9/10'],
    ['bytes=-3', [7, 8, 9], 'bytes 7-9/10'],
    ['bytes=8-9999999999999999999999999', [8, 9], 'bytes 8-9/10'],
    ['bytes=-9999999999999999999999999', [...bytes], 'bytes 0-9/10'],
  ]) {
    const response = await film({ Range: range });
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get('Content-Range'), contentRange);
    assert.equal(response.headers.get('Content-Length'), String(expected.length));
    assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], expected);
    assert.equal(forwarded.at(-1).method, 'GET');
    assert.equal(forwarded.at(-1).headers.get('Range'), null);
    assert.equal(forwarded.at(-1).url, 'https://cappy.uppercut-labs.com/cappy/assets/cappy-film.mp4?rev=1');
  }
  const head = await film({ Range: 'bytes=2-5' }, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), '10');
  assert.equal(head.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(head.headers.get('Content-Range'), null);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('film range validation returns 416 or ignores unsupported syntax without changing bytes', async () => {
  const filmAssets = { fetch: async () => new Response(new Uint8Array([10, 20, 30]), { headers: { 'Content-Type': 'video/mp4' } }) };
  for (const range of ['bytes=3-', 'bytes=20-30', 'bytes=-0', 'bytes=2-1']) {
    const response = await handleRequest(new Request('https://cappy.uppercut-labs.com/cappy/assets/cappy-film.mp4', { headers: { Range: range } }), filmAssets);
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('Content-Range'), 'bytes */3');
    assert.equal(response.headers.get('Content-Length'), '0');
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
  for (const range of ['bytes=0-1,2-2', 'items=0-1', 'bytes=hello', 'bytes=-', 'bytes=0.5-2']) {
    const response = await handleRequest(new Request('https://cappy.uppercut-labs.com/cappy/assets/cappy-film.mp4', { headers: { Range: range } }), filmAssets);
    assert.equal(response.status, 200, range);
    assert.equal(response.headers.get('Content-Range'), null);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [10, 20, 30]);
  }
});

test('film If-Range requires the matching strong ETag or exact modification date', async () => {
  const modified = 'Tue, 20 Oct 2026 12:00:00 GMT';
  const filmAssets = { fetch: async request => {
    assert.equal(request.headers.get('If-Range'), null);
    return new Response(new Uint8Array([10, 20, 30]), { headers: { ETag: '"film-v1"', 'Last-Modified': modified } });
  } };
  for (const [validator, status, expected] of [
    ['"film-v1"', 206, [20]], [modified, 206, [20]],
    ['"film-v0"', 200, [10, 20, 30]], ['W/"film-v1"', 200, [10, 20, 30]],
    ['Mon, 19 Oct 2026 12:00:00 GMT', 200, [10, 20, 30]], ['invalid', 200, [10, 20, 30]],
  ]) {
    const response = await handleRequest(new Request('https://cappy.uppercut-labs.com/cappy/assets/cappy-film.mp4', { headers: { Range: 'bytes=1-1', 'If-Range': validator } }), filmAssets);
    assert.equal(response.status, status, validator);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], expected);
  }
});

test('film adapter is exact, preserves missing assets and rejects oversized owned files', async () => {
  const request = new Request('https://cappy.uppercut-labs.com/cappy/assets/cappy-film.mp4', { headers: { Range: 'bytes=0-1' } });
  const missing = await handleRequest(request, { fetch: async () => new Response('Missing', { status: 404 }) });
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), 'Missing');
  const oversized = await handleRequest(request, { fetch: async () => new Response('Not buffered', { headers: { 'Content-Length': String(25 * 1024 * 1024 + 1) } }) });
  assert.equal(oversized.status, 502);
  const empty = await handleRequest(request, { fetch: async () => new Response(new Uint8Array()) });
  assert.equal(empty.status, 416);
  assert.equal(empty.headers.get('Content-Range'), 'bytes */0');
  const untouched = await handleRequest(new Request('https://cappy.uppercut-labs.com/cappy/assets/other.mp4', { headers: { Range: 'bytes=0-1' } }), { fetch: async upstream => {
    assert.equal(upstream.headers.get('Range'), 'bytes=0-1');
    return new Response('Existing asset');
  } });
  assert.equal(await untouched.text(), 'Existing asset');
});
