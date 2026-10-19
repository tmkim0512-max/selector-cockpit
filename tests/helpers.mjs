/* Shared test helpers: fixture http server, temp POM dir, POM server, core loader. */
import http from 'node:http';
import vm from 'node:vm';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../scripts/lib/browser.mjs';
import { listen } from '../server/server.js';

export { ROOT };
export const FIXTURES = path.join(ROOT, 'tests', 'fixtures');

/** Path of core.js under test; the red-check script points this at a mutated copy. */
export const CORE_PATH = process.env.SELECTOR_COCKPIT_CORE || path.join(ROOT, 'extension', 'core.js');
export const coreSource = () => fs.readFile(CORE_PATH, 'utf8');
/** Evaluate core.js in Node (no DOM) for the pure helpers. */
export async function loadCoreNode() {
  const ctx = { globalThis: null };
  ctx.globalThis = ctx;
  vm.runInNewContext(await coreSource(), ctx, { filename: CORE_PATH });
  return ctx.SelectorCockpit;
}

/** Serve tests/fixtures on 127.0.0.1:<random>. Returns { url, close }. */
export function serveFixtures() {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };
  const server = http.createServer(async (req, res) => {
    const file = path.join(FIXTURES, path.normalize(new URL(req.url, 'http://x').pathname).replace(/^(\.\.[/\\])+/, ''));
    try {
      const body = await fs.readFile(file);
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** Create a temp dir containing the given pages as <name>.json. */
export async function tmpPomDir(pages = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'selector-cockpit-pom-'));
  for (const p of pages) await fs.writeFile(path.join(dir, p.name + '.json'), JSON.stringify(p, null, 2));
  return dir;
}

export async function startPomServer({ pomDir, port = 0 }) {
  const { server, port: p } = await listen({ port, pomDir });
  return { server, port: p, url: `http://127.0.0.1:${p}`, close: () => new Promise((r) => server.close(r)) };
}

export const fixturePom = (fixtureUrl) => ({
  name: 'fixture',
  url: fixtureUrl + '/page.html',
  urlPattern: '/page.html',
  elements: {
    username: '#user',
    password: 'input[name="password"]',
    loginButton: 'role=button[name="Log in"]',
    anyLink: 'a.link',
    closeButton: 'role=button[name="Close dialog"]',
    gone: '#does-not-exist',
    broken: 'div[',
  },
});
