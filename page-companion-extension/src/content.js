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
  const HOST_ID = 'jarvis-page-companion-host';
  const RECHECK_DEBOUNCE_MS = 600;

  if (window.__jarvisPageCompanionLoaded) return; // double-inject guard
  window.__jarvisPageCompanionLoaded = true;

  let askedKey = null; // the page key we last asked about — once per page
  let recheckTimer = null;
  let current = null; // last positive lookup result

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

  /** Kevin's HTML-signature idea (design doc): sent along for the server to use later. */
  function pageSignature() {
    const meta = document.querySelector('meta[name="jarvis-page"]');
    const content = meta?.getAttribute('content');
    return typeof content === 'string' && content.trim() ? content.trim() : null;
  }

  function ask() {
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
          if (response.result?.ours) mount(response.result);
          else unmount();
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
    .note {
      /* The wrap shrink-to-fits to the 48px button, so an absolutely positioned
         child needs an explicit width or it wraps one word per line. */
      position: absolute; right: 0; bottom: 60px; width: 250px;
      background: #1f2a44; color: #eaf0ff; border: 1px solid rgba(255,255,255,.14);
      border-radius: 10px; padding: 10px 12px; box-shadow: 0 10px 28px rgba(8,13,28,.44);
    }
    .note .project { font-weight: 700; margin-bottom: 4px; }
    .note .muted { opacity: .72; font-weight: 400; }
    .note[hidden] { display: none; }
  `;

  function mount(result) {
    current = result;
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
        <div class="note" hidden></div>
        <button class="btn" type="button" part="button">
          <span aria-hidden="true">🤖</span>
          <span class="badge" hidden></span>
        </button>`;
      root.append(style, wrap);
      (document.body ?? document.documentElement).appendChild(host);
      root.querySelector('.btn').addEventListener('click', onClick);
    }
    paint(host.shadowRoot, result);
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
    document.getElementById(HOST_ID)?.remove();
  }

  // Panel stub — the real panel (tabbed iframes of /thread/<external_id>) is the
  // next node. For now: say what we found and prove the data arrived.
  function onClick() {
    const root = document.getElementById(HOST_ID)?.shadowRoot;
    if (!root || !current) return;
    const note = root.querySelector('.note');
    const names = current.threads
      .slice(0, 4)
      .map((t) => `• ${escapeHtml(t.title ?? t.external_id)}`)
      .join('<br>');
    note.innerHTML = `
      <div class="project">${escapeHtml(current.project ?? 'A JARVIS page')}</div>
      <div class="muted">${current.threads.length} related chat${current.threads.length === 1 ? '' : 's'}</div>
      ${names ? `<div class="muted" style="margin-top:6px">${names}</div>` : ''}
      <div class="muted" style="margin-top:6px">Chat panel lands in the next build.</div>`;
    note.hidden = !note.hidden;
    console.log('[JARVIS Page Companion]', current);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  watchNavigation();
  ask();
})();
