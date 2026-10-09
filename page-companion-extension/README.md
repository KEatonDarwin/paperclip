# JARVIS Page Companion — Chrome extension (v0.1)

Tree `tree-e753d989`, nodes #1574–#1576. Design: `outbox/page-companion-concept-2026-10-09.md`.
Server contract: `darwin-assistant/docs/page-companion/CONTRACT.md`.

Kevin opens a page. The extension asks the cockpit "is this one of ours?". If it
is, a floating button appears bottom-right with a badge counting the cockpit
chats that already touched that page. If it isn't, **nothing happens at all** —
not one node, not one stylesheet.

Clicking the button opens a panel with one tab per related chat — each an
embedded `/thread/<external_id>` iframe, with a pop-out to the cockpit's own
thread window — plus **+ New** to start a fresh chat scoped to that page. The
last tab open on a page is reopened the next time you land on it.

## Install

No build step — plain JS/CSS on purpose.

1. `chrome://extensions` → **Developer mode** on → **Load unpacked**
2. Pick this directory (`page-companion-extension/`)
3. Click the extension's **Details → Extension options** (or the toolbar icon)
4. Fill in the cockpit base URL and Save. **Test connection** proves it end to end.

## Options

| Field | What to put |
|---|---|
| **Cockpit base URL** | However you actually reach the cockpit — `http://192.168.1.25:8080`, or a Tailscale MagicDNS name. A bare host is fine; `http://` is assumed. |
| **API base** (optional) | Leave blank. Set it only to bypass the derivation below. |
| **Bearer API key** | `JARVIS_COCKPIT_KEY` from `jarvis-command-center/.env`. **Optional** when going through the `:8080` proxy — the cockpit injects its own key server-side. Required when talking straight to JARVIS. |

How the API base is derived from the cockpit base (`src/config.js`,
`resolveApiBase`, unit-tested):

| cockpit base | lookups POST to |
|---|---|
| `http://host:8080` | `http://host:8080/cockpit-api/page-companion/lookup` |
| `http://host:3201` | `http://host:3201/api/v1/page-companion/lookup` |
| `http://host:3201/api/v1` | taken as-is (an explicit path is believed) |

The options page shows the resolved URL live, so there is never any guessing
about which rule fired.

## How it's wired

```
content.js  (page world, no key, no fetch)
   │  chrome.runtime.sendMessage { url, signature }
   ▼
background.js  (service worker — the ONLY place the key is read)
   │  POST <apiBase>/page-companion/lookup   + 30s per-page cache
   ▼
{ ours, project, registry_id, threads[], normalized_url }
   │
   ▼
content.js → Shadow DOM button + badge + panel (only when ours === true)
```

The panel's **+ New** and the per-page last-tab memory take the same route: the
content script messages the worker, which POSTs `/page-companion/new-chat` or
reads/writes `chrome.storage.local` on its behalf.

- **The key never reaches a page.** The content script has no `fetch`, no
  `chrome.storage` and no `Authorization` — it asks the worker and gets an
  answer. A test asserts this stays true.
- **The background worker trusts `sender.tab.url`, not the message body** — a
  page can talk to its content script; it can't fake where it is.
- **Shadow DOM, `mode: 'open'`** — page CSS can't restyle our button and our CSS
  can't leak into the page.
- **SPA-aware.** The cockpit and most of our dashboards never do a real page
  load, so `popstate` / `hashchange` / the Navigation API (falling back to
  patched `pushState`/`replaceState`) trigger a debounced re-ask. It's keyed on
  the canonical page key, so a query-string change costs nothing.
- **Kevin's HTML-signature idea** (`<meta name="jarvis-page" content="…">`) is
  read and sent along as `signature`. The server ignores it today; the field is
  there so the fallback can land without touching the extension.

## Tests

```
npm test                              # 16 unit tests, no deps, no network
xvfb-run -a node test/e2e-browser.mjs # 22 real-browser assertions
```

Server side, from `darwin-assistant/`:

```
npm run page-companion:check        # 47 unit tests (registry, lookup, seeding, deny list)
npm run page-companion:route-check  # 86 route checks against the real router
```

## The deny list

`src/config.js` carries the hosts/endpoints the companion must never ask about —
Hub 1.0 (`thedarwinhub.com`, `www.thedarwinhub.com`, **exact hosts**, so
`intake.`/`staging.intake.`/`accounting.` subdomains stay in scope), `/track*`
and `/api/*` on any host, and any URL with a query string. `content.js` carries
an inline copy (MV3 forbids imports) between `deny-mirror:begin/end` sentinels;
the server carries a third in `darwin-assistant/src/page-companion.ts`. All
three are proven identical by `test/deny.test.mjs` and the server's
`page-companion:check`, over the shared table in `test/deny-cases.mjs`. **Edit
all three or none.** Full rationale: `darwin-assistant/docs/page-companion/CONTRACT.md`.

`test/e2e-browser.mjs` is the real proof: it mounts the **real** Express
`/page-companion` router on a scratch `/tmp` sqlite DB, serves a registered and
an unregistered static page, loads this extension unpacked into a real Chromium,
configures it through the real options page, drives the panel (tab switching,
pop-out, **+ New**, last-tab restore), and asserts the button appears with the
right count on one page and that the other page's DOM comes out byte-identical
to what the server sent. Hermetic: no live DB, no network beyond 127.0.0.1, zero
model calls. It borrows Playwright from `jarvis-command-center/node_modules`
(override with `PLAYWRIGHT_DIR`); this extension has no dependencies of its own.

`E2E_SHOT=/tmp/shot.png` writes a screenshot of the button in situ.

## Not done here (next nodes)

- Firefox port (MV3 ports over nearly as-is).
