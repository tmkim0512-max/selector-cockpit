/*
 * HTTP server + store tests — no browser. Covers the security guards
 * (Origin, Host, page-name traversal, body limit) and atomic writes.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { tmpPomDir, startPomServer } from '../helpers.mjs';
import { isLoopbackHost } from '../../server/server.js';
import { PomStore } from '../../server/store.js';

let pomDir, srv;
const req = (method, p, { body, headers = {} } = {}) =>
  fetch(srv.url + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
// fetch() normalizes paths and silently drops the Host header — use raw http for those cases
const raw = (method, p, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const r = http.request({ host: '127.0.0.1', port: srv.port, method, path: p, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
    let text = '';
    res.on('data', (d) => (text += d));
    res.on('end', () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }));
  });
  r.on('error', reject);
  r.end(data);
});

before(async () => {
  pomDir = await tmpPomDir([{ name: 'a', urlPattern: '/a', elements: { x: '#x' } }]);
  srv = await startPomServer({ pomDir });
});
after(async () => srv?.close());

test('binds to 127.0.0.1 only', async () => {
  assert.equal(srv.server.address().address, '127.0.0.1');
  const r = await req('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).pomDir, pomDir);
});

test('rejects web-page Origins (no CORS) but accepts the extension origin and no Origin', async () => {
  assert.equal((await req('GET', '/pages', { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await req('GET', '/pages', { headers: { origin: 'http://127.0.0.1:4777' } })).status, 403);
  const ext = await req('GET', '/pages', { headers: { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } });
  assert.equal(ext.status, 200);
  assert.equal(ext.headers.get('access-control-allow-origin'), null);
  assert.equal((await req('GET', '/pages')).status, 200);
});

test('rejects non-loopback Host headers (DNS rebinding guard)', async () => {
  assert.equal((await raw('GET', '/pages', { headers: { host: 'attacker.example:4777' } })).status, 403);
  assert.equal((await raw('GET', '/pages', { headers: { host: '127.0.0.1.attacker.example' } })).status, 403);
  assert.equal((await raw('GET', '/pages', { headers: { host: 'localhost:' + srv.port } })).status, 200);
  assert.equal((await raw('GET', '/pages', { headers: { host: '[::1]' } })).status, 200);
  assert.equal(isLoopbackHost('127.0.0.1:4777'), true);
  assert.equal(isLoopbackHost(''), false);
  assert.equal(isLoopbackHost('127.0.0.1:4777.evil'), false);
});

test('page CRUD with traversal-safe names', async () => {
  assert.equal((await req('GET', '/pages/a')).status, 200);
  const trav = await raw('GET', '/pages/%2e%2e%2fescape');
  assert.equal(trav.status, 400);
  assert.match(trav.text, /invalid page name/);
  assert.equal((await raw('PUT', '/pages/..', { body: { elements: {} } })).status, 404); // URL-normalized to '/' before routing
  assert.equal((await req('PUT', '/pages/b', { body: { elements: { y: '' } } })).status, 400);
  assert.equal((await req('PUT', '/pages/b', { body: { urlPattern: '/b', elements: { y: '#y' } } })).status, 200);
  const add = await req('POST', '/pages/b/elements', { body: { name: 'z', selector: 'text=Z' } });
  assert.equal(add.status, 200);
  assert.deepEqual((await add.json()).page.elements, { y: '#y', z: 'text=Z' });
  assert.equal((await req('DELETE', '/pages/b/elements/y')).status, 200);
  assert.equal((await req('DELETE', '/pages/b/elements/y')).status, 404);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(pomDir, 'b.json'), 'utf8')).elements, { z: 'text=Z' });
  assert.equal((await req('DELETE', '/pages/b')).status, 200);
  assert.equal((await req('GET', '/pages/b')).status, 404);
  assert.equal((await raw('POST', '/pages/a/elements', { body: '{bad' })).status, 400);
  assert.equal((await req('GET', '/other')).status, 404);
});

test('element named __proto__ is persisted as an own property', async () => {
  const r = await req('POST', '/pages/a/elements', { body: { name: '__proto__', selector: '#p' } });
  assert.equal(r.status, 200);
  const onDisk = JSON.parse(await fs.readFile(path.join(pomDir, 'a.json'), 'utf8'));
  assert.equal(Object.prototype.hasOwnProperty.call(onDisk.elements, '__proto__'), true);
  assert.equal((await req('DELETE', '/pages/a/elements/__proto__')).status, 200);
});

test('rejects bodies over 1MB', async () => {
  const r = await raw('PUT', '/pages/a', { body: { elements: {}, pad: 'x'.repeat(1024 * 1024 + 10) } });
  assert.equal(r.status, 413);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(pomDir, 'a.json'), 'utf8')).elements, { x: '#x' });
});

test('store: concurrent writes never share a temp file and leave no .tmp behind', async () => {
  const store = new PomStore(pomDir);
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.put('c', { elements: { ['e' + i]: '#e' + i } })));
  const files = await fs.readdir(pomDir);
  assert.deepEqual(files.filter((f) => f.endsWith('.tmp')), []);
  const page = JSON.parse(await fs.readFile(path.join(pomDir, 'c.json'), 'utf8'));
  assert.equal(Object.keys(page.elements).length, 1); // one complete writer won — never a torn file
});
