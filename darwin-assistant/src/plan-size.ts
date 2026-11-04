// plan-size.ts — model-free "is this planned tree big?" test + routing note.
//
// WHY THIS EXISTS (tree-c679ba76 › Sprint lane routing by size): the sprint
// lane is faster but only pays off for a BIG planned tree. This module is the
// cheap, deterministic test that decides whether a plan is big enough to route
// through the sprint lane, and the human-readable routing NOTE that explains
// the verdict. It REPLACES the planned `routeLeaf` (ghost #389); node #390 will
// consume `planSize` to actually invoke the sprint lane (the seam is marked in
// goals.ts proposePlanEx). This node (#1745) only MEASURES and NOTES — it never
// invokes sprint.
//
// PURITY CONTRACT: this module is dependency-light and PURE. `planSize()` does
// pure arithmetic + string scanning over the plan it is handed — no DB, no
// network, no model call, and (critically) no IMPORT-time side effects. That is
// why the estimate constants live HERE rather than being imported from
// night-shift.ts: night-shift.ts opens a sqlite DB at import time (via
// conversation-db.ts:18), so importing from it would give this module an
// import-time DB side effect. Instead this module OWNS the two plan-build
// estimate numbers and night-shift.ts imports THEM from here, so there is still
// exactly one source of truth for the formula — just pointing the other way.
//
// The only import is a TYPE-ONLY import of PlanJson from goals.ts. goals.ts
// imports planSize() from here at runtime; a type-only import back is erased at
// compile time, so there is no runtime import cycle.

import type { PlanJson, PlanJsonNode } from './goals.js';

// ---------------------------------------------------------------------------
// Estimate constants — THE single source of truth for the plan-build estimate.
// night-shift.ts's NIGHT_EST_DEFAULTS.{plan_build_min, plan_build_per_node}
// import these, and planEst()/estimateFor() in night-shift.ts apply the same
// Math.max formula reproduced in estPlanMinutes() below. Change the numbers
// here and both the sprint-routing test and the night-shift ETA move together.
// ---------------------------------------------------------------------------

/** Base minutes any build plan is assumed to take, floor of the estimate. */
export const PLAN_BUILD_BASE_MIN = 45;
/** Additional minutes assumed per build node. */
export const PLAN_BUILD_PER_NODE_MIN = 15;

/**
 * The night-shift plan estimate, as a pure function of the build-node count.
 * THE single source of the formula:
 *   Math.max(plan_build_min, plan_build_per_node * nodes)
 * (NOT `base + per_node*nodes` — the prose in some specs paraphrases it that
 * way, but the authoritative engine formula is the Math.max above.)
 *
 * `est` lets a caller inject live estimate constants (e.g. night-shift's
 * per-run NIGHT_EST_DEFAULTS, which may be overridden from settings) so the
 * night-shift `planEst()` can delegate here instead of reproducing the Math.max
 * itself (#390: night-shift plan estimate single-sourced through planSize's
 * formula). Defaults to this module's own constants, so #394's callers that
 * pass only the node count are unchanged.
 */
export function estPlanMinutes(
  buildNodes: number,
  est: PlanSizeEst = { plan_build_min: PLAN_BUILD_BASE_MIN, plan_build_per_node: PLAN_BUILD_PER_NODE_MIN },
): number {
  return Math.max(est.plan_build_min, est.plan_build_per_node * Math.max(0, buildNodes));
}

// ---------------------------------------------------------------------------
// Size thresholds — documented so the rule reads the same in code and in
// outbox/sprint-lane/WIRE-IN.md (STEP 5 keeps that doc line-for-line in sync).
// ---------------------------------------------------------------------------
export const SIZE_THRESHOLDS = {
  /** big if build-node count >= this */
  nodes: 5,
  /** big if estimated minutes > this */
  est_minutes: 60,
  /** AND-rule part 1: at least this many independent root nodes (no deps) */
  indep_roots: 3,
  /** AND-rule part 2: AND at least this many distinct files touched */
  distinct_files: 8,
} as const;

// ---------------------------------------------------------------------------
// Exclusions — categories that force a SMALL / plain-tree verdict regardless of
// size. Mirrored verbatim in outbox/sprint-lane/WIRE-IN.md.
//
// Two of the five are text-detectable from the plan itself (self-builds,
// research/docs-only) and are auto-detected below. The other three are context
// the CALLER knows, not the plan — a human-step node, a FAIL replan, or a
// live-prod touch — so the caller passes `opts.excludedReason` to force the
// same outcome. Either way the fired exclusion is recorded in `reasons`.
// ---------------------------------------------------------------------------
export const PLAN_SIZE_EXCLUSIONS = [
  'darwin-assistant self-builds',
  'live-prod touches',
  'research/docs-only',
  'human steps',
  'FAIL replans',
] as const;
export type PlanSizeExclusion = (typeof PLAN_SIZE_EXCLUSIONS)[number];

/** Injectable estimate constants (lets a caller pass the live night-shift
 *  config values; defaults to this module's own single-source constants). */
export interface PlanSizeEst {
  plan_build_min: number;
  plan_build_per_node: number;
}
export const EST_DEFAULT: PlanSizeEst = {
  plan_build_min: PLAN_BUILD_BASE_MIN,
  plan_build_per_node: PLAN_BUILD_PER_NODE_MIN,
};

export interface PlanSizeOpts {
  /** Live estimate constants (e.g. night-shift NIGHT_EST_DEFAULTS). Defaults to EST_DEFAULT. */
  est?: PlanSizeEst;
  /** Extra free text to scan for an `executor: tree|sprint` override — e.g. the
   *  goal node's `notes`. The plan's own node specs + what/deliverable are
   *  always scanned too. */
  noteText?: string;
  /** Caller-known exclusion (human steps / FAIL replan / live-prod). When set,
   *  forces a small/plain-tree verdict and is recorded in reasons. */
  excludedReason?: PlanSizeExclusion | string;
}

export interface PlanSizeVerdict {
  big: boolean;
  reasons: string[];
  nodes: number;
  est_minutes: number;
  distinct_files: number;
}

// ---------------------------------------------------------------------------
// File-path heuristic (best effort). A "file path" is a run of path-safe
// characters containing at least one "/" and ending in a dotted extension,
// e.g. `src/goals.ts`, `darwin-assistant/src/plan-size.ts`,
// `/home/kevin/paperclip/x.md`. This deliberately does NOT try to parse prose;
// it just counts the distinct concrete paths a spec names. URLs can match
// (`example.com/a/b.js`) — acceptable noise for a size heuristic.
// ---------------------------------------------------------------------------
const PATH_RE = /(?:[A-Za-z0-9_@.~-]+\/)+[A-Za-z0-9_@.-]+\.[A-Za-z0-9]{1,8}/g;

function extractPaths(text: string | null | undefined): string[] {
  if (!text) return [];
  const m = text.match(PATH_RE);
  return m ?? [];
}

/** A verify/accept/review-gate node is NOT a build node: it is excluded from
 *  the count. #400 — the server-appended review gate is four nodes
 *  (REVIEW opus ∥ REVIEW codex → FIX → VERIFY); none are build work. The
 *  terminal VERIFY is caught by `verify_index`/the VERIFY|ACCEPT regex; the two
 *  reviews and the fix are caught by their reserved title prefixes (precise
 *  enough not to match an ordinary "Review …"/"Fix …" build node). */
function isVerifyNode(plan: PlanJson, index: number, n: PlanJsonNode): boolean {
  if (plan.verify_index != null && plan.verify_index >= 0 && plan.verify_index === index) return true;
  const t = (n.title ?? '').trim();
  // defensive: a model that wrongly titled its own verifier
  if (/^(VERIFY|ACCEPT)\b/i.test(t)) return true;
  // the appended review gate's non-terminal nodes
  return /^REVIEW \((?:opus|codex)\):/i.test(t) || /^FIX review findings:/i.test(t);
}

const OVERRIDE_RE = /executor:\s*(sprint|tree)/i;

/**
 * Model-free size test for a planned tree.
 *
 * - `nodes`          = count of BUILD nodes (the ACCEPT/verify node excluded).
 * - `est_minutes`    = estPlanMinutes(nodes) using opts.est ?? EST_DEFAULT.
 * - `distinct_files` = distinct file paths mentioned across the build node specs.
 * - `big`            = TRUE if ANY of: nodes >= 5; est_minutes > 60;
 *                      (independent roots >= 3 AND distinct_files >= 8).
 *
 * A node-note `executor: tree|sprint` override forces the verdict, and an
 * `opts.excludedReason` (or an auto-detected self-build / docs-only plan) forces
 * small. Both are recorded in `reasons`. Pure: no DB/network/model.
 */
export function planSize(plan: PlanJson, opts: PlanSizeOpts = {}): PlanSizeVerdict {
  const est = opts.est ?? EST_DEFAULT;
  const buildNodes = (plan.nodes ?? []).filter((n, i) => !isVerifyNode(plan, i, n));
  const nodes = buildNodes.length;
  const est_minutes = Math.max(est.plan_build_min, est.plan_build_per_node * nodes);

  const files = new Set<string>();
  for (const n of buildNodes) {
    for (const p of extractPaths(n.spec)) files.add(p);
  }
  const distinct_files = files.size;

  const indepRoots = buildNodes.filter((n) => !n.depends_on_indexes || n.depends_on_indexes.length === 0).length;

  const reasons: string[] = [];

  // 1) node-note override wins outright.
  const scanText = [opts.noteText ?? '', plan.what ?? '', plan.deliverable ?? '', ...buildNodes.map((n) => n.spec ?? '')].join('\n');
  const override = OVERRIDE_RE.exec(scanText);
  if (override) {
    const forced = override[1].toLowerCase() === 'sprint';
    reasons.push(`override: node note forces executor=${forced ? 'sprint' : 'tree'}`);
    return { big: forced, reasons, nodes, est_minutes, distinct_files };
  }

  // 2) exclusions force small / plain-tree regardless of size.
  const caller = opts.excludedReason?.trim();
  if (caller) {
    reasons.push(`excluded (${caller}) — forced to plain tree`);
    return { big: false, reasons, nodes, est_minutes, distinct_files };
  }
  // auto-detect: darwin-assistant self-build (the engine editing its own code).
  if (/\bdarwin-assistant\b|\/home\/kevin\/paperclip(?!-worktrees)/i.test(scanText)) {
    reasons.push('excluded (darwin-assistant self-builds) — forced to plain tree');
    return { big: false, reasons, nodes, est_minutes, distinct_files };
  }
  // auto-detect: research/docs-only — there are build nodes AND every file any
  // of them names is a doc (.md/.mdx/.txt/.rst), and at least one file is named.
  if (nodes > 0) {
    const allFiles = [...files];
    const docsOnly = allFiles.length > 0 && allFiles.every((f) => /\.(md|mdx|txt|rst)$/i.test(f));
    if (docsOnly) {
      reasons.push('excluded (research/docs-only) — forced to plain tree');
      return { big: false, reasons, nodes, est_minutes, distinct_files };
    }
  }

  // 3) size triggers (any one makes it big).
  if (nodes >= SIZE_THRESHOLDS.nodes) reasons.push(`${nodes} build nodes (>= ${SIZE_THRESHOLDS.nodes})`);
  if (est_minutes > SIZE_THRESHOLDS.est_minutes) reasons.push(`~${est_minutes}m estimated (> ${SIZE_THRESHOLDS.est_minutes}m)`);
  if (indepRoots >= SIZE_THRESHOLDS.indep_roots && distinct_files >= SIZE_THRESHOLDS.distinct_files) {
    reasons.push(`${indepRoots} independent roots touching ${distinct_files} files (>= ${SIZE_THRESHOLDS.indep_roots} roots & >= ${SIZE_THRESHOLDS.distinct_files} files)`);
  }

  const big = reasons.length > 0;
  if (!big) reasons.push(`small: ${nodes} build nodes, ~${est_minutes}m, ${distinct_files} files`);
  return { big, reasons, nodes, est_minutes, distinct_files };
}

/** One-line human-readable routing note for a verdict (used by both hooks). */
export function routingNote(v: PlanSizeVerdict): string {
  return `routing: ${v.big ? 'BIG → sprint-lane candidate' : 'small → plain tree'} — ` +
    `${v.nodes} build nodes, ~${v.est_minutes}m, ${v.distinct_files} files · ${v.reasons.join('; ')}`;
}

/**
 * Planning-as-a-tree-node (D) — should this runnable machine LEAF be planned by
 * the speed (sprint) lane? Pure (no DB / network / model): scans only the goal
 * node's own `notes` for an explicit `executor: sprint|tree` opt-in. The last
 * match wins when a note was edited more than once. Conservative default is
 * FALSE — a leaf that never opted in takes the plain `plan` cue path, so a
 * one-feature change no longer pays for two planners + a referee.
 */
export function leafWantsSprint(node: { notes?: string | null }): boolean {
  const text = node.notes ?? '';
  if (!text) return false;
  let verdict = false;
  const re = /executor:\s*(sprint|tree)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) verdict = m[1].toLowerCase() === 'sprint';
  return verdict;
}
