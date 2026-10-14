#!/usr/bin/env node
// Betterment nightly collector — model-free. Reads jarvis.db READ-ONLY and
// upserts per-day aggregates into betterment.db `metrics_daily`.
//
//   node collect.mjs [--source /path/jarvis.db] [--days 30] [--end YYYY-MM-DD]
//
// Days are UTC calendar days (jarvis.db stores created_at as UTC text).
// Definitions, matched to the real schema (checked with pragma_table_info):
//   model call      = a `turns` row carrying usage (input_tokens NOT NULL). Both
//                     `assistant` and `tool_call` rows carry their own usage — a
//                     tool_call row is a separate model call in the tool loop.
//   tokens          = input_tokens + cache_read_tokens + cache_write_tokens + output_tokens
//   tokens_per_turn = sum(tokens) / count(model calls); _worker / _interactive split
//                     by conversations.external_id: worker = 'cockpit:hopper-node-%'
//                     or 'cockpit:unblocker-%', everything else interactive.
//   cache_ratio     = sum(cache_read_tokens) / sum(input_tokens + cache_read_tokens)
//   turns_per_day   = count of `assistant` rows (one per reply).
//   repair_nodes_per_day = hopper_nodes created that day that are merge-repair
//                     nodes. The engine (src/hopper-engine.ts createIntegrationRepairNode)
//                     inserts them with integrates_node_id = <failed node> and
//                     title `integrate n<id>`; either marker counts.
//   dead_turns_per_day = `assistant` rows with error_detail set, EXCLUDING
//                     "Run stopped by user" (a deliberate stop, not a failure) —
//                     i.e. hung/timeout/adapter-failure replies.
// A metric whose columns are missing in the source schema is skipped with a
// note on stderr — never invented. Ratios are only written for days that have
// a non-zero denominator; counts are gap-filled with 0 for every day in range.
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { LIVE_JARVIS_DB, addDays, openBettermentDb, parseArgs, utcDay } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const source = args.source && args.source !== true ? args.source : LIVE_JARVIS_DB;
const days = Number(args.days ?? 30);
if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a positive integer');
const end = args.end && args.end !== true ? args.end : utcDay(new Date());
const start = addDays(end, -(days - 1));
const endExclusive = addDays(end, 1);

if (!fs.existsSync(source)) throw new Error(`source db not found: ${source}`);
const src = new Database(source, { readonly: true, fileMustExist: true });
src.pragma('query_only = ON');

const tables = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
const cols = (t) => new Set(tables.has(t) ? src.prepare('SELECT name FROM pragma_table_info(?)').all(t).map((r) => r.name) : []);
const has = (set, ...names) => names.every((n) => set.has(n));
const turnCols = cols('turns');
const convCols = cols('conversations');
const nodeCols = cols('hopper_nodes');
const skipped = [];

const out = []; // { day, metric, value }
const dayList = [];
for (let d = start; d < endExclusive; d = addDays(d, 1)) dayList.push(d);
const push = (day, metric, value) => out.push({ day, metric, value });
const gapFill = (metric, rows) => {
  const byDay = new Map(rows.map((r) => [r.day, r.n]));
  for (const d of dayList) push(d, metric, byDay.get(d) ?? 0);
};

// ── tokens_per_turn / cache_ratio (overall + by thread class) ───────────────
if (has(turnCols, 'conversation_id', 'created_at', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens')
  && has(convCols, 'id', 'external_id')) {
  const rows = src.prepare(`
    SELECT substr(t.created_at, 1, 10) AS day,
           CASE WHEN c.external_id LIKE 'cockpit:hopper-node-%' OR c.external_id LIKE 'cockpit:unblocker-%'
                THEN 'worker' ELSE 'interactive' END AS cls,
           COUNT(*) AS calls,
           SUM(COALESCE(t.input_tokens,0) + COALESCE(t.cache_read_tokens,0)
             + COALESCE(t.cache_write_tokens,0) + COALESCE(t.output_tokens,0)) AS tokens,
           SUM(COALESCE(t.cache_read_tokens,0)) AS cache_read,
           SUM(COALESCE(t.input_tokens,0) + COALESCE(t.cache_read_tokens,0)) AS input_side
    FROM turns t LEFT JOIN conversations c ON c.id = t.conversation_id
    WHERE t.input_tokens IS NOT NULL AND t.created_at >= ? AND t.created_at < ?
    GROUP BY day, cls
  `).all(start, endExclusive);
  const agg = new Map(); // `${day}|${cls}` -> sums
  for (const r of rows) {
    for (const key of [`${r.day}|${r.cls}`, `${r.day}|all`]) {
      const a = agg.get(key) ?? { calls: 0, tokens: 0, cache_read: 0, input_side: 0 };
      a.calls += r.calls; a.tokens += r.tokens; a.cache_read += r.cache_read; a.input_side += r.input_side;
      agg.set(key, a);
    }
  }
  for (const [key, a] of agg) {
    const [day, cls] = key.split('|');
    const suffix = cls === 'all' ? '' : `_${cls}`;
    if (a.calls > 0) push(day, `tokens_per_turn${suffix}`, a.tokens / a.calls);
    if (a.input_side > 0) push(day, `cache_ratio${suffix}`, a.cache_read / a.input_side);
  }
} else skipped.push('tokens_per_turn*, cache_ratio* (turns/conversations usage columns missing)');

// ── turns_per_day ────────────────────────────────────────────────────────────
if (has(turnCols, 'role', 'created_at')) {
  gapFill('turns_per_day', src.prepare(`
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM turns
    WHERE role = 'assistant' AND created_at >= ? AND created_at < ? GROUP BY day
  `).all(start, endExclusive));
} else skipped.push('turns_per_day (turns.role/created_at missing)');

// ── repair_nodes_per_day ─────────────────────────────────────────────────────
if (has(nodeCols, 'created_at', 'title')) {
  const marker = nodeCols.has('integrates_node_id')
    ? "(integrates_node_id IS NOT NULL OR title LIKE 'integrate n%')"
    : "title LIKE 'integrate n%'";
  gapFill('repair_nodes_per_day', src.prepare(`
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM hopper_nodes
    WHERE ${marker} AND created_at >= ? AND created_at < ? GROUP BY day
  `).all(start, endExclusive));
} else skipped.push('repair_nodes_per_day (hopper_nodes.created_at/title missing)');

// ── dead_turns_per_day ───────────────────────────────────────────────────────
if (has(turnCols, 'role', 'created_at', 'error_detail')) {
  gapFill('dead_turns_per_day', src.prepare(`
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM turns
    WHERE role = 'assistant' AND error_detail IS NOT NULL AND error_detail != ''
      AND error_detail NOT LIKE 'Run stopped by user%'
      AND created_at >= ? AND created_at < ? GROUP BY day
  `).all(start, endExclusive));
} else skipped.push('dead_turns_per_day (turns.error_detail missing — not derivable)');

src.close();

const bdb = openBettermentDb();
const upsert = bdb.prepare(`
  INSERT INTO metrics_daily (day, metric, value, collected_at) VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(day, metric) DO UPDATE SET value = excluded.value, collected_at = excluded.collected_at
`);
bdb.transaction(() => { for (const r of out) upsert.run(r.day, r.metric, r.value); })();
bdb.close();

for (const s of skipped) console.error(`collect: skipped ${s}`);
const latest = {};
for (const r of out) if (!latest[r.metric] || r.day >= latest[r.metric].day) latest[r.metric] = { day: r.day, value: r.value };
console.log(JSON.stringify({ source, start, end, rows_upserted: out.length, skipped, latest }, null, 2));
