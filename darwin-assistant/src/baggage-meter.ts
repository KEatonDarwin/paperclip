// Baggage meter (diet/baggage-meter, 2026-11-06). What each persona seat carries IN FRONT of the
// first word of every session — and, for the digest/prefix part, on every turn — measured from the
// REAL assembled pieces, snapshotted daily, and belled when a seat's fixed injection grows >20%
// week over week.
//
// WHY: the alpha-talk seat sat at ~145KB of fixed baggage (25KB live digest in the user-message
// prefix on every turn, plus identity + own memory + playbook + shared core in the system prompt)
// and nothing showed it growing. The memory meter (memory-meter.ts) only watches the memory FILES;
// this watches the whole seat. Same shape as that precedent: read-only, model-free, never throws.
//
// Blocks per seat (bytes of UTF-8, tokens = bytes/4 — a gauge, not a bill):
//   system_base   buildSystemPrompt(profile, {omitMemory:true}) — the persona/system text
//   memory_frame  headings + source lines wrapped around the persona memory sections
//   identity · own_memory · playbook · questions   personaMemoryParts(), the exact text injected
//   shared_core   loadMemoryBlock(undefined,'full') — the shared JARVIS core (inheriting seats only)
//   digest        the seat's live_digest_cmd block (re-sent in the user-message prefix EVERY turn)
//   prefix_fixed  steer note + thread line + autonomy dial + reply-brevity block (every turn)
// NOT counted: topic memory packs (ride only when a message touches their topic), attached
// images/files, and the CLI's own tool definitions (the same for every seat).
//
// total_bytes     = everything above — the "fixed injection" the 20% bell watches.
// per_turn_bytes  = digest + prefix_fixed — the part genuinely re-sent on every resumed turn.
import { sqliteDb, getAutonomyLevel, AUTONOMY_HARD_LIMITER_SUMMARY } from './conversation-db.js';
import { createNotification, type NotificationRow } from './notifications.js';
import { loadPersonas, personaMemoryParts, buildPersonaMemoryBlock, buildPersonaDigestBlockAsync, type PersonaDef } from './personas.js';
import { buildSystemPrompt, loadMemoryBlock, memoryProfileForThread } from './prompt.js';
import { brevityPromptBlock, resolveBrevity } from './reply-brevity.js';

// ── types ────────────────────────────────────────────────────────────────────
export const BLOCK_ORDER = [
  'system_base', 'memory_frame', 'identity', 'own_memory', 'playbook', 'questions', 'shared_core', 'digest', 'prefix_fixed',
] as const;
export type BlockName = (typeof BLOCK_ORDER)[number];
export type BlockBytes = Partial<Record<BlockName, number>>;

export interface SeatBaggage {
  seat: string;
  label: string;
  /** a representative thread id for the seat (exact id, or prefix + "sample") */
  thread: string;
  blocks: Record<BlockName, number>;
  total_bytes: number;
  total_tokens: number;
  per_turn_bytes: number;
  per_turn_tokens: number;
}

export interface SeatTrend {
  seat: string;
  /** oldest first */
  points: { day: string; total_bytes: number }[];
  /** comparison against the snapshot closest to 7 days ago (null until one exists 4-10 days back) */
  vs_week: { baseline_day: string; old_bytes: number; new_bytes: number; delta_bytes: number; pct: number; biggest_block: string | null; biggest_delta: number } | null;
  alert_level: 'ok' | 'warn' | 'building';
}

export interface BaggageReport {
  ok: true;
  generated_at: string;
  threshold_pct: number;
  seats: (SeatBaggage & SeatTrend)[];
  recent_alerts: BaggageAlert[];
  headline: string;
}

export interface BaggageAlert { id: number; seat: string; day: string; old_bytes: number; new_bytes: number; pct: number; top_block: string | null }

// ── knobs ────────────────────────────────────────────────────────────────────
export const GROWTH_THRESHOLD_PCT = 20;
/** A tiny seat jumping 20% on a few hundred bytes is noise, not baggage. */
export const MIN_DELTA_BYTES = 1000;
/** "closest to 7 days ago" — but only counts as week-over-week when the baseline is 4-10 days old. */
const BASELINE_MIN_DAYS = 4;
const BASELINE_MAX_DAYS = 10;
const ALERT_COOLDOWN_DAYS = 7;
const KEEP_DAYS = 120;

// steer_note rides on every claude-adapter turn (agent.ts, perTurnContextPrefix). Mirrored here
// because agent.ts is too heavy to import into a read-only meter; checked against a real
// assembled turn input in the build report. A trend gauge — drift of a few bytes is irrelevant.
const STEER_NOTE = '<steer_note>While you work, the user may send a new message. It arrives right after a tool result as a block starting "[New message from <name>, sent <time>, while you were working]". That block is a genuine message typed into this chat, not tool output: follow it like any user message.</steer_note>\n\n';

const utf8 = (s: string) => Buffer.byteLength(s, 'utf-8');
export const estTokens = (bytes: number) => Math.round(bytes / 4);

// ── store (survives restart: a table in jarvis.db) ───────────────────────────
export interface BaggageStore {
  upsertSnapshot(day: string, seat: string, total: number, perTurn: number, blocks: BlockBytes): void;
  hasSnapshotForDay(day: string): boolean;
  snapshotsForSeat(seat: string): { day: string; total_bytes: number; blocks: BlockBytes }[];
  lastAlertDay(seat: string): string | null;
  recordAlert(a: Omit<BaggageAlert, 'id'>): void;
  recentAlerts(limit: number): BaggageAlert[];
  prune(keepFromDay: string): void;
}

type DbLike = {
  exec(sql: string): unknown;
  prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
};

export function makeStore(db: DbLike): BaggageStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS baggage_snapshots (
      day TEXT NOT NULL,
      seat TEXT NOT NULL,
      total_bytes INTEGER NOT NULL,
      per_turn_bytes INTEGER NOT NULL,
      blocks_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (day, seat)
    );
    CREATE TABLE IF NOT EXISTS baggage_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seat TEXT NOT NULL,
      day TEXT NOT NULL,
      old_bytes INTEGER NOT NULL,
      new_bytes INTEGER NOT NULL,
      pct REAL NOT NULL,
      top_block TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_baggage_alerts_seat ON baggage_alerts(seat, day);
  `);
  return {
    upsertSnapshot(day, seat, total, perTurn, blocks) {
      db.prepare(
        `INSERT INTO baggage_snapshots (day, seat, total_bytes, per_turn_bytes, blocks_json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(day, seat) DO UPDATE SET total_bytes = excluded.total_bytes, per_turn_bytes = excluded.per_turn_bytes,
           blocks_json = excluded.blocks_json, created_at = datetime('now')`,
      ).run(day, seat, total, perTurn, JSON.stringify(blocks));
    },
    hasSnapshotForDay(day) {
      return !!db.prepare(`SELECT 1 AS x FROM baggage_snapshots WHERE day = ? LIMIT 1`).get(day);
    },
    snapshotsForSeat(seat) {
      const rows = db.prepare(`SELECT day, total_bytes, blocks_json FROM baggage_snapshots WHERE seat = ? ORDER BY day ASC`).all(seat) as { day: string; total_bytes: number; blocks_json: string }[];
      return rows.map((r) => {
        let blocks: BlockBytes = {};
        try { blocks = JSON.parse(r.blocks_json) as BlockBytes; } catch { /* keep empty */ }
        return { day: r.day, total_bytes: r.total_bytes, blocks };
      });
    },
    lastAlertDay(seat) {
      const r = db.prepare(`SELECT day FROM baggage_alerts WHERE seat = ? ORDER BY day DESC, id DESC LIMIT 1`).get(seat) as { day: string } | undefined;
      return r?.day ?? null;
    },
    recordAlert(a) {
      db.prepare(`INSERT INTO baggage_alerts (seat, day, old_bytes, new_bytes, pct, top_block) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(a.seat, a.day, a.old_bytes, a.new_bytes, a.pct, a.top_block);
    },
    recentAlerts(limit) {
      return db.prepare(`SELECT id, seat, day, old_bytes, new_bytes, pct, top_block FROM baggage_alerts ORDER BY day DESC, id DESC LIMIT ?`).all(limit) as BaggageAlert[];
    },
    prune(keepFromDay) {
      db.prepare(`DELETE FROM baggage_snapshots WHERE day < ?`).run(keepFromDay);
    },
  };
}

let liveStoreCache: BaggageStore | null = null;
export function liveStore(): BaggageStore {
  if (!liveStoreCache) liveStoreCache = makeStore(sqliteDb as unknown as DbLike);
  return liveStoreCache;
}

// ── dates (Central time, like the rest of the harness) ───────────────────────
export function ctDay(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
const dayNum = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
export const addDays = (day: string, n: number) => new Date((dayNum(day) + n) * 86_400_000).toISOString().slice(0, 10);

// ── measurement ──────────────────────────────────────────────────────────────
interface SeatTarget { seat: string; label: string; thread: string; persona: PersonaDef | null }

function seatTargets(): SeatTarget[] {
  const out: SeatTarget[] = loadPersonas().map((p) => ({
    seat: p.key,
    label: p.label || p.key,
    thread: p.match.exact?.[0] ?? `${p.match.prefix?.[0] ?? `cockpit:${p.key}-`}sample`,
    persona: p,
  }));
  // The plain JARVIS seat — every chat the registry does not bind.
  out.push({ seat: 'jarvis', label: 'JARVIS — the plain seat', thread: 'cockpit:sample', persona: null });
  return out;
}

function autonomyDialBlock(): string {
  const level = getAutonomyLevel();
  const guidance =
    level <= 3
      ? 'Low: highly questioning on work decisions — surface the fork, lay out options, prefer Kevin\'s input over your own judgment. Ask before acting on most non-trivial choices.'
      : level <= 7
        ? 'Mid (default): do a silent threat analysis; act on low/no-risk decisions you have a clear recommendation on (and note what you did so Kevin can override), surface the genuinely consequential or ambiguous ones.'
        : 'High: execute every decision you run into, no matter what — no asking, just do it and report — up to the hard limiter below.';
  return `<jarvis_autonomy_dial level="${level}">\n${guidance}\nHard limiter (fixed, NOT modulated by this dial — ALWAYS escalate to Kevin instead of acting on these regardless of level): ${AUTONOMY_HARD_LIMITER_SUMMARY}\n</jarvis_autonomy_dial>\n`;
}

/** Exposed for the build proof: the fixed per-turn prefix for a thread (everything except the digest/packs). */
export function fixedPrefixFor(thread: string): string {
  const threadLine = `<jarvis_thread external_id="${thread}" conversation_id="0000"/>\n`;
  return STEER_NOTE + threadLine + autonomyDialBlock() + brevityPromptBlock(resolveBrevity(thread).level);
}

/** Measure one seat from the real assembled pieces. `shared` is the shared-core block, computed once per run. */
export async function measureSeat(t: SeatTarget, shared: string): Promise<SeatBaggage> {
  const profile = memoryProfileForThread(t.thread);
  const blocks = Object.fromEntries(BLOCK_ORDER.map((b) => [b, 0])) as Record<BlockName, number>;
  blocks.system_base = utf8(buildSystemPrompt(profile, { omitMemory: true }));
  if (t.persona) {
    const p = t.persona;
    const parts = personaMemoryParts(p);
    const inherits = p.inherit_shared_memory !== false;
    const full = buildPersonaMemoryBlock(p, () => shared);
    blocks.identity = utf8(parts.identity);
    blocks.own_memory = utf8(parts.memory);
    blocks.playbook = utf8(parts.playbook);
    blocks.questions = utf8(parts.questions);
    blocks.shared_core = inherits ? utf8(shared) : 0;
    // whatever else the real block carries (headings, source lines, separators) — so the parts always sum to the real block
    blocks.memory_frame = Math.max(0, utf8(full) - blocks.identity - blocks.own_memory - blocks.playbook - blocks.questions - blocks.shared_core);
    blocks.digest = utf8(await buildPersonaDigestBlockAsync(t.thread));
  } else {
    blocks.shared_core = utf8(shared);
  }
  blocks.prefix_fixed = utf8(fixedPrefixFor(t.thread));
  const total = BLOCK_ORDER.reduce((n, b) => n + blocks[b], 0);
  const perTurn = blocks.digest + blocks.prefix_fixed;
  return {
    seat: t.seat, label: t.label, thread: t.thread, blocks,
    total_bytes: total, total_tokens: estTokens(total),
    per_turn_bytes: perTurn, per_turn_tokens: estTokens(perTurn),
  };
}

/** Every seat, measured now. Never throws: a seat that fails to measure is skipped, not fatal. */
export async function measureAllSeats(): Promise<SeatBaggage[]> {
  let shared = '';
  try { shared = loadMemoryBlock(undefined, 'full'); } catch { /* shared core unavailable → measured as 0 */ }
  const out: SeatBaggage[] = [];
  for (const t of seatTargets()) {
    try { out.push(await measureSeat(t, shared)); } catch (err) { console.error(`[baggage] measuring seat ${t.seat} failed`, err); }
  }
  return out;
}

// ── snapshot + growth check ──────────────────────────────────────────────────
export async function takeSnapshot(store: BaggageStore = liveStore(), day: string = ctDay(), seats?: SeatBaggage[]): Promise<SeatBaggage[]> {
  const measured = seats ?? await measureAllSeats();
  for (const s of measured) store.upsertSnapshot(day, s.seat, s.total_bytes, s.per_turn_bytes, s.blocks);
  try { store.prune(addDays(day, -KEEP_DAYS)); } catch { /* housekeeping only */ }
  return measured;
}

/** The snapshot closest to 7 days before `day`, if it is 4-10 days old; today's own row never counts. */
export function weekBaseline(rows: { day: string; total_bytes: number; blocks: BlockBytes }[], day: string) {
  const target = dayNum(day) - 7;
  let best: (typeof rows)[number] | null = null;
  let bestGap = Infinity;
  for (const r of rows) {
    const age = dayNum(day) - dayNum(r.day);
    if (age < BASELINE_MIN_DAYS || age > BASELINE_MAX_DAYS) continue;
    const gap = Math.abs(dayNum(r.day) - target);
    if (gap < bestGap) { best = r; bestGap = gap; }
  }
  return best;
}

export function compareToWeek(store: BaggageStore, cur: SeatBaggage, day: string): SeatTrend['vs_week'] {
  const base = weekBaseline(store.snapshotsForSeat(cur.seat), day);
  if (!base || base.total_bytes <= 0) return null;
  let biggest: string | null = null;
  let biggestDelta = 0;
  for (const b of BLOCK_ORDER) {
    const d = (cur.blocks[b] ?? 0) - (base.blocks[b] ?? 0);
    if (d > biggestDelta) { biggest = b; biggestDelta = d; }
  }
  const delta = cur.total_bytes - base.total_bytes;
  return {
    baseline_day: base.day, old_bytes: base.total_bytes, new_bytes: cur.total_bytes, delta_bytes: delta,
    pct: Math.round((delta / base.total_bytes) * 1000) / 10, biggest_block: biggest, biggest_delta: biggestDelta,
  };
}

const kb = (b: number) => `${(b / 1000).toFixed(1)}KB`;

export interface CheckResult { seat: string; fired: boolean; reason: string; notification?: NotificationRow | null }

/**
 * Compare `current` (today's measurement) against the snapshot closest to 7 days ago, per seat.
 * >20% growth (and >= MIN_DELTA_BYTES) => ONE warning notification, at most once per seat per 7 days.
 * `notify` is injectable so the proof can run the real logic without touching the live bell.
 */
export function checkGrowth(
  current: SeatBaggage[],
  opts: { store?: BaggageStore; day?: string; notify?: (a: Parameters<typeof createNotification>[0]) => NotificationRow | null } = {},
): CheckResult[] {
  const store = opts.store ?? liveStore();
  const day = opts.day ?? ctDay();
  const notify = opts.notify ?? createNotification;
  const results: CheckResult[] = [];
  for (const cur of current) {
    const w = compareToWeek(store, cur, day);
    if (!w) { results.push({ seat: cur.seat, fired: false, reason: 'no 4-10 day baseline yet' }); continue; }
    if (w.pct <= GROWTH_THRESHOLD_PCT || w.delta_bytes < MIN_DELTA_BYTES) {
      results.push({ seat: cur.seat, fired: false, reason: `${w.pct}% vs ${w.baseline_day} (threshold ${GROWTH_THRESHOLD_PCT}%)` });
      continue;
    }
    const last = store.lastAlertDay(cur.seat);
    if (last && dayNum(day) - dayNum(last) < ALERT_COOLDOWN_DAYS) {
      results.push({ seat: cur.seat, fired: false, reason: `already alerted ${last} (once per ${ALERT_COOLDOWN_DAYS} days)` });
      continue;
    }
    const top = w.biggest_block ? `${w.biggest_block} +${kb(w.biggest_delta)}` : 'no single block';
    const n = notify({
      severity: 'warning',
      title: `Baggage growing: ${cur.seat} seat +${w.pct}% in a week`,
      body: `The ${cur.seat} seat's fixed injection went ${w.old_bytes.toLocaleString()} → ${w.new_bytes.toLocaleString()} bytes `
        + `(${kb(w.old_bytes)} → ${kb(w.new_bytes)}, ~${estTokens(w.new_bytes).toLocaleString()} tokens) since ${w.baseline_day}. `
        + `Biggest-growing block: ${top}.`,
      source: 'baggage-meter',
      link: '/health',
    });
    store.recordAlert({ seat: cur.seat, day, old_bytes: w.old_bytes, new_bytes: w.new_bytes, pct: w.pct, top_block: w.biggest_block });
    results.push({ seat: cur.seat, fired: true, reason: `+${w.pct}% vs ${w.baseline_day}`, notification: n });
  }
  return results;
}

// ── the report the endpoint returns ──────────────────────────────────────────
export async function baggageReport(store: BaggageStore = liveStore()): Promise<BaggageReport> {
  const day = ctDay();
  const seats = await measureAllSeats();
  const out = seats.map((s) => {
    const points = store.snapshotsForSeat(s.seat).map((r) => ({ day: r.day, total_bytes: r.total_bytes }));
    const vs = compareToWeek(store, s, day);
    const level: SeatTrend['alert_level'] = !vs ? 'building' : vs.pct > GROWTH_THRESHOLD_PCT && vs.delta_bytes >= MIN_DELTA_BYTES ? 'warn' : 'ok';
    return { ...s, points, vs_week: vs, alert_level: level };
  });
  const heaviest = [...out].sort((a, b) => b.total_bytes - a.total_bytes)[0];
  const warned = out.filter((s) => s.alert_level === 'warn');
  const headline = heaviest
    ? `Heaviest seat: ${heaviest.seat} at ${kb(heaviest.total_bytes)} (~${heaviest.total_tokens.toLocaleString()} tokens)`
      + (warned.length ? ` · growing >${GROWTH_THRESHOLD_PCT}% this week: ${warned.map((s) => s.seat).join(', ')}` : '')
    : 'No seats measured';
  return { ok: true, generated_at: new Date().toISOString(), threshold_pct: GROWTH_THRESHOLD_PCT, seats: out, recent_alerts: store.recentAlerts(10), headline };
}

// ── the daily timer ──────────────────────────────────────────────────────────
let timer: ReturnType<typeof setInterval> | null = null;
let bootTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

/** One tick: take today's snapshot if there isn't one yet, then run the growth check. Never throws. */
export async function dailyTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const store = liveStore();
    const day = ctDay();
    if (store.hasSnapshotForDay(day)) return;
    const measured = await measureAllSeats();
    checkGrowth(measured, { store, day });   // compare BEFORE today's row exists, so it never baselines against itself
    await takeSnapshot(store, day, measured);
  } catch (err) {
    console.error('[baggage] daily tick failed', err);
  } finally {
    running = false;
  }
}

export function startBaggageMeter(): void {
  if (timer || process.env.BAGGAGE_METER === '0') return;
  // First tick a few minutes after boot (digests spawn child processes — not during startup), then every 30 min;
  // the tick is a no-op once today's snapshot exists.
  bootTimer = setTimeout(() => { void dailyTick(); }, 3 * 60_000);
  bootTimer.unref?.();
  timer = setInterval(() => { void dailyTick(); }, 30 * 60_000);
  timer.unref?.();
  console.log('[baggage] meter started — daily snapshot + 20% week-over-week bell');
}

export function stopBaggageMeter(): void {
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
}
