// docs-pass (2026-11-01) — the [after-earlier-leaves] dependency, enforced in ONE place.
//
// A leaf whose notes carry `[after-earlier-leaves]` must not start (plan, replan, plant,
// patch-tree, unblock re-plant) until EVERY earlier machine-leaf sibling has actually LANDED
// on the base branch. Before this module the rule lived only in the night-shift scheduler's
// runnable(); the autopilot's isRunnable() counted `working`/`check` as "settled", and the
// plant functions had no ordering check at all, so a replan/unblock/autopilot path could start
// the docs leaf on a base that did not yet hold the features (take-8h, 2026-11-01).
//
// Model-free and side-effect-free: it only READS goal_nodes / hopper_trees and runs
// `git merge-base --is-ancestor`. It imports nothing from goals.ts so every dispatcher can use
// it without a circular import.

import { execFileSync } from 'node:child_process';
import { sqliteDb } from './conversation-db.js';

export const AFTER_EARLIER_LEAVES = '[after-earlier-leaves]';

export interface OrderBlocker {
  id: number;
  title: string;
  /** Plain-English reason this earlier leaf still holds the later one back. */
  why: string;
}

interface OrderRow {
  id: number;
  parent_id: number | null;
  title: string;
  state: string;
  leaf_kind: string;
  notes: string | null;
  tree_id: string | null;
}

const PROTECTED = new Set(['main', 'master', 'before']);

/** Base branch named in a node's notes (`--base X` first, then `base: X`). */
export function baseFromNotes(notes: string | null | undefined): string | null {
  const m = /--base\s+(\S+)/.exec(notes ?? '') ?? /base:\s*(\S+)/i.exec(notes ?? '');
  return m ? m[1].replace(/[.,;:)\]}'"`]+$/, '') : null;
}

export function repoFromNotes(notes: string | null | undefined): string | null {
  const m = /REPO\s+(\S+)/.exec(notes ?? '');
  return m ? m[1].replace(/[.,;:)\]}'"`]+$/, '') : null;
}

function gitOk(repo: string, args: string[]): boolean {
  try { execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore', timeout: 15_000 }); return true; } catch { return false; }
}

/** The earlier machine leaves still holding `nodeId` back. Empty = free to start.
 *  `earlier` = preceding siblings + earlier(parent), recursively (same walk as the shift). */
export function afterEarlierLeavesBlockers(goalId: number, nodeId: number): OrderBlocker[] {
  const rows = sqliteDb.prepare(
    `SELECT id, parent_id, title, state, leaf_kind, notes, tree_id FROM goal_nodes
       WHERE goal_id = ? AND state NOT IN ('discarded') ORDER BY sort_order, id`,
  ).all(goalId) as OrderRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const node = byId.get(nodeId);
  if (!node || !node.notes?.includes(AFTER_EARLIER_LEAVES)) return [];

  const childrenOf = new Map<number | null, OrderRow[]>();
  for (const r of rows) {
    const k = r.parent_id ?? null;
    if (!childrenOf.has(k)) childrenOf.set(k, []);
    childrenOf.get(k)!.push(r);
  }
  const earlier: OrderRow[] = [];
  let cur: OrderRow | undefined = node;
  while (cur) {
    const sibs = childrenOf.get(cur.parent_id ?? null) ?? [];
    const pos = sibs.findIndex((s) => s.id === cur!.id);
    for (let i = 0; i < pos; i += 1) earlier.push(sibs[i]);
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
  }

  const base = baseFromNotes(node.notes);
  const out: OrderBlocker[] = [];
  for (const e of earlier) {
    if (e.leaf_kind !== 'machine' || e.state === 'ghost') continue;
    // Landed = verified `done`. `check` is "tree finished, verdict pending" — a FAIL verdict
    // reopens the node and lands nothing, so it is NOT landed yet.
    if (e.state !== 'done') {
      out.push({ id: e.id, title: e.title, why: `#${e.id} ${e.title} is ${e.state}, not landed` });
      continue;
    }
    // Belt and braces: `done` AND its integration tip must actually be on the base.
    if (!e.tree_id || !base || PROTECTED.has(base.toLowerCase())) continue;
    const t = sqliteDb.prepare(`SELECT repo_path, integration_branch FROM hopper_trees WHERE id = ?`).get(e.tree_id) as
      { repo_path: string | null; integration_branch: string | null } | undefined;
    const repo = t?.repo_path || repoFromNotes(node.notes);
    const ib = t?.integration_branch;
    if (!repo || !ib) continue;
    if (!gitOk(repo, ['rev-parse', '--verify', ib]) || !gitOk(repo, ['rev-parse', '--verify', base])) continue;
    if (!gitOk(repo, ['merge-base', '--is-ancestor', ib, base])) {
      out.push({ id: e.id, title: e.title, why: `#${e.id} ${e.title} is done but ${ib} is not on ${base} yet` });
    }
  }
  return out;
}

/** One-line human text for a blocker list. */
export function blockerLine(bs: OrderBlocker[]): string {
  return bs.length ? `holds for earlier features to land (${bs[0].why})`.slice(0, 200) : '';
}
