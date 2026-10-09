// Page Companion — background service worker.
//
// This worker owns EVERY network call and is the only place the bearer key is
// read. Content scripts run in the page's world; handing them a cockpit key
// would publish it to whatever page Kevin happens to be on. They ask, we fetch.

import {
  endpointFor, isAskableUrl, pageKey, badgeLabel, normalizeLookup, withDefaults, normalizeBase,
} from './config.js';

const MSG_LOOKUP = 'page-companion:lookup';
const MSG_NEW_CHAT = 'page-companion:new-chat';
const CACHE_TTL_MS = 30_000;
const LOOKUP_TIMEOUT_MS = 6_000;

/** pageKey -> { at, result } — collapses the reload/SPA storm into one call. */
const cache = new Map();

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
  if (!isAskableUrl(url)) return { ours: false, project: null, registry_id: null, normalized_url: null, threads: [] };

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

  return false;
});

// Settings changed → everything we cached was answered by the old endpoint.
chrome.storage.onChanged.addListener(() => cache.clear());

// Clicking the toolbar icon opens options; the in-page button is the real
// surface, and this is the escape hatch when it hasn't appeared.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
