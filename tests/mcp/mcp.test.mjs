/*
 * MCP server tests — spawns mcp/index.js over stdio with the official client
 * and calls every tool. check_selectors opens a local fixture page in headless
 * Chromium (no network).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../mcp/index.js';
import { ROOT, serveFixtures, tmpPomDir, fixturePom } from '../helpers.mjs';

let fixtures, pomDir, client;
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { isError: !!res.isError, text: res.content[0].text, json: res.isError ? null : JSON.parse(res.content[0].text) };
};

before(async () => {
  fixtures = await serveFixtures();
  pomDir = await tmpPomDir([fixturePom(fixtures.url)]);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [path.join(ROOT, 'mcp', 'index.js')], env: { ...process.env, POM_DIR: pomDir },
  }));
});
after(async () => { await client?.close(); await fixtures?.close(); });

test('lists the four tools', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['add_element', 'check_selectors', 'get_page_objects', 'list_pages']);
});

test('list_pages / get_page_objects read the POM directory', async () => {
  const pages = (await call('list_pages')).json;
  assert.deepEqual(pages, [{ name: 'fixture', url: fixtures.url + '/page.html', urlPattern: '/page.html', elements: 7 }]);
  const page = (await call('get_page_objects', { page: 'fixture' })).json;
  assert.equal(page.elements.username, '#user');
  const missing = await call('get_page_objects', { page: 'nope' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /page not found/);
});

test('check_selectors measures real match counts in a browser', async () => {
  const r = (await call('check_selectors', { url: fixtures.url + '/page.html', selectors: ['#user', 'a.link', '#zzz', 'role=button[name="Log in"]', 'div['] })).json;
  assert.deepEqual(r.results.map((x) => [x.selector, x.count, x.status]), [
    ['#user', 1, 'ok'], ['a.link', 3, 'ambiguous'], ['#zzz', 0, 'missing'], ['role=button[name="Log in"]', 1, 'ok'], ['div[', 0, 'invalid'],
  ]);
  assert.deepEqual(r.summary, { total: 5, ok: 2, missing: 1, ambiguous: 1, invalid: 1 });
});

test('check_selectors measures the page as-is: no injected <script> node, structure intact', async () => {
  const r = (await call('check_selectors', { url: fixtures.url + '/page.html', selectors: ['script', '*', 'body:last-child', 'html > :last-child'] })).json;
  assert.deepEqual(r.results.map((x) => x.count), [0, 29, 1, 1]);
});

test('check_selectors with page= checks the POM entries and names them', async () => {
  const r = (await call('check_selectors', { url: fixtures.url + '/page.html', page: 'fixture' })).json;
  const byName = Object.fromEntries(r.results.map((x) => [x.name, x.status]));
  assert.deepEqual(byName, { username: 'ok', password: 'ok', loginButton: 'ok', anyLink: 'ambiguous', closeButton: 'ok', gone: 'missing', broken: 'invalid' });
  const neither = await call('check_selectors', { url: fixtures.url + '/page.html' });
  assert.equal(neither.isError, true);
});

test('check_selectors reports a browser launch failure as a tool error (injected launcher)', async () => {
  const server = createMcpServer({ pomDir, launchBrowser: async () => { throw new Error('chromium missing (simulated)'); } });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const local = new Client({ name: 'local', version: '0.0.0' });
  await local.connect(clientSide);
  const res = await local.callTool({ name: 'check_selectors', arguments: { url: fixtures.url + '/page.html', selectors: ['#user'] } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /check_selectors failed: chromium missing \(simulated\)/);
  await local.close();
  await server.close();
});

test('check_selectors reports navigation failures as tool errors', async () => {
  const r = await call('check_selectors', { url: 'http://127.0.0.1:1/', selectors: ['#x'], timeoutMs: 5000 });
  assert.equal(r.isError, true);
  assert.match(r.text, /check_selectors failed/);
});

test('add_element writes the POM file atomically and is visible to get_page_objects', async () => {
  const r = (await call('add_element', { page: 'fixture', name: 'cardB', selector: 'text=Card B', note: 'added by mcp' })).json;
  assert.deepEqual(r.page.elements.cardB, { selector: 'text=Card B', note: 'added by mcp' });
  const onDisk = JSON.parse(await fs.readFile(path.join(pomDir, 'fixture.json'), 'utf8'));
  assert.deepEqual(onDisk.elements.cardB, { selector: 'text=Card B', note: 'added by mcp' });
  assert.deepEqual((await fs.readdir(pomDir)).filter((f) => f.endsWith('.tmp')), []);
  const bad = await call('add_element', { page: '../escape', name: 'x', selector: '#x' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /invalid page name/);
});
