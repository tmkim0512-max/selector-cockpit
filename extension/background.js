/*
 * Service worker — the only place that talks to the local POM server.
 * The panel sends { type: 'server', method, path, body } and gets back
 * { ok, status, data } or { ok: false, offline: true, error } when the server is down.
 * The panel treats "offline" as read-only mode (graceful degradation).
 */
const SERVER = 'http://127.0.0.1:4777';

const TIMEOUT_MS = 5000;

async function callServer(method, path, body) {
  try {
    const res = await fetch(SERVER + path, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
    if (!res.ok) return { ok: false, offline: false, status: res.status, error: (data && data.error) || res.statusText, data };
    return { ok: true, status: res.status, data };
  } catch (e) {
    // network error, timeout, or body read failure — all mean "no usable server"
    return { ok: false, offline: true, error: 'server unreachable: ' + (e && e.message ? e.message : e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'server') return false;
  callServer(msg.method || 'GET', msg.path, msg.body).then(sendResponse);
  return true; // async response
});

// Exposed for integration tests: lets a test drive the content script from the
// service worker context (chrome.tabs.sendMessage needs no extra permission).
const sendToTab = (tabId, msg) => new Promise((resolve) => {
  chrome.tabs.sendMessage(tabId, msg, (res) => {
    const err = chrome.runtime.lastError;
    resolve(err ? { ok: false, error: err.message } : res);
  });
});
// Without the "tabs" permission tab objects carry no url, so a tab is located
// by pinging each content script and comparing the url it reports.
const findTab = async (url) => {
  for (const tab of await chrome.tabs.query({})) {
    const res = await sendToTab(tab.id, { type: 'ping' });
    if (res && res.ok && res.url === url) return tab.id;
  }
  return null;
};
self.selectorCockpit = { sendToTab, findTab, callServer };
