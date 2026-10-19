/*
 * Browser helpers shared by the cockpit launcher, the tests and the screenshot script.
 *
 * Why Chrome for Testing: recent stable Chrome builds ignore --load-extension,
 * so the extension silently never appears. The Playwright-bundled Chromium
 * (Chrome for Testing) still honours it. Extension load is verified through
 * CDP (/json/list must contain the service_worker target of *this* extension,
 * identified by the id derived from manifest.json "key") — never assumed.
 */
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXTENSION_DIR = path.join(ROOT, 'extension');

/** Chrome derives an extension id from manifest "key": first 16 bytes of sha256(DER public key), each nibble → a..p. */
export function expectedExtensionId(extDir = EXTENSION_DIR) {
  const manifest = JSON.parse(readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  if (!manifest.key) throw new Error('manifest.json has no "key" — extension id cannot be predicted');
  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16);
  return [...digest].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('');
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** True when something already answers on 127.0.0.1:port (e.g. another browser's CDP endpoint). */
export function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(true));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(false)));
  });
}

export async function chromiumExecutable() {
  const { chromium } = await import('playwright');
  return chromium.executablePath();
}

export function extensionArgs(extDir = EXTENSION_DIR) {
  return [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`];
}

/**
 * Poll CDP /json/list until the background service worker of *our* extension
 * (url chrome-extension://<expected id>/background.js) shows up.
 */
export async function waitForExtensionWorker(port, { timeoutMs = 15000, intervalMs = 250, extDir = EXTENSION_DIR } = {}) {
  const extensionId = expectedExtensionId(extDir);
  const wantUrl = `chrome-extension://${extensionId}/background.js`;
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response from CDP yet';
  let lastTargets = [];
  while (Date.now() < deadline) {
    // each probe (headers + body) is bounded so a stalled endpoint cannot outlive the deadline;
    // a probe that could not get a meaningful answer anyway (<300ms left) is skipped so its
    // abort message does not overwrite the last substantive error
    const budget = Math.min(2000, deadline - Date.now());
    if (budget < 300 && lastTargets.length) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(Math.max(50, budget)) });
      lastTargets = await res.json();
      if (!Array.isArray(lastTargets)) throw new Error('not a CDP target list');
      const sw = lastTargets.find((t) => t.type === 'service_worker' && t.url === wantUrl);
      if (sw) return { ok: true, target: sw, extensionId };
      lastError = `no service_worker target ${wantUrl} among ${lastTargets.length} CDP targets`;
    } catch (e) {
      lastError = 'CDP endpoint unreachable or not CDP: ' + e.message;
    }
    if (Date.now() + intervalMs < deadline) await new Promise((r) => setTimeout(r, intervalMs)); else break;
  }
  return { ok: false, error: lastError, extensionId, targets: (Array.isArray(lastTargets) ? lastTargets : []).map((t) => ({ type: t.type, url: t.url })) };
}

/**
 * Launch a persistent Chromium context with the extension loaded and a CDP port open.
 * Returns { context, port, cdp, worker, extensionId }; throws if the extension is not verified.
 */
export async function launchWithExtension({ userDataDir, headless = true, port, extDir = EXTENSION_DIR, extraArgs = [] } = {}) {
  const { chromium } = await import('playwright');
  const cdpPort = port || (await freePort());
  if (await portInUse(cdpPort)) throw new Error(`CDP port ${cdpPort} is already in use — cannot verify this browser instance`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium', // new headless mode supports extensions; headed also works
    headless,
    args: [...extensionArgs(extDir), `--remote-debugging-port=${cdpPort}`, ...extraArgs],
  });
  const cdp = await waitForExtensionWorker(cdpPort, { extDir });
  if (!cdp.ok) {
    await context.close().catch(() => {});
    throw new Error('extension did not load: ' + cdp.error);
  }
  let worker = context.serviceWorkers().find((w) => w.url() === cdp.target.url);
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10000, predicate: (w) => w.url() === cdp.target.url });
  return { context, port: cdpPort, cdp, worker, extensionId: cdp.extensionId };
}
