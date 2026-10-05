# Companion thread type — recon (node #1374)

Repo: `/home/kevin/paperclip`, worked in worktree `companion-thread` on branch
`jarvis/companion-thread`. Backend is `darwin-assistant` (cockpit =
`jarvis-command-center`). Live DB: `/home/kevin/paperclip/darwin-assistant/jarvis.db`
(not `./jarvis.db` at repo root or `jarvis-command-center/jarvis.db` — those are
other copies/the UI's own db).

Read-only recon only. No code changes in this pass.

## (a) How thread kinds are registered/recognized

There is no single "thread type registry" table — kinds are a convention: an
`external_id` **prefix**, a dedicated module that (1) find-or-creates the
conversation row for that prefix, (2) returns one-time seed text the caller
posts, and (3) exports a `build*ThreadContext(externalId)` function that
returns `''` for every other thread and a `<tag>` snapshot block for its own.
`agent.ts` calls every one of these per turn and string-concats the results.

- **Coarse source classification** (badging only, not behavior):
  `deriveSource()` in `darwin-assistant/src/conversation-db.ts:194-207` — takes
  `externalId.split(':', 1)[0]`, maps `slack|cockpit|watch|api|checkin|webhook|quick|ephemeral` → `ConversationSource`, else `'other'`.
- **Per-turn context injection point** (where a new kind plugs in):
  `darwin-assistant/src/agent.ts:1528-1570`. Each kind's context builder is
  called and concatenated into `perTurnContextPrefix` at line 1570:
  ```
  const perTurnContextPrefix = threadContextLine + autonomyDialLine + groupContextBlock
    + quickChatContextBlock + workbenchContextBlock + goalContextBlock + nightContextBlock
    + mikeContextBlock + imageBlock;
  ```
  Existing kinds and their prefix/builder pairs (all in `agent.ts` imports at
  lines 32-35 plus the quick-chat import):
  - `quick:<profile_id>:<uuid>` → `buildQuickChatContext()` (`quick-chat-profiles.ts:334`)
  - workbench node chats → `buildWorkbenchThreadContext()` (`workbench.ts`)
  - `cockpit:goal-<id>` / `cockpit:goal-<g>-node-<n>` → `buildGoalThreadContext()` (`goals.ts`)
  - `cockpit:shift-<id>` / `cockpit:night-shift` → `nightShiftContextBlock()` (`night-shift.ts`)
  - `cockpit:mike-<short_id>` → `buildMikeThreadContext()` (`mike-radar-chat.ts:97`) — **the
    best template for "companion"**, see below.
- **Best precedent to copy — Mike Radar project chat** (`darwin-assistant/src/mike-radar.ts:1094-1134`,
  `mike-radar-chat.ts` whole file):
  - `mikeThreadExt(short) => \`cockpit:mike-${short}\`` — the prefix mint (mike-radar.ts:1094-1096)
  - `composeMikeProjectSeed(project)` — one-time orientation text (mike-radar.ts:1103-1114)
  - `getOrCreateMikeThread(project)` — find-or-create + rename, returns `{external_id, created, seed_text}`;
    caller (`/mike-radar/projects/:shortId/thread` route, api-v1.ts:2797-2798) posts `seed_text`
    to `/threads/:ext/messages` only when `created` is true (mike-radar.ts:1119-1134+)
  - `mikeShortIdFromThread(externalId)` — the recognizer, strict regex match on the suffix
    (mike-radar-chat.ts:51-57) — a template to mirror for `companionIdFromThread()`
  - `buildMikeThreadContext(externalId)` — per-turn snapshot, `''` for non-matches,
    never throws (mike-radar-chat.ts:97-109)
- **Other prefix-routed behaviors worth knowing about** (not context blocks, but
  other places code branches on `external_id` prefix — relevant if companion
  needs special-casing beyond context+model):
  `agent.ts:1447` (`cockpit:hopper-node-` → spawn detection), `prompt.ts:18`,
  `turn-admission.ts:51`, `health-monitor.ts:447`, `thread-autogroup.ts:28-31`
  (excludes `quick:`/`ephemeral:`/`checkin:`/`cockpit:group:` from auto-grouping —
  a companion thread should likely be added here too if it should resist
  auto-grouping, or left out if it's fine being grouped), `api-v1.ts:5602-5604,5627-5629`
  (thread-list visibility filters exclude `ephemeral:`/`checkin:` explicitly).

## (b) Where the 48h quick-chat TTL lives, and how to opt out

The TTL is **entirely scoped to the `quick_chat_sessions` mechanism** — it is
not a general property of threads. A thread that is never registered as a
quick-chat session (i.e. doesn't use the `quick:<profile_id>:<uuid>` prefix /
`openQuickChatSession()` path) is simply never subject to it. **Opting out is
automatic as long as companion threads use their own prefix** (e.g.
`cockpit:companion-<id>`, mirroring Mike Radar) instead of being built as a
quick-chat profile.

- TTL storage: `quick_chat_profiles.ttl_hours` (default `48`, clamped
  `[1,168]` by `normalizeTtlHours()`, `quick-chat-profiles.ts:224-228`). All
  three seed profiles (`hub-1-database`, `hub-2-database`, `paperclip-database`)
  set it to `48` explicitly (`quick-chat-profiles.ts:92,107,122`).
- Session creation: `openQuickChatSession(profileId)` mints
  `external_id = \`quick:${profile.id}:${randomUUID()}\`` and inserts into
  `quick_chat_sessions` with `expires_at = datetime('now', '+' || ttl_hours || ' hours')`
  (`quick-chat-profiles.ts:286-296`, table at `179-182`).
- **Enforcement point** (the thing to bypass): `archiveExpiredQuickChatSessions()`
  (`quick-chat-profiles.ts:324-332`) — selects rows from `quick_chat_sessions`
  where `closed_at IS NULL AND expires_at <= datetime('now')`
  (`expiredSessionsStmt`, lines 204-208), closes each session and archives its
  conversation. Called from three places in `handlers/api-v1.ts` (lines 5463,
  5527, 5590) — all inside quick-chat-profile API routes (opened as a sweep
  side-effect whenever those endpoints are hit), never from a global cron.
- Separate, unrelated near-miss: a **generic 14-day idle auto-archive** exists —
  `autoHideStaleThreads(days)` (`conversation-db.ts:803-835`), run at boot + every
  6h from `index.ts:34-44` (`AUTO_HIDE_DEFAULT_DAYS = 14`, setting key
  `thread_auto_hide_days`, `0` disables). It archives (not deletes) any `active`
  thread idle past `days` **with `group_id IS NULL` and no open todos**. This is
  not the "quick chat TTL" the task means, but it will eventually archive a
  companion thread too if it goes idle >14d — same mitigation as any other
  long-lived thread: keep it in a group (`group_id` set) or give it an open
  todo. Not a blocker, just worth noting in the same breath.

**Conclusion:** don't touch `quick-chat-profiles.ts` at all. Give companion its
own prefix + its own find-or-create module (Mike Radar pattern) and the 48h TTL
never applies.

## (c) Where a per-thread model pin lives + the resolution path

This already exists as a first-class mechanism (DAR-680 AC#4) and Night Shift
already uses it exactly the way companion would want to (pin to Opus at
creation time, then leave it to the picker).

- **Storage**: `conversations.thread_adapter` / `conversations.thread_model`
  columns (migration in `conversation-db.ts:94-144`, declared on
  `ConversationRow` at `conversation-db.ts:157-160`). Confirmed present on the
  live `jarvis.db` conversations table (checked via `sqlite3 .schema conversations`).
  `NULL` on both = inherit the global adapter/model setting.
- **Writer**: `setThreadModelOverride(conversationId, adapterId, model)`
  (`conversation-db.ts:438-443`, prepared statement `stmts.setThreadModelOverride`
  at `272-276`): `UPDATE conversations SET thread_adapter = ?, thread_model = ? WHERE id = ?`.
  Distinct from `pinned_claude_account` (account-level pin within the claude
  adapter, tree-b32ef869, `conversation-db.ts:134-141,280-284`) — not relevant here.
- **Resolution path** (where a turn's model is actually decided):
  `resolveConversationRuntime(conv)` in `darwin-assistant/src/agent.ts:475-487`.
  If `conv.thread_adapter` is a known adapter, it wins; the model is used only
  if it's a valid model id for that adapter, else falls back to that adapter's
  default (`null`) rather than leaking a model from another provider. Otherwise
  falls back to the global `getActiveAdapter()` / `getSetting('model')`.
- **Exact precedent for "pin a persistent thread to Opus at creation"**:
  `ensureNightThread()`, `darwin-assistant/src/night-shift.ts:1507-1521`:
  ```ts
  export function ensureNightThread(): { external_id: string; created: boolean; seed_text: string | null } {
    const existing = getConversation(NIGHT_THREAD_EXT);
    if (existing) return { external_id: NIGHT_THREAD_EXT, created: false, seed_text: null };
    const conv = getOrCreateConversation(NIGHT_THREAD_EXT);
    renameConversation(conv.id, '🌙 Night Shift — orchestrator');
    try {
      setThreadModelOverride(conv.id, 'claude', 'claude-opus-5');
    } catch (err) {
      console.warn('[night-shift] could not set the orchestrator thread model override', err);
    }
    return { external_id: NIGHT_THREAD_EXT, created: true, seed_text: composeNightSeed() };
  }
  ```
  Comment at `night-shift.ts:1508`: *"the model override is applied ONCE at
  creation; after that the picker is Kevin's."* — i.e. it's a default, not a
  lock; Kevin can still change it from the model dropdown afterward. If
  companion needs a **hard** pin (can't be changed from the UI), that's a
  different, unbuilt behavior — nothing currently enforces thread_model against
  user edits.
  - Valid Opus model ids today (`agent.ts:244-246,370`): `claude-opus-5` (current
    default elsewhere — goals verify_model, foundry review model, hopper engine
    ladder all use `claude-opus-5`), plus `claude-opus-4-8`, `claude-opus-4-7`.

## (d) jarvis.db schema — conversations + quick-chat columns

Live file: `/home/kevin/paperclip/darwin-assistant/jarvis.db` (391MB as of
2026-10-05 13:12). Confirmed via `sqlite3 jarvis.db ".schema conversations"`:

```sql
CREATE TABLE conversations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id   TEXT NOT NULL UNIQUE,
    slack_channel TEXT,
    claude_session_id TEXT,
    status        TEXT NOT NULL DEFAULT 'active',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    continued_from_id INTEGER REFERENCES conversations(id),
    continued_to_id INTEGER REFERENCES conversations(id),
    session_adapter TEXT,
    thread_adapter TEXT,      -- per-thread provider pin (NULL = inherit global)
    thread_model TEXT,        -- per-thread model pin (NULL = adapter default)
    title TEXT,
    title_is_user_set INTEGER NOT NULL DEFAULT 0,
    desk_x REAL, desk_y REAL, desk_pile_id INTEGER,
    pinned INTEGER NOT NULL DEFAULT 0,
    pinned_at TEXT,
    group_id INTEGER REFERENCES conversation_groups(id),  -- protects from 14d auto-hide
    is_group_chat INTEGER NOT NULL DEFAULT 0,
    headline TEXT, border_color TEXT,
    password_hash TEXT,
    session_account TEXT,
    pinned_claude_account TEXT
);
```

`quick_chat_profiles` / `quick_chat_sessions` schema (for completeness, confirms
the TTL is self-contained in these two tables and nowhere else):

```sql
CREATE TABLE quick_chat_profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
    instructions TEXT NOT NULL, tool_scope TEXT,
    ttl_hours INTEGER NOT NULL DEFAULT 48, sort_order INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE quick_chat_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id TEXT NOT NULL REFERENCES quick_chat_profiles(id),
    conversation_id INTEGER NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL UNIQUE,
    opened_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL, closed_at TEXT, archived_at TEXT
);
```

No separate "thread kind" column/table exists anywhere in the schema — kind is
100% derived from the `external_id` string at read time, per module, as in (a).

## Cleanest way to add a persistent `companion` kind with an Opus pin

Copy the Mike Radar shape exactly (it's the closest-scoped, most recently
built precedent, and it already composes seed + per-turn snapshot + read-only
semantics cleanly):

1. New module `darwin-assistant/src/companion-chat.ts` (or extend a
   `companion.ts` if one gets built for the guest-auth side of this project —
   see note below):
   - `COMPANION_THREAD_PREFIX = 'cockpit:companion-'`
   - `companionThreadExt(id)` → `` `cockpit:companion-${id}` ``
   - `companionIdFromThread(externalId)` → strict-regex recognizer (mirror
     `mikeShortIdFromThread`)
   - `getOrCreateCompanionThread(...)`: find-or-create via `getOrCreateConversation`,
     `renameConversation(...)`, then **once, only when newly created**:
     `setThreadModelOverride(conv.id, 'claude', 'claude-opus-5')` (mirrors
     `ensureNightThread`, `night-shift.ts:1507-1521` exactly) — this is the
     persistent Opus pin, and it bypasses the 48h quick-chat TTL automatically
     because this thread is never inserted into `quick_chat_sessions`.
   - `buildCompanionThreadContext(externalId)`: `''` for non-matches; else a
     `<companion_thread>` snapshot block (whatever live facts companion needs —
     wish-catalog state, linked goal, etc.), wrapped in try/catch like
     `buildMikeThreadContext` so a bad row never breaks a turn.
2. Wire it into `agent.ts` exactly like the Mike block: import the builder near
   line 35, call it near line 1555, append it into `perTurnContextPrefix` at
   line 1570.
3. If the thread should resist the 14-day idle auto-archive even without
   activity, either set `group_id` on it at creation or give it a permanent
   open `thread_todos` row — don't add a special case to `autoHideStaleThreads`
   for one more prefix.
4. If companion needs the Opus pin to be a **hard lock** (survive Kevin changing
   the model picker), that's new behavior — today `thread_model`/`thread_adapter`
   are a default only; nothing currently re-asserts them after a user edit via
   the model-override API route. Flag this to whoever builds it as a decision
   point, not something to infer.

Related, already-in-flight work on this same tree (branches present in this
checkout, not touched by this recon): `jarvis/companion-guest-auth` and
`jarvis/companion-guest-enforce` — a `guest_identities` table + bearer-chokepoint
login resolution for scoped guest access to a companion thread (the "her own
linked AI" login side of the wish-catalog pilot, separate concern from
thread-kind/TTL/model-pin).
