// Page Companion — background service worker.
//
// This worker owns EVERY network call and is the only place the bearer key is
// read. Content scripts run in the page's world; handing them a cockpit key
// would publish it to whatever page Kevin happens to be on. They ask, we fetch.

import {
  endpointFor, shouldAskAboutUrl, pageKey, badgeLabel, normalizeLookup, normalizeDeployment,
  deploymentLine, withDefaults, normalizeBase,
} from './config.js';

const MSG_LOOKUP = 'page-companion:lookup';
const MSG_NEW_CHAT = 'page-companion:new-chat';
const MSG_GET_LAST_TAB = 'page-companion:get-last-tab';
const MSG_SET_LAST_TAB = 'page-companion:set-last-tab';
const MSG_DEPLOYMENT = 'page-companion:deployment';
const CACHE_TTL_MS = 30_000;
const LOOKUP_TIMEOUT_MS = 6_000;
// Branch awareness is a nice-to-have on an already-open panel, so it gets its
// own (shorter) budget and its own cache — it must never be able to slow or
// break a lookup. The server caches per target for 60s too; this just stops a
// panel being toggled from making a request per click.
const DEPLOY_TIMEOUT_MS = 8_000;
const DEPLOY_CACHE_TTL_MS = 60_000;
// { [pageKey]: external_id } — which tab was open last, per page. Separate
// storage key from the settings fields so withDefaults() never sees it.
const LAST_TABS_KEY = 'lastTabs';

/** pageKey -> { at, result } — collapses the reload/SPA storm into one call. */
const cache = new Map();
/** registry_id -> { at, result|null } — null is cached too, so a dead deploy
 *  source is not re-asked on every panel toggle. */
const deployCache = new Map();

async function settings() {
  const stored = await chrome.storage.local.get(null);
  return withDefaults(stored);
}

function cached(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.result;
}

async function lookup(url) {
  // THE DENY GATE. A denied page (Hub 1.0, /track*, /api/*, anything with a
  // query string — see config.js) gets the ordinary miss without a network call
  // ever being made, so it is indistinguishable from a page that simply isn't
  // registered. The content script refuses first; this is the backstop for any
  // other caller of the worker.
  if (!shouldAskAboutUrl(url)) {
    return { ours: false, project: null, registry_id: null, normalized_url: null, threads: [] };
  }

  const key = pageKey(url);
  const hit = key ? cached(key) : null;
  if (hit) return hit;

  const cfg = await settings();
  if (!cfg.enabled) throw new Error('Page Companion is switched off in options');

  const endpoint = endpointFor(cfg, 'lookup');
  if (!endpoint) throw new Error('No cockpit base URL configured — open the extension options');

  const headers = { 'Content-Type': 'application/json' };
  // Optional on the /cockpit-api path (the cockpit proxy holds its own key),
  // required when pointing straight at JARVIS on :3201.
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url }),
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`lookup ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  const result = normalizeLookup(await res.json());
  if (key) cache.set(key, { at: Date.now(), result });
  return result;
}

// Starts a page-scoped chat server-side (zero model calls — see CONTRACT.md)
// and invalidates that page's lookup cache so the next lookup lists it.
async function newChat(url, project) {
  if (!shouldAskAboutUrl(url)) throw new Error('Page Companion does not operate on this page');
  const cfg = await settings();
  if (!cfg.enabled) throw new Error('Page Companion is switched off in options');

  const endpoint = endpointFor(cfg, 'new-chat');
  if (!endpoint) throw new Error('No cockpit base URL configured — open the extension options');

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url, project: typeof project === 'string' && project ? project : undefined }),
    signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`new-chat ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
  }

  const data = await res.json();
  const key = pageKey(url);
  if (key) cache.delete(key);
  return data;
}

// "Remember last-selected tab per normalized URL in chrome.storage.local"
// (design doc) — the content script never touches chrome.storage itself
// (see test/config.test.mjs), so it round-trips through us like everything else.
async function getLastTab(url) {
  const key = pageKey(url);
  if (!key) return null;
  const stored = await chrome.storage.local.get(LAST_TABS_KEY);
  const map = stored?.[LAST_TABS_KEY];
  return map && typeof map === 'object' && typeof map[key] === 'string' ? map[key] : null;
}

async function setLastTab(url, externalId) {
  const key = pageKey(url);
  if (!key || typeof externalId !== 'string' || !externalId) return;
  const stored = await chrome.storage.local.get(LAST_TABS_KEY);
  const map = stored?.[LAST_TABS_KEY] && typeof stored[LAST_TABS_KEY] === 'object' ? stored[LAST_TABS_KEY] : {};
  map[key] = externalId;
  await chrome.storage.local.set({ [LAST_TABS_KEY]: map });
}

/**
 * Which branch is live on the host serving this page. Returns null for every
 * failure mode — no target, unknown answer, HTTP error, timeout, no config —
 * because the panel's contract is "render the line or render nothing".
 */
async function deployment(registryId) {
  if (!Number.isInteger(registryId) || registryId <= 0) return null;

  const hit = deployCache.get(registryId);
  if (hit && Date.now() - hit.at < DEPLOY_CACHE_TTL_MS) return hit.result;

  let result = null;
  try {
    const cfg = await settings();
    const endpoint = cfg.enabled ? endpointFor(cfg, 'deployment') : '';
    if (endpoint) {
      const headers = {};
      if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
      const res = await fetch(`${endpoint}?registry_id=${encodeURIComponent(registryId)}`, {
        headers,
        signal: AbortSignal.timeout(DEPLOY_TIMEOUT_MS),
      });
      if (res.ok) result = normalizeDeployment(await res.json());
    }
  } catch {
    result = null; // a branch line is never worth surfacing an error for
  }
  deployCache.set(registryId, { at: Date.now(), result });
  return result;
}

function paintBadge(tabId, result) {
  if (typeof tabId !== 'number') return;
  const text = result.ours ? badgeLabel(result.threads) || '•' : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  if (text) chrome.action.setBadgeBackgroundColor({ tabId, color: '#2f6df6' }).catch(() => {});
  chrome.action
    .setTitle({
      tabId,
      title: result.ours
        ? `JARVIS Page Companion — ${result.project ?? 'ours'} · ${result.threads.length} chat${result.threads.length === 1 ? '' : 's'}`
        : 'JARVIS Page Companion',
    })
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Trust the sender's own URL over anything in the message body — a page can
  // talk to a content script, and a content script can be coaxed into lying.
  const url = sender?.tab?.url || sender?.url || (typeof message.url === 'string' ? message.url : '');

  if (message?.type === MSG_LOOKUP) {
    Promise.all([lookup(url), settings()])
      .then(([result, cfg]) => {
        paintBadge(sender?.tab?.id, result);
        // The panel needs the public base URL (never the key) to build
        // /thread/<external_id> links for the embedded iframe and pop-out.
        sendResponse({ ok: true, result, cockpitBase: normalizeBase(cfg.cockpitBase) });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      });
    return true; // async sendResponse
  }

  if (message?.type === MSG_NEW_CHAT) {
    newChat(url, message?.project)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      });
    return true; // async sendResponse
  }

  if (message?.type === MSG_DEPLOYMENT) {
    // The worker formats the line too (it can import config.js; a content
    // script cannot), so there is no fourth mirrored copy of this logic to keep
    // honest — content.js just prints what it is handed, or nothing.
    deployment(typeof message.registryId === 'number' ? message.registryId : NaN)
      .then((result) => sendResponse({ ok: true, result, line: deploymentLine(result) }))
      .catch(() => sendResponse({ ok: true, result: null, line: '' }));
    return true; // async sendResponse
  }

  if (message?.type === MSG_GET_LAST_TAB) {
    getLastTab(url)
      .then((externalId) => sendResponse({ ok: true, externalId }))
      .catch(() => sendResponse({ ok: true, externalId: null }));
    return true; // async sendResponse
  }

  if (message?.type === MSG_SET_LAST_TAB) {
    setLastTab(url, message?.externalId)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    return true; // async sendResponse
  }

  return false;
});

// A settings change invalidates the lookup cache (it was answered by the old
// endpoint); a lastTabs-only write did not change what any endpoint returns.
chrome.storage.onChanged.addListener((changes) => {
  if (Object.keys(changes).some((k) => k !== LAST_TABS_KEY)) { cache.clear(); deployCache.clear(); }
});

// Clicking the toolbar icon opens options; the in-page button is the real
// surface, and this is the escape hatch when it hasn't appeared.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
