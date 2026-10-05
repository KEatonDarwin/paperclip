# Cockpit auth/session recon — for "her own login: scoped guest access from iPhone"

Node #1353, tree-a2479fea. Recon only, no code changes.

## TL;DR

There is **no per-user auth concept anywhere in this stack today.** The whole
cockpit is a single shared admin principal. The browser (jarvis-command-center)
has zero session/cookie layer — it blindly forwards every request to JARVIS
using one server-held key. The backend (darwin-assistant) has a flat
`api_keys` table with a bare `scope` string and no JSON claim column, and
thread-level scoping is done by string-prefix convention, not a real ACL.

Building "her own scoped guest login" means adding a new layer, not flipping
a flag that already exists — but there's a recent, very close precedent
(the Big Board kiosk token) that's the fastest path to copy from.

## (a) DB file + schema

- Live DB: **`/home/kevin/paperclip/darwin-assistant/jarvis.db`** (SQLite,
  `better-sqlite3`). Path resolved in
  `darwin-assistant/src/conversation-db.ts:15`:
  `process.env.JARVIS_DB_PATH ?? path.join(__dirname, '..', 'jarvis.db')`.
  - Note: there is *also* a `jarvis.db` file sitting inside
    `/home/kevin/paperclip/jarvis-command-center/jarvis.db` — that is a stray/
    unused copy, not the live one. Don't touch it, don't confuse it for the
    real DB.
- Auth table — **`api_keys`**, defined in `darwin-assistant/src/api-keys.ts:6-15`:
  ```sql
  CREATE TABLE IF NOT EXISTS api_keys (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash      TEXT NOT NULL UNIQUE,
    caller_label  TEXT NOT NULL,
    scope         TEXT NOT NULL DEFAULT 'jarvis',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at    TEXT
  );
  ```
  No JSON claim column exists. `scope` is a bare string; known values in use
  today are `jarvis`, `cockpit`, `admin` (anything in `ADMIN_SCOPES` = cockpit-
  wide visibility, see `isAdminScope` below).
- Thread ownership is **not** a DB column/FK on `api_keys` — it's a naming
  convention on the `conversations.external_id` string: ordinary keys own
  `api:{key_id}:...`, admin/cockpit keys own everything, and the UI's own
  threads are externally tagged `cockpit:...`.

## (b) Request → authenticated principal: the exact code path

Two hops for the actual browser (iPhone/desktop cockpit UI). Direct API
callers (curl, hopper workers, M365 connector, etc.) only go through hop 2.

**Hop 1 — jarvis-command-center (TanStack Start server, :8080), ZERO per-user auth:**
- `jarvis-command-center/src/server.ts:53` — every request matching
  `isCockpitApiRequest()` (path starts with `/cockpit-api/`) is handed to
  `proxyCockpitRequest()` *before* it ever reaches the app router/SSR.
- `jarvis-command-center/src/lib/cockpit-proxy.ts:45-63` (`proxyCockpitRequest`)
  — reads **one** server-side env var `JARVIS_COCKPIT_KEY`
  (`jarvis-command-center/.env`), and stamps
  `Authorization: Bearer <that key>` onto literally every forwarded request,
  regardless of who's on the other end of the browser connection. There is no
  cookie, no session store, no `req.headers.cookie` read anywhere in this
  repo's `src/` — confirmed by grep. Whoever can reach port 8080 over the
  network *is* Kevin/admin, full stop. This is the real gap for "her own
  login" — there is nothing today that distinguishes one browser tab from
  another.

**Hop 2 — darwin-assistant (Express, :3201) — the actual chokepoint:**
- `darwin-assistant/src/handlers/api-v1.ts:1497` —
  `router.use(bearerAuth as ...)` installs the gate in front of the whole
  `/api/v1/*` router.
- **`bearerAuth()` at `api-v1.ts:1411-1441` is THE chokepoint function** —
  principal resolution happens here and only here:
  1. `AUTH_EXEMPT_PATHS` escape hatch (`api-v1.ts:1381`) — only the Goals
     guard webhook, verified by a separate HMAC header, not relevant here.
  2. Kiosk escape hatch (`api-v1.ts:1416-1427`) — see precedent note below.
  3. Normal path: regex-match `Authorization: Bearer (.+)` →
     `authenticateBearer(token)` (`api-keys.ts:78-84`, sha256-hash lookup,
     rejects revoked rows) → on success, `req.apiKey = key` (the full
     `ApiKeyRow`) → `next()`.
- **Principal shape**: `interface AuthedRequest extends Request { apiKey?: ApiKeyRow }`
  (`api-v1.ts:517-519`). `ApiKeyRow = { id, key_hash, caller_label, scope,
  created_at, revoked_at }` (`api-keys.ts:18-25`). That's it — no user id, no
  per-thread list, no expiry.
- **Per-thread authorization** (separate from the bearer gate, called inside
  individual route handlers): `findConversationForCaller()`
  (`api-v1.ts:1367-1376`) → `callerOwnsExternalId(caller.id, externalId)`
  (`api-keys.ts:113-116`): admin/cockpit scope owns everything; everyone else
  must have `externalId.startsWith('api:{their_key_id}:')`. **This is the
  natural second insertion point** — a guest key isn't admin-scope, so it
  needs its own branch here to check a per-thread allow-list instead of the
  `api:{id}:` prefix convention (which is for programmatic callers, not
  guests).

## (c) How keys are hashed

`hashApiKey()` (`api-keys.ts:45-47`): `sha256` over the raw plaintext, hex
digest, via Node's `crypto.createHash('sha256')`. Only the hash is persisted
(`key_hash`, unique). Plaintext format: `jrv_` + 24 random bytes as hex
(`randomBytes(24).toString('hex')`), minted in `mintApiKey()`
(`api-keys.ts:53-59`) and shown to the operator exactly once — never stored,
never re-derivable. Lookup is a straight indexed hash equality
(`stmts.getByHash`), not constant-time — but since it's a hash of a
high-entropy secret (not the secret itself), that's the normal/acceptable
pattern here. The *kiosk* token path (see below) deliberately does use
`timingSafeEqual` since it's a single long-lived shared comparison, not a
per-row hash lookup.

## The closest existing precedent: Big Board kiosk token

`darwin-assistant/src/big-board.ts` + `api-v1.ts:1394-1427` already implement
almost exactly the "unprivileged scoped visitor" pattern a guest login needs,
just for a TV kiosk instead of a person:

- A single shared secret lives in settings-KV
  (`BIG_BOARD_KIOSK_TOKEN_SETTING = 'big_board_kiosk_token'`), **not** in
  `api_keys` at all.
- Eligible only for specific `GET` paths (`KIOSK_ELIGIBLE_PATHS`), only via
  `?kiosk=<token>` query param, constant-time-compared
  (`constantTimeStringEqual`, `api-v1.ts:1404-1409`), fails closed if unset.
- On success it doesn't even hit `authenticateBearer` — it synthesizes a
  fixed, hardcoded `ApiKeyRow` in memory
  (`BIG_BOARD_KIOSK_API_KEY`, `api-v1.ts:1395-1402`, `scope: 'cockpit'`) and
  sets `req.apiKey` directly.
- There's also an SSE event-type allow-list specifically for the kiosk
  credential (`BIG_BOARD_KIOSK_EVENT_TYPES` in `big-board.ts`) so a kiosk
  holder can't eavesdrop on full assistant turns — i.e. scope-narrowing
  already exists as a *concept* in this codebase, just hand-rolled per
  feature rather than generalized.

## Cleanest insertion points for a new "guest" principal + JSON scope claim

1. **Schema** — `darwin-assistant/src/api-keys.ts`: add `scope_claim TEXT`
   (nullable JSON) to `api_keys` via a guarded `ALTER TABLE` (SQLite needs a
   `PRAGMA table_info` check, not `ADD COLUMN IF NOT EXISTS`), extend
   `ApiKeyRow` with `scope_claim: string | null`, add `'guest'` as a
   recognized `scope` value. Suggested claim shape:
   `{"threads": ["cockpit:goal-13"], "label": "wife"}`.
2. **Thread authorization** — `callerOwnsExternalId()`
   (`api-keys.ts:113-116`): add a branch for `scope === 'guest'` that parses
   `scope_claim.threads` and checks membership, instead of the `api:{id}:`
   prefix test. This is the one function every per-thread route already
   calls through `findConversationForCaller`, so it's a single-point change
   for backend enforcement.
3. **The bearer gate itself** (`bearerAuth`, `api-v1.ts:1411-1441`) needs no
   structural change — `authenticateBearer` already returns whatever's in
   the row, including a future `scope_claim`. Minting a guest key is just
   `mintApiKey(label, 'guest')` plus a follow-up `UPDATE` to set
   `scope_claim` (or extend `mintApiKey`'s signature).
4. **The real missing piece is hop 1** — jarvis-command-center has no concept
   of "which browser is this" at all (no cookies, no sessions, confirmed by
   grep of `src/`). For an iPhone-scoped guest login to exist, something new
   has to be built at that layer: e.g. a signed guest-session cookie minted
   by Kevin (or a magic link), checked in `src/server.ts` before
   `proxyCockpitRequest()`, that resolves to a *specific* guest-scoped
   darwin-assistant key (stored server-side only, never sent to the
   browser) instead of the one hardcoded `JARVIS_COCKPIT_KEY`. The kiosk
   `?kiosk=` pattern is the fastest template to fork: same shape, but with a
   per-guest token (not one shared secret) mapped to a per-guest
   `scope_claim` instead of a single hardcoded `BIG_BOARD_KIOSK_API_KEY`.

## Files touched by this recon (read-only)

- `darwin-assistant/src/api-keys.ts`
- `darwin-assistant/src/handlers/api-v1.ts` (lines 490-1441, 1740-1761 for an
  example of a route already branching on `isAdminScope`)
- `darwin-assistant/src/big-board.ts`
- `darwin-assistant/src/conversation-db.ts`
- `jarvis-command-center/src/server.ts`
- `jarvis-command-center/src/lib/cockpit-proxy.ts`
- `jarvis-command-center/.env` (confirmed `JARVIS_COCKPIT_KEY` is just a
  `cockpit`-scoped row in `api_keys`, per its own header comment)
