/*
 * Unit tests for extension/core.js — deterministic, no network.
 * The DOM comes from page.setContent() in headless Chromium so the same code
 * path as the content script (querySelectorAll, CSS.escape, getAttribute) is used.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { FIXTURES, coreSource, loadCoreNode } from '../helpers.mjs';

let browser, page;
const FIXTURE_HTML = await fs.readFile(path.join(FIXTURES, 'page.html'), 'utf8');

before(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.setContent(FIXTURE_HTML);
  // evaluate the source directly: no <script> node is inserted into the DOM being measured
  await page.evaluate((src) => (0, eval)(src), await coreSource());
});
after(async () => browser && browser.close());

const count = (sel) => page.evaluate((s) => globalThis.SelectorCockpit.countMatches(s, document), sel);

test('countMatches: css 0 / 1 / 2+ map to missing / ok / ambiguous', async () => {
  assert.deepEqual(await count('#user'), { count: 1, status: 'ok', error: null });
  assert.deepEqual(await count('#nope'), { count: 0, status: 'missing', error: null });
  assert.equal((await count('a.link')).count, 3);
  assert.equal((await count('a.link')).status, 'ambiguous');
  assert.equal((await count('.card')).count, 2);
});

test('the test harness itself injects nothing into the DOM (script → 0, 29 elements)', async () => {
  assert.equal((await count('script')).count, 0);
  assert.equal((await count('*')).count, 29);
});

test('countMatches: invalid css reports status invalid, never throws', async () => {
  const r = await count('div[');
  assert.equal(r.status, 'invalid');
  assert.equal(r.count, 0);
  assert.match(r.error, /not a valid selector|SyntaxError|div\[/);
});

test('text= matches innermost element with exactly that text', async () => {
  assert.equal((await count('text=OK')).count, 1);          // <span>OK</span>, not the wrapping <button>
  assert.equal((await count('text=Two')).count, 2);         // two links say "Two"
  assert.equal((await count('text=Paragraph with nested text')).count, 1);
  assert.equal((await count('text=nested')).count, 1);
  assert.equal((await count('text=Nope')).count, 0);
});

test('role= uses implicit roles and accessible names', async () => {
  assert.equal((await count('role=button[name="Log in"]')).count, 1);
  assert.equal((await count('role=button[name="Close dialog"]')).count, 1);   // aria-label
  assert.equal((await count('role=button[name=OK]')).count, 1);              // nested span text
  assert.equal((await count('role=button')).count, 3);
  assert.equal((await count('role=link[name=Two]')).count, 2);
  assert.equal((await count('role=textbox[name=Username]')).count, 1);       // <label for>
  assert.equal((await count('role=heading')).count, 1);
  assert.equal((await count('role=bogus[')).status, 'invalid');
});

test('candidatesFor: prefers id, then data-testid, name, role, text, css path — each with counts', async () => {
  const cands = await page.evaluate(() => globalThis.SelectorCockpit.candidatesFor(document.querySelector('#user'), document));
  // css-path of an element with an id is the id itself → deduplicated
  assert.deepEqual(cands.map((c) => c.kind), ['id', 'data-testid', 'name', 'role']);
  assert.equal(cands[0].selector, '#user');
  assert.equal(cands[1].selector, '[data-testid="user-input"]');
  assert.equal(cands[2].selector, 'input[name="username"]');
  assert.equal(cands[3].selector, 'role=textbox[name="Username"]');
  assert.ok(cands.every((c) => c.count === 1 && c.status === 'ok'), JSON.stringify(cands));
});

test('candidatesFor: flags non-unique candidates', async () => {
  const cands = await page.evaluate(() =>
    globalThis.SelectorCockpit.candidatesFor(document.querySelectorAll('a.link')[2], document));
  const byKind = Object.fromEntries(cands.map((c) => [c.kind, c]));
  assert.equal(byKind.role.selector, 'role=link[name="Two"]');
  assert.equal(byKind.role.count, 2);
  assert.equal(byKind.role.status, 'ambiguous');
  assert.equal(byKind.text.count, 2);
  assert.equal(byKind['css-path'].selector, 'body > nav > a:nth-of-type(3)');
  assert.equal(byKind['css-path'].count, 1);
});

test('cssPath stops at the nearest ancestor with a *unique* id; html is "html"', async () => {
  const p = await page.evaluate(() => globalThis.SelectorCockpit.cssPath(document.querySelectorAll('#list li')[1]));
  assert.equal(p, '#list > li:nth-of-type(2)');
  assert.equal(await page.evaluate(() => globalThis.SelectorCockpit.cssPath(document.documentElement)), 'html');
  const dup = await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<div id="dup"><i>a</i></div><div id="dup"><i>b</i></div>');
    const r = globalThis.SelectorCockpit.candidatesFor(document.querySelectorAll('#dup i')[1], document);
    document.querySelectorAll('#dup').forEach((d) => d.remove());
    return r;
  });
  const cssPath = dup.find((c) => c.kind === 'css-path');
  assert.equal(cssPath.selector, 'body > div:nth-of-type(4) > i');
  assert.equal(cssPath.count, 1);
});

test('role= names with quotes/backslashes round-trip between generator and parser', async () => {
  const r = await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<button id="q">Say "Hi" C:\\Temp</button>');
    const el = document.getElementById('q');
    const cands = globalThis.SelectorCockpit.candidatesFor(el, document);
    const role = cands.find((c) => c.kind === 'role');
    const out = { selector: role.selector, count: role.count, text: cands.find((c) => c.kind === 'text') };
    el.remove();
    return out;
  });
  assert.equal(r.selector, 'role=button[name="Say \\"Hi\\" C:\\\\Temp"]');
  assert.equal(r.count, 1);
  assert.equal(r.text.count, 1);
});

test('checkPom + summarize: one row per element with count/status', async () => {
  const pom = { name: 'fixture', elements: {
    username: '#user', anyLink: 'a.link', gone: '#does-not-exist', broken: 'div[', btn: { selector: 'role=button[name="Log in"]' },
  } };
  const { results, summary } = await page.evaluate((p) => {
    const r = globalThis.SelectorCockpit.checkPom(p, document);
    return { results: r, summary: globalThis.SelectorCockpit.summarize(r) };
  }, pom);
  assert.deepEqual(results.map((r) => [r.name, r.count, r.status]), [
    ['username', 1, 'ok'], ['anyLink', 3, 'ambiguous'], ['gone', 0, 'missing'], ['broken', 0, 'invalid'], ['btn', 1, 'ok'],
  ]);
  assert.deepEqual(summary, { total: 5, ok: 2, missing: 1, ambiguous: 1, invalid: 1 });
});

test('matchPage: substring and /regex/ url patterns (pure, runs in Node)', async () => {
  const core = await loadCoreNode();
  const pages = [{ name: 'login', urlPattern: '/login' }, { name: 'cb', urlPattern: '/\\/checkboxes$/' }, { name: 'home', url: 'https://x.test/' }];
  assert.equal(core.matchPage(pages, 'https://x.test/login').name, 'login');
  assert.equal(core.matchPage(pages, 'https://x.test/checkboxes').name, 'cb');
  assert.equal(core.matchPage(pages, 'https://other.test/checkboxes/extra'), null);
  assert.equal(core.matchPage(pages, 'https://x.test/').name, 'home');
  assert.equal(core.matchPage([{ name: 'bad', urlPattern: '/[/' }, { name: 'ok', urlPattern: 'x.test' }], 'https://x.test/').name, 'ok'); // invalid regex skipped
  assert.equal(core.statusForCount(0), 'missing');
  assert.equal(core.statusForCount(1), 'ok');
  assert.equal(core.statusForCount(7), 'ambiguous');
});
