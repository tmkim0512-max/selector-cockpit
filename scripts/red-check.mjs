#!/usr/bin/env node
/*
 * red check — proves the unit tests actually guard the uniqueness logic.
 *
 *   1. baseline: the unmodified core.js must pass every unit test (otherwise an
 *      infrastructure problem — missing Chromium, broken fixture — could be
 *      mistaken for "the mutation was detected")
 *   2. mutation: a copy where every count ≥ 1 is reported as "ok" (ambiguous
 *      selectors would pass) must make the *uniqueness* tests fail — the
 *      failures are matched by name, not just counted
 * Exit 0 only when both hold; 1 when the suite stayed green; 2 on infrastructure failure.
 */
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './lib/browser.mjs';

const original = path.join(ROOT, 'extension', 'core.js');
const needle = "if (count === 1) return 'ok';";
const MUST_FAIL = ['countMatches: css 0 / 1 / 2+', 'candidatesFor: flags non-unique', 'checkPom + summarize', 'matchPage'];

function runUnit(corePath) {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/unit/core.test.mjs'], {
    cwd: ROOT, env: { ...process.env, SELECTOR_COCKPIT_CORE: corePath }, encoding: 'utf8',
  });
  const num = (k) => Number((r.stdout.match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [])[1] ?? -1);
  const failed = [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim());
  return { status: r.status, pass: num('pass'), fail: num('fail'), failed, out: r.stdout + r.stderr };
}

const src = await fs.readFile(original, 'utf8');
if (!src.includes(needle)) {
  console.error('[red-check] ✗ expected line not found in core.js: ' + needle);
  process.exit(2);
}

console.log('[red-check] 1/2 baseline run (unmodified core.js)');
const base = runUnit(original);
console.log(`[red-check]     pass=${base.pass} fail=${base.fail} exit=${base.status}`);
if (base.status !== 0 || base.fail !== 0 || base.pass <= 0) {
  console.error('[red-check] ✗ baseline is not green — fix the environment/tests first (infrastructure failure, not a mutation signal)');
  console.error(base.out.slice(-2000));
  process.exit(2);
}

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'selector-cockpit-red-'));
const mutatedPath = path.join(dir, 'core.js');
await fs.writeFile(mutatedPath, src.replace(needle, "if (count >= 1) return 'ok'; // MUTATED by red-check"));
console.log('[red-check] 2/2 mutated run: ' + mutatedPath);
const mut = runUnit(mutatedPath);
console.log(`[red-check]     pass=${mut.pass} fail=${mut.fail} exit=${mut.status}`);
for (const f of mut.failed) console.log('[red-check]     RED: ' + f);

const missing = MUST_FAIL.filter((name) => !mut.failed.some((f) => f.includes(name)));
if (mut.status !== 0 && mut.fail > 0 && missing.length === 0) {
  console.log('[red-check] ✓ every uniqueness test went RED on the mutation — the suite really guards it');
  process.exit(0);
}
console.error('[red-check] ✗ mutation not caught' + (missing.length ? ' — expected these to fail but they stayed green: ' + missing.join(' | ') : ''));
console.error(mut.out.slice(-2000));
process.exit(1);
