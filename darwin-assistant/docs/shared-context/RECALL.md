# RECALL — what's indexed, ranking, limits

Implements CONTRACT.md §2. `recall(query, opts?)` in `src/recall.ts` is a synchronous, zero-model-call keyword
search over everything JARVIS + Kevin have already done, so a fresh thread on any provider can answer
"where does X live / what happened with Y" before asking Kevin. Exposed as the `recall` tool
(`src/tools/recall-tool.ts`, also reachable natively as `mcp__jarvis__recall`) and `GET /api/v1/recall?q=`.

## What's indexed

| Source | What | `ref` shape | Notes |
|---|---|---|---|
| `thread_summary` | Newest `thread_summaries` row per conversation | thread external_id | Matches on the summary's full content. |
| `thread_title` | `conversations.title` + `external_id` | thread external_id | Catches a thread by name even with no summary/turns matched. |
| `turn` | `user`/`assistant` turns from the last `days` days (default 30) | thread external_id | FTS5 (`turns_fts`) when available, `LIKE` fallback otherwise — see below. Only `role IN ('user','assistant')`; tool calls/`claude_output`/`claude_input` are never searched. |
| `tree` | `hopper_trees.topic` + every node's `title`/`spec`/`result` | `tree-<id>` (the tree's own id, already `tree-xxxxxxxx`) | Whole-tree aggregate match — this is how "MBI lives in branch mbi/ledger-v2" gets found even though that sentence is buried in one node's `result`. |
| `goal` | `goals.title`/`done_means`/`notes` **and**, separately, each `goal_nodes` row (`state != 'discarded'`) | `goal-<id>` (goal) or `goal-<id>/node-<id>` (node) | A goal and its nodes are indexed independently — a matching node produces its own hit even if the goal root doesn't match. |
| `workstream` | `workstreams.title`/`what`/`next_action` + all of its `workstream_events.text` | `workstream-<id>` | |
| `wiki` | `.md` files under `agent-memory/`, `skills/`, `outbox/`, `kevin/` in the Obsidian vault (`/home/kevin/obsidian/paperclip-wiki`) | vault-relative path | Files > 512 KB are skipped. Self-contained sync file walk (not `tools/wiki.ts`'s async `searchWiki`, since `recall()` is synchronous per its contract signature). |
| `auto_memory` | `.md` files in the Claude Code auto-memory dir (`JARVIS_AUTO_MEMORY_DIR`, default `/home/kevin/.claude/projects/-home-kevin--jarvis-cli-workspace/memory`) | absolute file path | `title` = frontmatter `name:` if present, else the filename. |

Worker/ephemeral threads (anything `isSharedNowEligibleThread(ext, {workers:false})` excludes — hopper/foundry
node workers, quick chats, ephemeral chats, check-in firings, monitor runs) are excluded from `thread_summary`,
`thread_title`, and `turn` hits. Their content still surfaces indirectly through the owning tree's `result`.

## Matching + ranking

- The query is split on whitespace into lowercase terms. A hit requires **every** term to appear
  (substring match, case-insensitive) somewhere in that source's searched text.
- `score = Σ(term occurrence count) × source weight + recency bonus`:
  - Weights: `thread_summary` 3, `tree` 3, `goal` 2, `workstream` 2, `thread_title` 2, `wiki` 2,
    `auto_memory` 2, `turn` 1.
  - Recency bonus: `+2` if `when` is within 7 days, `+1` within 30 days, `0` otherwise.
  - Ties break to the newer `when`.
- `snippet` is centered on the first term match in the matched text, collapsed to one line, capped at 280
  chars (`…` on either truncated edge). `tree`/`goal`/`workstream` snippets are built from whichever
  aggregated field actually contains a term, not always the first field.
- `days` (default 30, max 3650) only bounds the `turn` source — every other source is unbounded by time.
- `limit` (default 12, max 50) caps the combined, sorted hit list across all requested sources.
- `sources` restricts to a subset; omit for all eight.

## Turn search: FTS5 vs LIKE

`ensureTurnsFts()` tries `CREATE VIRTUAL TABLE turns_fts USING fts5(content, content='turns',
content_rowid='id')` plus the three standard external-content sync triggers (`turns_ai`/`turns_ad`/`turns_au`),
backfilling with `INSERT INTO turns_fts(turns_fts) VALUES('rebuild')` the first time the table is created. If
the `CREATE VIRTUAL TABLE` throws (FTS5 not compiled into the SQLite build), the module falls back to
`LIKE '%term%'` search permanently for that process — it never retries FTS5 mid-run. Set
`JARVIS_RECALL_FORCE_LIKE=1` to force LIKE mode without even attempting FTS5 (used by tests to exercise both
code paths deterministically). `getRecallIndexMode()` reports which mode is active.

FTS5 candidates are pulled with an `AND`-joined, quoted MATCH query (`"term1" AND "term2"`), newest 200 by
`turns.id`, then filtered by role/eligibility/date in JS. LIKE candidates apply the date cutoff directly in
SQL (`created_at >= datetime('now', '-N days')`) alongside the `AND`-joined `LIKE` conditions, same 200-row
cap. Both paths only ever touch `turns.content` for `user`/`assistant` rows.

## Limits / non-goals (v0)

- No semantic/embedding search — pure substring AND-match, same class as the existing `search_wiki` tool.
- No pagination beyond `limit`/`sources` — `recall` is meant for a quick "where does X live" lookup inside a
  turn, not a full search UI.
- `conversations` and `workstreams`/`goals` are scanned in full per call (no index needed at current row
  counts); revisit if either table grows into the tens of thousands of rows.
- Wiki/auto-memory hits use file mtime for `when`, so a file touched by an unrelated edit looks "recent" even
  if the matching text is old.
