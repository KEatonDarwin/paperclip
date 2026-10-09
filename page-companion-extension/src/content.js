// Page Companion — content script, on every http(s) page Kevin opens.
//
// Two hard rules:
//   1. ZERO DOM TOUCH when the page isn't ours. No host element, no style tag,
//      no observers left running. A page that isn't in the registry must not be
//      able to tell this extension exists.
//   2. Everything we do inject lives inside a Shadow DOM, so page CSS can't
//      reach our button and our CSS can't reach the page.
//
// No ES imports here — MV3 content scripts don't support them. The small amount
// of logic duplicated from config.js (the page key) is deliberate and is covered
// by test/config.test.mjs on the config.js side.

(() => {
  const MSG_LOOKUP = 'page-companion:lookup';
  const MSG_NEW_CHAT = 'page-companion:new-chat';
  const MSG_GET_LAST_TAB = 'page-companion:get-last-tab';
  const MSG_SET_LAST_TAB = 'page-companion:set-last-tab';
  const HOST_ID = 'jarvis-page-companion-host';
  const RECHECK_DEBOUNCE_MS = 600;
  // Identical to the cockpit's own openThreadWindow() (thread-window.ts) — same
  // dimensions and the same per-thread window name, so popping a thread out here
  // focuses the exact window the cockpit itself would reuse.
  const POPUP_FEATURES = 'width=480,height=760,menubar=no,toolbar=no,location=no,status=no';

  if (window.__jarvisPageCompanionLoaded) return; // double-inject guard
  window.__jarvisPageCompanionLoaded = true;

  let askedKey = null; // the page key we last asked about — once per page
  let recheckTimer = null;
  let current = null; // last positive lookup result
  let cockpitBase = null; // public base URL (no key) from the background worker
  let panelOpen = false;
  let activeExternalId = null; // which tab is selected

  function pageKey(raw) {
    try {
      const u = new URL(String(raw));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      if (!u.hostname) return null;
      const defaultPort =
        (u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443');
      const host = defaultPort ? u.hostname.toLowerCase() : u.host.toLowerCase();
      return `${host}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
      return null;
    }
  }

  // ─── THE DENY LIST — third copy, inline because MV3 forbids imports ────────
  // Byte-for-byte mirror of src/config.js (which mirrors the server's
  // page-companion.ts). The sentinels below are not decoration: test/deny.test.mjs
  // extracts everything between them, evaluates it, and asserts it answers
  // IDENTICALLY to config.js over the shared case table. Edit all three or none.
  //
  // This is the earliest chokepoint there is — a denied page never even sends a
  // message to the background worker, let alone a request to the cockpit.
  // deny-mirror:begin
  const DENIED_HOSTS = ['thedarwinhub.com', 'www.thedarwinhub.com'];
  const DENIED_PATH_PREFIXES = ['/track', '/api'];
  const DENY_ANY_QUERY_STRING = true;

  // 🔴 EXACT hostname match, NOT a domain suffix — intake./staging.intake./
  // accounting.thedarwinhub.com are IN scope and must stay askable.
  function isDeniedHost(hostname) {
    if (typeof hostname !== 'string') return false;
    const h = hostname.trim().toLowerCase().replace(/\.$/, '');
    return DENIED_HOSTS.includes(h);
  }

  function isDeniedPath(pathname) {
    if (typeof pathname !== 'string') return false;
    const p = pathname.toLowerCase();
    return DENIED_PATH_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
  }

  function isDeniedUrl(raw) {
    if (typeof raw !== 'string') return true;
    const trimmed = raw.trim();
    if (!trimmed) return true;
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
    if (hasScheme && !/^https?:\/\//i.test(trimmed)) return true;
    if (!hasScheme && trimmed.startsWith('/')) return true;
    let u;
    try {
      u = new URL(hasScheme ? trimmed : `http://${trimmed}`);
    } catch {
      return true;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
    if (!u.hostname) return true;
    if (isDeniedHost(u.hostname)) return true;
    if (isDeniedPath(u.pathname)) return true;
    if (DENY_ANY_QUERY_STRING && u.search) return true;
    return false;
  }
  // deny-mirror:end

  /** Kevin's HTML-signature idea (design doc): sent along for the server to use later. */
  function pageSignature() {
    const meta = document.querySelector('meta[name="jarvis-page"]');
    const content = meta?.getAttribute('content');
    return typeof content === 'string' && content.trim() ? content.trim() : null;
  }

  function ask() {
    // Deny gate first: no message, no request, nothing, on a denied page.
    if (isDeniedUrl(location.href)) return;
    const key = pageKey(location.href);
    if (!key || key === askedKey) return;
    askedKey = key;

    let responded = false;
    try {
      chrome.runtime.sendMessage(
        { type: MSG_LOOKUP, url: location.href, signature: pageSignature() },
        (response) => {
          responded = true;
          // The worker was asleep / the extension reloaded — not worth shouting about.
          if (chrome.runtime.lastError) return;
          if (!response?.ok) return;
          if (pageKey(location.href) !== key) return; // navigated while we waited
          if (response.result?.ours) {
            mount(response.result, response.cockpitBase);
            restoreLastTab();
          } else {
            unmount();
          }
        },
      );
    } catch {
      // Extension context invalidated (reload during dev). Allow a retry later.
      if (!responded) askedKey = null;
    }
  }

  function scheduleRecheck() {
    clearTimeout(recheckTimer);
    recheckTimer = setTimeout(ask, RECHECK_DEBOUNCE_MS);
  }

  // SPA navigation: the cockpit and most of our dashboards never reload, so the
  // load-time ask alone would miss every page after the first. `ask()` is keyed
  // on the page key, so these extra calls are free when nothing really changed.
  function watchNavigation() {
    window.addEventListener('popstate', scheduleRecheck);
    window.addEventListener('hashchange', scheduleRecheck);
    if (window.navigation?.addEventListener) {
      window.navigation.addEventListener('navigatesuccess', scheduleRecheck);
    } else {
      for (const name of ['pushState', 'replaceState']) {
        const original = history[name];
        if (typeof original !== 'function') continue;
        history[name] = function patched(...args) {
          const out = original.apply(this, args);
          scheduleRecheck();
          return out;
        };
      }
    }
  }

  // ── the button ──────────────────────────────────────────────────────────
  const STYLE = `
    :host { all: initial; }
    .wrap {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
      font: 500 13px/1.3 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .btn {
      position: relative; width: 48px; height: 48px; border-radius: 999px;
      border: 1px solid rgba(255,255,255,.18); background: #1f2a44; color: #eaf0ff;
      box-shadow: 0 6px 20px rgba(8,13,28,.38); cursor: pointer;
      display: grid; place-items: center; font-size: 20px; padding: 0;
      transition: transform .12s ease, box-shadow .12s ease;
    }
    .btn:hover { transform: translateY(-2px); box-shadow: 0 10px 26px rgba(8,13,28,.46); }
    .btn:focus-visible { outline: 2px solid #7aa2ff; outline-offset: 2px; }
    .badge {
      position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px;
      padding: 0 4px; border-radius: 999px; background: #2f6df6; color: #fff;
      font-size: 11px; font-weight: 700; display: grid; place-items: center;
      box-shadow: 0 0 0 2px #1f2a44;
    }
    .panel {
      position: absolute; right: 0; bottom: 60px; width: 420px; height: 520px;
      max-height: calc(100vh - 100px);
      background: #161e35; color: #eaf0ff; border: 1px solid rgba(255,255,255,.14);
      border-radius: 12px; box-shadow: 0 14px 36px rgba(8,13,28,.5);
      display: flex; flex-direction: column; overflow: hidden;
    }
    .panel[hidden] { display: none; }
    .panel-head {
      display: flex; align-items: center; gap: 8px; padding: 10px 8px 10px 14px;
      border-bottom: 1px solid rgba(255,255,255,.1); flex: none;
    }
    .panel-title { font-weight: 700; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .panel-actions { display: flex; gap: 2px; flex: none; }
    .icon-btn {
      border: 0; background: transparent; color: #eaf0ff; opacity: .72; cursor: pointer;
      width: 26px; height: 26px; border-radius: 6px; font-size: 14px; line-height: 1;
      display: grid; place-items: center; padding: 0;
    }
    .icon-btn:hover { opacity: 1; background: rgba(255,255,255,.08); }
    .icon-btn[hidden] { display: none; }
    .tabs {
      display: flex; gap: 4px; padding: 8px; overflow-x: auto; flex: none;
      border-bottom: 1px solid rgba(255,255,255,.1);
    }
    .tab {
      border: 1px solid rgba(255,255,255,.14); background: #1f2a44; color: #cdd8f5;
      border-radius: 999px; padding: 5px 11px; font: inherit; font-size: 12px;
      cursor: pointer; white-space: nowrap; flex: none; max-width: 170px;
      display: inline-flex; align-items: baseline; gap: 3px;
    }
    .tab-label { overflow: hidden; text-overflow: ellipsis; max-width: 120px; }
    .tab-rel { opacity: .65; font-size: 10.5px; flex: none; }
    .tab.active { background: #2f6df6; border-color: #2f6df6; color: #fff; }
    .tab.new { opacity: .8; }
    .tab:disabled { cursor: default; opacity: .5; }
    .frame-wrap { flex: 1; min-height: 0; position: relative; }
    .thread-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
    .empty, .error, .mixed-note {
      padding: 16px 14px; font-size: 12.5px; line-height: 1.5; opacity: .82;
    }
    .error { color: #ff9b9b; }
    .mixed-note .open-popout {
      display: block; margin-top: 10px; border: 0; border-radius: 7px; padding: 7px 12px;
      background: #2f6df6; color: #fff; font: 600 12.5px/1 inherit; cursor: pointer;
    }
  `;

  function mount(result, base) {
    current = result;
    if (base) cockpitBase = base;
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      const root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = STYLE;
      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      wrap.innerHTML = `
        <div class="panel" hidden>
          <div class="panel-head">
            <span class="panel-title"></span>
            <div class="panel-actions">
              <button class="icon-btn popout-btn" type="button" title="Pop out this chat" hidden>↗</button>
              <button class="icon-btn close-btn" type="button" aria-label="Close panel">×</button>
            </div>
          </div>
          <div class="tabs"></div>
          <div class="frame-wrap"></div>
        </div>
        <button class="btn" type="button" part="button">
          <span aria-hidden="true">🤖</span>
          <span class="badge" hidden></span>
        </button>`;
      root.append(style, wrap);
      (document.body ?? document.documentElement).appendChild(host);
      wireEvents(root);
    }
    paint(host.shadowRoot, result);
    if (panelOpen) refreshPanel(host.shadowRoot);
  }

  function wireEvents(root) {
    root.querySelector('.btn').addEventListener('click', () => togglePanel(root));
    root.querySelector('.close-btn').addEventListener('click', () => {
      panelOpen = false;
      root.querySelector('.panel').hidden = true;
    });
    root.querySelector('.popout-btn').addEventListener('click', () => popOut(activeExternalId));
    // Delegated: the tab list is rebuilt wholesale on every render.
    root.querySelector('.tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.new) { startNewChat(root); return; }
      const id = btn.dataset.id;
      if (id && id !== activeExternalId) {
        activeExternalId = id;
        renderTabs(root);
        renderFrame(root);
        saveLastTab(id);
      }
    });
  }

  /** Round-trips through the background worker — see note in background.js. */
  function saveLastTab(externalId) {
    try {
      chrome.runtime.sendMessage({ type: MSG_SET_LAST_TAB, url: location.href, externalId }, () => {
        void chrome.runtime.lastError; // best-effort; nothing actionable on failure
      });
    } catch {
      // extension context invalidated mid-reload — not worth retrying for this
    }
  }

  /** Re-selects whatever tab was last open on this exact page, if it still exists. */
  function restoreLastTab() {
    if (activeExternalId) return; // user (or this call, on a re-paint) already picked one
    try {
      chrome.runtime.sendMessage({ type: MSG_GET_LAST_TAB, url: location.href }, (response) => {
        if (chrome.runtime.lastError || !response?.ok || !response.externalId) return;
        if (activeExternalId) return; // raced with a user click while we waited
        const threads = Array.isArray(current?.threads) ? current.threads : [];
        if (!threads.some((th) => th.external_id === response.externalId)) return;
        activeExternalId = response.externalId;
        const root = document.getElementById(HOST_ID)?.shadowRoot;
        if (root && panelOpen) { renderTabs(root); renderFrame(root); }
      });
    } catch {
      // extension context invalidated mid-reload — fine, next page load retries
    }
  }

  function togglePanel(root) {
    panelOpen = !panelOpen;
    root.querySelector('.panel').hidden = !panelOpen;
    if (panelOpen) refreshPanel(root);
  }

  /** Tab bar + content area reflect current.threads and activeExternalId. */
  function refreshPanel(root) {
    if (!current) return;
    root.querySelector('.panel-title').textContent = current.project || 'JARVIS chats';
    const threads = Array.isArray(current.threads) ? current.threads : [];
    if (!activeExternalId || !threads.some((th) => th.external_id === activeExternalId)) {
      activeExternalId = threads[0]?.external_id ?? null;
    }
    renderTabs(root);
    renderFrame(root);
  }

  function parseServerDate(raw) {
    if (!raw) return null;
    const d = new Date(/[Tt]/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** "derive a display name client-side when [title is] null" — CONTRACT.md. */
  function deriveTitle(thread) {
    if (thread.title) return thread.title;
    const d = parseServerDate(thread.last_active);
    return d ? `Chat — ${d.toLocaleDateString()}` : 'Untitled chat';
  }

  /** Compact relative time for the tab strip ("title + relative last-active"). */
  function relativeTime(raw) {
    const d = parseServerDate(raw);
    if (!d) return '';
    const mins = Math.round((Date.now() - d.getTime()) / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return days < 7 ? `${days}d ago` : d.toLocaleDateString();
  }

  function renderTabs(root) {
    const threads = Array.isArray(current?.threads) ? current.threads : [];
    root.querySelector('.tabs').innerHTML =
      threads
        .map((th) => {
          const title = deriveTitle(th);
          const rel = relativeTime(th.last_active);
          return `<button class="tab${th.external_id === activeExternalId ? ' active' : ''}" type="button"
            data-id="${escapeHtml(th.external_id)}" title="${escapeHtml(title)}${rel ? ` · ${rel}` : ''}">
            <span class="tab-label">${escapeHtml(title)}</span>${rel ? `<span class="tab-rel">${escapeHtml(rel)}</span>` : ''}
          </button>`;
        })
        .join('') + `<button class="tab new" type="button" data-new="1">+ New</button>`;
  }

  /** host[:port]/thread/<id> — the cockpit's own pop-out route, verbatim. */
  function threadUrl(base, externalId, project) {
    const q = project ? `?group=${encodeURIComponent(project)}` : '';
    return `${base}/thread/${encodeURIComponent(externalId)}${q}`;
  }

  /** An https page can't iframe a plain-http cockpit — the browser blocks it as
   *  mixed content. An https cockpit, or an http page, is always fine. */
  function canEmbed(base) {
    if (!base) return false;
    try {
      return !(location.protocol === 'https:' && new URL(base).protocol !== 'https:');
    } catch {
      return false;
    }
  }

  function popOut(externalId) {
    if (!cockpitBase || !externalId) return;
    window.open(threadUrl(cockpitBase, externalId, current?.project), `jarvis-thread-${externalId}`, POPUP_FEATURES);
  }

  function renderFrame(root) {
    const wrap = root.querySelector('.frame-wrap');
    const popoutBtn = root.querySelector('.popout-btn');
    if (!activeExternalId || !cockpitBase) {
      popoutBtn.hidden = true;
      wrap.innerHTML = '<div class="empty">No chat selected yet — start one with “+ New”.</div>';
      return;
    }
    popoutBtn.hidden = false;
    if (canEmbed(cockpitBase)) {
      wrap.innerHTML =
        `<iframe class="thread-frame" src="${escapeHtml(threadUrl(cockpitBase, activeExternalId, current.project))}"></iframe>`;
      return;
    }
    // Mixed content: this page is https, the cockpit isn't, so the iframe would
    // be blocked outright. Pop it out instead — still inside the click's user
    // gesture, so the browser won't treat it as an unsolicited popup.
    wrap.innerHTML = `
      <div class="mixed-note">
        This page is secure (https); the cockpit chat isn't, so it can't load inside this panel.
        Opening it in its own window instead.
        <button class="open-popout" type="button">Open chat ↗</button>
      </div>`;
    wrap.querySelector('.open-popout').addEventListener('click', () => popOut(activeExternalId));
    popOut(activeExternalId);
  }

  function startNewChat(root) {
    const newBtn = root.querySelector('.tab.new');
    if (newBtn) { newBtn.disabled = true; newBtn.textContent = 'Starting…'; }
    chrome.runtime.sendMessage(
      { type: MSG_NEW_CHAT, url: location.href, project: current?.project },
      (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          if (newBtn) { newBtn.disabled = false; newBtn.textContent = '+ New'; }
          root.querySelector('.frame-wrap').innerHTML =
            `<div class="error">Couldn't start a new chat${response?.error ? `: ${escapeHtml(response.error)}` : ''}.</div>`;
          return;
        }
        const t = response.result;
        current.threads = [
          { external_id: t.external_id, title: null, last_active: new Date().toISOString() },
          ...(Array.isArray(current.threads) ? current.threads : []),
        ];
        activeExternalId = t.external_id;
        paint(root, current);
        renderTabs(root);
        renderFrame(root);
        saveLastTab(t.external_id);
      },
    );
  }

  function paint(root, result) {
    const count = Array.isArray(result.threads) ? result.threads.length : 0;
    const badge = root.querySelector('.badge');
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.hidden = count === 0;
    root.querySelector('.btn').title = result.project
      ? `${result.project} — ${count} JARVIS chat${count === 1 ? '' : 's'} about this page`
      : `${count} JARVIS chat${count === 1 ? '' : 's'} about this page`;
    root.querySelector('.btn').setAttribute('aria-label', root.querySelector('.btn').title);
    // Data the panel node reads straight off the DOM instead of re-querying.
    root.host.dataset.project = result.project ?? '';
    root.host.dataset.threads = String(count);
  }

  function unmount() {
    current = null;
    panelOpen = false;
    activeExternalId = null;
    document.getElementById(HOST_ID)?.remove();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  watchNavigation();
  ask();
})();
