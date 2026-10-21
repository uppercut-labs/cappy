/* global process, document, innerWidth, innerHeight, getComputedStyle, navigator, URL, chrome, matchMedia, console */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

// Keep browser profiles, screenshots, and the actual extension outside Git.
const origin = process.env.CAPPY_QA_ORIGIN || 'http://localhost:4178';
const docsOrigin = process.env.CAPPY_DOCS_QA_ORIGIN || origin;
const output = process.env.CAPPY_QA_OUTPUT || path.join(tmpdir(), 'cappy-site-qa');
const extension = process.env.DARK_READER_PATH;
if (!extension) throw new Error('Set DARK_READER_PATH to an unpacked genuine Dark Reader extension.');
const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
assert.equal(manifest.name, 'Dark Reader');
await mkdir(output, { recursive: true });
const result = { extension: { name: manifest.name, version: manifest.version }, baseline: [], transformed: [], pageErrors: [] };
const viewports = [{ width: 320, height: 667 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1440, height: 1000 }];
const routes = ['/', '/cappy/'];
const profile = await mkdtemp(path.join(tmpdir(), 'cappy-qa-profile-'));
const browser = await chromium.launch({ headless: true });
const normal = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const page = await normal.newPage();
page.on('pageerror', (error) => result.pageErrors.push(error.message));

async function measure(target, route, viewport, transformed) {
  await target.setViewportSize(viewport);
  await target.goto((route === '/cappy/' ? docsOrigin : origin) + route, { waitUntil: 'networkidle' });
  await target.evaluate(() => document.fonts.ready);
  const measurements = await target.evaluate(() => {
    const button = document.querySelector('[data-copy="setup"]');
    return {
      width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      button: button.getBoundingClientRect().toJSON(),
      headingColor: getComputedStyle(document.querySelector('h1')).color,
      buttonBackground: getComputedStyle(button).backgroundColor,
      background: getComputedStyle(document.documentElement).backgroundColor,
      styles: document.querySelectorAll('style.darkreader').length,
      logos: [...document.querySelectorAll('.agents span')].map((item) => ({ name: item.textContent, loaded: item.querySelector('img').naturalWidth > 0, bottom: item.getBoundingClientRect().bottom })),
    };
  });
  assert(measurements.scrollWidth <= viewport.width, `Overflow: ${route} ${viewport.width}`);
  assert(measurements.button.bottom <= viewport.height, `Prompt below fold: ${route}`);
  assert(measurements.logos.every((logo) => logo.loaded && logo.bottom <= viewport.height));
  assert.deepEqual(measurements.logos.map((logo) => logo.name), ['Codex', 'Claude Code', 'Cursor']);
  if (transformed) assert(measurements.styles > 0);
  const slug = route === '/' ? 'landing' : 'docs';
  await target.screenshot({ path: path.join(output, `${slug}-${viewport.width}${transformed ? '-dark-reader' : ''}.png`) });
  return { route, ...measurements };
}

try {
  for (const route of routes) for (const viewport of viewports) result.baseline.push(await measure(page, route, viewport, false));
  await page.goto(origin);
  await page.locator('[data-copy="setup"]').first().click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  await page.locator('#inspect-prompt').click();
  assert.equal(clipboard, await page.locator('#prompt-text').inputValue());
  assert(clipboard.length <= 300 && clipboard.split(/\s+/).length <= 40);
  await page.locator('#close-dialog').click();
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Clipboard denied by QA'); }; });
  await page.locator('[data-copy="setup"]').first().click();
  assert(await page.locator('#prompt-dialog').evaluate((element) => element.open));
  assert(await page.locator('#prompt-text').evaluate((element) => element === document.activeElement && element.selectionStart === 0 && element.selectionEnd === element.value.length));
  assert.equal(await page.locator('#dialog-status').textContent(), 'Copy the selected text manually.');
  assert.equal(await page.locator('#dialog-copy').textContent(), 'Copy prompt');
  await page.keyboard.press('Escape');
  assert(await page.locator('[data-copy="setup"]').first().evaluate((element) => element === document.activeElement));
  result.clipboardParity = true;
  result.clipboardDenialRecovery = true;
  await browser.close();

  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20000 });
    result.extension.runtimeId = new URL(worker.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${result.extension.runtimeId}/ui/popup/index.html`);
    const settings = await popup.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: 'ui-bg-change-settings', data: { enabled: true, enabledByDefault: true, detectDarkTheme: false, automation: { enabled: false, mode: '', behavior: 'OnOff' } } });
      return chrome.runtime.sendMessage({ type: 'ui-bg-get-data' });
    });
    assert((settings.data ?? settings).settings.enabled);
    const dark = await context.newPage();
    dark.on('pageerror', (error) => result.pageErrors.push(error.message));
    for (const route of routes) for (const viewport of viewports.filter((item) => item.width !== 768)) {
      const measurement = await measure(dark, route, viewport, true);
      const before = result.baseline.find((item) => item.route === route && item.width === viewport.width);
      assert(measurement.background !== before.background || measurement.headingColor !== before.headingColor || measurement.buttonBackground !== before.buttonBackground, 'Dark Reader did not transform the actual target page');
      result.transformed.push(measurement);
      await dark.locator('#inspect-prompt').click();
      await dark.screenshot({ path: path.join(output, `${route === '/' ? 'landing' : 'docs'}-${viewport.width}-dark-reader-dialog.png`) });
      await dark.keyboard.press('Escape');
    }
    await dark.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await dark.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    result.reducedMotion = true;
  } finally { await context.close(); }
  assert.deepEqual(result.pageErrors, []);
  await writeFile(path.join(output, 'qa-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`Cappy QA passed: ${result.baseline.length} normal and ${result.transformed.length} actual Dark Reader views; clipboard, recovery, keyboard, reduced motion.`);
} finally {
  await browser.close();
  await rm(profile, { recursive: true, force: true });
}
