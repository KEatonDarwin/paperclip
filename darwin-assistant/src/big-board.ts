// BIG BOARD — office-TV kiosk aggregate view (tree-fead1551, node #517).
// See docs/big-board/CONTRACT.md (binding) — this file implements Part 1
// (`GET /api/v1/big-board`'s payload) exactly. Zero new tables: every field is
// sourced from an existing store. `buildBigBoardSnapshot` is a pure function
// over injected rows (mirrors src/spawn-monitor.ts); `gatherBigBoardSnapshot`
// is the thin impure wrapper that fetches the live rows and calls it — the
// route in handlers/api-v1.ts only adds the `providers` block (its readers
// are private to that file) and calls `gatherBigBoardSnapshot`.

import { readFileSync } from 'node:fs';
import {
  getInFlightMessageId,
  resolveConversationRuntime,
} from './agent.js';
import { listAllConversations, type ConversationRow } from './conversation-db.js';
import { listCommitments, type CommitmentRow } from './commitments.js';
import { listGoals, getGoalTree, type GoalSummary, type GoalTree, type GoalNodeRow } from './goals.js';
import { governorStatus, governorStatusAll, type GovernorProvider, type GovernorVerdict } from './hopper-governor.js';
import { listAllHopperTrees, listTreeNodes, type HopperTreeRow, type HopperNodeRow } from './hopper-engine.js';
import { listMonitors, type MonitorRow } from './monitors.js';
import { listNotifications, type NotificationRow } from './notifications.js';
import { getLatestThreadSummary } from './thread-summaries.js';

// Settings-KV key for the kiosk auth token (CONTRACT Part 3). Lives here (not
// api-v1.ts) so both the bearerAuth check and any future settings UI import a
// single constant.
export const BIG_BOARD_KIOSK_TOKEN_SETTING = 'big_board_kiosk_token';

// The ONLY SSE event types the kiosk credential may receive on /events
// (CONTRACT Part 2's ticker list). Review fix (node #520): the kiosk token is
// a read-only credential for the BOARD, not a firehose — without this cap a
// ?kiosk= holder would also stream every `turn`/`stream_delta` (full assistant
// replies, incl. password-locked threads) in real time. Everything else on the
// /events FORWARD set stays admin-bearer-only.
export const BIG_BOARD_KIOSK_EVENT_TYPES: ReadonlySet<string> = new Set([
  'hopper_node', 'goal', 'goal_node', 'goal_focus', 'goal_guard', 'monitor', 'monitor_run',
  'notification', 'dispatch', 'dispatch_cue', 'workstream', 'conversation_updated', 'status',
]);

const SENTINEL_HEARTBEAT_FILE = '/tmp/jarvis-watchdog-heartbeat.json';
const SENTINEL_NAMES = ['foreman', 'dead_turn', 'commitments', 'services', 'hopper_stall'] as const;
const SENTINEL_FRESH_MS = 90_000; // watchdog timer fires every 60s
const DEFAULT_LANDED_HOURS = 48;
const LANDED_CAP = 8;
const RUNNING_THREAD_EXCLUDE_PATTERNS = [/^ephemeral:/, /^checkin:/, /^cockpit:hopper-node-/];

// ---------------------------------------------------------------------------
// Shapes (CONTRACT Part 1)
// ---------------------------------------------------------------------------

export interface BigBoardThreadLite {
  thread_id: string;
  title: string | null;
  headline: string | null;
  adapter: string;
  model: string | null;
  updated_at: string;
  running: boolean;
  latest_summary: string | null;
}

export interface BigBoardSentinel {
  name: string;
  ok: boolean;
}

export interface BigBoardHopperNode {
  tree_id: string;
  tree_topic: string;
  node_id: number;
  title: string;
  adapter: string | null;
  model: string | null;
  // Best-effort; no per-node account stamp is persisted (chosen dynamically at
  // spawn time — see docs/big-board/CONTRACT.md's zone map), so always null.
  claude_account: string | null;
  started_at: string;
  lease_expires_at: string | null;
}

export interface BigBoardLandedEntry {
  kind: 'tree' | 'commitment' | 'notification';
  text: string;
  at: string;
}

export interface BigBoardProviders {
  claude: unknown;
  claude_accounts: unknown;
  openai_codex: unknown;
  augment: unknown;
}

export interface BigBoardSnapshot {
  generated_at: string;
  monitors: { open: MonitorRow[]; summary: { active: number; failing: number } };
  sentinels: { ran_at: string | null; fresh: boolean; sentinels: BigBoardSentinel[] };
  commitments: { open: CommitmentRow[] };
  in_motion: { hopper_nodes: BigBoardHopperNode[]; threads: BigBoardThreadLite[] };
  goal_spotlight: { goal: GoalSummary | null; focus_node_id: number | null; nodes: GoalNodeRow[] };
  radar: BigBoardThreadLite[];
  landed: BigBoardLandedEntry[];
  providers: BigBoardProviders;
  governor: GovernorVerdict & { providers: Record<GovernorProvider, GovernorVerdict> };
}

// ---------------------------------------------------------------------------
// Pure aggregation — inputs are already-fetched/derived rows, no I/O here.
// ---------------------------------------------------------------------------

export interface BigBoardInputs {
  now: Date;
  monitorsOpen: MonitorRow[];
  sentinelHeartbeat: { ran_at: string | null; fresh: boolean; sentinels: BigBoardSentinel[] };
  commitmentsAll: CommitmentRow[]; // unfiltered by status — this fn slices open/breached + done
  hopperTrees: HopperTreeRow[]; // every tree (listAllHopperTrees())
  hopperNodesByTree: Map<string, HopperNodeRow[]>; // tree.id -> its nodes (listTreeNodes)
  allConversations: ConversationRow[]; // listAllConversations() — already updated_at DESC
  goals: GoalSummary[]; // listGoals() — active (not done/archived), each carrying last_event_at
  getGoalTreeFn: (goalId: number) => GoalTree | null; // injected so the pure fn stays DB-agnostic
  notificationsRecent: NotificationRow[];
  providers: BigBoardProviders;
  governorDefault: GovernorVerdict;
  governorProviders: Record<GovernorProvider, GovernorVerdict>;
  landedHours?: number;
  resolveThreadLite: (conv: ConversationRow) => BigBoardThreadLite; // impure resolution injected in
}

function bySortOrder(a: { sort_order: number }, b: { sort_order: number }): number {
  return a.sort_order - b.sort_order;
}

/** Siblings of the focused node (incl. the focus node itself), with the focus
 *  node's own children inlined immediately after it — the exact slice the
 *  /goals UI's zoom renders, per CONTRACT's zone map. Focus null = the goal's
 *  top-level nodes. */
function selectSpotlightNodes(tree: GoalTree): GoalNodeRow[] {
  const focusId = tree.focus.node_id;
  const focusNode = focusId != null ? tree.nodes.find((n) => n.id === focusId) ?? null : null;
  const parentIdOfFocus = focusId != null && focusNode ? focusNode.parent_id : null;
  const siblings = tree.nodes.filter((n) => n.parent_id === parentIdOfFocus).sort(bySortOrder);
  const out: GoalNodeRow[] = [];
  for (const sib of siblings) {
    out.push(sib);
    if (focusId != null && sib.id === focusId) {
      const children = tree.nodes.filter((n) => n.parent_id === sib.id).sort(bySortOrder);
      out.push(...children);
    }
  }
  return out;
}

/** Threads the board never shows (review fix, node #520): worker/ephemeral
 *  prefixes (as GET /threads), PLUS password-locked threads — a TV in the
 *  office must never display a title/summary Kevin explicitly locked — PLUS
 *  archived ones (the radar is "what's alive," not the archive). */
function isExcludedThread(conv: ConversationRow): boolean {
  if (conv.password_hash) return true;
  if (conv.status === 'archived') return true;
  return RUNNING_THREAD_EXCLUDE_PATTERNS.some((re) => re.test(conv.external_id));
}

export function buildBigBoardSnapshot(input: BigBoardInputs): BigBoardSnapshot {
  const now = input.now;
  const landedHours = input.landedHours ?? DEFAULT_LANDED_HOURS;
  const cutoffMs = now.getTime() - landedHours * 60 * 60 * 1000;

  // -- monitors ---------------------------------------------------------------
  const monitors = {
    open: input.monitorsOpen,
    summary: {
      active: input.monitorsOpen.filter((m) => m.status === 'active').length,
      failing: input.monitorsOpen.filter((m) => m.last_outcome === 'fail').length,
    },
  };

  // -- commitments --------------------------------------------------------
  const commitments = {
    open: input.commitmentsAll.filter((c) => c.status === 'open' || c.status === 'breached'),
  };

  // -- in motion: hopper nodes ----------------------------------------------
  const hopperNodes: BigBoardHopperNode[] = [];
  for (const tree of input.hopperTrees) {
    const nodes = input.hopperNodesByTree.get(tree.id) ?? [];
    for (const n of nodes) {
      if (n.status !== 'running') continue;
      hopperNodes.push({
        tree_id: tree.id,
        tree_topic: tree.topic,
        node_id: n.id,
        title: n.title,
        adapter: n.adapter,
        model: n.model,
        claude_account: null,
        started_at: n.updated_at,
        lease_expires_at: n.lease_expires_at,
      });
    }
  }

  // -- in motion: cockpit/slack threads + conversation radar -----------------
  const eligibleThreads = input.allConversations.filter((c) => !isExcludedThread(c));
  const threadLites = eligibleThreads.map((c) => input.resolveThreadLite(c));
  const runningThreads = threadLites.filter((t) => t.running);
  const radar = threadLites; // already updated_at DESC (pinned-first) from listAllConversations()

  // -- goal spotlight: auto-zoom to the goal touched most recently -----------
  const spotlightGoal = [...input.goals].sort((a, b) => {
    const at = a.last_event_at ?? '';
    const bt = b.last_event_at ?? '';
    return bt.localeCompare(at);
  })[0] ?? null;
  const spotlightTree = spotlightGoal ? input.getGoalTreeFn(spotlightGoal.id) : null;
  const goalSpotlight = {
    goal: spotlightGoal,
    focus_node_id: spotlightTree?.focus.node_id ?? null,
    nodes: spotlightTree ? selectSpotlightNodes(spotlightTree) : [],
  };

  // -- landed: last N hours, newest first, capped ----------------------------
  const landed: BigBoardLandedEntry[] = [];
  for (const t of input.hopperTrees) {
    if (t.status !== 'done') continue;
    if (new Date(t.updated_at.includes('T') ? t.updated_at : `${t.updated_at.replace(' ', 'T')}Z`).getTime() < cutoffMs) continue;
    landed.push({ kind: 'tree', text: t.topic, at: t.updated_at });
  }
  for (const c of input.commitmentsAll) {
    if (c.status !== 'done' || !c.resolved_at) continue;
    if (new Date(c.resolved_at.includes('T') ? c.resolved_at : `${c.resolved_at.replace(' ', 'T')}Z`).getTime() < cutoffMs) continue;
    landed.push({ kind: 'commitment', text: c.subject, at: c.resolved_at });
  }
  for (const n of input.notificationsRecent) {
    if (n.severity !== 'success') continue;
    if (new Date(n.created_at.includes('T') ? n.created_at : `${n.created_at.replace(' ', 'T')}Z`).getTime() < cutoffMs) continue;
    landed.push({ kind: 'notification', text: n.title, at: n.created_at });
  }
  landed.sort((a, b) => b.at.localeCompare(a.at));

  return {
    generated_at: now.toISOString(),
    monitors,
    sentinels: input.sentinelHeartbeat,
    commitments,
    in_motion: { hopper_nodes: hopperNodes, threads: runningThreads },
    goal_spotlight: goalSpotlight,
    radar,
    landed: landed.slice(0, LANDED_CAP),
    providers: input.providers,
    governor: { ...input.governorDefault, providers: input.governorProviders },
  };
}

// ---------------------------------------------------------------------------
// Live gathering — the only impure part. Route handlers call this.
// ---------------------------------------------------------------------------

interface WatchdogHeartbeatFile {
  ran_at?: string;
  errors?: string[];
  sentinels?: string[];
}

/** Reads /tmp/jarvis-watchdog-heartbeat.json directly — no HTTP route exposes
 *  it today (CONTRACT zone map). Never throws: a missing/unreadable/malformed
 *  file reads as "no sentinel data," not an error. */
function readSentinelHeartbeat(now: Date): { ran_at: string | null; fresh: boolean; sentinels: BigBoardSentinel[] } {
  try {
    const raw = readFileSync(SENTINEL_HEARTBEAT_FILE, 'utf8');
    const parsed = JSON.parse(raw) as WatchdogHeartbeatFile;
    const ranAt = typeof parsed.ran_at === 'string' ? parsed.ran_at : null;
    const errors = Array.isArray(parsed.errors) ? parsed.errors.filter((e): e is string => typeof e === 'string') : [];
    const names =
      Array.isArray(parsed.sentinels) && parsed.sentinels.length
        ? parsed.sentinels.filter((s): s is string => typeof s === 'string')
        : [...SENTINEL_NAMES];
    const fresh = ranAt != null && Number.isFinite(new Date(ranAt).getTime())
      ? now.getTime() - new Date(ranAt).getTime() < SENTINEL_FRESH_MS
      : false;
    return {
      ran_at: ranAt,
      fresh,
      sentinels: names.map((name) => ({
        name,
        ok: !errors.some((e) => e.startsWith(`${name}: `)),
      })),
    };
  } catch {
    // Missing/unreadable file = the watchdog itself is dead. Keep the fixed
    // sentinel grid on screen and paint every sentinel red rather than
    // collapsing the grid (an empty list read as "nothing to worry about").
    return { ran_at: null, fresh: false, sentinels: SENTINEL_NAMES.map((name) => ({ name, ok: false })) };
  }
}

function toThreadLite(conv: ConversationRow): BigBoardThreadLite {
  const { adapter, model } = resolveConversationRuntime(conv);
  const summary = getLatestThreadSummary(conv.id);
  return {
    thread_id: conv.external_id,
    title: conv.title ?? conv.headline ?? null,
    headline: conv.headline ?? null,
    adapter: adapter.id,
    model,
    updated_at: conv.updated_at,
    running: getInFlightMessageId(conv.id) != null,
    latest_summary: summary?.content ?? null,
  };
}

const EMPTY_PROVIDERS: BigBoardProviders = {
  claude: null,
  claude_accounts: [],
  openai_codex: null,
  augment: null,
};

/**
 * Gathers every live row the snapshot needs and calls buildBigBoardSnapshot.
 * `providers` is injected because its readers (readClaudeLiveUsage etc.) are
 * private to handlers/api-v1.ts — the route passes them in rather than this
 * module importing back into the route file (would create a cycle).
 */
export function gatherBigBoardSnapshot(opts: { landedHours?: number; providers?: BigBoardProviders } = {}): BigBoardSnapshot {
  const now = new Date();

  const trees = listAllHopperTrees();
  // Only non-terminal trees can carry a running node, so skip the per-tree
  // node query for done/archived trees (88 trees live → ~1 query instead of
  // 88 every refetch). The pure fn treats a missing entry as "no nodes."
  const hopperNodesByTree = new Map<string, HopperNodeRow[]>();
  for (const t of trees) {
    if (t.status === 'done' || t.status === 'archived') continue;
    hopperNodesByTree.set(t.id, listTreeNodes(t.id));
  }

  // notifications: fetch a generous window then let the pure fn cut by
  // landedHours — listNotifications has no severity filter param.
  const notificationsRecent = listNotifications(200);

  return buildBigBoardSnapshot({
    now,
    monitorsOpen: listMonitors('open'),
    sentinelHeartbeat: readSentinelHeartbeat(now),
    commitmentsAll: listCommitments({ limit: 200 }),
    hopperTrees: trees,
    hopperNodesByTree,
    allConversations: listAllConversations(),
    goals: listGoals(),
    getGoalTreeFn: (goalId: number) => getGoalTree(goalId),
    notificationsRecent,
    providers: opts.providers ?? EMPTY_PROVIDERS,
    governorDefault: governorStatus(),
    governorProviders: governorStatusAll(),
    landedHours: opts.landedHours,
    resolveThreadLite: toThreadLite,
  });
}
