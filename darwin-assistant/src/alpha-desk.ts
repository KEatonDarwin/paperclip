// ALPHA DESK (2026-10-15) — the read surface behind the cockpit /alpha-desk page.
//
// Alpha JARVIS (cockpit:jarvis-alpha) is a second-Kevin coworker: it does not do the
// work itself, it writes briefs, spawns chats, reads their reports, verifies and
// follows up. This module answers the one question Kevin has when he looks at that:
// "what did Alpha hand out, and is it going the right way?"
//
// Everything here is DERIVED from rows that already exist — chat_spawns, the child's
// own turns, and the chat_report watch_commitments row — with exactly one exception:
// Alpha's own verdict per child, which lives in a plain JSON file Alpha writes with
// no deploy (see VERDICTS_PATH). A child missing from that file is `pending`, so a
// brand-new spawn shows up on the page immediately.
//
// Read-only and model-free by construction: SELECTs with explicit columns (never
// SELECT * on `turns` — claude_input/claude_output are huge) plus one small JSON
// read. Nothing here writes anything.
//
// The "is this child running right now" check is INJECTED rather than imported.
// In production the route passes JARVIS's own in-process `getInFlightMessageId`
// (the same signal the thread status pill uses). Keeping it a parameter means this
// whole module can be exercised OUTSIDE the JARVIS process - which is how the
// preview proved it against the real database before any deploy.

import fs from 'node:fs';
import path from 'node:path';
import { sqliteDb, getConversation } from './conversation-db.js';
import {
  costOf,
  zeroCost,
  addCost,
  priceSlug,
  PRICE_SOURCE,
  PRICE_AS_OF,
  type TurnCost,
} from './alpha-desk-pricing.js';

/** The orchestrator whose delegations this desk shows, unless overridden. */
export const DEFAULT_ORIGIN_EXT = 'cockpit:jarvis-alpha';

const VAULT_ROOT = process.env.ALPHA_DESK_VAULT_ROOT?.trim() || '/home/kevin/obsidian/paperclip-wiki';
export const VERDICTS_PATH = path.join(VAULT_ROOT, 'agent-memory/jarvis-alpha/desk/verdicts.json');

/** Alpha's judgement on one child. Anything unrecognised degrades to 'pending'. */
export type VerdictKind = 'accepted' | 'follow-up' | 'rejected' | 'pending';
const VERDICT_KINDS: VerdictKind[] = ['accepted', 'follow-up', 'rejected', 'pending'];

export interface Verdict {
  verdict: VerdictKind;
  note: string;
  next_step: string;
  updated_at: string | null;
}

/**
 * How the work is going, in one word:
 *   running  — a turn is in flight in the child right now
 *   reported — the child called report_back
 *   overdue  — past the commitment's due_at with no report
 *   quiet    — not running, no report, not yet due
 */
export type SpawnState = 'running' | 'reported' | 'overdue' | 'quiet';

/** Raw token counts. Every number here is measured, not estimated. */
export interface TokenTotals {
  turns: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** Everything above added up — the "how big is this" number. */
  total: number;
  /** API-equivalent dollars. null when no turn here had a priced model. */
  cost_usd: number | null;
  /** Same tokens priced with 1-hour cache writes: the ceiling (TTL isn't recorded). */
  cost_usd_max: number | null;
  /** Tokens on models missing from the price table — excluded from cost_usd. */
  unpriced_tokens: number;
  unpriced_models: string[];
}

export interface ModelUsage {
  model: string;
  label: string;
  turns: number;
  total: number;
  cost_usd: number | null;
}

/** One chat opened in the rolling last hour, for the counter tile's click-through. */
export interface RecentSpawn {
  external_id: string;
  title: string | null;
  conversation_id: number;
  spawned_at: string;
  state: SpawnState;
}

export interface AlphaDeskRow {
  spawn_id: number;
  external_id: string;
  conversation_id: number;
  title: string | null;
  spawned_at: string;
  reported_at: string | null;
  state: SpawnState;
  running: boolean;
  /** From the chat_report commitment, when one was registered. */
  due_at: string | null;
  commitment_status: string | null;
  /** The child's first user-role turn — the brief Alpha wrote. */
  brief: string | null;
  /** report_back's `summary` argument. */
  report_summary: string | null;
  report_at: string | null;
  /** The child's last assistant message, full text. */
  final_reply: string | null;
  final_reply_at: string | null;
  turn_count: number;
  verdict: Verdict;
  /** This chat's own tokens. */
  tokens: TokenTotals;
}

export interface AlphaDeskPayload {
  origin: { external_id: string; conversation_id: number | null; title: string | null };
  counts: {
    total: number;
    open: number;
    running: number;
    reported_today: number;
    overdue: number;
    /** Chats opened in the rolling last 60 minutes. */
    last_hour: number;
  };
  /** The chats behind the last_hour count, newest first. */
  last_hour_spawns: RecentSpawn[];
  tokens: TokenMeter;
  rows: AlphaDeskRow[];
  verdicts_path: string;
  /** Set when verdicts.json is missing or unparseable — the page says so out loud
   *  rather than silently showing every child as pending. */
  verdicts_error: string | null;
  generated_at: string;
}

/** Alpha's own chat vs everything it delegated to, over one time window. */
export interface TokenSplit {
  alpha: TokenTotals;
  spawned: TokenTotals;
  combined: TokenTotals;
}

export interface TokenMeter {
  last_hour: TokenSplit;
  today: TokenSplit;
  all_time: TokenSplit;
  /** Biggest models first, all time. */
  by_model: ModelUsage[];
  /** Where the prices came from, so the number is auditable rather than magic. */
  price_source: string;
  price_as_of: string;
  /** The day boundary the `today` window uses. */
  today_timezone: string;
  today_date: string;
  /** Spelled out on the page: we pay by subscription, this is scale not a bill. */
  basis: string;
}

const PENDING: Verdict = { verdict: 'pending', note: '', next_step: '', updated_at: null };

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Read Alpha's verdict file. Never throws — a bad file is reported, not fatal. */
export function readVerdicts(): { verdicts: Record<string, Verdict>; error: string | null } {
  let raw: string;
  try {
    raw = fs.readFileSync(VERDICTS_PATH, 'utf8');
  } catch {
    return { verdicts: {}, error: 'verdicts.json not found — every child reads as pending' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { verdicts: {}, error: `verdicts.json is not valid JSON (${(err as Error).message})` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { verdicts: {}, error: 'verdicts.json must be a JSON object keyed by child external_id' };
  }
  const out: Record<string, Verdict> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const kind = str(v.verdict).trim().toLowerCase() as VerdictKind;
    out[key] = {
      verdict: VERDICT_KINDS.includes(kind) ? kind : 'pending',
      note: str(v.note),
      next_step: str(v.next_step),
      updated_at: str(v.updated_at) || null,
    };
  }
  return { verdicts: out, error: null };
}

// ─── Queries ─────────────────────────────────────────────────────────────────
// Prepared lazily: chat_spawns is created on first use by the spawn_chat tool, so a
// top-level prepare would throw on a build where nobody has spawned anything yet.

interface SpawnJoinRow {
  spawn_id: number;
  child_conversation_id: number;
  created_at: string;
  reported_at: string | null;
  external_id: string;
  title: string | null;
}

function selectSpawns(originConversationId: number): SpawnJoinRow[] {
  try {
    return sqliteDb
      .prepare(
        `SELECT s.id AS spawn_id,
                s.child_conversation_id,
                s.created_at,
                s.reported_at,
                c.external_id,
                c.title
           FROM chat_spawns s
           JOIN conversations c ON c.id = s.child_conversation_id
          WHERE s.origin_conversation_id = ?
          ORDER BY s.id DESC`,
      )
      .all(originConversationId) as SpawnJoinRow[];
  } catch {
    // No chat_spawns table yet — nothing has ever been delegated.
    return [];
  }
}

const SQL_BRIEF = `SELECT content, created_at FROM turns
                    WHERE conversation_id = ? AND role = 'user'
                    ORDER BY id ASC LIMIT 1`;

const SQL_REPORT = `SELECT tool_args, created_at FROM turns
                     WHERE conversation_id = ? AND role = 'tool_call' AND tool_name = 'report_back'
                     ORDER BY id DESC LIMIT 1`;

const SQL_FINAL = `SELECT content, created_at FROM turns
                    WHERE conversation_id = ? AND role = 'assistant'
                      AND content IS NOT NULL AND TRIM(content) <> ''
                    ORDER BY id DESC LIMIT 1`;

const SQL_TURNS = `SELECT COUNT(*) AS n FROM turns WHERE conversation_id = ?`;

const SQL_COMMITMENT = `SELECT due_at, status FROM watch_commitments
                         WHERE check_type = 'chat_report' AND check_ref = ?
                         ORDER BY id DESC LIMIT 1`;

/** report_back's summary, pulled out of the recorded tool_args JSON. */
function reportSummaryFrom(toolArgs: string | null): string | null {
  if (!toolArgs) return null;
  try {
    const parsed = JSON.parse(toolArgs) as Record<string, unknown>;
    const summary = str(parsed.summary).trim();
    return summary || null;
  } catch {
    return null;
  }
}

/** `datetime('now')`-style strings are UTC without a zone marker; make that explicit
 *  so Date parsing doesn't silently read them as local time. due_at is already ISO. */
export function parseDbTime(value: string | null): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? value.replace(' ', 'T') + 'Z'
    : value;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

// ─── Kevin's day, not UTC ────────────────────────────────────────────────────
// `datetime('now')` is UTC, so a UTC "today" rolls over at 7pm CT and a report
// filed at 8pm shows up as tomorrow's. Intl does the DST arithmetic for us.

export const DESK_TIMEZONE = 'America/Chicago';
const CT_DAY_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: DESK_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `YYYY-MM-DD` for an instant, in Kevin's timezone. */
export function ctDay(ms: number): string {
  return CT_DAY_FMT.format(new Date(ms));
}

// ─── Tokens ──────────────────────────────────────────────────────────────────
// Explicit columns only: `turns` holds claude_output, and SELECT * on it is the
// documented way to blow up a page on this database.
//
// Read per TURN, not pre-aggregated: one turn is one request, which is what makes
// Haiku 5.5's per-request prompt-length tier exact without a second grouping key.
// The volumes are a few thousand narrow rows, so this costs nothing.

export function emptyTotals(): TokenTotals {
  return {
    turns: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0,
    cost_usd: null, cost_usd_max: null, unpriced_tokens: 0, unpriced_models: [],
  };
}

/**
 * Per-turn rows for one conversation, windowable. Buckets give exact aggregate
 * pricing but no timestamps, so the windowed views read turns individually —
 * still explicit columns, still no claude_output.
 */
const SQL_TURN_TOKENS = `
  SELECT COALESCE(model, '') AS model,
         COALESCE(input_tokens,0)       AS input,
         COALESCE(output_tokens,0)      AS output,
         COALESCE(cache_read_tokens,0)  AS cache_read,
         COALESCE(cache_write_tokens,0) AS cache_write,
         created_at
    FROM turns
   WHERE conversation_id = ?
     AND (COALESCE(input_tokens,0) + COALESCE(output_tokens,0)
          + COALESCE(cache_read_tokens,0) + COALESCE(cache_write_tokens,0)) > 0`;

export interface TurnTokenRow {
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  created_at: string;
}

/** Add one turn into a running total, pricing it as we go. */
export function accumulate(into: TokenTotals, row: TurnTokenRow, unpriced: Set<string>): void {
  const t = {
    input_tokens: row.input,
    output_tokens: row.output,
    cache_read_tokens: row.cache_read,
    cache_write_tokens: row.cache_write,
  };
  into.turns += 1;
  into.input += row.input;
  into.output += row.output;
  into.cache_read += row.cache_read;
  into.cache_write += row.cache_write;
  into.total += row.input + row.output + row.cache_read + row.cache_write;

  const cost = costOf(row.model, t);
  if (cost) {
    into.cost_usd = (into.cost_usd ?? 0) + cost.usd;
    into.cost_usd_max = (into.cost_usd_max ?? 0) + cost.usd_max;
  } else {
    into.unpriced_tokens += row.input + row.output + row.cache_read + row.cache_write;
    if (row.model) unpriced.add(row.model);
  }
}

export function finishTotals(into: TokenTotals, unpriced: Set<string>): TokenTotals {
  into.unpriced_models = [...unpriced].sort();
  if (into.cost_usd != null) into.cost_usd = round6(into.cost_usd);
  if (into.cost_usd_max != null) into.cost_usd_max = round6(into.cost_usd_max);
  return into;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Sum a set of per-turn rows into one total. */
function totalsOf(rows: TurnTokenRow[]): TokenTotals {
  const out = emptyTotals();
  const unpriced = new Set<string>();
  for (const r of rows) accumulate(out, r, unpriced);
  return finishTotals(out, unpriced);
}

function stateOf(args: {
  running: boolean;
  reportedAt: string | null;
  dueAt: string | null;
  now: number;
}): SpawnState {
  if (args.running) return 'running';
  if (args.reportedAt) return 'reported';
  const due = parseDbTime(args.dueAt);
  if (due != null && args.now > due) return 'overdue';
  return 'quiet';
}

/**
 * The whole desk in one read. `originExt` defaults to Alpha's own chat but is a
 * parameter so the same page can supervise any orchestrator later.
 */
/** Is a turn in flight in this child right now? See the note at the top of the file. */
export type IsRunning = (conversationId: number) => boolean;

/** Fallback when no in-flight signal is available: nothing reads as running, so a
 *  child falls through to reported / overdue / quiet rather than claiming activity. */
const NEVER_RUNNING: IsRunning = () => false;

/**
 * Every conversation downstream of `rootId` through chat_spawns, however deep.
 * Alpha only spawns one level today, but a child that spawns its own helper is
 * still Alpha's cost, so the meter follows the whole chain. Breadth-first with a
 * visited set, so a cycle (or a child re-spawned under two parents) terminates.
 */
export function descendantConversations(rootId: number): number[] {
  let stmt;
  try {
    stmt = sqliteDb.prepare(
      `SELECT child_conversation_id FROM chat_spawns WHERE origin_conversation_id = ?`,
    );
  } catch {
    return [];
  }
  const seen = new Set<number>([rootId]);
  const out: number[] = [];
  const queue: number[] = [rootId];
  while (queue.length) {
    const next = queue.shift() as number;
    const kids = stmt.all(next) as Array<{ child_conversation_id: number }>;
    for (const k of kids) {
      const id = k.child_conversation_id;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      queue.push(id);
    }
  }
  return out;
}

function emptySplit(): TokenSplit {
  return { alpha: emptyTotals(), spawned: emptyTotals(), combined: emptyTotals() };
}

function emptyMeter(): TokenMeter {
  return {
    last_hour: emptySplit(),
    today: emptySplit(),
    all_time: emptySplit(),
    by_model: [],
    price_source: PRICE_SOURCE,
    price_as_of: PRICE_AS_OF,
    today_timezone: DESK_TIMEZONE,
    today_date: ctDay(Date.now()),
    basis: 'We pay Anthropic by subscription, so this is not a bill — it is what the same tokens would have cost at list API prices.',
  };
}

export function buildAlphaDesk(
  originExt: string = DEFAULT_ORIGIN_EXT,
  isRunning: IsRunning = NEVER_RUNNING,
): AlphaDeskPayload {
  const origin = getConversation(originExt);
  const { verdicts, error: verdictsError } = readVerdicts();
  const now = Date.now();
  const generatedAt = new Date().toISOString();

  if (!origin) {
    return {
      origin: { external_id: originExt, conversation_id: null, title: null },
      counts: { total: 0, open: 0, running: 0, reported_today: 0, overdue: 0, last_hour: 0 },
      last_hour_spawns: [],
      tokens: emptyMeter(),
      rows: [],
      verdicts_path: VERDICTS_PATH,
      verdicts_error: verdictsError,
      generated_at: generatedAt,
    };
  }

  const briefStmt = sqliteDb.prepare(SQL_BRIEF);
  const reportStmt = sqliteDb.prepare(SQL_REPORT);
  const finalStmt = sqliteDb.prepare(SQL_FINAL);
  const turnsStmt = sqliteDb.prepare(SQL_TURNS);
  const commitmentStmt = sqliteDb.prepare(SQL_COMMITMENT);
  const turnTokensStmt = sqliteDb.prepare(SQL_TURN_TOKENS);
  const tokenRowsFor = (convId: number): TurnTokenRow[] => {
    try {
      return turnTokensStmt.all(convId) as TurnTokenRow[];
    } catch {
      return [];
    }
  };

  const rows: AlphaDeskRow[] = selectSpawns(origin.id).map((s) => {
    const brief = briefStmt.get(s.child_conversation_id) as { content: string | null } | undefined;
    const report = reportStmt.get(s.child_conversation_id) as
      | { tool_args: string | null; created_at: string }
      | undefined;
    const final = finalStmt.get(s.child_conversation_id) as
      | { content: string | null; created_at: string }
      | undefined;
    const turns = turnsStmt.get(s.child_conversation_id) as { n: number };
    const commitment = commitmentStmt.get(s.external_id) as
      | { due_at: string; status: string }
      | undefined;

    const running = isRunning(s.child_conversation_id);
    // reported_at is stamped by report_back; fall back to the marker turn itself so a
    // report that landed before the stamp existed still reads as reported.
    const reportedAt = s.reported_at ?? report?.created_at ?? null;

    return {
      spawn_id: s.spawn_id,
      external_id: s.external_id,
      conversation_id: s.child_conversation_id,
      title: s.title ?? null,
      spawned_at: s.created_at,
      reported_at: reportedAt,
      state: stateOf({ running, reportedAt, dueAt: commitment?.due_at ?? null, now }),
      running,
      due_at: commitment?.due_at ?? null,
      commitment_status: commitment?.status ?? null,
      brief: brief?.content ?? null,
      report_summary: reportSummaryFrom(report?.tool_args ?? null),
      report_at: report?.created_at ?? null,
      final_reply: final?.content ?? null,
      final_reply_at: final?.created_at ?? null,
      turn_count: turns?.n ?? 0,
      verdict: verdicts[s.external_id] ?? PENDING,
      tokens: totalsOf(tokenRowsFor(s.child_conversation_id)),
    };
  });

  const today = ctDay(now);
  const hourAgo = now - 3_600_000;

  // Rolling 60 minutes, not "this clock hour" — "opened in the last hour" is the
  // question Kevin asked, and a clock-hour bucket would read 1 at 10:59 and 0 at 11:01.
  const lastHourRows = rows.filter((r) => {
    const ms = parseDbTime(r.spawned_at);
    return ms != null && ms >= hourAgo;
  });

  const counts = {
    total: rows.length,
    open: rows.filter((r) => r.state !== 'reported').length,
    running: rows.filter((r) => r.state === 'running').length,
    reported_today: rows.filter((r) => {
      const ms = parseDbTime(r.reported_at);
      return ms != null && ctDay(ms) === today;
    }).length,
    overdue: rows.filter((r) => r.state === 'overdue').length,
    last_hour: lastHourRows.length,
  };

  const lastHourSpawns: RecentSpawn[] = lastHourRows.map((r) => ({
    external_id: r.external_id,
    title: r.title,
    conversation_id: r.conversation_id,
    spawned_at: r.spawned_at,
    state: r.state,
  }));

  // ── The meter ──────────────────────────────────────────────────────────────
  // Alpha's own chat is read separately from its descendants so the page can
  // answer "is the supervisor or the work the expensive part?".
  const alphaRows = tokenRowsFor(origin.id);
  const spawnedRows: TurnTokenRow[] = [];
  for (const id of descendantConversations(origin.id)) spawnedRows.push(...tokenRowsFor(id));

  const inWindow = (list: TurnTokenRow[], keep: (ms: number | null) => boolean) =>
    list.filter((r) => keep(parseDbTime(r.created_at)));

  const splitFor = (keep: (ms: number | null) => boolean): TokenSplit => {
    const a = inWindow(alphaRows, keep);
    const sp = inWindow(spawnedRows, keep);
    return { alpha: totalsOf(a), spawned: totalsOf(sp), combined: totalsOf([...a, ...sp]) };
  };

  const tokens: TokenMeter = {
    ...emptyMeter(),
    last_hour: splitFor((ms) => ms != null && ms >= hourAgo),
    today: splitFor((ms) => ms != null && ctDay(ms) === today),
    all_time: splitFor(() => true),
    by_model: modelUsage([...alphaRows, ...spawnedRows]),
    today_date: today,
  };

  return {
    origin: { external_id: originExt, conversation_id: origin.id, title: origin.title ?? null },
    counts,
    last_hour_spawns: lastHourSpawns,
    tokens,
    rows,
    verdicts_path: VERDICTS_PATH,
    verdicts_error: verdictsError,
    generated_at: generatedAt,
  };
}

/** Biggest-first model breakdown. Unpriced models still appear, with a null cost. */
function modelUsage(rows: TurnTokenRow[]): ModelUsage[] {
  const byModel = new Map<string, { turns: number; total: number; cost: TurnCost | null; unpriced: boolean }>();
  for (const r of rows) {
    const key = r.model || '(unrecorded)';
    const entry = byModel.get(key) ?? { turns: 0, total: 0, cost: zeroCost(), unpriced: false };
    entry.turns += 1;
    entry.total += r.input + r.output + r.cache_read + r.cache_write;
    const c = costOf(r.model, {
      input_tokens: r.input,
      output_tokens: r.output,
      cache_read_tokens: r.cache_read,
      cache_write_tokens: r.cache_write,
    });
    if (c && entry.cost) entry.cost = addCost(entry.cost, c);
    else if (!c) entry.unpriced = true;
    byModel.set(key, entry);
  }
  return [...byModel.entries()]
    .map(([model, e]) => ({
      model,
      label: priceSlug(model) ?? model,
      turns: e.turns,
      total: e.total,
      cost_usd: e.unpriced || !e.cost ? null : round6(e.cost.usd),
    }))
    .sort((a, b) => b.total - a.total);
}
