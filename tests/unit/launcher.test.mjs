/*
 * Launcher plumbing — no browser. Extension id derivation, CDP polling under a
 * stalled / wrong endpoint, port probing, and the cockpit's early-exit paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ROOT, expectedExtensionId, waitForExtensionWorker, portInUse, freePort } from '../../scripts/lib/browser.mjs';

test('expectedExtensionId is derived from manifest key (32 chars a-p)', () => {
  const id = expectedExtensionId();
  assert.match(id, /^[a-p]{32}$/);
  assert.equal(id, expectedExtensionId()); // deterministic
});

test('waitForExtensionWorker gives up on a stalled endpoint within the deadline', async () => {
  const stalled = net.createServer(() => { /* accept, never answer */ });
  await new Promise((r) => stalled.listen(0, '127.0.0.1', r));
  try {
    const t0 = Date.now();
    const r = await waitForExtensionWorker(stalled.address().port, { timeoutMs: 600 });
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.match(r.error, /unreachable|abort|timeout/i);
    assert.ok(elapsed < 2500, 'took ' + elapsed + 'ms');
  } finally {
    stalled.close();
  }
});

test('waitForExtensionWorker rejects a CDP list without our worker and a non-CDP endpoint', async () => {
  const fake = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/json/list'
      ? JSON.stringify([{ type: 'service_worker', url: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/background.js' }, { type: 'page', url: 'about:blank' }])
      : '{}');
  });
  const notCdp = http.createServer((_req, res) => res.end('hello'));
  await Promise.all([fake, notCdp].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
  try {
    const r = await waitForExtensionWorker(fake.address().port, { timeoutMs: 400 });
    assert.equal(r.ok, false);
    assert.match(r.error, /no service_worker target chrome-extension:\/\/[a-p]{32}\/background\.js among 2 CDP targets/);
    assert.deepEqual(r.targets.map((t) => t.type), ['service_worker', 'page']);

    const r2 = await waitForExtensionWorker(notCdp.address().port, { timeoutMs: 300 });
    assert.equal(r2.ok, false);
    assert.match(r2.error, /not CDP/);
  } finally {
    fake.close();
    notCdp.close();
  }
});

test('portInUse / freePort', async () => {
  const port = await freePort();
  assert.equal(await portInUse(port), false);
  const holder = net.createServer();
  await new Promise((r) => holder.listen(port, '127.0.0.1', r));
  try { assert.equal(await portInUse(port), true); } finally { holder.close(); }
});

test('cockpit exits 1 with a reason when the CDP port is occupied (before launching any browser)', async () => {
  const port = await freePort();
  const holder = net.createServer();
  await new Promise((r) => holder.listen(port, '127.0.0.1', r));
  let r;
  try {
    r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'cockpit.mjs'), '--port', String(port), '--headless'], { encoding: 'utf8', timeout: 20000 });
  } finally { holder.close(); }
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`CDP port ${port} is already in use`));
});
