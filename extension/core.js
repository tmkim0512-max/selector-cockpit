/*
 * selector-cockpit core — pure DOM logic shared by the content script, the
 * DevTools panel, the MCP server (injected into a Playwright page) and tests.
 *
 * No chrome.* APIs here. Everything takes a `root` (Document) argument so it
 * can run in any DOM. Loaded as a classic script (content script / panel),
 * injected via addScriptTag by the MCP server, and evaluated with node:vm in tests.
 *
 * Selector syntax accepted by countMatches():
 *   "css=..." or bare string  → CSS selector (querySelectorAll)
 *   "text=..."                → elements whose normalized text equals the value,
 *                               innermost only (a <button><span>OK</span></button>
 *                               counts the <span>, not both)
 *   "role=button[name=Login]" → ARIA role + accessible name (small subset:
 *                               explicit role attr + implicit roles for common tags,
 *                               name from aria-label / alt / value / text)
 *
 * Known limits (documented in README): no shadow DOM piercing, no iframe
 * traversal, text/role matching is a simplified subset of Playwright's.
 */
(function (globalScope) {
  'use strict';

  const IMPLICIT_ROLES = {
    a: (el) => (el.hasAttribute('href') ? 'link' : null),
    button: () => 'button',
    input: (el) => {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'range') return 'slider';
      if (t === 'number') return 'spinbutton';
      if (t === 'search') return 'searchbox';
      if (t === 'hidden') return null;
      return 'textbox';
    },
    select: () => 'combobox',
    textarea: () => 'textbox',
    h1: () => 'heading', h2: () => 'heading', h3: () => 'heading',
    h4: () => 'heading', h5: () => 'heading', h6: () => 'heading',
    img: () => 'img',
    nav: () => 'navigation',
    main: () => 'main',
    form: () => 'form',
    table: () => 'table',
    ul: () => 'list', ol: () => 'list', li: () => 'listitem',
    option: () => 'option',
  };

  function normText(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const fn = IMPLICIT_ROLES[el.tagName.toLowerCase()];
    return fn ? fn(el) : null;
  }

  function accessibleName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return normText(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const doc = el.ownerDocument;
      const parts = labelledBy.split(/\s+/).map((id) => {
        const ref = doc.getElementById(id);
        return ref ? normText(ref.textContent) : '';
      });
      const joined = normText(parts.join(' '));
      if (joined) return joined;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'img') return normText(el.getAttribute('alt'));
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') {
        return normText(el.getAttribute('value')) || (t === 'submit' ? 'Submit' : '');
      }
      if (el.id) {
        const label = el.ownerDocument.querySelector('label[for="' + cssEscape(el.id) + '"]');
        if (label) return normText(label.textContent);
      }
      const wrap = el.closest('label');
      if (wrap) return normText(wrap.textContent);
      return normText(el.getAttribute('placeholder'));
    }
    return normText(el.textContent);
  }

  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/([^\w-])/g, '\\$1');
  }

  function quoteAttr(v) {
    return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  // --- selector parsing ----------------------------------------------------

  function parseSelector(raw) {
    const s = String(raw || '').trim();
    const m = /^(css|text|role)=([\s\S]*)$/.exec(s);
    if (!m) return { kind: 'css', value: s };
    return { kind: m[1], value: m[2] };
  }

  function parseRole(value) {
    // role=button[name=Login] | role=button[name="Log in"] | role=link
    // quoted names use the same escaping as quoteAttr(): \" and \\
    const m = /^([a-zA-Z]+)(?:\[name=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\]]*))\])?$/.exec(value.trim());
    if (!m) return null;
    const unescape = (q) => q.replace(/\\(.)/g, '$1');
    const name = m[2] !== undefined ? unescape(m[2]) : m[3] !== undefined ? unescape(m[3]) : m[4];
    return { role: m[1].toLowerCase(), name: name === undefined ? null : normText(name) };
  }

  const OVERLAY_TAG = 'SELECTOR-COCKPIT-OVERLAY';
  const notOverlay = (el) => el.tagName !== OVERLAY_TAG;

  function allElements(root) {
    return Array.prototype.slice.call(root.querySelectorAll('*')).filter(notOverlay);
  }

  /**
   * Returns the elements matched by a selector, or throws on invalid syntax.
   */
  function queryAll(raw, root) {
    const { kind, value } = parseSelector(raw);
    if (kind === 'css') {
      return Array.prototype.slice.call(root.querySelectorAll(value)).filter(notOverlay);
    }
    if (kind === 'text') {
      const want = normText(value);
      return allElements(root).filter((el) => {
        if (normText(el.textContent) !== want) return false;
        // innermost only: skip if a child element also matches the text
        for (const child of el.children) {
          if (normText(child.textContent) === want) return false;
        }
        return true;
      });
    }
    if (kind === 'role') {
      const spec = parseRole(value);
      if (!spec) throw new Error('invalid role selector: ' + raw);
      return allElements(root).filter((el) => {
        if (roleOf(el) !== spec.role) return false;
        return spec.name === null ? true : accessibleName(el) === spec.name;
      });
    }
    throw new Error('unknown selector kind: ' + kind);
  }

  /**
   * { count, status, error }  status ∈ 'missing' | 'ok' | 'ambiguous' | 'invalid'
   */
  function countMatches(raw, root) {
    try {
      const count = queryAll(raw, root).length;
      return { count, status: statusForCount(count), error: null };
    } catch (e) {
      return { count: 0, status: 'invalid', error: String(e && e.message ? e.message : e) };
    }
  }

  function statusForCount(count) {
    if (count === 0) return 'missing';
    if (count === 1) return 'ok';
    return 'ambiguous';
  }

  // --- candidate generation ------------------------------------------------

  function cssPath(el) {
    const parts = [];
    let node = el;
    const doc = el.ownerDocument;
    if (node && node.tagName && node.tagName.toLowerCase() === 'html') return 'html';
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
      const tag = node.tagName.toLowerCase();
      // anchor on an id only when it is unique in the document; a duplicated id is no anchor
      if (node.id && doc.querySelectorAll('#' + cssEscape(node.id)).length === 1) {
        parts.unshift('#' + cssEscape(node.id));
        break;
      }
      let part = tag;
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  /**
   * Candidate selectors for an element, each with its match count in `root`.
   * Order = preference order. Returns [] for non-elements.
   */
  function candidatesFor(el, root) {
    if (!el || el.nodeType !== 1) return [];
    const doc = root || el.ownerDocument;
    const tag = el.tagName.toLowerCase();
    const out = [];
    const push = (kind, selector) => {
      if (!selector || out.some((c) => c.selector === selector)) return;
      const r = countMatches(selector, doc);
      out.push({ kind, selector, count: r.count, status: r.status });
    };

    if (el.id) push('id', '#' + cssEscape(el.id));
    for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
      const v = el.getAttribute(attr);
      if (v) push(attr, '[' + attr + '=' + quoteAttr(v) + ']');
    }
    const nameAttr = el.getAttribute('name');
    if (nameAttr) push('name', tag + '[name=' + quoteAttr(nameAttr) + ']');

    const role = roleOf(el);
    if (role) {
      const name = accessibleName(el);
      if (name && name.length <= 60) push('role', 'role=' + role + '[name=' + quoteAttr(name) + ']');
    }
    const text = normText(el.textContent);
    if (text && text.length <= 60 && el.children.length === 0) push('text', 'text=' + text);

    push('css-path', cssPath(el));
    return out;
  }

  // --- POM reconciliation --------------------------------------------------

  function elementEntries(page) {
    const els = (page && page.elements) || {};
    return Object.keys(els).map((name) => {
      const v = els[name];
      const selector = typeof v === 'string' ? v : v && v.selector;
      return { name, selector: selector || '', note: (v && v.note) || '' };
    });
  }

  /**
   * For every element in a POM page, count matches in `root`.
   * → [{ name, selector, count, status, error }]
   */
  function checkPom(page, root) {
    return elementEntries(page).map((e) => {
      const r = countMatches(e.selector, root);
      return { name: e.name, selector: e.selector, count: r.count, status: r.status, error: r.error };
    });
  }

  function summarize(results) {
    const s = { total: results.length, ok: 0, missing: 0, ambiguous: 0, invalid: 0 };
    for (const r of results) s[r.status] = (s[r.status] || 0) + 1;
    return s;
  }

  /**
   * Pick the POM page whose urlPattern matches the url. urlPattern is a
   * substring or a /regex/. First match wins; null when nothing matches.
   */
  function matchPage(pages, url) {
    for (const p of pages || []) {
      const pat = p.urlPattern || p.url;
      if (!pat) continue;
      const rx = /^\/(.*)\/([a-z]*)$/.exec(pat);
      if (rx) {
        let re;
        try { re = new RegExp(rx[1], rx[2]); } catch (_) { continue; } // invalid pattern never matches
        if (re.test(url)) return p;
      } else if (url.indexOf(pat) !== -1) {
        return p;
      }
    }
    return null;
  }

  const api = {
    parseSelector, parseRole, queryAll, countMatches, statusForCount,
    cssPath, candidatesFor, roleOf, accessibleName, normText,
    checkPom, summarize, matchPage, elementEntries,
  };

  globalScope.SelectorCockpit = api;
})(globalThis);
