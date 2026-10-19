#!/usr/bin/env node
/*
 * Local POM server — plain node:http, bound to 127.0.0.1 only.
 *
 *   GET    /health
 *   GET    /pages                       → { pages: [...] }
 *   GET    /pages/:name                 → page
 *   PUT    /pages/:name                 → replace page (body = page JSON)
 *   DELETE /pages/:name
 *   POST   /pages/:name/elements        → { name, selector, note? }  adds/overwrites one element
 *   DELETE /pages/:name/elements/:el
 *
 * No CORS headers on purpose: web pages must not be able to read or write
 * the POM from the user's browser. The extension reaches this server through
 * its host_permissions, which does not need CORS. Requests carrying an Origin
 * that is not chrome-extension:// are rejected, and so are requests whose Host
 * is not a loopback name (DNS-rebinding guard).
 */
import http from 'node:http';
import { PomStore, StoreError } from './store.js';

export const DEFAULT_PORT = 4777;
const MAX_BODY = 1024 * 1024;

export function createServer({ store = new PomStore() } = {}) {
  return http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      const origin = req.headers.origin;
      if (origin && !origin.startsWith('chrome-extension://')) return send(403, { error: 'forbidden origin' });
      if (!isLoopbackHost(req.headers.host)) return send(403, { error: 'forbidden host' });

      const url = new URL(req.url, 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, pomDir: store.dir });
      if (parts[0] !== 'pages') return send(404, { error: 'not found' });

      if (parts.length === 1 && req.method === 'GET') return send(200, { pages: await store.list() });
      if (parts.length === 2) {
        const name = parts[1];
        if (req.method === 'GET') return send(200, await store.get(name));
        if (req.method === 'PUT') return send(200, await store.put(name, await readJson(req)));
        if (req.method === 'DELETE') { await store.remove(name); return send(200, { ok: true }); }
      }
      if (parts.length === 3 && parts[2] === 'elements' && req.method === 'POST') {
        const body = await readJson(req);
        const page = await store.addElement(parts[1], body.name, body.selector, body.note);
        return send(200, { ok: true, page });
      }
      if (parts.length === 4 && parts[2] === 'elements' && req.method === 'DELETE') {
        return send(200, { ok: true, page: await store.removeElement(parts[1], parts[3]) });
      }
      return send(405, { error: 'method not allowed' });
    } catch (e) {
      if (e instanceof StoreError) return send(e.status, { error: e.message });
      if (e instanceof SyntaxError) return send(400, { error: 'invalid JSON body' });
      console.error('[server] unhandled error:', e);
      return send(500, { error: 'internal error' });
    }
  });
}

/** Host must be 127.0.0.1 / localhost / [::1] with an optional port. */
export function isLoopbackHost(host) {
  const m = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i.exec(String(host || '').trim());
  return !!m;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return; // keep draining so a 413 can still be delivered
      size += c.length;
      if (size > MAX_BODY) { tooLarge = true; chunks.length = 0; reject(new StoreError(413, 'body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/** Start listening on 127.0.0.1. Resolves with the bound port; rejects on EADDRINUSE etc. */
export function listen({ port = DEFAULT_PORT, pomDir } = {}) {
  const server = createServer({ store: new PomStore(pomDir) });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const isMain = process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.POM_PORT || DEFAULT_PORT);
  listen({ port, pomDir: process.env.POM_DIR }).then(({ port: p }) => {
    console.log(`[server] listening on http://127.0.0.1:${p}  (pom dir: ${process.env.POM_DIR || 'server/pom'})`);
  }).catch((e) => {
    console.error('[server] failed to start:', e.message);
    process.exit(1);
  });
}
