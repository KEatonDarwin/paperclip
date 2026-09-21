#!/usr/bin/env node
// BIG BOARD v2 FIXTURE CHECK — unit-style test of buildBigBoardSnapshot()
// (the pure aggregator, not the live-DB gatherBigBoardSnapshot()) against
// hand-built fixture rows. Complements scripts/big-board-check.mjs (which
// exercises the real jarvis.db end-to-end but can't deterministically hit
// every density/sort/waiting_on branch — live data may have 0 or 1 active
// trees, never proving the 3+ "compact" branch, for example).
//
// Asserts, per node #532's spec:
//   - trees.density: none / expanded (<=2 active trees) / compact (>=3)
//   - trees.active sort: running-first, then most-recently-updated
//   - trees.active[].nodes: ordered by id, each node has the right shape
//   - radar.waiting_on: running -> jarvis; last turn user -> jarvis;
//     last turn assistant -> kevin; no turns -> null
//   - radar window: threads outside radarHours are excluded, cap RADAR_CAP(8)
//   - landed cap tightened to 6 (was 8 in v1)
//
//   npm run build && npm run big-board:v2-fixture-check

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');
const { buildBigBoardSnapshot } = await import(path.join(distDir, 'big-board.js'));

let failed = false;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

const NOW = new Date('2026-09-21T20:00:00.000Z');
const iso = (offsetMinutes) => new Date(NOW.getTime() + offsetMinutes * 60_000).toISOString();

const GOVERNOR_VERDICT = { allow: true, reason: 'ok', detail: '' };
const GOVERNOR_PROVIDERS = {
  claude: GOVERNOR_VERDICT,
  codex: GOVERNOR_VERDICT,
  auggie: GOVERNOR_VERDICT,
  devin: GOVERNOR_VERDICT,
};
const PROVIDERS = { claude: null, claude_accounts: [], openai_codex: null, augment: null };

function tree(id, status, updatedAt) {
  return { id, topic: `Topic for ${id}`, origin_thread_ext: null, status, created_at: iso(-100), updated_at: updatedAt };
}

function node(id, treeId, status, updatedAt, opts = {}) {
  return {
    id,
    tree_id: treeId,
    parent_id: null,
    title: `Node ${id}`,
    spec: null,
    status,
    depends_on: opts.depends_on ? JSON.stringify(opts.depends_on) : null,
    priority: 0,
    attempts: 0,
    question: null,
    answer: null,
    result: null,
    worker_thread_ext: null,
    lease_expires_at: null,
    adapter: opts.adapter ?? 'claude',
    model: opts.model ?? 'claude-sonnet-5',
    foundry_auto_retries: 0,
    created_at: iso(-100),
    updated_at: updatedAt,
  };
}

function conv(id, externalId, updatedAt) {
  return {
    id,
    external_id: externalId,
    slack_channel: null,
    claude_session_id: null,
    session_adapter: null,
    status: 'active',
    created_at: iso(-200),
    updated_at: updatedAt,
    continued_from_id: null,
    continued_to_id: null,
    thread_adapter: null,
    thread_model: null,
    title: `Thread ${id}`,
    title_is_user_set: 0,
    pinned: 0,
    pinned_at: null,
    group_id: null,
    is_group_chat: 0,
    headline: null,
    border_color: null,
    password_hash: null,
    session_account: null,
  };
}

function threadLite(c, running) {
  return {
    thread_id: c.external_id,
    title: c.title,
    headline: c.headline,
    adapter: 'claude',
    model: 'claude-sonnet-5',
    updated_at: c.updated_at,
    running,
    latest_summary: null,
  };
}

function baseInputs(overrides = {}) {
  return {
    now: NOW,
    monitorsOpen: [],
    sentinelHeartbeat: { ran_at: null, fresh: false, sentinels: [] },
    commitmentsAll: [],
    hopperTrees: [],
    hopperNodesByTree: new Map(),
    allConversations: [],
    goals: [],
    getGoalTreeFn: () => null,
    notificationsRecent: [],
    providers: PROVIDERS,
    governorDefault: GOVERNOR_VERDICT,
    governorProviders: GOVERNOR_PROVIDERS,
    resolveThreadLite: (c) => threadLite(c, false),
    spawnTasksAll: [],
    waitingOnByConversationId: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. density: none
// ---------------------------------------------------------------------------
{
  const snap = buildBigBoardSnapshot(baseInputs());
  check('density = none when 0 active trees', snap.trees.density === 'none');
  check('active is empty array when 0 active trees', snap.trees.active.length === 0);
}

// ---------------------------------------------------------------------------
// 2. density: expanded (1-2 active trees) + node ordering + sort (running-first)
// ---------------------------------------------------------------------------
{
  const treeA = tree('tree-a', 'active', iso(-10)); // older update, but has a running node
  const treeB = tree('tree-b', 'active', iso(-1)); // newest update, no running node
  const nodesA = [
    node(3, 'tree-a', 'done', iso(-50)),
    node(1, 'tree-a', 'running', iso(-5)),
    node(2, 'tree-a', 'pending', iso(-40), { depends_on: [1] }),
  ];
  const nodesB = [node(10, 'tree-b', 'done', iso(-2))];
  const inputs = baseInputs({
    hopperTrees: [treeA, treeB],
    hopperNodesByTree: new Map([
      ['tree-a', nodesA],
      ['tree-b', nodesB],
    ]),
  });
  const snap = buildBigBoardSnapshot(inputs);
  check('density = expanded for 2 active trees', snap.trees.density === 'expanded');
  check('active has 2 trees', snap.trees.active.length === 2);
  check('running tree (tree-a) sorts first despite older updated_at', snap.trees.active[0]?.id === 'tree-a');
  check('non-running tree (tree-b) sorts second', snap.trees.active[1]?.id === 'tree-b');
  const aNodes = snap.trees.active[0]?.nodes ?? [];
  check('tree-a nodes ordered by id (1,2,3)', aNodes.map((n) => n.id).join(',') === '1,2,3');
  check('node shape carries status/model/adapter/depends_on/updated_at',
    aNodes[1]?.status === 'pending' && aNodes[1]?.model === 'claude-sonnet-5' &&
    aNodes[1]?.adapter === 'claude' && Array.isArray(aNodes[1]?.depends_on) && aNodes[1].depends_on.join(',') === '1');
  check('tree-a counts.running reused from buildSpawnMonitorSnapshot (not re-derived)', snap.trees.active[0]?.counts?.running === 1);
  check('tree-a counts.total = 3', snap.trees.active[0]?.counts?.total === 3);
}

// ---------------------------------------------------------------------------
// 3. density: compact (3+ active trees) + updated_at tiebreak among non-running
// ---------------------------------------------------------------------------
{
  const trees = [
    tree('tree-x', 'active', iso(-30)),
    tree('tree-y', 'active', iso(-5)), // most recently updated, no running node
    tree('tree-z', 'active', iso(-60)),
    tree('tree-done', 'done', iso(-1)), // NOT active — must be excluded
  ];
  const byTree = new Map([
    ['tree-x', [node(20, 'tree-x', 'pending', iso(-30))]],
    ['tree-y', [node(21, 'tree-y', 'pending', iso(-5))]],
    ['tree-z', [node(22, 'tree-z', 'pending', iso(-60))]],
  ]);
  const inputs = baseInputs({ hopperTrees: trees, hopperNodesByTree: byTree });
  const snap = buildBigBoardSnapshot(inputs);
  check('density = compact for 3+ active trees', snap.trees.density === 'compact');
  check('active excludes the done tree', !snap.trees.active.some((t) => t.id === 'tree-done'));
  check('active has exactly 3 trees', snap.trees.active.length === 3);
  check(
    'no tree running -> sorted purely by updated_at desc (tree-y, tree-x, tree-z)',
    snap.trees.active.map((t) => t.id).join(',') === 'tree-y,tree-x,tree-z',
  );
}

// ---------------------------------------------------------------------------
// 4. radar: waiting_on derivation + window + cap
// ---------------------------------------------------------------------------
{
  const cRunning = conv(1, 'cockpit:running-thread', iso(-1));
  const cUserLast = conv(2, 'cockpit:user-last', iso(-2));
  const cAssistantLast = conv(3, 'cockpit:assistant-last', iso(-3));
  const cNoTurns = conv(4, 'cockpit:no-turns', iso(-4));
  const cOld = conv(5, 'cockpit:too-old', iso(-500)); // outside a 6h window

  const allConversations = [cRunning, cUserLast, cAssistantLast, cNoTurns, cOld];
  const waitingOnByConversationId = new Map([
    [2, 'jarvis'], // last turn was Kevin's -> jarvis owes a reply
    [3, 'kevin'], // last turn was JARVIS's -> kevin owes a reply
    // id 4 intentionally absent -> null
    // id 1 (running) intentionally absent -> overridden to 'jarvis' by running:true regardless
  ]);

  const inputs = baseInputs({
    allConversations,
    radarHours: 6,
    waitingOnByConversationId,
    resolveThreadLite: (c) => threadLite(c, c.id === 1),
  });
  const snap = buildBigBoardSnapshot(inputs);
  const byId = Object.fromEntries(snap.radar.map((r) => [r.thread_id, r]));

  check('radar excludes threads outside the window (too-old)', !('cockpit:too-old' in byId));
  check('radar includes running/user-last/assistant-last/no-turns',
    'cockpit:running-thread' in byId && 'cockpit:user-last' in byId &&
    'cockpit:assistant-last' in byId && 'cockpit:no-turns' in byId);
  check('running thread waiting_on = jarvis (overrides map)', byId['cockpit:running-thread']?.waiting_on === 'jarvis');
  check('last-turn-user thread waiting_on = jarvis', byId['cockpit:user-last']?.waiting_on === 'jarvis');
  check('last-turn-assistant thread waiting_on = kevin', byId['cockpit:assistant-last']?.waiting_on === 'kevin');
  check('no-turns thread waiting_on = null', byId['cockpit:no-turns']?.waiting_on === null);
}

// ---------------------------------------------------------------------------
// 5. radar cap (8)
// ---------------------------------------------------------------------------
{
  const many = Array.from({ length: 15 }, (_, i) => conv(100 + i, `cockpit:many-${i}`, iso(-(i + 1))));
  const inputs = baseInputs({ allConversations: many, radarHours: 6 });
  const snap = buildBigBoardSnapshot(inputs);
  check('radar capped at 8 even with 15 eligible recent threads', snap.radar.length === 8);
  check('radar keeps the 8 most-recently-updated (already-sorted input)', snap.radar[0]?.thread_id === 'cockpit:many-0');
}

// ---------------------------------------------------------------------------
// 6. landed cap tightened to 6 (was 8)
// ---------------------------------------------------------------------------
{
  const trees = Array.from({ length: 10 }, (_, i) => tree(`tree-done-${i}`, 'done', iso(-(i + 1))));
  const inputs = baseInputs({ hopperTrees: trees, landedHours: 48 });
  const snap = buildBigBoardSnapshot(inputs);
  check('landed capped at 6 (v2 tightened from 8)', snap.landed.length === 6);
}

// ---------------------------------------------------------------------------
// 7. commitments field kept for compatibility even though the widget is gone
// ---------------------------------------------------------------------------
{
  const inputs = baseInputs({
    commitmentsAll: [{
      id: 1, subject: 'x', thread_ext: null, check_type: null, check_ref: null, due_at: null,
      status: 'open', recovery_attempts: 0, last_checked: null, created_at: iso(-10), resolved_at: null, notes: null,
    }],
  });
  const snap = buildBigBoardSnapshot(inputs);
  check('commitments.open still populated (API compat; UI widget removed)', snap.commitments.open.length === 1);
}

console.log(
  `\n[big-board-v2-fixture-check] ${failed ? 'FAILED' : 'PASSED'} — trees/radar/landed v2 fixtures exercised`,
);
if (failed) process.exit(1);
