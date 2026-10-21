/* global URL, console */
import { cp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { marked } from 'marked';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'site/dist');
const read = (name) => readFile(path.join(root, name), 'utf8');
const write = async (name, text) => {
  const target = path.join(output, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
};
const exists = async (name) => {
  try { await access(path.join(root, name)); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(root, 'site/public'), path.join(output, 'cappy/assets'), { recursive: true });
for (const name of ['cappy.svg', 'cappy-transparent.png', 'cappy-glass-preview.png']) {
  await cp(path.join(root, 'assets/brand', name), path.join(output, 'cappy/assets', name));
}
await cp(path.join(root, '.agents/skills/cappy'), path.join(output, 'cappy/skill'), { recursive: true });
await cp(path.join(root, 'LICENSE'), path.join(output, 'cappy/LICENSE.txt'));
await cp(path.join(root, 'site/THIRD_PARTY_NOTICES.md'), path.join(output, 'cappy/THIRD_PARTY_NOTICES.md'));
const hasFilm = await exists('site/public/cappy-film.mp4');

const setupUrl = 'https://docs.uppercut-labs.com/cappy/guides/setup-cappy.md';
const handoff = `<div class="handoff"><div class="agents" aria-label="Works with Codex, Claude Code, and Cursor">${[['codex', 'Codex'], ['claude-code', 'Claude Code'], ['cursor', 'Cursor']].map(([id, label]) => `<span><img src="/cappy/assets/brands/${id}-white.svg" width="22" height="22" alt="">${label}</span>`).join('')}</div><div class="prompt-actions"><button class="primary" data-copy="setup">Copy setup prompt</button><button class="quiet" id="inspect-prompt">View prompt</button></div><p class="copy-status" role="status" id="copy-status"></p></div>`;
const footer = `<footer><div class="family"><a href="https://uppercut-labs.com">Uppercut Labs</a><a href="https://starter.uppercut-labs.com">Starter Pack</a><a href="https://dvn.pw">dvn.</a></div><div class="footer-links"><a href="https://github.com/uppercut-labs/cappy">GitHub</a><a href="https://www.npmjs.com/package/@uppercut-labs/cappy">npm</a><a href="https://docs.uppercut-labs.com/cappy/">Docs</a><a href="/cappy/LICENSE.txt">MIT License</a><a href="https://github.com/uppercut-labs/cappy/issues">Support</a><a href="/cappy/THIRD_PARTY_NOTICES.md">Credits</a></div></footer>`;
const dialog = `<dialog id="prompt-dialog" aria-labelledby="dialog-title"><div class="dialog-heading"><h2 id="dialog-title">Setup prompt</h2><button class="quiet" id="close-dialog" aria-label="Close prompt">Close</button></div><p id="dialog-status"></p><label for="prompt-text">Prompt</label><textarea id="prompt-text" readonly rows="5"></textarea><p id="prompt-count"></p><div class="prompt-actions"><button class="primary" id="dialog-copy" data-copy="setup">Copy prompt</button><a href="${setupUrl}">Read the guide</a></div></dialog>`;
function shell(title, description, content, canonical, bodyClass = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#090909"><title>${title}</title><meta name="description" content="${description}"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><meta property="og:image" content="https://cappy.uppercut-labs.com/cappy/assets/cappy-glass-preview.png"><meta property="og:type" content="website"><link rel="canonical" href="${canonical}"><link rel="icon" href="/cappy/assets/cappy.svg" type="image/svg+xml"><link rel="stylesheet" href="/cappy/assets/style.css"><link rel="preload" href="/cappy/assets/fonts/geist.woff2" as="font" type="font/woff2" crossorigin><script src="/cappy/assets/site.js" type="module"></script></head><body class="${bodyClass}"><a class="skip" href="#main">Skip to content</a><header><a class="wordmark" href="https://cappy.uppercut-labs.com/" aria-label="Cappy home"><img src="/cappy/assets/cappy-transparent.png" alt="" width="40" height="40">cappy<span>.</span></a><nav aria-label="Main"><a href="https://docs.uppercut-labs.com/cappy/">Docs</a><a href="https://github.com/uppercut-labs/cappy">GitHub</a></nav></header>${content}${footer}${dialog}</body></html>`;
}

const landing = `<main id="main"><section class="hero"><div class="hero-copy"><h1>Reproducible<br>game capture.</h1><p class="lede">Record a session. Replay the same moment. Compare builds and export the footage.</p>${handoff}<a class="install" href="https://www.npmjs.com/package/@uppercut-labs/cappy"><code>npm i -D @uppercut-labs/cappy</code></a></div><figure class="mascot"><img src="/cappy/assets/cappy-transparent.png" alt="Cappy, a movie camera in a purple cap, leaning on a purple C" width="1254" height="1254"></figure></section><section class="showcase" aria-labelledby="film-title"><div class="section-head"><h2 id="film-title">${hasFilm ? 'Cappy in 12 seconds' : 'The Cappy glass treatment'}</h2><a href="https://github.com/uppercut-labs/cappy/tree/main/assets/brand">Brand assets</a></div>${hasFilm ? '<video controls playsinline preload="metadata" poster="/cappy/assets/cappy-glass-preview.png" aria-label="Cappy film: glass logo, game capture, replay, and comparison"><source src="/cappy/assets/cappy-film.mp4" type="video/mp4"></video>' : '<img class="glass-preview" src="/cappy/assets/cappy-glass-preview.png" width="1024" height="1024" alt="The original Cappy mascot presented inside polished purple glass" loading="lazy">'}<p>Authored scenarios, replayable sessions, OBS masters, FFmpeg derivatives, and manifests with artifact hashes.</p></section><section class="interfaces" aria-labelledby="interfaces-title"><h2 id="interfaces-title">Use Cappy</h2><article><h3>CLI</h3><div><code>npx @uppercut-labs/cappy doctor</code><p>Capture, replay, compare, and export from your game project.</p><a href="https://docs.uppercut-labs.com/cappy/cli/">CLI reference</a></div></article><article><h3>Skill</h3><div><p>Setup and operating instructions for your coding agent. Ships in the npm package.</p><a href="https://docs.uppercut-labs.com/cappy/skill/">Install the skill</a></div></article><article><h3>MCP</h3><div><p>Hosted guidance without installation. Local tools to drive your game and OBS.</p><div class="endpoint"><code>https://cappy.uppercut-labs.com/mcp</code><button class="small" data-copy="endpoint">Copy URL</button></div><a href="https://docs.uppercut-labs.com/cappy/mcp/">Connect MCP</a></div></article></section><section class="workflow"><h2>Game adapters</h2><div><p>Your game owns the simulation, cameras, and replay data. Cappy handles launch, recording, derivatives, and storage.</p><p>Godot 4.x addon included. Other engines can implement the same adapter protocol.</p><a href="https://docs.uppercut-labs.com/cappy/getting-started/">Make your first capture</a></div></section></main>`;
await write('index.html', shell('Cappy — Reproducible game capture', 'Capture, replay, and compare game footage with the Cappy CLI, skill, and MCP.', landing, 'https://cappy.uppercut-labs.com/'));

const pages = [
  ['getting-started', 'First capture', 'site/content/first-capture.md'],
  ['cli', 'CLI', 'docs/cli.md'],
  ['godot', 'Godot addon', 'adapters/godot/README.md'],
  ['configuration', 'Configuration', '.agents/skills/cappy/references/configuration.md'],
  ['presets', 'Presets & event anchors', 'docs/presets.md'],
  ['mcp', 'MCP', 'site/content/mcp.md'],
  ['skill', 'Agent skill', 'site/content/skill.md'],
  ['storage', 'Storage & cleanup', 'docs/storage.md'],
  ['troubleshooting', 'Troubleshooting', '.agents/skills/cappy/references/troubleshooting.md'],
  ['protocol', 'Adapter protocol', 'docs/protocol.md'],
  ['acceptance', 'Host acceptance', 'docs/acceptance.md'],
];
const nav = `<aside class="docs-nav"><nav aria-label="Documentation">${pages.map(([slug, label]) => `<a href="/cappy/${slug}/">${label}</a>`).join('')}</nav><a href="https://github.com/uppercut-labs/cappy">View source</a></aside>`;
const linkMap = {
  '../../docs/protocol.md': '/cappy/protocol.md', '../adapters/godot/README.md': '/cappy/godot.md',
  '../README.md': 'https://github.com/uppercut-labs/cappy', '../cappy.config.example.json': 'https://raw.githubusercontent.com/uppercut-labs/cappy/main/cappy.config.example.json',
};
function publicMarkdown(text) {
  return text.replace(/\]\(([^)]+)\)/g, (all, href) => {
    if (linkMap[href]) return `](${linkMap[href]})`;
    if (href.startsWith('https:') || href.startsWith('#') || href.startsWith('/cappy/')) return all;
    if (href === 'skill/SKILL.md') return '](/cappy/skill/SKILL.md)';
    const matching = pages.find(([slug]) => href === `${slug}.md`);
    if (matching) return `](/cappy/${matching[0]}.md)`;
    return `](https://github.com/uppercut-labs/cappy/blob/main/${href.replace(/^(\.\.\/)+/, '')})`;
  }).replace('When the first npm release is available,', '').replace('The tag has not been published yet; with the current checkout, copy', 'For a source checkout, copy');
}
for (const [slug, label, source] of pages) {
  let markdown = publicMarkdown(await read(source));
  if (slug === 'godot') markdown = markdown.replace(/The addon is distributed[\s\S]*?from this repository\./, 'The npm package includes the addon. Install `@uppercut-labs/cappy` in your game project, then copy `node_modules/@uppercut-labs/cappy/addons/cappy/` into your game\'s `addons/` folder. The same source lives in `adapters/godot/addons/cappy/` in the public repository.');
  await write(`cappy/${slug}.md`, markdown);
  const html = marked.parse(markdown).replace(/href="\/cappy\/([^"#]+)\.md(#[^"]*)?"/g, (all, slug, anchor = '') => pages.some(([page]) => page === slug) ? `href="/cappy/${slug}/${anchor}"` : all);
  const body = `<main id="main" class="docs-layout">${nav}<article class="document">${html}<p class="source-link"><a href="/cappy/${slug}.md">Read Markdown</a></p></article></main>`;
  await write(`cappy/${slug}/index.html`, shell(`${label} — Cappy docs`, `${label} for Cappy game capture.`, body, `https://docs.uppercut-labs.com/cappy/${slug}/`, 'docs-page'));
}
const docsHome = `<main id="main"><section class="docs-intro"><img src="/cappy/assets/cappy-transparent.png" alt="" width="100" height="100"><h1>Cappy docs</h1><p class="lede">Set up your game, capture a moment, and replay it.</p>${handoff}</section><div class="docs-layout home-layout">${nav}<article class="document"><h2>Start with one capture</h2><p>Install the npm package, connect your game adapter, and run diagnostics before recording.</p><pre><code>npm install --save-dev @uppercut-labs/cappy<br>npx cappy doctor --json</code></pre><p>Requires Node.js 24+. Captures use OBS Studio 28+ and FFmpeg/ffprobe. The Godot 4.x addon ships in the package.</p><p><a href="/cappy/getting-started/">First capture</a></p><h2>Connect an agent</h2><p>The <a href="/cappy/skill/">skill</a> teaches your agent the CLI. <a href="/cappy/mcp/">Local MCP</a> provides typed capture tools; the hosted MCP serves guidance without accessing your computer.</p><h2>Capture outputs</h2><p>Successful captures hold the master, derivatives, timeline, and a manifest with artifact hashes in your project's <code>.cappy/</code> directory. Takes never overwrite.</p><h2>Host support</h2><p>macOS and Windows have historical real-OBS acceptance. Linux real-OBS capture remains unverified. See <a href="/cappy/acceptance/">host acceptance</a>.</p></article></div></main>`;
await write('cappy/index.html', shell('Cappy docs', 'Installation, CLI, Godot, skills, and MCP for Cappy.', docsHome, 'https://docs.uppercut-labs.com/cappy/', 'docs-page'));
await write('cappy/guides/setup-cappy.md', await read('site/content/setup-cappy.md'));
await write('cappy/llms.txt', `# Cappy\n\nReproducible game capture by Uppercut Labs.\n\n- [Setup guide](${setupUrl})\n${pages.map(([slug, label]) => `- [${label}](https://docs.uppercut-labs.com/cappy/${slug}.md)`).join('\n')}\n- [Skill](https://docs.uppercut-labs.com/cappy/skill/SKILL.md)\n- [Hosted guidance MCP](https://cappy.uppercut-labs.com/mcp)\n- [Source](https://github.com/uppercut-labs/cappy)\n`);
console.log(`Built Cappy landing, ${pages.length + 1} documentation pages, guides, and assets.`);
