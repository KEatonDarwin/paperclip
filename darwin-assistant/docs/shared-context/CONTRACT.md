# SHARED CONTEXT v0 — CONTRACT (binding; tree-f6da9dbf, node #484)

**Status:** BINDING as of 2026-09-20. **REVIEWED + AMENDED 2026-09-20 by node #488 (adversarial review) — see §7 for the amendments; they are part of the contract.** Written by the recon node; §1 is BUILT in the same commit (`src/shared-context.ts` + injection seam + route + wiki mirror). §2 (recall), §3 (summary refresher) and §4 (skill) are built by parallel sonnet workers against THIS file without talking to each other. Additive only. If a builder must add something, it adds it here in the same commit and says so in its finish result.

Mirror of this file: `/home/kevin/obsidian/paperclip-wiki/skills/shared-context/CONTRACT.md` (keep both identical; repo copy wins on conflict).

**Branch/worktree (every node):** `hopper/shared-context` in `/home/kevin/paperclip-worktrees/shared-context/darwin-assistant`. `node_modules` is a symlink to the live checkout's (gitignored). Never edit `/home/kevin/paperclip/darwin-assistant`, never restart `jarvis.service`, never open the live `jarvis.db` (scratch: `JARVIS_DB_PATH=/tmp/<name>.db`). `npm run build` (tsc) must pass. JARVIS deploys after review.

---

## 0. The problem (verified 2026-09-20, do not re-derive)

Kevin (thread `cockpit:fff28b3e-…`): fresh threads ask him "where does the MBI code live?" although MBI was the whole of Thursday/Friday; two Claude accounts + codex + auggie + devin each start cold; nothing lets a thread search other threads.

Three memory layers exist, ONE is cross-provider:

| Layer | Where | Cross-provider? | Problem |
|---|---|---|---|
| `memory.md` | wiki `agent-memory/jarvis/memory.md`, injected every turn by `loadMemoryBlock()` (`src/prompt.ts`) into `buildContinuationPrompt` / `<memory_refresh>` | YES (prompt text) | Durable/long-form. Not "what is in flight this week". |
| Claude Code auto-memory | `/home/kevin/.claude/projects/-home-kevin--jarvis-cli-workspace/memory/` (`MEMORY.md` index + one file per fact). Account B's dir is a symlink to A's since 2026-09-20. | NO — claude adapter only | codex/auggie/devin never see it. |
| `thread_summaries` | jarvis.db (`src/thread-summaries.ts`), written only by the manual cockpit "Summarize" button (`POST /threads/:ext/summarize` → `generateThreadSummary`) | injected NOWHERE | 49 rows, last written 2026-08-21. Nothing searches other threads (`thread-search.ts` is a model-mediated cockpit search over summaries, not a tool). |

Meanwhile the real "what are we doing" state is already server-owned in jarvis.db: `workstreams`/`workstream_links`/`workstream_events` (Flight Deck), `hopper_trees`/`hopper_nodes` (topic/status/origin thread/result), `goals`/`goal_nodes`/`goal_focus`/`goal_events`, `watch_commitments` (written by `scripts/jarvis-watchdog.py`, table may be absent on a scratch DB). Nothing feeds any of that into a fresh thread, on any provider.

**The ONE per-turn seam:** `runConversationTurn()` in `src/agent.ts` composes `perTurnContextPrefix = threadContextLine + autonomyDialLine + groupContextBlock + quickChatContextBlock + workbenchContextBlock + goalContextBlock + imageBlock` and prepends it to stdin for every adapter, on the initial prompt, the `<memory_refresh>` resume path, the transcript-replay path and both retry paths. Anything added to that string reaches every provider. That is where §1 plugs in (one added term, `sharedNowBlock`).

Design rule for all of v0: **zero model calls in the per-turn path; deterministic SQL + string building only.** Model calls exist only in §3 (the refresher, out of the request path, local `claude` CLI via the existing `runClaude` one-shot pattern — NO API KEYS).

---

## 1. SHARED NOW DIGEST — `src/shared-context.ts` (BUILT by node #484)

### 1.1 Module surface (exact signatures)

```ts
// src/shared-context.ts — imports ONLY ./conversation-db.js (sqliteDb, getSetting)
// + node:fs/path/crypto. Never imports agent.ts / hopper-engine.ts / goals.ts /
// workstreams.ts (agent.ts imports THIS module; keep the graph acyclic and keep
// the module loadable on a scratch DB where those tables may not exist).

export interface SharedNowWorkstream { id: number; title: string; turn: string; next_action: string | null; next_owner: string | null; waiting_since: string | null; threads: string[] }
export interface SharedNowTree { id: string; topic: string; status: string; origin_thread_ext: string | null; updated_at: string; counts: Record<string, number>; branch: string | null; commit: string | null; outcome: string | null }
export interface SharedNowGoal { id: number; title: string; status: string; focus_path: string | null; counts: Record<string, number>; thread_ext: string | null }
export interface SharedNowCommitment { id: number; subject: string; due_at: string; thread_ext: string | null; check_type: string }
export interface SharedNowSummary { external_id: string; title: string; one_liner: string; created_at: string }
export interface SharedNowData {
  as_of: string;                     // ISO UTC
  workstreams: SharedNowWorkstream[]; trees: SharedNowTree[]; goals: SharedNowGoal[];
  commitments: SharedNowCommitment[]; summaries: SharedNowSummary[];
  truncated: boolean;                // true when the char cap cut sections
}

export const SHARED_NOW_SETTING_KEYS: readonly string[];   // every settings-KV key below
export function sharedNowSettings(): { enabled: boolean; ttl_sec: number; reinject_min: number; workers: boolean; max_chars: number; mirror_min: number };

export function collectSharedNow(): SharedNowData;           // fresh SQL, uncached, never throws (missing table → empty section)
export function renderSharedNow(data: SharedNowData, maxChars?: number): string; // deterministic text, see 1.4
export function buildSharedNow(opts?: { force?: boolean }): string;               // cached: TTL from settings; returns renderSharedNow(collectSharedNow())
export function getSharedNowSnapshot(opts?: { force?: boolean }): { as_of: string; text: string; data: SharedNowData; cached: boolean };
export function invalidateSharedNow(): void;

export function isSharedNowEligibleThread(externalId: string, opts?: { workers?: boolean }): boolean;
export function shouldInjectSharedNow(args: { externalId: string; turns: Array<{ role: string; created_at: string }>; nowMs?: number }): boolean;
export function sharedNowInjectionBlock(args: { externalId: string; turns: Array<{ role: string; created_at: string }>; nowMs?: number }): string; // '' or the block + '\n\n'

export function writeSharedNowMirror(vaultRoot?: string): { path: string; written: boolean } | null; // agent-memory/jarvis/now.md
export function startSharedNowMirror(): void;   // setInterval(mirror_min); unref'd; first write after 20s
```

### 1.2 Settings-KV (all read live via `getSetting`, no restart)

| key | default | meaning |
|---|---|---|
| `shared_now_enabled` | `1` | kill switch. `0` → `sharedNowInjectionBlock` returns `''`, route still works, mirror still writes. |
| `shared_now_ttl_sec` | `300` | in-process cache TTL for `buildSharedNow`. |
| `shared_now_reinject_min` | `120` | re-inject when the conversation's previous turn is older than this many minutes. |
| `shared_now_workers` | `0` | `1` → hopper-node worker threads / quick chats / ephemeral / checkin threads also get the digest. |
| `shared_now_max_chars` | `7200` | hard cap on rendered text (~1,800 tokens at 4 chars/token). Sections are trimmed tail-first (summaries → commitments → goals → trees → workstreams) until it fits; `truncated=true` + a footer line. |
| `shared_now_mirror_min` | `10` | wiki mirror period (minutes). `0` disables the timer. |

### 1.3 Data rules (SQL, read-only, each section in its own try/catch)

- **workstreams:** `archived=0 AND turn!='done'`, ordered kevin→jarvis→external→parked then `COALESCE(waiting_since, updated_at)` ASC (same order as `listOpenStmt` in workstreams.ts). Cap 12. `threads` = `workstream_links.ref WHERE kind='thread'` (cap 3 per workstream).
- **trees:** `hopper_trees WHERE status IN ('active','done') AND updated_at >= datetime('now','-7 days')`, `status='active'` first then `updated_at DESC`. Cap 12. `counts` = nodes grouped by status. `branch` = first match of `/\bhopper\/[A-Za-z0-9._\/-]+|\b(?:branch|on)\s+`?([A-Za-z0-9._\/-]+\/[A-Za-z0-9._\/-]+)`?/` over the concatenated node results (newest node first); `commit` = first `/\b[0-9a-f]{7,40}\b/` in the same text (only if the text contains `commit` or `@` within 12 chars before it — avoids matching uuids). `outcome` = first non-empty line of the newest `done` node's `result`, stripped of markdown, ≤ 140 chars; for active trees with nothing done yet → `null`. Never include node `spec`.
- **goals:** `goals WHERE archived=0 AND status IN ('ghost','set')` ordered `sort_order, id`. Cap 8. `focus_path` = titles from root to `goal_focus.node_id` joined by ` › ` (walk `goal_nodes.parent_id`), null when no focus. `counts` = `goal_nodes` grouped by `state` excluding `discarded`.
- **commitments:** `watch_commitments WHERE status='open' ORDER BY due_at ASC` — table may not exist (created by the Python watchdog); missing → empty. Cap 8. `subject` ≤ 120 chars.
- **summaries:** newest `thread_summaries` row per conversation (`MAX(id)` per `conversation_id`), joined to `conversations`, excluding external ids matching `isSharedNowEligibleThread(ext, {workers:false}) === false` (see 1.5) and `status='closed'`, ordered `created_at DESC`. Cap 10. `title` = `conversations.title` else the external id. `one_liner` = first line of `content` that is not a heading (`#`) and not blank, with leading `-`/`*` stripped, ≤ 160 chars.

### 1.4 Rendering (exact shape — the sim asserts on tag + section headers)

```
<shared_now as_of="2026-09-20T10:03:11Z" ttl_sec="300">
SHARED NOW — what Kevin + JARVIS have in flight across every thread/provider (server-generated, no model). Use it to answer "where does X live / what happened with Y" before asking Kevin. For anything older or deeper: call the `recall` tool (searches other threads, trees, goals, wiki, auto-memory). Flight Deck = /flight-deck, trees = /spawn-tree, goals = /goals.

## Workstreams (N open)
- #12 MBI lead ledger v2 · turn=kevin · next: deploy 003-mbi-v2.sql (kevin) · waiting since 2026-09-18 · threads: cockpit:a0b1…, cockpit:…
## Trees (last 7 days, M)
- tree-a0760095 · done · MBI ledger v2 · origin cockpit:eb5c… · branch mbi/ledger-v2 @1840574 · done 5/5 · outcome: review PASS-with-fixes, pushed
- tree-f6da9dbf · active · Shared context v0 · origin cockpit:fff28b3e… · running 1 / pending 4
## Goals (K open)
- #1 Monitoring on every part of Hub 1.0 · set · focus: Lead flow › Day-0 leads · nodes set 6 / ghost 2 / working 1 · chat cockpit:goal-1
## Commitments (open)
- #55 JARVIS reviews + deploys goals branches · due 2026-09-19T19:00 · thread cockpit:fff2…
## Recent thread summaries
- [cockpit:fff28b3e-…] Shared context design — Decided: Shared Now digest + recall tool + refresher (2026-09-20)
</shared_now>
```

Empty section → the header line reads `## Workstreams (0 open)` followed by `- (none)`. Timestamps are printed as stored (UTC, `YYYY-MM-DDTHH:MM`), external ids are printed in full (the model needs them for `recall`/`get_member_thread`). If `truncated`, last line before the closing tag is `… (digest truncated to fit; call recall for more)`.

### 1.5 Injection rules (implemented in `sharedNowInjectionBlock`, wired in `runConversationTurn`)

- `isSharedNowEligibleThread(ext)`: FALSE for prefixes `cockpit:hopper-node-`, `quick:`, `ephemeral:`, `checkin:`, `cockpit:foundry-node-`, `monitor:` — unless `workers=true` (settings-KV `shared_now_workers=1`). Group cover chats (`cockpit:group:`) and goal chats ARE eligible (they run real JARVIS turns).
- `shouldInjectSharedNow({externalId, turns})` where `turns` = `getTurns(conv.id)` AFTER the current user turn was added (so `turns[turns.length-1]` is the message being answered):
  - `shared_now_enabled` = 0 → false
  - thread not eligible → false
  - no prior turn (`turns.length <= 1`) → **true** (first turn)
  - previous turn (`turns[turns.length-2]`, any role) `created_at` older than `shared_now_reinject_min` minutes → **true**
  - else false.
  - `created_at` is SQLite `datetime('now')` (UTC, no `Z`) — parse as UTC.
- The block is placed in `perTurnContextPrefix` AFTER `autonomyDialLine` and BEFORE `groupContextBlock` (so it precedes any per-surface context and the `<memory_refresh>`), on every adapter. Cost: ≤ ~1,800 tokens on turn 1 and after every idle gap ≥ 120 min; nothing on the turns in between.

### 1.6 Route

`GET /api/v1/shared-context/now` — admin-scoped (`isAdminScope`). Query `?refresh=1` bypasses the cache. Response `{ as_of, cached, text, data }` where `text` is the exact injected block and `data` is `SharedNowData`. Lives in `src/handlers/api-v1.ts` next to `/hopper-engine/governor`.

### 1.7 Wiki mirror

`writeSharedNowMirror()` writes `<vault>/agent-memory/jarvis/now.md`:

```
# JARVIS — Shared Now (auto-mirrored every 10 min; DO NOT EDIT — generated by darwin-assistant src/shared-context.ts)

_as of 2026-09-20T10:03:11Z · live: GET /api/v1/shared-context/now_

<the same <shared_now> block>
```

Skips the write when the body (minus `as_of`) is unchanged (sha1 compare) so the vault doesn't churn. `startSharedNowMirror()` is called from `src/index.ts` after `startHopperEngine`. BOOT.md gets one line pointing foreign chats (claude.ai desktop, codex CLI, augment) at `agent-memory/jarvis/now.md`.

---

## 2. RECALL — `src/recall.ts` + `src/tools/recall-tool.ts` + route (parallel node)

### 2.1 Surface

```ts
// src/recall.ts — imports ./conversation-db.js (sqliteDb) + node:fs; NO agent.ts import.
export type RecallSource = 'thread_summary' | 'thread_title' | 'turn' | 'tree' | 'goal' | 'workstream' | 'wiki' | 'auto_memory';
export interface RecallHit { source: RecallSource; ref: string; title: string; snippet: string; when: string; score: number }
export interface RecallOptions { days?: number; limit?: number; sources?: RecallSource[] }
export function ensureTurnsFts(): { mode: 'fts5' | 'like' };       // idempotent; called at module load AND exported for the sim
export function getRecallIndexMode(): 'fts5' | 'like';
export function recall(query: string, opts?: RecallOptions): { query: string; mode: 'fts5' | 'like'; hits: RecallHit[] };
```

- `days` default 30 (applies to `turn` hits only — everything else is unbounded), `limit` default 12 (max 50). `query` trimmed, ≥ 2 chars, split on whitespace into terms; a hit must contain EVERY term (case-insensitive); `score` = sum of term occurrences weighted by source (`thread_summary` 3, `tree` 3, `goal` 2, `workstream` 2, `thread_title` 2, `wiki` 2, `auto_memory` 2, `turn` 1) + recency bonus (+2 if `when` within 7 days, +1 within 30). Ties → newer first.
- `ref`: thread external_id (thread_summary/thread_title/turn), `tree-<id>` (tree), `goal-<id>` or `goal-<id>/node-<id>` (goal), `workstream-<id>`, wiki path relative to vault root, absolute file path (auto_memory).
- `snippet`: ≤ 280 chars, centred on the first term match, newlines collapsed. **Never** from `turns.claude_output` / `claude_input` / `tool_result` — only `turns.content` for `role IN ('user','assistant')`. Worker/ephemeral threads (`isSharedNowEligibleThread(ext,{workers:false}) === false`) are EXCLUDED from turn/summary/title hits (their results surface via the tree's `result` instead).
- Sources, in order of the code:
  1. `thread_summaries` (newest row per conversation) — content match.
  2. `conversations.title` / `external_id` — title match.
  3. `turns` last `days` days — via `turns_fts` (FTS5) or `LIKE` fallback.
  4. `hopper_trees.topic` + `hopper_nodes.title/spec/result` (spec included here — it is how "the MBI ledger lives in intake branch mbi/ledger-v2" gets found).
  5. `goals.title/done_means/notes` + `goal_nodes.title/done_means/notes` (exclude `discarded`).
  6. `workstreams.title/what/next_action` + `workstream_events.text`.
  7. Wiki: walk `agent-memory/`, `skills/`, `outbox/`, `kevin/` under `/home/kevin/obsidian/paperclip-wiki` (reuse the walk from `src/tools/wiki.ts` `searchWiki` — extract it to an exported helper `searchVaultFiles(term, {dirs, limit})` in wiki.ts if needed, additive). Skip files > 512 KB. `when` = file mtime.
  8. Auto-memory: `/home/kevin/.claude/projects/-home-kevin--jarvis-cli-workspace/memory/*.md` (env `JARVIS_AUTO_MEMORY_DIR` overrides; missing dir → skip). `title` = frontmatter `name:` else filename.
- **FTS5:** `CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(content, content='turns', content_rowid='id')` + the three standard external-content triggers (`turns_ai`, `turns_ad`, `turns_au`) created `IF NOT EXISTS`; on first creation backfill with `INSERT INTO turns_fts(turns_fts) VALUES('rebuild')`. Detect support by attempting the CREATE inside try/catch at startup → on failure set mode `like` and never touch FTS again. FTS query = terms joined with AND, each quoted (`"mbi" AND "ledger"`), `LIMIT 200` candidates then filtered by role/eligibility/date in JS. LIKE fallback: `content LIKE '%term%'` for each term, `created_at >= datetime('now', '-N days')`, `LIMIT 200`.
- Only `user`/`assistant` rows are indexed for search results (FTS indexes every row but the SELECT filters `role`). `role` is on `turns`, join by rowid.

### 2.2 Tool (`src/tools/recall-tool.ts`, registered in `src/tools/index.ts` → therefore also `mcp__jarvis__recall`)

```
name: recall
description: Search what JARVIS and Kevin have already done or decided in OTHER threads, trees, goals, workstreams, the wiki and JARVIS's auto-memory — before asking Kevin where something lives or what happened. Keyword search (all terms must match), ranked, ≤ 12 hits, each with source + ref (thread ext id / tree id / path) + snippet + when. Cite the ref when you use a hit.
parameters: { query: string (required), days?: number (default 30, turn history window), limit?: number (default 12, max 50), sources?: string[] (subset of thread_summary|thread_title|turn|tree|goal|workstream|wiki|auto_memory) }
returns: { query, mode, hits: RecallHit[] }   // never an exception — errors → { error }
```

### 2.3 Route

`GET /api/v1/recall?q=<query>&days=&limit=&sources=a,b` — any scope (results are read-only, non-admin callers get the same result set since summaries/threads are already scoped elsewhere; keep it simple: admin OR cockpit scope). Returns the tool's payload. Lives next to `/shared-context/now`.

---

## 3. SUMMARY REFRESHER — `src/summary-refresh.ts` + `scripts/refresh-thread-summaries.ts` + `deploy/` (parallel node)

### 3.1 Why: §1 summaries + §2 summary hits are only as fresh as `thread_summaries`; today that table is hand-fed.

### 3.2 Surface

```ts
// src/summary-refresh.ts — imports ./conversation-db.js + ./thread-summaries.js + ./shared-context.js (isSharedNowEligibleThread). NO agent.ts import.
export interface StaleThread { conversation_id: number; external_id: string; title: string | null; turn_count: number; summary_anchor: number | null; summary_at: string | null; last_turn_at: string; stale_turns: number }
export function selectStaleThreads(opts?: { minTurns?: number; batch?: number }): StaleThread[];
```

Stale = eligible non-worker thread (`isSharedNowEligibleThread(ext,{workers:false})`), `conversations.status='active'`, count of `user`/`assistant` turns since the newest summary's `anchor_turn_index` (or since 0 when no summary) ≥ `minTurns` (settings-KV `summary_refresh_min_turns`, default 6), AND newest turn `created_at` > newest summary `created_at` (or no summary). Ordered oldest `summary_at` first (NULL first), then `last_turn_at` ASC. `batch` = settings-KV `summary_refresh_batch` default 15.

### 3.3 Additive change to the existing summarize path

`generateThreadSummary(conv, opts?: { adapter?: string; model?: string })` — when `opts.model` is given, pass `runtime: { adapter: getAdapters()[opts.adapter ?? 'claude'], model: opts.model, options: {} }` to `runClaude`; otherwise byte-identical to today. `POST /threads/:ext/summarize` accepts optional JSON body `{ adapter?, model? }` and forwards it. Nothing else about the route changes (still 202 + `thread_summary` SSE).

### 3.4 Script `scripts/refresh-thread-summaries.ts` (run with `npx tsx`, out of process, against the live DB read-only + the live API for the model call so the SSE fires in the cockpit)

- Env: `JARVIS_API_BASE` (default `http://localhost:3201/api/v1`), `JARVIS_COCKPIT_KEY` (else read from `/home/kevin/paperclip/jarvis-command-center/.env`), `JARVIS_DB_PATH` (the DB to read for staleness — defaults to the repo's `jarvis.db`).
- Flags: `--dry-run` (print the stale list, no POSTs), `--batch N`, `--min-turns N`.
- For each stale thread (up to batch): `POST /threads/:ext/summarize` with `{adapter:'claude', model: <settings-KV summary_refresh_model, default 'claude-haiku-4-5'>}`; sleep 2s between POSTs (the route is 202/async; the live process fans the claude one-shots out). Log one line per thread. Exit 0 even when some POSTs fail (log them).
- No API keys, no SDK: the model call happens inside the live service via the local `claude` CLI (existing path).

### 3.5 `deploy/` (documented, NOT installed by workers — JARVIS installs at deploy)

`deploy/jarvis-summary-refresh.service` (Type=oneshot, User=kevin, `WorkingDirectory=/home/kevin/paperclip/darwin-assistant`, `ExecStart=/usr/bin/npx tsx scripts/refresh-thread-summaries.ts`, `EnvironmentFile=-/home/kevin/paperclip/darwin-assistant/.env`, PATH incl. `/home/kevin/.local/bin:/home/kevin/.npm-global/bin`) + `deploy/jarvis-summary-refresh.timer` (`OnCalendar=*:0/30`, `Persistent=true`). `deploy/README.md` lists the install commands (`sudo cp … /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now jarvis-summary-refresh.timer`).

---

## 4. SKILL — `skills/shared-context/SKILL.md` (wiki) + tools-block sentence (parallel node)

- Wiki `skills/shared-context/SKILL.md`: what the three pieces are, the persona rule (below), how to read `now.md` from a foreign chat, the settings keys table (§1.2), the route + tool signatures, troubleshooting (digest missing → check `shared_now_enabled` + eligibility; recall finds nothing → run the refresher / check mode).
- **Persona rule (verbatim, goes in SKILL.md AND in `buildToolsBlock()` in `src/agent.ts` as one sentence appended to the HOW-TO-CALL paragraph):** "When a thread lacks context on a named project, system, branch or decision (e.g. 'where does the MBI code live?'), call `recall` with the name BEFORE asking Kevin, and cite the hit's ref (thread / tree / path) in your answer."
- Also: append one line to `skills/jarvis-continuity/BOOT.md` live-state checks: `cat /home/kevin/obsidian/paperclip-wiki/agent-memory/jarvis/now.md  # Shared Now digest (what's in flight, all providers)` — node #484 already added this; the skill node verifies it is present.

---

## 5. Acceptance (sim node runs on `JARVIS_DB_PATH=/tmp/shared-context-sim.db`, `npm run build` first, imports from `dist/`)

Seed: 2 workstreams (one turn=kevin with a thread link), 2 hopper_trees (one active with 1 running/2 pending nodes, one done ≤7d whose last node result mentions `branch mbi/ledger-v2 @1840574`), 1 goal with 3 nodes + focus on the deepest, 1 `watch_commitments` open row (create the table exactly as the Python watchdog does), 3 conversations (`cockpit:sim-a` with a summary mentioning "MBI ledger", `cockpit:hopper-node-999-abcd` worker, `quick:hub1:xyz`) each with a few turns, one turn in `cockpit:sim-a` containing "MBI code lives in intake branch mbi/ledger-v2", a temp wiki dir with `skills/x/SKILL.md` containing "MBI", and a temp auto-memory dir (`JARVIS_AUTO_MEMORY_DIR`) with `mbi-lead-trace-model.md`.

1. `collectSharedNow()` returns 2 workstreams, 2 trees (done tree has `branch='mbi/ledger-v2'`, `commit='1840574'`), 1 goal with `focus_path` of 3 titles, 1 commitment, exactly 1 summary (`cockpit:sim-a` — worker and quick excluded).
2. `renderSharedNow()` starts with `<shared_now as_of=` and contains all five `## ` headers; `renderSharedNow(data, 600)` sets `truncated` semantics (returned text ≤ 600 chars + footer).
3. `shouldInjectSharedNow`: `cockpit:sim-a` with 1 turn → true; with 2 turns both "now" → false; with previous turn 3h old → true; `cockpit:hopper-node-999-abcd` 1 turn → false; same with `shared_now_workers=1` → true; `shared_now_enabled=0` → false.
4. `buildSharedNow()` twice within TTL returns the identical string (cached); `invalidateSharedNow()` then a seed change → new content.
5. `writeSharedNowMirror(tmpVault)` writes `agent-memory/jarvis/now.md`; second call → `written:false`.
6. `recall('MBI')` returns hits with sources ⊇ {`turn`, `thread_summary`, `tree`, `wiki`, `auto_memory`}; no hit has `ref` of the worker or quick thread; every snippet ≤ 280 chars.
7. `recall` with FTS forced off (env `JARVIS_RECALL_FORCE_LIKE=1` → mode `like`) returns the same `turn` hit.
8. `selectStaleThreads({minTurns:6, batch:15})` returns exactly the seeded stale threads (≥6 turns since summary / never summarized) and skips a thread with a fresh summary and one with 3 turns; worker/quick threads never appear.
9. `npm run build` passes; `GET /shared-context/now` and `GET /recall?q=MBI` are reachable through the router (route-level test via supertest-style direct handler call or curl against a scratch-port instance — sim's choice).

---

## 6. Namespace / non-goals

- Tables: only `turns_fts` (+ triggers) is new. No changes to existing table shapes.
- Settings keys: `shared_now_*`, `summary_refresh_*` only.
- Not in v0: model-written digests, per-provider variants, cockpit UI for the digest (the route + now.md are enough), cross-account Claude auto-memory sync beyond the existing symlink, editing `memory.md`.


---

## 7. AMENDMENTS — adversarial review, node #488 (2026-09-20)

Every item below was found by running the built branch against a **read-only VACUUM snapshot of the live `jarvis.db`** (809 MB, 10,739 turns) plus the real wiki vault — not against the sim fixtures. Each is fixed on-branch and pinned by a new sim check in section **[10]** (all five fail on the pre-fix code, all five pass after; the sim is 26/26).

| # | Amendment | Why (measured) |
|---|---|---|
| A1 | **New module `src/redact.ts`; every recall snippet/title and every digest bullet goes through `redactSecrets()`.** Dependency-free so §1 and §2 can both import it without a cycle. | §2.1 said snippets never come from `claude_output`/`tool_result` — but `turns.content` itself holds real credentials. On live data `recall("BROWSERBASE_API_KEY")` returned a plaintext `bb_live_…` key and `recall("CHIP_RUNNER_API_KEY")` a plaintext `crk_…` bearer token out of old Slack threads. Before this branch those were reachable only inside that one thread; §1/§2 made them quotable from **every** thread on **every** provider. |
| A2 | **§2.1 score: occurrences are capped at 5 per term** (`OCCURRENCE_CAP`), and the returned slice is **round-robined across sources** (`diversify()`). | `recall("MBI")` — the literal question that motivated this build — returned **12/12 `tree` hits**, all near-duplicate hopper blobs. The top tree scored 539 (term repeated across every node's spec+result) vs. 16 for `mbi-lead-trace-model.md`; the auto-memory answer ranked **19th** and was never returned at the default `limit=12`. After: 8 distinct sources in 12 hits, auto-memory included. |
| A3 | **§2.1 LIKE fallback: `ESCAPE '\'` on EVERY condition, not just the last.** | SQLite binds `ESCAPE` to the immediately preceding `LIKE`, so earlier terms kept a literal backslash. Proven at raw-SQL level: `recall('CHIP_RUNNER_API_KEY bearer')` → **0 hits**, `recall('bearer CHIP_RUNNER_API_KEY')` → **2 hits**. Silent, term-order-dependent zero results in the no-FTS5 fallback. |
| A4 | **§2.1 turn candidates: the `role IN ('user','assistant')` + worker-thread-eligibility + date filters move INTO the SQL** (`NON_ELIGIBLE_PREFIXES` is now exported from `shared-context.ts` and rendered as a `LOWER(...) NOT LIKE` predicate). | Those filters ran in JS **after** `LIMIT 200`. For "mbi", **158 of the 200** candidates were hopper-worker turns that were then discarded — 79 % of the search window wasted, and eligible older turns never entered it. |
| A5 | **§1.4 truncation is two-phase with per-section floors** (`[3,3,2,2,3]`): phase 1 trims the **longest** section still above its floor; phase 2 (all at floor) falls back to the contract's tail-first order. | At the real `shared_now_max_chars=7200` on live data, strict tail-first wiped **all 10 thread summaries** and 3 of 4 commitments while 12 tree bullets kept ~4,000 chars — i.e. the "where does X live" evidence was dropped to preserve tree telemetry. After: summaries 0→8, commitments 1→4, trees 12→5, still ~1,777 tokens. |
| A6 | **§1.3 `branch` regex: the bare `\b(?:branch\|on)\s+` alternative loses `on`.** A generic branch must be introduced by the word "branch"; an explicit `hopper/…` path still matches alone. | It matched the prose *"status 0 on network/timeout"* in a node result, so the live digest advertised **`tree-43fb4584 · branch network/timeout`** — a fresh thread on any provider would have told Kevin the Guards work lived on that branch. |
| A7 | **§3.2 `summary_refresh_batch` default 15 → 6; the script's inter-POST stagger 2s → 15s.** | 88 threads are stale on live data, the largest with a 266 KB (~66k-token) transcript. Each selection becomes a live `claude` one-shot inside `jarvis.service` — a path the hopper governor does **not** gate. A batch of 15 staggered 2s apart ran concurrently against Kevin's Claude window. 6 × 15s keeps the same backlog trajectory (~7 h) at under half the burst; still overridable via settings-KV / `--batch`. |
| A8 | **FTS5 `MATCH` query sanitised** (`buildFtsMatchQuery`): terms with no letters/digits tokenize to nothing and raise `fts5: syntax error`, which silently cost the whole turn section via the catch block. They're dropped instead. | Defensive; found by inspection, no live occurrence. |

**Measured, unchanged, and accepted as-is:**

- **Per-turn cost.** Real digest against live data: **7,106 chars ≈ 1,777 tokens**, `collectSharedNow()` **4 ms** + render **1 ms**. Zero model calls, zero network, zero `spawn` in `shared-context.ts` / `recall.ts` / `redact.ts` (verified by grep). Injected on turn 1 and after a ≥120-min idle gap only.
- **Every adapter gets it.** `sharedNowBlock` sits in `perTurnContextPrefix`, which is used on all five stdin paths (initial, `<memory_refresh>` resume, transcript replay, both retries). It is plain prompt text — a codex/auggie/devin thread with no MCP still receives it.
- **FTS5 on the live schema.** `CREATE VIRTUAL TABLE IF NOT EXISTS` + three `IF NOT EXISTS` triggers, rebuild only on first creation: **185 ms**, **+6.7 MB** on the 809 MB DB, one time at first boot after deploy. Verified idempotent on a second call, and verified that insert/delete on `turns` keeps `turns_fts` in sync. The only `UPDATE turns SET content` in the codebase is `reconcileInterruptedRuns()` at startup, so `turns_au` is effectively idle.
- **Wiki mirror does not touch `memory.md`.** It writes `agent-memory/jarvis/now.md` only, sha1-guarded against churn, with a cold-start compare against what is already on disk.
