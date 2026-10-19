/*
 * DevTools panel logic.
 *   server (via background) ──► page list / save
 *   content script (via tabs.sendMessage) ──► checkPom / inspect / pick
 * When the server is unreachable the panel stays usable in read-only mode:
 * a POM JSON file can be loaded from disk and checked, but "Add to POM" is disabled.
 */
(function () {
  'use strict';
  const core = window.SelectorCockpit;
  const $ = (id) => document.getElementById(id);

  const tabId = (chrome.devtools && chrome.devtools.inspectedWindow && chrome.devtools.inspectedWindow.tabId) ||
    Number(new URLSearchParams(location.search).get('tabId')) || null;

  const state = { online: false, pages: [], current: null, picked: null, inspect: false };

  function log(msg) { $('log').textContent = new Date().toLocaleTimeString() + '  ' + msg; }

  function server(method, path, body) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'server', method, path, body }, (res) => {
        const err = chrome.runtime.lastError;
        resolve(err ? { ok: false, offline: true, error: err.message } : res);
      });
    });
  }

  function toTab(msg) {
    return new Promise((resolve) => {
      if (!tabId) return resolve({ ok: false, error: 'no inspected tab' });
      chrome.tabs.sendMessage(tabId, msg, (res) => {
        const err = chrome.runtime.lastError;
        resolve(err ? { ok: false, error: err.message } : res);
      });
    });
  }

  function setOnline(on) {
    state.online = on;
    const b = $('server-badge');
    b.textContent = on ? 'server: online' : 'server: offline (read-only)';
    b.className = 'badge ' + (on ? 'online' : 'offline');
    $('btn-add').disabled = !on;
  }

  async function refreshPages() {
    clearResults('');
    const health = await server('GET', '/health');
    setOnline(!!health.ok);
    if (!health.ok) { log(health.error || 'server offline'); return; }
    const res = await server('GET', '/pages');
    if (!res.ok) { log('list pages failed: ' + res.error); return; }
    state.pages = res.data.pages || [];
    renderPageSelect();
    const ping = await toTab({ type: 'ping' });
    if (ping && ping.ok) {
      $('page-url').textContent = ping.url;
      const m = core.matchPage(state.pages, ping.url);
      selectPage(m ? m.name : ''); // unmatched url → nothing selected, stale table cleared
    } else {
      $('page-url').textContent = '(content script not reachable — reload the page) ' + (ping && ping.error ? ping.error : '');
    }
  }

  function renderPageSelect() {
    const sel = $('page-select');
    sel.replaceChildren(new Option('(none)', ''));
    for (const p of state.pages) sel.appendChild(new Option(p.name + '  ' + (p.urlPattern || p.url || ''), p.name));
    if (state.current) sel.value = state.current.name;
  }

  function clearResults(note) {
    $('pom-table').querySelector('tbody').replaceChildren();
    $('summary').textContent = note || '';
  }

  function selectPage(name) {
    state.current = state.pages.find((p) => p.name === name) || null;
    $('page-select').value = state.current ? state.current.name : '';
    if (state.current) check(); else clearResults('no POM page selected');
  }

  async function check() {
    if (!state.current) { log('select a POM page first'); return; }
    clearResults('checking…');
    const res = await toTab({ type: 'checkPom', page: state.current });
    if (!res || !res.ok) { clearResults('check failed — no results'); log('check failed: ' + (res && res.error)); return; }
    renderResults(res.results, res.summary);
    log('checked ' + res.results.length + ' selectors on ' + res.url);
  }

  function renderResults(results, summary) {
    const tb = $('pom-table').querySelector('tbody');
    tb.replaceChildren();
    for (const r of results) {
      const tr = document.createElement('tr');
      tr.className = r.status;
      tr.innerHTML = '<td></td><td></td><td></td><td class="status"></td>';
      tr.children[0].textContent = r.name;
      tr.children[1].textContent = r.selector;
      tr.children[2].textContent = String(r.count);
      tr.children[3].textContent = r.status + (r.error ? ' (' + r.error + ')' : '');
      tb.appendChild(tr);
    }
    $('summary').textContent = 'ok ' + summary.ok + ' · missing ' + summary.missing + ' · ambiguous ' + summary.ambiguous +
      ' · invalid ' + summary.invalid + '  (total ' + summary.total + ')';
  }

  async function setInspect(on) {
    const res = await toTab({ type: 'setInspect', on });
    if (!res || !res.ok) { log('inspect failed: ' + (res && res.error)); on = false; }
    state.inspect = on;
    const b = $('btn-inspect');
    b.textContent = 'Inspect: ' + (on ? 'on' : 'off');
    b.classList.toggle('on', on);
  }

  function showPicked(msg) {
    state.picked = msg;
    const box = $('pick-candidates');
    box.replaceChildren();
    const preferred = msg.candidates.findIndex((c) => c.status === 'ok');
    msg.candidates.forEach((c, i) => {
      const label = document.createElement('label');
      label.className = c.status;
      const radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'cand'; radio.value = c.selector;
      radio.checked = i === (preferred === -1 ? 0 : preferred); // first unique candidate, else first
      label.appendChild(radio);
      label.appendChild(document.createTextNode(' ×' + c.count + '  [' + c.kind + ']  ' + c.selector));
      box.appendChild(label);
    });
    $('pick-box').classList.remove('hidden');
    $('pick-name').focus();
  }

  async function addPicked() {
    if (!state.current) { log('select a POM page first'); return; }
    const sel = $('pick-candidates').querySelector('input:checked');
    const name = $('pick-name').value.trim();
    if (!sel || !name) { log('name and selector are required'); return; }
    const res = await server('POST', '/pages/' + encodeURIComponent(state.current.name) + '/elements',
      { name, selector: sel.value });
    if (!res.ok) { log('add failed: ' + res.error); if (res.offline) setOnline(false); return; }
    state.current = res.data.page;
    state.pages = state.pages.map((p) => (p.name === state.current.name ? state.current : p));
    $('pick-box').classList.add('hidden');
    $('pick-name').value = '';
    log('added ' + name + ' → ' + sel.value);
    check();
  }

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        const pages = Array.isArray(data) ? data : data.pages ? data.pages : [data];
        for (const p of pages) {
          if (!p.name) throw new Error('page without name');
          state.pages = state.pages.filter((x) => x.name !== p.name).concat([p]);
        }
        renderPageSelect();
        selectPage(pages[0].name);
        log('loaded ' + pages.length + ' page(s) from file (not saved to server)');
      } catch (e) { log('invalid POM file: ' + e.message); }
    };
    reader.readAsText(file);
  }

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || !sender.tab || sender.tab.id !== tabId) return;
    if (msg.type === 'hover') {
      $('hover-out').textContent = '<' + msg.tag + '>\n' + msg.candidates.map((c) =>
        (c.status === 'ok' ? '✓' : c.status === 'missing' ? '✗' : '!') + ' ×' + c.count + '  [' + c.kind + ']  ' + c.selector).join('\n');
    } else if (msg.type === 'picked') {
      showPicked(msg);
      setInspect(false);
    }
  });

  $('page-select').addEventListener('change', (e) => selectPage(e.target.value));
  $('btn-check').addEventListener('click', check);
  $('btn-inspect').addEventListener('click', () => setInspect(!state.inspect));
  $('btn-pick').addEventListener('click', async () => {
    const res = await toTab({ type: 'setPick', on: true });
    log(res && res.ok ? 'click an element in the page' : 'pick failed: ' + (res && res.error));
  });
  $('btn-clear').addEventListener('click', async () => {
    const res = await toTab({ type: 'clear' });
    if (!res || !res.ok) log('clear failed: ' + (res && res.error));
    setInspect(false);
  });
  $('btn-add').addEventListener('click', addPicked);
  $('btn-cancel-pick').addEventListener('click', () => $('pick-box').classList.add('hidden'));
  $('file-input').addEventListener('change', (e) => e.target.files[0] && loadFile(e.target.files[0]));
  if (chrome.devtools && chrome.devtools.network) chrome.devtools.network.onNavigated.addListener(() => setTimeout(refreshPages, 300));

  refreshPages();
})();
