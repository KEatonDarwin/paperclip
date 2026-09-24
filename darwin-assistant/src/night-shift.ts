// NIGHT SHIFT — the cross-goal overnight orchestrator (skills/night-shift/
// CONTRACT.md, tree-37015f83 node #679).
//
// Kevin hits "Plan the night": a deterministic planner (ZERO model calls) scans
// every live goal, ranks them, simulates each goal's own autopilot decision
// stream in DFS order, and lays the WHOLE night out as ONE frozen ordered list
// with an estimate and an ETA per row. He hits Start: a 30s driver walks that
// list top-down through N lanes, never putting two lanes on dependent work,
// posting every cue into ONE orchestrator thread (`cockpit:night-shift`) and
// marking each row ✓ / ✗ / ⛔ exactly like a hopper tree does. Pause is total.
// In the morning he stops it and reads outbox/night/night-<date>.md.
//
// Night Shift is per-goal autopilot GENERALIZED — it owns nothing of its own:
// the work model is goals.ts, the execution mechanics are goals-autopilot.ts
// (predicates, cue text, verdict parser), the workers are the hopper engine,
// the budget truth is the governor. The three tables here are scheduling only.
//
// Seams (§12.16 / §4.5): the hopper engine gets a paused-tree PROVIDER (setter,
// not an import, so the engine never imports us back) and goals-autopilot gets
// an ownership probe the same way.

import fs from 'node:fs';
import path from 'node:path';
import { sqliteDb, getConversation, getOrCreateConversation, renameConversation, getSetting, setSetting, setThreadModelOverride } from './conversation-db.js';
import { sseBus, type NightRunEvent, type NightItemEvent } from './sse-bus.js';
import { createNotification } from './notifications.js';
import { registerTreeStatusListener, getHopperTree, getHopperNode, setNightShiftPausedTreesProvider, listTreeNodes } from './hopper-engine.js';
import { governorCheck, governorStatusAll, type GovernorVerdict } from './hopper-governor.js';
import {
  AUTOPILOT_DEFAULTS,
  GoalError,
  approvePlan,
  autopilotConfigFor,
  getGoalTree,
  getRawGoal,
  getRawGoalNode,
  insertEvent as insertGoalEvent,
  isFrontierModel,
  normalizeAutopilotConfig,
  parkGoalNode,
  postCue,
  recordAutopilotVerdict,
  renderGoalTreeSnapshot,
  setGoalAutopilot,
  setGoalFocus,
  verifyGoalNode,
  type AutopilotConfig,
  type AutopilotVerdict,
  type GoalNodeRow,
  type GoalRow,
  type GoalTree,
  type PlanJson,
} from './goals.js';
import {
  ancestorsBlock,
  composeCueText,
  earlierOf,
  indexTree,
  isSettled,
  parseVerdict,
  registerNightShiftOwnership,
  buildNightReport,
  type Decision,
  type TreeIndex,
} from './goals-autopilot.js';
import { VAULT_ROOT } from './goals-autopilot-verify.js';

// ---------------------------------------------------------------------------
// Constants + knobs
// ---------------------------------------------------------------------------

export const NIGHT_THREAD_EXT = 'cockpit:night-shift';
export const NIGHT_STOP_FILE = process.env.NIGHT_SHIFT_STOP_FILE?.trim() || '/tmp/night-shift.stop';
const SETTING_ENABLED = 'night_shift_enabled';
const SETTING_HEARTBEAT = 'night_shift_heartbeat';
const LOOP_MS = (() => {
  const n = Number(process.env.NIGHT_SHIFT_LOOP_MS);
  return Number.isFinite(n) && n >= 50 ? n : 30_000;
})();
const KICK_COALESCE_MS = (() => {
  const n = Number(process.env.NIGHT_SHIFT_KICK_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1_000;
})();
const CT = 'America/Chicago';

// ---------------------------------------------------------------------------
// §1 Types
// ---------------------------------------------------------------------------

export type NightRunStatus = 'planned' | 'running' | 'paused' | 'stopped' | 'complete';
export type NightRunMode = 'until_stop' | 'until_budget';
export type NightStopReason = 'kevin' | 'budget' | 'complete' | 'stuck';
export type NightItemKind =
  | 'finish' | 'verify' | 'unblock' | 'replant' | 'weigh_in'
  | 'plan' | 'replan' | 'decompose' | 'classify' | 'predicted';
export type NightItemStatus = 'queued' | 'running' | 'done' | 'failed' | 'blocked' | 'skipped' | 'expanded';

export interface NightEstConfig {
  decompose: number; classify: number; plan_build_per_node: number; plan_build_min: number;
  verify: number; unblock: number; replant: number; weigh_in: number;
}

export interface NightRunConfig {
  lanes: number;
  build_model: string;
  light_model: string;
  verify_model: string;
  max_depth: number;
  max_attempts: number;
  per_goal_parallel: number;
  est: NightEstConfig;
  predicted_children: number;
  predicted_nodes: number;
  kevin_active_bypass: boolean;
  /** REVIEW (node #682) — minutes before an unanswered model cue is re-asked,
   *  and again before it is failed + parked. Mirrors autopilot's tick_minutes
   *  re-ask window (goals-autopilot.ts §15.4); without it a cue the orchestrator
   *  never answers holds its lane for the whole night. */
  recue_minutes: number;
}

export const NIGHT_EST_DEFAULTS: NightEstConfig = {
  decompose: 8, classify: 4, plan_build_per_node: 15, plan_build_min: 45,
  verify: 3, unblock: 25, replant: 2, weigh_in: 5,
};

export const NIGHT_DEFAULTS: NightRunConfig = {
  lanes: 3,
  build_model: AUTOPILOT_DEFAULTS.build_model,
  light_model: AUTOPILOT_DEFAULTS.light_model,
  verify_model: AUTOPILOT_DEFAULTS.verify_model,
  max_depth: 4,
  max_attempts: 2,
  per_goal_parallel: 1,
  est: { ...NIGHT_EST_DEFAULTS },
  predicted_children: 3,
  predicted_nodes: 4,
  kevin_active_bypass: true,
  recue_minutes: 10,
};

export interface PriorAutopilotEntry { autopilot: 0 | 1; config: AutopilotConfig | null }

export interface NightRunRow {
  id: number;
  status: NightRunStatus;
  mode: NightRunMode;
  config: NightRunConfig;
  goal_ids: number[];
  prior_autopilot: Record<string, PriorAutopilotEntry>;
  planned_at: string | null;
  started_at: string | null;
  paused_at: string | null;
  ended_at: string | null;
  stop_reason: NightStopReason | null;
  report_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface NightItemRow {
  id: number;
  run_id: number;
  position: number;
  locked: 0 | 1;
  goal_id: number;
  node_id: number | null;
  parent_item_id: number | null;
  kind: NightItemKind;
  title: string;
  why: string;
  est_minutes: number;
  eta_at: string | null;
  status: NightItemStatus;
  lane: number | null;
  attempt: number;
  tree_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  result_summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface NightStats {
  items: { done: number; failed: number; blocked: number; skipped: number; queued: number; running: number };
  trees_spawned: number;
  hopper_nodes: { done: number; blocked: number };
  worker_attempts: number;
  verify: { pass: number; fail: number };
  worker_turns: number;
  wall_minutes: number;
  holds: { count: number; minutes: number };
  /** best-effort, parsed out of worker results — labelled "(parsed)" in the UI */
  commits: number;
  tests: number;
}

export interface NightNeedsYou {
  goal_id: number;
  node_id: number | null;
  title: string;
  reason: 'human' | 'parked' | 'root_ready_to_verify' | 'awaiting_weigh_in';
}

export interface NightLaneView {
  lane: number;
  item: NightItemRow | null;
  tree: { id: string; status: string; done: number; total: number; running_title: string | null; running_model: string | null } | null;
}

export interface NightBudgetBar { provider: string; label: string; used_pct: number | null; resets_at: string | null }

export interface NightBoard {
  run: NightRunRow | null;
  items: NightItemRow[];
  lanes: NightLaneView[];
  stats: NightStats;
  needs_you: NightNeedsYou[];
  budget: NightBudgetBar[];
  hold: { reason: string; detail: string; since: string } | null;
  heartbeat: string | null;
  thread_ext: string;
  eta_end: string | null;
}

export class NightError extends Error {
  constructor(public status: number, public code: string, message: string, public data?: Record<string, unknown>) {
    super(message);
    this.name = 'NightError';
  }
}

// ---------------------------------------------------------------------------
// §1 Tables — idempotent DDL + the goals.ts lazy-ALTER pattern
// ---------------------------------------------------------------------------

const LAZY_COLUMNS: Array<{ table: string; column: string; ddl: string }> = [
  // Additive columns land here as the schema evolves; the try/catch swallows
  // "duplicate column name" so this is safe on every boot.
];

export function ensureNightShiftTables(): void {
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS night_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      status          TEXT NOT NULL DEFAULT 'planned',
      mode            TEXT NOT NULL DEFAULT 'until_stop',
      config          TEXT NOT NULL,
      goal_ids        TEXT NOT NULL,
      prior_autopilot TEXT NOT NULL DEFAULT '{}',
      planned_at      TEXT,
      started_at      TEXT,
      paused_at       TEXT,
      ended_at        TEXT,
      stop_reason     TEXT,
      report_path     TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS night_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id          INTEGER NOT NULL,
      position        INTEGER NOT NULL,
      locked          INTEGER NOT NULL DEFAULT 0,
      goal_id         INTEGER NOT NULL,
      node_id         INTEGER,
      parent_item_id  INTEGER,
      kind            TEXT NOT NULL,
      title           TEXT NOT NULL,
      why             TEXT NOT NULL DEFAULT '',
      est_minutes     INTEGER NOT NULL DEFAULT 15,
      eta_at          TEXT,
      status          TEXT NOT NULL DEFAULT 'queued',
      lane            INTEGER,
      attempt         INTEGER NOT NULL DEFAULT 1,
      tree_id         TEXT,
      started_at      TEXT,
      finished_at     TEXT,
      result_summary  TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_night_items_run ON night_items(run_id, position);
    CREATE INDEX IF NOT EXISTS idx_night_items_node ON night_items(run_id, node_id);
    CREATE TABLE IF NOT EXISTS night_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     INTEGER NOT NULL,
      item_id    INTEGER,
      actor      TEXT NOT NULL DEFAULT 'system',
      kind       TEXT NOT NULL,
      text       TEXT,
      data       TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_night_events_run ON night_events(run_id, id);
  `);
  for (const c of LAZY_COLUMNS) {
    try { sqliteDb.exec(`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.ddl}`); }
    catch (err) { if (!/duplicate column name/i.test(String(err))) throw err; }
  }
}
ensureNightShiftTables();

// ---------------------------------------------------------------------------
// Test seams (scratch-DB sims only — the driver never spawns anything itself)
// ---------------------------------------------------------------------------

interface TestOverrides {
  governor?: (opts?: { ignoreKevinActive?: boolean }) => Pick<GovernorVerdict, 'allow' | 'reason' | 'detail'>;
  inFlight?: (conversationId: number) => string | null;
  now?: () => number;
}
let overrides: TestOverrides = {};
export function __setNightShiftTestOverrides(next: TestOverrides): void { overrides = { ...next }; }
function nowMs(): number { return overrides.now ? overrides.now() : Date.now(); }
function nowIso(): string { return new Date(nowMs()).toISOString(); }

// ---------------------------------------------------------------------------
// Row parsing / persistence helpers
// ---------------------------------------------------------------------------

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function parseRun(raw: Record<string, unknown> | undefined): NightRunRow | null {
  if (!raw) return null;
  return {
    ...(raw as unknown as NightRunRow),
    config: normalizeNightConfig(parseJson<Partial<NightRunConfig>>(raw.config as string, {})),
    goal_ids: parseJson<number[]>(raw.goal_ids as string, []),
    prior_autopilot: parseJson<Record<string, PriorAutopilotEntry>>(raw.prior_autopilot as string, {}),
  };
}

const getRunStmt = sqliteDb.prepare(`SELECT * FROM night_runs WHERE id = ?`);
const activeRunStmt = sqliteDb.prepare(
  `SELECT * FROM night_runs WHERE status IN ('planned','running','paused') ORDER BY id DESC LIMIT 1`,
);
const latestRunStmt = sqliteDb.prepare(`SELECT * FROM night_runs ORDER BY id DESC LIMIT 1`);
const itemsStmt = sqliteDb.prepare(`SELECT * FROM night_items WHERE run_id = ? ORDER BY position ASC, id ASC`);
const itemStmt = sqliteDb.prepare(`SELECT * FROM night_items WHERE id = ?`);

export function getNightRun(id: number): NightRunRow | null {
  return parseRun(getRunStmt.get(id) as Record<string, unknown> | undefined);
}
export function activeNightRun(): NightRunRow | null {
  return parseRun(activeRunStmt.get() as Record<string, unknown> | undefined);
}
export function latestNightRun(): NightRunRow | null {
  return activeNightRun() ?? parseRun(latestRunStmt.get() as Record<string, unknown> | undefined);
}
export function listNightItems(runId: number): NightItemRow[] {
  return itemsStmt.all(runId) as NightItemRow[];
}
function getItem(id: number): NightItemRow | null {
  return (itemStmt.get(id) as NightItemRow | undefined) ?? null;
}

function emitRun(action: NightRunEvent['action'], run: NightRunRow): void {
  sseBus.emit('sse', { type: 'night_run', action, run } satisfies NightRunEvent);
}
function emitItem(action: NightItemEvent['action'], item: NightItemRow): void {
  sseBus.emit('sse', { type: 'night_item', action, item } satisfies NightItemEvent);
}

export function insertNightEvent(
  runId: number, itemId: number | null, actor: 'kevin' | 'jarvis' | 'system', kind: string,
  text?: string | null, data?: unknown,
): void {
  sqliteDb.prepare(`INSERT INTO night_events (run_id, item_id, actor, kind, text, data) VALUES (?,?,?,?,?,?)`)
    .run(runId, itemId, actor, kind, text ?? null, data === undefined ? null : JSON.stringify(data));
}

function setRun(id: number, patch: Partial<Record<string, string | number | null>>): NightRunRow {
  const keys = Object.keys(patch);
  if (keys.length) {
    sqliteDb.prepare(`UPDATE night_runs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...keys.map((k) => patch[k] ?? null), id);
  }
  invalidatePausedCache();
  return getNightRun(id)!;
}

function setItem(id: number, patch: Partial<Record<string, string | number | null>>): NightItemRow {
  const keys = Object.keys(patch);
  if (keys.length) {
    sqliteDb.prepare(`UPDATE night_items SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
      .run(...keys.map((k) => patch[k] ?? null), id);
  }
  invalidatePausedCache();
  const fresh = getItem(id)!;
  emitItem('updated', fresh);
  return fresh;
}

// ---------------------------------------------------------------------------
// Config validation (§1)
// ---------------------------------------------------------------------------

function intIn(value: unknown, lo: number, hi: number, key: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < lo || n > hi) {
    throw new NightError(400, 'night_config_invalid', `${key} must be an integer in ${lo}..${hi}`);
  }
  return n;
}

export function normalizeNightConfig(input: unknown, base?: NightRunConfig | null): NightRunConfig {
  const b: NightRunConfig = base ? { ...base, est: { ...base.est } } : { ...NIGHT_DEFAULTS, est: { ...NIGHT_EST_DEFAULTS } };
  if (input === undefined || input === null) return b;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new NightError(400, 'night_config_invalid', 'config must be an object');
  }
  const o = input as Record<string, unknown>;
  const out: NightRunConfig = { ...b, est: { ...b.est } };
  out.lanes = intIn(o.lanes, 1, 4, 'lanes', b.lanes);
  out.max_depth = intIn(o.max_depth, 1, 8, 'max_depth', b.max_depth);
  out.max_attempts = intIn(o.max_attempts, 1, 5, 'max_attempts', b.max_attempts);
  out.per_goal_parallel = intIn(o.per_goal_parallel, 1, 3, 'per_goal_parallel', b.per_goal_parallel);
  out.predicted_children = intIn(o.predicted_children, 1, 10, 'predicted_children', b.predicted_children);
  out.predicted_nodes = intIn(o.predicted_nodes, 1, 10, 'predicted_nodes', b.predicted_nodes);
  out.recue_minutes = intIn(o.recue_minutes, 1, 120, 'recue_minutes', b.recue_minutes);
  if (o.kevin_active_bypass !== undefined) out.kevin_active_bypass = !!o.kevin_active_bypass;
  for (const key of ['build_model', 'light_model', 'verify_model'] as const) {
    if (o[key] === undefined) continue;
    const v = o[key];
    if (typeof v !== 'string' || !v.trim()) throw new NightError(400, 'night_config_invalid', `${key} must be a non-empty string`);
    const model = v.trim();
    if (isFrontierModel(model)) throw new NightError(400, 'night_config_invalid', `${key} must not be a frontier/planner model: ${model}`);
    if (!/^claude-/i.test(model)) throw new NightError(400, 'night_config_invalid', `${key} must be a claude model id: ${model}`);
    out[key] = model;
  }
  if (o.est !== undefined) {
    if (typeof o.est !== 'object' || o.est === null) throw new NightError(400, 'night_config_invalid', 'est must be an object');
    const e = o.est as Record<string, unknown>;
    for (const key of Object.keys(NIGHT_EST_DEFAULTS) as Array<keyof NightEstConfig>) {
      if (e[key] === undefined) continue;
      out.est[key] = intIn(e[key], 1, 600, `est.${key}`, out.est[key]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function sqliteToMs(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v.includes('T') ? v : `${v.replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : null;
}
function ctDate(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: CT, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function ctTime(iso: string | null | undefined): string {
  const ms = sqliteToMs(iso);
  if (ms == null) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: CT, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
}
function ctStamp(iso: string | null | undefined): string {
  const ms = sqliteToMs(iso);
  if (ms == null) return '—';
  return `${new Intl.DateTimeFormat('en-US', { timeZone: CT, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))} CT`;
}
function fmtDuration(mins: number | null): string {
  if (mins == null || mins < 0) return '—';
  const m = Math.round(mins);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function parsePlan(node: Pick<GoalNodeRow, 'plan'> | null | undefined): PlanJson | null {
  if (!node?.plan) return null;
  try { return JSON.parse(node.plan) as PlanJson; } catch { return null; }
}
function planEst(cfg: NightRunConfig): number {
  return Math.max(cfg.est.plan_build_min, cfg.est.plan_build_per_node * cfg.predicted_nodes);
}

const MODEL_KINDS = new Set<NightItemKind>(['plan', 'replan', 'decompose', 'classify', 'unblock', 'weigh_in']);
const SERVER_KINDS = new Set<NightItemKind>(['verify', 'replant']);
export function isModelKind(kind: NightItemKind): boolean { return MODEL_KINDS.has(kind); }
export function isServerKind(kind: NightItemKind): boolean { return SERVER_KINDS.has(kind); }

/** The top-level ancestor of a node (the child of the goal root it hangs off).
 *  Two items "share an ancestor below the goal root" iff these match. */
function topAncestorId(ix: TreeIndex, nodeId: number): number {
  let cur = ix.byId.get(nodeId);
  if (!cur) return nodeId;
  while (cur.parent_id != null && ix.byId.has(cur.parent_id)) cur = ix.byId.get(cur.parent_id)!;
  return cur.id;
}

// ---------------------------------------------------------------------------
// §3 THE PLANNER — deterministic, ZERO model calls
// ---------------------------------------------------------------------------

interface ItemDraft {
  goal_id: number;
  node_id: number | null;
  kind: NightItemKind;
  title: string;
  est_minutes: number;
  /** DFS index inside its goal's stream (the ordering key within a goal) */
  dfs_index: number;
  /** filled in by assemble(): index of the draft this predicted row hangs off */
  parent_draft?: ItemDraft | null;
  why_kind: string;
}

export interface NightPlanPreview {
  run: NightRunRow;
  items: NightItemRow[];
  eta_end: string | null;
}

function scopeGoals(goalIds?: number[] | null): GoalRow[] {
  const rows = sqliteDb.prepare(`SELECT id FROM goals WHERE archived = 0 AND status = 'set' ORDER BY id ASC`)
    .all() as Array<{ id: number }>;
  let ids = rows.map((r) => r.id);
  if (goalIds && goalIds.length) {
    const wanted = new Set(goalIds.map(Number));
    ids = ids.filter((id) => wanted.has(id));
  }
  return ids.map((id) => getRawGoal(id)).filter((g): g is GoalRow => !!g);
}

function elapsedMinutes(iso: string | null | undefined, at: number): number {
  const ms = sqliteToMs(iso);
  if (ms == null) return 0;
  return Math.max(0, Math.round((at - ms) / 60_000));
}

/** §3.1 — one goal's predicted action stream, in DFS order, with a MUTABLE
 *  simulated-settled set so later siblings see earlier emissions as settled. */
function simulateGoal(
  goal: GoalRow, tree: GoalTree, cfg: NightRunConfig, at: number, needsYou: NightNeedsYou[],
): ItemDraft[] {
  const ix = indexTree(tree.nodes);
  const simSettled = new Set<number>();
  const out: ItemDraft[] = [];
  const pEst = planEst(cfg);
  const earlierOk = (n: GoalNodeRow): boolean =>
    earlierOf(ix, n).every((x) => isSettled(x) || simSettled.has(x.id));
  const push = (n: GoalNodeRow | null, kind: NightItemKind, est: number, title: string, whyKind: string, parent?: ItemDraft): ItemDraft => {
    const d: ItemDraft = {
      goal_id: goal.id, node_id: n?.id ?? null, kind, title,
      est_minutes: Math.max(1, Math.round(est)), dfs_index: out.length, why_kind: whyKind,
      parent_draft: parent ?? null,
    };
    out.push(d);
    if (n) simSettled.add(n.id);
    return d;
  };

  for (const n of tree.nodes) {
    if (n.state === 'discarded') continue;
    // 1 — a blocked tree.
    if (n.state === 'working' && n.tree_status_cache === 'blocked') {
      push(n, 'unblock', cfg.est.unblock, n.title, `tree ${n.tree_id ?? '?'} is blocked`);
      continue;
    }
    // 2 — already in flight: finish it.
    if (n.state === 'working') {
      const tree_ = n.tree_id ? getHopperTree(n.tree_id) : null;
      const est = Math.max(5, pEst - elapsedMinutes(tree_?.created_at, at));
      push(n, 'finish', est, n.title, `already in flight (${n.tree_id ?? 'no tree'}) — finish floats`);
      continue;
    }
    // 3 — a tree that landed: verify it (server action).
    if (n.state === 'check') {
      push(n, 'verify', cfg.est.verify, n.title, 'node is in `check`');
      continue;
    }
    // 4 — plan approved, plant failed: replant (server action).
    if (n.state === 'planned') {
      push(n, 'replant', cfg.est.replant, n.title, 'plan approved but the tree never planted');
      continue;
    }
    // 5 — Kevin changed it; weigh in.
    if (n.review_state === 'awaiting_jarvis') {
      push(n, 'weigh_in', cfg.est.weigh_in, n.title, 'Kevin edited/moved this — awaiting your take');
      needsYou.push({ goal_id: goal.id, node_id: n.id, title: n.title, reason: 'awaiting_weigh_in' });
      continue;
    }
    if (ancestorsBlock(ix, n)) continue;
    // 6 — the next runnable machine leaf.
    if (n.state === 'set' && n.leaf_kind === 'machine' && n.plan_state === 'none' && earlierOk(n)) {
      const retry = n.autopilot_attempts > 0;
      push(n, retry ? 'replan' as NightItemKind : 'plan', pEst, n.title,
        retry ? `attempt ${n.autopilot_attempts + 1} of ${cfg.max_attempts} after a FAIL` : 'next runnable machine leaf');
      continue;
    }
    // 7/8 — an unclassified set node with no children.
    if (n.state === 'set' && n.leaf_kind === 'none' && n.child_count === 0 && n.promoted_to_goal_id == null && earlierOk(n)) {
      if (n.depth < cfg.max_depth) {
        const dec = push(n, 'decompose', cfg.est.decompose, n.title, `set node, no children, depth ${n.depth} of ${cfg.max_depth}`);
        push(null, 'predicted', cfg.predicted_children * pEst, `↳ then: build #${n.id}'s children`,
          `guessed fan-out: ${cfg.predicted_children} children × ${pEst}m`, dec);
      } else {
        push(n, 'classify', cfg.est.classify, n.title, `at max_depth ${cfg.max_depth}`);
      }
      continue;
    }
    // 9 — a human leaf is Kevin's, never an item.
    if (n.state === 'set' && n.leaf_kind === 'human') {
      needsYou.push({ goal_id: goal.id, node_id: n.id, title: n.title, reason: 'human' });
      continue;
    }
    // 10 — parked.
    if (n.state === 'parked') {
      needsYou.push({ goal_id: goal.id, node_id: n.id, title: n.title, reason: 'parked' });
      continue;
    }
    // 11 — done / a parent with children / anything else: no item.
  }

  // Goal root with every child settled → Kevin's verify moment, never an item.
  const live = tree.nodes.filter((n) => n.state !== 'discarded');
  if (live.length && !out.some((d) => d.kind !== 'predicted') && goal.status === 'set') {
    needsYou.push({ goal_id: goal.id, node_id: null, title: goal.title, reason: 'root_ready_to_verify' });
  }
  return out;
}

interface GoalRank {
  goal: GoalRow;
  tree: GoalTree;
  score: number;
  momentum: number;
  closeness: number;
  freshness: number;
  bonus: number;
  rank: number;
}

const goalThreadActivity = sqliteDb.prepare(`
  SELECT MAX(t.created_at) AS at FROM turns t
  JOIN conversations c ON c.id = t.conversation_id
  WHERE c.external_id = ? OR c.external_id LIKE ?
`);

/** §3.2 — "finish what's closest to done first, then what's moving, then the rest." */
function rankGoals(entries: Array<{ goal: GoalRow; tree: GoalTree; stream: ItemDraft[] }>, at: number): GoalRank[] {
  const ranked = entries.map(({ goal, tree, stream }) => {
    const live = tree.nodes.filter((n) => n.state !== 'discarded');
    const total = live.length;
    const advanced = live.filter((n) => n.state === 'done' || n.state === 'working').length;
    const momentum = total ? advanced / total : 0;
    const realItems = stream.filter((d) => d.kind !== 'predicted').length;
    const closeness = 1 / (1 + realItems);
    const evAt = sqliteToMs((sqliteDb.prepare(`SELECT MAX(created_at) AS at FROM goal_events WHERE goal_id = ?`)
      .get(goal.id) as { at: string | null } | undefined)?.at);
    const turnAt = sqliteToMs((goalThreadActivity.get(`cockpit:goal-${goal.id}`, `cockpit:goal-${goal.id}-node-%`) as { at: string | null } | undefined)?.at);
    const last = Math.max(evAt ?? 0, turnAt ?? 0);
    const freshness = last > 0 && at - last <= 24 * 60 * 60 * 1000 ? 1 : 0.4;
    const bonus = goal.autopilot === 1 ? 0.1 : 0;
    const score = 0.5 * momentum + 0.3 * closeness + 0.2 * freshness + bonus;
    return { goal, tree, score, momentum, closeness, freshness, bonus, rank: 0 };
  });
  ranked.sort((a, b) => b.score - a.score || a.goal.id - b.goal.id);
  ranked.forEach((r, i) => { r.rank = i + 1; });
  return ranked;
}

function whyLine(r: GoalRank, d: ItemDraft, total: number): string {
  return `goal_score ${r.score.toFixed(3)} (rank ${r.rank}/${total}; momentum ${r.momentum.toFixed(2)} · closeness ${r.closeness.toFixed(2)} · fresh ${r.freshness.toFixed(1)}${r.bonus ? ' · autopilot +0.1' : ''}) — ${d.why_kind}; DFS #${d.dfs_index + 1}`;
}

// -- §3.4 lane simulation ---------------------------------------------------

interface SimRow {
  draft: ItemDraft;
  est: number;
  status: 'queued' | 'running' | 'done';
  start: number;
  end: number;
}

interface SimContext {
  /** node id → simulated settle time (minutes from t0); pre-seeded with 0 for
   *  nodes that are ALREADY settled in reality. */
  settledAt: Map<number, number>;
  ix: Map<number, TreeIndex>;
  goalPar: Map<number, number>;
}

/** §12.6 — Night Shift must never throttle a goal Kevin already runs wider. */
export function goalParallel(goal: GoalRow, cfg: NightRunConfig): number {
  const prior = goal.autopilot === 1 ? (goal.autopilot_config?.parallel ?? AUTOPILOT_DEFAULTS.parallel) : 0;
  return Math.max(cfg.per_goal_parallel, prior);
}

/** §3.4 — walk the frozen list through `lanes` slots and stamp an eta on every
 *  row. Deterministic; also rerun after move / insert / expand. */
function simulateLanes(
  rows: SimRow[], cfg: NightRunConfig, ctx: SimContext,
): number {
  const lanes = Math.max(1, cfg.lanes);
  const laneFree = new Array(lanes).fill(0);
  let t = 0;
  let guard = 0;
  const running: SimRow[] = [];

  const readyTime = (r: SimRow): number | null => {
    if (r.draft.kind === 'predicted') {
      const parent = r.draft.parent_draft;
      if (!parent) return 0;
      const pr = rows.find((x) => x.draft === parent);
      if (!pr) return 0;
      return pr.status === 'done' ? pr.end : null;
    }
    const nodeId = r.draft.node_id;
    if (nodeId == null) return 0;
    const ix = ctx.ix.get(r.draft.goal_id);
    const node = ix?.byId.get(nodeId);
    if (!ix || !node) return 0;
    let ready = 0;
    for (const x of earlierOf(ix, node)) {
      const at = ctx.settledAt.get(x.id);
      if (at == null) return null;          // not settled and not scheduled yet
      ready = Math.max(ready, at);
    }
    return ready;
  };

  const settle = (r: SimRow): void => {
    if (r.draft.node_id != null) ctx.settledAt.set(r.draft.node_id, r.end);
  };

  const sameSubtreeBusy = (r: SimRow): boolean => {
    const ix = ctx.ix.get(r.draft.goal_id);
    if (!ix || r.draft.node_id == null) return false;
    const mine = topAncestorId(ix, r.draft.node_id);
    return running.some((o) => {
      if (o.draft.goal_id !== r.draft.goal_id || o.draft.node_id == null) return false;
      if (o.draft.kind === 'finish') return false; // §12.7 — pre-existing facts
      return topAncestorId(ix, o.draft.node_id) === mine;
    });
  };

  while (guard++ < 20_000) {
    // complete anything that finished at or before t
    for (let i = running.length - 1; i >= 0; i -= 1) {
      if (running[i].end <= t) { running[i].status = 'done'; settle(running[i]); running.splice(i, 1); }
    }
    if (!rows.some((r) => r.status === 'queued')) break;

    // A) server kinds run inline: no lane, no caps (§12.4)
    let fired = false;
    for (const r of rows) {
      if (r.status !== 'queued' || !isServerKind(r.draft.kind)) continue;
      const rt = readyTime(r);
      if (rt == null || rt > t) continue;
      r.start = Math.max(rt, t);
      r.end = r.start + r.est;
      r.status = 'done';
      settle(r);
      fired = true;
    }
    if (fired) continue;

    // B) lane kinds (model kinds + predicted placeholders)
    let started = false;
    for (const r of rows) {
      if (r.status !== 'queued' || isServerKind(r.draft.kind)) continue;
      const rt = readyTime(r);
      if (rt == null || rt > t) continue;
      const lane = laneFree.findIndex((f) => f <= t);
      if (lane === -1) break;
      const exempt = r.draft.kind === 'finish';
      if (!exempt) {
        const par = ctx.goalPar.get(r.draft.goal_id) ?? cfg.per_goal_parallel;
        const busy = running.filter((o) => o.draft.goal_id === r.draft.goal_id && o.draft.kind !== 'finish').length;
        if (busy >= par) continue;
        if (sameSubtreeBusy(r)) continue;
      }
      r.start = t;
      r.end = t + r.est;
      r.status = 'running';
      laneFree[lane] = r.end;
      running.push(r);
      started = true;
    }
    if (started) continue;

    // C) advance the clock to the next interesting instant
    const next: number[] = [];
    for (const r of running) if (r.end > t) next.push(r.end);
    for (const f of laneFree) if (f > t) next.push(f);
    for (const r of rows) {
      if (r.status !== 'queued') continue;
      const rt = readyTime(r);
      if (rt != null && rt > t) next.push(rt);
    }
    if (!next.length) break;   // nothing schedulable — leave the rest without an eta
    t = Math.min(...next);
  }
  return rows.reduce((acc, r) => Math.max(acc, r.status === 'queued' ? 0 : r.end), 0);
}

function isoPlus(baseMs: number, minutes: number): string {
  return new Date(baseMs + minutes * 60_000).toISOString();
}

/** Build the SimContext for a set of drafts (fresh trees read once). */
function simContext(goalIds: number[], cfg: NightRunConfig, trees: Map<number, GoalTree>): SimContext {
  const ctx: SimContext = { settledAt: new Map(), ix: new Map(), goalPar: new Map() };
  for (const gid of goalIds) {
    const tree = trees.get(gid);
    if (!tree) continue;
    const ix = indexTree(tree.nodes);
    ctx.ix.set(gid, ix);
    const goal = getRawGoal(gid);
    ctx.goalPar.set(gid, goal ? goalParallel(goal, cfg) : cfg.per_goal_parallel);
    for (const n of tree.nodes) if (isSettled(n)) ctx.settledAt.set(n.id, 0);
  }
  return ctx;
}

export function planNight(input: {
  mode?: NightRunMode; goal_ids?: number[]; config?: unknown; actor?: 'kevin' | 'jarvis' | 'system';
} = {}): NightPlanPreview {
  const live = activeNightRun();
  if (live && live.status !== 'planned') {
    throw new NightError(409, 'night_run_active', `night run #${live.id} is ${live.status} — stop it before planning another night`);
  }
  const cfg = normalizeNightConfig(input.config);
  const mode: NightRunMode = input.mode === 'until_budget' ? 'until_budget' : 'until_stop';
  // §3.4 — the lane sim runs at minute resolution, so the anchor is the top of
  // the current minute (two plans in the same minute are byte-identical).
  const at = Math.floor(nowMs() / 60_000) * 60_000;
  const goals = scopeGoals(input.goal_ids);
  const needsYou: NightNeedsYou[] = [];
  const trees = new Map<number, GoalTree>();
  const entries: Array<{ goal: GoalRow; tree: GoalTree; stream: ItemDraft[] }> = [];
  for (const goal of goals) {
    const tree = getGoalTree(goal.id);
    if (!tree) continue;
    trees.set(goal.id, tree);
    entries.push({ goal, tree, stream: simulateGoal(goal, tree, cfg, at, needsYou) });
  }
  const ranked = rankGoals(entries, at);

  // §3.3 assemble — (goal_rank, dfs_index), then every `finish` floats to the
  // top keeping its relative order (§12.5).
  const byGoal = new Map(entries.map((e) => [e.goal.id, e]));
  const ordered: Array<{ draft: ItemDraft; why: string }> = [];
  for (const r of ranked) {
    const stream = byGoal.get(r.goal.id)?.stream ?? [];
    for (const d of stream) ordered.push({ draft: d, why: whyLine(r, d, ranked.length) });
  }
  const finishes = ordered.filter((o) => o.draft.kind === 'finish');
  const rest = ordered.filter((o) => o.draft.kind !== 'finish');
  const finalOrder = [...finishes, ...rest];

  // Lane sim → etas.
  const ctx = simContext([...trees.keys()], cfg, trees);
  const simRows: SimRow[] = finalOrder.map((o) => ({ draft: o.draft, est: o.draft.est_minutes, status: 'queued', start: 0, end: 0 }));
  simulateLanes(simRows, cfg, ctx);

  // Persist — replace any un-started `planned` run (re-planning before Start is normal).
  const tx = sqliteDb.transaction(() => {
    if (live && live.status === 'planned') {
      sqliteDb.prepare(`DELETE FROM night_items WHERE run_id = ?`).run(live.id);
      sqliteDb.prepare(`DELETE FROM night_events WHERE run_id = ?`).run(live.id);
      sqliteDb.prepare(`DELETE FROM night_runs WHERE id = ?`).run(live.id);
    }
    const info = sqliteDb.prepare(
      `INSERT INTO night_runs (status, mode, config, goal_ids, prior_autopilot, planned_at) VALUES ('planned', ?, ?, ?, '{}', ?)`,
    ).run(mode, JSON.stringify(cfg), JSON.stringify(ranked.map((r) => r.goal.id)), nowIso());
    const runId = Number(info.lastInsertRowid);
    const insert = sqliteDb.prepare(
      `INSERT INTO night_items (run_id, position, goal_id, node_id, parent_item_id, kind, title, why, est_minutes, eta_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    const idOf = new Map<ItemDraft, number>();
    simRows.forEach((row, i) => {
      const d = row.draft;
      const why = finalOrder.find((o) => o.draft === d)?.why ?? '';
      const info2 = insert.run(
        runId, i + 1, d.goal_id, d.node_id,
        d.parent_draft ? (idOf.get(d.parent_draft) ?? null) : null,
        d.kind, d.title.slice(0, 300), why, d.est_minutes,
        row.status === 'queued' ? null : isoPlus(at, row.end),
      );
      idOf.set(d, Number(info2.lastInsertRowid));
    });
    return runId;
  });
  const runId = tx();

  const run = getNightRun(runId)!;
  const items = listNightItems(runId);
  const etaEnd = items.reduce<string | null>((acc, it) => (it.eta_at && (!acc || it.eta_at > acc) ? it.eta_at : acc), null);
  insertNightEvent(runId, null, input.actor ?? 'kevin', 'run_planned',
    `Planned ${items.length} item(s) across ${run.goal_ids.length} goal(s); list ends ~${ctTime(etaEnd)} CT.`,
    { items: items.length, goals: run.goal_ids, eta_end: etaEnd, needs_you: needsYou.length });
  emitRun('planned', run);                                   // §12.15 — ONE event, not 42
  postPlanReadyCue(run, items, etaEnd);
  return { run, items, eta_end: etaEnd };
}

/** §6.2 — the one place a model touches the order before Start. Never blocks it. */
function postPlanReadyCue(run: NightRunRow, items: NightItemRow[], etaEnd: string | null): void {
  try {
    seedNightThreadIfNew();
    const top = items.slice(0, 12).map((it) => `#${it.position} G${it.goal_id} ${it.node_id != null ? `#${it.node_id} ` : ''}${it.title} · ${it.kind} · ${it.est_minutes}m — ${it.why}`);
    const text = [
      `[night-shift PLAN READY run #${run.id} — ${items.length} items, est until ${ctTime(etaEnd)}]`,
      'Read the top of the list ONCE and sanity-check the ORDER only. You may not add work, decompose anything, or touch a goal tree in this turn.',
      `Then: one \`log\` op with a one-line verdict (recorded as the plan review), and AT MOST 3 \`move\` ops with a reason each. Finish inside this turn — Start does not wait for you.`,
      '',
      ...top,
      items.length > 12 ? `… (+${items.length - 12} more)` : '',
    ].filter(Boolean).join('\n');
    postCue(NIGHT_THREAD_EXT, text, `night:${run.id}:plan-ready`, 'night-shift');
  } catch (err) {
    console.error('[night-shift] plan-ready cue failed', err);
  }
}

// ---------------------------------------------------------------------------
// Re-simulation of a live list (after move / insert / expand)
// ---------------------------------------------------------------------------

const OPEN_STATUSES = new Set<NightItemStatus>(['queued', 'running']);

/** Recompute `eta_at` for every still-open row of a run. Done/running items keep
 *  their real times; t0 = now. Deterministic and side-effect-free besides the
 *  eta writes (§3.4 "also rerun after move/insert/expand"). */
export function resimulateEtas(run: NightRunRow): string | null {
  const items = listNightItems(run.id);
  const cfg = run.config;
  const trees = new Map<number, GoalTree>();
  for (const gid of run.goal_ids) {
    const t = getGoalTree(gid);
    if (t) trees.set(gid, t);
  }
  const ctx = simContext(run.goal_ids, cfg, trees);
  // Anything already settled by the run itself settles at t=0.
  for (const it of items) {
    if (!OPEN_STATUSES.has(it.status) && it.node_id != null) ctx.settledAt.set(it.node_id, 0);
  }
  const at = Math.floor(nowMs() / 60_000) * 60_000;   // minute resolution, like planNight
  const draftById = new Map<number, ItemDraft>();
  const open = items.filter((it) => OPEN_STATUSES.has(it.status));
  const rows: SimRow[] = [];
  for (const it of open) {
    const draft: ItemDraft = {
      goal_id: it.goal_id, node_id: it.node_id, kind: it.kind, title: it.title,
      est_minutes: it.est_minutes, dfs_index: it.position, why_kind: '', parent_draft: null,
    };
    draftById.set(it.id, draft);
  }
  for (const it of open) {
    const d = draftById.get(it.id)!;
    if (it.parent_item_id != null) d.parent_draft = draftById.get(it.parent_item_id) ?? null;
  }
  for (const it of open) {
    const d = draftById.get(it.id)!;
    if (it.status === 'running') {
      const spent = elapsedMinutes(it.started_at, at);
      rows.push({ draft: d, est: Math.max(1, it.est_minutes - spent), status: 'queued', start: 0, end: 0 });
    } else {
      rows.push({ draft: d, est: it.est_minutes, status: 'queued', start: 0, end: 0 });
    }
  }
  simulateLanes(rows, cfg, ctx);
  let etaEnd: string | null = null;
  const upd = sqliteDb.prepare(`UPDATE night_items SET eta_at = ?, updated_at = datetime('now') WHERE id = ?`);
  open.forEach((it, i) => {
    const r = rows[i];
    const eta = r.status === 'queued' ? null : isoPlus(at, r.end);
    upd.run(eta, it.id);
    if (eta && (!etaEnd || eta > etaEnd)) etaEnd = eta;
  });
  return etaEnd;
}

export function nightEtaEnd(runId: number): string | null {
  return listNightItems(runId).reduce<string | null>((acc, it) => (it.eta_at && (!acc || it.eta_at > acc) ? it.eta_at : acc), null);
}

// ---------------------------------------------------------------------------
// Position surgery — §3.3 / §12.12: locked rows keep their ABSOLUTE position
// ---------------------------------------------------------------------------

/** Open `count` slots for new rows at/after `from`, honouring §12.12: a LOCKED
 *  row keeps its ABSOLUTE position, unlocked rows slide down around it, and the
 *  list stays contiguous 1..N+count. Returns the positions the new rows take.
 *
 *  REVIEW (node #682) — the previous version bumped `position + count` on every
 *  unlocked row at/after the target and then `renumber()`d the whole list, which
 *  (a) COLLIDED a shifted row onto a locked row sitting further down and (b)
 *  then moved that locked row anyway when renumber re-packed by (position, id).
 *  Building the final slot order in memory is both correct and simpler. */
function makeRoom(runId: number, from: number, count: number): number[] {
  const items = listNightItems(runId);
  const total = items.length + count;
  const locked = new Map<number, NightItemRow>();
  const unlocked: NightItemRow[] = [];
  for (const it of items) {
    if (it.locked && !locked.has(it.position)) locked.set(it.position, it);
    else unlocked.push(it);
  }
  // Walk past any locked occupant sitting exactly at the insertion point.
  let target = Math.max(1, Math.min(from, total));
  while (locked.has(target)) target += 1;

  const holes: number[] = [];
  const upd = sqliteDb.prepare(`UPDATE night_items SET position = ?, updated_at = datetime('now') WHERE id = ?`);
  let holesLeft = count;
  let ui = 0;
  for (let pos = 1; pos <= total; pos += 1) {
    const lk = locked.get(pos);
    if (lk) { if (lk.position !== pos) upd.run(pos, lk.id); continue; }
    if (pos >= target && holesLeft > 0) { holes.push(pos); holesLeft -= 1; continue; }
    if (ui < unlocked.length) { const it = unlocked[ui]; ui += 1; if (it.position !== pos) upd.run(pos, it.id); continue; }
    holes.push(pos); holesLeft -= 1;
  }
  return holes;
}

interface InsertSpec {
  goal_id: number; node_id: number | null; kind: NightItemKind; title: string;
  why: string; est_minutes: number; attempt?: number; parent_item_id?: number | null;
}

/** Insert follow-up rows immediately AFTER `afterItemId` (§3.3c). */
function insertAfter(run: NightRunRow, afterItemId: number | null, specs: InsertSpec[]): NightItemRow[] {
  if (!specs.length) return [];
  const anchor = afterItemId != null ? getItem(afterItemId) : null;
  const from = anchor ? anchor.position + 1 : listNightItems(run.id).length + 1;
  const holes = makeRoom(run.id, from, specs.length);
  const insert = sqliteDb.prepare(
    `INSERT INTO night_items (run_id, position, goal_id, node_id, parent_item_id, kind, title, why, est_minutes, attempt)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  const out: NightItemRow[] = [];
  specs.forEach((s, i) => {
    const info = insert.run(run.id, holes[i], s.goal_id, s.node_id, s.parent_item_id ?? null,
      s.kind, s.title.slice(0, 300), s.why, Math.max(1, Math.round(s.est_minutes)), s.attempt ?? 1);
    const row = getItem(Number(info.lastInsertRowid))!;
    out.push(row);
    emitItem('created', row);
    insertNightEvent(run.id, row.id, 'system', 'item_inserted', `#${row.position} ${row.kind} — ${row.title}`, { after: afterItemId, kind: row.kind });
  });
  resimulateEtas(getNightRun(run.id)!);
  return out.map((r) => getItem(r.id)!);
}

export function moveNightItem(runId: number, itemId: number, position: number, actor: 'kevin' | 'jarvis' = 'kevin'): NightItemRow[] {
  const run = getNightRun(runId);
  if (!run) throw new NightError(404, 'night_run_not_found', 'night run not found');
  const item = getItem(itemId);
  if (!item || item.run_id !== runId) throw new NightError(404, 'night_item_not_found', 'night item not found');
  const items = listNightItems(runId);
  const target = Math.min(Math.max(1, Math.round(position)), items.length);
  const from = item.position;
  if (target !== from) {
    const rest = items.filter((i) => i.id !== itemId);
    rest.splice(target - 1, 0, item);
    const upd = sqliteDb.prepare(`UPDATE night_items SET position = ?, updated_at = datetime('now') WHERE id = ?`);
    rest.forEach((it, i) => upd.run(i + 1, it.id));
  }
  sqliteDb.prepare(`UPDATE night_items SET locked = 1, updated_at = datetime('now') WHERE id = ?`).run(itemId);
  resimulateEtas(getNightRun(runId)!);
  const fresh = listNightItems(runId);
  insertNightEvent(runId, itemId, actor, 'reorder', `#${from} → #${target} (locked): ${item.title}`, { from, to: target });
  for (const it of fresh) emitItem('updated', it);
  invalidatePausedCache();
  return fresh;
}

export function skipNightItem(runId: number, itemId: number, actor: 'kevin' | 'jarvis' = 'kevin'): NightItemRow {
  const item = getItem(itemId);
  if (!item || item.run_id !== runId) throw new NightError(404, 'night_item_not_found', 'night item not found');
  if (item.status !== 'queued') {
    throw new NightError(409, 'night_item_not_skippable', `item is ${item.status}; only queued items can be skipped`);
  }
  const fresh = setItem(itemId, { status: 'skipped', finished_at: nowIso(), result_summary: `skipped by ${actor}` });
  insertNightEvent(runId, itemId, actor, 'item_skipped', `#${item.position} ${item.title}`);
  resimulateEtas(getNightRun(runId)!);
  return fresh;
}

/** §5 — manual add (orchestrator tool / Kevin). Kind is derived from node state. */
export function addNightItem(runId: number, goalId: number, nodeId: number, afterItemId?: number | null, actor: 'kevin' | 'jarvis' = 'jarvis'): NightItemRow {
  const run = getNightRun(runId);
  if (!run) throw new NightError(404, 'night_run_not_found', 'night run not found');
  const tree = getGoalTree(goalId);
  const node = tree?.nodes.find((n) => n.id === nodeId);
  if (!tree || !node) throw new NightError(404, 'goal_node_not_found', 'goal node not found');
  const cfg = run.config;
  const kind = deriveKind(node, cfg);
  if (!kind) throw new NightError(409, 'night_item_not_schedulable', `node #${nodeId} is ${node.state}/${node.leaf_kind} — nothing to schedule`);
  const est = estimateFor(kind, cfg, node);
  const [row] = insertAfter(run, afterItemId ?? null, [{
    goal_id: goalId, node_id: nodeId, kind, title: node.title, est_minutes: est,
    why: `added by ${actor} — node is ${node.state}`,
  }]);
  insertNightEvent(runId, row.id, actor, 'item_inserted', `manual add #${row.position} ${kind} — ${node.title}`);
  return row;
}

function deriveKind(node: GoalNodeRow, cfg: NightRunConfig): NightItemKind | null {
  if (node.state === 'working' && node.tree_status_cache === 'blocked') return 'unblock';
  if (node.state === 'working') return 'finish';
  if (node.state === 'check') return 'verify';
  if (node.state === 'planned') return 'replant';
  if (node.review_state === 'awaiting_jarvis') return 'weigh_in';
  if (node.state === 'set' && node.leaf_kind === 'machine' && node.plan_state === 'none') {
    return node.autopilot_attempts > 0 ? 'replan' : 'plan';
  }
  if (node.state === 'set' && node.leaf_kind === 'none' && node.child_count === 0) {
    return node.depth < cfg.max_depth ? 'decompose' : 'classify';
  }
  return null;
}

function estimateFor(kind: NightItemKind, cfg: NightRunConfig, node?: GoalNodeRow | null): number {
  switch (kind) {
    case 'decompose': return cfg.est.decompose;
    case 'classify': return cfg.est.classify;
    case 'verify': return cfg.est.verify;
    case 'replant': return cfg.est.replant;
    case 'unblock': return cfg.est.unblock;
    case 'weigh_in': return cfg.est.weigh_in;
    case 'predicted': return cfg.predicted_children * planEst(cfg);
    case 'finish': {
      const t = node?.tree_id ? getHopperTree(node.tree_id) : null;
      return Math.max(5, planEst(cfg) - elapsedMinutes(t?.created_at, nowMs()));
    }
    default: return planEst(cfg);
  }
}

// ---------------------------------------------------------------------------
// §2.2 The orchestrator thread — one forever
// ---------------------------------------------------------------------------

function composeNightSeed(): string {
  return [
    'You are the NIGHT SHIFT orchestrator.',
    '',
    'This one thread runs Kevin\'s whole night across every goal. A deterministic server-side driver picks the next item off a FROZEN ordered list and posts it here as a cue; you do exactly that one step on that one node and stop. The list, the lanes, the pausing and the budget are the server\'s job — never yours.',
    '',
    'Rules for every cue turn:',
    '- Kevin is asleep. Never ask him anything and never end a turn on a question. If a step genuinely needs him, `park` the node with a reason and `log` it — the morning report surfaces it.',
    '- Do the ONE step the cue names, on the ONE node it names. Do not wander the tree, do not start other goals, do not add work to the night.',
    '- Reply in ≤4 lines, then exactly one `log` op (one sentence: what you decided and why). The morning report is built from those lines.',
    '- The `goals` tool needs an explicit `goal_id` here (this is not a goal chat). The cue header tells you which goal.',
    '- Use `night_shift` for the list itself: `status` to see where you are, `log` for your own read, `move`/`skip` only if Kevin asks you in this thread.',
    '',
    'Kevin may talk to you here at any time — answer him with the list in context. He can pause, resume, reorder and stop from the /night board; you never do any of that on your own.',
    '',
    'The model for this thread is Kevin\'s manual pick (the picker in this window\'s header). It starts on Opus 5.',
  ].join('\n');
}

/** §5 / §12.14 — find-or-create, mirroring getOrCreateGoalThread exactly. The
 *  model override is applied ONCE at creation; after that the picker is Kevin's. */
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
export const getOrCreateNightThread = ensureNightThread;

/** REVIEW (node #682) — seed the thread the moment WE create it.
 *
 *  `ensureNightThread()` only RETURNS the seed text; the cockpit posts it on
 *  first open. But `planNight` / `startNightRun` both create the thread too —
 *  so a night planned from the tool or a curl (no /night tab open) got a
 *  PLAN-READY cue in a thread with no persona at all, and the UI, seeing
 *  `created:false` later, would never seed it. Same failure as the un-seeded
 *  goal-1 chat. Posting it as a cue is idempotent by construction: it only ever
 *  fires on the turn the conversation is born. */
function seedNightThreadIfNew(): void {
  try {
    const t = ensureNightThread();
    if (t.created && t.seed_text) postCue(NIGHT_THREAD_EXT, t.seed_text, 'night:seed', 'night-shift');
  } catch (err) {
    console.error('[night-shift] orchestrator seed failed', err);
  }
}

// ---------------------------------------------------------------------------
// §2.1 Run lifecycle
// ---------------------------------------------------------------------------

function nightConfigToAutopilot(goal: GoalRow, cfg: NightRunConfig): Partial<AutopilotConfig> {
  return {
    build_model: cfg.build_model,
    light_model: cfg.light_model,
    verify_model: cfg.verify_model,
    max_depth: cfg.max_depth,
    max_attempts: cfg.max_attempts,
    parallel: Math.min(3, goalParallel(goal, cfg)),
    tick_minutes: 10,
  };
}

function registerCommitment(run: NightRunRow): void {
  try {
    const has = sqliteDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='watch_commitments'`).get();
    if (!has) return;
    const due = new Date(nowMs() + 10 * 60 * 60 * 1000).toISOString();
    sqliteDb.prepare(
      `INSERT INTO watch_commitments (subject, thread_ext, check_type, check_ref, due_at, status)
       VALUES (?,?,?,?,?,'open')`,
    ).run(`Night Shift run #${run.id} wraps by morning with a report`, NIGHT_THREAD_EXT, 'manual', `night_run:${run.id}`, due);
  } catch (err) {
    console.warn('[night-shift] commitment registration skipped', err);
  }
}

function resolveCommitment(run: NightRunRow): void {
  try {
    sqliteDb.prepare(
      `UPDATE watch_commitments SET status = 'done', resolved_at = datetime('now') WHERE check_ref = ? AND status = 'open'`,
    ).run(`night_run:${run.id}`);
  } catch { /* the watchdog table is optional */ }
}

export function startNightRun(runId: number, actor: 'kevin' | 'jarvis' = 'kevin'): NightRunRow {
  const run = getNightRun(runId);
  if (!run) throw new NightError(404, 'night_run_not_found', 'night run not found');
  if (run.status !== 'planned') {
    throw new NightError(409, 'night_invalid_transition', `run is ${run.status}, expected planned`);
  }
  const prior: Record<string, PriorAutopilotEntry> = {};
  for (const gid of run.goal_ids) {
    const goal = getRawGoal(gid);
    if (!goal) continue;
    prior[String(gid)] = { autopilot: goal.autopilot, config: goal.autopilot_config ?? null };
  }
  const updated = setRun(runId, {
    status: 'running', started_at: nowIso(), paused_at: null,
    prior_autopilot: JSON.stringify(prior),
  });
  // Adopt: every included goal runs on the night's models while the run owns it.
  for (const gid of updated.goal_ids) {
    const goal = getRawGoal(gid);
    if (!goal) continue;
    try {
      setGoalAutopilot(gid, true, nightConfigToAutopilot(goal, updated.config), 'system');
    } catch (err) {
      console.warn(`[night-shift] could not adopt goal #${gid} onto autopilot:`, err instanceof Error ? err.message : err);
    }
  }
  seedNightThreadIfNew();
  registerCommitment(updated);
  insertNightEvent(runId, null, actor, 'run_started',
    `Night run #${runId} started (${updated.mode}, ${updated.config.lanes} lanes, ${updated.goal_ids.length} goals).`,
    { goal_ids: updated.goal_ids, lanes: updated.config.lanes, mode: updated.mode });
  invalidatePausedCache();
  emitRun('started', updated);
  kickNight('start');
  return updated;
}

export function pauseNightRun(runId: number, actor: 'kevin' | 'jarvis' = 'kevin'): NightRunRow {
  const run = getNightRun(runId);
  if (!run) throw new NightError(404, 'night_run_not_found', 'night run not found');
  if (run.status === 'paused') return run;
  if (run.status !== 'running') throw new NightError(409, 'night_invalid_transition', `run is ${run.status}, expected running`);
  const updated = setRun(runId, { status: 'paused', paused_at: nowIso() });
  insertNightEvent(runId, null, actor, 'run_paused', 'Paused — running work finishes, nothing new starts anywhere in the run.');
  emitRun('paused', updated);
  return updated;
}

export function resumeNightRun(runId: number, actor: 'kevin' | 'jarvis' = 'kevin'): NightRunRow {
  const run = getNightRun(runId);
  if (!run) throw new NightError(404, 'night_run_not_found', 'night run not found');
  if (run.status === 'running') return run;
  if (run.status !== 'paused') throw new NightError(409, 'night_invalid_transition', `run is ${run.status}, expected paused`);
  const updated = setRun(runId, { status: 'running', paused_at: null });
  insertNightEvent(runId, null, actor, 'run_resumed', 'Resumed.');
  emitRun('resumed', updated);
  kickNight('resume');
  return updated;
}

/** §2.1 the wrap — ONE code path for stop AND complete. */
export function stopNightRun(
  runId: number, reason: NightStopReason = 'kevin', actor: 'kevin' | 'jarvis' | 'system' = 'kevin',
): NightRunRow {
  const run = getNightRun(runId);
  if (!run) throw new NightError(404, 'night_run_not_found', 'night run not found');
  if (run.status === 'stopped' || run.status === 'complete') return run;
  const finalStatus: NightRunStatus = reason === 'complete' ? 'complete' : 'stopped';

  // 1) running items → skipped (their trees keep running under the goal).
  for (const it of listNightItems(runId)) {
    if (it.status === 'running') {
      setItem(it.id, { status: 'skipped', finished_at: nowIso(), lane: null, result_summary: `left running at wrap (${reason}) — its tree carries on under the goal` });
      insertNightEvent(runId, it.id, 'system', 'item_skipped', `#${it.position} still running at wrap`, { reason });
    } else if (it.status === 'queued') {
      setItem(it.id, { status: 'skipped', finished_at: nowIso(), result_summary: `not reached before the run ${finalStatus}` });
    }
  }

  // 2) restore prior autopilot flags AND configs, byte-for-byte.
  const updated0 = setRun(runId, { status: finalStatus, ended_at: nowIso(), stop_reason: reason, paused_at: null });
  for (const gid of updated0.goal_ids) {
    const prior = updated0.prior_autopilot[String(gid)];
    try {
      if (!prior || prior.autopilot !== 1) {
        setGoalAutopilot(gid, false, undefined, 'system');
      } else if (prior.config) {
        setGoalAutopilot(gid, true, {
          build_model: prior.config.build_model, light_model: prior.config.light_model,
          verify_model: prior.config.verify_model, max_depth: prior.config.max_depth,
          parallel: prior.config.parallel, tick_minutes: prior.config.tick_minutes,
          max_attempts: prior.config.max_attempts,
        }, 'system');
      }
    } catch (err) {
      console.warn(`[night-shift] restoring goal #${gid} autopilot failed:`, err instanceof Error ? err.message : err);
    }
  }

  // 3) report + cue + bell + commitment.
  let reportPath: string | null = null;
  try {
    const report = buildNightShiftReport(runId);
    reportPath = report.written ? report.path : null;
  } catch (err) {
    console.error('[night-shift] report build failed', err);
  }
  const updated = setRun(runId, { report_path: reportPath, status: finalStatus });
  insertNightEvent(runId, null, actor, finalStatus === 'complete' ? 'run_complete' : 'run_stopped',
    `Night run #${runId} ${finalStatus} (${reason}).`, { reason, report_path: reportPath });
  const stats = buildNightStats(updated);
  try {
    postCue(NIGHT_THREAD_EXT,
      [`[night-shift run #${runId} ${finalStatus.toUpperCase()} — ${reason}]`,
       `${stats.items.done} done · ${stats.items.failed} failed · ${stats.items.blocked} blocked · ${stats.items.skipped} skipped · ${stats.trees_spawned} trees.`,
       reportPath ? `Report: ${reportPath}` : 'Report could not be written — say so in your summary.',
       'Post a ≤10-line morning summary of the run here (what landed, what is parked, what needs Kevin), then ONE `log` op. Do not start any new work.'].join('\n'),
      `night:${runId}:wrap`, 'night-shift');
  } catch (err) { console.error('[night-shift] wrap cue failed', err); }
  try {
    createNotification({
      severity: reason === 'stuck' ? 'error' : 'success',
      title: `🌙 Night Shift run #${runId} ${finalStatus}`,
      body: `${reason} · ${stats.items.done} done / ${stats.items.failed} failed / ${stats.items.blocked} blocked${reportPath ? ` · ${reportPath}` : ''}`,
      source: 'night-shift',
      link: '/night',
    });
  } catch (err) { console.error('[night-shift] wrap bell failed', err); }
  resolveCommitment(updated);
  invalidatePausedCache();
  emitRun(finalStatus === 'complete' ? 'complete' : 'stopped', updated);
  return updated;
}

// ---------------------------------------------------------------------------
// §4.4 / §4.5 — the two seams the rest of the system reads us through
// ---------------------------------------------------------------------------

let pausedCache: { at: number; ids: Set<string> } | null = null;
function invalidatePausedCache(): void { pausedCache = null; }

/** Tree ids belonging to open items of a PAUSED run. Cached per write. */
export function nightShiftPausedTreeIds(): ReadonlySet<string> {
  if (pausedCache && nowMs() - pausedCache.at < 5_000) return pausedCache.ids;
  const ids = new Set<string>();
  const paused = sqliteDb.prepare(`SELECT id FROM night_runs WHERE status = 'paused'`).all() as Array<{ id: number }>;
  for (const r of paused) {
    for (const it of listNightItems(r.id)) {
      if (it.tree_id && OPEN_STATUSES.has(it.status)) ids.add(it.tree_id);
      // A queued/running item whose node already owns a tree counts too.
      if (!it.tree_id && it.node_id != null && OPEN_STATUSES.has(it.status)) {
        const node = getRawGoalNode(it.node_id);
        if (node?.tree_id) ids.add(node.tree_id);
      }
    }
  }
  pausedCache = { at: nowMs(), ids };
  return ids;
}

/** True while a run in running/paused includes this goal (§4.5 stand-down). */
export function nightShiftOwns(goalId: number): boolean {
  const run = activeNightRun();
  if (!run || (run.status !== 'running' && run.status !== 'paused')) return false;
  return run.goal_ids.includes(goalId);
}

setNightShiftPausedTreesProvider(nightShiftPausedTreeIds);
registerNightShiftOwnership(nightShiftOwns);

// ---------------------------------------------------------------------------
// §4 THE DRIVER
// ---------------------------------------------------------------------------

interface DriverState {
  ticking: boolean;
  pendingKick: boolean;
  kickTimer: NodeJS.Timeout | null;
  lastHold: string | null;
  holdLog: Array<{ reason: string; detail: string; from: number; to: number | null }>;
  idleTicks: number;
  booted: boolean;
}
const driver: DriverState = { ticking: false, pendingKick: false, kickTimer: null, lastHold: null, holdLog: [], idleTicks: 0, booted: false };
const STUCK_TICKS = (() => {
  const n = Number(process.env.NIGHT_SHIFT_STUCK_TICKS);
  return Number.isFinite(n) && n >= 1 ? n : 20;
})();

function noteHold(run: NightRunRow, reason: string | null, detail: string): void {
  if (reason === driver.lastHold) return;
  const t = nowMs();
  const open = driver.holdLog[driver.holdLog.length - 1];
  if (open && open.to == null) open.to = t;
  if (reason) {
    driver.holdLog.push({ reason, detail, from: t, to: null });
    insertNightEvent(run.id, null, 'system', 'hold', `${reason} — ${detail}`, { reason, detail });
    console.log(`[night-shift] run #${run.id} held: ${reason} — ${detail}`);
  } else if (driver.lastHold) {
    insertNightEvent(run.id, null, 'system', 'hold_clear', 'hold cleared');
    console.log(`[night-shift] run #${run.id} resumed`);
  }
  driver.lastHold = reason;
  emitRun('updated', run);
}

function cueCount(itemId: number): number {
  const row = sqliteDb.prepare(`SELECT COUNT(*) AS n FROM night_events WHERE item_id = ? AND kind = 'item_started'`).get(itemId) as { n: number };
  return row?.n ?? 0;
}

function finishItem(run: NightRunRow, item: NightItemRow, status: NightItemStatus, summary: string): NightItemRow {
  const fresh = setItem(item.id, { status, lane: null, finished_at: nowIso(), result_summary: summary.slice(0, 1000) });
  const kind = status === 'done' ? 'item_done' : status === 'blocked' ? 'item_blocked' : status === 'skipped' ? 'item_skipped' : 'item_failed';
  insertNightEvent(run.id, item.id, 'system', kind, `#${item.position} ${item.kind} ${item.title} — ${summary.split('\n')[0]}`.slice(0, 500));
  return fresh;
}

/** One `unblock` follow-up per item, ever (§4.1). A node that re-blocks after
 *  its unblock pass is parked — the standing "one pass per node" rule. */
function onItemBlocked(run: NightRunRow, item: NightItemRow, detail: string): void {
  const priorUnblock = listNightItems(run.id).find(
    (i) => i.node_id != null && i.node_id === item.node_id && i.kind === 'unblock' && i.id !== item.id,
  );
  finishItem(run, item, 'blocked', detail);
  if (priorUnblock) {
    if (OPEN_STATUSES.has(priorUnblock.status)) finishItem(run, priorUnblock, 'failed', 'node blocked again after its unblock pass');
    parkNode(run, item, `tree ${item.tree_id ?? '?'} blocked again after an unblock pass`);
    return;
  }
  if (item.kind === 'unblock' || item.node_id == null) return;
  const node = getRawGoalNode(item.node_id);
  insertAfter(run, item.id, [{
    goal_id: item.goal_id, node_id: item.node_id, kind: 'unblock',
    title: node?.title ?? item.title, est_minutes: run.config.est.unblock,
    why: `inserted after #${item.position} blocked — ${detail}`.slice(0, 300),
  }]);
}

function parkNode(run: NightRunRow, item: NightItemRow, reason: string): void {
  if (item.node_id == null) return;
  try { parkGoalNode(item.goal_id, item.node_id, 'system', reason.slice(0, 500)); }
  catch (err) { console.error('[night-shift] park failed', err); }
}

/** Apply a VERIFY verdict to a `check` node exactly the way autopilot P1 does. */
function applyVerdict(run: NightRunRow, item: NightItemRow, node: GoalNodeRow): { verdict: 'PASS' | 'FAIL'; summary: string; attempts: number } | null {
  const plan = parsePlan(node);
  const verifyId = plan?.verify_hopper_node_id;
  if (!verifyId) return null;
  const hopper = getHopperNode(verifyId);
  const parsed = parseVerdict(hopper?.result, hopper?.status ?? 'missing');
  const verdict: AutopilotVerdict = { ...parsed, tree_id: node.tree_id ?? item.tree_id ?? '', at: nowIso() };
  const after = recordAutopilotVerdict(item.goal_id, node.id, verdict);
  if (parsed.verdict === 'PASS') {
    verifyGoalNode(item.goal_id, node.id, true, parsed.evidence || 'VERIFY: PASS', 'system');
    return { verdict: 'PASS', summary: (parsed.evidence || 'VERIFY: PASS').split('\n')[0], attempts: after.autopilot_attempts };
  }
  verifyGoalNode(item.goal_id, node.id, false, parsed.gaps.join('\n') || 'VERIFY: FAIL', 'system');
  return { verdict: 'FAIL', summary: `VERDICT: FAIL — ${parsed.gaps[0] ?? 'no gap text'}`, attempts: after.autopilot_attempts };
}

/** §4.1 P0 sync — reconcile every running item against live goal/tree state.
 *  Runs on EVERY tick, held or paused or not. Zero model calls. */
function syncItems(run: NightRunRow): void {
  const cfg = run.config;
  for (const item of listNightItems(run.id)) {
    if (item.status !== 'running') continue;
    const node = item.node_id != null ? getRawGoalNode(item.node_id) : null;
    if (!node) { finishItem(run, item, 'failed', 'node is gone'); continue; }
    const derived = { state: node.state, tree_id: node.tree_id, cache: node.tree_status_cache };

    // Stamp the tree the moment the node owns one (the tree IS a plan item).
    if (!item.tree_id && derived.tree_id) setItem(item.id, { tree_id: derived.tree_id });
    const fresh = getItem(item.id)!;

    if (item.kind === 'plan' || item.kind === 'replan' || item.kind === 'finish') {
      if (derived.cache === 'blocked') { onItemBlocked(run, fresh, `tree ${derived.tree_id ?? '?'} is blocked`); continue; }
      if (derived.state === 'check') {
        const full = getGoalTree(item.goal_id)?.nodes.find((n) => n.id === item.node_id);
        const applied = full ? applyVerdict(run, fresh, full) : null;
        if (!applied) {
          // No machine verifier on this node (hand-run plan): leave it for the
          // `verify` server kind to settle; the item is done either way.
          finishItem(run, fresh, 'done', 'tree landed — node is in check, awaiting a verdict');
          continue;
        }
        if (applied.verdict === 'PASS') { finishItem(run, fresh, 'done', applied.summary); continue; }
        if (applied.attempts >= cfg.max_attempts) {
          finishItem(run, fresh, 'failed', applied.summary);
          parkNode(run, fresh, `verify failed ${applied.attempts}/${cfg.max_attempts}: ${applied.summary}`);
          continue;
        }
        // §12.10 — a FAILed plan with retries left reads `done`; the inserted
        // replan carries the ✗ risk and the list keeps moving.
        finishItem(run, fresh, 'done', applied.summary);
        insertAfter(run, fresh.id, [{
          goal_id: item.goal_id, node_id: item.node_id, kind: 'replan',
          title: node.title, est_minutes: planEst(cfg), attempt: fresh.attempt + 1,
          why: `attempt ${fresh.attempt + 1} of ${cfg.max_attempts} after ${applied.summary}`.slice(0, 300),
        }]);
        continue;
      }
      if (derived.state === 'done') { finishItem(run, fresh, 'done', 'node verified done'); continue; }
      if (derived.state === 'parked') { finishItem(run, fresh, 'failed', node.parked_reason ?? 'node parked'); continue; }
      // REVIEW (node #682) — the plan was approved but the tree never planted:
      // the planner's rule 4 case, reached mid-run. Settle the item and let the
      // `replant` server kind retry it, instead of holding the lane forever.
      if (derived.state === 'planned') {
        finishItem(run, fresh, 'done', 'plan approved but the tree never planted');
        insertAfter(run, fresh.id, [{
          goal_id: item.goal_id, node_id: item.node_id, kind: 'replant', title: node.title,
          est_minutes: cfg.est.replant, attempt: fresh.attempt,
          why: `inserted after #${fresh.position} — plan approved, tree never planted`,
        }]);
        continue;
      }
      // REVIEW (node #682) — `finish` items ARE a running tree, so they wait;
      // a plan/replan whose node is still an untouched `set` leaf means the cue
      // itself went unanswered. Re-ask, then fail + park.
      if (item.kind !== 'finish' && derived.state === 'set' && node.plan_state === 'none') {
        nagOrFail(run, fresh, item.kind);
      }
      continue; // still working
    }

    if (item.kind === 'decompose') {
      const tree = getGoalTree(item.goal_id);
      const live = tree?.nodes.find((n) => n.id === item.node_id);
      if (live && live.child_count > 0) {
        finishItem(run, fresh, 'done', `${live.child_count} child node(s)`);
        expandPredicted(run, fresh);
        continue;
      }
      if (live && (live.state === 'parked' || live.leaf_kind !== 'none')) {
        finishItem(run, fresh, 'done', `node is now ${live.state}/${live.leaf_kind}`);
        expandPredicted(run, fresh);
        continue;
      }
      nagOrFail(run, fresh, 'decompose');
      continue;
    }
    if (item.kind === 'classify') {
      if (node.leaf_kind !== 'none' || node.state === 'parked') { finishItem(run, fresh, 'done', `leaf_kind=${node.leaf_kind}, state=${node.state}`); continue; }
      nagOrFail(run, fresh, 'classify');
      continue;
    }
    if (item.kind === 'weigh_in') {
      if (node.review_state !== 'awaiting_jarvis') { finishItem(run, fresh, 'done', `review_state=${node.review_state}`); continue; }
      nagOrFail(run, fresh, 'weigh_in');
      continue;
    }
    if (item.kind === 'unblock') {
      if (node.state === 'parked') { finishItem(run, fresh, 'failed', node.parked_reason ?? 'parked during the unblock pass'); continue; }
      if (derived.cache !== 'blocked') { finishItem(run, fresh, 'done', `tree ${derived.tree_id ?? '?'} is no longer blocked`); continue; }
      nagOrFail(run, fresh, 'unblock');
      continue;
    }
  }
}

/** When did we last put a cue for this item into the orchestrator thread? */
function lastCueAtMs(item: NightItemRow): number {
  const row = sqliteDb.prepare(
    `SELECT created_at FROM night_events WHERE item_id = ? AND kind = 'item_started' ORDER BY id DESC LIMIT 1`,
  ).get(item.id) as { created_at: string } | undefined;
  return sqliteToMs(row?.created_at) ?? sqliteToMs(item.started_at) ?? nowMs();
}

/** REVIEW (node #682) — THE re-ask window, mirroring autopilot §15.4.
 *
 *  Before this, a model-kind item went `running` exactly once and was NEVER
 *  cued again: `fillLanes` only ever picks `queued` rows, so `secondAsk` could
 *  not become true and the contract's "cue posted twice and still no proof →
 *  fail + park" (§4.1) was unreachable. An orchestrator turn that died, was
 *  dropped, or simply did not do the step held its lane until morning — three
 *  of those and the whole night was silently over with the driver reporting
 *  "running". Now: no proof after `recue_minutes` → ask once more (second ask);
 *  still nothing after another `recue_minutes` → fail the item and park the
 *  node, which frees the lane and surfaces it in the morning report. */
function nagOrFail(run: NightRunRow, item: NightItemRow, kind: string): void {
  const waited = Math.max(0, Math.round((nowMs() - lastCueAtMs(item)) / 60_000));
  if (waited < run.config.recue_minutes) return;
  if (cueCount(item.id) >= 2) {
    finishItem(run, item, 'failed', `${kind} cue ignored twice`);
    parkNode(run, item, `night shift: ${kind} cue ignored twice`);
    return;
  }
  const trees = new Map<number, GoalTree>();
  const tree = getGoalTree(item.goal_id);
  if (!tree) { finishItem(run, item, 'failed', 'goal tree is gone'); return; }
  trees.set(item.goal_id, tree);
  runModelItem(run, item, item.lane ?? 1, listNightItems(run.id).length, trees);
}

/** §2.2 predicted→expanded: the real children take the placeholder's block. */
function expandPredicted(run: NightRunRow, decomposeItem: NightItemRow): void {
  const placeholder = listNightItems(run.id).find((i) => i.kind === 'predicted' && i.parent_item_id === decomposeItem.id && i.status === 'queued');
  if (!placeholder) return;
  const cfg = run.config;
  const tree = getGoalTree(decomposeItem.goal_id);
  const parent = tree?.nodes.find((n) => n.id === decomposeItem.node_id);
  if (!tree || !parent) { setItem(placeholder.id, { status: 'expanded', finished_at: nowIso(), result_summary: 'parent node gone' }); return; }
  const children = tree.nodes.filter((n) => n.parent_id === parent.id && n.state !== 'discarded');
  const specs: InsertSpec[] = [];
  for (const c of children) {
    const kind = deriveKind(c, cfg);
    if (!kind) continue;
    specs.push({
      goal_id: decomposeItem.goal_id, node_id: c.id, kind, title: c.title,
      est_minutes: estimateFor(kind, cfg, c),
      why: `expanded from the guessed fan-out of #${parent.id} (${children.length} real children)`,
    });
  }
  // The placeholder vacates its block first, so the real rows land in its slot.
  const at = placeholder.position;
  setItem(placeholder.id, { status: 'expanded', finished_at: nowIso(), result_summary: `${specs.length} real item(s)` });
  insertNightEvent(run.id, placeholder.id, 'system', 'item_expanded', `#${at} → ${specs.length} real item(s) from #${parent.id}`, { children: specs.length });
  if (specs.length) insertAfter(run, placeholder.id, specs);
  else resimulateEtas(getNightRun(run.id)!);
}

// -- §4.2 gates -------------------------------------------------------------

export interface NightHold { reason: string; detail: string }

/** Governor holds that mean "the subscription is spent", not "wait a while". */
const BUDGET_EXHAUSTED_HOLDS: ReadonlySet<string> = new Set([
  'governor:claude_all_accounts_full',
  'governor:weekly_ceiling',
]);

export function nightHoldReason(run: NightRunRow, logging = false): NightHold | null {
  if (getSetting(SETTING_ENABLED) === '0') return { reason: 'disabled', detail: 'settings-KV night_shift_enabled = 0' };
  if (fs.existsSync(NIGHT_STOP_FILE)) return { reason: 'stop_file', detail: NIGHT_STOP_FILE };
  const opts = { ignoreKevinActive: run.config.kevin_active_bypass };
  const gov = overrides.governor ? overrides.governor(opts) : governorCheck('claude', opts);
  if (!gov.allow) return { reason: `governor:${gov.reason}`, detail: gov.detail ?? gov.reason };
  void logging;
  return null;
}

// -- §4.3 fill lanes --------------------------------------------------------

interface Runnability { ok: boolean; why: string }

function runnable(run: NightRunRow, item: NightItemRow, running: NightItemRow[], trees: Map<number, GoalTree>): Runnability {
  if (item.kind === 'predicted') return { ok: false, why: 'placeholder — never executed' };
  const tree = trees.get(item.goal_id);
  const node = item.node_id != null ? tree?.nodes.find((n) => n.id === item.node_id) : null;
  if (!tree || !node) return { ok: false, why: 'node is gone' };
  const ix = indexTree(tree.nodes);
  if (ancestorsBlock(ix, node)) return { ok: false, why: 'an ancestor is a ghost or parked' };
  const blocking = earlierOf(ix, node).filter((x) => !isSettled(x));
  if (blocking.length) return { ok: false, why: `waits on #${blocking[0].id} ${blocking[0].title}`.slice(0, 160) };
  if (isServerKind(item.kind)) return { ok: true, why: '' };          // §12.4 — no lane, no caps
  if (item.kind === 'finish') return { ok: true, why: '' };           // §12.7 — already running
  const goalRow = getRawGoal(item.goal_id);
  if (!goalRow) return { ok: false, why: 'goal is gone' };
  const par = goalParallel(goalRow, run.config);
  const busy = running.filter((r) => r.goal_id === item.goal_id && r.kind !== 'finish');
  if (busy.length >= par) return { ok: false, why: `goal #${item.goal_id} already at its parallel cap (${par})` };
  const mine = topAncestorId(ix, node.id);
  for (const r of busy) {
    if (r.node_id == null) continue;
    if (topAncestorId(ix, r.node_id) === mine) return { ok: false, why: `#${r.position} is working the same branch` };
  }
  return { ok: true, why: '' };
}

/** Execute a server-kind item inline (§4.1 last row). */
function runServerItem(run: NightRunRow, item: NightItemRow, trees: Map<number, GoalTree>): void {
  const tree = trees.get(item.goal_id);
  const node = item.node_id != null ? tree?.nodes.find((n) => n.id === item.node_id) : null;
  if (!node) { finishItem(run, item, 'failed', 'node is gone'); return; }
  setItem(item.id, { status: 'running', started_at: nowIso() });
  insertNightEvent(run.id, item.id, 'system', 'item_started', `#${item.position} ${item.kind} (server) — ${item.title}`, { kind: item.kind, server: true });
  const fresh = getItem(item.id)!;
  if (item.kind === 'replant') {
    try {
      approvePlan(item.goal_id, node.id, 'system');
      finishItem(run, fresh, 'done', 'tree re-planted');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      finishItem(run, fresh, 'failed', `replant failed: ${msg}`);
      parkNode(run, fresh, `tree plant failed under night shift: ${msg}`);
    }
    return;
  }
  // verify
  if (node.state !== 'check') { finishItem(run, fresh, 'skipped', `node is ${node.state}, not check`); return; }
  const applied = applyVerdict(run, fresh, node);
  if (applied) {
    if (applied.verdict === 'PASS') { finishItem(run, fresh, 'done', applied.summary); return; }
    if (applied.attempts >= run.config.max_attempts) {
      finishItem(run, fresh, 'failed', applied.summary);
      parkNode(run, fresh, `verify failed ${applied.attempts}/${run.config.max_attempts}`);
      return;
    }
    finishItem(run, fresh, 'done', applied.summary);
    insertAfter(run, fresh.id, [{
      goal_id: item.goal_id, node_id: node.id, kind: 'replan', title: node.title,
      est_minutes: planEst(run.config), attempt: fresh.attempt + 1,
      why: `attempt ${fresh.attempt + 1} of ${run.config.max_attempts} after ${applied.summary}`.slice(0, 300),
    }]);
    return;
  }
  // No machine verifier — a parent whose children all verified settles here.
  const children = tree!.nodes.filter((n) => n.parent_id === node.id && n.state !== 'discarded');
  if (children.length && children.every((c) => c.state === 'done')) {
    verifyGoalNode(item.goal_id, node.id, true, 'every child verified', 'system');
    finishItem(run, fresh, 'done', 'every child verified');
    return;
  }
  finishItem(run, fresh, 'failed', 'check node has no machine verdict — needs a human read');
}

const KIND_TO_ACTION: Record<string, Decision['action']> = {
  plan: 'plan', replan: 'replan', decompose: 'decompose', classify: 'classify', unblock: 'unblock', weigh_in: 'weigh_in',
};

/** Execute a model-kind item: focus the node, then post ONE cue into the
 *  orchestrator thread with the night header on top of the autopilot cue. */
function runModelItem(run: NightRunRow, item: NightItemRow, lane: number, total: number, trees: Map<number, GoalTree>): void {
  const goal = getRawGoal(item.goal_id);
  const tree = trees.get(item.goal_id);
  const node = item.node_id != null ? tree?.nodes.find((n) => n.id === item.node_id) : null;
  if (!goal || !tree || !node) { finishItem(run, item, 'failed', 'goal or node is gone'); return; }
  const action = KIND_TO_ACTION[item.kind];
  if (!action) { finishItem(run, item, 'failed', `no action for kind ${item.kind}`); return; }
  const secondAsk = item.status === 'running' && cueCount(item.id) >= 1;
  try { setGoalFocus(item.goal_id, node.id, 'system'); } catch { /* focus is best-effort */ }
  const d: Decision = {
    action, node_id: node.id, reason: item.why,
    weigh_in: item.kind === 'weigh_in' ? [node.id] : [],
  };
  const body = composeCueText(goal, tree, d, secondAsk);
  const text = `[night item #${item.position} of ${total} · lane ${lane}]\n${body}`;
  setItem(item.id, { status: 'running', lane, started_at: item.started_at ?? nowIso() });
  insertNightEvent(run.id, item.id, 'system', 'item_started',
    `#${item.position} ${item.kind} lane ${lane} — ${item.title}`, { kind: item.kind, lane, second_ask: secondAsk });
  postCue(NIGHT_THREAD_EXT, text, `night:${run.id}:${item.id}:${cueCount(item.id)}`, 'night-shift');
  insertGoalEvent(item.goal_id, node.id, 'system', 'autopilot_cue', text.split('\n')[1] ?? text.split('\n')[0], {
    action, node_id: node.id, correlation: `night:${run.id}:${item.id}`, night_run: run.id, night_item: item.id,
  });
  console.log(`[night-shift] run #${run.id} item #${item.position} ${item.kind} G${item.goal_id}#${node.id} → lane ${lane}`);
}

function fillLanes(run: NightRunRow): { started: number; waiting: string | null } {
  const items = listNightItems(run.id);
  const total = items.length;
  const trees = new Map<number, GoalTree>();
  for (const gid of run.goal_ids) { const t = getGoalTree(gid); if (t) trees.set(gid, t); }
  let started = 0;
  let waiting: string | null = null;

  // Server kinds first: they take no lane (§12.4).
  for (const item of items) {
    if (item.status !== 'queued' || !isServerKind(item.kind)) continue;
    const running = listNightItems(run.id).filter((i) => i.status === 'running');
    const r = runnable(run, item, running, trees);
    if (!r.ok) continue;
    runServerItem(run, item, trees);
    started += 1;
  }

  for (;;) {
    const fresh = listNightItems(run.id);
    const running = fresh.filter((i) => i.status === 'running' && isModelKind(i.kind) || (i.status === 'running' && i.kind === 'finish'));
    const usedLanes = new Set(running.map((i) => i.lane).filter((l): l is number => l != null));
    if (usedLanes.size >= run.config.lanes) break;
    let lane = 1;
    while (usedLanes.has(lane) && lane <= run.config.lanes) lane += 1;
    if (lane > run.config.lanes) break;

    let picked: NightItemRow | null = null;
    for (const item of fresh) {
      if (item.status !== 'queued' || isServerKind(item.kind)) continue;
      const r = runnable(run, item, running, trees);
      if (r.ok) { picked = item; break; }
      if (!waiting && item.kind !== 'predicted') waiting = `#${item.position} ${r.why}`;
    }
    if (!picked) break;
    if (picked.kind === 'finish') {
      // Already in flight: the tree IS the work — just take the lane and let P0 settle it.
      setItem(picked.id, { status: 'running', lane, started_at: picked.started_at ?? nowIso(), tree_id: picked.tree_id ?? (picked.node_id != null ? getRawGoalNode(picked.node_id)?.tree_id ?? null : null) });
      insertNightEvent(run.id, picked.id, 'system', 'item_started', `#${picked.position} finish lane ${lane} — ${picked.title}`, { kind: 'finish', lane });
    } else {
      runModelItem(run, picked, lane, total, trees);
    }
    started += 1;
  }
  return { started, waiting };
}

let lastWaiting: string | null = null;
export function nightWaitingReason(): string | null { return lastWaiting; }

export async function tickNightShift(reason = 'loop'): Promise<void> {
  if (driver.ticking) { driver.pendingKick = true; return; }
  driver.ticking = true;
  try {
    setSetting(SETTING_HEARTBEAT, nowIso());
    const run = activeNightRun();
    if (!run) { driver.idleTicks = 0; return; }

    // P0 always runs — facts keep reconciling even when paused or held.
    syncItems(run);
    const after = getNightRun(run.id)!;
    if (after.status !== 'running') return;

    const hold = nightHoldReason(after, true);
    if (hold) {
      noteHold(after, hold.reason, hold.detail);
      // REVIEW (node #682) — `claude_all_accounts_full` is the MULTI-account
      // verdict only; with a single enabled account (B disabled, say) the
      // governor says `weekly_ceiling` instead and `until_budget` would have run
      // until morning regardless. `five_hour_ceiling` is deliberately NOT here —
      // that window resets, it is the pacing loop, not the end of the budget —
      // and neither is `usage_stale`/`kevin_active`, which are transient.
      if (after.mode === 'until_budget' && BUDGET_EXHAUSTED_HOLDS.has(hold.reason)) {
        stopNightRun(after.id, 'budget', 'system');
      }
      return;
    }
    noteHold(after, null, '');

    const { started, waiting } = fillLanes(after);
    lastWaiting = waiting;

    const items = listNightItems(after.id);
    const open = items.filter((i) => OPEN_STATUSES.has(i.status));
    if (!open.length) { stopNightRun(after.id, 'complete', 'system'); return; }
    const running = open.filter((i) => i.status === 'running');
    if (!running.length && !started) {
      driver.idleTicks += 1;
      if (driver.idleTicks >= STUCK_TICKS) {
        insertNightEvent(after.id, null, 'system', 'hold', `nothing runnable for ${driver.idleTicks} ticks — ${waiting ?? 'no reason recorded'}`);
        stopNightRun(after.id, 'stuck', 'system');
      }
    } else {
      driver.idleTicks = 0;
    }
    void reason;
  } catch (err) {
    console.error('[night-shift] tick failed', err);
  } finally {
    driver.ticking = false;
    if (driver.pendingKick) { driver.pendingKick = false; kickNight('pending'); }
  }
}

export function kickNight(reason: string): void {
  if (driver.ticking) { driver.pendingKick = true; return; }
  if (driver.kickTimer) return;
  driver.kickTimer = setTimeout(() => {
    driver.kickTimer = null;
    void tickNightShift(reason);
  }, KICK_COALESCE_MS);
  driver.kickTimer.unref?.();
}

function nightOnTreeStatus(treeId: string): void {
  const run = activeNightRun();
  if (!run || run.status !== 'running') return;
  const owned = listNightItems(run.id).some((i) => i.tree_id === treeId)
    || (sqliteDb.prepare(`SELECT goal_id FROM goal_nodes WHERE tree_id = ? AND state != 'discarded' ORDER BY id DESC LIMIT 1`).get(treeId) as { goal_id: number } | undefined
        && run.goal_ids.includes((sqliteDb.prepare(`SELECT goal_id FROM goal_nodes WHERE tree_id = ? AND state != 'discarded' ORDER BY id DESC LIMIT 1`).get(treeId) as { goal_id: number }).goal_id));
  if (owned) kickNight('tree_status');
}

let loopTimer: NodeJS.Timeout | null = null;
export function startNightShiftDriver(): void {
  if (loopTimer) return;
  if (!driver.booted) {
    driver.booted = true;
    const run = activeNightRun();
    if (run) insertNightEvent(run.id, null, 'system', 'driver_started', `Driver (re)started; run #${run.id} is ${run.status}.`);
  }
  loopTimer = setInterval(() => { void tickNightShift('loop'); }, LOOP_MS);
  loopTimer.unref?.();
}
export function stopNightShiftDriver(): void {
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
}

registerTreeStatusListener(nightOnTreeStatus);
if (process.env.NIGHT_SHIFT_DRIVER !== '0') {
  startNightShiftDriver();
}

// ---------------------------------------------------------------------------
// §8.2 Stats
// ---------------------------------------------------------------------------

const HEX_TOKEN = /\b[0-9a-f]{7,40}\b/gi;
const COMMIT_HINT = /commit|sha|pushed/i;
const TEST_COUNT = /(\d+)\s+(?:tests?\s+)?(?:passed|passing)/gi;

export function buildNightStats(run: NightRunRow | null): NightStats {
  const empty: NightStats = {
    items: { done: 0, failed: 0, blocked: 0, skipped: 0, queued: 0, running: 0 },
    trees_spawned: 0, hopper_nodes: { done: 0, blocked: 0 }, worker_attempts: 0,
    verify: { pass: 0, fail: 0 }, worker_turns: 0, wall_minutes: 0,
    holds: { count: 0, minutes: 0 }, commits: 0, tests: 0,
  };
  if (!run) return empty;
  const items = listNightItems(run.id);
  const stats: NightStats = { ...empty, items: { ...empty.items }, hopper_nodes: { ...empty.hopper_nodes }, verify: { ...empty.verify }, holds: { ...empty.holds } };
  for (const it of items) {
    if (it.status === 'expanded') continue;
    if (it.status in stats.items) (stats.items as Record<string, number>)[it.status] += 1;
  }
  const treeIds = [...new Set(items.map((i) => i.tree_id).filter((t): t is string => !!t))];
  stats.trees_spawned = treeIds.length;
  for (const tid of treeIds) {
    for (const n of listTreeNodes(tid)) {
      if (n.status === 'done') stats.hopper_nodes.done += 1;
      if (n.status === 'blocked' || n.status === 'blocked_question') stats.hopper_nodes.blocked += 1;
      const result = n.result ?? '';
      if (result) {
        for (const m of result.matchAll(HEX_TOKEN)) {
          const idx = m.index ?? 0;
          if (COMMIT_HINT.test(result.slice(Math.max(0, idx - 40), idx + 40))) { stats.commits += 1; break; }
        }
        for (const m of result.matchAll(TEST_COUNT)) stats.tests += Number(m[1]) || 0;
      }
    }
    try {
      const w = sqliteDb.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(turn_count),0) AS turns FROM spawn_tasks WHERE hopper_tree_id = ?`)
        .get(tid) as { n: number; turns: number } | undefined;
      stats.worker_attempts += w?.n ?? 0;
      stats.worker_turns += w?.turns ?? 0;
    } catch { /* spawn_tasks is optional on a scratch DB */ }
  }
  for (const it of items) {
    if (!it.result_summary) continue;
    if (/^VERDICT:\s*FAIL/i.test(it.result_summary)) stats.verify.fail += 1;
    else if ((it.kind === 'plan' || it.kind === 'replan' || it.kind === 'verify') && it.status === 'done') stats.verify.pass += 1;
  }
  const startMs = sqliteToMs(run.started_at);
  const endMs = sqliteToMs(run.ended_at) ?? nowMs();
  stats.wall_minutes = startMs ? Math.max(0, Math.round((endMs - startMs) / 60_000)) : 0;
  const holds = sqliteDb.prepare(`SELECT created_at, kind FROM night_events WHERE run_id = ? AND kind IN ('hold','hold_clear') ORDER BY id ASC`)
    .all(run.id) as Array<{ created_at: string; kind: string }>;
  let openAt: number | null = null;
  for (const h of holds) {
    const t = sqliteToMs(h.created_at) ?? 0;
    if (h.kind === 'hold') { if (openAt == null) { openAt = t; stats.holds.count += 1; } }
    else if (openAt != null) { stats.holds.minutes += Math.round((t - openAt) / 60_000); openAt = null; }
  }
  if (openAt != null) stats.holds.minutes += Math.round((endMs - openAt) / 60_000);
  return stats;
}

// ---------------------------------------------------------------------------
// §5 The board — the ONE polled payload
// ---------------------------------------------------------------------------

function budgetBars(): NightBudgetBar[] {
  const out: NightBudgetBar[] = [];
  try {
    const all = governorStatusAll();
    for (const [provider, v] of Object.entries(all)) {
      if (provider === 'claude') {
        const accounts = v.claude_accounts ?? [];
        if (accounts.length) {
          for (const a of accounts) {
            out.push({ provider: `claude:${a.key}`, label: `Claude ${a.key.toUpperCase()} 5h`, used_pct: a.five_hour, resets_at: null });
            out.push({ provider: `claude:${a.key}:weekly`, label: `Claude ${a.key.toUpperCase()} weekly`, used_pct: a.weekly, resets_at: null });
          }
        } else {
          out.push({ provider: 'claude', label: 'Claude 5h', used_pct: v.five_hour ?? null, resets_at: null });
          out.push({ provider: 'claude:weekly', label: 'Claude weekly', used_pct: v.weekly ?? null, resets_at: null });
        }
      } else {
        out.push({ provider, label: provider, used_pct: v.provider_usage ?? null, resets_at: null });
      }
    }
  } catch (err) {
    console.error('[night-shift] budget read failed', err);
  }
  return out;
}

function laneViews(run: NightRunRow | null, items: NightItemRow[]): NightLaneView[] {
  const lanes = run?.config.lanes ?? NIGHT_DEFAULTS.lanes;
  const out: NightLaneView[] = [];
  for (let lane = 1; lane <= lanes; lane += 1) {
    const item = items.find((i) => i.status === 'running' && i.lane === lane) ?? null;
    let tree: NightLaneView['tree'] = null;
    const treeId = item?.tree_id ?? (item?.node_id != null ? getRawGoalNode(item.node_id)?.tree_id ?? null : null);
    if (treeId) {
      const t = getHopperTree(treeId);
      const nodes = listTreeNodes(treeId);
      const runningNode = nodes.find((n) => n.status === 'running') ?? null;
      tree = {
        id: treeId, status: t?.status ?? 'unknown',
        done: nodes.filter((n) => n.status === 'done').length, total: nodes.length,
        running_title: runningNode?.title ?? null, running_model: runningNode?.model ?? null,
      };
    }
    out.push({ lane, item, tree });
  }
  return out;
}

function needsYouFor(run: NightRunRow | null): NightNeedsYou[] {
  const out: NightNeedsYou[] = [];
  const goalIds = run?.goal_ids.length ? run.goal_ids : scopeGoals().map((g) => g.id);
  for (const gid of goalIds) {
    const tree = getGoalTree(gid);
    const goal = getRawGoal(gid);
    if (!tree || !goal) continue;
    const live = tree.nodes.filter((n) => n.state !== 'discarded');
    for (const n of live) {
      // One row per node — a parked node that is ALSO awaiting a weigh-in used
      // to appear twice in Kevin's morning queue.
      if (n.review_state === 'awaiting_jarvis') out.push({ goal_id: gid, node_id: n.id, title: n.title, reason: 'awaiting_weigh_in' });
      else if (n.state === 'set' && n.leaf_kind === 'human') out.push({ goal_id: gid, node_id: n.id, title: n.title, reason: 'human' });
      else if (n.state === 'parked') out.push({ goal_id: gid, node_id: n.id, title: n.title, reason: 'parked' });
    }
    if (live.length && live.every((n) => n.state === 'done' || n.state === 'parked' || (n.state === 'check' && n.parent_id == null))) {
      out.push({ goal_id: gid, node_id: null, title: goal.title, reason: 'root_ready_to_verify' });
    }
  }
  return out;
}

export function buildNightBoard(): NightBoard {
  const run = latestNightRun();
  const items = run ? listNightItems(run.id) : [];
  const openHold = driver.holdLog[driver.holdLog.length - 1];
  const hold = run && run.status === 'running' && openHold && openHold.to == null
    ? { reason: openHold.reason, detail: openHold.detail, since: new Date(openHold.from).toISOString() }
    : null;
  return {
    run,
    items,
    lanes: laneViews(run, items),
    stats: buildNightStats(run),
    needs_you: needsYouFor(run),
    budget: budgetBars(),
    hold,
    heartbeat: getSetting(SETTING_HEARTBEAT),
    thread_ext: NIGHT_THREAD_EXT,
    eta_end: run ? nightEtaEnd(run.id) : null,
  };
}

// ---------------------------------------------------------------------------
// §8 The report
// ---------------------------------------------------------------------------

const GLYPH: Record<NightItemStatus, string> = {
  queued: '·', running: '▶', done: '✓', failed: '✗', blocked: '⛔', skipped: '⏭', expanded: '↳',
};

export function buildNightShiftReport(runId: number): { markdown: string; path: string | null; written: boolean } {
  const run = getNightRun(runId);
  if (!run) throw new NightError(404, 'night_run_not_found', 'night run not found');
  const items = listNightItems(runId);
  const events = sqliteDb.prepare(`SELECT * FROM night_events WHERE run_id = ? ORDER BY id ASC`).all(runId) as Array<{
    id: number; item_id: number | null; actor: string; kind: string; text: string | null; data: string | null; created_at: string;
  }>;
  const stats = buildNightStats(run);
  const date = ctDate(new Date(sqliteToMs(run.started_at ?? run.planned_at ?? run.created_at) ?? nowMs()));
  const esc = (s: string | null | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();

  const out: string[] = [];
  out.push(`# 🌙 Night Shift — ${date} (run #${run.id})`);
  out.push(`${run.mode} · started ${ctStamp(run.started_at)} → ended ${ctStamp(run.ended_at)} · stop: ${run.stop_reason ?? '—'} · ${run.config.lanes} lanes · goals ${run.goal_ids.map((g) => `#${g}`).join(', ') || '—'}`);
  out.push('');

  out.push('## The plan as generated');
  out.push('| pos | kind | goal/node | title | est | eta | why |');
  out.push('|---|---|---|---|---|---|---|');
  for (const it of items) {
    out.push(`| ${it.position} | ${it.kind} | G${it.goal_id}${it.node_id != null ? `/#${it.node_id}` : ''} | ${esc(it.title)} | ${it.est_minutes}m | ${ctTime(it.eta_at)} | ${esc(it.why)} |`);
  }
  if (!items.length) out.push('| — | — | — | _none_ | — | — | — |');
  out.push('');

  out.push('## What actually happened');
  out.push('| pos | | title | est → actual | attempt | lane | tree | result |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const it of items) {
    const spent = it.started_at && it.finished_at
      ? Math.max(0, Math.round(((sqliteToMs(it.finished_at) ?? 0) - (sqliteToMs(it.started_at) ?? 0)) / 60_000))
      : null;
    out.push(`| ${it.position} | ${GLYPH[it.status] ?? it.status} | ${esc(it.title)} | ${it.est_minutes}m → ${spent == null ? '—' : `${spent}m`} | ${it.attempt} | ${it.lane ?? '—'} | ${it.tree_id ?? '—'} | ${esc(it.result_summary)} |`);
  }
  if (!items.length) out.push('| — | — | _none_ | — | — | — | — | — |');
  out.push('');

  out.push('## Stats');
  out.push('| metric | value |');
  out.push('|---|---|');
  out.push(`| items | ${stats.items.done} done · ${stats.items.failed} failed · ${stats.items.blocked} blocked · ${stats.items.skipped} skipped · ${stats.items.queued} queued · ${stats.items.running} running |`);
  out.push(`| trees spawned | ${stats.trees_spawned} |`);
  out.push(`| hopper nodes | ${stats.hopper_nodes.done} done · ${stats.hopper_nodes.blocked} blocked |`);
  out.push(`| worker attempts | ${stats.worker_attempts} |`);
  out.push(`| worker turns | ${stats.worker_turns} |`);
  out.push(`| verify | ${stats.verify.pass} PASS · ${stats.verify.fail} FAIL |`);
  out.push(`| wall time | ${fmtDuration(stats.wall_minutes)} |`);
  out.push(`| holds | ${stats.holds.count} (${fmtDuration(stats.holds.minutes)}) |`);
  out.push(`| commits (parsed) | ${stats.commits} |`);
  out.push(`| tests (parsed) | ${stats.tests} |`);
  out.push('');

  out.push('## Per goal');
  for (const gid of run.goal_ids) {
    const goal = getRawGoal(gid);
    const tree = getGoalTree(gid);
    if (!goal || !tree) continue;
    const live = tree.nodes.filter((n) => n.state !== 'discarded');
    const done = live.filter((n) => n.state === 'done').length;
    const mine = items.filter((i) => i.goal_id === gid);
    out.push(`### G${gid} — ${goal.title}`);
    out.push(`progress ${done}/${live.length} done · ${mine.filter((i) => i.status === 'done').length}/${mine.length} night items done`);
    try {
      const per = buildNightReport(gid, date);
      const whatRan = per.markdown.split('\n');
      const start = whatRan.findIndex((l) => l.trim() === '## What ran');
      if (start >= 0) {
        const end = whatRan.findIndex((l, i) => i > start && l.startsWith('## '));
        out.push(...whatRan.slice(start + 1, end > start ? end : whatRan.length).filter((l) => l.trim().length));
      }
    } catch { out.push('_(no per-goal autopilot run to embed)_'); }
    out.push('');
  }

  out.push('## Needs you');
  const needs = needsYouFor(run);
  out.push(...(needs.length ? needs.map((n) => `- ${n.reason} — G${n.goal_id}${n.node_id != null ? ` #${n.node_id}` : ''} ${n.title}`) : ['_none_']));
  out.push('');

  out.push('## Holds');
  out.push('| reason | from → to | minutes |');
  out.push('|---|---|---|');
  let openHold: { reason: string; at: number } | null = null;
  let holdRows = 0;
  for (const e of events) {
    if (e.kind === 'hold') {
      if (openHold) continue;
      openHold = { reason: e.text ?? 'hold', at: sqliteToMs(e.created_at) ?? 0 };
    } else if (e.kind === 'hold_clear' && openHold) {
      const to = sqliteToMs(e.created_at) ?? 0;
      out.push(`| ${esc(openHold.reason)} | ${ctTime(new Date(openHold.at).toISOString())} → ${ctTime(e.created_at)} | ${Math.round((to - openHold.at) / 60_000)} |`);
      holdRows += 1;
      openHold = null;
    }
  }
  if (openHold) {
    out.push(`| ${esc(openHold.reason)} | ${ctTime(new Date(openHold.at).toISOString())} → (open) | ${Math.round((nowMs() - openHold.at) / 60_000)} |`);
    holdRows += 1;
  }
  if (!holdRows) out.push('| — | — | _none_ |');
  out.push('');

  out.push("## The orchestrator's read");
  const logs = events.filter((e) => e.kind === 'orchestrator_log' || e.kind === 'plan_review');
  out.push(...(logs.length ? logs.map((e) => `- ${ctTime(e.created_at)} CT ${e.kind === 'plan_review' ? '(plan review)' : ''} — ${e.text ?? ''}`) : ['_none_']));
  out.push('');

  out.push('<details><summary>event trail</summary>');
  out.push('');
  out.push(...(events.length ? events.map((e) => `- ${ctTime(e.created_at)} · ${e.actor} · ${e.kind} · ${e.item_id != null ? `item ${e.item_id}` : '—'} · ${(e.text ?? '').split('\n')[0]}`) : ['_none_']));
  out.push('');
  out.push('</details>');
  out.push('');

  const markdown = out.join('\n');
  const rel = path.join('outbox', 'night', `night-${date}.md`);
  const abs = path.join(VAULT_ROOT, rel);
  let written = false;
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, markdown, 'utf8');
    written = true;
  } catch (err) {
    console.error(`[night-shift] report write failed: ${abs}`, err);
  }
  return { markdown, path: written ? rel : null, written };
}

// ---------------------------------------------------------------------------
// §6.1 The per-turn context block for `cockpit:night-shift`
// ---------------------------------------------------------------------------

const NIGHT_CUE_HEADER = /^\[night item #(\d+) of (\d+) · lane (\d+)\]/;
/** The autopilot header composeCueText puts on line 2 — the authoritative goal id. */
const AUTOPILOT_CUE_HEADER = /^\[autopilot goal #(\d+) — /m;

/** Does this turn input look like one of our own cues? Returns the item id. */
export function nightCueItem(turnInput: string | undefined): NightItemRow | null {
  if (!turnInput) return null;
  const m = NIGHT_CUE_HEADER.exec(turnInput.trimStart());
  if (!m) return null;
  const run = latestNightRun();
  if (!run) return null;
  const items = listNightItems(run.id);
  // REVIEW (node #682) — `position` is MUTABLE (an insert or a Kevin move
  // re-packs the list), and a cue can sit in the thread queue behind another
  // turn, so matching on position alone could hand the orchestrator a DIFFERENT
  // goal's tree than the one its cue names. The autopilot header on line 2 is
  // immutable, so prefer it and fall back to position.
  const g = AUTOPILOT_CUE_HEADER.exec(turnInput);
  const byPos = items.find((i) => i.position === Number(m[1])) ?? null;
  if (!g) return byPos;
  const goalId = Number(g[1]);
  if (byPos && byPos.goal_id === goalId) return byPos;
  return items.find((i) => i.goal_id === goalId && i.status === 'running') ?? byPos;
}

export function nightShiftContextBlock(externalId: string, turnInput?: string): string {
  if (externalId !== NIGHT_THREAD_EXT) return '';
  try {
    const run = latestNightRun();
    if (!run) return '';
    const items = listNightItems(run.id);
    const running = items.filter((i) => i.status === 'running');
    const elapsed = run.started_at ? fmtDuration(elapsedMinutes(run.started_at, nowMs())) : '—';
    const hold = driver.holdLog[driver.holdLog.length - 1];
    const holdAttr = run.status === 'running' && hold && hold.to == null ? `${hold.reason}` : '';
    const lines: string[] = [];
    lines.push(`<night_shift run_id="${run.id}" status="${run.status}" mode="${run.mode}" lanes="${running.length}/${run.config.lanes}" elapsed="${elapsed}" eta_end="${ctTime(nightEtaEnd(run.id))}" hold="${holdAttr}">`);
    const firstOpen = items.findIndex((i) => OPEN_STATUSES.has(i.status));
    const start = Math.max(0, Math.min(firstOpen === -1 ? 0 : firstOpen - 2, Math.max(0, items.length - 12)));
    for (const it of items.slice(start, start + 12)) {
      const glyph = it.status === 'running' && it.lane ? `▶L${it.lane}` : (GLYPH[it.status] ?? '·');
      lines.push(`#${it.position} ${glyph} G${it.goal_id}${it.node_id != null ? ` #${it.node_id}` : ''} · ${it.title} · ${it.kind} · ${it.est_minutes}m${it.eta_at ? ` · eta ${ctTime(it.eta_at)}` : ''}${it.locked ? ' 🔒' : ''}`);
    }
    const laneTxt = laneViews(run, items).map((l) => l.item
      ? `L${l.lane} #${l.item.position}${l.tree ? ` (${l.tree.id}, ${l.tree.done}/${l.tree.total} nodes)` : ''}`
      : `L${l.lane} idle`).join(' · ');
    lines.push(`lanes: ${laneTxt}${lastWaiting ? ` · next: ${lastWaiting}` : ''}`);
    const budget = budgetBars().filter((b) => b.used_pct != null).map((b) => `${b.label} ${b.used_pct}%`).join(' · ');
    if (budget) lines.push(`budget: ${budget}`);
    lines.push('</night_shift>');
    let out = `${lines.join('\n')}\n`;
    // On a cue turn, hand the model the cued goal's tree with the SAME markers
    // a goal chat gets (§6.1) — that is what makes the `goals` tool usable here.
    // The goal the cue NAMES always wins over the item we matched (see
    // nightCueItem) — the snapshot must never describe a different goal.
    const body = turnInput ? turnInput.split('\n').slice(1).join('\n') : undefined;
    const named = turnInput && NIGHT_CUE_HEADER.test(turnInput.trimStart())
      ? AUTOPILOT_CUE_HEADER.exec(turnInput) : null;
    const cued = nightCueItem(turnInput);
    const cuedGoalId = named ? Number(named[1]) : cued?.goal_id ?? null;
    if (cuedGoalId != null) {
      out += renderGoalTreeSnapshot(cuedGoalId, { turn_input: body, include_node_chats: false });
    }
    return out;
  } catch (err) {
    console.error('[night-shift] context block failed', err);
    return '';
  }
}

// ---------------------------------------------------------------------------
// Orchestrator log (§6 tool `log`) + the condensed status read
// ---------------------------------------------------------------------------

export function nightOrchestratorLog(text: string, kind: 'orchestrator_log' | 'plan_review' = 'orchestrator_log'): { run_id: number } {
  const run = latestNightRun();
  if (!run) throw new NightError(404, 'night_run_not_found', 'there is no night run to log against');
  insertNightEvent(run.id, null, 'jarvis', kind, text.slice(0, 2000));
  emitRun('updated', run);
  return { run_id: run.id };
}

export function nightStatusDigest(): {
  run: NightRunRow | null; items: NightItemRow[]; lanes: NightLaneView[];
  hold: NightBoard['hold']; budget: NightBudgetBar[]; eta_end: string | null; waiting: string | null; thread_ext: string;
} {
  const board = buildNightBoard();
  const firstOpen = board.items.findIndex((i) => OPEN_STATUSES.has(i.status));
  const start = Math.max(0, firstOpen === -1 ? 0 : firstOpen - 2);
  return {
    run: board.run, items: board.items.slice(start, start + 12), lanes: board.lanes,
    hold: board.hold, budget: board.budget, eta_end: board.eta_end, waiting: lastWaiting,
    thread_ext: NIGHT_THREAD_EXT,
  };
}
