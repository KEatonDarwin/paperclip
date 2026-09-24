// GOALS AUTOPILOT — the driver (CONTRACT.md §15.4–§15.8, tree-a2a9e6b2 node #538).
//
// Kevin sets a goal and flips 🌙 autopilot on; this module walks the goal's tree
// on a heartbeat and computes ONE deterministic next action per goal. It makes
// ZERO model calls: it either applies the action itself (parse a VERIFY verdict,
// retry a failed plant, park) or posts ONE cue into the goal chat so a real
// JARVIS turn does the thinking (decompose / plan / replan / classify / unblock /
// weigh_in / wrap). Every decision is a goal_events row.
//
// Seams: goals.ts registers nothing about us — we register INTO it at module
// load (registerAutopilotHooks: preview / kick / hold) because goals.ts cannot
// import this file back. Cues go through goals.ts `postCue` (§11.3 seam) so the
// scratch-DB sims that stub goals.js's dynamic import('./agent.js') see them.
// The in-flight / governor probes are overridable for tests
// (__setAutopilotTestOverrides) — the driver never spawns anything itself.

import fs from 'node:fs';
import path from 'node:path';
import { sqliteDb, getConversation, getSetting } from './conversation-db.js';
import { registerTreeStatusListener, getHopperTree, getHopperNode } from './hopper-engine.js';
import { governorCheck, governorStatus, type GovernorVerdict } from './hopper-governor.js';
import { listQueuedMessages } from './thread-message-queue.js';
import {
  GoalError,
  getGoalTree,
  getRawGoal,
  getRawGoalNode,
  autopilotConfigFor,
  normalizeAutopilotConfig,
  recordAutopilotVerdict,
  verifyGoalNode,
  parkGoalNode,
  approvePlan,
  setAutopilotOff,
  setGoalFocus,
  cueTargetForNode,
  postCue,
  insertEvent,
  emitGoal,
  registerAutopilotHooks,
  AUTOPILOT_DEFAULTS,
  type AutopilotConfig,
  type AutopilotVerdict,
  type AutopilotNextAction,
  type AutopilotActionKind,
  type GoalNodeRow,
  type GoalRow,
  type GoalTree,
  type PlanJson,
} from './goals.js';
import { VAULT_ROOT } from './goals-autopilot-verify.js';

// NIGHT SHIFT §4.5 — night-shift.ts imports this module (predicates, cue text,
// verdict parser), so we must NOT import it back. It registers its ownership
// probe here at its own module load; null until then = nobody owns anything.
type NightOwnsFn = (goalId: number) => boolean;
let nightOwns: NightOwnsFn | null = null;
export function registerNightShiftOwnership(fn: NightOwnsFn | null): void {
  nightOwns = fn;
}
export function nightShiftOwnsGoal(goalId: number): boolean {
  if (!nightOwns) return false;
  try { return nightOwns(goalId); } catch { return false; }
}

export const STOP_FILE = process.env.GOALS_AUTOPILOT_STOP_FILE?.trim() || '/tmp/goals-autopilot.stop';
const LOOP_MS = (() => {
  const n = Number(process.env.GOALS_AUTOPILOT_LOOP_MS);
  return Number.isFinite(n) && n >= 50 ? n : 60_000;
})();
const KICK_COALESCE_MS = (() => {
  const n = Number(process.env.GOALS_AUTOPILOT_KICK_MS);
  return Number.isFinite(n) && n >= 0 ? n : 1_000;
})();
const SETTING_ENABLED = 'goals_autopilot_enabled';

// ---------------------------------------------------------------------------
// Test seams (scratch-DB sims only)
// ---------------------------------------------------------------------------

interface TestOverrides {
  governor?: () => Pick<GovernorVerdict, 'allow' | 'reason'>;
  inFlight?: (conversationId: number) => string | null;
  now?: () => number;
}
let overrides: TestOverrides = {};
export function __setAutopilotTestOverrides(next: TestOverrides): void {
  overrides = { ...next };
}
function nowMs(): number {
  return overrides.now ? overrides.now() : Date.now();
}

// ---------------------------------------------------------------------------
// §15.3 verdict parser (pure)
// ---------------------------------------------------------------------------

export type ParsedVerdict = Pick<AutopilotVerdict, 'verdict' | 'evidence' | 'gaps'>;

export function parseVerdict(resultText: string | null | undefined, hopperStatus?: string | null): ParsedVerdict {
  const text = (resultText ?? '').trim();
  const noVerdict = (): ParsedVerdict => ({
    verdict: 'FAIL',
    evidence: '',
    gaps: [`no verdict — VERIFY node did not report \`VERDICT: PASS|FAIL\` (result: ${text.slice(0, 200)})`],
  });
  if (hopperStatus && hopperStatus !== 'done') return noVerdict();
  if (!text) return noVerdict();
  const lines = text.split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  const m = firstIdx >= 0 ? /^VERDICT:\s*(PASS|FAIL)\b/i.exec(lines[firstIdx].trim()) : null;
  if (!m) return noVerdict();
  let verdict: 'PASS' | 'FAIL' = m[1].toUpperCase() as 'PASS' | 'FAIL';

  const evIdx = lines.findIndex((l) => /^evidence:\s*$/i.test(l.trim()));
  const gapIdx = lines.findIndex((l, i) => i > (evIdx >= 0 ? evIdx : firstIdx) && /^gaps:\s*$/i.test(l.trim()));
  let evidence = '';
  if (evIdx >= 0) {
    const end = gapIdx > evIdx ? gapIdx : lines.length;
    evidence = lines.slice(evIdx + 1, end).join('\n').trim();
  }
  let gaps: string[] = [];
  if (gapIdx >= 0) {
    gaps = lines
      .slice(gapIdx + 1)
      .map((l) => /^\s*-\s+(.*)$/.exec(l)?.[1]?.trim() ?? '')
      .filter((g) => g.length > 0);
    if (gaps.length === 1 && /^none\.?$/i.test(gaps[0])) gaps = [];
  }
  if (verdict === 'PASS' && gaps.length) {
    verdict = 'FAIL';
    gaps = ['verifier reported gaps alongside PASS', ...gaps];
  }
  return { verdict, evidence, gaps };
}

// ---------------------------------------------------------------------------
// §15.4 decision table (pure over a GoalTree read)
// ---------------------------------------------------------------------------

function cfgOf(goal: GoalRow): AutopilotConfig {
  return goal.autopilot_config ?? normalizeAutopilotConfig(null);
}

function parsePlan(node: Pick<GoalNodeRow, 'plan'>): PlanJson | null {
  if (!node.plan) return null;
  try { return JSON.parse(node.plan) as PlanJson; } catch { return null; }
}

/** settled(n) for the ORDERING walk (§15.4). `working` counts: a leaf that
 *  has been dispatched already holds its place in the row — concurrency is
 *  limited by row 3's `parallel` cap, not by ordering. With parallel=1 row 3
 *  fires before this walk whenever anything is working, so parallel=1
 *  behaviour is byte-identical; with parallel>1 the NEXT leaf in DFS order may
 *  start while the earlier one runs (AP-7's `parallel:2` example). REVIEW fix
 *  (node #541): previously `working` was NOT settled, which made parallel>1
 *  inert. `planned` (plant retry pending) is deliberately not settled. */
export function isSettled(n: GoalNodeRow): boolean {
  return n.state === 'done' || n.state === 'parked' || n.state === 'working' || n.leaf_kind === 'human' || n.state === 'check' || n.promoted_to_goal_id != null;
}

export interface TreeIndex {
  nodes: GoalNodeRow[];
  byId: Map<number, GoalNodeRow>;
  childrenOf: Map<number | null, GoalNodeRow[]>;
}

export function indexTree(nodes: GoalNodeRow[]): TreeIndex {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<number | null, GoalNodeRow[]>();
  for (const n of nodes) {
    const key = n.parent_id ?? null;
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(n); // tree.nodes is already sort_order,id DFS order
  }
  return { nodes, byId, childrenOf };
}

/** earlier(n): preceding siblings + earlier(parent), recursively. */
export function earlierOf(ix: TreeIndex, n: GoalNodeRow): GoalNodeRow[] {
  const out: GoalNodeRow[] = [];
  let cur: GoalNodeRow | undefined = n;
  while (cur) {
    const sibs = ix.childrenOf.get(cur.parent_id ?? null) ?? [];
    const pos = sibs.findIndex((s) => s.id === cur!.id);
    for (let i = 0; i < pos; i += 1) out.push(sibs[i]);
    cur = cur.parent_id != null ? ix.byId.get(cur.parent_id) : undefined;
  }
  return out;
}

export function ancestorsBlock(ix: TreeIndex, n: GoalNodeRow): boolean {
  let cur = n.parent_id != null ? ix.byId.get(n.parent_id) : undefined;
  while (cur) {
    if (cur.state === 'ghost' || cur.state === 'parked') return true;
    cur = cur.parent_id != null ? ix.byId.get(cur.parent_id) : undefined;
  }
  return false;
}

export function earlierSettled(ix: TreeIndex, n: GoalNodeRow): boolean {
  return earlierOf(ix, n).every(isSettled);
}

export function isRunnable(ix: TreeIndex, n: GoalNodeRow, cfg: AutopilotConfig): boolean {
  return n.state === 'set' && n.leaf_kind === 'machine' && n.plan_state === 'none'
    && n.autopilot_attempts < cfg.max_attempts && earlierSettled(ix, n);
}

export interface Decision extends AutopilotNextAction {
  /** row 8: nodes Kevin changed during the night, folded into this cue. */
  weigh_in: number[];
}

/** The §15.4 decision table (rows 2–9) over an already-read tree. Pure. */
export function computeNextAction(nodes: GoalNodeRow[], cfg: AutopilotConfig): Decision {
  const ix = indexTree(nodes);
  const weighIn = nodes.filter((n) => n.review_state === 'awaiting_jarvis').map((n) => n.id);
  const done = (action: AutopilotActionKind | null, node: GoalNodeRow | null, reason: string): Decision =>
    ({ action, node_id: node?.id ?? null, reason, weigh_in: weighIn });

  // row 2 — a blocked tree.
  const blocked = nodes.find((n) => n.state === 'working' && n.tree_status_cache === 'blocked');
  if (blocked) return done('unblock', blocked, `tree ${blocked.tree_id ?? '?'} is blocked`);

  // row 3 — parallel slots full.
  const working = nodes.filter((n) => n.state === 'working').length;
  if (working >= cfg.parallel) return done(null, null, 'parallel_full');

  // rows 4/5/6 — one DFS walk, first node that satisfies any of them.
  for (const n of nodes) {
    if (ancestorsBlock(ix, n)) continue;
    if (isRunnable(ix, n, cfg)) {
      return n.autopilot_attempts > 0
        ? done('replan', n, `attempt ${n.autopilot_attempts + 1} of ${cfg.max_attempts} after a FAIL`)
        : done('plan', n, 'first runnable machine leaf');
    }
    if (n.state === 'set' && n.leaf_kind === 'none' && n.child_count === 0 && n.promoted_to_goal_id == null && earlierSettled(ix, n)) {
      if (n.depth < cfg.max_depth) return done('decompose', n, `set node with no children at depth ${n.depth} of ${cfg.max_depth}`);
      return done('classify', n, `at max_depth ${cfg.max_depth}`);
    }
  }

  // still working (below the parallel cap) or a plant retry pending → wait.
  if (working > 0) return done(null, null, 'waiting_on_work');
  if (nodes.some((n) => n.state === 'planned')) return done(null, null, 'plant_retry_pending');

  // row 8 standalone — nothing else to do but Kevin changed things.
  if (weighIn.length) return done('weigh_in', null, `${weighIn.length} Kevin change(s) awaiting weigh-in`);

  // row 9 — nothing runnable, nothing working.
  return done('wrap', null, 'nothing runnable and nothing working');
}

/** Pure read for GoalSummary.autopilot_next + route 38 (no writes, no cues). */
export function nextAction(goalId: number): AutopilotNextAction | null {
  const goal = getRawGoal(goalId);
  if (!goal || goal.autopilot !== 1) return null;
  const tree = getGoalTree(goalId);
  if (!tree) return null;
  const d = computeNextAction(tree.nodes, cfgOf(goal));
  return { action: d.action, node_id: d.node_id, reason: d.reason };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export type HoldReason = 'disabled' | 'stop_file' | `governor:${string}` | 'chat_busy';

function governorProbe(logging: boolean): Pick<GovernorVerdict, 'allow' | 'reason'> {
  if (overrides.governor) return overrides.governor();
  return logging ? governorCheck('claude') : governorStatus('claude');
}

/** Gates 1–3 (sync). `logging=false` for previews (governorStatus has no side effects). */
export function syncHoldReason(logging = false): HoldReason | null {
  if (getSetting(SETTING_ENABLED) === '0') return 'disabled';
  if (fs.existsSync(STOP_FILE)) return 'stop_file';
  const gov = governorProbe(logging);
  if (!gov.allow) return `governor:${gov.reason}`;
  return null;
}

async function inFlightFor(conversationId: number): Promise<string | null> {
  if (overrides.inFlight) return overrides.inFlight(conversationId);
  const agent = await import('./agent.js');
  return agent.getInFlightMessageId(conversationId);
}

/** Gate 4: the goal chat (and the cue target, when different) has no in-flight
 *  turn and no queued autopilot cue. */
async function chatBusy(goalId: number, extraTarget?: string | null): Promise<boolean> {
  const targets = new Set<string>([`cockpit:goal-${goalId}`]);
  if (extraTarget) targets.add(extraTarget);
  const prefix = `[autopilot goal #${goalId}`;
  for (const ext of targets) {
    const conv = getConversation(ext);
    if (!conv) continue;
    if (await inFlightFor(conv.id)) return true;
    if (listQueuedMessages(conv.id).some((q) => q.content.trimStart().startsWith(prefix))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Driver state (per goal, in-memory; the durable trail is goal_events)
// ---------------------------------------------------------------------------

interface LastCue {
  key: string;
  action: AutopilotActionKind;
  node_id: number;
  correlation: string;
  at: number;              // ms
  second_ask: boolean;
  node_sig: string;        // signature of the cued node when the cue was posted
}
interface HoldLogEntry { reason: string; from: number; to: number | null }
interface GoalDriverState {
  lastTickAt: number;
  pendingKick: boolean;
  ticking: boolean;
  kickTimer: NodeJS.Timeout | null;
  lastHold: string | null;
  holdLog: HoldLogEntry[];
  plantFailures: Map<number, number>;
  lastCue: LastCue | null;
  lastCueLoaded: boolean;
}
const states = new Map<number, GoalDriverState>();
function stateFor(goalId: number): GoalDriverState {
  let s = states.get(goalId);
  if (!s) {
    s = { lastTickAt: 0, pendingKick: false, ticking: false, kickTimer: null, lastHold: null, holdLog: [], plantFailures: new Map(), lastCue: null, lastCueLoaded: false };
    states.set(goalId, s);
  }
  return s;
}

function nodeSig(n: GoalNodeRow | null | undefined): string {
  if (!n) return 'gone';
  return [n.state, n.leaf_kind, n.plan_state, n.child_count, n.autopilot_attempts, n.review_state, n.updated_at].join('|');
}

/** Seed the in-memory last-cue record from the trail so a restart doesn't re-post. */
function loadLastCue(goalId: number, s: GoalDriverState): void {
  if (s.lastCueLoaded) return;
  s.lastCueLoaded = true;
  const row = sqliteDb.prepare(`SELECT data, created_at FROM goal_events WHERE goal_id = ? AND kind = 'autopilot_cue' ORDER BY id DESC LIMIT 1`)
    .get(goalId) as { data: string | null; created_at: string } | undefined;
  if (!row?.data) return;
  try {
    const d = JSON.parse(row.data) as Partial<LastCue> & { correlation?: string; at_ms?: number };
    if (d.correlation && d.action) {
      s.lastCue = {
        key: d.correlation,
        action: d.action,
        node_id: Number(d.node_id ?? 0),
        correlation: d.correlation,
        at: typeof d.at_ms === 'number' ? d.at_ms : Date.parse(`${row.created_at.replace(' ', 'T')}Z`),
        second_ask: !!d.second_ask,
        node_sig: d.node_sig ?? '',
      };
    }
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Pre-pass (server-only; runs on every tick, held or not)
// ---------------------------------------------------------------------------

function prePass(goal: GoalRow, tree: GoalTree, s: GoalDriverState): boolean {
  const cfg = cfgOf(goal);
  let wrote = false;
  // P0 — plan approved, tree plant failed → retry once, then park.
  for (const n of tree.nodes) {
    if (n.state !== 'planned') continue;
    try {
      approvePlan(goal.id, n.id, 'system');
      s.plantFailures.delete(n.id);
      wrote = true;
    } catch (err) {
      const count = (s.plantFailures.get(n.id) ?? 0) + 1;
      s.plantFailures.set(n.id, count);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[autopilot] goal #${goal.id} node #${n.id} plant retry ${count} failed: ${msg}`);
      if (count >= 2) {
        try {
          parkGoalNode(goal.id, n.id, 'system', `tree plant failed twice: ${msg}`.slice(0, 500));
          s.plantFailures.delete(n.id);
          wrote = true;
        } catch (perr) {
          console.error(`[autopilot] goal #${goal.id} park after plant failure threw`, perr);
        }
      }
    }
  }
  // P1 — parse VERIFY verdicts for check nodes not yet parsed for their tree.
  for (const n of tree.nodes) {
    if (n.state !== 'check' || !n.tree_id) continue;
    const plan = parsePlan(n);
    const verifyId = plan?.verify_hopper_node_id;
    if (!verifyId) continue;
    if (n.autopilot_verdict && n.autopilot_verdict.tree_id === n.tree_id) continue;
    const hopper = getHopperNode(verifyId);
    const parsed = parseVerdict(hopper?.result, hopper?.status ?? 'missing');
    const verdict: AutopilotVerdict = { ...parsed, tree_id: n.tree_id, at: new Date(nowMs()).toISOString() };
    try {
      const after = recordAutopilotVerdict(goal.id, n.id, verdict);
      if (verdict.verdict === 'PASS') {
        verifyGoalNode(goal.id, n.id, true, verdict.evidence || 'VERIFY: PASS', 'system');
      } else {
        verifyGoalNode(goal.id, n.id, false, verdict.gaps.join('\n') || 'VERIFY: FAIL', 'system');
        if (after.autopilot_attempts >= cfg.max_attempts) {
          parkGoalNode(goal.id, n.id, 'system', `verify failed ${after.autopilot_attempts}/${cfg.max_attempts}: ${verdict.gaps[0] ?? 'no gap text'}`.slice(0, 500));
        }
      }
      wrote = true;
    } catch (err) {
      console.error(`[autopilot] goal #${goal.id} node #${n.id} verdict resolution threw`, err);
    }
  }
  return wrote;
}

// ---------------------------------------------------------------------------
// §15.5 cue texts
// ---------------------------------------------------------------------------

function q(s: string | null | undefined): string {
  return (s ?? '').replace(/\n+/g, ' ').trim();
}

function weighInBlock(tree: GoalTree, ids: number[], goalTitle: string): string {
  if (!ids.length) return '';
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const lines = ids.map((id) => {
    const n = byId.get(id);
    if (!n) return `#${id} (gone)`;
    if (n.kevin_moved_at) {
      const from = n.kevin_move_from;
      const fromTitle = from == null || from === -1 ? `${goalTitle} (root)` : (byId.get(from)?.title ?? getRawGoalNode(from)?.title ?? `#${from}`);
      return `#${n.id} moved: "${n.title}" — done: "${q(n.done_means)}"  [from: ${fromTitle}]`;
    }
    if (n.kevin_edit_original) {
      let orig: { title?: string; done_means?: string } = {};
      try { orig = JSON.parse(n.kevin_edit_original) as { title?: string; done_means?: string }; } catch { /* keep {} */ }
      return `#${n.id} edited: "${n.title}" — done: "${q(n.done_means)}"  [was: "${orig.title ?? ''}" — done: "${q(orig.done_means)}"]`;
    }
    return `#${n.id} added: "${n.title}" — done: "${q(n.done_means)}"`;
  });
  return [
    'Also — Kevin changed these during the night; weigh in on each (acknowledge in a sentence, then `accept` {node_id} or `push_back` {node_id, note}); a push-back is a note for the morning, it does not stop the run:',
    ...lines,
  ].join('\n');
}

export function composeCueText(goal: GoalRow, tree: GoalTree, d: Decision, secondAsk: boolean): string {
  const cfg = cfgOf(goal);
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const node = d.node_id != null ? byId.get(d.node_id) ?? null : null;
  const actionUpper = (d.action ?? 'wait').toUpperCase();
  const header = `[autopilot goal #${goal.id} — ${actionUpper} #${node?.id ?? 0} "${node?.title ?? goal.title}"]${secondAsk ? ' (second ask)' : ''}`;
  const preambleRules =
    `Kevin is asleep — never ask him anything and never end this turn on a question. If this step genuinely needs him, \`park\` {node_id:${node?.id ?? 0}, reason:"…"} with a \`log\` line and stop; the night report surfaces it. ` +
    'Do exactly this one step on this one node — don\'t wander the tree. Reply in ≤4 lines, then ONE `log` op (one sentence: what you decided and why) — the morning report is built from those lines.';
  const lines: string[] = [header, preambleRules];
  if (node) {
    const parent = node.parent_id != null ? byId.get(node.parent_id) : undefined;
    lines.push(
      `Node #${node.id} · ${node.title}`,
      `  done_means: ${q(node.done_means)}`,
      `  path: ${node.path.join(' › ')}`,
      `  notes: ${node.notes?.trim() ? node.notes.trim() : '(none)'}`,
      `  parent's done_means: ${parent ? q(parent.done_means) : '(root — the goal itself)'}`,
    );
  }
  const attempt = (node?.autopilot_attempts ?? 0) + 1;
  const gapsBlock = node?.autopilot_verdict?.gaps?.length
    ? `Last verdict: FAIL — gaps:\n${node.autopilot_verdict.gaps.map((g) => `- ${g}`).join('\n')}\nFix the spec, not the verifier.`
    : '';
  switch (d.action) {
    case 'decompose':
      lines.push(
        `Break #${node!.id} into 2–6 children in EXECUTION ORDER (the driver runs them top to bottom, one at a time). Each child: a title, a one-line done_means a stranger could verify, and \`notes\` = the exact instructions a claude-sonnet worker with no chat context needs (files, commands, acceptance). Classify every child you can in the same turn with \`set_leaf_kind\` (machine = you can spec it; human = only Kevin). Depth budget: this node is at depth ${node!.depth} of max ${cfg.max_depth} — children at depth ${cfg.max_depth} must be leaves. Push back on the parent's done_means the way you would with Kevin: if a better breakdown serves it, do that one (you may \`propose_edit\` #${node!.id}'s wording; it applies immediately). Expected ops: \`propose\` {parent_id:${node!.id}, items:[…]} (lands SET under autopilot — no accept needed) then \`set_leaf_kind\` per child, then \`log\`.`,
      );
      break;
    case 'plan':
    case 'replan': {
      lines.push(
        `Write the plan for #${node!.id} and dispatch it: \`propose_plan\` {node_id:${node!.id}, plan:{what, deliverable, model, estimate, nodes:[…]}}. ≤6 flat build nodes, dependency-ordered via depends_on_indexes, every spec self-contained (a worker on ${cfg.build_model} with no chat context must succeed: repo, branch/worktree, files, commands, acceptance). adapter "claude" on every node; builds on ${cfg.build_model}, mechanical steps on ${cfg.light_model}; never fable / gpt-6-astra. Do NOT add a VERIFY or review node — the server appends the verifier on ${cfg.verify_model} and plants the tree in the same call. This is attempt ${attempt} of ${cfg.max_attempts}.`,
      );
      if (gapsBlock) lines.push(gapsBlock);
      if (d.action === 'replan') {
        lines.push(`The previous tree was ${node!.tree_id ?? '(unknown)'}; read its build results + the VERIFY result before rewriting the spec. If the gaps show the done_means itself is unachievable as written, \`park\` with the reason instead of retrying.`);
      }
      break;
    }
    case 'classify':
      lines.push(
        `#${node!.id} is at the depth limit (${cfg.max_depth}) and cannot be split further under autopilot. Decide now: \`set_leaf_kind\` {node_id:${node!.id}, leaf_kind:"machine"} if you can write a self-contained plan for it (the driver will cue \`plan\` next), \`"human"\` if only Kevin can do it, or \`park\` {node_id:${node!.id}, reason:"…"} if it is neither (too big for one leaf — say what depth it would need). Then \`log\`.`,
      );
      break;
    case 'unblock':
      lines.push(
        `Tree ${node!.tree_id ?? '?'} for #${node!.id} is BLOCKED. Read \`GET /hopper-trees/${node!.tree_id ?? '?'}\` (or the overlay): which node, outcome (blocked vs blocked_question), question/result text. If it is a \`blocked_question\` you can answer from the goal/notes/repo → answer it (\`POST /hopper-nodes/<id>/answer\`) and \`log\`. If it is a genuine \`blocked\` (missing access, broken dependency, toolchain) → decide: re-pend with a corrected spec if the fix is in the spec, or \`park\` #${node!.id} with the precise reason. Never answer a question only Kevin can answer — park it.`,
      );
      break;
    case 'wrap':
      lines.push(
        `Nothing is runnable and nothing is working. Close the night: (1) for every node in \`check\` that has no machine verdict (parents whose children all verified, hand-dispatched leaves), read the evidence and \`verify\` {node_id, passed} yourself — you are the verifier of record; (2) call \`night_report\` (it writes outbox/goals/autopilot-${goal.id}-<date>.md from the event log and posts the path back to you) and post a ≤10-line summary of it here: what got done, what's parked and why, what needs Kevin; (3) if every node is done, say in one line that the goal looks complete and that Kevin should \`verify\` the goal root — do NOT call \`verify {goal:true}\` yourself. Then \`log\` "autopilot: wrapped — <complete|stuck>".`,
      );
      break;
    case 'weigh_in':
      // standalone: the block below is the whole body
      break;
    default:
      break;
  }
  const weigh = weighInBlock(tree, d.weigh_in, goal.title);
  if (weigh) lines.push(weigh);
  lines.push('Expected tool ops for this step are named above; anything else you touch, say why in the log line.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

function noteHold(goalId: number, s: GoalDriverState, reason: string | null): void {
  if (reason === s.lastHold) return;
  const t = nowMs();
  const open = s.holdLog[s.holdLog.length - 1];
  if (open && open.to == null) open.to = t;
  if (reason) {
    s.holdLog.push({ reason, from: t, to: null });
    console.log(`[autopilot] goal #${goalId} held: ${reason}`);
  } else if (s.lastHold) {
    console.log(`[autopilot] goal #${goalId} resumed`);
  }
  s.lastHold = reason;
}

/** Unblock cues already posted for this node during the current run. */
function countUnblockCues(goalId: number, nodeId: number): number {
  const startId = runStartEventId(goalId, null) ?? 0;
  const row = sqliteDb.prepare(`SELECT COUNT(*) AS n FROM goal_events WHERE goal_id = ? AND node_id = ? AND kind = 'autopilot_cue' AND id >= ? AND data LIKE '%"action":"unblock"%'`)
    .get(goalId, nodeId, startId) as { n: number };
  return row?.n ?? 0;
}

/** After a `wrap` cue's turn ended: flip off + fallback report (§15.4 row 9). */
function finalizeWrap(goal: GoalRow, tree: GoalTree, s: GoalDriverState): void {
  const allDone = tree.nodes.every((n) => n.state === 'done' || (n.state === 'check' && n.parent_id == null));
  const reason = allDone ? 'complete' : 'stuck';
  const startedId = runStartEventId(goal.id, null);
  const hasReport = startedId != null && !!sqliteDb.prepare(`SELECT 1 FROM goal_events WHERE goal_id = ? AND kind = 'autopilot_report' AND id >= ? LIMIT 1`).get(goal.id, startedId);
  if (!hasReport) {
    try { buildNightReport(goal.id); } catch (err) { console.error(`[autopilot] goal #${goal.id} fallback report failed`, err); }
  }
  setAutopilotOff(goal.id, reason, 'system');
  s.lastCue = null;
  console.log(`[autopilot] goal #${goal.id} wrapped — ${reason}`);
}

async function tickGoal(goalId: number, reason: string): Promise<void> {
  const s = stateFor(goalId);
  if (s.ticking) { s.pendingKick = true; return; }
  s.ticking = true;
  try {
    s.lastTickAt = nowMs();
    s.pendingKick = false;
    loadLastCue(goalId, s);
    const goal = getRawGoal(goalId);
    if (!goal || goal.autopilot !== 1) return;
    // NIGHT SHIFT (CONTRACT §4.5) — while a night run owns this goal, the
    // per-goal driver stands down entirely: Night Shift drives every cue for
    // it out of the ONE orchestrator thread. Restored at the run's wrap.
    if (nightShiftOwnsGoal(goalId)) return;
    const cfg = cfgOf(goal);
    let tree = getGoalTree(goalId);
    if (!tree) return;

    // Pre-pass always runs (no model calls).
    if (prePass(goal, tree, s)) tree = getGoalTree(goalId) ?? tree;

    // Gates 1–3.
    const hold = syncHoldReason(true);
    if (hold) { noteHold(goalId, s, hold); return; }

    // Decision (pure) → gate 4 checks the goal chat + the target chat.
    const d = computeNextAction(tree.nodes, cfg);
    const target = cueTargetForNode(goalId, d.node_id);
    if (await chatBusy(goalId, target)) {
      noteHold(goalId, s, 'chat_busy');
      s.pendingKick = true; // retry on the next loop rather than waiting tick_minutes
      return;
    }
    noteHold(goalId, s, null);

    // A wrap cue whose turn has ended (we passed gate 4) → close the night.
    if (s.lastCue?.action === 'wrap') {
      finalizeWrap(goal, tree, s);
      return;
    }

    if (!d.action) {
      console.log(`[autopilot] goal #${goalId} ${reason}: waiting (${d.reason})`);
      return;
    }

    const key = `autopilot:${goalId}:${d.action}:${d.node_id ?? 0}`;
    const cuedNode = d.node_id != null ? tree.nodes.find((n) => n.id === d.node_id) ?? null : null;

    // REVIEW fix (node #541) — bound the unblock loop. A tree that JARVIS
    // re-pends and that blocks AGAIN changes the node's signature every time, so
    // the "cue ignored twice" guard below never trips and the night would spend
    // a JARVIS turn + a worker attempt per cycle, forever. Cap unblock cues per
    // node per run at max_attempts; past that → park with the tree id.
    if (d.action === 'unblock' && cuedNode) {
      const prior = countUnblockCues(goalId, cuedNode.id);
      if (prior >= cfg.max_attempts) {
        try {
          parkGoalNode(goalId, cuedNode.id, 'system', `tree ${cuedNode.tree_id ?? '?'} blocked ${prior + 1} times — unblock cues exhausted (${cfg.max_attempts})`.slice(0, 500));
        } catch (err) { console.error('[autopilot] park after exhausted unblock cues failed', err); }
        s.lastCue = null;
        return;
      }
    }

    // Dedupe (§15.4).
    const sig = nodeSig(cuedNode);
    let secondAsk = false;
    if (s.lastCue && s.lastCue.key === key) {
      const unchanged = s.lastCue.node_sig === sig;
      const elapsed = nowMs() - s.lastCue.at;
      if (unchanged && elapsed < cfg.tick_minutes * 60_000) {
        return; // JARVIS's turn is still "fresh" — don't nag.
      }
      if (unchanged) {
        if (s.lastCue.second_ask) {
          // Third identical ask → park (node) or stop (goal-level cue).
          if (cuedNode) {
            try { parkGoalNode(goalId, cuedNode.id, 'system', 'cue ignored twice'); } catch (err) { console.error('[autopilot] park after ignored cues failed', err); }
          } else {
            finalizeWrap(goal, tree, s);
          }
          s.lastCue = null;
          return;
        }
        secondAsk = true;
      }
    }

    // Focus the cued node so the tool's implicit parent is right, then post.
    if (cuedNode) {
      try { setGoalFocus(goalId, cuedNode.id, 'system'); } catch { /* focus is best-effort */ }
    }
    const text = composeCueText(goal, tree, d, secondAsk);
    const at = nowMs();
    insertEvent(goalId, d.node_id ?? null, 'system', 'autopilot_cue', text.split('\n')[0], {
      action: d.action, node_id: d.node_id ?? 0, correlation: key, second_ask: secondAsk, node_sig: sig, at_ms: at, target,
    });
    s.lastCue = { key, action: d.action, node_id: d.node_id ?? 0, correlation: key, at, second_ask: secondAsk, node_sig: sig };
    postCue(target, text, key, 'autopilot');
    emitGoal('updated', goalId);
    console.log(`[autopilot] goal #${goalId} cued ${d.action} #${d.node_id ?? 0}${secondAsk ? ' (second ask)' : ''} → ${target}`);
  } catch (err) {
    console.error(`[autopilot] goal #${goalId} tick failed`, err);
  } finally {
    s.ticking = false;
  }
}

/** One tick for one goal (exported for the sim / an explicit kick). */
export async function tickAutopilot(goalId: number, reason = 'manual'): Promise<void> {
  await tickGoal(goalId, reason);
}

function autopilotGoalIds(): number[] {
  return (sqliteDb.prepare(`SELECT id FROM goals WHERE autopilot = 1 AND archived = 0`).all() as Array<{ id: number }>).map((r) => r.id);
}

/** Every autopilot goal that is due (tick_minutes elapsed or a pending kick). */
export async function tickAll(reason = 'loop'): Promise<void> {
  for (const goalId of autopilotGoalIds()) {
    const s = stateFor(goalId);
    const goal = getRawGoal(goalId);
    if (!goal) continue;
    const due = s.pendingKick || nowMs() - s.lastTickAt >= cfgOf(goal).tick_minutes * 60_000;
    if (!due) continue;
    await tickGoal(goalId, reason);
  }
}

// ---------------------------------------------------------------------------
// Kicks (coalesced, one tick per goal per ~second) + lifecycle
// ---------------------------------------------------------------------------

export function kick(goalId: number): void {
  const s = stateFor(goalId);
  if (s.ticking) { s.pendingKick = true; return; } // our own writes — the tick's tail handles it
  s.pendingKick = true;
  if (s.kickTimer) return;
  s.kickTimer = setTimeout(() => {
    s.kickTimer = null;
    void tickGoal(goalId, 'kick');
  }, KICK_COALESCE_MS);
  s.kickTimer.unref?.();
}

function autopilotOnTreeStatus(treeId: string): void {
  const row = sqliteDb.prepare(`SELECT goal_id FROM goal_nodes WHERE tree_id = ? AND state != 'discarded' ORDER BY id DESC LIMIT 1`).get(treeId) as { goal_id: number } | undefined;
  if (!row) return;
  const goal = getRawGoal(row.goal_id);
  if (goal?.autopilot === 1) kick(goal.id);
}

let loopTimer: NodeJS.Timeout | null = null;
export function startAutopilotDriver(): void {
  if (loopTimer) return;
  loopTimer = setInterval(() => { void tickAll('loop'); }, LOOP_MS);
  loopTimer.unref?.();
}
export function stopAutopilotDriver(): void {
  if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
}

// ---------------------------------------------------------------------------
// Route 38 — status (pure read + gates)
// ---------------------------------------------------------------------------

export interface AutopilotStatus {
  autopilot: 0 | 1;
  config: AutopilotConfig | null;
  next_action: AutopilotNextAction | null;
  wait_reason: string | null;
  last_cue_at: string | null;
  last_cue: { action: AutopilotActionKind; node_id: number; correlation: string } | null;
  blocked_by: HoldReason | null;
  working: number;
  parked: number;
  attempts_used: number;
}

export async function getAutopilotStatus(goalId: number): Promise<AutopilotStatus> {
  const goal = getRawGoal(goalId);
  if (!goal) throw new GoalError(404, 'goal_not_found', 'goal not found');
  const tree = getGoalTree(goalId);
  const nodes = tree?.nodes ?? [];
  const working = nodes.filter((n) => n.state === 'working').length;
  const parked = nodes.filter((n) => n.state === 'parked').length;
  const attemptsUsed = nodes.reduce((acc, n) => acc + (n.autopilot_attempts ?? 0), 0);
  const lastCueRow = sqliteDb.prepare(`SELECT data, created_at FROM goal_events WHERE goal_id = ? AND kind = 'autopilot_cue' ORDER BY id DESC LIMIT 1`)
    .get(goalId) as { data: string | null; created_at: string } | undefined;
  let lastCue: AutopilotStatus['last_cue'] = null;
  if (lastCueRow?.data) {
    try {
      const d = JSON.parse(lastCueRow.data) as { action?: AutopilotActionKind; node_id?: number; correlation?: string };
      if (d.action && d.correlation) lastCue = { action: d.action, node_id: Number(d.node_id ?? 0), correlation: d.correlation };
    } catch { /* ignore */ }
  }
  const base: AutopilotStatus = {
    autopilot: goal.autopilot,
    config: goal.autopilot_config ?? null,
    next_action: null,
    wait_reason: null,
    last_cue_at: lastCueRow ? `${lastCueRow.created_at.replace(' ', 'T')}Z` : null,
    last_cue: lastCue,
    blocked_by: null,
    working,
    parked,
    attempts_used: attemptsUsed,
  };
  if (goal.autopilot !== 1) return base;
  const d = computeNextAction(nodes, cfgOf(goal));
  base.next_action = d.action ? { action: d.action, node_id: d.node_id, reason: d.reason } : null;
  base.wait_reason = d.action ? null : d.reason;
  const hold = syncHoldReason(false);
  if (hold) base.blocked_by = hold;
  else if (await chatBusy(goalId, cueTargetForNode(goalId, d.node_id))) base.blocked_by = 'chat_busy';
  return base;
}

// ---------------------------------------------------------------------------
// §15.8 — the night report (deterministic markdown, zero model calls)
// ---------------------------------------------------------------------------

const CT = 'America/Chicago';
function ctDate(d: Date): string {
  // YYYY-MM-DD in Central time
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: CT, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function ctTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') || iso.endsWith('Z') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', { timeZone: CT, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}
function ctStamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') || iso.endsWith('Z') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${new Intl.DateTimeFormat('en-US', { timeZone: CT, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)} CT`;
}
function sqliteToMs(v: string | null | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v.includes('T') ? v : `${v.replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : null;
}
function fmtDuration(ms: number | null): string {
  if (ms == null || ms < 0) return '—';
  const m = Math.round(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

interface EventRow { id: number; node_id: number | null; actor: string; kind: string; text: string | null; data: string | null; created_at: string }
function eventData(e: EventRow): Record<string, unknown> {
  if (!e.data) return {};
  try { return JSON.parse(e.data) as Record<string, unknown>; } catch { return {}; }
}

/** id of the `autopilot_on` event that started the run on/before `date` (CT), or the latest. */
function runStartEventId(goalId: number, date: string | null): number | null {
  const rows = sqliteDb.prepare(`SELECT id, created_at, data FROM goal_events WHERE goal_id = ? AND kind = 'autopilot_on' ORDER BY id ASC`)
    .all(goalId) as Array<{ id: number; created_at: string; data: string | null }>;
  // a re-on (config update) does not start a new run
  const starts = rows.filter((r) => { try { return !(JSON.parse(r.data ?? '{}') as { re_on?: boolean }).re_on; } catch { return true; } });
  if (!starts.length) return null;
  if (!date) return starts[starts.length - 1].id;
  const onOrBefore = starts.filter((r) => ctDate(new Date(sqliteToMs(r.created_at) ?? 0)) <= date);
  return (onOrBefore.length ? onOrBefore[onOrBefore.length - 1] : starts[0]).id;
}

function stateMarker(n: GoalNodeRow, cfg: AutopilotConfig): string {
  let m: string;
  if (n.state === 'ghost') m = 'ghost';
  else if (n.state === 'set') m = n.leaf_kind === 'human' ? 'human' : n.leaf_kind === 'machine' ? 'machine' : 'set';
  else if (n.state === 'working') m = `working 🌳 ${n.tree_id ?? '?'}${n.tree_status_cache === 'blocked' ? ' ⚠blocked' : ''}`;
  else if (n.state === 'done') m = 'done ✓';
  else m = n.state;
  if (n.review_state === 'awaiting_jarvis' && n.last_edited_by === 'kevin') m += n.kevin_moved_at ? ' ↕K' : ' ✎K';
  let out = `[${m}]`;
  if (n.autopilot_set === 1) out += ' 🌙';
  if (n.autopilot_verdict) out += n.autopilot_verdict.verdict === 'PASS' ? ' `PASS`' : ` \`FAIL ${n.autopilot_attempts}/${cfg.max_attempts}\``;
  return out;
}

export function buildNightReport(goalId: number, date?: string | null): { markdown: string; path: string; written: boolean } {
  const goal = getRawGoal(goalId);
  if (!goal) throw new GoalError(404, 'goal_not_found', 'goal not found');
  const startId = runStartEventId(goalId, date ?? null);
  if (startId == null) throw new GoalError(404, 'no_autopilot_run', 'this goal has never been on autopilot');
  const cfg = cfgOf(goal);
  const events = sqliteDb.prepare(`SELECT id, node_id, actor, kind, text, data, created_at FROM goal_events WHERE goal_id = ? AND id >= ? ORDER BY id ASC`)
    .all(goalId, startId) as EventRow[];
  const startEv = events[0];
  const tree = getGoalTree(goalId, true);
  const nodes = tree?.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const live = nodes.filter((n) => n.state !== 'discarded');

  const startedAt = cfg.started_at ?? `${startEv.created_at.replace(' ', 'T')}Z`;
  const stoppedAt = goal.autopilot === 1 ? null : cfg.stopped_at;
  const reportDate = date ?? ctDate(new Date(sqliteToMs(startEv.created_at) ?? nowMs()));

  const out: string[] = [];
  out.push(`# 🌙 Autopilot night report — goal #${goalId} "${goal.title}"`);
  out.push(`${ctStamp(startedAt)} → ${stoppedAt ? ctStamp(stoppedAt) : 'still running'} · stop: ${cfg.stop_reason ?? '—'} · config: build ${cfg.build_model} · verify ${cfg.verify_model} · depth ≤${cfg.max_depth} · parallel ${cfg.parallel} · attempts ≤${cfg.max_attempts}`);
  out.push('');

  // Plan
  out.push('## Plan (the tree as JARVIS shaped it)');
  if (!live.length) out.push('_none_');
  for (const n of live) {
    const parked = n.state === 'parked' && n.parked_reason ? ` — parked: ${n.parked_reason}` : '';
    out.push(`${'  '.repeat(n.depth)}- ${stateMarker(n, cfg)} #${n.id} ${n.title} — done: ${n.done_means ?? '(no done_means yet)'}${parked}`);
  }
  out.push('');

  // What ran
  out.push('## What ran');
  const dispatches = events.filter((e) => e.kind === 'autopilot_dispatched');
  const verdicts = events.filter((e) => e.kind === 'autopilot_verdict');
  if (!dispatches.length) out.push('_none_');
  else {
    out.push('| # | node | attempt | tree | verdict | wall time | workers | evidence (first line) |');
    out.push('|---|---|---|---|---|---|---|---|');
    const failBlocks: string[] = [];
    dispatches.forEach((e, i) => {
      const d = eventData(e);
      const treeId = String(d.tree_id ?? '');
      const node = e.node_id != null ? byId.get(e.node_id) : undefined;
      const v = verdicts.find((ve) => eventData(ve).tree_id === treeId);
      const vd = v ? eventData(v) : null;
      const verdict = vd ? String(vd.verdict) : (node?.state === 'working' && node.tree_id === treeId ? '— (still working)' : '—');
      const tree = treeId ? getHopperTree(treeId) : null;
      const wall = tree ? fmtDuration((sqliteToMs(tree.updated_at) ?? 0) - (sqliteToMs(tree.created_at) ?? 0)) : '—';
      const workers = treeId
        ? (sqliteDb.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS d, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS f FROM spawn_tasks WHERE hopper_tree_id = ?`).get(treeId) as { n: number; d: number | null; f: number | null })
        : null;
      const workersTxt = workers ? `${workers.n} (${workers.d ?? 0} done / ${workers.f ?? 0} failed)` : '—';
      const evidence = vd ? String(vd.evidence ?? '').split('\n')[0] : '';
      out.push(`| ${i + 1} | #${e.node_id ?? '?'} ${node?.title ?? ''} | ${d.attempt ?? '?'}/${cfg.max_attempts} | ${treeId} | ${verdict} | ${wall} | ${workersTxt} | ${evidence.replace(/\|/g, '\\|')} |`);
      if (vd && vd.verdict === 'FAIL') {
        const gaps = Array.isArray(vd.gaps) ? (vd.gaps as string[]) : [];
        failBlocks.push(`**#${e.node_id} ${node?.title ?? ''} — ${treeId} gaps**\n${gaps.map((g) => `- ${g}`).join('\n') || '- (none recorded)'}`);
      }
    });
    if (failBlocks.length) { out.push(''); out.push(...failBlocks.flatMap((b) => [b, ''])); }
  }
  out.push('');

  // Waiting on you
  out.push("## What's waiting on you");
  const waiting: string[] = [];
  for (const n of live) {
    if (n.state === 'set' && n.leaf_kind === 'human') waiting.push(`- human leaf #${n.id} ${n.title} — ${n.done_means ?? ''}`);
  }
  for (const n of live) {
    if (n.state === 'parked') waiting.push(`- parked #${n.id} ${n.title} — ${n.parked_reason ?? '(no reason)'}, attempts ${n.autopilot_attempts}`);
  }
  for (const n of live) {
    if (n.review_state === 'awaiting_jarvis') waiting.push(`- Kevin edit awaiting weigh-in #${n.id} ${n.title}`);
    if (n.review_state === 'pushed_back') waiting.push(`- JARVIS pushed back #${n.id} ${n.title} — ${n.review_note ?? ''}`);
  }
  for (const n of live) {
    if (n.state === 'check' && !parsePlan(n)?.verify_hopper_node_id) waiting.push(`- check without a machine verdict #${n.id} ${n.title}`);
  }
  const startMs = sqliteToMs(startEv.created_at) ?? 0;
  for (const n of live) {
    if (n.state === 'ghost' && (sqliteToMs(n.created_at) ?? 0) < startMs) waiting.push(`- ghost left alone (pre-dates the run, ${n.review_state}) #${n.id} ${n.title}`);
  }
  out.push(...(waiting.length ? waiting : ['_none_']));
  out.push('');

  // Where it stopped
  out.push('## Where it stopped and why');
  const lastCue = [...events].reverse().find((e) => e.kind === 'autopilot_cue');
  const offEv = [...events].reverse().find((e) => e.kind === 'autopilot_off');
  out.push(`- stop_reason: ${cfg.stop_reason ?? (goal.autopilot === 1 ? 'still running' : '—')}`);
  if (lastCue) out.push(`- last cue (${ctTime(lastCue.created_at)} CT): ${lastCue.text ?? ''}`);
  if (offEv) out.push(`- ${ctTime(offEv.created_at)} CT: ${offEv.text ?? 'autopilot off'}`);
  const holds = (states.get(goalId)?.holdLog ?? []).filter((h) => ((h.to ?? nowMs()) - h.from) >= 10 * 60_000);
  for (const h of holds) out.push(`- held ${fmtDuration((h.to ?? nowMs()) - h.from)} — ${h.reason}`);
  if (!lastCue && !offEv && !holds.length) out.push('_none_');
  out.push('');

  // Orchestrator's own read
  out.push("## The orchestrator's own read");
  const logs = events.filter((e) => e.kind === 'log' && e.actor === 'jarvis');
  out.push(...(logs.length ? logs.map((e) => `${ctTime(e.created_at)} CT — ${e.text ?? ''}`) : ['_none_']));
  out.push('');

  // Event trail
  out.push('## Event trail');
  const trail = events.filter((e) => e.kind.startsWith('autopilot_') || e.kind === 'node_verified' || e.kind === 'node_parked' || e.kind.startsWith('tree_'));
  out.push('<details><summary>every autopilot / verify / park / tree event</summary>');
  out.push('');
  out.push(...(trail.length ? trail.map((e) => `- ${ctTime(e.created_at)} · ${e.actor} · ${e.kind} · ${e.node_id != null ? `#${e.node_id}` : '—'} · ${(e.text ?? '').split('\n')[0]}`) : ['_none_']));
  out.push('');
  out.push('</details>');
  out.push('');

  const markdown = out.join('\n');
  const rel = path.join('outbox', 'goals', `autopilot-${goalId}-${reportDate}.md`);
  const abs = path.join(VAULT_ROOT, rel);
  let written = false;
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, markdown, 'utf8');
    written = true;
  } catch (err) {
    console.error(`[autopilot] goal #${goalId} report write failed: ${abs}`, err);
  }
  if (written) {
    const already = sqliteDb.prepare(`SELECT 1 FROM goal_events WHERE goal_id = ? AND kind = 'autopilot_report' AND id >= ? AND data LIKE ? LIMIT 1`)
      .get(goalId, startId, `%${rel}%`);
    if (!already) {
      insertEvent(goalId, null, 'system', 'autopilot_report', `Night report written → ${rel}`, { path: rel });
      emitGoal('updated', goalId);
    }
  }
  return { markdown, path: rel, written };
}

// ---------------------------------------------------------------------------
// Module load: register the seams + the tree-status kick + start the loop.
// ---------------------------------------------------------------------------

registerAutopilotHooks({
  preview: nextAction,
  kick,
  hold: () => syncHoldReason(false),
});
registerTreeStatusListener(autopilotOnTreeStatus);
if (process.env.GOALS_AUTOPILOT_DRIVER !== '0') {
  startAutopilotDriver();
}

export { AUTOPILOT_DEFAULTS };
