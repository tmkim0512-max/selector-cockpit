/*
 * Optional — needs network. Runs only with DEMO_NETWORK=1 (npm run test:demo).
 * Checks the shipped example POM against the public practice site and expects
 * the intentionally broken / ambiguous entries to be detected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, coreSource } from '../helpers.mjs';

const skip = process.env.DEMO_NETWORK !== '1' ? 'set DEMO_NETWORK=1 to run (needs internet)' : false;

test('example POM "login" against the-internet.herokuapp.com/login', { skip }, async () => {
  const pom = JSON.parse(await fs.readFile(path.join(ROOT, 'server', 'pom', 'login.json'), 'utf8'));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript({ content: await coreSource() });
    await page.goto(pom.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const results = await page.evaluate((p) => globalThis.SelectorCockpit.checkPom(p, document), pom);
    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    assert.equal(byName.username.status, 'ok');
    assert.equal(byName.password.status, 'ok');
    assert.equal(byName.loginButton.status, 'ok');
    assert.equal(byName.heading.status, 'ok');
    assert.equal(byName.anyInput.status, 'ambiguous');
    assert.equal(byName.anyInput.count, 2);
    assert.equal(byName.loginButtonOld.status, 'missing');
  } finally {
    await browser.close();
  }
});
