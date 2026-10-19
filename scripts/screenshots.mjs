#!/usr/bin/env node
/*
 * Generates docs/screenshot-page.png (page with hover tooltip + POM highlights)
 * and docs/screenshot-panel.png (the DevTools panel UI) with the real extension.
 * Default target is the local fixture page; `--demo` uses the public practice
 * site with the shipped example POM (needs internet) and writes *-demo.png.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, launchWithExtension } from './lib/browser.mjs';
import { serveFixtures, tmpPomDir, startPomServer, fixturePom } from '../tests/helpers.mjs';

const demo = process.argv.includes('--demo');
const out = path.join(ROOT, 'docs');
await fs.mkdir(out, { recursive: true });

const fixtures = demo ? null : await serveFixtures();
const pomDir = demo ? path.join(ROOT, 'server', 'pom') : await tmpPomDir([fixturePom(fixtures.url)]);
const pomServer = await startPomServer({ pomDir, port: 4777 });
const url = demo ? 'https://the-internet.herokuapp.com/login' : fixtures.url + '/page.html';
const hoverTarget = demo ? 'button[type="submit"]' : 'a.link >> nth=2';
const suffix = demo ? '-demo' : '';

const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'selector-cockpit-shot-'));
const ctx = await launchWithExtension({ userDataDir, headless: true, extraArgs: ['--window-size=1100,800'] });
try {
  const page = await ctx.context.newPage();
  await page.setViewportSize({ width: 1000, height: 640 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('html[data-selector-cockpit-ready]', { state: 'attached' });

  const tabId = await ctx.worker.evaluate((u) => self.selectorCockpit.findTab(u), page.url());
  if (!tabId) throw new Error('tab not found for ' + page.url());
  const panel = await ctx.context.newPage();
  await panel.setViewportSize({ width: 900, height: 520 });
  await panel.goto(`chrome-extension://${ctx.extensionId}/panel.html?tabId=${tabId}`);
  await panel.waitForSelector('#pom-table tbody tr');
  await panel.evaluate(() => document.getElementById('btn-inspect').click());

  await page.bringToFront();
  await page.hover(hoverTarget);
  await page.waitForFunction(() => document.getElementById('selector-cockpit-overlay')?.shadowRoot.textContent.includes('css-path'));
  await page.screenshot({ path: path.join(out, `screenshot-page${suffix}.png`) });
  await panel.waitForFunction(() => document.getElementById('hover-out').textContent.includes('css-path'));
  await panel.screenshot({ path: path.join(out, `screenshot-panel${suffix}.png`) });
  console.log(`[screenshots] wrote docs/screenshot-page${suffix}.png and docs/screenshot-panel${suffix}.png (` + (demo ? 'demo site' : 'local fixture') + ')');
} finally {
  await ctx.context.close();
  await pomServer.close();
  if (fixtures) await fixtures.close();
}
