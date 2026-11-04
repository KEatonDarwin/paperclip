// SPEND SPLIT (2026-10-24) — "what does Jarvis Prime spend vs what is spent in what it spawns?"
//
// Sits beside alpha-desk.ts and reuses its pricing and per-turn accounting. The desk's
// own meter answers a narrower question (one origin chat + its chat_spawns descendants).
// Two things made that unable to answer Kevin's question:
//   1. Alpha LANES (cockpit:alpha-lane-*) are opened by the lane tool, not spawn_chat, so
//      they have NO chat_spawns row — ~40% of Prime-side spend never reached the meter.
//   2. It covers one front seat; there are several (alpha-talk, jarvis-alpha, jobhunt-talk…).
//
// Attribution is by each chat's ROOT ancestor through chat_spawns, never by guesswork:
//   Prime         = a front-seat chat's own turns
//   Spawned       = spawn_chat descendants of a front seat + alpha lanes + whatever lanes spawn
//   Everything else is shown but kept OUT of both, so the split can't be flattered.
//
// Claude dollars are API-equivalent (subscription, not a bill) and swing with cache
// warmth, so every figure carries tokens AND a min..max dollar range (5m vs 1h cache TTL).
// codex / agy tokens are recorded but have no price table, so they are tokens-only and
// say so (`unpriced_tokens`). Read-only: SELECTs with explicit columns, never turns.claude_*.

import fs from 'node:fs';
import { sqliteDb } from './conversation-db.js';
import {
  ctDay, DESK_TIMEZONE, parseDbTime, emptyTotals, accumulate, finishTotals,
  type TokenTotals, type TurnTokenRow,
} from './alpha-desk.js';
import { PRICE_SOURCE, PRICE_AS_OF, OPENAI_PRICE_SOURCE, OPENAI_PRICE_AS_OF } from './alpha-desk-pricing.js';

const ROUTE_LEDGER = process.env.ALPHA_ROUTE_LEDGER ?? '/home/kevin/alpha-board/route-ledger.jsonl';
/** Midnight at the start of 2026-10-24 in America/Chicago (CDT). */
export const ROUTER_CUTOVER_MS = Date.parse('2026-10-24T00:00:00-05:00');

/** Front-seat chats = "Prime". Anything named `cockpit:<x>-talk` counts too. */
export const FRONT_SEAT_EXTS = [
  'cockpit:alpha-talk',
  'cockpit:jarvis-alpha',
  'cockpit:jobhunt-talk',
  'cockpit:alpha-debrief',
];
const FRONT_SEAT_RE = /^cockpit:[a-z0-9]+(?:-[a-z0-9]+)*-talk$/;

export type Side = 'prime' | 'spawned' | 'other';
export type GroupKey =
  | 'prime' | 'spawn_chat' | 'lanes' | 'beneath_lanes'
  | 'workers_hopper' | 'workers_goal' | 'direct' | 'beneath_direct' | 'automation';

const GROUPS: Array<{ key: GroupKey; side: Side; label: string; hint: string }> = [
  { key: 'prime', side: 'prime', label: 'Prime — front seats', hint: 'alpha-talk, jarvis-alpha, jobhunt-talk, alpha-debrief: the chats Kevin talks to' },
  { key: 'spawn_chat', side: 'spawned', label: 'Spawned: spawn_chat children', hint: 'chats a front seat started with spawn_chat' },
  { key: 'lanes', side: 'spawned', label: 'Spawned: Alpha lanes', hint: 'cockpit:alpha-lane-* — opened by the lane tool, so the Alpha Desk meter never saw them' },
  { key: 'beneath_lanes', side: 'spawned', label: 'Spawned: helpers under lanes', hint: 'chats the lanes spawned in turn' },
  { key: 'workers_hopper', side: 'other', label: 'Workers: hopper nodes', hint: 'tree / goal build workers' },
  { key: 'workers_goal', side: 'other', label: 'Workers: goal / shift / workstream', hint: 'goal, shift, workstream and notepad chats' },
  { key: 'direct', side: 'other', label: 'Other chats Kevin talks to directly', hint: 'Slack and ordinary cockpit chats that are not a front seat' },
  { key: 'beneath_direct', side: 'other', label: 'Spawned beneath those other chats', hint: 'helpers started by chats above' },
  { key: 'automation', side: 'other', label: 'Automation / other', hint: 'check-ins, monitors, api, and anything unrecognised' },
];

export interface ProviderTotals { provider: string; totals: TokenTotals }
export interface SpendGroup {
  key: GroupKey; side: Side; label: string; hint: string;
  chats: number;
  totals: TokenTotals;
  by_provider: ProviderTotals[];
}
export interface SpendWindow {
  from: string;
  prime: TokenTotals;
  spawned: TokenTotals;
  other: TokenTotals;
  all: TokenTotals;
  /** spawned ÷ (prime + spawned), by total tokens and by fresh (non-cache-read) tokens. */
  spawned_share: { tokens: number | null; fresh_tokens: number | null; cost_mid: number | null };
  groups: SpendGroup[];
  by_provider: ProviderTotals[];
  /** Prime vs spawned, per provider — the "what did each provider cost on each side". */
  side_by_provider: Array<{ provider: string; prime: TokenTotals; spawned: TokenTotals }>;
}
export interface SpendBreakdown { key: string; totals: TokenTotals; cost_per_reply: number | null }
export interface ModelBeforeAfter {
  model: string;
  before: SpendBreakdown;
  after: SpendBreakdown;
}
export interface RouterProof {
  cutoff: string;
  scope: string;
  before: SpendBreakdown;
  after: SpendBreakdown;
  by_model: ModelBeforeAfter[];
  by_route: SpendBreakdown[];
  route_ledger: string;
}
export interface SpendSplit {
  generated_at: string;
  today_timezone: string;
  today_date: string;
  price_source: string;
  price_as_of: string;
  openai_price_source: string;
  openai_price_as_of: string;
  basis: string;
  coverage: string;
  front_seats: string[];
  router_proof: RouterProof;
  windows: { today: SpendWindow; last_24h: SpendWindow; last_7d: SpendWindow };
}

interface Conv { id: number; ext: string; adapter: string | null; account: string | null; threadModel: string | null }
interface Row extends TurnTokenRow { conversation_id: number }

interface RouteEvent { at: number; route: string; model: string | null }

function routeEvents(): Map<string, RouteEvent[]> {
  const out = new Map<string, RouteEvent[]>();
  try {
    for (const line of fs.readFileSync(ROUTE_LEDGER, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const raw = JSON.parse(line) as { ts?: string; lane?: string; route?: string; model?: string | null };
      const at = Date.parse(raw.ts ?? '');
      if (!raw.lane || !raw.route || !Number.isFinite(at)) continue;
      const a = out.get(raw.lane) ?? [];
      a.push({ at, route: raw.route, model: raw.model ?? null });
      out.set(raw.lane, a);
    }
    for (const a of out.values()) a.sort((x, y) => x.at - y.at);
  } catch { /* the endpoint stays useful without the optional ledger */ }
  return out;
}

function routeAt(events: Map<string, RouteEvent[]>, lane: string, at: number): string {
  const a = events.get(lane) ?? [];
  let found: RouteEvent | undefined;
  for (const e of a) { if (e.at <= at) found = e; else break; }
  return found?.route ?? '(pre-router / untracked)';
}

function providerOf(c: Conv): string {
  const a = (c.adapter ?? 'claude').toLowerCase();
  if (a === 'antigravity') return 'agy';
  if (a === 'claude') return c.account ? `claude-${c.account}` : 'claude';
  return a;
}

function fresh(t: TokenTotals): number { return t.input + t.output + t.cache_write; }

/** Instant of CT midnight for the CT day containing `ms`. DST-safe: walk back until the CT day flips. */
function ctMidnight(ms: number): number {
  const day = ctDay(ms);
  let lo = ms - 26 * 3600e3, hi = ms;
  while (hi - lo > 1000) { const mid = Math.floor((lo + hi) / 2); if (ctDay(mid) === day) hi = mid; else lo = mid; }
  return hi;
}

const dbTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

export function buildSpendSplit(now: number = Date.now()): SpendSplit {
  const convs = new Map<number, Conv>();
  for (const r of sqliteDb.prepare(
    `SELECT id, COALESCE(external_id,'') AS ext, COALESCE(thread_adapter, session_adapter) AS adapter,
            session_account AS account, thread_model AS threadModel FROM conversations`,
  ).all() as Array<{ id: number; ext: string; adapter: string | null; account: string | null; threadModel: string | null }>) {
    convs.set(r.id, { id: r.id, ext: r.ext, adapter: r.adapter, account: r.account, threadModel: r.threadModel });
  }
  const parent = new Map<number, number>();
  try {
    for (const e of sqliteDb.prepare(`SELECT origin_conversation_id AS o, child_conversation_id AS k FROM chat_spawns`).all() as Array<{ o: number; k: number }>) {
      parent.set(e.k, e.o);
    }
  } catch { /* chat_spawns absent: every chat is its own root */ }
  const rootOf = (id: number): number => { let r = id, n = 0; while (parent.has(r) && n++ < 50) r = parent.get(r) as number; return r; };
  const isFront = (c: Conv) => FRONT_SEAT_EXTS.includes(c.ext) || FRONT_SEAT_RE.test(c.ext);
  const laneRoot = (c: Conv): Conv | null => {
    const root = convs.get(rootOf(c.id)) ?? c;
    return /^cockpit:alpha-lane-/.test(root.ext) ? root : null;
  };

  const groupOf = (c: Conv): GroupKey => {
    const root = convs.get(rootOf(c.id)) ?? c;
    if (isFront(c)) return 'prime';
    if (isFront(root)) return 'spawn_chat';
    if (/^cockpit:alpha-lane-/.test(root.ext)) return root.id === c.id ? 'lanes' : 'beneath_lanes';
    if (/^cockpit:hopper-node-/.test(c.ext)) return 'workers_hopper';
    if (/^cockpit:(goal-|shift-|workstream-|notepad-line-)/.test(root.ext)) return 'workers_goal';
    if (/^(slack:|cockpit:group:)/.test(root.ext) || /^cockpit:[0-9a-f]{8}-/.test(root.ext) || /^cockpit:(war-room|pp-|bugfix-|alpha-board-build)/.test(root.ext)) {
      return root.id === c.id ? 'direct' : 'beneath_direct';
    }
    return 'automation';
  };

  const since7 = now - 7 * 864e5;
  const rows = sqliteDb.prepare(
    `SELECT conversation_id,
            COALESCE(model,'') AS model,
            COALESCE(input_tokens,0) AS input, COALESCE(output_tokens,0) AS output,
            COALESCE(cache_read_tokens,0) AS cache_read, COALESCE(cache_write_tokens,0) AS cache_write,
            created_at
       FROM turns
      WHERE created_at >= ?
        AND (COALESCE(input_tokens,0)+COALESCE(output_tokens,0)+COALESCE(cache_read_tokens,0)+COALESCE(cache_write_tokens,0)) > 0`,
  ).all(dbTime(since7)) as Row[];

  const windowFor = (fromMs: number): SpendWindow => {
    type Acc = { totals: TokenTotals; unpriced: Set<string> };
    const mk = (): Acc => ({ totals: emptyTotals(), unpriced: new Set() });
    const add = (m: Map<string, Acc>, k: string, r: Row) => { let a = m.get(k); if (!a) { a = mk(); m.set(k, a); } accumulate(a.totals, r, a.unpriced); };
    const byGroup = new Map<string, Acc>(), byGroupProv = new Map<string, Acc>(), byProv = new Map<string, Acc>(),
      bySideProv = new Map<string, Acc>(), bySide = new Map<string, Acc>(), all = mk();
    const chatSets = new Map<GroupKey, Set<number>>();
    const sideOf = new Map(GROUPS.map((g) => [g.key, g.side]));
    for (const r of rows) {
      const ms = parseDbTime(r.created_at);
      if (ms == null || ms < fromMs) continue;
      const c = convs.get(r.conversation_id);
      if (!c) continue;
      const pricedRow = { ...r, model: r.model || c.threadModel || '' };
      const g = groupOf(c), p = providerOf(c), side = sideOf.get(g) as Side;
      add(byGroup, g, pricedRow); add(byGroupProv, `${g}|${p}`, pricedRow); add(byProv, p, pricedRow);
      add(bySide, side, pricedRow); add(bySideProv, `${side}|${p}`, pricedRow); accumulate(all.totals, pricedRow, all.unpriced);
      (chatSets.get(g) ?? chatSets.set(g, new Set()).get(g) as Set<number>).add(c.id);
    }
    const fin = (a: Acc | undefined) => finishTotals(a?.totals ?? emptyTotals(), a?.unpriced ?? new Set());
    const provs = [...byProv.keys()].sort();
    const prime = fin(bySide.get('prime')), spawned = fin(bySide.get('spawned')), other = fin(bySide.get('other'));
    /** spawned ÷ (prime + spawned); a = prime, b = spawned. */
    const share = (prime: number, spawned: number) => (prime + spawned > 0 ? spawned / (prime + spawned) : null);
    const mid = (t: TokenTotals) => (t.cost_usd != null && t.cost_usd_max != null ? (t.cost_usd + t.cost_usd_max) / 2 : t.cost_usd);
    return {
      from: dbTime(fromMs),
      prime, spawned, other, all: fin(all),
      spawned_share: {
        tokens: share(prime.total, spawned.total),
        fresh_tokens: share(fresh(prime), fresh(spawned)),
        cost_mid: share(mid(prime) ?? 0, mid(spawned) ?? 0),
      },
      groups: GROUPS.map((g) => ({
        ...g,
        chats: chatSets.get(g.key)?.size ?? 0,
        totals: fin(byGroup.get(g.key)),
        by_provider: provs.filter((p) => byGroupProv.has(`${g.key}|${p}`)).map((p) => ({ provider: p, totals: fin(byGroupProv.get(`${g.key}|${p}`)) })),
      })),
      by_provider: provs.map((p) => ({ provider: p, totals: fin(byProv.get(p)) })),
      side_by_provider: provs.map((p) => ({
        provider: p,
        prime: fin(bySideProv.get(`prime|${p}`)),
        spawned: fin(bySideProv.get(`spawned|${p}`)),
      })),
    };
  };

  // Decision-grade router comparison: lanes + helpers below lanes only. This is
  // the population the route table controls; mixing Prime/direct chats into it
  // would make a cheaper router look better or worse for unrelated reasons.
  const events = routeEvents();
  type Acc = { totals: TokenTotals; unpriced: Set<string> };
  const mk = (): Acc => ({ totals: emptyTotals(), unpriced: new Set() });
  const addAcc = (m: Map<string, Acc>, k: string, r: Row) => {
    let a = m.get(k); if (!a) { a = mk(); m.set(k, a); }
    accumulate(a.totals, r, a.unpriced);
  };
  const periods = new Map<string, Acc>(), models = new Map<string, Acc>(), routes = new Map<string, Acc>();
  for (const r of rows) {
    const c = convs.get(r.conversation_id); if (!c) continue;
    const lane = laneRoot(c); if (!lane) continue;
    const at = parseDbTime(r.created_at); if (at == null) continue;
    const period = at < ROUTER_CUTOVER_MS ? 'before' : 'after';
    const model = r.model || c.threadModel || '(model not recorded)';
    const pricedRow = { ...r, model: model === '(model not recorded)' ? '' : model };
    addAcc(periods, period, pricedRow);
    addAcc(models, `${model}|${period}`, pricedRow);
    if (period === 'after') addAcc(routes, routeAt(events, lane.ext, at), pricedRow);
  }
  const breakdown = (key: string, a?: Acc): SpendBreakdown => {
    const totals = finishTotals(a?.totals ?? emptyTotals(), a?.unpriced ?? new Set());
    const completePrice = totals.turns > 0 && totals.unpriced_tokens === 0 && totals.cost_usd != null;
    const midpoint = completePrice ? ((totals.cost_usd as number) + (totals.cost_usd_max ?? totals.cost_usd as number)) / 2 : null;
    return { key, totals, cost_per_reply: midpoint == null ? null : Math.round((midpoint / totals.turns) * 1e6) / 1e6 };
  };
  const modelNames = [...new Set([...models.keys()].map((k) => k.slice(0, k.lastIndexOf('|'))))].sort();
  const routerProof: RouterProof = {
    cutoff: new Date(ROUTER_CUTOVER_MS).toISOString(),
    scope: 'Alpha lanes and spawn_chat helpers whose root ancestor is an Alpha lane.',
    before: breakdown('before', periods.get('before')),
    after: breakdown('after', periods.get('after')),
    by_model: modelNames.map((model) => ({
      model,
      before: breakdown('before', models.get(`${model}|before`)),
      after: breakdown('after', models.get(`${model}|after`)),
    })),
    by_route: [...routes.keys()].sort().map((route) => breakdown(route, routes.get(route))),
    route_ledger: ROUTE_LEDGER,
  };

  return {
    generated_at: new Date(now).toISOString(),
    today_timezone: DESK_TIMEZONE,
    today_date: ctDay(now),
    price_source: PRICE_SOURCE,
    price_as_of: PRICE_AS_OF,
    openai_price_source: OPENAI_PRICE_SOURCE,
    openai_price_as_of: OPENAI_PRICE_AS_OF,
    basis: 'Claude is a subscription, so dollars are what the same tokens would cost at list API prices — a range, because the cache write TTL (5 min vs 1 h) is not recorded. Tokens are exact.',
    coverage: 'Counts model turns recorded in jarvis.db. Codex turns do not record turns.model, so their conversation thread_model is used; if a Codex thread was retuned after earlier turns, those earlier turns inherit its current thread model. agy remains unpriced. Cloud-credit runs (claude --cloud), devin sessions outside the cockpit and Agent-tool sub-runs inside a turn are not separately recorded.',
    front_seats: FRONT_SEAT_EXTS,
    router_proof: routerProof,
    windows: {
      today: windowFor(ctMidnight(now)),
      last_24h: windowFor(now - 864e5),
      last_7d: windowFor(since7),
    },
  };
}
