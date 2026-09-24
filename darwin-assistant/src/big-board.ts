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
import { listAllConversations, getSetting, sqliteDb, type ConversationRow } from './conversation-db.js';
import { listCommitments, type CommitmentRow } from './commitments.js';
import { listGoals, getGoalTree, type GoalSummary, type GoalTree, type GoalNodeRow } from './goals.js';
import { governorStatus, governorStatusAll, type GovernorProvider, type GovernorVerdict } from './hopper-governor.js';
import { listAllHopperTrees, listTreeNodes, type HopperTreeRow, type HopperNodeRow, type HopperNodeStatus } from './hopper-engine.js';
import { listMonitors, type MonitorRow } from './monitors.js';
import { listNotifications, type NotificationRow } from './notifications.js';
import { getLatestThreadSummary } from './thread-summaries.js';
import { listAllSpawnTasks, type SpawnTaskRow } from './spawn-tasks.js';
import { buildSpawnMonitorSnapshot, type SpawnMonitorTreeSummary } from './spawn-monitor.js';

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
// v2 note: no `hopper_tree` SSE event type exists anywhere in this codebase —
// tree status flips (active->done, agree->active) go through `hopper_node`
// events on their constituent nodes plus a `notification` on tree completion
// (see hopper-engine.ts maybeFinishTree), never a dedicated tree-level SSE
// event. `hopper_node` is already in this set, so a node claim/finish inside
// any active tree already triggers the kiosk's debounced refetch — the spec's
// "refetch on hopper_node/hopper_tree events" requirement is met by the
// former; the latter doesn't exist to add (per CONTRACT: verify, don't invent).
export const BIG_BOARD_KIOSK_EVENT_TYPES: ReadonlySet<string> = new Set([
  'hopper_node', 'goal', 'goal_node', 'goal_focus', 'goal_guard', 'monitor', 'monitor_run',
  'notification', 'dispatch', 'dispatch_cue', 'workstream', 'conversation_updated', 'status',
  'night_run', 'night_item',
]);

const SENTINEL_HEARTBEAT_FILE = '/tmp/jarvis-watchdog-heartbeat.json';
const SENTINEL_NAMES = ['foreman', 'dead_turn', 'commitments', 'services', 'hopper_stall'] as const;
const SENTINEL_FRESH_MS = 90_000; // watchdog timer fires every 60s
const DEFAULT_LANDED_HOURS = 48;
// v2 (tree-e1c07f73, node #532): Commitments dropped as its own board widget
// (Kevin: "isn't useful right now") — Landed's display cap tightened from 8 to
// 6 to give the new Active Trees anchor + curated Radar more room.
const LANDED_CAP = 6;
// v2: Radar is now CURATED — only threads touched recently, small cap, each
// tagged with whose turn it is. Settings-KV `big_board_radar_hours` overrides
// the default window; `?radar_hours=` query param overrides both (debugging).
const DEFAULT_RADAR_HOURS = 6;
const RADAR_CAP = 8;
const RADAR_HOURS_SETTING = 'big_board_radar_hours';
// v2: node-list cap per active tree card (density='expanded' or 'compact') —
// a bound on payload size, not a UI truncation signal (a tree rarely has >40
// nodes; if it does, the card still renders the first 40 in id order).
const TREE_NODES_CAP = 40;
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

// v2 — 🌳 Active Trees (the new center-column anchor). One node row, ordered
// by id (creation order), per active tree — the same detail /spawn-tree's
// TreeCard shows on click, now surfaced directly on the board.
export interface BigBoardTreeNode {
  id: number;
  title: string;
  status: HopperNodeStatus;
  model: string | null;
  adapter: string | null;
  depends_on: number[];
  updated_at: string;
}

// Extends the exact per-tree summary /spawn-tree renders (counts, models,
// running_nodes, attention) — reused via buildSpawnMonitorSnapshot rather
// than re-derived, so the board and /spawn-tree can never drift on a count.
export interface BigBoardTree extends SpawnMonitorTreeSummary {
  nodes: BigBoardTreeNode[];
}

export type BigBoardTreeDensity = 'none' | 'expanded' | 'compact';

export interface BigBoardTreesBlock {
  active: BigBoardTree[];
  density: BigBoardTreeDensity;
}

// v2 — 📡 Radar, curated: a BigBoardThreadLite plus whose turn it is.
// running -> 'jarvis' (already in motion); else derived from the thread's
// last user/assistant turn (last turn is Kevin's -> jarvis owes a reply;
// last turn is JARVIS's -> Kevin owes a reply); no turns yet -> null.
export interface BigBoardRadarEntry extends BigBoardThreadLite {
  waiting_on: 'kevin' | 'jarvis' | null;
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
  // v2: kept for API compatibility (the field, not the widget) — the
  // dedicated "Commitments open" card was removed from the board UI per
  // Kevin's ask; commitments still surface inside Landed.
  commitments: { open: CommitmentRow[] };
  // v2: `in_motion.threads` is now the ONLY thing this zone shows — running
  // hopper nodes moved into `trees.active[].nodes`/`running_nodes` so a
  // running node is never double-counted between the two zones.
  // `in_motion.hopper_nodes` stays populated for compatibility.
  in_motion: { hopper_nodes: BigBoardHopperNode[]; threads: BigBoardThreadLite[] };
  goal_spotlight: { goal: GoalSummary | null; focus_node_id: number | null; nodes: GoalNodeRow[] };
  // v2: the new center-column anchor — see BigBoardTreesBlock.
  trees: BigBoardTreesBlock;
  radar: BigBoardRadarEntry[];
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
  // v2 inputs --------------------------------------------------------------
  spawnTasksAll: SpawnTaskRow[]; // listAllSpawnTasks() — feeds buildSpawnMonitorSnapshot's reuse
  radarHours?: number;
  // Precomputed per the whole eligible-thread candidate set in ONE query
  // (conversation_id -> who owes the next reply) — see gatherBigBoardSnapshot's
  // fetchWaitingOnMap. Never computed per-thread (would be N+1).
  waitingOnByConversationId: Map<number, 'kevin' | 'jarvis'>;
}

function bySortOrder(a: { sort_order: number }, b: { sort_order: number }): number {
  return a.sort_order - b.sort_order;
}

/** HopperNodeRow.depends_on is a JSON-array-string column (mirrors the private
 *  parseDependsOn in spawn-monitor.ts, unexported there — trivial field parse,
 *  not an aggregate to re-derive, so a local copy is fine here). */
function parseDependsOnJson(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is number => typeof x === 'number') : [];
  } catch {
    return [];
  }
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

  // -- in motion: cockpit/slack threads --------------------------------------
  const eligibleThreads = input.allConversations.filter((c) => !isExcludedThread(c));
  const threadLites = eligibleThreads.map((c) => input.resolveThreadLite(c));
  const runningThreads = threadLites.filter((t) => t.running);

  // -- radar (v2, curated): last radarHours, newest first, capped, tagged ----
  const radarHours = input.radarHours ?? DEFAULT_RADAR_HOURS;
  const radarCutoffMs = now.getTime() - radarHours * 60 * 60 * 1000;
  const radar: BigBoardRadarEntry[] = [];
  for (let i = 0; i < eligibleThreads.length && radar.length < RADAR_CAP; i++) {
    const conv = eligibleThreads[i];
    const lite = threadLites[i];
    const updatedMs = new Date(conv.updated_at.includes('T') ? conv.updated_at : `${conv.updated_at.replace(' ', 'T')}Z`).getTime();
    if (updatedMs < radarCutoffMs) continue;
    const waitingOn = lite.running ? 'jarvis' : input.waitingOnByConversationId.get(conv.id) ?? null;
    radar.push({ ...lite, waiting_on: waitingOn });
  }

  // -- active trees (v2): reuse buildSpawnMonitorSnapshot's per-tree summary
  // (counts/models/running_nodes/attention) so the board and /spawn-tree can
  // never disagree on a number — this file only adds the full node list.
  const allNodes = input.hopperTrees.flatMap((t) => input.hopperNodesByTree.get(t.id) ?? []);
  const monitorSnapshot = buildSpawnMonitorSnapshot({
    trees: input.hopperTrees,
    nodes: allNodes,
    spawnTasks: input.spawnTasksAll,
    governor: input.governorDefault,
  });
  const treeSummaryById = new Map<string, SpawnMonitorTreeSummary>();
  for (const cluster of monitorSnapshot.clusters) {
    for (const t of cluster.trees) treeSummaryById.set(t.id, t);
  }
  const activeTrees: BigBoardTree[] = [];
  for (const tree of input.hopperTrees) {
    if (tree.status !== 'active') continue;
    const summary = treeSummaryById.get(tree.id);
    if (!summary) continue; // shouldn't happen (active trees are never archived-excluded)
    const nodes = (input.hopperNodesByTree.get(tree.id) ?? [])
      .slice()
      .sort((a, b) => a.id - b.id)
      .slice(0, TREE_NODES_CAP)
      .map((n): BigBoardTreeNode => ({
        id: n.id,
        title: n.title,
        status: n.status,
        model: n.model,
        adapter: n.adapter,
        depends_on: parseDependsOnJson(n.depends_on),
        updated_at: n.updated_at,
      }));
    activeTrees.push({ ...summary, nodes });
  }
  activeTrees.sort((a, b) => {
    const aRunning = a.counts.running > 0 ? 1 : 0;
    const bRunning = b.counts.running > 0 ? 1 : 0;
    if (aRunning !== bRunning) return bRunning - aRunning; // running-first
    return b.updated_at.localeCompare(a.updated_at); // then most-recently-updated
  });
  const treesBlock: BigBoardTreesBlock = {
    active: activeTrees,
    density: activeTrees.length === 0 ? 'none' : activeTrees.length <= 2 ? 'expanded' : 'compact',
  };

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
    trees: treesBlock,
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
/**
 * conversation_id -> who owes the next reply, for a bounded candidate set,
 * in ONE query (a MAX(turn_index) self-join, not a per-conversation lookup).
 * `running` last turn = 'user' -> 'jarvis' owes a reply; last turn =
 * 'assistant' -> 'kevin' owes a reply. A conversation with no user/assistant
 * turn yet is simply absent from the returned map (caller treats it as null).
 */
function fetchWaitingOnMap(conversationIds: number[]): Map<number, 'kevin' | 'jarvis'> {
  const map = new Map<number, 'kevin' | 'jarvis'>();
  if (!conversationIds.length) return map;
  const placeholders = conversationIds.map(() => '?').join(',');
  const rows = sqliteDb
    .prepare<unknown[], { conversation_id: number; role: string }>(
      `SELECT t.conversation_id AS conversation_id, t.role AS role
       FROM turns t
       JOIN (
         SELECT conversation_id, MAX(turn_index) AS max_idx
         FROM turns
         WHERE role IN ('user', 'assistant') AND conversation_id IN (${placeholders})
         GROUP BY conversation_id
       ) last ON last.conversation_id = t.conversation_id AND last.max_idx = t.turn_index`,
    )
    .all(...conversationIds);
  for (const row of rows) {
    map.set(row.conversation_id, row.role === 'user' ? 'jarvis' : 'kevin');
  }
  return map;
}

function resolveRadarHours(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override;
  const kv = getSetting(RADAR_HOURS_SETTING);
  const parsed = kv != null ? parseFloat(kv) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RADAR_HOURS;
}

export function gatherBigBoardSnapshot(
  opts: { landedHours?: number; radarHours?: number; providers?: BigBoardProviders } = {},
): BigBoardSnapshot {
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

  const allConversations = listAllConversations();
  // Bound the waiting-on lookup to the (already updated_at DESC) most-recent
  // 150 eligible threads — comfortably covers anything an 8-cap/few-hour-
  // window radar could ever surface, without querying every conversation ever.
  const eligibleForWaitingOn = allConversations.filter((c) => !isExcludedThread(c)).slice(0, 150);
  const waitingOnByConversationId = fetchWaitingOnMap(eligibleForWaitingOn.map((c) => c.id));

  return buildBigBoardSnapshot({
    now,
    monitorsOpen: listMonitors('open'),
    sentinelHeartbeat: readSentinelHeartbeat(now),
    commitmentsAll: listCommitments({ limit: 200 }),
    hopperTrees: trees,
    hopperNodesByTree,
    allConversations,
    goals: listGoals(),
    getGoalTreeFn: (goalId: number) => getGoalTree(goalId),
    notificationsRecent,
    providers: opts.providers ?? EMPTY_PROVIDERS,
    governorDefault: governorStatus(),
    governorProviders: governorStatusAll(),
    landedHours: opts.landedHours,
    radarHours: resolveRadarHours(opts.radarHours),
    resolveThreadLite: toThreadLite,
    spawnTasksAll: listAllSpawnTasks(),
    waitingOnByConversationId,
  });
}
