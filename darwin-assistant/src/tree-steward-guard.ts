/**
 * TREE STEWARD GUARD — the safety rail around auto-answering blocked_question nodes.
 *
 * WHAT THIS GUARDS: the Tree Steward can automatically answer a node that
 * finished `blocked_question` so a stuck tree gets unstuck without waiting on
 * Kevin. Left ungoverned that is dangerous in two ways — it could answer the
 * same tree forever, and it could answer its OWN answer in a loop. This module
 * is the gate every auto-answer must pass first.
 *
 * STORAGE: there is NO table and NO column for this feature. The only
 * persistence is ONE settings-KV key (STEWARD_STATE_KEY) holding the whole
 * per-tree counter map as JSON, plus the work-switch JSON that the `steward`
 * lane already lives in. Nothing here opens a database connection directly:
 * all reads/writes go through getSetting/setSetting from conversation-db.
 */

import { getSetting, setSetting } from './conversation-db.js';
import { laneStopped } from './work-switch.js';

/**
 * ONE key for the whole state — deliberately NOT a key per tree, which would
 * grow the settings table without bound. Shape:
 *   { trees: { [treeId]: { n: number, nodes: number[], at: string } } }
 * where `n` is how many auto-answers the steward has spent on that tree,
 * `nodes` is the list of nodeIds it has already answered there, and `at` is the
 * ISO timestamp of the most recent answer (used only to prune the map).
 */
export const STEWARD_STATE_KEY = 'steward_autoanswer_state';

/** A null treeId still gets a real bucket so an unscoped node is still capped. */
const NO_TREE_BUCKET = '(none)';

/** How many trees we keep in the single key before pruning the oldest. */
const MAX_TREES_TRACKED = 50;

interface TreeEntry {
  n: number;
  nodes: number[];
  at: string;
}
interface StewardState {
  trees: Record<string, TreeEntry>;
}

function emptyState(): StewardState {
  return { trees: {} };
}

/**
 * Read the state. FAIL OPEN on a corrupt/missing value (return empty state)
 * — a garbled counter must NOT permanently wedge the steward off; the worst
 * case of fail-open is a few extra answers, which the cap re-bounds as soon as
 * the key is rewritten. (laneStopped is the hard stop; this counter is not.)
 * Never throws.
 */
function readState(): StewardState {
  let raw: string | null;
  try {
    raw = getSetting(STEWARD_STATE_KEY);
  } catch {
    return emptyState();
  }
  if (!raw || !raw.trim()) return emptyState();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyState();
    const trees = (parsed as { trees?: unknown }).trees;
    if (!trees || typeof trees !== 'object') return emptyState();
    const out: StewardState = emptyState();
    for (const [tid, v] of Object.entries(trees as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue;
      const e = v as Partial<TreeEntry>;
      const n = typeof e.n === 'number' && Number.isFinite(e.n) ? e.n : 0;
      const nodes = Array.isArray(e.nodes)
        ? e.nodes.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
        : [];
      const at = typeof e.at === 'string' ? e.at : '';
      out.trees[tid] = { n, nodes, at };
    }
    return out;
  } catch {
    return emptyState();
  }
}

/** Persist the state. Never throws — a write failure just loses this tick's bump. */
function writeState(state: StewardState): void {
  try {
    setSetting(STEWARD_STATE_KEY, JSON.stringify(state));
  } catch {
    /* fail open: a lost bump means at most one extra future answer */
  }
}

function bucketKey(treeId: string | null): string {
  return treeId && treeId.trim() ? treeId : NO_TREE_BUCKET;
}

/**
 * The per-tree auto-answer cap. Reads `steward_max_per_tree` from settings,
 * defaults to 3, clamps to 1..20, and tolerates a non-numeric value by falling
 * back to the default. Never throws.
 */
export function stewardMaxPerTree(): number {
  const DEFAULT = 3;
  let raw: string | null;
  try {
    raw = getSetting('steward_max_per_tree');
  } catch {
    return DEFAULT;
  }
  if (raw == null || !raw.trim()) return DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > 20) return 20;
  return i;
}

export interface StewardGuardVerdict {
  allowed: boolean;
  reason: string;
  code: 'ok' | 'lane_off' | 'cap_reached' | 'already_answered';
  priorCount: number;
}

/**
 * The gate. Evaluated in this ORDER, which is load-bearing:
 *   1. lane_off          — the work switch wins over everything; it is Kevin's
 *                          stop, so it is checked first and nothing else matters.
 *   2. already_answered  — THE ANTI-LOOP RULE: a node the steward already
 *                          answered that comes back asking again must go to
 *                          Kevin, because the steward's own answer evidently did
 *                          not settle it; answering again is how it would answer
 *                          its own question forever.
 *   3. cap_reached       — this tree has had its budget of auto-answers.
 *   4. ok                — green light.
 */
export function stewardAllowed(treeId: string | null, nodeId: number): StewardGuardVerdict {
  if (laneStopped('steward')) {
    return {
      allowed: false,
      reason: 'the steward lane is switched off',
      code: 'lane_off',
      priorCount: 0,
    };
  }

  const key = bucketKey(treeId);
  const state = readState();
  const entry = state.trees[key];
  const priorCount = entry ? entry.n : 0;

  if (entry && entry.nodes.includes(nodeId)) {
    return {
      allowed: false,
      reason: `node ${nodeId} was already auto-answered in tree ${key} — sending to Kevin instead of looping`,
      code: 'already_answered',
      priorCount,
    };
  }

  const cap = stewardMaxPerTree();
  if (priorCount >= cap) {
    return {
      allowed: false,
      reason: `tree ${key} has reached the auto-answer cap (${priorCount}/${cap})`,
      code: 'cap_reached',
      priorCount,
    };
  }

  return {
    allowed: true,
    reason: `ok (${priorCount}/${cap} auto-answers used in tree ${key})`,
    code: 'ok',
    priorCount,
  };
}

/**
 * Record that the steward just auto-answered nodeId in treeId: bump `n`, append
 * nodeId without duplicates, stamp `at`, then PRUNE to the 50 most recently
 * stamped trees so the single key can never grow without bound. Never throws.
 */
export function recordStewardAnswer(treeId: string | null, nodeId: number): void {
  const key = bucketKey(treeId);
  const state = readState();
  const now = new Date().toISOString();
  const entry = state.trees[key] ?? { n: 0, nodes: [], at: now };
  entry.n += 1;
  if (!entry.nodes.includes(nodeId)) entry.nodes.push(nodeId);
  entry.at = now;
  state.trees[key] = entry;

  const ids = Object.keys(state.trees);
  if (ids.length > MAX_TREES_TRACKED) {
    const keep = ids
      .sort((a, b) => (state.trees[b]?.at ?? '').localeCompare(state.trees[a]?.at ?? ''))
      .slice(0, MAX_TREES_TRACKED);
    const pruned: StewardState = emptyState();
    for (const k of keep) {
      const e = state.trees[k];
      if (e) pruned.trees[k] = e;
    }
    writeState(pruned);
    return;
  }
  writeState(state);
}

/** DRY-RUN ONLY. Clears the single state key. Do not call in production paths. */
export function __resetStewardGuardStateForDryRun(): void {
  writeState(emptyState());
}
