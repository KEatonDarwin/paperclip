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

1. The four hand-listed dashboards (`MANUAL_PAGE_REGISTRY_SEED`), upserted by
   pattern: `:8100/*` Hub 1.0 Heartbeat · `:8095/*` Restore Matrix + Leaks ·
   `:8094/*` Circle & Flip · `:8090/*` Engine Docs (all on 192.168.1.25).
   A project name Kevin later edits is **never** clobbered by a re-seed.
2. `thread_links_auto` rows for every distinct http(s) thread-link page **not
   already covered** by a row — so one `…:8100/*` row stops a hundred per-page
   auto rows appearing beneath it. Project name = the link's label, else the
   owning thread's title, else the page key.

## Tests

Hermetic, no live DB, no network, no model calls:

```
npm run page-companion:check        # 31 unit tests  (scripts/page-companion-check.mjs)
npm run page-companion:route-check  # 55 route tests (the real Express router over HTTP)
```
