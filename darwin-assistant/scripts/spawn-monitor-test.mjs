#!/usr/bin/env node
// SPAWN-MONITOR AGGREGATOR TESTS — pure-function unit tests for src/spawn-monitor.ts
// against plain fixture arrays (no live data, no model calls). Permanent regression
// script: `npm run spawn-monitor:test`.
//
//   JARVIS_DB_PATH=/tmp/spawn-monitor-test.db node scripts/spawn-monitor-test.mjs
//
// (run `npm run build` first — this drives the compiled dist/, not tsx. Importing
// dist/spawn-monitor.js pulls in conversation-db.js, which opens a sqlite handle at
// import time, so the JARVIS_DB_PATH scratch guard below is required even though
// every assertion here runs against plain fixture arrays.)

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function guardDbPath() {
  const raw = process.env.JARVIS_DB_PATH;
  if (!raw || !raw.trim()) {
    console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path before running this script.');
    process.exit(1);
  }
  const resolved = path.resolve(raw);
  const live = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
  if (resolved === live) {
    console.error(`FATAL: refusing to run against the live jarvis.db (${live}). Use a /tmp scratch path.`);
    process.exit(1);
  }
  return resolved;
}

const DB_PATH = guardDbPath();
fs.rmSync(DB_PATH, { force: true });
console.log(`[spawn-monitor-test] scratch DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const spawnMonitor = await import(path.join(distDir, 'spawn-monitor.js'));
const { buildSpawnMonitorSnapshot, buildSpawnMonitorTreeDetail, matchSpawnTasksToNodes } = spawnMonitor;

// ---------------------------------------------------------------------------
// Result harness (mirrors scripts/foundry-sim.mjs)
// ---------------------------------------------------------------------------
const results = [];
function check(id, description, fn) {
  try {
    fn();
    results.push({ id, description, pass: true });
  } catch (err) {
    results.push({ id, description, pass: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------
function tree(id, topic, status, updatedAt) {
  return { id, topic, origin_thread_ext: null, status, created_at: updatedAt, updated_at: updatedAt };
}
function node(overrides) {
  return {
    id: 0, tree_id: '', parent_id: null, title: '', spec: null, status: 'pending',
    depends_on: null, priority: 0, attempts: 0, question: null, answer: null, result: null,
    worker_thread_ext: null, lease_expires_at: null, adapter: null, model: null,
    created_at: '2026-09-12 00:00:00', updated_at: '2026-09-12 00:00:00',
    ...overrides,
  };
}
function spawnTask(overrides) {
  return {
    id: 0, thread_ext: '', conversation_id: null, parent_thread_ext: null, parent_conversation_id: null,
    group_id: null, label: null, task_prompt: null, model: null, status: 'running', pid: null,
    result: null, error: null, message_id: null, turn_count: 0, last_seen_running: 0,
    created_at: '2026-09-12 00:00:00', updated_at: '2026-09-12 00:00:00', last_heartbeat: null,
    hopper_tree_id: null, hopper_node_id: null,
    ...overrides,
  };
}

// =============================================================================
// 1) Foundry clustering — `foundry:<project>/<module>` trees group by project;
//    everything else is a `single` cluster keyed by tree id.
// =============================================================================
check('foundry-cluster-1', 'foundry:proj-a/* trees cluster together, kind=foundry, title=project', () => {
  const trees = [
    tree('tree-a1', 'foundry:proj-a/module-1', 'active', '2026-09-12 01:00:00'),
    tree('tree-a2', 'foundry:proj-a/module-2', 'done', '2026-09-12 00:30:00'),
    tree('tree-b1', 'foundry:proj-b/module-1', 'done', '2026-09-12 00:00:00'),
    tree('tree-solo', 'manual project', 'done', '2026-09-11 23:00:00'),
  ];
  const snap = buildSpawnMonitorSnapshot({ trees, nodes: [], spawnTasks: [], governor: { mock: true } });
  assert.equal(snap.clusters.length, 3, 'expected 3 clusters (proj-a, proj-b, solo)');
  const projA = snap.clusters.find((c) => c.key === 'foundry:proj-a');
  assert.ok(projA, 'foundry:proj-a cluster missing');
  assert.equal(projA.kind, 'foundry');
  assert.equal(projA.title, 'proj-a');
  assert.equal(projA.trees.length, 2);
  const projB = snap.clusters.find((c) => c.key === 'foundry:proj-b');
  assert.ok(projB && projB.trees.length === 1);
  const solo = snap.clusters.find((c) => c.key === 'tree-solo');
  assert.ok(solo && solo.kind === 'single' && solo.title === 'manual project');
  assert.equal(snap.governor.mock, true, 'governor payload should pass through verbatim');
});

// =============================================================================
// 2) Attention ordering — attention < active < draft < done, regardless of
//    recency, and totals scope correctly.
// =============================================================================
check('attention-ordering', 'clusters order attention-first, then active/draft/done', () => {
  const trees = [
    tree('t-done', 'no attention (done)', 'done', '2026-09-12 05:00:00'),
    tree('t-active-attn', 'active with blocked node', 'active', '2026-09-12 01:00:00'),
    tree('t-active-plain', 'active no attention', 'active', '2026-09-12 02:00:00'),
    tree('t-draft', 'draft tree', 'draft', '2026-09-12 03:00:00'),
  ];
  const nodes = [
    node({ id: 1, tree_id: 't-active-attn', title: 'blocked node', status: 'blocked_question', question: 'need answer' }),
    node({ id: 2, tree_id: 't-active-plain', title: 'running node', status: 'running' }),
  ];
  const spawnTasks = [
    spawnTask({ id: 1, thread_ext: 'cockpit:hopper-node-2-abc123', status: 'running', hopper_node_id: 2, hopper_tree_id: 't-active-plain' }),
  ];
  const snap = buildSpawnMonitorSnapshot({ trees, nodes, spawnTasks, governor: {} });
  assert.deepEqual(
    snap.clusters.map((c) => c.key),
    ['t-active-attn', 't-active-plain', 't-draft', 't-done'],
    'attention must sort ahead of active, draft, done regardless of updated_at recency',
  );
  assert.equal(snap.totals.active_trees, 2);
  assert.equal(snap.totals.running_workers, 1);
  assert.equal(snap.totals.needs_attention, 1);
  const attnCluster = snap.clusters[0];
  assert.equal(attnCluster.trees[0].attention.length, 1);
  assert.equal(attnCluster.trees[0].attention[0].status, 'blocked_question');
  assert.equal(attnCluster.trees[0].attention[0].question, 'need answer');
});

// =============================================================================
// 3) Archived exclusion — hidden by default, included with includeArchived.
// =============================================================================
check('archived-exclusion', 'archived trees excluded unless includeArchived', () => {
  const trees = [
    tree('t-arch', 'archived thing', 'archived', '2026-09-12 00:00:00'),
    tree('t-live', 'live thing', 'done', '2026-09-12 00:00:00'),
  ];
  const hidden = buildSpawnMonitorSnapshot({ trees, nodes: [], spawnTasks: [], governor: {} });
  assert.equal(hidden.clusters.length, 1);
  assert.equal(hidden.clusters[0].key, 't-live');

  const shown = buildSpawnMonitorSnapshot({ trees, nodes: [], spawnTasks: [], governor: {}, includeArchived: true });
  assert.equal(shown.clusters.length, 2);
  assert.ok(shown.clusters.some((c) => c.key === 't-arch'));
});

// =============================================================================
// 4) Multi-attempt matching — stamped columns AND ext-pattern fallback both
//    resolve to the same node, oldest attempt first, drill-in detail carries
//    the full history.
// =============================================================================
check('multi-attempt-matching', 'retried node attempts group via stamped id + pattern fallback, oldest first', () => {
  const t = tree('t-multi', 'multi attempt tree', 'active', '2026-09-12 00:00:00');
  const n = node({
    id: 42, tree_id: 't-multi', title: 'flaky task', status: 'running',
    worker_thread_ext: 'cockpit:hopper-node-42-bbbbbbbb',
  });
  const spawnTasks = [
    spawnTask({
      id: 1, thread_ext: 'cockpit:hopper-node-42-aaaaaaaa', hopper_tree_id: 't-multi', hopper_node_id: 42,
      status: 'stuck', created_at: '2026-09-12 00:00:00', updated_at: '2026-09-12 00:05:00',
    }),
    spawnTask({
      id: 2, thread_ext: 'cockpit:hopper-node-42-bbbbbbbb', status: 'running',
      created_at: '2026-09-12 00:10:00', updated_at: '2026-09-12 00:12:00',
    }),
  ];
  const detail = buildSpawnMonitorTreeDetail(t, [n], spawnTasks);
  assert.equal(detail.nodes.length, 1);
  assert.equal(detail.nodes[0].spawns.length, 2, 'both attempts should attach to node 42');
  assert.deepEqual(
    detail.nodes[0].spawns.map((s) => s.thread_ext),
    ['cockpit:hopper-node-42-aaaaaaaa', 'cockpit:hopper-node-42-bbbbbbbb'],
    'attempts must be oldest-first',
  );
});

// =============================================================================
// 5) Fallback 3 — worker_thread_ext equality (a legacy/non-pattern ext).
// =============================================================================
check('fallback-worker-thread-ext', 'a legacy ext with no stamp/pattern still matches via worker_thread_ext', () => {
  const nodes = [node({ id: 7, tree_id: 't-legacy', title: 'legacy node', worker_thread_ext: 'cockpit:legacy-worker-xyz' })];
  const spawnTasks = [spawnTask({ id: 9, thread_ext: 'cockpit:legacy-worker-xyz' })];
  const { byNode, unmatched } = matchSpawnTasksToNodes(spawnTasks, nodes);
  assert.equal(unmatched.length, 0);
  assert.equal(byNode.get(7)?.length, 1);
});

// =============================================================================
// 6) Unmatched → adhoc, grouped by parent, newest group first.
// =============================================================================
check('unmatched-to-adhoc', 'genuinely non-hopper spawn_tasks land in adhoc, grouped by parent, newest first', () => {
  const t = tree('t-x', 'has one hopper node', 'active', '2026-09-12 00:00:00');
  const n = node({ id: 5, tree_id: 't-x', title: 'hopper node', worker_thread_ext: 'cockpit:hopper-node-5-cccccccc' });
  const spawnTasks = [
    spawnTask({ id: 1, thread_ext: 'cockpit:hopper-node-5-cccccccc', status: 'done' }), // matches the hopper node
    spawnTask({
      id: 2, thread_ext: 'cockpit:standalone-a', parent_thread_ext: 'cockpit:parent-old',
      status: 'done', created_at: '2026-09-12 00:00:00',
    }),
    spawnTask({
      id: 3, thread_ext: 'cockpit:standalone-b', parent_thread_ext: 'cockpit:parent-new',
      status: 'running', created_at: '2026-09-12 01:00:00',
    }),
    spawnTask({ id: 4, thread_ext: 'cockpit:standalone-c', parent_thread_ext: null, status: 'done', created_at: '2026-09-12 00:30:00' }),
  ];
  const snap = buildSpawnMonitorSnapshot({ trees: [t], nodes: [n], spawnTasks, governor: {} });
  assert.equal(snap.adhoc.length, 3, 'three distinct parents (incl. null) among the unmatched rows');
  assert.deepEqual(
    snap.adhoc.map((g) => g.parent),
    ['cockpit:parent-new', null, 'cockpit:parent-old'],
    'adhoc groups must be newest-group-first',
  );
  const allAdhocExts = snap.adhoc.flatMap((g) => g.workers.map((w) => w.thread_ext));
  assert.ok(!allAdhocExts.includes('cockpit:hopper-node-5-cccccccc'), 'matched hopper attempt must not leak into adhoc');
  assert.equal(
    snap.totals.running_workers, 1,
    'the running ad-hoc worker (id 3, no hopper node of its own) must still count toward the header total',
  );
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'} [${r.id}] ${r.description}${r.pass ? '' : `\n       ${r.error}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
