// Page Companion — background service worker.
//
// This worker owns EVERY network call and is the only place the bearer key is
// read. Content scripts run in the page's world; handing them a cockpit key
// would publish it to whatever page Kevin happens to be on. They ask, we fetch.

import { endpointFor, isAskableUrl, pageKey, badgeLabel, normalizeLookup, withDefaults } from './config.js';

const MSG_LOOKUP = 'page-companion:lookup';
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
  if (message?.type !== MSG_LOOKUP) return false;

  // Trust the sender's own URL over anything in the message body — a page can
  // talk to a content script, and a content script can be coaxed into lying.
  const url = sender?.tab?.url || sender?.url || (typeof message.url === 'string' ? message.url : '');

  lookup(url)
    .then((result) => {
      paintBadge(sender?.tab?.id, result);
      sendResponse({ ok: true, result });
    })
    .catch((err) => {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });

  return true; // async sendResponse
});

// Settings changed → everything we cached was answered by the old endpoint.
chrome.storage.onChanged.addListener(() => cache.clear());

// Clicking the toolbar icon opens options; the in-page button is the real
// surface, and this is the escape hatch when it hasn't appeared.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
