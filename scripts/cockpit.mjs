#!/usr/bin/env node
/*
 * cockpit — one command to get a working setup:
 *   1. launch Chrome for Testing (Playwright-bundled Chromium) with the extension
 *      and a remote debugging port
 *   2. verify through CDP /json/list that *this* extension's service worker is
 *      loaded (fail loudly otherwise — a Chrome that ignores --load-extension
 *      looks perfectly healthy)
 *   3. start the local POM server on 127.0.0.1:4777
 *   4. open the demo site
 *
 * Exit codes: 0 = user closed the browser window / Ctrl+C after a verified start,
 *             1 = any startup failure (reason printed),
 *             2 = browser died later on its own (non-zero code or a signal we did not send).
 *
 * Usage: node scripts/cockpit.mjs [--port 9333] [--url https://the-internet.herokuapp.com/login]
 *                                 [--pom-dir server/pom] [--profile .cockpit-profile] [--headless]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { ROOT, EXTENSION_DIR, chromiumExecutable, extensionArgs, waitForExtensionWorker, portInUse } from './lib/browser.mjs';
import { listen, DEFAULT_PORT } from '../server/server.js';

const args = parseArgs(process.argv.slice(2));
const cdpPort = Number(args.port || 9333);
const url = args.url || 'https://the-internet.herokuapp.com/login';
const profile = path.resolve(ROOT, args.profile || '.cockpit-profile');
const pomDir = args['pom-dir'] ? path.resolve(args['pom-dir']) : undefined;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}

function die(msg, code = 1) {
  console.error('[cockpit] ✗ ' + msg);
  process.exit(code);
}

async function main() {
  const exe = await chromiumExecutable().catch((e) => die('cannot resolve Chromium: ' + e.message + '\n  run: npx playwright install chromium'));
  if (!existsSync(exe)) die('Chromium not installed at ' + exe + '\n  run: npx playwright install chromium');
  if (await portInUse(cdpPort)) die(`CDP port ${cdpPort} is already in use (another browser?) — pick another with --port`);

  console.log('[cockpit] browser:  ' + exe);
  console.log('[cockpit] extension: ' + EXTENSION_DIR);
  const chromeArgs = [
    ...extensionArgs(),
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    ...(args.headless ? ['--headless=new'] : []),
    url,
  ];
  const browser = spawn(exe, chromeArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderrTail = '';
  browser.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-4000); });
  let verified = false;
  let stopping = false; // set only when *we* kill the browser (Ctrl+C / startup failure)
  let browserExit = null;
  browser.on('exit', (code, signal) => {
    browserExit = { code, signal };
    if (!verified || stopping) return; // startup path / our own shutdown report elsewhere
    if (code === 0) {
      console.log('[cockpit] browser window closed — shutting down');
      process.exit(0);
    }
    console.error(`[cockpit] ✗ browser died unexpectedly (code=${code} signal=${signal})` +
      (stderrTail.trim() ? '\n  browser stderr (tail):\n' + stderrTail.trim().split('\n').slice(-15).map((l) => '    ' + l).join('\n') : ''));
    process.exit(2);
  });
  browser.on('error', (e) => die('failed to spawn browser: ' + e.message));

  const cdp = await waitForExtensionWorker(cdpPort, { timeoutMs: 20000 });
  if (!cdp.ok) {
    stopping = true;
    browser.kill();
    die('extension not loaded: ' + cdp.error +
      '\n  expected id: ' + cdp.extensionId +
      '\n  targets seen: ' + JSON.stringify(cdp.targets) +
      (browserExit ? `\n  browser exited early: ${JSON.stringify(browserExit)}` : '') +
      (stderrTail.trim() ? '\n  browser stderr (tail):\n' + stderrTail.trim().split('\n').slice(-15).map((l) => '    ' + l).join('\n') : ''));
  }
  verified = true;
  console.log('[cockpit] ✓ extension loaded, id=' + cdp.extensionId + ' (verified via CDP :' + cdpPort + '/json/list)');

  let server;
  try {
    server = await listen({ port: DEFAULT_PORT, pomDir });
  } catch (e) {
    stopping = true;
    browser.kill();
    die('POM server failed to start on 127.0.0.1:' + DEFAULT_PORT + ': ' + e.message);
  }
  console.log('[cockpit] ✓ POM server http://127.0.0.1:' + server.port + '  (pom dir: ' + (pomDir || 'server/pom') + ')');
  console.log('[cockpit] open DevTools (F12) in the browser → "Selector Cockpit" panel. Ctrl+C to stop.');

  const stop = () => { stopping = true; browser.kill(); server.server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => die(e.stack || e.message));
