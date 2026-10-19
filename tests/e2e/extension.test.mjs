/*
 * Integration tests — a real Chromium with the extension loaded.
 *   - extension load is verified through CDP /json/list (service_worker target)
 *   - the content script's POM check is driven from the service worker
 *   - the DevTools panel UI is exercised by opening panel.html?tabId=<n> as a tab
 *     (Playwright cannot attach to the DevTools window itself)
 *   - server-down path: the panel must degrade to read-only, not break
 * Needs the POM server on its fixed port 4777 (what background.js talks to).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchWithExtension } from '../../scripts/lib/browser.mjs';
import { serveFixtures, tmpPomDir, startPomServer, fixturePom } from '../helpers.mjs';

const POM_PORT = 4777;
let fixtures, pomDir, pomServer, ctx, page;

before(async () => {
  fixtures = await serveFixtures();
  pomDir = await tmpPomDir([fixturePom(fixtures.url)]);
  pomServer = await startPomServer({ pomDir, port: POM_PORT }).catch((e) => {
    throw new Error(`POM server could not bind 127.0.0.1:${POM_PORT} (${e.code}) — stop whatever uses it and rerun`);
  });
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'selector-cockpit-profile-'));
  ctx = await launchWithExtension({ userDataDir, headless: true });
  page = await ctx.context.newPage();
  await page.goto(fixtures.url + '/page.html');
  await page.waitForSelector('html[data-selector-cockpit-ready]', { state: 'attached' });
});

after(async () => {
  await ctx?.context.close();
  await pomServer?.close();
  await fixtures?.close();
});

const tabIdOf = async (url) => {
  const id = await ctx.worker.evaluate((u) => self.selectorCockpit.findTab(u), url);
  assert.ok(id, 'tab not found for ' + url);
  return id;
};
const toTab = async (msg) => ctx.worker.evaluate(({ id, m }) => self.selectorCockpit.sendToTab(id, m), { id: await tabIdOf(fixtures.url + '/page.html'), m: msg });

test('extension service worker is visible in CDP /json/list', () => {
  assert.equal(ctx.cdp.ok, true);
  assert.equal(ctx.cdp.target.type, 'service_worker');
  assert.match(ctx.cdp.target.url, /^chrome-extension:\/\/[a-p]{32}\/background\.js$/);
});

test('content script answers ping and counts POM selectors on the live page', async () => {
  const ping = await toTab({ type: 'ping' });
  assert.equal(ping.ok, true);
  assert.equal(ping.title, 'Fixture');

  const res = await toTab({ type: 'checkPom', page: fixturePom(fixtures.url) });
  assert.equal(res.ok, true);
  assert.deepEqual(res.results.map((r) => [r.name, r.count, r.status]), [
    ['username', 1, 'ok'], ['password', 1, 'ok'], ['loginButton', 1, 'ok'], ['anyLink', 3, 'ambiguous'],
    ['closeButton', 1, 'ok'], ['gone', 0, 'missing'], ['broken', 0, 'invalid'],
  ]);
  assert.deepEqual(res.summary, { total: 7, ok: 4, missing: 1, ambiguous: 1, invalid: 1 });

  // one highlight box per matched element (4 ok + 3 ambiguous), labelled name ×count
  const labels = await page.evaluate(() => [...document.getElementById('selector-cockpit-overlay').shadowRoot.querySelectorAll('span')].map((e) => e.textContent).sort());
  assert.deepEqual(labels, ['anyLink ×3', 'anyLink ×3', 'anyLink ×3', 'closeButton ×1', 'loginButton ×1', 'password ×1', 'username ×1']);
  // overlay nodes must not pollute counts: the page itself has 3 <span>, 2 <div>, 29 elements,
  // and structural selectors still see <body> as the last child of <html>
  const counts = (await toTab({ type: 'countSelectors', selectors: ['span', 'div', '*', 'body:last-child', 'html > :last-child'] })).results.map((r) => r.count);
  assert.deepEqual(counts, [3, 2, 29, 1, 1]);

  // highlight boxes follow the element when the page scrolls
  await page.setViewportSize({ width: 800, height: 200 });
  await page.evaluate(() => window.scrollTo(0, 120));
  // the scroll event (and thus repositioning) is dispatched on the next frame — wait for it
  const boxVsElement = await page.waitForFunction(() => {
    const el = document.querySelector('#user');
    const box = [...document.getElementById('selector-cockpit-overlay').shadowRoot.children].find((b) => b.textContent === 'username ×1');
    const r = { boxTop: Math.round(parseFloat(box.style.top)), elTop: Math.round(el.getBoundingClientRect().top) };
    return r.boxTop === r.elTop ? r : null;
  }, null, { timeout: 3000 });
  const { boxTop, elTop } = await boxVsElement.jsonValue();
  assert.equal(boxTop, elTop);
  assert.ok(elTop < 0, 'element scrolled out of view: ' + elTop);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('inspect mode: hovering shows a tooltip with candidates and their counts', async () => {
  await toTab({ type: 'setInspect', on: true });
  await page.hover('a.link >> nth=2');
  await page.waitForFunction(() => document.getElementById('selector-cockpit-overlay')?.shadowRoot.textContent.includes('css-path'));
  const tip = await page.evaluate(() => [...document.getElementById('selector-cockpit-overlay').shadowRoot.querySelectorAll('div div')].map((e) => e.textContent));
  assert.ok(tip.some((l) => l.startsWith('!') && l.includes('role') && l.includes('×2')), tip.join('\n'));
  assert.ok(tip.some((l) => l.startsWith('✓') && l.includes('css-path') && l.includes('×1')), tip.join('\n'));
  await toTab({ type: 'clear' });
  const visible = await page.evaluate(() => [...document.getElementById('selector-cockpit-overlay').shadowRoot.children].filter((e) => e.style.display !== 'none').length);
  assert.equal(visible, 0);
});

test('panel: online badge, auto-selected page, status table, pick → add → saved to server', async () => {
  const tabId = await tabIdOf(fixtures.url + '/page.html');
  const panel = await ctx.context.newPage();
  await panel.goto(`chrome-extension://${ctx.extensionId}/panel.html?tabId=${tabId}`);
  await panel.waitForSelector('#server-badge.online');
  assert.equal(await panel.inputValue('#page-select'), 'fixture');
  await panel.waitForSelector('#pom-table tbody tr');
  const rows = await panel.$$eval('#pom-table tbody tr', (trs) => trs.map((tr) => [tr.className, tr.children[0].textContent, tr.children[2].textContent]));
  assert.deepEqual(rows, [
    ['ok', 'username', '1'], ['ok', 'password', '1'], ['ok', 'loginButton', '1'], ['ambiguous', 'anyLink', '3'],
    ['ok', 'closeButton', '1'], ['missing', 'gone', '0'], ['invalid', 'broken', '0'],
  ]);
  assert.match(await panel.textContent('#summary'), /ok 4 · missing 1 · ambiguous 1 · invalid 1/);

  // selecting "(none)" clears stale rows; re-selecting the page re-checks
  await panel.selectOption('#page-select', '');
  assert.equal(await panel.$$eval('#pom-table tbody tr', (trs) => trs.length), 0);
  assert.equal(await panel.textContent('#summary'), 'no POM page selected');
  await panel.selectOption('#page-select', 'fixture');
  await panel.waitForSelector('#pom-table tbody tr');
  // a check that cannot reach the content script leaves no results behind
  const bogus = await ctx.context.newPage();
  await bogus.goto(`chrome-extension://${ctx.extensionId}/panel.html?tabId=999999`);
  await bogus.waitForSelector('#server-badge.online');
  await bogus.selectOption('#page-select', 'fixture');
  await bogus.waitForFunction(() => document.getElementById('summary').textContent === 'check failed — no results');
  assert.equal(await bogus.$$eval('#pom-table tbody tr', (trs) => trs.length), 0);
  await bogus.close();

  await panel.click('#btn-pick');
  await page.bringToFront();
  await page.click('[data-testid="card"] span');
  await panel.bringToFront();
  await panel.waitForSelector('#pick-box:not(.hidden)');
  const cands = await panel.$$eval('#pick-candidates label', (ls) => ls.map((l) => l.textContent.trim()));
  assert.ok(cands.some((c) => c.includes('text=Card A') && c.includes('×1')), cands.join('\n'));
  await panel.fill('#pick-name', 'cardA');
  await panel.click('#btn-add');
  await panel.waitForFunction(() => [...document.querySelectorAll('#pom-table tbody tr td:first-child')].some((td) => td.textContent === 'cardA'));

  const saved = JSON.parse(await fs.readFile(path.join(pomDir, 'fixture.json'), 'utf8'));
  assert.equal(saved.elements.cardA, 'text=Card A'); // first unique candidate is preselected
  await panel.close();
});

test('server goes down while the panel is open: add fails visibly and the panel flips to read-only', async () => {
  const tabId = await tabIdOf(fixtures.url + '/page.html');
  const panel = await ctx.context.newPage();
  await panel.goto(`chrome-extension://${ctx.extensionId}/panel.html?tabId=${tabId}`);
  await panel.waitForSelector('#server-badge.online');
  await pomServer.close();
  pomServer = null;
  await panel.click('#btn-pick');
  await page.bringToFront();
  await page.click('#list li >> nth=0');
  await panel.bringToFront();
  await panel.waitForSelector('#pick-box:not(.hidden)');
  await panel.fill('#pick-name', 'firstItem');
  await panel.click('#btn-add');
  await panel.waitForSelector('#server-badge.offline');
  assert.match(await panel.textContent('#log'), /add failed: server unreachable/);
  assert.equal(await panel.isDisabled('#btn-add'), true);
  assert.equal(JSON.parse(await fs.readFile(path.join(pomDir, 'fixture.json'), 'utf8')).elements.firstItem, undefined);
  await panel.close();
});

test('server down at panel open: read-only mode (offline badge, add disabled, file load still checks)', async () => {
  const tabId = await tabIdOf(fixtures.url + '/page.html');
  const panel = await ctx.context.newPage();
  await panel.goto(`chrome-extension://${ctx.extensionId}/panel.html?tabId=${tabId}`);
  await panel.waitForSelector('#server-badge.offline');
  assert.equal(await panel.isDisabled('#btn-add'), true);
  await panel.setInputFiles('#file-input', {
    name: 'pom.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixturePom(fixtures.url))),
  });
  await panel.waitForSelector('#pom-table tbody tr');
  assert.match(await panel.textContent('#summary'), /ok 4 · missing 1 · ambiguous 1 · invalid 1/);
  await panel.close();
});
