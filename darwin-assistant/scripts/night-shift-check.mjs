// NIGHT SHIFT CHECK (node #681, skills/night-shift/CONTRACT.md).
//
// The end-to-end wire-protocol counterpart to `npm run night:sim`: boots the
// REAL compiled server (express + the REAL createApiV1Router()) on a
// throwaway port against a READ-ONLY .backup() COPY of the LIVE jarvis.db,
// then drives it over real HTTP (curl-shaped fetch calls, not in-process
// function calls) through thread → plan → board → move → start → pause →
// resume → stop → report, asserting CONTRACT §5's routes against Kevin's
// real live goal data.
//
// Invoked by scripts/night-shift-check.sh, which does the safe DB copy and
// sets the environment. Never run this file directly against JARVIS_DB_PATH
// pointed at the live file — it refuses if so, same guard as the sim.
//
// NO MODEL CALLS: same ESM stub hooks as night-shift-sim.mjs for goals.js's
// postCue dynamic import of agent.js, PLUS the sim-guard chokepoint (belt and
// suspenders — sim-guard alone already fails closed on a non-live DB path).

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

register(pathToFileURL(path.join(__dirname, 'goals-v01-cue-check.hooks.mjs')), import.meta.url);
register(pathToFileURL(path.join(__dirname, 'goals-guards-sim-cue.hooks.mjs')), import.meta.url);
register(pathToFileURL(path.join(__dirname, 'goals-tree-cue-sim.hooks.mjs')), import.meta.url);
register(pathToFileURL(path.join(__dirname, 'goals-tool-sim-seed.hooks.mjs')), import.meta.url);

const LIVE_DB = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
const DB_PATH = path.resolve(process.env.JARVIS_DB_PATH ?? '');
if (!DB_PATH || DB_PATH === LIVE_DB) {
  console.error('FATAL: night-shift-check.mjs refuses to run without JARVIS_DB_PATH pointed at a COPY (got: ' + (DB_PATH || '(unset)') + ').');
  process.exit(2);
}
if (!fs.existsSync(DB_PATH)) {
  console.error(`FATAL: JARVIS_DB_PATH does not exist: ${DB_PATH}`);
  process.exit(2);
}
console.log(`[night-check] DB copy: ${DB_PATH}`);
console.log(`[night-check] vault:   ${process.env.GOALS_VAULT_ROOT ?? '(default — should be overridden by the wrapper!)'}`);

const distDir = path.join(repoRoot, 'dist');
const express = (await import('express')).default;
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const hopperEngine = await import(path.join(distDir, 'hopper-engine.js'));
const night = await import(path.join(distDir, 'night-shift.js'));
const { sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));

async function fakeProcessMessage() { return 'FAKE_WORKER_OK — no model call made (night-shift-check).'; }
hopperEngine.startHopperEngine(fakeProcessMessage);

const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const port = server.address().port;
const base = `http://127.0.0.1:${port}/api/v1`;
console.log(`[night-check] server: ${base}`);
const adminKey = mintApiKey('night-check-admin', 'cockpit').plaintext;

async function req(method, urlPath, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}${urlPath}`, {
    method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
const get = (p, token = adminKey) => req('GET', p, { token });
const post = (p, body = {}, token = adminKey) => req('POST', p, { token, body });

const results = [];
async function check(id, description, fn) {
  try { await fn(); results.push({ id, description, pass: true }); console.log(`  ✓ [${id}] ${description}`); }
  catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    results.push({ id, description, pass: false, error: msg });
    console.log(`  ✗ [${id}] ${description}\n      ${msg}`);
  }
}

let firstTwelve = null;
let goalCountAtPlan = null;

try {

// ── CHK-THREAD ──────────────────────────────────────────────────────────
await check('CHK-thread', 'POST /night/thread: created=true + real seed_text on first call, created=false (no seed) on the second', async () => {
  const first = await post('/night/thread', {});
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.external_id, 'cockpit:night-shift');
  assert.equal(first.json.created, true, `expected created=true on the first call, got ${JSON.stringify(first.json)}`);
  assert.ok(typeof first.json.seed_text === 'string' && first.json.seed_text.length > 40, 'seed_text missing/too short on creation');
  const second = await post('/night/thread', {});
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.equal(second.json.created, false, 'a second POST /night/thread claimed to create again');
  assert.equal(second.json.seed_text, null, 'a second POST /night/thread returned a seed_text');
});

// ── CHK-PLAN ─────────────────────────────────────────────────────────────
let runId = -1;
await check('CHK-plan', 'POST /night/plan on the live-data copy: ≥1 item, positions 1..N contiguous, every item has why/est_minutes/eta_at, no human leaves scheduled, finish items float to the top, DFS/sibling order preserved within each goal', async () => {
  const goalsBefore = await get('/goals');
  assert.equal(goalsBefore.status, 200, JSON.stringify(goalsBefore.json));
  goalCountAtPlan = goalsBefore.json.goals.filter((g) => !g.archived && g.status === 'set').length;
  assert.ok(goalCountAtPlan >= 1, 'the live-data copy has no set goals to plan against');

  const planned = await post('/night/plan', { mode: 'until_stop' });
  assert.equal(planned.status, 200, JSON.stringify(planned.json));
  runId = planned.json.run.id;
  const items = planned.json.items;
  assert.ok(items.length >= 1, `expected >=1 item from the live-data plan, got ${items.length}`);
  assert.ok(planned.json.eta_end, 'no eta_end on the plan');

  const positions = items.map((i) => i.position).sort((a, b) => a - b);
  assert.equal(positions.join(','), positions.map((_, idx) => idx + 1).join(','), 'positions are not a contiguous 1..N run');

  for (const it of items) {
    assert.ok(it.why && it.why.length > 5, `item #${it.position} (${it.kind}) has no why`);
    assert.ok(Number.isFinite(it.est_minutes) && it.est_minutes >= 1, `item #${it.position} has no est_minutes`);
    if (it.status === 'queued' && it.kind !== 'predicted') {
      // queued items always carry a lane-sim eta except a placeholder still
      // waiting on a parent that has not settled yet in the simulation.
      assert.ok(it.eta_at || it.kind === 'predicted', `item #${it.position} (${it.kind}) has no eta_at`);
    }
  }

  // No human leaf is ever an item (§3.1 rule 9 — they only ever appear in needs_you).
  const nodeIds = new Set(items.filter((i) => i.node_id != null).map((i) => i.node_id));
  if (nodeIds.size) {
    const placeholders = [...nodeIds].map(() => '?').join(',');
    const humans = sqliteDb.prepare(`SELECT id FROM goal_nodes WHERE id IN (${placeholders}) AND leaf_kind = 'human'`).all(...nodeIds);
    assert.equal(humans.length, 0, `a human leaf was scheduled as an item: node ids ${humans.map((h) => h.id).join(',')}`);
  }

  // Finish items float to the very top — no non-finish item precedes any finish item.
  const kinds = items.map((i) => i.kind);
  const firstNonFinish = kinds.findIndex((k) => k !== 'finish');
  const lastFinish = kinds.lastIndexOf('finish');
  if (lastFinish >= 0 && firstNonFinish >= 0) {
    assert.ok(lastFinish < firstNonFinish, `a non-finish item (#${firstNonFinish + 1}) precedes a finish item (#${lastFinish + 1})`);
  }
  // Goal 5's real in-flight nodes (state='working' in the live snapshot) —
  // if any exist, each must be represented by an item, and per §3.1 rules 1/2
  // that item is `finish` (floated to the top) when its tree is healthy, or
  // `unblock` (not floated) when the tree is CURRENTLY blocked for real —
  // read the actual live tree_status_cache rather than assuming one or the
  // other, since which one applies can (and does) change from run to run.
  const workingForGoal5 = sqliteDb.prepare(`SELECT id, tree_status_cache FROM goal_nodes WHERE state = 'working' AND goal_id = 5`).all();
  if (workingForGoal5.length) {
    const byNode = new Map(items.filter((i) => i.node_id != null).map((i) => [i.node_id, i]));
    for (const n of workingForGoal5) {
      const item = byNode.get(n.id);
      assert.ok(item, `goal 5's working node #${n.id} produced no item at all`);
      const wantKind = n.tree_status_cache === 'blocked' ? 'unblock' : 'finish';
      assert.equal(item.kind, wantKind, `goal 5's working node #${n.id} (tree_status_cache=${n.tree_status_cache}) should be "${wantKind}", got "${item.kind}"`);
      // finish items floating to the top is already proven generally above
      // (firstNonFinish/lastFinish) — this just confirms THIS node's item
      // is one of the floated ones when it is in fact a `finish`.
      if (wantKind === 'finish') assert.ok(item.position <= (lastFinish + 1), `node #${n.id}'s finish item at #${item.position} did not float into the top block (top block ends at #${lastFinish + 1})`);
    }
  }

  // Sibling/DFS order rule (§3.1 — "this order is sacred"): within a single
  // goal's own stream (finish items excluded, since assembly floats them out
  // of DFS order on purpose), consecutive items for that goal must never
  // regress to an earlier DFS index than a sibling/earlier item already saw.
  const dfsOf = (why) => { const m = /DFS #(\d+)/.exec(why); return m ? Number(m[1]) : null; };
  const perGoal = new Map();
  for (const it of items) {
    if (it.kind === 'finish' || it.kind === 'predicted') continue;
    const d = dfsOf(it.why);
    if (d == null) continue;
    if (!perGoal.has(it.goal_id)) perGoal.set(it.goal_id, []);
    perGoal.get(it.goal_id).push({ position: it.position, dfs: d });
  }
  for (const [goalId, seq] of perGoal) {
    for (let i = 1; i < seq.length; i += 1) {
      assert.ok(seq[i].dfs >= seq[i - 1].dfs,
        `goal #${goalId}: item at position ${seq[i].position} (DFS #${seq[i].dfs}) sits after position ${seq[i - 1].position} (DFS #${seq[i - 1].dfs}) — sibling/DFS order violated`);
    }
  }

  firstTwelve = items.slice(0, 12);
});

// ── CHK-BOARD ────────────────────────────────────────────────────────────
await check('CHK-board', 'GET /night/board before Start: every §5 field present, ACTIVITY stats all zero (nothing has run yet — queued naturally holds the whole backlog), budget non-empty', async () => {
  const b = await get('/night/board');
  assert.equal(b.status, 200, JSON.stringify(b.json));
  for (const k of ['run', 'items', 'lanes', 'stats', 'needs_you', 'budget', 'hold', 'heartbeat', 'thread_ext']) {
    assert.ok(k in b.json, `board is missing "${k}"`);
  }
  // SHIFTS v1 §3.1 — the board points at the ACTIVE shift's OWN thread; the
  // lobby is only the fallback for a run planned before per-shift threads.
  assert.equal(b.json.thread_ext, `cockpit:shift-${runId}`);
  assert.equal(b.json.run.thread_ext, `cockpit:shift-${runId}`, 'the run row did not record its own thread');
  assert.equal(b.json.run.id, runId);
  assert.equal(b.json.lanes.length, b.json.run.config.lanes);
  // Nothing has RUN yet (Start hasn't been called), so every activity stat
  // is zero — but `queued` legitimately holds the whole freshly-planned
  // backlog, so it's checked for the opposite: it should equal the item count.
  for (const k of ['done', 'failed', 'blocked', 'skipped', 'running']) {
    assert.equal(b.json.stats.items[k], 0, `stats.items.${k} is nonzero before Start: ${b.json.stats.items[k]}`);
  }
  const nonExpanded = b.json.items.filter((i) => i.status !== 'expanded').length;
  assert.equal(b.json.stats.items.queued, nonExpanded, `stats.items.queued (${b.json.stats.items.queued}) should equal the freshly-planned backlog (${nonExpanded})`);
  assert.equal(b.json.stats.trees_spawned, 0, 'stats.trees_spawned is nonzero before Start');
  assert.equal(b.json.stats.hopper_nodes.done, 0, 'stats.hopper_nodes.done is nonzero before Start');
  assert.equal(b.json.stats.commits, 0, 'stats.commits is nonzero before Start');
  assert.equal(b.json.stats.tests, 0, 'stats.tests is nonzero before Start');
  assert.ok(Array.isArray(b.json.budget) && b.json.budget.length >= 1, `budget is empty: ${JSON.stringify(b.json.budget)}`);
  assert.equal(b.json.hold, null, 'a fresh planned run already shows a hold');
});

// ── CHK-MOVE ─────────────────────────────────────────────────────────────
await check('CHK-move', 'move + lock: an explicit move locks the item, lands it exactly where asked, and keeps positions a contiguous 1..N', async () => {
  const before = night.listNightItems(runId);
  assert.ok(before.length >= 2, 'not enough items to exercise move');
  const target = before[before.length - 1];
  assert.equal(target.locked, 0, 'the target item was already locked before the move');
  const moved = await post(`/night/runs/${runId}/items/${target.id}/move`, { position: 2 });
  assert.equal(moved.status, 200, JSON.stringify(moved.json));
  const after = night.listNightItems(runId);
  const now = after.find((i) => i.id === target.id);
  assert.equal(now.position, Math.min(2, before.length), 'move did not land on the requested (clamped) position');
  assert.equal(now.locked, 1, 'move did not lock the item');
  const positions = after.map((i) => i.position).sort((a, b) => a - b);
  assert.equal(positions.join(','), positions.map((_, idx) => idx + 1).join(','), 'positions are not contiguous 1..N after the move');
});

// ── CHK-LIFECYCLE ────────────────────────────────────────────────────────
await check('CHK-lifecycle', 'start -> pause (nightShiftPausedTreeIds covers the run\'s already-in-flight trees) -> resume -> stop, with prior_autopilot restored byte-for-byte for every included goal', async () => {
  const priorBefore = new Map();
  for (const gid of night.getNightRun(runId).goal_ids) {
    const g = await get(`/goals/${gid}`);
    assert.equal(g.status, 200, JSON.stringify(g.json));
    priorBefore.set(gid, { autopilot: g.json.goal.autopilot, config: g.json.goal.autopilot_config ?? null });
  }

  const started = await post(`/night/runs/${runId}/start`, {});
  assert.equal(started.status, 200, JSON.stringify(started.json));
  assert.equal(started.json.run.status, 'running');
  for (const gid of night.getNightRun(runId).goal_ids) {
    const g = await get(`/goals/${gid}`);
    assert.equal(g.json.goal.autopilot, 1, `goal #${gid} was not adopted onto autopilot at Start`);
  }

  const paused = await post(`/night/runs/${runId}/pause`, {});
  assert.equal(paused.status, 200, JSON.stringify(paused.json));
  assert.equal(paused.json.run.status, 'paused');
  const pausedTrees = night.nightShiftPausedTreeIds();
  // The run's items whose node already owns a real tree (goal 5's in-flight
  // nodes, carried over untouched from the live snapshot) MUST be covered.
  const items = night.listNightItems(runId);
  const expectTrees = new Set();
  for (const it of items) {
    if (it.status !== 'queued' && it.status !== 'running') continue;
    if (it.node_id == null) continue;
    const node = sqliteDb.prepare('SELECT tree_id FROM goal_nodes WHERE id = ?').get(it.node_id);
    if (node?.tree_id) expectTrees.add(node.tree_id);
  }
  for (const tid of expectTrees) {
    assert.ok(pausedTrees.has(tid), `nightShiftPausedTreeIds() is missing tree ${tid}, which an open item's node already owns`);
  }
  if (expectTrees.size === 0) {
    console.log('      (no open item currently owns a real tree in this snapshot — pausedTrees set is legitimately empty; the coverage rule still held vacuously)');
  }

  const resumed = await post(`/night/runs/${runId}/resume`, {});
  assert.equal(resumed.status, 200, JSON.stringify(resumed.json));
  assert.equal(resumed.json.run.status, 'running');
  assert.ok(!night.nightShiftPausedTreeIds().size || [...night.nightShiftPausedTreeIds()].every((t) => !expectTrees.has(t)),
    'a tree is still reported paused after resume');

  const stopped = await post(`/night/runs/${runId}/stop`, {});
  assert.equal(stopped.status, 200, JSON.stringify(stopped.json));
  assert.ok(stopped.json.run.status === 'stopped' || stopped.json.run.status === 'complete', `run did not wrap: ${stopped.json.run.status}`);

  for (const [gid, prior] of priorBefore) {
    const g = await get(`/goals/${gid}`);
    assert.equal(g.json.goal.autopilot, prior.autopilot, `goal #${gid} autopilot was not restored to its pre-run value (${prior.autopilot})`);
    if (prior.autopilot === 1 && prior.config) {
      const now = g.json.goal.autopilot_config;
      for (const k of ['parallel', 'tick_minutes', 'max_depth', 'build_model', 'light_model', 'verify_model', 'max_attempts']) {
        assert.equal(JSON.stringify(now?.[k]), JSON.stringify(prior.config[k]), `goal #${gid} autopilot_config.${k} was not restored byte-for-byte`);
      }
    }
  }
});

// ── CHK-REPORT ───────────────────────────────────────────────────────────
await check('CHK-report', 'GET /night/runs/:id/report: markdown + a written path under the scratch VAULT_ROOT (never the real wiki), containing every required section', async () => {
  const r = await get(`/night/runs/${runId}/report`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.written, 'report was not written to disk');
  assert.ok(r.json.path, 'no report path returned');
  const vaultRoot = process.env.GOALS_VAULT_ROOT;
  assert.ok(vaultRoot && vaultRoot !== '/home/kevin/obsidian/paperclip-wiki',
    `GOALS_VAULT_ROOT is not overridden to a scratch dir — refusing to trust the write target (${vaultRoot})`);
  const abs = path.join(vaultRoot, r.json.path);
  assert.ok(fs.existsSync(abs), `report file missing on disk: ${abs}`);
  assert.ok(!abs.startsWith('/home/kevin/obsidian/paperclip-wiki'), `report landed inside the REAL wiki: ${abs}`);
  const md = fs.readFileSync(abs, 'utf8');
  for (const section of ['# 🌙 Night Shift', '## The plan as generated', '## What actually happened', '## Stats', '## Per goal', '## Needs you', '## Holds', "## The orchestrator's read", '<details><summary>event trail</summary>']) {
    assert.ok(md.includes(section), `report is missing "${section}"`);
  }
  assert.equal(md, r.json.markdown, 'the written file does not match the returned markdown');
});

} catch (err) {
  console.error('\n[night-check] FATAL', err);
  results.push({ id: 'FATAL', description: 'check crashed', pass: false, error: String(err?.stack ?? err) });
} finally {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n[night-check] ${passed}/${results.length} checks passed${failed ? ` — ${failed} FAILED` : ''}`);
  if (firstTwelve) {
    console.log(`\n[night-check] the plan's first ${firstTwelve.length} rows, as the server produced them on the live snapshot (${goalCountAtPlan} set goal(s) in scope):`);
    console.log('pos | kind       | goal/node       | est  | eta                  | why');
    for (const it of firstTwelve) {
      const gn = `G${it.goal_id}${it.node_id != null ? `/#${it.node_id}` : ''}`;
      console.log(`${String(it.position).padStart(3)} | ${it.kind.padEnd(10)} | ${gn.padEnd(15)} | ${String(it.est_minutes).padStart(3)}m | ${(it.eta_at ?? '—').padEnd(20)} | ${it.why.slice(0, 90)}`);
    }
  }
  server.close();
  process.exit(failed ? 1 : 0);
}
