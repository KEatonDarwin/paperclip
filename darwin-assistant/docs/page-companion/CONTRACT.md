# Page Companion — server contract (v0.1)

Tree `tree-e753d989`, node #1574. Design: `outbox/page-companion-concept-2026-10-09.md`.

The question this answers: **Kevin just loaded a page — is it one of ours, and
which cockpit chats already talk about it?** The Chrome extension (node #2+)
codes against the shapes below; nothing here is allowed to drift without
updating this file.

Implementation: `src/page-companion.ts`. Routes: `src/handlers/api-v1.ts`
(`/page-companion/*`). Auth: the usual `/api/v1` bearer key.

## The canonical page key

Every comparison happens on ONE normalized form, `host[:port]/path`:

| dropped | kept |
|---|---|
| scheme (`http`/`https` are never different pages) | host, lowercased |
| default ports (`:80`, `:443`) | non-default ports |
| query string, hash | path, **case preserved** (hosts are case-insensitive, paths are not) |
| trailing slash (`host/a/` → `host/a`, `host/` → `host`) | |

`https://HOST:8100/goals/?tab=x#y` → `host:8100/goals`.

`normalizePageUrl` returns **null** (→ `ours:false`, never an error) for
anything that isn't an http(s) URL with a host: `chrome://`, `file://`,
`about:`, relative paths, junk. A bare `host:8100/path` is accepted as a
convenience (that's how patterns get typed by hand).

## `page_registry`

| column | notes |
|---|---|
| `id` | |
| `url_pattern` | **UNIQUE**, stored canonically. Exact key, or a wildcard (below). |
| `project` | human name shown on the page button ("Hub 1.0 Heartbeat") |
| `primary_thread_ext` | optional owning chat's `external_id` |
| `source` | `manual` · `thread_links_auto` · `signature` |
| `created_at` / `updated_at` | |

Wildcards, both deliberate:

- `host:8100/*` — the host root **and** everything under it, on a path-segment
  boundary. Will not bleed into `host:81009` or a different port.
- `host/dash*` — a raw string prefix (`host/dashboard` matches). For the
  occasional "every URL starting with this".
- no `*` — exact. An exact row does **not** swallow its children.

On a lookup the **most specific covering row wins**: longest pattern, with an
exact row beating a wildcard of the same length.

## Routes

### `POST /page-companion/lookup` → 200

Body `{ "url": "<the page the browser is on>" }` (required, non-empty string;
anything else → 400).

```json
{ "ours": true,
  "project": "Hub 1.0 Heartbeat",
  "registry_id": 1,
  "threads": [{ "external_id": "cockpit:page-…", "title": "…", "last_active": "2026-10-09 16:02:56" }],
  "normalized_url": "192.168.1.25:8100/heartbeat" }
```

- `ours` = a registry row matched **OR** at least one chat has linked this page.
- `threads` = the union of the registry row's `primary_thread_ext` and every
  conversation with a `thread_links` row normalizing to the same key.
  Deduped, **newest activity first** (`last_active` = newest turn, falling back
  to the conversation's `updated_at`), each conversation listed once.
  `ephemeral:` / `checkin:` conversations are never listed.
- `title` is the thread's stored title, or `null` — derive a display name
  client-side when it's null, same as the cockpit sidebar does.
- A `/settings/vault?file=…` link (the cockpit's wiki viewer) is **never** a
  page — it can't make a page ours and it never becomes a registry row.
- A non-page URL answers `ours:false` with `normalized_url:null`. The extension
  asks about every page Kevin opens; that is not an error.

### `POST /page-companion/new-chat` → 201

Body `{ "url": "…", "project": "…"? }`. `project` defaults to the matching
registry row's name. Bad URL → 400 (and no thread is created).

```json
{ "external_id": "cockpit:page-<uuid>", "conversation_id": 12,
  "project": "Hub 1.0 Heartbeat", "page_url": "http://…", "created": true }
```

Creates a cockpit conversation whose **first turn is an assistant turn** pinning
the page URL + project — the teams-radar pattern, so opening a chat from a page
costs **zero model calls** until Kevin types something. Writes the
`thread_links` preview row immediately, so the page lists this chat on the very
next lookup. That's the loop: a page accumulates its own chat history.

### `GET /page-companion/registry` → `{ pages: [...] }`

### `POST /page-companion/registry` → 201

Body `{ url_pattern, project, primary_thread_ext?, source? }`. Idempotent on the
canonical pattern — re-registering updates the row instead of duplicating it.
This is the "any time I ship a page, add a registry row in the same turn" path.

### `POST /page-companion/seed` → `{ manual_added, auto_added, skipped_covered }`

Re-runs the back-fill. Also runs once at boot (`src/index.ts`).

## Seeding

Idempotent by construction — a second run adds nothing:

1. The hand-listed dashboards (`MANUAL_PAGE_REGISTRY_SEED`, **79 rows**),
   upserted by pattern. A project name Kevin later edits is **never** clobbered
   by a re-seed. Three source tables, composed in that order:
   - `LAN_DASHBOARD_SEED` (4) — the self-hosted listeners on 192.168.1.25:
     `:8100/*` Hub 1.0 Heartbeat · `:8095/*` Restore Matrix + Leaks ·
     `:8094/*` Circle & Flip · `:8090/*` Engine Docs.
   - `INTAKE_DASHBOARD_ROUTES` (23) × `INTAKE_HOSTS` (2) = **46** — derived from
     `DarwinIntakeSystem routes/web.php` (68 GET-reachable definitions; the other
     45 are denied, live machinery, `dd()` debug dumps, or JSON/test endpoints).
     Registered on `intake.thedarwinhub.com` *and*
     `staging.intake.thedarwinhub.com` because they are separate deploy targets
     on separate branches — a chat about staging is a different thing.
   - `ACCOUNTING_DASHBOARD_ROUTES` (29) — `accounting.thedarwinhub.com`, derived
     from the live app's `routes/web.php` + `routes/web-dashboard.php`, read
     read-only off the hub (there is no checkout on the pi).

   Two shapes worth not undoing:
   - **`/deploy` is EXACT, not `/deploy/*`** — `/deploy/{identifier}/execute`
     runs a deploy on a plain GET, so it must stay unregistered.
     `/deploy/history/*` is its own row.
   - **`/api-intake-monitor` and `/api-audit-logs` are dashboards**, not API
     paths. Rule (b) matches on a path-segment boundary, so they pass; a test
     asserts they are NOT denied, because loosening that rule to a bare
     `startsWith` would dark two live dashboards silently.

   Known cost, accounting only: `web-dashboard.php` aliases several URLs onto one
   blade view (`/quickbooks-dashboard` = `/dashboard/quickbooks` = `/qb-dashboard`
   = `/transfers`). Each alias is a distinct page key, so each gets a row and the
   project *name* is shared — but the chat lists do not merge across aliases.
   Fixing that needs a `canonical_of` column and is deliberately not done.

   Route map for Kevin's approval: `outbox/page-companion/route-map.md`.
   Out of the manual seed on purpose: `perclickity.thedarwinhub.com` (its live
   interstitial is `/link`, which the deny list does not cover) and
   `health.thedarwinhub.com` (`/overwatch` already self-registers via a thread
   link).
2. `thread_links_auto` rows for every distinct http(s) thread-link page **not
   already covered** by a row — so one `…:8100/*` row stops a hundred per-page
   auto rows appearing beneath it. Project name = the link's label, else the
   owning thread's title, else the page key.

## The deny list (v0.2 — tree `tree-b0198a82`, node #1584)

Hosts and endpoints the companion must **never** ask about. This table is the
ONE source of truth for "may this page ever be looked up or registered", it
gates every entry point *before* the registry or `thread_links` is consulted,
and it is mirrored in three places that are proven identical by tests:

| copy | where |
|---|---|
| server | `src/page-companion.ts` — `DENIED_HOSTS`, `DENIED_PATH_PREFIXES`, `DENY_ANY_QUERY_STRING`, `isDeniedPageUrl`, `isDeniedPagePattern` |
| extension logic | `page-companion-extension/src/config.js` — same names, plus `shouldAskAboutUrl` |
| content script | `page-companion-extension/src/content.js`, inline between `deny-mirror:begin/end` (MV3 content scripts cannot import) |

The rules:

- **(a) host** — exactly `thedarwinhub.com` and `www.thedarwinhub.com` (Hub 1.0),
  any port, case-insensitive, trailing dot tolerated. 🔴 **An EXACT hostname
  match, never a domain suffix.** `intake.thedarwinhub.com`,
  `staging.intake.thedarwinhub.com` and `accounting.thedarwinhub.com` are
  subdomains of it and are **in scope** — an `endsWith('thedarwinhub.com')`
  check here kills the whole feature. Both halves are asserted in one test.
- **(b) path, on every host** — `/track` and `/api`, matched on a path-segment
  boundary (`/track/test` denied, `/tracking-dashboard` **not**). The live
  lead/click machinery and the internal APIs.
- **(c) query string** — any URL carrying one is denied, on every host.
  Hub-family admin pages write on a bare `?param=` GET and the canonical key
  drops the query anyway. **Known cost:** a dashboard reached as
  `…/leaks?brand=x` has no companion button until Kevin lands on the
  query-free URL. Narrowing this to a host list is a one-line change in each
  of the three copies.
- **(d)** non-http(s) and unparseable URLs stay refused, as before.

Why Hub 1.0 is out permanently (Kevin, 2026-10-09): page-to-chat mapping has no
value where the chats are about breakage and running numbers rather than editing
the page, and ~51 Hub 1.0 pages write to the live DB on a bare `?param=` GET.

How a deny behaves at each entry point:

| entry point | denied behaviour |
|---|---|
| `POST /lookup` | **200** with the ordinary miss — `{ours:false, project:null, registry_id:null, threads:[], normalized_url:null}`. Never an error, never a distinct status: the extension asks about every page, so a deny that looked different from a miss would itself leak a signal about the page. A pre-existing registry row or thread link for a denied key **cannot** resurrect it — the gate runs first. |
| `POST /registry` | **400 `denied_url_pattern`**. A loud refusal on purpose: this caller is Kevin or JARVIS registering on purpose, so a silent no-op would be worse. Wildcards are stripped before the check, so `…/track*` is denied. A denied page can never be registered by hand. |
| `POST /new-chat` | **400**, the *same* `invalid_url` a bad URL gets, and no thread is created (a page chat writes a `thread_links` row, which is exactly how a page would otherwise auto-register on the next seed). |
| seeding | denied manual seed rows and denied thread links are skipped — no auto row. |
| extension | `shouldAskAboutUrl` in `background.js` (`lookup` *and* `newChat`, before any fetch) and the inline mirror in `content.js` `ask()`, before `chrome.runtime.sendMessage`. A denied page never even generates a request. |

## Tests

Hermetic, no live DB, no network, no model calls:

```
npm run page-companion:check        # 52 unit tests  (scripts/page-companion-check.mjs)
npm run page-companion:route-check  # 86 route tests (the real Express router over HTTP)
```

Extension side, from `page-companion-extension/`: `npm test` — 26 tests, of
which 10 are the deny list (`test/deny.test.mjs`).

The route-map seed adds 5 of those unit tests (`MANUAL_PAGE_REGISTRY_SEED — the
public route map`): every row canonicalizes and is unique; **no seeded row is
denied** (a denied row is silently skipped by the seeder, so without this a typo
would produce a dashboard that never gets a button and never complains);
`/api-intake-monitor` + `/api-audit-logs` are not denied while `/api/*` and
`/track` still are; **longest-pattern-wins is regression-locked** with three
overlapping patterns on one host (host prefix < path prefix < exact), which is
the property the whole route-keyed design rests on; and the real seeded map
resolves 16 spot-checked URLs to their own rows.

The deny cases live in ONE shared table, `page-companion-extension/test/deny-cases.mjs`
(50 URL cases + 16 pattern cases), read by all three suites — that is what keeps
the three copies honest. Each deny test was proven to FAIL against the wrong
implementation: suffix-match host deny, bare-`startsWith` path deny, the registry
upsert refusal removed, the `lookupPage` gate removed, and the `content.js`
`ask()` gate removed.
