#!/usr/bin/env node
/*
 * MCP server (stdio) — lets an agent read/extend the POM and measure selector
 * uniqueness against a real page.
 *
 * Tools:
 *   list_pages                              → page names + url patterns
 *   get_page_objects(page)                  → elements of one page
 *   check_selectors(url, selectors?, page?) → match count per selector, measured
 *                                             in headless Chromium (Playwright)
 *   add_element(page, name, selector, note?)→ add/overwrite one element (atomic write)
 *
 * The POM directory is read directly from disk (POM_DIR env, default server/pom),
 * so this works even when the HTTP server is not running.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PomStore } from '../server/store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_SRC = readFileSync(path.join(ROOT, 'extension', 'core.js'), 'utf8');

export function createMcpServer({ pomDir = process.env.POM_DIR, launchBrowser = defaultLaunch } = {}) {
  const store = new PomStore(pomDir);
  const server = new McpServer({ name: 'selector-cockpit', version: '0.1.0' });
  const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });
  const fail = (msg) => ({ isError: true, content: [{ type: 'text', text: msg }] });

  server.registerTool('list_pages', {
    description: 'List POM pages (name, url, urlPattern, element count).',
    inputSchema: {},
  }, async () => {
    const pages = await store.list();
    return text(pages.map((p) => ({ name: p.name, url: p.url || null, urlPattern: p.urlPattern || null, elements: Object.keys(p.elements).length })));
  });

  server.registerTool('get_page_objects', {
    description: 'Return all elements (name → selector) of one POM page.',
    inputSchema: { page: z.string().describe('page name, see list_pages') },
  }, async ({ page }) => {
    try { return text(await store.get(page)); } catch (e) { return fail(e.message); }
  });

  server.registerTool('check_selectors', {
    description: 'Open url in headless Chromium and count how many elements each selector matches. ' +
      '0 = broken, 1 = unique, 2+ = ambiguous. Pass selectors explicitly, or a page name to check that POM page. ' +
      'Selector syntax: CSS (default), "text=...", "role=button[name=...]".',
    inputSchema: {
      url: z.string().url().describe('page to open'),
      selectors: z.array(z.string()).optional().describe('selectors to count'),
      page: z.string().optional().describe('POM page name whose selectors are checked when selectors is omitted'),
      timeoutMs: z.number().int().positive().max(120000).optional().describe('navigation timeout, default 30000'),
    },
  }, async ({ url, selectors, page, timeoutMs }) => {
    let list = selectors;
    let names = null;
    if (!list || list.length === 0) {
      if (!page) return fail('either selectors or page is required');
      try {
        const p = await store.get(page);
        names = Object.keys(p.elements);
        list = names.map((n) => (typeof p.elements[n] === 'string' ? p.elements[n] : p.elements[n].selector));
      } catch (e) { return fail(e.message); }
    }
    let browser;
    try {
      browser = await launchBrowser();
      const bp = await browser.newPage();
      // init script: core is evaluated before the page's own scripts, without inserting a <script> node
      // into the DOM that is being measured (addScriptTag would make "script" count one too many)
      await bp.addInitScript({ content: CORE_SRC });
      await bp.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs || 30000 });
      const results = await bp.evaluate((sels) => sels.map((s) => ({ selector: s, ...globalThis.SelectorCockpit.countMatches(s, document) })), list);
      if (names) results.forEach((r, i) => (r.name = names[i]));
      const summary = { total: results.length, ok: 0, missing: 0, ambiguous: 0, invalid: 0 };
      for (const r of results) summary[r.status]++;
      return text({ url: bp.url(), summary, results });
    } catch (e) {
      return fail('check_selectors failed: ' + e.message);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  });

  server.registerTool('add_element', {
    description: 'Add or overwrite one element in a POM page. The file is written atomically.',
    inputSchema: {
      page: z.string().describe('page name'),
      name: z.string().describe('element name, e.g. loginButton'),
      selector: z.string().describe('selector'),
      note: z.string().optional(),
    },
  }, async ({ page, name, selector, note }) => {
    try { return text({ ok: true, page: await store.addElement(page, name, selector, note) }); } catch (e) { return fail(e.message); }
  });

  return server;
}

async function defaultLaunch() {
  const { chromium } = await import('playwright');
  return chromium.launch({ headless: true });
}

const isMain = process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href;
if (isMain) {
  const server = createMcpServer();
  server.connect(new StdioServerTransport()).catch((e) => {
    console.error('[mcp] failed to start:', e);
    process.exit(1);
  });
}
