// ⚡ THROTTLE — Kevin's manual control surface over the autonomous work rate.
// Binding contract: skills/throttle/CONTRACT.md (DESIGN.md states the intent).
//
// Kevin, 2026-09-24: "basically manually be like 'ok we can use 6 total
// simultaneous workers, no more than 2 per goal project, and do them in this
// order (Claude A, Claude B, Codex)' … and set up what the stop loss for that
// is … Basically I need a way to manually control this so I can turn it way up
// when I need to."
//
// THE FRAME: this is a control surface over machinery that ALREADY EXISTS, plus
// the two caps that were missing (per-goal, per-tree). At every default value
// the system must behave BYTE-IDENTICALLY to before this module existed. A dial
// that changes behaviour when nobody touched it is a bug, not a feature.
//
// Everything is read UNCACHED through getSetting() (a direct prepared SELECT),
// so every dial lands on the next dispatch tick and never needs a restart —
// that was the whole complaint: MAX_SLOTS used to be a module-load constant.
//
// ─── IMPORT DISCIPLINE (deliberate, do not "tidy") ────────────────────────────
// hopper-engine.ts, hopper-governor.ts and claude-accounts.ts all import RUNTIME
// values from this file. So this file imports runtime values from NONE of them —
// only `import type`. That keeps the dependency edge one-directional. It also
// means this module's body runs BEFORE hopper-engine's DDL, which is why every
// statement touching hopper_nodes / hopper_trees / goal_nodes is prepared LAZILY
// (see `lazy()`): preparing them at module load would throw "no such table".

import type { Statement } from 'better-sqlite3';
import { sqliteDb, getSetting, setSetting } from './conversation-db.js';
import { activeAutomatedTurns } from './turn-admission.js';
import { createNotification } from './notifications.js';
import type { AccountUsageEntry, ClaudeAccount } from './claude-accounts.js';
import type { GovernorProvider, GovernorVerdict } from './hopper-governor.js';

// ─── §1.1 the dials ───────────────────────────────────────────────────────────

export type ClaudeMode = 'auto' | 'ordered' | 'split' | 'a' | 'b';
export type OnOff = 'on' | 'off';
export type OverrideState = 'auto' | 'on' | 'off';

export interface ThrottleDials {
  hopper_slots: number;
  throttle_max_per_goal: number;
  throttle_max_per_tree: number;
  throttle_claude_mode: ClaudeMode;
  throttle_claude_order: string[];
  throttle_provider_order: GovernorProvider[];
  throttle_provider_fallback: OnOff;
  throttle_preset: string;
}

const ALL_PROVIDERS: readonly GovernorProvider[] = ['claude', 'codex', 'auggie', 'devin'];
const CLAUDE_MODES: readonly ClaudeMode[] = ['auto', 'ordered', 'split', 'a', 'b'];

/** Integer keys the throttle may write, with their clamp ranges (§1.1, §1.2). */
const NUMERIC_RANGES: Record<string, [number, number]> = {
  // §1.3 rule 5: never 0 — 0 slots is `gov_override_* = off`, a different dial.
  hopper_slots: [1, 12],
  throttle_max_per_goal: [0, 12],
  throttle_max_per_tree: [0, 12],
  // §1.3 rule 6: a window at 100% is a wall, not a budget.
  gov_5h_ceiling: [0, 98],
  gov_weekly_ceiling: [0, 98],
  gov_kevin_active_claude_max_5h: [0, 98],
  gov_codex_ceiling: [0, 98],
  gov_auggie_ceiling: [0, 98],
  gov_concurrency_cap: [0, 12],
};

const ENUM_VALUES: Record<string, readonly string[]> = {
  throttle_claude_mode: CLAUDE_MODES,
  throttle_provider_fallback: ['on', 'off'],
  gov_weekly_mode: ['soft', 'hard'],
};

/** CSV keys → the vocabulary a member must belong to (null = any account key). */
const CSV_KEYS: Record<string, readonly string[] | null> = {
  throttle_claude_order: null,
  throttle_provider_order: ALL_PROVIDERS,
};

/** §6.1 — the ONLY settings keys a preset may write. */
export const PRESET_DIAL_ALLOWLIST: readonly string[] = [
  'hopper_slots',
  'throttle_max_per_goal',
  'throttle_max_per_tree',
  'throttle_claude_mode',
  'throttle_claude_order',
  'throttle_provider_order',
  'throttle_provider_fallback',
  'gov_5h_ceiling',
  'gov_weekly_ceiling',
  'gov_weekly_mode',
  'gov_kevin_active_claude_max_5h',
  'gov_codex_ceiling',
  'gov_auggie_ceiling',
  'gov_concurrency_cap',
];

/**
 * §7.3 — keys `PATCH /throttle` accepts. Deliberately EXCLUDES
 * `throttle_split_cursor` (internal), `gov_override_*` (Kevin's pause switch,
 * which must outrank every dial — see §6.4), `max_concurrent_auto_turns` (raised
 * automatically, lowered only on request — §2.3) and `claude_accounts`.
 */
const PATCHABLE_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(NUMERIC_RANGES),
  ...Object.keys(ENUM_VALUES),
  ...Object.keys(CSV_KEYS),
  'throttle_preset',
  'throttle_presets',
]);

const DEFAULT_CLAUDE_ORDER = ['a', 'b'];
const DEFAULT_PROVIDER_ORDER: GovernorProvider[] = ['claude', 'codex', 'auggie'];

// ─── lazy prepared statements (see IMPORT DISCIPLINE above) ───────────────────

function lazy<P extends unknown[], R>(sql: string): () => Statement<P, R> | null {
  let stmt: Statement<P, R> | null = null;
  return () => {
    if (stmt) return stmt;
    try {
      stmt = sqliteDb.prepare<P, R>(sql);
    } catch {
      return null; // table not created yet (module-load order) — caller degrades
    }
    return stmt;
  };
}

/** §3.1 — a tree's goal is a reverse lookup; `MIN()` keeps it deterministic. */
const goalForTreeStmt = lazy<[string], { goal_id: number | null }>(
  `SELECT MIN(goal_id) AS goal_id FROM goal_nodes WHERE tree_id = ?`,
);

interface RunningNodeRow {
  node_id: number;
  tree_id: string;
  adapter: string | null;
  model: string | null;
  title: string;
  lease_expires_at: string | null;
}
const runningNodesStmt = lazy<[], RunningNodeRow>(`
  SELECT id AS node_id, tree_id, adapter, model, title, lease_expires_at
  FROM hopper_nodes WHERE status = 'running'
`);

/** Mirrors hopper-engine's readyLeavesStmt — read-only, for the hold reason. */
const readyLeavesStmt = lazy<[], { id: number; tree_id: string; depends_on: string | null; adapter: string | null }>(`
  SELECT n.id, n.tree_id, n.depends_on, n.adapter FROM hopper_nodes n
  JOIN hopper_trees t ON t.id = n.tree_id AND t.status = 'active'
  WHERE n.status = 'pending'
    AND NOT EXISTS (SELECT 1 FROM hopper_nodes c WHERE c.parent_id = n.id)
  ORDER BY n.priority DESC, n.id ASC
`);

const nodeStatusStmt = lazy<[number], { status: string }>(`SELECT status FROM hopper_nodes WHERE id = ?`);
const treeTopicStmt = lazy<[string], { topic: string }>(`SELECT topic FROM hopper_trees WHERE id = ?`);
const goalTitleStmt = lazy<[number], { title: string }>(`SELECT title FROM goals WHERE id = ?`);
const rerouteStmt = lazy<[], { id: number; tree_id: string; throttle_reroute: string | null; updated_at: string }>(`
  SELECT id, tree_id, throttle_reroute, updated_at FROM hopper_nodes
  WHERE throttle_reroute IS NOT NULL ORDER BY updated_at DESC LIMIT 10
`);

// ─── readers ──────────────────────────────────────────────────────────────────

function intSetting(key: string, fallback: number, envKey?: string): number {
  const raw = getSetting(key)?.trim() || (envKey ? process.env[envKey]?.trim() : undefined);
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  const [lo, hi] = NUMERIC_RANGES[key] ?? [0, Number.MAX_SAFE_INTEGER];
  return Math.min(Math.max(n, lo), hi);
}

/**
 * TOTAL WORKER SLOTS — the canonical reader (`hopper-engine.maxSlots()`
 * delegates here so there is exactly one implementation). Settings-KV wins over
 * env `HOPPER_ENGINE_SLOTS`; clamped 1–12; default 2 = today's behaviour.
 */
export function hopperSlots(): number {
  return intSetting('hopper_slots', 2, 'HOPPER_ENGINE_SLOTS');
}

function enumSetting<T extends string>(key: string, fallback: T): T {
  const raw = getSetting(key)?.trim().toLowerCase();
  const allowed = ENUM_VALUES[key] ?? [];
  return raw && allowed.includes(raw) ? (raw as T) : fallback;
}

function csvSetting(key: string, fallback: string[]): string[] {
  const raw = getSetting(key)?.trim();
  if (!raw) return [...fallback];
  const vocab = CSV_KEYS[key] ?? null;
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const v = part.trim().toLowerCase();
    if (!v || out.includes(v)) continue;
    if (vocab && !vocab.includes(v)) continue;
    out.push(v);
  }
  return out.length ? out : [...fallback];
}

export function readThrottleDials(): ThrottleDials {
  return {
    hopper_slots: hopperSlots(),
    throttle_max_per_goal: intSetting('throttle_max_per_goal', 0),
    throttle_max_per_tree: intSetting('throttle_max_per_tree', 0),
    throttle_claude_mode: enumSetting<ClaudeMode>('throttle_claude_mode', 'auto'),
    throttle_claude_order: csvSetting('throttle_claude_order', DEFAULT_CLAUDE_ORDER),
    throttle_provider_order: csvSetting('throttle_provider_order', DEFAULT_PROVIDER_ORDER) as GovernorProvider[],
    throttle_provider_fallback: enumSetting<OnOff>('throttle_provider_fallback', 'off'),
    throttle_preset: getSetting('throttle_preset')?.trim() || 'normal',
  };
}

/**
 * A byte-for-byte mirror of hopper-governor's `getGovernorSetting()` key/env
 * precedence (settings-KV `gov_<name>` → env `GOV_<NAME>` → legacy env). It
 * exists so a value the SELECTOR gates on can never differ from the value the
 * GOVERNOR gates on: `readStopLoss()` above is a DISPLAY reader and deliberately
 * clamps to the ≤98 rail, which would be the wrong number to gate with.
 */
function governorSettingRaw(name: string, legacyEnvKeys: string[] = []): string | null {
  const key = name.startsWith('gov_') ? name : `gov_${name}`;
  const kv = getSetting(key)?.trim();
  if (kv) return kv;
  const envKey = key.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const primary = process.env[envKey]?.trim();
  if (primary) return primary;
  for (const legacy of legacyEnvKeys) {
    const v = process.env[legacy]?.trim();
    if (v) return v;
  }
  return null;
}

/**
 * The weekly ceiling an account must stay UNDER to be selectable, or `null` when
 * weekly mode is `soft` (soft never blocks below 100).
 *
 * REVIEW FIX (node #719, §4.6 anti-drift): in `hard` weekly mode the governor's
 * Claude lane excluded an account whose own weekly window was over the ceiling,
 * but `selectActiveClaudeAccount` did not — it only ever looked at weekly ≥ 100.
 * Verified on a scratch DB: hard mode, ceiling 30, account a at weekly 40 and
 * account b at 20 → the governor reported OPEN on **b** while the selector
 * returned **a**, so dispatch proceeded and the worker ran on the account that
 * was already past the hard stop-loss. That is both the exact "worker spawns
 * onto an account that cannot serve it" failure §4.6 exists to prevent AND a
 * silent bypass of a stop-loss Kevin set. Soft mode (the default) returns null,
 * so the default path is untouched.
 */
export function hardWeeklyCeiling(): number | null {
  const mode = governorSettingRaw('weekly_mode', ['HOPPER_GOV_WEEKLY_MODE'])?.toLowerCase();
  if (mode !== 'hard') return null;
  const raw = governorSettingRaw('weekly_ceiling', ['HOPPER_GOV_WEEKLY_CEILING']);
  const n = raw != null ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

/** §1.2 — the pre-existing stop-loss keys, SURFACED (not re-defaulted) here. */
export interface ThrottleStopLoss {
  gov_5h_ceiling: number;
  gov_weekly_ceiling: number;
  gov_weekly_mode: 'soft' | 'hard';
  gov_kevin_active_claude_max_5h: number;
  gov_codex_ceiling: number;
  gov_auggie_ceiling: number;
  gov_concurrency_cap: number;
}

/**
 * Reads the stop-loss keys for DISPLAY. The gates themselves keep reading their
 * own values through hopper-governor's numSetting() (env fallback included), so
 * this never becomes a second source of truth for a gating decision.
 */
export function readStopLoss(): ThrottleStopLoss {
  return {
    gov_5h_ceiling: intSetting('gov_5h_ceiling', 90, 'HOPPER_GOV_5H_CEILING'),
    gov_weekly_ceiling: intSetting('gov_weekly_ceiling', 30, 'HOPPER_GOV_WEEKLY_CEILING'),
    gov_weekly_mode: enumSetting<'soft' | 'hard'>('gov_weekly_mode', 'soft'),
    gov_kevin_active_claude_max_5h: intSetting('gov_kevin_active_claude_max_5h', 50),
    gov_codex_ceiling: intSetting('gov_codex_ceiling', 90, 'HOPPER_GOV_CODEX_CEILING'),
    gov_auggie_ceiling: intSetting('gov_auggie_ceiling', 85, 'HOPPER_GOV_AUGGIE_CEILING'),
    gov_concurrency_cap: intSetting('gov_concurrency_cap', 2, 'HOPPER_DAYTIME_MAX_WORKERS'),
  };
}

// ─── §1.3 validation + clamping, in ONE place ─────────────────────────────────

export interface ThrottleClamp {
  key: string;
  requested: unknown;
  stored: string;
}
export interface ThrottlePatchResult {
  updates: Record<string, string>;
  clamped: ThrottleClamp[];
  error?: { code: string; message: string };
}

/**
 * §1.3 rule 7 — shared numeric clamp so the ≤98 stop-loss rail cannot be walked
 * around via the pre-existing `PATCH /hopper-engine/settings`, which accepted
 * anything up to 100000. Returns the integer to store.
 */
export function clampGovernorNumeric(key: string, n: number): number {
  const range = NUMERIC_RANGES[key];
  const v = Math.trunc(n);
  if (!range) return v;
  return Math.min(Math.max(v, range[0]), range[1]);
}

function validatePresetMap(raw: unknown): { presets: Record<string, ThrottlePreset> } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'throttle_presets must be a JSON object keyed by preset name' };
  const out: Record<string, ThrottlePreset> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') return { error: `preset ${name} must be an object` };
    const v = value as Record<string, unknown>;
    const dials = v.dials;
    if (!dials || typeof dials !== 'object' || Array.isArray(dials)) return { error: `preset ${name} needs a dials object` };
    for (const k of Object.keys(dials as Record<string, unknown>)) {
      if (!PRESET_DIAL_ALLOWLIST.includes(k)) {
        // §6.1 rail: without this allowlist `throttle_presets` is an
        // arbitrary-settings-write primitive (gov_override_*, claude_accounts…).
        return { error: `preset ${name} may not set ${k} — allowed dials: ${PRESET_DIAL_ALLOWLIST.join(', ')}` };
      }
    }
    // Validate the dial VALUES through the same normalizer the API uses.
    const check = normalizeThrottlePatch(dials as Record<string, unknown>);
    if (check.error) return { error: `preset ${name}: ${check.error.message}` };
    out[name] = {
      label: typeof v.label === 'string' && v.label.trim() ? v.label.trim() : name,
      note: typeof v.note === 'string' ? v.note : '',
      dials: dials as Record<string, unknown>,
    };
  }
  return { presets: out };
}

/**
 * The ONE validation chokepoint. Every write path goes through it.
 *  - unknown key            → reject the WHOLE request (no partial writes)
 *  - out-of-range integer   → CLAMP, and report requested-vs-stored
 *  - bad enum               → reject
 *  - csv                    → trim/dedupe/drop-unknown, empty falls back
 */
export function normalizeThrottlePatch(input: Record<string, unknown>): ThrottlePatchResult {
  const updates: Record<string, string> = {};
  const clamped: ThrottleClamp[] = [];

  for (const [key, value] of Object.entries(input ?? {})) {
    if (!PATCHABLE_KEYS.has(key)) {
      return {
        updates: {},
        clamped: [],
        error: {
          code: 'invalid_setting',
          message: key.startsWith('gov_override_')
            ? `${key} is not settable through the throttle — gov_override_* is Kevin's pause switch and outranks every dial`
            : `${key} is not a throttle setting. Valid keys: ${[...PATCHABLE_KEYS].sort().join(', ')}`,
        },
      };
    }

    if (key in NUMERIC_RANGES) {
      const n = typeof value === 'number' ? value : parseFloat(String(value));
      if (!Number.isFinite(n)) {
        return { updates: {}, clamped: [], error: { code: 'invalid_setting', message: `${key} must be an integer` } };
      }
      const stored = clampGovernorNumeric(key, n);
      updates[key] = String(stored);
      if (stored !== Math.trunc(n)) clamped.push({ key, requested: value, stored: String(stored) });
      continue;
    }

    if (key in ENUM_VALUES) {
      const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (!raw || !ENUM_VALUES[key].includes(raw)) {
        return {
          updates: {},
          clamped: [],
          error: { code: 'invalid_setting', message: `${key} must be one of: ${ENUM_VALUES[key].join(', ')}` },
        };
      }
      updates[key] = raw;
      continue;
    }

    if (key in CSV_KEYS) {
      const parts = Array.isArray(value) ? value.map((v) => String(v)) : String(value ?? '').split(',');
      const vocab = CSV_KEYS[key];
      const out: string[] = [];
      for (const part of parts) {
        const v = part.trim().toLowerCase();
        if (!v || out.includes(v)) continue;
        if (vocab && !vocab.includes(v)) continue;
        out.push(v);
      }
      const fallback = key === 'throttle_claude_order' ? DEFAULT_CLAUDE_ORDER : DEFAULT_PROVIDER_ORDER;
      const stored = (out.length ? out : fallback).join(',');
      updates[key] = stored;
      if (stored !== parts.map((p) => p.trim().toLowerCase()).filter(Boolean).join(',')) {
        clamped.push({ key, requested: value, stored });
      }
      continue;
    }

    if (key === 'throttle_preset') {
      const name = typeof value === 'string' ? value.trim() : '';
      const presets = listThrottlePresets();
      if (!name || !(name in presets)) {
        return {
          updates: {},
          clamped: [],
          error: { code: 'invalid_setting', message: `throttle_preset must be one of: ${Object.keys(presets).join(', ')}` },
        };
      }
      updates[key] = name;
      continue;
    }

    if (key === 'throttle_presets') {
      const parsed = typeof value === 'string' ? safeJson(value) : value;
      const checked = validatePresetMap(parsed);
      if ('error' in checked) {
        return { updates: {}, clamped: [], error: { code: 'invalid_setting', message: checked.error } };
      }
      updates[key] = JSON.stringify(checked.presets);
      continue;
    }
  }

  return { updates, clamped };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Apply a validated patch. Callers MUST have run normalizeThrottlePatch first. */
export function writeThrottleUpdates(updates: Record<string, string>): void {
  for (const [key, value] of Object.entries(updates)) setSetting(key, value);
}

// ─── §2 the admission invariant (the hidden second ceiling) ───────────────────

const ADMISSION_KEY = 'max_concurrent_auto_turns';
const ADMISSION_FLOOR_MIN = 3;
const ADMISSION_FLOOR_MAX = 14;

export function admissionCap(): number {
  const n = parseInt(getSetting(ADMISSION_KEY) ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 4; // mirrors turn-admission.cap()
}

export function admissionFloor(): number {
  return Math.min(Math.max(hopperSlots() + 2, ADMISSION_FLOOR_MIN), ADMISSION_FLOOR_MAX);
}

/**
 * INVARIANT: max_concurrent_auto_turns >= hopper_slots + 2.
 *
 * Why this is CORRECTNESS, not a nicety: `isAutomatedTurn()` returns true for
 * every `cockpit:hopper-node-*` thread, so hopper workers are gated by turn
 * admission. A worker over the cap has ALREADY claimed its node and started its
 * 30-minute lease before it blocks in `acquireAutomatedSlot` — it then burns up
 * to 10 minutes of that lease doing nothing and gives up silently. Slots above
 * admission produce work that is claimed, leased, and never done.
 *
 * The +2 is headroom so tree-done / autopilot / guard / node-chat cues aren't
 * starved behind a full worker pool — those are exactly the turns that review
 * and advance the work the pool just finished.
 *
 * It RAISES ONLY (§2.3). Lowering admission is only ever Kevin's explicit action
 * through PATCH /hopper-engine/settings: admission also gates cues that have
 * nothing to do with the hopper, so shrinking it as a side effect of turning
 * slots DOWN would starve them exactly when the pool is draining.
 */
export function enforceAdmissionFloor(): { raised: boolean; from: number; to: number } {
  const floor = admissionFloor();
  const current = admissionCap();
  if (current >= floor) return { raised: false, from: current, to: current };
  setSetting(ADMISSION_KEY, String(floor));
  console.log(`[throttle] raised ${ADMISSION_KEY} ${current} → ${floor} (hopper_slots + 2)`);
  return { raised: true, from: current, to: floor };
}

export interface AdmissionStatus {
  cap: number;
  floor: number;
  active: number;
  satisfied: boolean;
  headroom: number;
}
export function admissionStatus(): AdmissionStatus {
  const cap = admissionCap();
  const floor = admissionFloor();
  const active = activeAutomatedTurns();
  return { cap, floor, active, satisfied: cap >= floor, headroom: cap - active };
}

// ─── §3 goal attribution + the two caps ──────────────────────────────────────

/** Adapters of the currently-running workers — for the daytime-cap hold line. */
export function runningWorkerAdapters(): (string | null)[] {
  return (runningNodesStmt()?.all() ?? []).map((r) => r.adapter);
}

/** §3.1 — a tree's goal, or null when no goal_nodes row names it. */
export function goalForTree(treeId: string): number | null {
  const stmt = goalForTreeStmt();
  if (!stmt) return null;
  try {
    return stmt.get(treeId)?.goal_id ?? null;
  } catch {
    return null;
  }
}

export interface CapEvaluator {
  maxPerGoal: number;
  maxPerTree: number;
  /** Memoized per evaluator (= per tick), per §3.1. */
  goalOf(treeId: string): number | null;
  /** null = allowed; otherwise the hold reason to report. */
  check(treeId: string): 'per_goal_cap' | 'per_tree_cap' | null;
  /** Count a claim IN-LOOP so six leaves of one goal can't all pass a cap of 2. */
  record(treeId: string): void;
  goalCounts: Map<number, number>;
  treeCounts: Map<string, number>;
  /** Human sentence naming the number AND the dial to turn (§7.4 rule 4). */
  detail(treeId: string, reason: 'per_goal_cap' | 'per_tree_cap'): string;
}

/**
 * Builds the per-tick cap evaluator from the CURRENTLY RUNNING nodes.
 *
 * Counting rule (§3.3): only `status='running'` counts — it is the only status
 * that occupies a worker, the claim is atomic, and dispatchTick is
 * single-flighted, so counting `running` is race-safe within a tick.
 *
 * UNATTRIBUTED TREES (§3.2): a tree no goal_nodes row points at has goal_id
 * null and answers to the per-TREE cap ONLY. It is never placed in a shared
 * "no goal" bucket — doing so would serialise every non-goal tree against every
 * other non-goal tree (this build's own tree competing with Zoom-3 for one
 * goal's worth of slots). Hence a Map keyed by a real integer goal_id and a
 * skipped check when it is null; a `-1` sentinel used as a map key is the exact
 * bug this forbids.
 */
export function throttleCapsForTick(): CapEvaluator {
  const dials = readThrottleDials();
  const goalCounts = new Map<number, number>();
  const treeCounts = new Map<string, number>();
  const goalMemo = new Map<string, number | null>();

  const goalOf = (treeId: string): number | null => {
    if (goalMemo.has(treeId)) return goalMemo.get(treeId) ?? null;
    const g = goalForTree(treeId);
    goalMemo.set(treeId, g);
    return g;
  };

  const rows = runningNodesStmt()?.all() ?? [];
  for (const row of rows) {
    treeCounts.set(row.tree_id, (treeCounts.get(row.tree_id) ?? 0) + 1);
    const g = goalOf(row.tree_id);
    if (g != null) goalCounts.set(g, (goalCounts.get(g) ?? 0) + 1);
  }

  const evaluator: CapEvaluator = {
    maxPerGoal: dials.throttle_max_per_goal,
    maxPerTree: dials.throttle_max_per_tree,
    goalCounts,
    treeCounts,
    goalOf,
    check(treeId) {
      if (evaluator.maxPerGoal > 0) {
        const g = goalOf(treeId);
        if (g != null && (goalCounts.get(g) ?? 0) >= evaluator.maxPerGoal) return 'per_goal_cap';
      }
      if (evaluator.maxPerTree > 0 && (treeCounts.get(treeId) ?? 0) >= evaluator.maxPerTree) return 'per_tree_cap';
      return null;
    },
    record(treeId) {
      treeCounts.set(treeId, (treeCounts.get(treeId) ?? 0) + 1);
      const g = goalOf(treeId);
      if (g != null) goalCounts.set(g, (goalCounts.get(g) ?? 0) + 1);
    },
    detail(treeId, reason) {
      if (reason === 'per_goal_cap') {
        const g = goalOf(treeId);
        return `goal ${g} has ${goalCounts.get(g ?? -1) ?? 0} of ${evaluator.maxPerGoal} workers — raise throttle_max_per_goal`;
      }
      return `tree ${treeId} has ${treeCounts.get(treeId) ?? 0} of ${evaluator.maxPerTree} workers — raise throttle_max_per_tree`;
    },
  };
  return evaluator;
}

// ─── §4 Claude account modes ─────────────────────────────────────────────────

export interface ClaudeCandidatePlan {
  mode: ClaudeMode;
  /** Mode-filtered AND eligible, in registry order. */
  eligible: AccountUsageEntry[];
  /** The mode's ranking over a pool of entries. */
  rank: (pool: AccountUsageEntry[]) => ClaudeAccount | null;
  /** 'a' | 'b' in a focus mode, else null. */
  focusKey: string | null;
  /**
   * The mode FILTER applied to an arbitrary pool. Additive beyond CONTRACT
   * §4.2's four fields because §4.5 requires the "so we still try" fallback pool
   * to be mode-narrowed too — without exposing the filter, each caller would
   * re-implement it, which is exactly the drift §4.6 forbids.
   */
  narrow: (pool: AccountUsageEntry[]) => AccountUsageEntry[];
}

function pickLeastUsed(pool: AccountUsageEntry[]): ClaudeAccount | null {
  let best: AccountUsageEntry | null = null;
  for (const e of pool) {
    const v = e.usage.five_hour;
    if (v == null) continue;
    if (best == null || v < (best.usage.five_hour as number)) best = e; // strict < keeps registry order on ties
  }
  return best?.account ?? (pool.length ? pool[0].account : null);
}

export function splitCursor(): string | null {
  return getSetting('throttle_split_cursor')?.trim() || null;
}

/**
 * §4.4 — advance the strict-alternation cursor. Called EXACTLY ONCE per real
 * worker spawn, never from `selectActiveClaudeAccount` (which is called several
 * times per turn and from two read-only GET endpoints; advancing inside it would
 * make `GET /claude-accounts` mutate routing state and burn alternation on calls
 * that spawn nothing).
 */
export function advanceSplitCursor(key: string): void {
  if (!key || !key.trim()) return;
  setSetting('throttle_split_cursor', key.trim());
}

/**
 * Record the account a real WORKER spawn landed on, advancing `split`'s cursor.
 * A no-op in every other mode, so the call site stays unconditional.
 *
 * DEVIATION FROM CONTRACT §4.4 (deliberate, justified): the contract names
 * `spawnWorker()` in hopper-engine.ts as the call site. It cannot be: spawnWorker
 * does not resolve the account — `runConversationTurn` does, one turn later, and
 * advancing the cursor BEFORE that selection is an off-by-one that makes split
 * pick the same account forever (cursor←a, then the selection sees cursor=a and
 * takes b, which is never recorded). So the advance happens at the ONE place a
 * worker's account is actually decided, immediately after the decision, and only
 * for a hopper-worker thread. The property §4.4 actually protects —
 * `selectActiveClaudeAccount` stays PURE, and read-only GETs never move the
 * cursor — is preserved exactly.
 */
export function noteWorkerSpawnAccount(key: string): void {
  if (readThrottleDials().throttle_claude_mode !== 'split') return;
  advanceSplitCursor(key);
}

/**
 * The ONE place a mode turns into a candidate set + a ranking. Both
 * `selectActiveClaudeAccount` (claude-accounts.ts) and `evaluateClaudeAccounts`
 * (hopper-governor.ts) call it — §4.6. If only one of them applied the mode, the
 * governor would say OPEN because B has headroom while the selector returned A
 * (focused, spent), spawning a worker onto an account that cannot serve it.
 *
 * THE BINDING RULE (§4.3): a focus/order preference REORDERS or NARROWS
 * candidates. It NEVER marks an ineligible account eligible.
 *
 * `forSpawn` selects the alternating ranking in `split` mode. Per §4.4 split
 * alternates WORKER SPAWNS only; Kevin's own interactive turns rank least-used
 * (alternating them would gratuitously drop native --resume sessions, which are
 * per-account, and cost him context for no benefit).
 */
export function throttleClaudeCandidates(
  entries: AccountUsageEntry[],
  opts?: { forSpawn?: boolean },
): ClaudeCandidatePlan {
  const dials = readThrottleDials();
  const mode = dials.throttle_claude_mode;
  const focusKey = mode === 'a' || mode === 'b' ? mode : null;

  const narrow = (pool: AccountUsageEntry[]): AccountUsageEntry[] =>
    focusKey ? pool.filter((e) => e.account.key === focusKey) : pool;

  let rank: (pool: AccountUsageEntry[]) => ClaudeAccount | null;
  if (focusKey) {
    rank = (pool) => narrow(pool)[0]?.account ?? null;
  } else if (mode === 'ordered') {
    rank = (pool) => {
      for (const key of dials.throttle_claude_order) {
        const hit = pool.find((e) => e.account.key === key);
        if (hit) return hit.account;
      }
      return pool.length ? pool[0].account : null; // then any remaining, registry order
    };
  } else if (mode === 'split' && opts?.forSpawn) {
    const cursor = splitCursor();
    rank = (pool) => {
      const other = pool.find((e) => e.account.key !== cursor);
      // Alternation yields to eligibility (§4.3): if the only candidate IS the
      // cursor, take it rather than wedging the pool.
      return other?.account ?? (pool.length ? pool[0].account : null);
    };
  } else {
    rank = pickLeastUsed; // auto, and split on interactive turns
  }

  return { mode, focusKey, narrow, rank, eligible: narrow(entries).filter((e) => e.eligible) };
}

/** Why a focused account can't serve — for the `claude_focus_account_full` detail. */
export function focusHoldDetail(focusKey: string, entries: AccountUsageEntry[]): string {
  const entry = entries.find((e) => e.account.key === focusKey);
  if (!entry) return `focused on account ${focusKey}: not in the registry`;
  const { usage, account } = entry;
  let cause: string;
  if (!account.enabled) cause = 'disabled';
  else if (usage.locked_reason) cause = `locked (${usage.locked_reason})`;
  else if (usage.stale) cause = 'usage meter stale';
  else if (usage.weekly != null && usage.weekly >= 100) cause = `weekly ${usage.weekly}% spent`;
  else if (usage.five_hour == null) cause = '5h utilization unknown';
  else cause = `5h ${usage.five_hour}% over the ceiling`;
  return `focused on account ${focusKey}: ${cause} — "${focusKey.toUpperCase()} only" holds rather than spilling to the other subscription (use Ordered to spill)`;
}

// ─── §6.4 provider overrides — `gov_override_*` wins over everything ──────────

/**
 * Kevin's per-pool pause switch. `off` holds all NEW claims on that pool
 * (running workers untouched — this is the drain pattern
 * scripts/throttle-slots-restart.sh depends on); `on` bypasses the ceilings and
 * the Kevin-active gate but NOT staleness (the override says "spend it", not
 * "fly blind"); anything else — including missing, empty, or unrecognised —
 * means EXACTLY today's behaviour, which is what keeps this change safe.
 */
export function overrideFor(provider: GovernorProvider): OverrideState {
  const raw = getSetting(`gov_override_${provider}`)?.trim().toLowerCase();
  if (raw === 'off') return 'off';
  if (raw === 'on') return 'on';
  return 'auto';
}

export function overrideStates(): Record<GovernorProvider, OverrideState> {
  const out = {} as Record<GovernorProvider, OverrideState>;
  for (const p of ALL_PROVIDERS) out[p] = overrideFor(p);
  return out;
}

// ─── §5 cross-provider fallback ──────────────────────────────────────────────

/** §5.1 rule 3 — only a CAPACITY hold may reroute. */
const REROUTE_CAPACITY_REASONS: ReadonlySet<string> = new Set([
  'five_hour_ceiling',
  'weekly_ceiling',
  'claude_all_accounts_full',
  'claude_focus_account_full',
]);

/** Same loadouts as hopper-engine's CROSS_PROVIDER_RETRY_LADDER — already reviewed. */
const REROUTE_TARGETS: Partial<Record<GovernorProvider, { adapter: string; model: string }>> = {
  codex: { adapter: 'codex', model: 'gpt-5.5' },
  auggie: { adapter: 'auggie', model: 'default' },
  // devin deliberately absent: providerMeters() gives it no meter, and
  // rerouting onto an unmetered pool is exactly what the ceilings prevent.
};

export type RerouteOutcome =
  | { kind: 'none' }
  | { kind: 'refused'; why: 'frontier_model' }
  | { kind: 'reroute'; provider: GovernorProvider; adapter: string; model: string };

/**
 * Decide whether a Claude node held on CAPACITY may be rerouted to another pool.
 * Default `throttle_provider_fallback=off` returns `{kind:'none'}` for
 * everything, so dispatch is byte-identical to today.
 */
export function throttleRerouteFor(
  node: { adapter: string | null; model: string | null },
  holdReason: string,
  providerAllows: (provider: GovernorProvider) => boolean,
): RerouteOutcome {
  const dials = readThrottleDials();
  if (dials.throttle_provider_fallback !== 'on') return { kind: 'none' };
  if (!REROUTE_CAPACITY_REASONS.has(holdReason)) return { kind: 'none' };

  // §5.1 rule 5 — a frontier-tier node is never silently demoted onto another
  // pool's worker tier. Precedent: skills/jarvis-router/SKILL.md's per-pool tier
  // rule — an Opus review node run at a worker tier is a green review that
  // reviewed nothing.
  const model = node.model ?? '';
  if (/opus|fable/i.test(model)) return { kind: 'refused', why: 'frontier_model' };

  for (const provider of dials.throttle_provider_order) {
    if (provider === 'claude') continue;
    const target = REROUTE_TARGETS[provider];
    if (!target) continue;
    if (/astra/i.test(model) && provider === 'codex') return { kind: 'refused', why: 'frontier_model' };
    if (!providerAllows(provider)) continue;
    return { kind: 'reroute', provider, adapter: target.adapter, model: target.model };
  }
  return { kind: 'none' };
}

/** §5.2 — the audit string stamped on `hopper_nodes.throttle_reroute`. */
export function rerouteAuditLine(
  from: GovernorProvider,
  to: GovernorProvider,
  reason: string,
  fromModel: string | null,
  toModel: string,
): string {
  return `${from}→${to} @${new Date().toISOString()} (${reason}) model ${fromModel ?? 'default'}→${toModel}`;
}

export function notifyReroute(nodeId: number, to: GovernorProvider, reason: string): void {
  createNotification({
    severity: 'info',
    title: `⚡ Throttle rerouted a Claude node to ${to}`,
    body: `Node ${nodeId} was held on ${reason}; throttle_provider_fallback=on rerouted it to ${to}. Set throttle_provider_fallback=off to keep Claude nodes on Claude.`,
    source: 'throttle',
  });
}

export interface RerouteRecord {
  node_id: number;
  tree_id: string;
  from: string;
  to: string;
  reason: string;
  at: string;
}

/** Last 10 rewrites, parsed back out of the audit string (§5.2). */
export function listRecentReroutes(): RerouteRecord[] {
  const rows = rerouteStmt()?.all() ?? [];
  return rows.map((r) => {
    const raw = r.throttle_reroute ?? '';
    const m = /^(\w+)→(\w+)\s+@(\S+)\s+\(([^)]*)\)/.exec(raw);
    return {
      node_id: r.id,
      tree_id: r.tree_id,
      from: m?.[1] ?? 'claude',
      to: m?.[2] ?? '?',
      reason: m?.[4] ?? '?',
      at: m?.[3] ?? r.updated_at,
    };
  });
}

// ─── §6 presets ──────────────────────────────────────────────────────────────

export interface ThrottlePreset {
  label: string;
  note: string;
  dials: Record<string, unknown>;
}

/** §6.2 — exactly as DESIGN lists them. Absent dials are LEFT ALONE (§6.2). */
export const SEEDED_PRESETS: Record<string, ThrottlePreset> = {
  turned_up: {
    label: 'Turned up',
    note: 'Spend it — 6 workers, 2 per goal, ceilings wide open',
    dials: {
      hopper_slots: 6,
      throttle_max_per_goal: 2,
      gov_5h_ceiling: 95,
      gov_weekly_ceiling: 85,
      gov_kevin_active_claude_max_5h: 95,
      throttle_claude_mode: 'ordered',
      throttle_claude_order: 'a,b',
    },
  },
  normal: {
    label: 'Normal',
    note: "Today's defaults — 2 workers, weekly protected at 30%",
    dials: {
      hopper_slots: 2,
      throttle_max_per_goal: 0,
      gov_5h_ceiling: 90,
      gov_weekly_ceiling: 30,
      gov_kevin_active_claude_max_5h: 50,
      throttle_claude_mode: 'auto',
    },
  },
  conserve: {
    label: 'Conserve',
    // Deliberately does NOT touch the account mode: conserving is about spend,
    // not about which subscription.
    note: 'One worker, tight ceilings — protect the window',
    dials: { hopper_slots: 1, throttle_max_per_goal: 0, gov_5h_ceiling: 60, gov_weekly_ceiling: 15 },
  },
  overnight: {
    label: 'Overnight',
    note: '4 workers, 2 per goal, split evenly across both subscriptions',
    dials: {
      hopper_slots: 4,
      throttle_max_per_goal: 2,
      gov_5h_ceiling: 95,
      gov_weekly_ceiling: 60,
      throttle_claude_mode: 'split',
    },
  },
};

let presetsSource: 'settings' | 'seeded_fallback' = 'settings';

/**
 * The preset store. A malformed/unparseable value falls back to the seeded four
 * and is reported as `presets_source: "seeded_fallback"` — never a 500.
 * Seeding is idempotent and NEVER overwrites Kevin's edits (§6.2).
 */
export function listThrottlePresets(): Record<string, ThrottlePreset> {
  const raw = getSetting('throttle_presets')?.trim();
  if (!raw) {
    presetsSource = 'settings';
    return SEEDED_PRESETS;
  }
  const parsed = safeJson(raw);
  const checked = validatePresetMap(parsed);
  if ('error' in checked || Object.keys(checked.presets).length === 0) {
    presetsSource = 'seeded_fallback';
    return SEEDED_PRESETS;
  }
  presetsSource = 'settings';
  return checked.presets;
}

export function throttlePresetsSource(): 'settings' | 'seeded_fallback' {
  listThrottlePresets();
  return presetsSource;
}

/** Write the four seeded presets ONLY when nothing usable is stored. */
export function seedThrottlePresets(): void {
  const raw = getSetting('throttle_presets')?.trim();
  if (raw) {
    const checked = validatePresetMap(safeJson(raw));
    if (!('error' in checked) && Object.keys(checked.presets).length > 0) return; // Kevin's edits stand
  }
  setSetting('throttle_presets', JSON.stringify(SEEDED_PRESETS));
}

export interface ApplyResult {
  ok: boolean;
  name?: string;
  updated?: string[];
  clamped?: ThrottleClamp[];
  admission?: { raised: boolean; from: number; to: number };
  error?: { code: string; message: string; valid?: string[] };
}

/** §6.3 — apply semantics. Same validation, same clamps, all-or-nothing. */
export function applyThrottlePreset(name: string): ApplyResult {
  const presets = listThrottlePresets();
  const preset = presets[name?.trim()];
  if (!preset) {
    return { ok: false, error: { code: 'unknown_preset', message: `no preset named ${name}`, valid: Object.keys(presets) } };
  }
  const patch = normalizeThrottlePatch(preset.dials);
  if (patch.error) return { ok: false, error: patch.error };
  writeThrottleUpdates(patch.updates);
  setSetting('throttle_preset', name.trim());
  const admission = enforceAdmissionFloor();
  createNotification({
    severity: 'info',
    title: `⚡ Throttle preset applied: ${preset.label}`,
    body: `slots ${hopperSlots()} · per-goal ${readThrottleDials().throttle_max_per_goal || 'unlimited'} · admission ${admissionCap()}. ${preset.note}`,
    source: 'throttle',
  });
  return { ok: true, name: name.trim(), updated: Object.keys(patch.updates), clamped: patch.clamped, admission };
}

// ─── §7.3 / §7.4 the GET payload + the honest hold reason ────────────────────

export type ThrottleHoldReason =
  | GovernorVerdict['reason']
  | 'slots_full'
  | 'no_ready_nodes'
  | 'deps_unsatisfied'
  | 'night_paused'
  | 'daytime_concurrency_cap'
  | 'per_goal_cap'
  | 'per_tree_cap';

/** §7.4 — the seven throttle-LOCAL reasons; everything else reuses the governor's. */
export const THROTTLE_LOCAL_REASONS: readonly string[] = [
  'slots_full',
  'no_ready_nodes',
  'deps_unsatisfied',
  'night_paused',
  'daytime_concurrency_cap',
  'per_goal_cap',
  'per_tree_cap',
];

export interface ThrottleAccountView {
  key: string;
  label: string;
  enabled: boolean;
  five_hour: number | null;
  weekly: number | null;
  stale: boolean;
  locked_reason: string | null;
  eligible: boolean;
  active: boolean;
  five_hour_resets_at: string | null;
  weekly_resets_at: string | null;
  five_hour_ceiling: number;
}

export interface ThrottleProviderView {
  allow: boolean;
  reason: string;
  detail: string;
  usage: number | null;
  ceiling: number | null;
  override: OverrideState;
}

export interface ThrottleStatus {
  dials: ThrottleDials;
  clamps: { hopper_slots: [number, number]; stop_loss_max: number; admission: [number, number] };
  stop_loss: ThrottleStopLoss;
  admission: AdmissionStatus;
  running: {
    total: number;
    slots: number;
    free: number;
    by_goal: { goal_id: number; title: string | null; n: number; cap: number; at_cap: boolean }[];
    by_tree: { tree_id: string; topic: string | null; goal_id: number | null; n: number; cap: number; at_cap: boolean }[];
    nodes: { node_id: number; tree_id: string; goal_id: number | null; adapter: string | null; model: string | null; title: string; lease_expires_at: string | null }[];
  };
  accounts: ThrottleAccountView[];
  providers: Partial<Record<GovernorProvider, ThrottleProviderView>>;
  hold: { dispatching: boolean; reason: ThrottleHoldReason; detail: string; scope: 'global' | 'local' };
  reroutes: RerouteRecord[];
  presets: Record<string, ThrottlePreset>;
  presets_source: 'settings' | 'seeded_fallback';
}

/**
 * What the route composes and hands in. `throttleStatus()` deliberately does NOT
 * import governorStatusAll / selectActiveClaudeAccount itself — both live in
 * modules that import THIS one (§7.1's import rule), so the route composes them,
 * exactly the pattern `/big-board` already uses. Called with no argument the
 * payload is still complete and correct, minus the governor/account views.
 */
export interface ThrottleStatusInputs {
  providers?: Partial<Record<GovernorProvider, ThrottleProviderView>>;
  accounts?: ThrottleAccountView[];
  /** Tree ids frozen by a paused Night Shift run, if the caller knows them. */
  nightPausedTrees?: ReadonlySet<string>;
  /** Kevin-at-the-keyboard + the non-Claude daytime cap, for the hold reason. */
  daytime?: { active: boolean; cap: number; nonClaudeRunning: number };
}

/**
 * Night Shift's paused-tree set, handed over by hopper-engine.ts at module load
 * (a setter, not an import, so this module never imports the engine back — the
 * same pattern the engine itself uses for night-shift.ts).
 */
let pausedTreesProvider: (() => ReadonlySet<string>) | null = null;
export function setThrottlePausedTreesProvider(fn: (() => ReadonlySet<string>) | null): void {
  pausedTreesProvider = fn;
}
function pausedTrees(): ReadonlySet<string> {
  if (!pausedTreesProvider) return new Set<string>();
  try {
    return pausedTreesProvider();
  } catch {
    return new Set<string>();
  }
}

function depsSatisfiedLocal(dependsOn: string | null): boolean {
  if (!dependsOn) return true;
  const stmt = nodeStatusStmt();
  if (!stmt) return true;
  try {
    const deps = JSON.parse(dependsOn) as number[];
    return deps.every((d) => {
      const dep = stmt.get(d);
      return !dep || dep.status === 'done';
    });
  } catch {
    return true;
  }
}

export function throttleStatus(inputs?: ThrottleStatusInputs): ThrottleStatus {
  const dials = readThrottleDials();
  const caps = throttleCapsForTick();
  const runningRows = runningNodesStmt()?.all() ?? [];
  const slots = dials.hopper_slots;
  const free = slots - runningRows.length;
  const providers = inputs?.providers ?? {};
  const nightPaused = inputs?.nightPausedTrees ?? pausedTrees();

  const nodes = runningRows.map((r) => ({
    node_id: r.node_id,
    tree_id: r.tree_id,
    goal_id: caps.goalOf(r.tree_id),
    adapter: r.adapter,
    model: r.model,
    title: r.title,
    lease_expires_at: r.lease_expires_at,
  }));

  const by_goal = [...caps.goalCounts.entries()].map(([goal_id, n]) => ({
    goal_id,
    title: (() => {
      try {
        return goalTitleStmt()?.get(goal_id)?.title ?? null;
      } catch {
        return null;
      }
    })(),
    n,
    cap: caps.maxPerGoal,
    at_cap: caps.maxPerGoal > 0 && n >= caps.maxPerGoal,
  }));

  const by_tree = [...caps.treeCounts.entries()].map(([tree_id, n]) => ({
    tree_id,
    topic: (() => {
      try {
        return treeTopicStmt()?.get(tree_id)?.topic ?? null;
      } catch {
        return null;
      }
    })(),
    goal_id: caps.goalOf(tree_id),
    n,
    cap: caps.maxPerTree,
    at_cap: caps.maxPerTree > 0 && n >= caps.maxPerTree,
  }));

  const hold = deriveHold({ dials, caps, free, runningCount: runningRows.length, providers, nightPaused, daytime: inputs?.daytime });

  return {
    dials,
    clamps: { hopper_slots: [1, 12], stop_loss_max: 98, admission: [ADMISSION_FLOOR_MIN, ADMISSION_FLOOR_MAX] },
    stop_loss: readStopLoss(),
    admission: admissionStatus(),
    running: { total: runningRows.length, slots, free, by_goal, by_tree, nodes },
    accounts: inputs?.accounts ?? [],
    providers,
    hold,
    reroutes: listRecentReroutes(),
    presets: listThrottlePresets(),
    presets_source: throttlePresetsSource(),
  };
}

/**
 * §7.4 — ONE honest status line, so "why is nothing running" is answerable in a
 * glance instead of reading journalctl. It reuses the governor's verdict reason
 * strings VERBATIM and only invents a name for a condition the governor has none
 * for. Precedence mirrors dispatchTick's own order of checks (§3.4): a governor
 * hold is GLOBAL ("the Claude lane is shut") while a cap is LOCAL to one goal —
 * reporting "per-goal cap" while the whole subscription is stopped out would
 * send Kevin to the wrong dial.
 */
function deriveHold(args: {
  dials: ThrottleDials;
  caps: CapEvaluator;
  free: number;
  runningCount: number;
  providers: Partial<Record<GovernorProvider, ThrottleProviderView>>;
  nightPaused: ReadonlySet<string>;
  daytime?: { active: boolean; cap: number; nonClaudeRunning: number };
}): ThrottleStatus['hold'] {
  const { caps, free, providers, nightPaused, daytime } = args;
  const leaves = readyLeavesStmt()?.all() ?? [];

  if (free <= 0) {
    return {
      dispatching: false,
      reason: 'slots_full',
      detail: `${args.runningCount} of ${args.dials.hopper_slots} worker slots in use — raise hopper_slots to run more`,
      scope: 'local',
    };
  }
  if (leaves.length === 0) {
    return { dispatching: false, reason: 'no_ready_nodes', detail: 'no pending leaf in an active tree is waiting for a slot', scope: 'local' };
  }

  // Walk the ready leaves exactly as dispatchTick does and report the first
  // reason that actually blocks one. If ANY leaf would dispatch, we're open.
  let firstHold: ThrottleStatus['hold'] | null = null;
  const note = (h: ThrottleStatus['hold']) => {
    if (!firstHold) firstHold = h;
  };

  for (const leaf of leaves) {
    if (nightPaused.has(leaf.tree_id)) {
      note({ dispatching: false, reason: 'night_paused', detail: `tree ${leaf.tree_id} is frozen by a paused Night Shift run — resume the run`, scope: 'local' });
      continue;
    }
    if (!depsSatisfiedLocal(leaf.depends_on)) {
      note({ dispatching: false, reason: 'deps_unsatisfied', detail: `node ${leaf.id} is waiting on an unfinished dependency`, scope: 'local' });
      continue;
    }
    const adapter = leaf.adapter ?? process.env.HOPPER_WORKER_ADAPTER ?? 'claude';
    const provider = providerForLabel(adapter);
    const verdict = providers[provider];
    if (verdict && !verdict.allow) {
      note({ dispatching: false, reason: verdict.reason as ThrottleHoldReason, detail: verdict.detail, scope: 'global' });
      continue;
    }
    if (daytime?.active && provider !== 'claude' && daytime.nonClaudeRunning >= daytime.cap) {
      note({
        dispatching: false,
        reason: 'daytime_concurrency_cap',
        detail: `${daytime.nonClaudeRunning} of ${daytime.cap} non-Claude workers while you're at the keyboard — raise gov_concurrency_cap`,
        scope: 'local',
      });
      continue;
    }
    const capHold = caps.check(leaf.tree_id);
    if (capHold) {
      note({ dispatching: false, reason: capHold, detail: caps.detail(leaf.tree_id, capHold), scope: 'local' });
      continue;
    }
    return { dispatching: true, reason: 'ok', detail: `${args.runningCount} running, ${free} slot(s) free, next node ${leaf.id} clear to dispatch`, scope: 'global' };
  }

  return firstHold ?? { dispatching: false, reason: 'no_ready_nodes', detail: 'no ready leaf is currently dispatchable', scope: 'local' };
}

/** Local copy of hopper-governor's providerFor — importing it would create a cycle. */
function providerForLabel(adapter: string): GovernorProvider {
  const a = adapter.toLowerCase();
  if (a.includes('codex') || a.includes('openai')) return 'codex';
  if (a.includes('auggie') || a.includes('augment')) return 'auggie';
  if (a.includes('devin')) return 'devin';
  return 'claude';
}
