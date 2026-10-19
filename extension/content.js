/*
 * Content script — runs in the inspected page.
 *   - hover mode: highlight box + tooltip with selector candidates and their match counts
 *   - pick mode: next click is captured and the candidates are sent to the panel
 *   - checkPom: count every POM selector on this page and paint matched elements
 * All overlay nodes live inside a shadow root on one host element, and the host
 * itself is detached from the document while counting, so neither the page's
 * querySelectorAll() nor structural selectors (:last-child …) are disturbed.
 */
(function () {
  'use strict';
  if (window.__selectorCockpitLoaded) return;
  window.__selectorCockpitLoaded = true;
  // Content scripts live in an isolated world; a DOM attribute is the only
  // ready signal visible to the page / Playwright.
  document.documentElement.setAttribute('data-selector-cockpit-ready', '');

  const core = window.SelectorCockpit;
  const HOST_ID = 'selector-cockpit-overlay';
  const COLORS = { ok: '#16a34a', ambiguous: '#f59e0b', missing: '#dc2626', invalid: '#7c3aed', hover: '#2563eb' };

  let host = null;
  let shadow = null;
  let hoverBox = null;
  let tooltip = null;
  let inspectOn = false;
  let pickOn = false;
  let lastHovered = null;
  let pomBoxes = []; // [{ box, el }]

  function ensureHost() {
    if (host && host.isConnected) return host;
    host = document.createElement('selector-cockpit-overlay'); // custom tag: never matched by a real POM selector
    host.id = HOST_ID;
    host.setAttribute('data-selector-cockpit', '');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'open' });
    hoverBox = mkBox(COLORS.hover);
    tooltip = document.createElement('div');
    tooltip.style.cssText = 'position:fixed;display:none;max-width:520px;background:#111827;color:#f9fafb;' +
      'font:12px/1.45 ui-monospace,Menlo,monospace;padding:8px 10px;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.35);' +
      'white-space:pre;pointer-events:none;';
    shadow.appendChild(hoverBox);
    shadow.appendChild(tooltip);
    document.documentElement.appendChild(host);
    return host;
  }

  function mkBox(color) {
    const b = document.createElement('div');
    b.style.cssText = 'position:fixed;display:none;border:2px solid ' + color + ';background:' + color + '22;box-sizing:border-box;';
    return b;
  }

  function placeBox(box, el) {
    const r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
  }

  function isOverlay(el) {
    return !!(el && el.id === HOST_ID);
  }

  // Run fn with the overlay host out of the DOM so it cannot affect any count.
  // Detach + reattach happen synchronously, so nothing is painted in between.
  function withoutOverlay(fn) {
    const attached = host && host.isConnected;
    if (attached) host.remove();
    try { return fn(); } finally { if (attached) document.documentElement.appendChild(host); }
  }

  function fmtLine(c) {
    const mark = c.status === 'ok' ? '✓' : c.status === 'missing' ? '✗' : '!';
    return mark + ' ' + pad(c.kind, 12) + ' ×' + c.count + '  ' + c.selector;
  }
  function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

  function renderTooltip(el, cands) {
    ensureHost();
    const lines = cands.map((c) => {
      const color = COLORS[c.status] || '#fff';
      const span = document.createElement('div');
      span.style.color = color;
      span.textContent = fmtLine(c);
      return span;
    });
    tooltip.replaceChildren(...lines);
    const r = el.getBoundingClientRect();
    tooltip.style.display = 'block';
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    let top = r.bottom + 6, left = r.left;
    if (top + th > window.innerHeight) top = Math.max(0, r.top - th - 6);
    if (left + tw > window.innerWidth) left = Math.max(0, window.innerWidth - tw - 4);
    tooltip.style.top = top + 'px';
    tooltip.style.left = left + 'px';
  }

  function onMove(ev) {
    if (!inspectOn) return;
    const el = ev.target;
    if (!el || el.nodeType !== 1 || isOverlay(el) || el === lastHovered) return;
    lastHovered = el;
    const cands = withoutOverlay(() => core.candidatesFor(el, document));
    ensureHost();
    placeBox(hoverBox, el);
    renderTooltip(el, cands);
    safeSend({ type: 'hover', candidates: cands, tag: el.tagName.toLowerCase(), url: location.href });
  }

  function onClick(ev) {
    if (!pickOn) return;
    const el = ev.target;
    if (!el || isOverlay(el)) return;
    ev.preventDefault();
    ev.stopPropagation();
    const cands = withoutOverlay(() => core.candidatesFor(el, document));
    safeSend({ type: 'picked', candidates: cands, tag: el.tagName.toLowerCase(), url: location.href });
    setPick(false);
  }

  function setInspect(on) {
    inspectOn = !!on;
    if (!inspectOn) {
      lastHovered = null;
      if (hoverBox) hoverBox.style.display = 'none';
      if (tooltip) tooltip.style.display = 'none';
    }
  }

  function setPick(on) {
    pickOn = !!on;
    document.documentElement.style.cursor = pickOn ? 'crosshair' : '';
    if (pickOn) setInspect(true);
  }

  function clearPomBoxes() {
    for (const b of pomBoxes) b.box.remove();
    pomBoxes = [];
  }

  function repositionPomBoxes() {
    for (const b of pomBoxes) {
      if (b.el.isConnected) placeBox(b.box, b.el); else b.box.style.display = 'none';
    }
  }

  function checkPom(page) {
    clearPomBoxes();
    const { results, matched } = withoutOverlay(() => {
      const results = core.checkPom(page, document);
      const matched = results.map((r) => {
        if (r.status !== 'ok' && r.status !== 'ambiguous') return [];
        try { return core.queryAll(r.selector, document); } catch (_) { return []; }
      });
      return { results, matched };
    });
    ensureHost();
    results.forEach((r, i) => {
      for (const el of matched[i]) {
        const box = mkBox(COLORS[r.status]);
        placeBox(box, el);
        const tag = document.createElement('span');
        tag.textContent = r.name + ' ×' + r.count;
        tag.style.cssText = 'position:absolute;left:0;top:-16px;font:11px ui-monospace,monospace;background:' +
          COLORS[r.status] + ';color:#fff;padding:0 4px;border-radius:3px;';
        box.appendChild(tag);
        shadow.appendChild(box);
        pomBoxes.push({ box, el });
      }
    });
    return { url: location.href, title: document.title, results, summary: core.summarize(results) };
  }

  function safeSend(msg) {
    try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch (_) { /* panel closed */ }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg && msg.type) {
      case 'ping': sendResponse({ ok: true, url: location.href, title: document.title }); break;
      case 'setInspect': setInspect(msg.on); sendResponse({ ok: true }); break;
      case 'setPick': setPick(msg.on); sendResponse({ ok: true }); break;
      case 'checkPom': sendResponse({ ok: true, ...checkPom(msg.page) }); break;
      case 'clear': clearPomBoxes(); setInspect(false); setPick(false); sendResponse({ ok: true }); break;
      case 'countSelectors': {
        const results = withoutOverlay(() => (msg.selectors || []).map((s) => ({ selector: s, ...core.countMatches(s, document) })));
        sendResponse({ ok: true, url: location.href, results });
        break;
      }
      default: return false;
    }
    return false;
  });

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  const onViewportChange = () => {
    if (lastHovered && inspectOn) placeBox(hoverBox, lastHovered);
    repositionPomBoxes();
  };
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);
})();
