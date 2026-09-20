// GOALS GUARDS (v0.2) — every `done_means` can become a monitored Overwatch
// rule. See CONTRACT §12 (binding), GUARDS-RECON.md (the Overwatch API, read
// from source), GUARDS.md (concept/loop).
//
// This module is the STORE + LOGIC: CRUD over the `goal_guards` table (declared
// in goals.ts §12.1), the lifecycle/health state machines, the poller, the
// health→cue seam, and the webhook applier. All Overwatch traffic goes through
// `src/goals-overwatch.ts`. Guards degrade cleanly: with no OVERWATCH_API_KEY,
// proposals stay ghosts, set guards sit at health='unknown', the poller no-ops.
//
// It imports FROM goals.ts (helpers) and never the other way around — goals.ts
// reads the goal_guards table directly (counts + snapshot markers) so there is
// no import cycle.

import { createHash, timingSafeEqual } from 'node:crypto';
import { sqliteDb, getConversation, getSetting } from './conversation-db.js';
import { sseBus } from './sse-bus.js';
import {
  GoalError,
  assertActor,
  requireGoal,
  requireNode,
  insertEvent,
  emitGoal,
  touchGoal,
  getRawGoal,
  getRawGoalNode,
  type GoalActor,
} from './goals.js';
import * as overwatch from './goals-overwatch.js';

export type GuardState = 'ghost' | 'set' | 'discarded';
export type GuardMode = 'query' | 'agent';
export type GuardHealth = 'unknown' | 'passing' | 'failing' | 'error';
export type GuardComparator = 'gte' | 'lte' | 'gt' | 'lt' | 'eq';
export type GuardSeverity = 'critical' | 'high' | 'medium' | 'low';

const COMPARATORS: GuardComparator[] = ['gte', 'lte', 'gt', 'lt', 'eq'];
const SEVERITIES: GuardSeverity[] = ['critical', 'high', 'medium', 'low'];
const OW_GROUPS = ['leads', 'email', 'queue', 'billing', 'revenue', 'system', 'custom', 'general'];

/** Raw DB row — 1:1 with the goal_guards table (sample_columns is a JSON string). */
interface GuardDbRow {
  id: number;
  goal_id: number;
  node_id: number | null;
  state: GuardState;
  mode: GuardMode;
  title: string;
  sql: string | null;
  comparator: GuardComparator | null;
  threshold: number | null;
  value_column: string | null;
  sample_columns: string | null;
  check_prompt: string | null;
  failure_prompt: string | null;
  cadence: number;
  severity: GuardSeverity;
  ow_group: string;
  window_minutes: number;
  overwatch_key: string | null;
  overwatch_rule_id: string | null;
  health: GuardHealth;
  last_checked_at: string | null;
  last_value: number | null;
  last_summary: string | null;
  authored_by: 'kevin' | 'jarvis';
  created_at: string;
  updated_at: string;
}

/** Public shape (CONTRACT §12.4) — raw row + parsed sample_columns + derived. */
export interface GoalGuardRow {
  id: number;
  goal_id: number;
  node_id: number | null;
  state: GuardState;
  mode: GuardMode;
  title: string;
  sql: string | null;
  comparator: GuardComparator | null;
  threshold: number | null;
  value_column: string | null;
  sample_columns: string[] | null;
  check_prompt: string | null;
  failure_prompt: string | null;
  cadence: number;
  severity: GuardSeverity;
  ow_group: string;
  window_minutes: number;
  overwatch_key: string | null;
  overwatch_rule_id: string | null;
  health: GuardHealth;
  last_checked_at: string | null;
  last_value: number | null;
  last_summary: string | null;
  authored_by: 'kevin' | 'jarvis';
  created_at: string;
  updated_at: string;
  // derived on reads:
  node_title: string | null;
  dashboard_url: string | null;
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

const getGuardStmt = sqliteDb.prepare(`SELECT * FROM goal_guards WHERE id = ?`);

function rawGuard(id: number): GuardDbRow | undefined {
  return getGuardStmt.get(id) as GuardDbRow | undefined;
}

function requireGuard(goalId: number, gid: number): GuardDbRow {
  const row = rawGuard(gid);
  if (!row || row.goal_id !== goalId) throw new GoalError(404, 'guard_not_found', 'guard not found in this goal');
  return row;
}

function toGuardRow(row: GuardDbRow): GoalGuardRow {
  let sampleColumns: string[] | null = null;
  if (row.sample_columns) {
    try {
      const parsed = JSON.parse(row.sample_columns);
      if (Array.isArray(parsed)) sampleColumns = parsed.map((c) => String(c));
    } catch { sampleColumns = null; }
  }
  const nodeTitle = row.node_id != null ? (getRawGoalNode(row.node_id)?.title ?? null) : null;
  const dashboardUrl = row.overwatch_key ? overwatch.dashboardUrl() : null;
  return {
    id: row.id, goal_id: row.goal_id, node_id: row.node_id,
    state: row.state, mode: row.mode, title: row.title,
    sql: row.sql, comparator: row.comparator, threshold: row.threshold,
    value_column: row.value_column, sample_columns: sampleColumns,
    check_prompt: row.check_prompt, failure_prompt: row.failure_prompt,
    cadence: row.cadence, severity: row.severity, ow_group: row.ow_group, window_minutes: row.window_minutes,
    overwatch_key: row.overwatch_key, overwatch_rule_id: row.overwatch_rule_id,
    health: row.health, last_checked_at: row.last_checked_at, last_value: row.last_value, last_summary: row.last_summary,
    authored_by: row.authored_by, created_at: row.created_at, updated_at: row.updated_at,
    node_title: nodeTitle, dashboard_url: dashboardUrl,
  };
}

function emitGuard(action: 'proposed' | 'set' | 'updated' | 'discarded' | 'health', row: GuardDbRow): void {
  sseBus.emit('sse', { type: 'goal_guard', action, goal_id: row.goal_id, guard: toGuardRow(row) });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** For the list route: lets the UI show "Overwatch not connected" BEFORE Kevin clicks ✓. */
export function overwatchConnected(): boolean {
  return overwatch.isConfigured();
}

export function listGuards(goalId: number, includeDiscarded = false): GoalGuardRow[] {
  requireGoal(goalId);
  const rows = sqliteDb.prepare(`SELECT * FROM goal_guards WHERE goal_id = ? ORDER BY id`).all(goalId) as GuardDbRow[];
  return rows.filter((r) => includeDiscarded || r.state !== 'discarded').map(toGuardRow);
}

export function getGuard(goalId: number, gid: number): GoalGuardRow {
  return toGuardRow(requireGuard(goalId, gid));
}

// ---------------------------------------------------------------------------
// Propose (route 32) — a ghost guard; nothing written to Overwatch yet.
// ---------------------------------------------------------------------------

export interface ProposeGuardArgs {
  node_id?: number | null;
  mode?: unknown;
  title?: unknown;
  sql?: unknown;
  comparator?: unknown;
  threshold?: unknown;
  value_column?: unknown;
  sample_columns?: unknown;
  check_prompt?: unknown;
  failure_prompt?: unknown;
  cadence?: unknown;
  severity?: unknown;
  ow_group?: unknown;
  window_minutes?: unknown;
  actor?: unknown;
}

function normComparator(v: unknown): GuardComparator | null {
  return typeof v === 'string' && (COMPARATORS as string[]).includes(v) ? (v as GuardComparator) : null;
}
function normSeverity(v: unknown, fallback: GuardSeverity = 'medium'): GuardSeverity {
  return typeof v === 'string' && (SEVERITIES as string[]).includes(v) ? (v as GuardSeverity) : fallback;
}
function normSampleColumns(v: unknown): string | null {
  if (v == null) return null;
  if (Array.isArray(v)) return JSON.stringify(v.map((c) => String(c)));
  if (typeof v === 'string' && v.trim()) return v.trim(); // allow pre-serialized JSON
  return null;
}
function posInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

export function proposeGuard(goalId: number, args: ProposeGuardArgs): GoalGuardRow {
  const goal = requireGoal(goalId);
  const actor = assertActor(args.actor, 'jarvis');
  const authoredBy = actor === 'kevin' ? 'kevin' : 'jarvis';

  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) throw new GoalError(400, 'title_required', 'title is required (a plain-words label for the guard)');

  const mode: GuardMode = args.mode === 'agent' ? 'agent' : 'query';
  const nodeId = args.node_id == null ? null : Number(args.node_id);

  // The win condition must be REAL before we monitor it (CONTRACT §12.1).
  if (nodeId != null) {
    const node = requireNode(goalId, nodeId);
    if (node.state !== 'check' && node.state !== 'done') {
      throw new GoalError(409, 'node_not_verifiable', `node is ${node.state}; a guard may only be proposed on a verified (check/done) node`, { state: node.state });
    }
  } else if (goal.status !== 'done') {
    throw new GoalError(409, 'node_not_verifiable', `goal is ${goal.status}; a root guard may only be proposed once the goal is done`, { status: goal.status });
  }

  // One active guard per node (v0) — enforced in code (discarded rows pile up).
  const existing = sqliteDb.prepare(
    `SELECT id FROM goal_guards WHERE goal_id = ? AND node_id IS ? AND state != 'discarded' LIMIT 1`,
  ).get(goalId, nodeId) as { id: number } | undefined;
  if (existing) throw new GoalError(409, 'guard_exists', 'this node already has an active guard', { guard_id: existing.id });

  const info = sqliteDb.prepare(`
    INSERT INTO goal_guards
      (goal_id, node_id, state, mode, title, sql, comparator, threshold, value_column, sample_columns,
       check_prompt, failure_prompt, cadence, severity, ow_group, window_minutes, authored_by)
    VALUES (?, ?, 'ghost', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    goalId, nodeId, mode, title,
    typeof args.sql === 'string' && args.sql.trim() ? args.sql.trim() : null,
    normComparator(args.comparator),
    typeof args.threshold === 'number' ? args.threshold : (args.threshold != null && Number.isFinite(Number(args.threshold)) ? Number(args.threshold) : null),
    typeof args.value_column === 'string' && args.value_column.trim() ? args.value_column.trim() : null,
    normSampleColumns(args.sample_columns),
    typeof args.check_prompt === 'string' && args.check_prompt.trim() ? args.check_prompt.trim() : null,
    typeof args.failure_prompt === 'string' && args.failure_prompt.trim() ? args.failure_prompt.trim() : null,
    posInt(args.cadence, 60),
    normSeverity(args.severity),
    typeof args.ow_group === 'string' && args.ow_group.trim() ? args.ow_group.trim() : 'custom',
    posInt(args.window_minutes, 60),
    authoredBy,
  );
  const row = rawGuard(Number(info.lastInsertRowid))!;
  insertEvent(goalId, nodeId, actor, 'guard_proposed', `Guard proposed: ${title}`, { guard_id: row.id, mode });
  emitGuard('proposed', row);
  return toGuardRow(row);
}

// ---------------------------------------------------------------------------
// Patch (route 33) — direct edit of a guard's fields; pushed to Overwatch when set.
// ---------------------------------------------------------------------------

export interface PatchGuardArgs {
  title?: unknown;
  sql?: unknown;
  comparator?: unknown;
  threshold?: unknown;
  value_column?: unknown;
  sample_columns?: unknown;
  check_prompt?: unknown;
  failure_prompt?: unknown;
  cadence?: unknown;
  severity?: unknown;
  ow_group?: unknown;
  window_minutes?: unknown;
  mode?: unknown;
  actor?: unknown;
}

export async function patchGuard(goalId: number, gid: number, patch: PatchGuardArgs): Promise<GoalGuardRow> {
  const row = requireGuard(goalId, gid);
  const actor = assertActor(patch.actor, 'kevin');
  if (row.state === 'discarded') throw new GoalError(409, 'invalid_transition', 'guard is discarded', { from: 'discarded', to: 'discarded' });
  if (actor === 'jarvis' && row.state !== 'ghost') {
    throw new GoalError(403, 'jarvis_must_propose', 'JARVIS may only edit a ghost guard; a set guard is edited by Kevin');
  }

  // Collect the changed columns (only keys present in the patch).
  const cols: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => { cols.push(`${col} = ?`); vals.push(v); };

  if (patch.title !== undefined) {
    const t = typeof patch.title === 'string' ? patch.title.trim() : '';
    if (!t) throw new GoalError(400, 'title_required', 'title must be non-empty');
    set('title', t);
  }
  if (patch.mode !== undefined) {
    if (patch.mode !== 'query' && patch.mode !== 'agent') throw new GoalError(400, 'invalid_request', "mode must be 'query' or 'agent'");
    set('mode', patch.mode);
  }
  if (patch.sql !== undefined) set('sql', typeof patch.sql === 'string' && patch.sql.trim() ? patch.sql.trim() : null);
  if (patch.comparator !== undefined) {
    const c = normComparator(patch.comparator);
    if (patch.comparator != null && c == null) throw new GoalError(400, 'invalid_request', `comparator must be one of ${COMPARATORS.join(', ')}`);
    set('comparator', c);
  }
  if (patch.threshold !== undefined) {
    const n = patch.threshold == null ? null : Number(patch.threshold);
    if (n != null && !Number.isFinite(n)) throw new GoalError(400, 'invalid_request', 'threshold must be numeric');
    set('threshold', n);
  }
  if (patch.value_column !== undefined) set('value_column', typeof patch.value_column === 'string' && patch.value_column.trim() ? patch.value_column.trim() : null);
  if (patch.sample_columns !== undefined) set('sample_columns', normSampleColumns(patch.sample_columns));
  if (patch.check_prompt !== undefined) set('check_prompt', typeof patch.check_prompt === 'string' && patch.check_prompt.trim() ? patch.check_prompt.trim() : null);
  if (patch.failure_prompt !== undefined) set('failure_prompt', typeof patch.failure_prompt === 'string' && patch.failure_prompt.trim() ? patch.failure_prompt.trim() : null);
  if (patch.cadence !== undefined) set('cadence', posInt(patch.cadence, row.cadence));
  if (patch.severity !== undefined) set('severity', normSeverity(patch.severity, row.severity));
  if (patch.ow_group !== undefined) set('ow_group', typeof patch.ow_group === 'string' && patch.ow_group.trim() ? patch.ow_group.trim() : 'custom');
  if (patch.window_minutes !== undefined) set('window_minutes', posInt(patch.window_minutes, row.window_minutes));

  if (!cols.length) return toGuardRow(row);

  // A SET guard's change must land in Overwatch first (CONTRACT §12.4 route 33):
  // a 422 there leaves the local row untouched.
  if (row.state === 'set' && row.overwatch_key) {
    if (!overwatch.isConfigured()) throw new GoalError(503, 'overwatch_not_connected', 'Overwatch is not configured; cannot sync a set guard');
    const merged: GuardDbRow = { ...row };
    // reflect the pending change onto a merged copy to build the Overwatch patch
    applyColsToRow(merged, cols, vals);
    const owPatch = buildOverwatchPayload(merged, { onlyChanged: cols });
    const r = await overwatch.patchRule(row.overwatch_key, owPatch);
    if (!r.ok) throw mapOverwatchError(r, 'patch');
  }

  sqliteDb.prepare(`UPDATE goal_guards SET ${cols.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...vals, gid);

  const fresh = rawGuard(gid)!;
  insertEvent(goalId, fresh.node_id, actor, 'guard_updated', `Guard updated: ${fresh.title}`, { guard_id: gid });
  emitGuard('updated', fresh);
  return toGuardRow(fresh);
}

/** Mutate an in-memory GuardDbRow copy from a set()-built cols/vals pair (patch preview). */
function applyColsToRow(row: GuardDbRow, cols: string[], vals: unknown[]): void {
  cols.forEach((assign, i) => {
    const col = assign.split(' = ')[0];
    if (col === 'updated_at') return;
    (row as unknown as Record<string, unknown>)[col] = vals[i];
  });
}

// ---------------------------------------------------------------------------
// Accept (route 34) — write the rule to Overwatch, store the key, → set.
// ---------------------------------------------------------------------------

function ruleName(goalId: number, nodeId: number | null, title: string): string {
  const prefix = nodeId != null ? `Goal ${goalId} · node ${nodeId}` : `Goal ${goalId}`;
  return `${prefix} — ${title}`.slice(0, 120);
}

function buildOverwatchPayload(row: GuardDbRow, opts?: { onlyChanged?: string[] }): Record<string, unknown> {
  const goal = getRawGoal(row.goal_id);
  const node = row.node_id != null ? getRawGoalNode(row.node_id) : null;
  // A node guard describes the NODE's win condition; a root guard the goal's.
  // Never let a node with no done_means borrow the goal's sentence.
  const description = (row.node_id != null
    ? (node?.done_means ?? row.title)
    : (goal?.done_means ?? row.title)).slice(0, 500);

  const full: Record<string, unknown> = {
    name: ruleName(row.goal_id, row.node_id, row.title),
    description,
    group: row.ow_group,
    severity: row.severity,
    cadence_minutes: row.cadence,
    window_minutes: row.window_minutes,
    mode: row.mode,
    created_by: 'goals',
  };
  if (row.mode === 'query') {
    full.sql = row.sql;
    full.comparator = row.comparator;
    full.threshold = row.threshold;
    if (row.value_column) full.value_column = row.value_column;
    if (row.sample_columns) {
      try { full.sample_columns = JSON.parse(row.sample_columns); } catch { /* omit */ }
    }
  } else {
    full.check_prompt = row.check_prompt;
    if (row.failure_prompt) full.failure_prompt = row.failure_prompt;
  }

  if (!opts?.onlyChanged) return full;
  // PATCH is merge-patch: send only the columns that changed (mapped to OW field names).
  const map: Record<string, string> = {
    title: 'name', ow_group: 'group', severity: 'severity', cadence: 'cadence_minutes',
    window_minutes: 'window_minutes', mode: 'mode', sql: 'sql', comparator: 'comparator',
    threshold: 'threshold', value_column: 'value_column', sample_columns: 'sample_columns',
    check_prompt: 'check_prompt', failure_prompt: 'failure_prompt',
  };
  const patch: Record<string, unknown> = {};
  for (const assign of opts.onlyChanged) {
    const col = assign.split(' = ')[0];
    const owField = map[col];
    if (!owField) continue;
    patch[owField] = full[owField];
  }
  // name always re-derives from title; if title changed, full.name already set.
  return patch;
}

function mapOverwatchError(
  r: { ok: false; status: number; error: string },
  op: string,
): GoalError {
  if (r.status === 422) return new GoalError(422, 'overwatch_rejected', `Overwatch rejected the rule: ${r.error}`, { reason: r.error });
  if (r.status === 503 || r.status === 401 || r.status === 0) {
    return new GoalError(503, 'overwatch_not_connected', `Overwatch is not reachable (${op}): ${r.error}`);
  }
  return new GoalError(502, 'overwatch_error', `Overwatch ${op} failed (${r.status}): ${r.error}`);
}

export async function acceptGuard(goalId: number, gid: number, actor?: unknown): Promise<GoalGuardRow> {
  const row = requireGuard(goalId, gid);
  const act = assertActor(actor, 'kevin');
  if (row.state !== 'ghost') throw new GoalError(409, 'invalid_transition', `guard is ${row.state}, cannot accept`, { from: row.state, to: 'set' });

  // Required fields per mode.
  const missing: string[] = [];
  if (row.mode === 'query') {
    if (!row.sql) missing.push('sql');
    if (!row.comparator) missing.push('comparator');
    if (row.threshold == null) missing.push('threshold');
  } else {
    if (!row.check_prompt) missing.push('check_prompt');
  }
  if (missing.length) throw new GoalError(409, 'guard_incomplete', `guard is missing required ${row.mode}-mode fields`, { missing });

  if (!overwatch.isConfigured()) {
    throw new GoalError(503, 'overwatch_not_connected', 'Overwatch is not configured; the guard stays a ghost and will be written once the key lands');
  }

  const r = await overwatch.createRule(buildOverwatchPayload(row));
  if (!r.ok) throw mapOverwatchError(r, 'create');

  // Re-check after the await: a concurrent accept (double-click / two tabs)
  // or a discard may have landed while Overwatch was writing. Never leave a
  // second live rule behind — undo ours and report the transition conflict.
  const now = rawGuard(gid);
  if (!now || now.state !== 'ghost') {
    void overwatch.deleteRule(r.key);
    throw new GoalError(409, 'invalid_transition', `guard is ${now?.state ?? 'gone'}, cannot accept`, { from: now?.state ?? 'gone', to: 'set' });
  }

  sqliteDb.prepare(`
    UPDATE goal_guards SET state = 'set', overwatch_key = ?, health = 'unknown', updated_at = datetime('now') WHERE id = ?
  `).run(r.key, gid);
  const fresh = rawGuard(gid)!;
  insertEvent(goalId, fresh.node_id, act, 'guard_set', `Guard set + written to Overwatch: ${fresh.title}`, { guard_id: gid, overwatch_key: r.key });
  emitGuard('set', fresh);
  touchGoal(goalId);
  return toGuardRow(fresh);
}

// ---------------------------------------------------------------------------
// Discard — DELETE the Overwatch rule (if set), → discarded.
// ---------------------------------------------------------------------------

export async function discardGuard(goalId: number, gid: number, reason?: string, actor?: unknown): Promise<GoalGuardRow> {
  const row = requireGuard(goalId, gid);
  const act = assertActor(actor, 'kevin');
  if (row.state === 'discarded') return toGuardRow(row);

  let deleteNote: string | null = null;
  if (row.state === 'set' && row.overwatch_key) {
    if (!overwatch.isConfigured()) {
      // Discard locally anyway (never strand the UI) but say the live rule may
      // still exist — Kevin can remove it from the Overwatch dashboard.
      deleteNote = 'overwatch delete skipped: Overwatch not configured (rule may still exist)';
    } else {
      const r = await overwatch.deleteRule(row.overwatch_key);
      if (!r.ok && r.status !== 404) {
        // Don't strand the UI on a delete failure — discard locally, note it.
        deleteNote = `overwatch delete failed: ${r.error}`;
      }
    }
  }

  if (deleteNote) {
    sqliteDb.prepare(`UPDATE goal_guards SET state = 'discarded', last_summary = ?, updated_at = datetime('now') WHERE id = ?`).run(deleteNote, gid);
  } else {
    sqliteDb.prepare(`UPDATE goal_guards SET state = 'discarded', updated_at = datetime('now') WHERE id = ?`).run(gid);
  }
  const fresh = rawGuard(gid)!;
  insertEvent(goalId, fresh.node_id, act, 'guard_discarded', `Guard discarded: ${fresh.title}${reason ? ` (${reason})` : ''}`, { guard_id: gid });
  emitGuard('discarded', fresh);
  touchGoal(goalId);
  return toGuardRow(fresh);
}

// ---------------------------------------------------------------------------
// Health — the ONE code path shared by the poller and the webhook (§12.7).
// ---------------------------------------------------------------------------

export interface OwHealthInput {
  status: string | null; // ok | warn | fail | error | null(never run)
  value: number | null;
  summary: string | null;
  at: string | null;
}

function computeHealth(input: OwHealthInput, cadenceMin: number): { health: GuardHealth; summaryOverride?: string } {
  let base: GuardHealth;
  switch (input.status) {
    case 'ok': base = 'passing'; break;
    case 'fail': base = 'failing'; break;
    case 'warn': base = 'failing'; break;
    case 'error': base = 'error'; break;
    case null:
    case undefined:
    case '': base = 'unknown'; break;
    default: base = 'unknown'; break;
  }
  // Staleness (RECON §5): a run older than max(3×cadence, 60m) is an error even
  // if its status was ok — Overwatch stopped running the rule.
  if (input.at) {
    const ageMin = (Date.now() - Date.parse(input.at)) / 60000;
    const limitMin = Math.max(3 * cadenceMin, 60);
    if (Number.isFinite(ageMin) && ageMin > limitMin) {
      return { health: 'error', summaryOverride: `guard stale — last run ${input.at}` };
    }
  }
  return { health: base };
}

/** Store last_* always; flip health + event + emit + cue ONLY on change. Idempotent. */
function setHealth(row: GuardDbRow, newHealth: GuardHealth, patch: { value: number | null; summary: string | null; checkedAt: string }): void {
  const prev = row.health;
  const changed = prev !== newHealth;
  sqliteDb.prepare(`
    UPDATE goal_guards SET health = ?, last_value = ?, last_summary = ?, last_checked_at = ?, updated_at = datetime('now') WHERE id = ?
  `).run(newHealth, patch.value, patch.summary, patch.checkedAt, row.id);
  if (!changed) return; // last_* updated silently; no event, no SSE, no cue (spec §12.7)

  const fresh = rawGuard(row.id)!;
  emitGuard('health', fresh); // SSE fires on every health flip (incl. unknown→passing)

  // A goal_events row + a chat CUE only fire on a MEANINGFUL transition
  // (§12.3(4)): the win condition breaking, recovering from a break, or the
  // check itself erroring. unknown→passing (a guard first going green) is a
  // silent SSE-only flip — no cue spam.
  let kind: string | null = null;
  if (newHealth === 'failing') kind = 'guard_failed';
  else if (newHealth === 'error') kind = 'guard_error';
  else if (newHealth === 'passing' && (prev === 'failing' || prev === 'error')) kind = 'guard_recovered';

  touchGoal(fresh.goal_id);
  if (kind) {
    insertEvent(fresh.goal_id, fresh.node_id, 'system', kind, patch.summary ?? `Guard ${newHealth}: ${fresh.title}`, { guard_id: fresh.id, health: newHealth });
    fireGuardCue(fresh, newHealth);
  }
}

/** Map an Overwatch last_result onto a set guard's health (poller + webhook). */
export function applyGuardHealth(guardId: number, input: OwHealthInput): void {
  const row = rawGuard(guardId);
  if (!row || row.state !== 'set') return; // ghost/discarded always report 'unknown'
  const { health, summaryOverride } = computeHealth(input, row.cadence);
  setHealth(row, health, {
    value: input.value,
    summary: summaryOverride ?? input.summary,
    checkedAt: input.at ?? new Date().toISOString(),
  });
}

/** Webhook / lookup by the server-generated key. Returns false when no guard owns the key. */
export function applyGuardHealthByKey(key: string, input: OwHealthInput): boolean {
  const row = sqliteDb.prepare(`SELECT * FROM goal_guards WHERE overwatch_key = ? AND state = 'set'`).get(key) as GuardDbRow | undefined;
  if (!row) return false;
  applyGuardHealth(row.id, input);
  return true;
}

// ---------------------------------------------------------------------------
// The cue (backend → goal chat) — same seam as goals.ts fireGoalReviewCue.
// ---------------------------------------------------------------------------

const lastEventIdStmt = sqliteDb.prepare(`SELECT id FROM goal_events WHERE goal_id = ? ORDER BY id DESC LIMIT 1`);

function fireGuardCue(guard: GuardDbRow, health: GuardHealth): void {
  const goalId = guard.goal_id;
  const externalId = `cockpit:goal-${goalId}`;
  const conv = getConversation(externalId);
  if (!conv) {
    console.warn(`[goals-guards] cue skipped — no conversation for ${externalId}`);
    return;
  }
  const goal = getRawGoal(goalId);
  const label = guard.node_id != null
    ? `on #${guard.node_id} "${getRawGoalNode(guard.node_id)?.title ?? guard.title}"`
    : `on this goal "${goal?.title ?? guard.title}"`;
  const summary = guard.last_summary ?? '';

  let text: string;
  if (health === 'failing') {
    text = `[goal #${goalId} — guard ${label} is FAILING: ${summary}]\n` +
      'Propose the fix under that node (a child or a Plan) — the win condition it protects has broken. Don\'t restate the rest of the tree.';
  } else if (health === 'passing') {
    text = `[goal #${goalId} — guard ${label} RECOVERED: ${summary}]`;
  } else {
    text = `[goal #${goalId} — guard ${label} ERRORED: the check itself failed (bad SQL or Hub unreachable) — ${summary}. ` +
      'This is the guard, not necessarily the goal; fix the rule or tell me to discard it.]';
  }

  const eventId = (lastEventIdStmt.get(goalId) as { id: number } | undefined)?.id ?? 0;
  const correlationKey = `goal-guard:${goalId}:${guard.id}:${eventId}`;
  const convId = conv.id;

  Promise.all([import('./agent.js'), import('./thread-message-queue.js')])
    .then(([agent, queue]) => {
      if (agent.getInFlightMessageId(convId)) {
        queue.enqueueMessage(convId, text);
        return;
      }
      agent.processMessage(text, externalId, correlationKey).catch((err: unknown) => {
        if (err instanceof agent.ConversationBusyError) queue.enqueueMessage(convId, text);
        else console.error('[goals-guards] cue post failed', err);
      });
    })
    .catch((err) => console.error('[goals-guards] cue import failed', err));
}

// ---------------------------------------------------------------------------
// The poller (§12.7) — reads each set guard's GET /rules/{key} on an interval.
// ---------------------------------------------------------------------------

function pollIntervalMs(): number {
  const min = Math.max(1, Number(getSetting('goal_guard_poll_min') ?? 10) || 10);
  return min * 60 * 1000;
}

/** One poll pass. Exported so the sim can drive it directly (no 10-min wait). */
export async function pollGuardsOnce(): Promise<void> {
  if (!overwatch.isConfigured()) return; // degrade: no-op when unconfigured
  const rows = sqliteDb.prepare(`SELECT * FROM goal_guards WHERE state = 'set' AND overwatch_key IS NOT NULL`).all() as GuardDbRow[];
  for (const row of rows) {
    const r = await overwatch.getRule(row.overwatch_key!);
    if (r.ok) {
      const lr = r.last_result;
      applyGuardHealth(row.id, {
        status: lr?.status ?? null,
        value: lr?.value ?? null,
        summary: lr?.summary ?? null,
        at: lr?.at ?? null,
      });
    } else {
      // Couldn't reach Overwatch this tick. Health unchanged UNLESS our last
      // reading has itself gone stale (Overwatch stopped reporting to us).
      markGuardStaleIfNeeded(row);
    }
  }
}

function markGuardStaleIfNeeded(row: GuardDbRow): void {
  if (!row.last_checked_at) return; // never had a reading — leave at 'unknown'
  const ageMin = (Date.now() - Date.parse(row.last_checked_at)) / 60000;
  const limitMin = Math.max(3 * row.cadence, 60);
  if (Number.isFinite(ageMin) && ageMin > limitMin && row.health !== 'error') {
    setHealth(row, 'error', {
      value: row.last_value,
      summary: 'guard stale — Overwatch not reporting',
      checkedAt: row.last_checked_at,
    });
  }
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleNextPoll(): void {
  pollTimer = setTimeout(() => {
    pollGuardsOnce()
      .catch((err) => console.error('[goals-guards] poll tick failed', err))
      .finally(() => scheduleNextPoll());
  }, pollIntervalMs());
  // Don't keep the process alive just for the poller (matters for the sim).
  if (typeof pollTimer.unref === 'function') pollTimer.unref();
}

export function startGuardPoller(): void {
  if (pollTimer) return;
  scheduleNextPoll();
}

export function stopGuardPoller(): void {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

// ---------------------------------------------------------------------------
// Webhook secret check (route 35) — env-read at call time (§12.12).
// ---------------------------------------------------------------------------

export type WebhookSecretResult = 'ok' | 'unset' | 'wrong';

export function checkWebhookSecret(provided: unknown): WebhookSecretResult {
  const secret = (process.env.GOALS_GUARD_WEBHOOK_SECRET ?? '').trim();
  if (!secret) return 'unset';
  if (typeof provided !== 'string' || !provided) return 'wrong';
  // Constant-time compare over fixed-length digests (avoids length-leak on raw compare).
  const a = createHash('sha256').update(secret).digest();
  const b = createHash('sha256').update(provided).digest();
  return timingSafeEqual(a, b) ? 'ok' : 'wrong';
}

// Start the poller at module load (like the watchdog cadence). Disable with
// GOAL_GUARD_POLLER=0 (the sim sets this and calls pollGuardsOnce() directly).
if (process.env.GOAL_GUARD_POLLER !== '0') {
  startGuardPoller();
}
