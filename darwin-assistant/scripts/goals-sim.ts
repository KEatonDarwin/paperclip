// GOALS LIFECYCLE SIM (hopper node #459) — drives the real goals.ts + hopper-engine.ts
// through the express router on a throwaway port, against a SCRATCH sqlite DB.
// No live model calls: the hopper engine's worker spawn is stubbed with a fake
// processMessage (mirrors scripts/foundry-sim.mjs's fakeProcessMessage), and we
// never POST to /threads/:ext/messages (which would run a real agent.ts turn).
//
//   npm run build
//   npm run goals:sim
//   (or: JARVIS_DB_PATH=/tmp/goals-sim.db HOPPER_GOV_ENABLED=0 npx tsx scripts/goals-sim.ts)
//
// Writes a full pass/fail report to
// /home/kevin/obsidian/paperclip-wiki/outbox/goals/sim-report.md.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// v0.1 §11.3 — fireGoalReviewCue dynamically imports dist/agent.js to post the
// review cue as a real JARVIS turn. Intercept that specific import (same hook
// script node #469 wrote for scripts/goals-v01-cue-check.mjs) so accepting a
// Kevin-edited ghost through the real HTTP path never spawns a real claude CLI
// turn — it just records the call on globalThis.__goalsCueCalls (NO API KEYS /
// no live model calls anywhere in this file).
register(pathToFileURL(path.join(__dirname, 'goals-v01-cue-check.hooks.mjs')), import.meta.url);
// v0.2 §12.6 — goals-guards.ts's fireGuardCue does the SAME dynamic
// import('./agent.js'), from a different dist file (goals-guards.js). Stub
// that one too, onto the same __goalsCueCalls array (see the hook file).
register(pathToFileURL(path.join(__dirname, 'goals-guards-sim-cue.hooks.mjs')), import.meta.url);
// v0.3 §14.6 — tree-cue.ts's treeCueOnTreeStatus does the SAME dynamic import
// from dist/tree-cue.js (imported lazily inside the V03 section so earlier
// tree completions don't add cue calls). Stub it onto the same array.
register(pathToFileURL(path.join(__dirname, 'goals-tree-cue-sim.hooks.mjs')), import.meta.url);
// v0.3 §14.7 — the `goals` tool's open_node_chat (and promote) post the seed
// text through import('../agent.js') from dist/tools/goals-tool.js. Stub that
// too — the V03 checks drive the real tool and must never run a real turn.
register(pathToFileURL(path.join(__dirname, 'goals-tool-sim-seed.hooks.mjs')), import.meta.url);

// ── scratch DB guard (must run before any dist/ module is imported — ──────
// conversation-db.js opens the sqlite handle at import time) ──────────────
const raw = process.env.JARVIS_DB_PATH ?? '/tmp/goals-sim.db';
const DB_PATH = path.resolve(raw);
const LIVE_DB = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
if (DB_PATH === LIVE_DB) {
  console.error('FATAL: refusing to run against the live jarvis.db. Use a /tmp scratch path.');
  process.exit(1);
}
process.env.JARVIS_DB_PATH = DB_PATH;
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
console.log(`[goals-sim] scratch DB: ${DB_PATH}`);

// No real model calls anywhere in this file's checks. Governor disabled +
// generous slots so dispatchTick claims ready hopper leaves immediately.
process.env.HOPPER_GOV_ENABLED = '0';
// v0.2 §13.5 — the structure digest is debounced 20s per goal in production;
// collapse it so the V02 checks can observe ONE cue per burst quickly.
process.env.GOALS_STRUCTURE_DEBOUNCE_MS = process.env.GOALS_STRUCTURE_DEBOUNCE_MS ?? '60';
process.env.HOPPER_ENGINE_SLOTS = process.env.HOPPER_ENGINE_SLOTS ?? '8';
delete process.env.ANTHROPIC_API_KEY;
// v0.2 §12.7/§12.12 guards: the poller auto-starts at module load of
// goals-guards.js (which api-v1.js imports transitively) unless this is set —
// must be set BEFORE that import. Section [16] drives pollGuardsOnce() by
// hand instead. No Overwatch key is set yet (checks flip it on/off per-case).
process.env.GOAL_GUARD_POLLER = '0';

const distDir = path.join(repoRoot, 'dist');
const express = (await import('express')).default;
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const hopperEngine = await import(path.join(distDir, 'hopper-engine.js'));
const goalsModule = await import(path.join(distDir, 'goals.js'));
const guardsModule = await import(path.join(distDir, 'goals-guards.js'));

// ── fake worker — no model calls, mirrors scripts/foundry-sim.mjs exactly ──
const dispatchedNodeIds = new Set<number>();
async function fakeProcessMessage(prompt: string): Promise<string> {
  const m = /node #(\d+)/.exec(prompt);
  if (m) dispatchedNodeIds.add(Number(m[1]));
  return 'FAKE_WORKER_OK — no model call made.';
}
hopperEngine.startHopperEngine(fakeProcessMessage);

// ── real express app, real HTTP, throwaway port ────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise<import('node:http').Server>((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s as import('node:http').Server));
});
const address = server.address();
const port = typeof address === 'object' && address ? address.port : 0;
const base = `http://127.0.0.1:${port}/api/v1`;
console.log(`[goals-sim] server: ${base}`);

const cockpitKey = mintApiKey('goals-sim-admin', 'cockpit').plaintext; // admin scope
const jarvisKey = mintApiKey('goals-sim-jarvis', 'jarvis').plaintext; // non-admin scope

type ReqOpts = { token?: string; body?: unknown };
async function req(method: string, urlPath: string, opts: ReqOpts = {}): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
function get(p: string, token = cockpitKey) {
  return req('GET', p, { token });
}
function post(p: string, body: unknown = {}, token = cockpitKey) {
  return req('POST', p, { token, body });
}
function patch(p: string, body: unknown = {}, token = cockpitKey) {
  return req('PATCH', p, { token, body });
}
function put(p: string, body: unknown = {}, token = cockpitKey) {
  return req('PUT', p, { token, body });
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── v0.1 §11.3 cue capture (populated by the stubbed dist/agent.js, see the ──
// register() call above) ────────────────────────────────────────────────────
type CueCall = { text: string; externalId: string; correlationKey?: string };
function cueCalls(): CueCall[] {
  return ((globalThis as unknown as { __goalsCueCalls?: CueCall[] }).__goalsCueCalls) ?? [];
}
function cueCallCount(): number {
  return cueCalls().length;
}
function lastCueCall(): CueCall {
  const calls = cueCalls();
  return calls[calls.length - 1];
}
async function waitForCueCalls(n: number, timeoutMs = 2000, stepMs = 30): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (cueCallCount() < n && Date.now() < deadline) await sleep(stepMs);
}

// Poll a condition (used to let dispatchTick's queueMicrotask + async claim
// loop settle after agreeHopperTree, without a fixed arbitrary sleep).
async function waitFor(label: string, fn: () => Promise<boolean>, timeoutMs = 4000, stepMs = 40): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(stepMs);
  }
  throw new Error(`waitFor timed out: ${label}`);
}

// ── result collection — never abort the whole run on one failure ───────────
type Result = { id: string; description: string; pass: boolean; error?: string };
const results: Result[] = [];
async function check(id: string, description: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ id, description, pass: true });
    console.log(`  ✓ [${id}] ${description}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ id, description, pass: false, error: msg });
    console.log(`  ✗ [${id}] ${description}\n      ${msg}`);
  }
}

// ── SSE capture (real HTTP GET /api/v1/events, both admin + non-admin keys) ─
type SSECapture = { close: () => void; events: { type: string }[] };
function captureSSE(token: string): SSECapture {
  const events: { type: string }[] = [];
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${base}/events`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (dataLine) {
            try {
              const parsed = JSON.parse(dataLine.slice(6));
              events.push(parsed);
            } catch { /* heartbeat or malformed, ignore */ }
          }
        }
      }
    } catch {
      // aborted on close — expected
    }
  })();
  return { close: () => ctrl.abort(), events };
}

// v0.2 §12 guards: a fake Overwatch HTTP server, started inside section [16]
// below. Declared here so the `finally` block can close it alongside the app
// server regardless of which check (if any) failed.
let owServer: import('node:http').Server | undefined;

// ═══════════════════════════════════════════════════════════════════════════
try {
  console.log('\n[SETUP] two SSE streams (admin=cockpit-scope, non-admin=jarvis-scope)');
  const sseAdmin = captureSSE(cockpitKey);
  const sseNonAdmin = captureSSE(jarvisKey);
  await sleep(150); // let the connections establish before anything fires

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[1] Goal creation: ghost -> set, thread eagerly created');
  let goalId = -1;
  let humanThreadCreated = false;
  await check('1a', 'POST /goals without done_means -> ghost goal + thread created eagerly', async () => {
    const r = await post('/goals', { title: 'Ship Perclickity v2 media-buy stats' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.goal.status, 'ghost');
    assert.equal(r.json.goal.authored_by, 'kevin');
    goalId = r.json.goal.id;
    assert.equal(r.json.thread.created, true);
    assert.equal(r.json.thread.external_id, `cockpit:goal-${goalId}`);
    assert.ok(typeof r.json.thread.seed_text === 'string' && r.json.thread.seed_text.includes('GOAL CHAT'));
    humanThreadCreated = true;
  });

  await check('1b', 'GET /goals/:id/thread on an already-created thread -> created:false, seed_text:null', async () => {
    const r = await get(`/goals/${goalId}/thread`);
    assert.equal(r.status, 200);
    assert.equal(r.json.created, false);
    assert.equal(r.json.seed_text, null);
    assert.equal(r.json.external_id, `cockpit:goal-${goalId}`);
  });

  await check('1c', 'PATCH done_means on a ghost goal flips it to set', async () => {
    const r = await patch(`/goals/${goalId}`, {
      done_means: 'Kevin can see media-buy revenue per link in the dashboard, reconciled to QB',
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.goal.status, 'set');
  });

  await check('1d', 'POST /goals {title, done_means} together -> set directly (no ghost step)', async () => {
    const r = await post('/goals', { title: 'Throwaway direct-set goal', done_means: 'exists for one assertion' });
    assert.equal(r.status, 201);
    assert.equal(r.json.goal.status, 'set');
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[2] Nodes: authored_by=kevin (born set) vs authored_by=jarvis (born ghost)');
  await check('2a', 'POST node authored_by=kevin without done_means -> 409 done_means_required', async () => {
    const r = await post(`/goals/${goalId}/nodes`, { title: 'No done means', authored_by: 'kevin' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'done_means_required');
  });

  let kevinNodeId = -1;
  await check('2b', 'POST node authored_by=kevin WITH done_means -> born set', async () => {
    const r = await post(`/goals/${goalId}/nodes`, {
      title: 'Kevin-dictated root node',
      done_means: 'a Kevin-authored acceptance criterion',
      authored_by: 'kevin',
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.node.state, 'set');
    assert.equal(r.json.node.authored_by, 'kevin');
    kevinNodeId = r.json.node.id;
  });

  let soloGhostId = -1;
  let soloGhostBatch = '';
  await check('2c', 'POST node authored_by=jarvis -> born ghost, own batch', async () => {
    const r = await post(`/goals/${goalId}/nodes`, {
      title: 'JARVIS solo proposal',
      done_means: 'a jarvis-authored ghost',
      authored_by: 'jarvis',
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.node.state, 'ghost');
    assert.ok(r.json.node.proposal_batch);
    soloGhostId = r.json.node.id;
    soloGhostBatch = r.json.node.proposal_batch;
  });

  await check('2d', "PATCH (direct edit) on a ghost as actor=jarvis is allowed (it's JARVIS's own proposal)", async () => {
    const r = await patch(`/goals/${goalId}/nodes/${soloGhostId}`, { title: 'JARVIS solo proposal (reworded)', actor: 'jarvis' });
    assert.equal(r.status, 200);
    assert.equal(r.json.node.title, 'JARVIS solo proposal (reworded)');
  });

  await check('2e', 'discard the solo ghost (not needed further)', async () => {
    const r = await post(`/goals/${goalId}/nodes/${soloGhostId}/discard`, {});
    assert.equal(r.status, 200);
    assert.equal(r.json.node.state, 'discarded');
  });
  void soloGhostBatch;

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[3] propose 4 ghosts (root-level) — nesting + parent-not-set guards');
  await check('3a', 'propose with nested items[].children -> 400 no_nesting', async () => {
    const r = await post(`/goals/${goalId}/nodes/propose`, {
      parent_id: null,
      items: [{ title: 'x', done_means: 'y', children: [{ title: 'grandchild' }] }],
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'no_nesting');
  });

  await check('3b', 'propose under a ghost parent -> 409 parent_not_set', async () => {
    const ghostParent = await post(`/goals/${goalId}/nodes`, {
      title: 'transient ghost parent',
      done_means: 'x',
      authored_by: 'jarvis',
    });
    const r = await post(`/goals/${goalId}/nodes/propose`, {
      parent_id: ghostParent.json.node.id,
      items: [{ title: 'child of a ghost', done_means: 'x' }],
    });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'parent_not_set');
    await post(`/goals/${goalId}/nodes/${ghostParent.json.node.id}/discard`, {});
  });

  let batchId = '';
  let fourIds: number[] = [];
  await check('3c', 'propose 4 ghosts under the goal root -> one shared batch', async () => {
    const r = await post(`/goals/${goalId}/nodes/propose`, {
      parent_id: null,
      items: [
        { title: 'Media-buy stats', done_means: '/stats page shows revenue per linkId for any date range' },
        { title: 'QB reconciliation', done_means: 'monthly totals match QB within $1' },
        { title: 'Docs', done_means: 'outbox/perclickity-v2.md reviewed' },
        { title: 'A ghost we will reject', done_means: "doesn't survive review" },
      ],
      actor: 'jarvis',
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.nodes.length, 4);
    assert.ok(r.json.nodes.every((n: any) => n.state === 'ghost'));
    batchId = r.json.batch_id;
    fourIds = r.json.nodes.map((n: any) => n.id);
  });

  let mediaBuyId = -1, qbId = -1, docsId = -1, rejectId = -1;
  await check('4a', 'accept 3 of the 4 via batch accept (ids subset)', async () => {
    [mediaBuyId, qbId, docsId, rejectId] = fourIds;
    const r = await post(`/goals/${goalId}/batches/${batchId}/accept`, { ids: [mediaBuyId, qbId, docsId] });
    assert.equal(r.status, 200);
    assert.equal(r.json.nodes.length, 3);
    assert.ok(r.json.nodes.every((n: any) => n.state === 'set'));
    assert.ok(r.json.nodes.every((n: any) => n.proposal_batch === null), 'batch cleared on accepted rows');
  });

  await check('4b', 'discard the 4th ghost individually', async () => {
    const r = await post(`/goals/${goalId}/nodes/${rejectId}/discard`, { reason: 'not aligned with the goal' });
    assert.equal(r.status, 200);
    assert.equal(r.json.node.state, 'discarded');
  });

  await check('4c', 'accept_all with no remaining ghosts -> { nodes: [] } 200', async () => {
    const r = await post(`/goals/${goalId}/accept_all`, {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.nodes, []);
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[5] focus + propose children under the focused node');
  let focusEventSeenAtCount = 0;
  await check('5a', 'PUT focus on Media-buy stats -> goal_focus SSE fires', async () => {
    const before = sseAdmin.events.filter((e) => e.type === 'goal_focus').length;
    const r = await put(`/goals/${goalId}/focus`, { node_id: mediaBuyId });
    assert.equal(r.status, 200);
    assert.equal(r.json.focus.node_id, mediaBuyId);
    await waitFor('goal_focus SSE after PUT focus', async () => sseAdmin.events.filter((e) => e.type === 'goal_focus').length > before);
    focusEventSeenAtCount = sseAdmin.events.filter((e) => e.type === 'goal_focus').length;
  });

  await check('5b', 'PUT focus on the SAME node again -> no new focus_set event/SSE (repeat click is a no-op)', async () => {
    const r = await put(`/goals/${goalId}/focus`, { node_id: mediaBuyId });
    assert.equal(r.status, 200);
    await sleep(150);
    assert.equal(
      sseAdmin.events.filter((e) => e.type === 'goal_focus').length,
      focusEventSeenAtCount,
      'no additional goal_focus SSE on an unchanged focus',
    );
  });

  await check('5c', 'PUT focus on a discarded node -> 409', async () => {
    const r = await put(`/goals/${goalId}/focus`, { node_id: rejectId });
    assert.equal(r.status, 409);
  });

  let machineChildId = -1, humanChildId = -1;
  await check('5d', 'propose 2 children under the focused node (Media-buy stats), one layer only', async () => {
    const r = await post(`/goals/${goalId}/nodes/propose`, {
      parent_id: mediaBuyId,
      items: [
        { title: 'Create monitoring', done_means: 'an Overwatch query rule fails when daily revenue < 7-day avg -5%' },
        { title: 'Kevin places the redirect', done_means: 'redirect live on prod' },
      ],
      actor: 'jarvis',
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.nodes.length, 2);
    machineChildId = r.json.nodes[0].id;
    humanChildId = r.json.nodes[1].id;
  });

  await check('5e', 'accept both children (accept_all scoped to parent_id)', async () => {
    const r = await post(`/goals/${goalId}/accept_all`, { parent_id: mediaBuyId });
    assert.equal(r.status, 200);
    assert.equal(r.json.nodes.length, 2);
    assert.ok(r.json.nodes.every((n: any) => n.state === 'set'));
  });

  await check('5f', 'propose_removal on a SET node WITH (non-discarded) children -> 409 node_has_children', async () => {
    // Must run while mediaBuyId is still 'set' — propose_removal's base precondition
    // is state='set' (see the 7f note below), so this is the one legal window to
    // observe node_has_children specifically (later it's 'check'/'done').
    const r = await post(`/goals/${goalId}/nodes/${mediaBuyId}/propose_removal`, { reason: 'x' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'node_has_children');
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[6] leaf kinds: 1 machine, 1 human');
  await check('6a', "setting leaf_kind on Media-buy stats (has children) -> 409 node_has_children", async () => {
    const r = await post(`/goals/${goalId}/nodes/${mediaBuyId}/leaf_kind`, { leaf_kind: 'machine' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'node_has_children');
  });

  await check('6b', "set 'Create monitoring' leaf_kind=machine", async () => {
    const r = await post(`/goals/${goalId}/nodes/${machineChildId}/leaf_kind`, { leaf_kind: 'machine' });
    assert.equal(r.status, 200);
    assert.equal(r.json.node.leaf_kind, 'machine');
  });

  await check('6c', "set 'Kevin places the redirect' leaf_kind=human", async () => {
    const r = await post(`/goals/${goalId}/nodes/${humanChildId}/leaf_kind`, { leaf_kind: 'human' });
    assert.equal(r.status, 200);
    assert.equal(r.json.node.leaf_kind, 'human');
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[7] machine leaf: invalid plan rejected, valid plan proposed + approved -> hopper tree');
  await check('7a', 'propose_plan with a fable model -> 400 plan_invalid', async () => {
    const r = await post(`/goals/${goalId}/nodes/${machineChildId}/propose_plan`, {
      plan: {
        what: 'x', deliverable: 'y', model: 'claude-fable-5', adapter: 'claude',
        nodes: [{ title: 'n1', spec: 's1', adapter: 'claude', model: 'claude-fable-5' }],
      },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'plan_invalid');
  });

  await check('7b', 'propose_plan with an empty nodes[] -> 400 plan_invalid', async () => {
    const r = await post(`/goals/${goalId}/nodes/${machineChildId}/propose_plan`, {
      plan: { what: 'x', deliverable: 'y', model: 'claude-sonnet-5', adapter: 'claude', nodes: [] },
    });
    assert.equal(r.status, 400);
  });

  await check('7c', 'valid propose_plan (2 nodes: sonnet build + opus review) -> plan_state=proposed', async () => {
    const r = await post(`/goals/${goalId}/nodes/${machineChildId}/propose_plan`, {
      plan: {
        what: 'Capture the query + register an Overwatch rule.',
        deliverable: 'rule id returned by lanes-tool',
        model: 'claude-sonnet-5',
        adapter: 'claude',
        estimate: '~30 min',
        nodes: [
          { title: 'Capture the SQL from smarty-pants', spec: 'pull the proven query for daily-vs-7-day-avg revenue', adapter: 'claude', model: 'claude-sonnet-5' },
          { title: 'Register + review the rule', spec: 'register via lanes-tool, then adversarial-review the rule body', adapter: 'claude', model: 'claude-opus-5', depends_on_indexes: [0] },
        ],
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.node.plan_state, 'proposed');
  });

  let treeId = '';
  const hopperNodeIds: number[] = [];
  await check('7d', 'approve_plan -> plan_state=approved, hopper tree created+agreed, node state=working, tree_id linked', async () => {
    const r = await post(`/goals/${goalId}/nodes/${machineChildId}/approve_plan`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.node.state, 'working');
    assert.ok(r.json.node.tree_id);
    assert.equal(r.json.tree.id, r.json.node.tree_id);
    assert.equal(r.json.hopper_nodes.length, 2);
    treeId = r.json.tree.id;
    for (const n of r.json.hopper_nodes) hopperNodeIds.push(n.id);

    const treeRow = await get(`/hopper-trees/${treeId}`);
    assert.equal(treeRow.status, 200);
    assert.equal(treeRow.json.tree.status, 'active');
  });

  await check('7e', 're-approve_plan on an already-working node -> 409 plan_not_proposed', async () => {
    const r = await post(`/goals/${goalId}/nodes/${machineChildId}/approve_plan`, {});
    assert.equal(r.status, 409);
  });

  await check(
    '7f',
    "propose_removal on a working leaf -> 409 (blocked either way; CONTRACT.md §3.3 route 18 names " +
      "'leaf_already_dispatched' for this case, but proposeRemoval's actual first-hit precondition is " +
      "'state must be set', so a working node 409s as invalid_transition instead — see sim-report notes, " +
      "this is a CONTRACT-wording ambiguity flagged for REVIEW-BACKEND, not patched here)",
    async () => {
      const r = await post(`/goals/${goalId}/nodes/${machineChildId}/propose_removal`, { reason: 'x' });
      assert.equal(r.status, 409);
      assert.equal(r.json.error.code, 'invalid_transition');
    },
  );

  await check('7g', 'creating a child under a machine leaf while working -> 409 leaf_already_dispatched', async () => {
    const r = await post(`/goals/${goalId}/nodes`, {
      title: 'illegal grandchild', done_means: 'x', parent_id: machineChildId, authored_by: 'kevin',
    });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'leaf_already_dispatched');
  });

  await check('7h', 'park a working node -> parked, hopper tree left untouched (still active); unpark restores working', async () => {
    const parked = await post(`/goals/${goalId}/nodes/${machineChildId}/park`, {});
    assert.equal(parked.status, 200);
    assert.equal(parked.json.node.state, 'parked');
    const treeStillActive = await get(`/hopper-trees/${treeId}`);
    assert.equal(treeStillActive.json.tree.status, 'active', 'park must not touch the running hopper tree');
    const unparked = await post(`/goals/${goalId}/nodes/${machineChildId}/unpark`, {});
    assert.equal(unparked.status, 200);
    assert.equal(unparked.json.node.state, 'working', 'unpark must restore the exact prior state');
  });

  await check(
    '7i',
    'dispatchTick claims both hopper leaves into running (fake worker, governor disabled)',
    async () => {
      await waitFor('hopper nodes -> running', async () => {
        const overlay = await get(`/goals/${goalId}/nodes/${machineChildId}/tree`);
        if (overlay.status !== 200) return false;
        return overlay.json.nodes.filter((n: any) => n.status === 'running').length >= 1;
      });
      assert.ok(dispatchedNodeIds.has(hopperNodeIds[0]), 'fake worker prompt should reference node #<id>');
    },
  );

  await check('7j', 'finish the first hopper node via POST /hopper-nodes/:id/finish {done} -> second node then claims', async () => {
    const r = await post(`/hopper-nodes/${hopperNodeIds[0]}/finish`, { outcome: 'done', result: 'query captured.' });
    assert.equal(r.status, 200);
    await waitFor('second hopper node -> running (dependency satisfied)', async () => {
      const overlay = await get(`/goals/${goalId}/nodes/${machineChildId}/tree`);
      const second = overlay.json.nodes.find((n: any) => n.id === hopperNodeIds[1]);
      return second?.status === 'running';
    });
  });

  await check('7k', 'finish the second hopper node -> tree done -> goalsOnTreeStatus flips the goal node to check', async () => {
    const r = await post(`/hopper-nodes/${hopperNodeIds[1]}/finish`, { outcome: 'done', result: 'rule registered + reviewed.' });
    assert.equal(r.status, 200);
    await waitFor('goal node -> check (tree_done)', async () => {
      const node = await get(`/goals/${goalId}`).then((res) => res.json.nodes.find((n: any) => n.id === machineChildId));
      return node?.state === 'check' && node?.tree_status_cache === 'done';
    });
    const treeRow = await get(`/hopper-trees/${treeId}`);
    assert.equal(treeRow.json.tree.status, 'done');
  });

  await check('7l', 'verify passed:false reopens check->set, plan_state resets to none (tree_id kept for reference)', async () => {
    const r = await post(`/goals/${goalId}/nodes/${machineChildId}/verify`, { passed: false, note: 'not quite — reopening as a drill' });
    assert.equal(r.status, 200);
    assert.equal(r.json.node.state, 'set');
    assert.equal(r.json.node.plan_state, 'none');
    assert.ok(r.json.node.tree_id, 'tree_id kept for reference after reopen');
  });

  await check('7m', 're-propose + re-approve a plan after reopen plants a NEW tree', async () => {
    const propose = await post(`/goals/${goalId}/nodes/${machineChildId}/propose_plan`, {
      plan: {
        what: 'same work, one node this time.', deliverable: 'rule id', model: 'claude-sonnet-5', adapter: 'claude',
        nodes: [{ title: 'Capture + register in one pass', spec: 'x', adapter: 'claude', model: 'claude-sonnet-5' }],
      },
    });
    assert.equal(propose.status, 200);
    const approve = await post(`/goals/${goalId}/nodes/${machineChildId}/approve_plan`, {});
    assert.equal(approve.status, 200);
    assert.notEqual(approve.json.tree.id, treeId, 'a fresh approve after reopen must plant a NEW tree');
    treeId = approve.json.tree.id;
    hopperNodeIds.length = 0;
    for (const n of approve.json.hopper_nodes) hopperNodeIds.push(n.id);
    await waitFor('new hopper node -> running', async () => {
      const overlay = await get(`/goals/${goalId}/nodes/${machineChildId}/tree`);
      return overlay.json.nodes.some((n: any) => n.status === 'running');
    });
    const fin = await post(`/hopper-nodes/${hopperNodeIds[0]}/finish`, { outcome: 'done', result: 'done, second time for real.' });
    assert.equal(fin.status, 200);
    await waitFor('goal node -> check again', async () => {
      const node = await get(`/goals/${goalId}`).then((res) => res.json.nodes.find((n: any) => n.id === machineChildId));
      return node?.state === 'check';
    });
  });

  await check('7n', 'verify passed:true -> done, verified_at set', async () => {
    const r = await post(`/goals/${goalId}/nodes/${machineChildId}/verify`, { passed: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.node.state, 'done');
    assert.ok(r.json.node.verified_at);
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[8] human leaf: human_done -> check -> verify -> done; then parent auto-check');
  await check('8a', 'human_done on the human leaf -> check', async () => {
    const r = await post(`/goals/${goalId}/nodes/${humanChildId}/human_done`, { note: 'redirect is live' });
    assert.equal(r.status, 200);
    assert.equal(r.json.node.state, 'check');
  });

  await check('8b', 'verify the human leaf -> done', async () => {
    const r = await post(`/goals/${goalId}/nodes/${humanChildId}/verify`, { passed: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.node.state, 'done');
  });

  await check('8c', 'PARENT AUTO-CHECK: Media-buy stats had exactly these 2 children, both now done -> auto-flips to check', async () => {
    const tree = await get(`/goals/${goalId}`);
    const parent = tree.json.nodes.find((n: any) => n.id === mediaBuyId);
    assert.equal(parent?.state, 'check', `expected parent auto-check, got ${parent?.state}`);
  });

  await check('8d', 'verify the parent -> done (explicit verify, not auto)', async () => {
    const r = await post(`/goals/${goalId}/nodes/${mediaBuyId}/verify`, { passed: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.node.state, 'done');
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[9] pending edit propose/resolve on a set node');
  await check('9a', 'propose_edit on a ghost -> 409 (JARVIS edits its own ghosts via PATCH, not propose_edit)', async () => {
    const ghost = await post(`/goals/${goalId}/nodes`, { title: 'temp ghost', done_means: 'x', authored_by: 'jarvis' });
    const r = await post(`/goals/${goalId}/nodes/${ghost.json.node.id}/propose_edit`, { title: 'edited ghost', actor: 'jarvis' });
    assert.equal(r.status, 409);
    await post(`/goals/${goalId}/nodes/${ghost.json.node.id}/discard`, {});
  });

  await check('9b', 'propose_edit on the set QB node -> pending_title/pending_done_means set, node.state stays set', async () => {
    const r = await post(`/goals/${goalId}/nodes/${qbId}/propose_edit`, {
      title: 'QB reconciliation (monthly)',
      done_means: 'monthly totals match QB within $1, reconciled by the 5th business day',
      actor: 'jarvis',
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.node.state, 'set');
    assert.equal(r.json.node.pending_title, 'QB reconciliation (monthly)');
    assert.equal(r.json.node.pending_by, 'jarvis');
  });

  await check('9c', 'resolve_pending {accept:true} -> title/done_means applied, pending cleared', async () => {
    const r = await post(`/goals/${goalId}/nodes/${qbId}/resolve_pending`, { accept: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.node.title, 'QB reconciliation (monthly)');
    assert.equal(r.json.node.pending_title, null);
    assert.equal(r.json.node.pending_by, null);
  });

  await check('9d', 'a SECOND propose_edit + resolve_pending {accept:false} -> cleared, node UNCHANGED', async () => {
    const before = await get(`/goals/${goalId}`).then((r) => r.json.nodes.find((n: any) => n.id === qbId));
    const p = await post(`/goals/${goalId}/nodes/${qbId}/propose_edit`, { title: 'a title Kevin will reject', actor: 'jarvis' });
    assert.equal(p.status, 200);
    const r = await post(`/goals/${goalId}/nodes/${qbId}/resolve_pending`, { accept: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.node.title, before.title, 'rejected edit must leave the node untouched');
    assert.equal(r.json.node.pending_title, null);
  });

  await check('9e', 'resolve_pending with nothing pending -> 409 nothing_pending', async () => {
    const r = await post(`/goals/${goalId}/nodes/${qbId}/resolve_pending`, { accept: true });
    assert.equal(r.status, 409);
  });

  await check('9f', 'propose_removal on the (now childless) Docs node, then accept -> discarded', async () => {
    const propose = await post(`/goals/${goalId}/nodes/${docsId}/propose_removal`, { reason: 'folding into the QB node' });
    assert.equal(propose.status, 200);
    assert.equal(propose.json.node.pending_removal, 1);
    const resolve = await post(`/goals/${goalId}/nodes/${docsId}/resolve_pending`, { accept: true });
    assert.equal(resolve.status, 200);
    assert.equal(resolve.json.node.state, 'discarded');
  });

  await check('9g', 'take the QB node (childless, leaf_kind still none) to done via the human-leaf path so the goal can eventually verify', async () => {
    const leaf = await post(`/goals/${goalId}/nodes/${qbId}/leaf_kind`, { leaf_kind: 'human' });
    assert.equal(leaf.status, 200);
    const done = await post(`/goals/${goalId}/nodes/${qbId}/human_done`, { note: 'reconciled by hand this cycle' });
    assert.equal(done.status, 200);
    assert.equal(done.json.node.state, 'check');
    const verified = await post(`/goals/${goalId}/nodes/${qbId}/verify`, { passed: true });
    assert.equal(verified.status, 200);
    assert.equal(verified.json.node.state, 'done');
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[10] promote a node to its own goal');
  let promotedGoalId = -1;
  await check('10a', 'promote the Kevin-dictated root node -> new goal, thread, back-link', async () => {
    const r = await post(`/goals/${goalId}/nodes/${kevinNodeId}/promote`, {});
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.goal.status, 'set');
    assert.equal(r.json.goal.promoted_from_node_id, kevinNodeId);
    promotedGoalId = r.json.goal.id;
    assert.equal(r.json.thread.external_id, `cockpit:goal-${promotedGoalId}`);
    assert.equal(r.json.thread.created, true);
    assert.ok(typeof r.json.thread.seed_text === 'string' && r.json.thread.seed_text.length > 0);
    assert.equal(r.json.node.promoted_to_goal_id, promotedGoalId);
  });

  await check('10b', 're-promoting an already-promoted node -> 409 already_promoted', async () => {
    const r = await post(`/goals/${goalId}/nodes/${kevinNodeId}/promote`, {});
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'already_promoted');
  });

  await check('10c', 'new goal reaching done flips the stub node to check (back in the ORIGINAL goal)', async () => {
    const newGoalTree = await get(`/goals/${promotedGoalId}`);
    assert.equal(newGoalTree.status, 200);
    assert.equal(newGoalTree.json.nodes.length, 0, 'promoted node had no children to move');
    const verified = await post(`/goals/${promotedGoalId}/verify`, { passed: true });
    assert.equal(verified.status, 200, JSON.stringify(verified.json));
    assert.equal(verified.json.goal.status, 'done');

    const stub = await get(`/goals/${goalId}`).then((r) => r.json.nodes.find((n: any) => n.id === kevinNodeId));
    assert.equal(stub?.state, 'check', 'promoted stub must flip to check once the new goal is done');
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[11] goal verify preconditions');
  await check('11a', 'POST /goals/:id/verify with non-done children -> 409 children_not_done', async () => {
    // kevinNodeId(stub, check) needs its own verify; the rest may still be open.
    const r = await post(`/goals/${goalId}/verify`, { passed: true });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'children_not_done');
  });

  await check('11b', 'verify the stub node -> done; then goal verify succeeds once every non-discarded/non-parked node is done', async () => {
    const stubVerify = await post(`/goals/${goalId}/nodes/${kevinNodeId}/verify`, { passed: true });
    assert.equal(stubVerify.status, 200);
    assert.equal(stubVerify.json.node.state, 'done');

    const r = await post(`/goals/${goalId}/verify`, { passed: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.goal.status, 'done');
    assert.ok(r.json.goal.verified_at);
  });

  await check('11c', 'goal park/unpark — only legal from status=set (a ghost goal cannot be parked, per CONTRACT §2.2)', async () => {
    const ghost = await post('/goals', { title: 'park/unpark drill (still a ghost)' });
    const ghostParkAttempt = await post(`/goals/${ghost.json.goal.id}/park`, {});
    assert.equal(ghostParkAttempt.status, 409, 'a ghost goal has no park transition in CONTRACT §2.2');

    const fresh = await post('/goals', { title: 'park/unpark drill', done_means: 'exists for this one assertion' });
    const gid = fresh.json.goal.id;
    const parked = await post(`/goals/${gid}/park`, {});
    assert.equal(parked.status, 200, JSON.stringify(parked.json));
    assert.equal(parked.json.goal.status, 'parked');
    const unparked = await post(`/goals/${gid}/unpark`, {});
    assert.equal(unparked.status, 200);
    assert.equal(unparked.json.goal.status, 'set');
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[12] focus-injection helper: buildGoalThreadContext');
  await check('12a', "buildGoalThreadContext on a non-goal thread ext returns ''", () => {
    const block = goalsModule.buildGoalThreadContext('cockpit:some-random-thread');
    assert.equal(block, '');
  });

  await check('12b', "buildGoalThreadContext on a goal thread ext for a goal that doesn't exist returns ''", () => {
    const block = goalsModule.buildGoalThreadContext('cockpit:goal-999999');
    assert.equal(block, '');
  });

  await check(
    '12c',
    "buildGoalThreadContext on the promoted goal (focus=none) renders <goal_focus/> + <goal_tree> with root-level nodes " +
      "(CONTRACT §6's example only shows a FOCUSED render; the no-focus attrs come back as empty strings rather than " +
      "the literal 'null' — a defensible reading, not asserted as a bug, but worth REVIEW-BACKEND's eyes since a " +
      "focus_node_id-driven prompt template downstream might expect one or the other)",
    async () => {
      const block: string = goalsModule.buildGoalThreadContext(`cockpit:goal-${promotedGoalId}`);
      assert.match(block, /^<goal_focus goal_id="\d+" node_id="[^"]*"/);
      assert.match(block, /<goal_tree goal_id="\d+" status="done"/);
      assert.match(block, /^# .+ — done: /m);
      assert.ok(block.trimEnd().endsWith('</goal_tree>'), 'block must be exactly the two tags, nothing appended after');
    },
  );

  await check('12d', 'buildGoalThreadContext respects focus + collapse: focused node shows siblings/children, unrelated branches collapse', async () => {
    // Build a small multi-branch fixture on goalId (already done/verified but
    // still readable — nodes are terminal, not deleted).
    const focusTarget = mediaBuyId; // done, but still a real node with 2 children
    await put(`/goals/${goalId}/focus`, { node_id: focusTarget });
    const block: string = goalsModule.buildGoalThreadContext(`cockpit:goal-${goalId}`);
    assert.match(block, new RegExp(`node_id="${focusTarget}"`));
    assert.match(block, /▶/, 'focused node must carry the ▶ marker');
    assert.match(block, /Create monitoring|Capture \+ register/, 'focused node\'s children must render');
    assert.ok(block.split('\n').length <= 62, 'must respect the ~60-line cap (+ a little slack for the two tag lines)');
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[13] SSE breadth: goal/goal_node/goal_focus reach BOTH admin and non-admin keys');
  await sleep(300); // let the streams catch up on everything emitted above
  await check('13a', 'admin-scope (cockpit) SSE stream saw goal, goal_node, and goal_focus events', () => {
    const types = new Set(sseAdmin.events.map((e) => e.type));
    assert.ok(types.has('goal'), 'missing goal event on admin stream');
    assert.ok(types.has('goal_node'), 'missing goal_node event on admin stream');
    assert.ok(types.has('goal_focus'), 'missing goal_focus event on admin stream');
  });
  await check('13b', 'non-admin-scope (jarvis) SSE stream ALSO saw all three (global events are not thread-scoped)', () => {
    const types = new Set(sseNonAdmin.events.map((e) => e.type));
    assert.ok(types.has('goal'), 'missing goal event on non-admin stream');
    assert.ok(types.has('goal_node'), 'missing goal_node event on non-admin stream');
    assert.ok(types.has('goal_focus'), 'missing goal_focus event on non-admin stream');
  });
  await check('13c', 'a batch propose carries a shared batch_id across its goal_node events', () => {
    const batchEvents = sseAdmin.events.filter((e: any) => e.type === 'goal_node' && e.batch_id === batchId);
    assert.ok(batchEvents.length >= 3, `expected >=3 goal_node events sharing batch_id ${batchId}, got ${batchEvents.length}`);
  });

  sseAdmin.close();
  sseNonAdmin.close();

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[14] auth: no bearer token -> 401 (same bearerAuth as every other /api/v1 route)');
  await check('14a', 'GET /goals with no Authorization header -> 401', async () => {
    const res = await fetch(`${base}/goals`);
    assert.equal(res.status, 401);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // v0.1 §11 — Kevin edits a ghost -> JARVIS weighs in (agree / push_back).
  // CONTRACT.md §11, checks V01-1..V01-9 (node #471). Drives the same real
  // HTTP path as every check above; the only new machinery is the agent.js
  // stub registered at the top of this file, which lets fireGoalReviewCue run
  // for real (composes + "sends" the cue) without a live model call.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[15] v0.1 §11: Kevin edits a ghost -> JARVIS weighs in (accept / push_back)');
  let v01GoalId = -1;
  let v01NodeId = -1;
  await check('V01-0', 'setup: fresh set goal + one jarvis-proposed ghost, focused on it', async () => {
    const g = await post('/goals', { title: 'v0.1 weigh-in drill', done_means: 'prove the edit-review loop end to end' });
    assert.equal(g.status, 201, JSON.stringify(g.json));
    v01GoalId = g.json.goal.id;
    const p = await post(`/goals/${v01GoalId}/nodes/propose`, {
      parent_id: null,
      items: [{ title: 'Ship the thing', done_means: 'thing is shipped and verified' }],
      actor: 'jarvis',
    });
    assert.equal(p.status, 201);
    v01NodeId = p.json.nodes[0].id;
    const f = await put(`/goals/${v01GoalId}/focus`, { node_id: v01NodeId });
    assert.equal(f.status, 200);
  });

  await check('V01-1', "Kevin PATCH on the ghost -> last_edited_by=kevin, kevin_edit_original snapshots the JARVIS wording, event ghost_edited_by_kevin", async () => {
    const before = await get(`/goals/${v01GoalId}`).then((r) => r.json.nodes.find((n: any) => n.id === v01NodeId));
    const r = await patch(`/goals/${v01GoalId}/nodes/${v01NodeId}`, {
      title: 'Ship the thing FAST',
      done_means: 'thing is shipped, verified, and fast',
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.node.last_edited_by, 'kevin');
    assert.ok(r.json.node.kevin_edit_original, 'expected a kevin_edit_original snapshot');
    const orig = JSON.parse(r.json.node.kevin_edit_original);
    assert.equal(orig.title, before.title, 'snapshot must capture the JARVIS wording from BEFORE this edit');
    assert.equal(orig.done_means, before.done_means);
    const events = await get(`/goals/${v01GoalId}/events`);
    assert.ok(
      events.json.events.some((e: any) => e.kind === 'ghost_edited_by_kevin' && e.node_id === v01NodeId),
      'expected a ghost_edited_by_kevin event',
    );
  });

  await check('V01-2', 'a SECOND Kevin PATCH does not overwrite the original snapshot', async () => {
    const firstSnapshot = await get(`/goals/${v01GoalId}`).then(
      (r) => r.json.nodes.find((n: any) => n.id === v01NodeId).kevin_edit_original,
    );
    const r = await patch(`/goals/${v01GoalId}/nodes/${v01NodeId}`, { title: 'Ship the thing FASTER STILL' });
    assert.equal(r.status, 200);
    assert.equal(r.json.node.kevin_edit_original, firstSnapshot, "the original JARVIS wording must survive a second Kevin edit");
    assert.equal(r.json.node.last_edited_by, 'kevin');
  });

  let v01CueEventId = -1;
  await check('V01-3', "Kevin accept -> stays ghost, review_state=awaiting_jarvis, event kevin_okd_edit, exactly ONE cue matching §11.3 (now/was + correlationKey)", async () => {
    const before = cueCallCount();
    const r = await post(`/goals/${v01GoalId}/nodes/${v01NodeId}/accept`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.node.state, 'ghost', "a Kevin-edited ghost must NOT solidify on Kevin's own accept");
    assert.equal(r.json.node.review_state, 'awaiting_jarvis');
    const events = await get(`/goals/${v01GoalId}/events`);
    const ev = events.json.events.filter((e: any) => e.kind === 'kevin_okd_edit' && e.node_id === v01NodeId);
    assert.equal(ev.length, 1);
    v01CueEventId = ev[0].id;
    await waitForCueCalls(before + 1);
    assert.equal(cueCallCount(), before + 1, 'expected exactly ONE cue call for this accept');
    const cue = lastCueCall();
    assert.equal(cue.externalId, `cockpit:goal-${v01GoalId}`);
    assert.match(cue.text, /now: "Ship the thing FASTER STILL"/);
    assert.match(cue.text, /was \(yours\): "Ship the thing"/);
    assert.equal(cue.correlationKey, `goal-cue:${v01GoalId}:${v01CueEventId}`);
  });

  await check('V01-4', 'Kevin accept AGAIN while awaiting -> 409 awaiting_jarvis, no extra cue', async () => {
    const before = cueCallCount();
    const r = await post(`/goals/${v01GoalId}/nodes/${v01NodeId}/accept`, {});
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'awaiting_jarvis');
    await sleep(150);
    assert.equal(cueCallCount(), before, 're-click while awaiting must not fire a second cue');
  });

  await check('V01-5', "JARVIS push_back -> stays ghost, review_state=pushed_back, review_note set, event jarvis_pushed_back", async () => {
    const note = 'Let\'s not promise "fast" until we\'ve actually measured it.';
    const r = await post(`/goals/${v01GoalId}/nodes/${v01NodeId}/push_back`, { note });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.node.state, 'ghost');
    assert.equal(r.json.node.review_state, 'pushed_back');
    assert.equal(r.json.node.review_note, note);
    const events = await get(`/goals/${v01GoalId}/events`);
    assert.ok(events.json.events.some((e: any) => e.kind === 'jarvis_pushed_back' && e.node_id === v01NodeId));
  });

  await check('V01-6', 'Kevin accept AGAIN (re-ask, no further edit) -> awaiting_jarvis, cue quotes the push-back note', async () => {
    const before = cueCallCount();
    const r = await post(`/goals/${v01GoalId}/nodes/${v01NodeId}/accept`, {});
    assert.equal(r.status, 200);
    assert.equal(r.json.node.state, 'ghost');
    assert.equal(r.json.node.review_state, 'awaiting_jarvis');
    await waitForCueCalls(before + 1);
    assert.equal(cueCallCount(), before + 1);
    const cue = lastCueCall();
    assert.match(cue.text, /you pushed back with:/);
  });

  await check('V01-7', 'JARVIS accept -> set, all four review fields cleared, event node_agreed', async () => {
    const r = await post(`/goals/${v01GoalId}/nodes/${v01NodeId}/accept`, { actor: 'jarvis' });
    assert.equal(r.status, 200);
    assert.equal(r.json.node.state, 'set');
    assert.equal(r.json.node.review_state, 'none');
    assert.equal(r.json.node.review_note, null);
    assert.equal(r.json.node.last_edited_by, null);
    assert.equal(r.json.node.kevin_edit_original, null);
    const events = await get(`/goals/${v01GoalId}/events`);
    assert.ok(events.json.events.some((e: any) => e.kind === 'node_agreed' && e.node_id === v01NodeId));
  });

  let v01Node2Id = -1;
  await check('V01-8a', 'setup: a second ghost, Kevin edits it', async () => {
    const p = await post(`/goals/${v01GoalId}/nodes/propose`, {
      parent_id: null,
      items: [{ title: 'Second thing', done_means: 'second thing is done' }],
      actor: 'jarvis',
    });
    assert.equal(p.status, 201);
    v01Node2Id = p.json.nodes[0].id;
    const patched = await patch(`/goals/${v01GoalId}/nodes/${v01Node2Id}`, { title: 'Second thing (Kevin edit)' });
    assert.equal(patched.status, 200);
    assert.equal(patched.json.node.last_edited_by, 'kevin');
  });

  await check('V01-8b', "JARVIS edit_ghost (PATCH as actor=jarvis) on the Kevin-edited ghost -> last_edited_by=jarvis, review_state=none (JARVIS takes the last word)", async () => {
    const r = await patch(`/goals/${v01GoalId}/nodes/${v01Node2Id}`, { title: 'Second thing (JARVIS reworded)', actor: 'jarvis' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.node.last_edited_by, 'jarvis');
    assert.equal(r.json.node.review_state, 'none');
  });

  await check('V01-8c', 'Kevin accept -> sets directly, v0 path, no awaiting round, no cue', async () => {
    const before = cueCallCount();
    const r = await post(`/goals/${v01GoalId}/nodes/${v01Node2Id}/accept`, {});
    assert.equal(r.status, 200);
    assert.equal(r.json.node.state, 'set');
    await sleep(150);
    assert.equal(cueCallCount(), before, 'the v0 accept path must not fire a review cue');
  });

  let v01BatchId = '';
  let v01MixIds: number[] = [];
  await check('V01-9a', 'setup: propose 3 ghosts in one batch; Kevin edits 2 of them, leaves 1 untouched', async () => {
    const p = await post(`/goals/${v01GoalId}/nodes/propose`, {
      parent_id: null,
      items: [
        { title: 'Batch A', done_means: 'A done' },
        { title: 'Batch B', done_means: 'B done' },
        { title: 'Batch C', done_means: 'C done' },
      ],
      actor: 'jarvis',
    });
    assert.equal(p.status, 201);
    v01BatchId = p.json.batch_id;
    v01MixIds = p.json.nodes.map((n: any) => n.id);
    const [aId, bId] = v01MixIds;
    const pa = await patch(`/goals/${v01GoalId}/nodes/${aId}`, { title: 'Batch A (Kevin edit)' });
    assert.equal(pa.status, 200);
    const pb = await patch(`/goals/${v01GoalId}/nodes/${bId}`, { title: 'Batch B (Kevin edit)' });
    assert.equal(pb.status, 200);
  });

  await check('V01-9b', 'batch accept -> the 2 kevin-edited nodes stay ghost/awaiting, the untouched one sets; ONE cue listing only the awaiting ones; counts.awaiting_jarvis correct', async () => {
    const before = cueCallCount();
    const r = await post(`/goals/${v01GoalId}/batches/${v01BatchId}/accept`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const [aId, bId, cId] = v01MixIds;
    const byId = new Map(r.json.nodes.map((n: any) => [n.id, n]));
    assert.equal(byId.get(aId).state, 'ghost');
    assert.equal(byId.get(aId).review_state, 'awaiting_jarvis');
    assert.equal(byId.get(bId).state, 'ghost');
    assert.equal(byId.get(bId).review_state, 'awaiting_jarvis');
    assert.equal(byId.get(cId).state, 'set', 'the untouched-by-Kevin ghost must set normally in the same batch call');

    await waitForCueCalls(before + 1);
    assert.equal(cueCallCount(), before + 1, 'expected exactly ONE cue for the whole batch accept request');
    const cue = lastCueCall();
    assert.match(cue.text, /Kevin edited 2 of your proposals/);
    assert.ok(cue.text.includes(`#${aId}`), 'cue must list the first awaiting node');
    assert.ok(cue.text.includes(`#${bId}`), 'cue must list the second awaiting node');
    assert.ok(!cue.text.includes(`#${cId} now:`), 'the untouched-and-set node must NOT appear in the cue');

    const tree = await get(`/goals/${v01GoalId}`);
    assert.equal(tree.json.goal.counts.awaiting_jarvis, 2, 'GoalCounts.awaiting_jarvis must count exactly the 2 awaiting nodes');
  });

  await check('V01-9c', 'focus-injection snapshot on an awaiting node shows the ✎K marker + AWAITING YOUR TAKE suffix', async () => {
    const [aId] = v01MixIds;
    await put(`/goals/${v01GoalId}/focus`, { node_id: aId });
    const block: string = goalsModule.buildGoalThreadContext(`cockpit:goal-${v01GoalId}`);
    assert.match(block, /✎K/);
    assert.match(block, /AWAITING YOUR TAKE/);
  });

  // --- review-node additions (#472): a PATCH that changes no text is not an edit ---
  await check('V01-10', 'a no-op Kevin PATCH (same text) does NOT flip last_edited_by / reset an open round', async () => {
    const [aId] = v01MixIds;              // still ghost + awaiting_jarvis from V01-9b
    const before = cueCallCount();
    const node = (await get(`/goals/${v01GoalId}`)).json.nodes.find((n: any) => n.id === aId);
    assert.equal(node.review_state, 'awaiting_jarvis', 'precondition: node is mid weigh-in');
    const r = await patch(`/goals/${v01GoalId}/nodes/${aId}`, { title: node.title, done_means: node.done_means });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.node.review_state, 'awaiting_jarvis', 'a bare re-save must not cancel the round JARVIS is answering');
    assert.equal(r.json.node.last_edited_by, 'kevin');
    await sleep(120);
    assert.equal(cueCallCount(), before, 'no-op PATCH fires no cue');
  });

  await check('V01-11', 'a sort_order-only PATCH does NOT mark a JARVIS ghost as Kevin-edited', async () => {
    const p1 = await post(`/goals/${v01GoalId}/nodes`, {
      title: 'Reorder me', done_means: 'it exists', authored_by: 'jarvis', actor: 'jarvis',
    });
    assert.equal(p1.status, 201, JSON.stringify(p1.json));
    const id = p1.json.node.id;
    assert.equal(p1.json.node.state, 'ghost');
    const r = await patch(`/goals/${v01GoalId}/nodes/${id}`, { sort_order: 42 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.node.sort_order, 42);
    assert.equal(r.json.node.last_edited_by, null, 'a reorder is not an edit — the last word stays with JARVIS');
    assert.equal(r.json.node.kevin_edit_original, null);
    // ...so Kevin's ✓ still solidifies it directly (v0 path).
    const acc = await post(`/goals/${v01GoalId}/nodes/${id}/accept`, {});
    assert.equal(acc.status, 200, JSON.stringify(acc.json));
    assert.equal(acc.json.node.state, 'set');
  });

  await check('V01-12', 'JARVIS accept on a ghost Kevin edited but has not OK\'d yet -> sets, logged as node_agreed', async () => {
    const p1 = await post(`/goals/${v01GoalId}/nodes`, {
      title: 'JARVIS wording', done_means: 'jarvis done', authored_by: 'jarvis', actor: 'jarvis',
    });
    const id = p1.json.node.id;
    const ed = await patch(`/goals/${v01GoalId}/nodes/${id}`, { title: 'Kevin wording' });
    assert.equal(ed.json.node.last_edited_by, 'kevin');
    assert.equal(ed.json.node.review_state, 'none', 'Kevin has not clicked OK yet');
    const acc = await post(`/goals/${v01GoalId}/nodes/${id}/accept`, { actor: 'jarvis' });
    assert.equal(acc.status, 200, JSON.stringify(acc.json));
    assert.equal(acc.json.node.state, 'set');
    assert.equal(acc.json.node.last_edited_by, null);
    const ev = (await get(`/goals/${v01GoalId}/events?limit=500`)).json.events.find((e: any) => e.node_id === id && e.kind === 'node_agreed');
    assert.ok(ev, 'the non-editing party approving Kevin\'s wording is an agreement, not a bare accept');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // v0.2 §12 — Guards: every done_means can become a monitored Overwatch
  // rule. CONTRACT.md §12, checks G-1..G-9 (node #478). Drives the same real
  // HTTP path as every check above, against a FAKE Overwatch HTTP server on a
  // throwaway port (mirrors scripts/goals-guards-check.mjs) — never a live
  // Overwatch, never a live model call (the guard cue is stubbed by
  // goals-guards-sim-cue.hooks.mjs registered at the top of this file, onto
  // the same __goalsCueCalls array the v0.1 section already reads via
  // cueCalls()/waitForCueCalls()). Guarded on `goalId` (the same goal used by
  // sections [1]-[14]): `machineChildId` is `done` (from check 7n) and
  // untouched since, `kevinNodeId` is `set`/unverified (from check 2b).
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[16] v0.2 §12: Guards — done_means -> a monitored Overwatch rule');

  const needYouBaseline = (await get(`/goals/${goalId}`)).json.goal.counts.need_you;

  const OW_KEY = 'sim-ow-key';
  const owState = {
    createBodies: [] as Record<string, unknown>[],
    patchBodies: [] as { key: string; body: Record<string, unknown> }[],
    deleteKeys: [] as string[],
    results: new Map<string, { status: string; value: number | null; summary: string | null; at: string } | null>(),
    next422OnPatch: false,
    next404OnDelete: false,
    createDelayMs: 0, // review R-2: slow the create so two accepts overlap
    seq: 0,
  };
  function owSlug(name: string): string {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'rule';
  }
  owServer = http.createServer((httpReq, httpRes) => {
    const chunks: Buffer[] = [];
    httpReq.on('data', (c) => chunks.push(c as Buffer));
    httpReq.on('end', () => {
      const auth = httpReq.headers['authorization'] ?? '';
      const url = httpReq.url ?? '';
      const send = (code: number, obj: unknown) => {
        httpRes.writeHead(code, { 'Content-Type': 'application/json' });
        httpRes.end(JSON.stringify(obj));
      };
      if (auth !== `Bearer ${OW_KEY}`) { send(401, { error: 'Unauthorized' }); return; }
      let body: Record<string, unknown> = {};
      if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { body = {}; } }
      const m = /^\/api\/v1\/overwatch\/rules(?:\/([^/?]+))?/.exec(url);
      const key = m && m[1] ? decodeURIComponent(m[1]) : null;

      if (httpReq.method === 'POST' && !key) {
        owState.createBodies.push(body);
        const k = `prompt.${owSlug(String(body.name ?? 'rule'))}-${(++owState.seq).toString(16).padStart(4, '0')}`;
        owState.results.set(k, null);
        const reply = () => send(201, { ...body, key: k, dashboard_url: 'https://health.thedarwinhub.com/overwatch', last_result: null, created: true });
        if (owState.createDelayMs > 0) setTimeout(reply, owState.createDelayMs); else reply();
        return;
      }
      if (httpReq.method === 'GET' && key) {
        if (!owState.results.has(key)) { send(404, { error: `No prompt rule found for ${key}` }); return; }
        send(200, { key, last_result: owState.results.get(key) });
        return;
      }
      if (httpReq.method === 'PATCH' && key) {
        if (owState.next422OnPatch) { owState.next422OnPatch = false; send(422, { error: 'sql was rejected: bad column' }); return; }
        owState.patchBodies.push({ key, body });
        send(200, { key, ...body });
        return;
      }
      if (httpReq.method === 'DELETE' && key) {
        owState.deleteKeys.push(key);
        if (owState.next404OnDelete) { owState.next404OnDelete = false; send(404, { error: 'not found' }); return; }
        owState.results.delete(key);
        send(200, { deleted: true, key });
        return;
      }
      send(400, { error: 'bad request' });
    });
  });
  await new Promise<void>((resolve) => owServer!.listen(0, '127.0.0.1', () => resolve()));
  const owAddress = owServer!.address();
  const owPort = typeof owAddress === 'object' && owAddress ? owAddress.port : 0;
  const OW_URL = `http://127.0.0.1:${owPort}`;
  console.log(`[goals-sim] fake Overwatch: ${OW_URL}`);

  function setOverwatchConfigured(on: boolean): void {
    if (on) {
      process.env.OVERWATCH_API_URL = OW_URL;
      process.env.OVERWATCH_API_KEY = OW_KEY;
    } else {
      delete process.env.OVERWATCH_API_URL;
      delete process.env.OVERWATCH_API_KEY;
    }
  }
  process.env.GOALS_GUARD_WEBHOOK_SECRET = 'sim-webhook-secret';
  setOverwatchConfigured(false); // starts unconfigured — G-2a needs this

  const sseGuards = captureSSE(cockpitKey);
  await sleep(150);

  await check('G-1a', 'propose_guard on a set (unverified) node -> 409 node_not_verifiable', async () => {
    // goalId's own goal reached status='done' back in [11b] (every node must
    // be done/parked/discarded to verify a goal), so by now it has no 'set'
    // node left to demonstrate this precondition on. v01GoalId (still status
    // 'set', §15) does — v01Node2Id sat 'set' since V01-8c and is untouched
    // since. propose_guard's node-scoped precondition only reads the NODE's
    // own state, not its parent goal's status, so this is a faithful check.
    const r = await post(`/goals/${v01GoalId}/guards/propose`, {
      node_id: v01Node2Id, mode: 'query', title: 'guard on an unverified node',
      sql: 'select 1 as v', comparator: 'gte', threshold: 1,
    });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.error.code, 'node_not_verifiable');
  });

  let guardId = -1;
  await check('G-1b', 'propose_guard on a done node (query mode) -> 201 ghost, nothing written to Overwatch, event guard_proposed', async () => {
    const eventsBefore = (await get(`/goals/${goalId}/events?limit=1000`)).json.events.length;
    const r = await post(`/goals/${goalId}/guards/propose`, {
      node_id: machineChildId,
      mode: 'query',
      title: 'rule registered + reviewed stays true',
      sql: 'select count(*) as v from x where 1=1',
      comparator: 'gte',
      threshold: 1,
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.guard.state, 'ghost');
    assert.equal(r.json.guard.node_id, machineChildId);
    assert.equal(r.json.guard.overwatch_key, null);
    assert.equal(owState.createBodies.length, 0, 'a ghost must not touch Overwatch');
    guardId = r.json.guard.id;
    const events = await get(`/goals/${goalId}/events?limit=1000`);
    assert.ok(events.json.events.length > eventsBefore);
    assert.ok(events.json.events.some((e: any) => e.kind === 'guard_proposed' && e.node_id === machineChildId));
  });

  await check('G-1c', 'a second propose_guard on the same node -> 409 guard_exists', async () => {
    const r = await post(`/goals/${goalId}/guards/propose`, {
      node_id: machineChildId, mode: 'query', title: 'dupe', sql: 'select 1 as v', comparator: 'gte', threshold: 1,
    });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.error.code, 'guard_exists');
  });

  await check('G-2a', 'accept when Overwatch is not configured -> 503 overwatch_not_connected (clean HTTP error, no throw to the caller); guard stays a ghost', async () => {
    const r = await post(`/goals/${goalId}/guards/${guardId}/accept`, {});
    assert.equal(r.status, 503, JSON.stringify(r.json));
    assert.equal(r.json.error.code, 'overwatch_not_connected');
    const g = await get(`/goals/${goalId}/guards/${guardId}`);
    assert.equal(g.status, 200);
    assert.equal(g.json.guard.state, 'ghost');
    assert.equal(g.json.guard.health, 'unknown');
  });

  await check('G-2b', 'Kevin PATCH on the ghost updates sql/threshold/title before it is ever written to Overwatch, event guard_updated', async () => {
    const r = await patch(`/goals/${goalId}/guards/${guardId}`, {
      title: 'rule registered + reviewed stays true (tightened)',
      sql: 'select count(*) as v from x where 1=1 and y=2',
      threshold: 2,
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.guard.threshold, 2);
    assert.match(r.json.guard.sql, /y=2/);
    const events = await get(`/goals/${goalId}/events?limit=1000`);
    assert.ok(events.json.events.some((e: any) => e.kind === 'guard_updated' && e.node_id === machineChildId));
  });

  let owKey = '';
  await check('G-2c', 'accept with Overwatch configured -> POSTs the exact §12 body, state=set, overwatch_key stored, health=unknown, event guard_set', async () => {
    setOverwatchConfigured(true);
    const before = owState.createBodies.length;
    const r = await post(`/goals/${goalId}/guards/${guardId}/accept`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.guard.state, 'set');
    assert.equal(r.json.guard.health, 'unknown');
    assert.ok(r.json.guard.overwatch_key, 'expected an overwatch_key to be stored');
    owKey = r.json.guard.overwatch_key;
    assert.equal(owState.createBodies.length, before + 1);
    const owBody = owState.createBodies[owState.createBodies.length - 1];
    assert.equal(owBody.name, `Goal ${goalId} · node ${machineChildId} — rule registered + reviewed stays true (tightened)`);
    assert.equal(owBody.group, 'custom');
    assert.equal(owBody.severity, 'medium');
    assert.equal(owBody.mode, 'query');
    assert.equal(owBody.created_by, 'goals');
    assert.equal(owBody.sql, 'select count(*) as v from x where 1=1 and y=2');
    assert.equal(owBody.comparator, 'gte');
    assert.equal(owBody.threshold, 2);
    assert.equal(typeof owBody.cadence_minutes, 'number');
    assert.equal(typeof owBody.window_minutes, 'number');
    assert.ok(typeof owBody.description === 'string' && owBody.description.length > 0);
    const events = await get(`/goals/${goalId}/events?limit=1000`);
    assert.ok(events.json.events.some((e: any) => e.kind === 'guard_set' && e.node_id === machineChildId));
  });

  await check('G-2d', 're-accept an already-set guard -> 409 invalid_transition', async () => {
    const r = await post(`/goals/${goalId}/guards/${guardId}/accept`, {});
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.error.code, 'invalid_transition');
  });

  await check('G-3a', 'PATCH a SET guard pushes the change to Overwatch (PATCH /rules/{key}) and applies it locally', async () => {
    const before = owState.patchBodies.length;
    const r = await patch(`/goals/${goalId}/guards/${guardId}`, { threshold: 3 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.guard.threshold, 3);
    assert.equal(owState.patchBodies.length, before + 1);
    assert.equal(owState.patchBodies[owState.patchBodies.length - 1].key, owKey);
    assert.equal(owState.patchBodies[owState.patchBodies.length - 1].body.threshold, 3);
  });

  await check('G-3b', 'Overwatch 422 on PATCH -> 422 overwatch_rejected, local row unchanged', async () => {
    owState.next422OnPatch = true;
    const r = await patch(`/goals/${goalId}/guards/${guardId}`, { threshold: 99 });
    assert.equal(r.status, 422, JSON.stringify(r.json));
    assert.equal(r.json.error.code, 'overwatch_rejected');
    const g = await get(`/goals/${goalId}/guards/${guardId}`);
    assert.equal(g.json.guard.threshold, 3, 'threshold must remain the last successfully-applied value');
  });

  await check('G-4a', 'poller: unknown -> passing is a SILENT flip (SSE only) — no event, no cue', async () => {
    owState.results.set(owKey, { status: 'ok', value: 1, summary: 'holding steady', at: new Date().toISOString() });
    const before = cueCallCount();
    await guardsModule.pollGuardsOnce();
    const g = await get(`/goals/${goalId}/guards/${guardId}`);
    assert.equal(g.json.guard.health, 'passing');
    await sleep(120);
    assert.equal(cueCallCount(), before, 'unknown->passing must not fire a cue');
  });

  await check('G-4b', 'poller: passing -> failing fires guard_failed + ONE cue + counts.guards_failing=1 + snapshot shows 🛡✗', async () => {
    owState.results.set(owKey, { status: 'fail', value: 0, summary: 'condition broke', at: new Date().toISOString() });
    const before = cueCallCount();
    await guardsModule.pollGuardsOnce();
    const g = await get(`/goals/${goalId}/guards/${guardId}`);
    assert.equal(g.json.guard.health, 'failing');
    const events = await get(`/goals/${goalId}/events?limit=1000`);
    assert.ok(events.json.events.some((e: any) => e.kind === 'guard_failed' && e.node_id === machineChildId));
    await waitForCueCalls(before + 1);
    assert.equal(cueCallCount(), before + 1, 'expected exactly ONE cue for the health flip');
    const cue = lastCueCall();
    assert.equal(cue.externalId, `cockpit:goal-${goalId}`);
    assert.match(cue.text, /is FAILING/);
    assert.ok(cue.text.includes(`#${machineChildId}`), 'cue must name the node the guard is on');

    const tree = await get(`/goals/${goalId}`);
    assert.equal(tree.json.goal.counts.guards, 1);
    assert.equal(tree.json.goal.counts.guards_failing, 1);

    await put(`/goals/${goalId}/focus`, { node_id: machineChildId });
    const snapshot: string = goalsModule.buildGoalThreadContext(`cockpit:goal-${goalId}`);
    assert.match(snapshot, /guards_failing="1"/);
    assert.match(snapshot, /🛡✗ "condition broke"/);
  });

  await check('G-4c', 'a second identical poll tick (still failing) -> idempotent: no extra event, no extra cue', async () => {
    const beforeCue = cueCallCount();
    const beforeFailedEvents = (await get(`/goals/${goalId}/events?limit=1000`)).json.events.filter((e: any) => e.kind === 'guard_failed').length;
    await guardsModule.pollGuardsOnce();
    await sleep(120);
    assert.equal(cueCallCount(), beforeCue, 'no health change -> no cue');
    const afterFailedEvents = (await get(`/goals/${goalId}/events?limit=1000`)).json.events.filter((e: any) => e.kind === 'guard_failed').length;
    assert.equal(afterFailedEvents, beforeFailedEvents, 'no health change -> no new event');
  });

  await check('G-4d', 'poller: failing -> passing fires guard_recovered + cue, guards_failing back to 0', async () => {
    owState.results.set(owKey, { status: 'ok', value: 1, summary: 'back to normal', at: new Date().toISOString() });
    const before = cueCallCount();
    await guardsModule.pollGuardsOnce();
    await waitForCueCalls(before + 1);
    const g = await get(`/goals/${goalId}/guards/${guardId}`);
    assert.equal(g.json.guard.health, 'passing');
    const events = await get(`/goals/${goalId}/events?limit=1000`);
    assert.ok(events.json.events.some((e: any) => e.kind === 'guard_recovered' && e.node_id === machineChildId));
    const cue = lastCueCall();
    assert.match(cue.text, /RECOVERED/);
    const tree = await get(`/goals/${goalId}`);
    assert.equal(tree.json.goal.counts.guards_failing, 0);
  });

  await check('G-4e', "poller: status='error' fires guard_error + cue (distinct wording — the check itself, not necessarily the goal)", async () => {
    owState.results.set(owKey, { status: 'error', value: null, summary: 'Hub connection refused', at: new Date().toISOString() });
    const before = cueCallCount();
    await guardsModule.pollGuardsOnce();
    const g = await get(`/goals/${goalId}/guards/${guardId}`);
    assert.equal(g.json.guard.health, 'error');
    const events = await get(`/goals/${goalId}/events?limit=1000`);
    assert.ok(events.json.events.some((e: any) => e.kind === 'guard_error' && e.node_id === machineChildId));
    await waitForCueCalls(before + 1);
    const cue = lastCueCall();
    assert.match(cue.text, /ERRORED/);
    assert.match(cue.text, /the guard, not necessarily the goal/);
  });

  await check('G-5a', 'webhook: bad secret -> 401', async () => {
    const r = await fetch(`${base}/goals/guards/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goals-Guard-Secret': 'wrong-secret' },
      body: JSON.stringify({ key: owKey, status: 'ok' }),
    });
    assert.equal(r.status, 401);
  });

  await check('G-5b', 'webhook: good secret but unknown key -> 404 no_guard_for_key (ignored, not alarmed)', async () => {
    const r = await fetch(`${base}/goals/guards/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goals-Guard-Secret': 'sim-webhook-secret' },
      body: JSON.stringify({ key: 'prompt.does-not-exist-0000', status: 'ok' }),
    });
    assert.equal(r.status, 404);
    const j = await r.json();
    assert.equal(j.error.code, 'no_guard_for_key');
  });

  await check('G-5c', 'webhook: good secret + known key -> applies health via the SAME applyGuardHealth path as the poller (health flips, cue fires once)', async () => {
    const before = cueCallCount();
    const r = await fetch(`${base}/goals/guards/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goals-Guard-Secret': 'sim-webhook-secret' },
      body: JSON.stringify({ key: owKey, status: 'fail', value: 0, summary: 'webhook says it broke', ran_at: new Date().toISOString() }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
    const g = await get(`/goals/${goalId}/guards/${guardId}`);
    assert.equal(g.json.guard.health, 'failing');
    assert.equal(g.json.guard.last_summary, 'webhook says it broke');
    await waitForCueCalls(before + 1);
    assert.equal(cueCallCount(), before + 1);
  });

  await check('G-5d', 'webhook: secret unconfigured -> 503 webhook_secret_unset', async () => {
    const saved = process.env.GOALS_GUARD_WEBHOOK_SECRET;
    delete process.env.GOALS_GUARD_WEBHOOK_SECRET;
    try {
      const r = await fetch(`${base}/goals/guards/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goals-Guard-Secret': 'sim-webhook-secret' },
        body: JSON.stringify({ key: owKey, status: 'ok' }),
      });
      assert.equal(r.status, 503);
      const j = await r.json();
      assert.equal(j.error.code, 'webhook_secret_unset');
    } finally {
      process.env.GOALS_GUARD_WEBHOOK_SECRET = saved;
    }
  });

  await check('G-6a', 'discard a SET guard -> Overwatch DELETE called, state=discarded, event guard_discarded', async () => {
    const before = owState.deleteKeys.length;
    const r = await post(`/goals/${goalId}/guards/${guardId}/discard`, { reason: 'drill cleanup' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.guard.state, 'discarded');
    assert.equal(owState.deleteKeys.length, before + 1);
    assert.equal(owState.deleteKeys[owState.deleteKeys.length - 1], owKey);
    const events = await get(`/goals/${goalId}/events?limit=1000`);
    assert.ok(events.json.events.some((e: any) => e.kind === 'guard_discarded' && e.node_id === machineChildId));
  });

  await check('G-6b', 'a discarded guard drops out of guards/guards_failing, and the node can be guarded again', async () => {
    const tree = await get(`/goals/${goalId}`);
    assert.equal(tree.json.goal.counts.guards, 0);
    assert.equal(tree.json.goal.counts.guards_failing, 0);
    const r = await post(`/goals/${goalId}/guards/propose`, {
      node_id: machineChildId, mode: 'query', title: 'second guard on the same node', sql: 'select 1 as v', comparator: 'gte', threshold: 1,
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
  });

  let guardId2 = -1;
  await check('G-7a', 'accepting the second guard sets counts.guards=1/guards_failing=0 and the snapshot shows a plain 🛡 (healthy, not ✗)', async () => {
    const listed = await get(`/goals/${goalId}/guards`);
    guardId2 = listed.json.guards.filter((g: any) => g.state === 'ghost')[0].id;
    const r = await post(`/goals/${goalId}/guards/${guardId2}/accept`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.guard.state, 'set');
    assert.equal(r.json.guard.health, 'unknown');
    const tree = await get(`/goals/${goalId}`);
    assert.equal(tree.json.goal.counts.guards, 1);
    assert.equal(tree.json.goal.counts.guards_failing, 0);
    const snapshot: string = goalsModule.buildGoalThreadContext(`cockpit:goal-${goalId}`);
    assert.match(snapshot, / 🛡(?!✗)/, 'a set, non-failing guard should render a plain shield');
    assert.doesNotMatch(snapshot, /guards_failing="/, 'guards_failing attribute must be omitted when 0 (§12.11)');
  });

  await check('G-7b', 'discard tolerates an Overwatch 404 on DELETE (already gone) — still discards locally', async () => {
    owState.next404OnDelete = true;
    const r = await post(`/goals/${goalId}/guards/${guardId2}/discard`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.guard.state, 'discarded');
  });

  // ── review (node #479) additions ────────────────────────────────────────
  await check('R-1', 'GET /goals/:id/guards carries overwatch_connected (additive) so the UI can show the banner on load', async () => {
    setOverwatchConfigured(false);
    let r = await get(`/goals/${goalId}/guards`);
    assert.equal(r.status, 200);
    assert.equal(r.json.overwatch_connected, false);
    setOverwatchConfigured(true);
    r = await get(`/goals/${goalId}/guards`);
    assert.equal(r.json.overwatch_connected, true);
  });

  let guardId3 = -1;
  await check('R-2', 'accept race: two concurrent accepts on one ghost -> exactly ONE set, the loser gets 409 invalid_transition and its Overwatch rule is deleted (never two live rules); create description = the NODE done_means, never the goal\'s', async () => {
    const goalNow = await get(`/goals/${goalId}`);
    const nodeRow = goalNow.json.nodes.find((n: any) => n.id === machineChildId);
    const r0 = await post(`/goals/${goalId}/guards/propose`, {
      node_id: machineChildId, mode: 'query', title: 'race guard', sql: 'select 1 as v', comparator: 'gte', threshold: 1,
    });
    assert.equal(r0.status, 201, JSON.stringify(r0.json));
    guardId3 = r0.json.guard.id;
    const createsBefore = owState.createBodies.length;
    const deletesBefore = owState.deleteKeys.length;
    owState.createDelayMs = 150;
    const [a, b] = await Promise.all([
      post(`/goals/${goalId}/guards/${guardId3}/accept`, {}),
      post(`/goals/${goalId}/guards/${guardId3}/accept`, {}),
    ]);
    owState.createDelayMs = 0;
    const codes = [a.status, b.status].sort();
    assert.deepEqual(codes, [200, 409], `got ${a.status}/${b.status}: ${JSON.stringify(a.json)} ${JSON.stringify(b.json)}`);
    const loser = a.status === 409 ? a : b;
    assert.equal(loser.json.error.code, 'invalid_transition');
    assert.equal(owState.createBodies.length, createsBefore + 2, 'both accepts reached Overwatch create');
    await sleep(100); // the loser's compensating DELETE is fire-and-forget
    assert.equal(owState.deleteKeys.length, deletesBefore + 1, 'the loser deleted its own rule');
    const g = await get(`/goals/${goalId}/guards/${guardId3}`);
    assert.equal(g.json.guard.state, 'set');
    assert.ok(g.json.guard.overwatch_key);
    assert.ok(!owState.deleteKeys.includes(g.json.guard.overwatch_key), 'the winner\'s rule was NOT deleted');
    assert.equal(owState.createBodies[createsBefore].description, nodeRow.done_means, 'node guard description = node done_means');
  });

  await check('R-3', 'discard a SET guard while Overwatch is unconfigured -> discards locally, last_summary says the delete was skipped (rule may still exist)', async () => {
    setOverwatchConfigured(false);
    const deletesBefore = owState.deleteKeys.length;
    const r = await post(`/goals/${goalId}/guards/${guardId3}/discard`, {});
    setOverwatchConfigured(true);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.guard.state, 'discarded');
    assert.match(String(r.json.guard.last_summary), /delete skipped/);
    assert.equal(owState.deleteKeys.length, deletesBefore, 'no Overwatch call while unconfigured');
  });

  await check('G-8a', 'SSE: the goal_guard event type reached the admin-scope stream across proposed/set/updated/health/discarded actions', async () => {
    await sleep(200);
    const guardEvents = sseGuards.events.filter((e: any) => e.type === 'goal_guard');
    const actions = new Set(guardEvents.map((e: any) => e.action));
    assert.ok(guardEvents.length > 0, 'expected at least one goal_guard SSE event');
    for (const expected of ['proposed', 'set', 'updated', 'health', 'discarded']) {
      assert.ok(actions.has(expected), `expected a goal_guard SSE event with action=${expected}, saw: ${[...actions].join(',')}`);
    }
    sseGuards.close();
  });

  await check('G-9a', 'need_you is UNCHANGED by guard proposals/health flips/discards (§12.11 — a failing guard cues the chat, it is not a fresh approval)', async () => {
    const tree = await get(`/goals/${goalId}`);
    assert.equal(tree.json.goal.counts.need_you, needYouBaseline, 'need_you must not move because of any guard event in this section');
  });

  // v0.2 §13 — Kevin restructures the tree himself (add row / move / indent)
  // -> JARVIS weighs in on his next turn. CONTRACT.md §13.9, checks V02-*.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[16] v0.2 §13: Kevin restructures the tree himself -> JARVIS weighs in');
  let v02GoalId = -1;
  let mbiId = -1;   // set, root-level (Kevin authored via jarvis actor = no flag)
  let biId = -1;    // set, root-level
  let v02DocsId = -1;  // set, under MBI
  let leafId = -1;  // set, under Docs (so Docs has a subtree)
  let doneId = -1;  // done, under MBI
  let v02AddedId = -1;
  const sseV02 = captureSSE(cockpitKey); // the earlier streams were closed after [14]
  await sleep(150);
  const cueCountAt = (n: number) => cueCalls().filter((c) => c.correlationKey?.startsWith(`goal-structure:${n}:`)).length;

  await check('V02-0', 'setup: set goal with MBI{Docs{leaf}, done-child}, BI; no review flags on tool-transcribed nodes', async () => {
    const g = await post('/goals', { title: 'v0.2 restructure drill', done_means: 'prove the structure weigh-in loop' });
    assert.equal(g.status, 201, JSON.stringify(g.json));
    v02GoalId = g.json.goal.id;
    const mk = async (title: string, parent: number | null) => {
      // actor='jarvis' + authored_by='kevin' = the tool's set_from_kevin (JARVIS transcribing) → born set, NOT flagged
      const r = await post(`/goals/${v02GoalId}/nodes`, { title, done_means: `${title} is done`, parent_id: parent, authored_by: 'kevin', actor: 'jarvis' });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      assert.equal(r.json.node.state, 'set');
      assert.equal(r.json.node.review_state, 'none', 'tool-transcribed nodes are not flagged');
      return r.json.node.id as number;
    };
    mbiId = await mk('MBI', null);
    biId = await mk('BI', null);
    v02DocsId = await mk('Docs', mbiId);
    leafId = await mk('Docs leaf', v02DocsId);
    doneId = await mk('Already done', mbiId);
    // drive doneId to done: human leaf → human_done → verify
    assert.equal((await post(`/goals/${v02GoalId}/nodes/${doneId}/leaf_kind`, { leaf_kind: 'human' })).status, 200);
    assert.equal((await post(`/goals/${v02GoalId}/nodes/${doneId}/human_done`, {})).status, 200);
    const v = await post(`/goals/${v02GoalId}/nodes/${doneId}/verify`, { passed: true });
    assert.equal(v.status, 200, JSON.stringify(v.json));
    assert.equal(v.json.node.state, 'done');
    // MBI must NOT have settled: Docs is still set
    const mbi = (await get(`/goals/${v02GoalId}`)).json.nodes.find((n: any) => n.id === mbiId);
    assert.equal(mbi.state, 'set');
    await sleep(150);
    assert.equal(cueCountAt(v02GoalId), 0, 'no structure cue during setup');
  });

  await check('V02-1', 'Kevin move re-parents Docs (subtree) MBI -> BI: node_moved, awaiting_jarvis, kevin_moved_at/from, children carried', async () => {
    const before = sseV02.events.length;
    const r = await post(`/goals/${v02GoalId}/nodes/${v02DocsId}/move`, { parent_id: biId });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.node.parent_id, biId);
    assert.equal(r.json.node.state, 'set', 'a move never changes state');
    assert.equal(r.json.node.review_state, 'awaiting_jarvis');
    assert.equal(r.json.node.last_edited_by, 'kevin');
    assert.ok(r.json.node.kevin_moved_at, 'kevin_moved_at set');
    assert.equal(r.json.node.kevin_move_from, mbiId);
    assert.deepEqual(r.json.node.path, ['v0.2 restructure drill', 'BI', 'Docs']);
    const tree = (await get(`/goals/${v02GoalId}`)).json;
    const leaf = tree.nodes.find((n: any) => n.id === leafId);
    assert.equal(leaf.parent_id, v02DocsId, 'subtree intact');
    assert.deepEqual(leaf.path, ['v0.2 restructure drill', 'BI', 'Docs', 'Docs leaf'], 'descendant path re-derived');
    assert.equal(leaf.depth, 2);
    const ev = (await get(`/goals/${v02GoalId}/events?limit=500`)).json.events.find((e: any) => e.kind === 'node_moved' && e.node_id === v02DocsId);
    assert.ok(ev, 'node_moved event');
    assert.equal(ev.data.old_parent_id, mbiId);
    assert.equal(ev.data.new_parent_id, biId);
    assert.equal(ev.actor, 'kevin');
    await sleep(80);
    const nodeEvents = sseV02.events.slice(before).filter((e: any) => e.type === 'goal_node' && e.goal_id === v02GoalId) as any[];
    assert.ok(nodeEvents.some((e) => e.node.id === v02DocsId), 'goal_node SSE for the moved node');
    assert.ok(nodeEvents.some((e) => e.node.id === leafId && e.node.depth === 2), 'goal_node SSE for the descendant with refreshed depth');
    assert.equal(tree.goal.counts.awaiting_jarvis, 1, 'counts.awaiting_jarvis includes set nodes');
  });

  await check('V02-8', "old parent MBI left with only a done child -> check (§2.4(1)); parent left empty stays set", async () => {
    const tree = (await get(`/goals/${v02GoalId}`)).json;
    const mbi = tree.nodes.find((n: any) => n.id === mbiId);
    assert.equal(mbi.state, 'check', 'MBI: remaining children all done → check');
    // BI has Docs; move Docs back out under root → BI has zero children → stays set (never vacuously complete)
    const r = await post(`/goals/${v02GoalId}/nodes/${v02DocsId}/move`, { parent_id: null });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.node.kevin_move_from, biId);
    const bi = (await get(`/goals/${v02GoalId}`)).json.nodes.find((n: any) => n.id === biId);
    assert.equal(bi.state, 'set', 'an emptied parent never vacuously completes');
    // put it back under BI for the rest of the drill (still one open round, refreshed)
    const r2 = await post(`/goals/${v02GoalId}/nodes/${v02DocsId}/move`, { parent_id: biId });
    assert.equal(r2.status, 200);
    assert.equal(r2.json.node.review_state, 'awaiting_jarvis');
    assert.equal(r2.json.node.kevin_move_from, -1, '-1 = it came from root');
  });

  await check('V02-3', 'cycle -> 409 move_cycle; done node -> 409 invalid_transition; ghost parent -> 409 parent_not_set; foreign node -> 400', async () => {
    const cyc = await post(`/goals/${v02GoalId}/nodes/${biId}/move`, { parent_id: leafId });
    assert.equal(cyc.status, 409, JSON.stringify(cyc.json));
    assert.equal(cyc.json.error.code, 'move_cycle');
    const self = await post(`/goals/${v02GoalId}/nodes/${biId}/move`, { parent_id: biId });
    assert.equal(self.json.error.code, 'move_cycle');
    const dn = await post(`/goals/${v02GoalId}/nodes/${doneId}/move`, { parent_id: biId });
    assert.equal(dn.status, 409);
    assert.equal(dn.json.error.code, 'invalid_transition');
    const gh = await post(`/goals/${v02GoalId}/nodes/propose`, { parent_id: null, items: [{ title: 'ghost parent', done_means: 'x' }], actor: 'jarvis' });
    assert.equal(gh.status, 201);
    const ghostId = gh.json.nodes[0].id;
    const gp = await post(`/goals/${v02GoalId}/nodes/${leafId}/move`, { parent_id: ghostId });
    assert.equal(gp.status, 409);
    assert.equal(gp.json.error.code, 'parent_not_set');
    const foreign = await post(`/goals/${v02GoalId}/nodes/${leafId}/move`, { parent_id: v01NodeId });
    assert.equal(foreign.status, 400);
    assert.equal(foreign.json.error.code, 'parent_goal_mismatch');
    const bad = await post(`/goals/${v02GoalId}/nodes/${leafId}/move`, {});
    assert.equal(bad.status, 400, 'parent_id is required');
    // tidy: discard the ghost
    assert.equal((await post(`/goals/${v02GoalId}/nodes/${ghostId}/discard`, {})).status, 200);
  });

  await check('V02-7', 'sort_order-only PATCH on a set node and a no-op move -> no flag, no cue', async () => {
    const r = await patch(`/goals/${v02GoalId}/nodes/${biId}`, { sort_order: 9 });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.node.review_state, 'none');
    assert.equal(r.json.node.last_edited_by, null);
    const noop = await post(`/goals/${v02GoalId}/nodes/${biId}/move`, { parent_id: null });
    assert.equal(noop.status, 200);
    assert.equal(noop.json.node.review_state, 'none', 'no-op move does not flag');
    const events = (await get(`/goals/${v02GoalId}/events?limit=500`)).json.events;
    assert.ok(!events.some((e: any) => e.kind === 'node_moved' && e.node_id === biId), 'no node_moved event for a no-op');
  });

  await check('V02-4', 'debounced digest: move + add + set-node edit in one burst -> exactly ONE cue listing all three (an already-agreed node is dropped)', async () => {
    const before = cueCountAt(v02GoalId);
    const eventsBefore = (await get(`/goals/${v02GoalId}/events?limit=500`)).json.events.filter((e: any) => e.kind === 'kevin_restructured').length;
    // Docs is already awaiting from V02-1/V02-8 (its own digest fired already — the
    // 60ms sim debounce elapsed). Re-move it inside THIS burst, add a Kevin-typed
    // row, edit BI: three changes, one cue.
    assert.equal((await post(`/goals/${v02GoalId}/nodes/${v02DocsId}/move`, { parent_id: null })).status, 200);
    assert.equal((await post(`/goals/${v02GoalId}/nodes/${v02DocsId}/move`, { parent_id: biId })).status, 200);
    const add = await post(`/goals/${v02GoalId}/nodes`, { title: 'Kevin typed this', done_means: 'row exists', parent_id: biId });
    assert.equal(add.status, 201, JSON.stringify(add.json));
    v02AddedId = add.json.node.id;
    assert.equal(add.json.node.state, 'set', 'Kevin-authored → born set (pin)');
    assert.equal(add.json.node.review_state, 'awaiting_jarvis');
    assert.equal(add.json.node.last_edited_by, 'kevin');
    const ed = await patch(`/goals/${v02GoalId}/nodes/${biId}`, { title: 'BI (business intelligence)' });
    assert.equal(ed.status, 200);
    assert.equal(ed.json.node.state, 'set');
    assert.equal(ed.json.node.review_state, 'awaiting_jarvis');
    assert.ok(ed.json.node.kevin_edit_original, 'set-node edit snapshots the pre-edit text');
    assert.equal(JSON.parse(ed.json.node.kevin_edit_original).title, 'BI');
    // a 4th change JARVIS agrees to BEFORE the timer fires must not be listed
    const extra = await post(`/goals/${v02GoalId}/nodes`, { title: 'Agreed early', done_means: 'x', parent_id: null });
    assert.equal(extra.status, 201);
    const agreed = await post(`/goals/${v02GoalId}/nodes/${extra.json.node.id}/accept`, { actor: 'jarvis' });
    assert.equal(agreed.status, 200, JSON.stringify(agreed.json));
    assert.equal(agreed.json.node.review_state, 'none');
    await waitForCueCalls(cueCallCount() + 1, 1500);
    await sleep(200); // a second cue would land here if the debounce were broken
    assert.equal(cueCountAt(v02GoalId) - before, 1, 'exactly one structure cue for the burst');
    const cue = cueCalls().filter((c) => c.correlationKey?.startsWith(`goal-structure:${v02GoalId}:`)).pop()!;
    assert.equal(cue.externalId, `cockpit:goal-${v02GoalId}`);
    if (process.env.GOALS_SIM_VERBOSE) console.log('---- structure cue ----\n' + cue.text + '\n-----------------------');
    assert.match(cue.text, /^\[goal #\d+ — Kevin restructured the tree: /);
    assert.match(cue.text, new RegExp(`#${v02DocsId} moved: "Docs" — from: .*\\(root\\) → now: v0.2 restructure drill › BI \\(business intelligence\\)`));
    assert.match(cue.text, new RegExp(`#${add.json.node.id} added: "Kevin typed this" under `));
    assert.match(cue.text, new RegExp(`#${biId} edited: "BI" now: "BI \\(business intelligence\\)"`));
    assert.match(cue.text, /was: "BI"/);
    assert.ok(!cue.text.includes('Agreed early'), 'a node JARVIS already agreed to is not in the digest');
    assert.match(cue.text, /`accept` \{node_id\}/);
    const ev = (await get(`/goals/${v02GoalId}/events?limit=500`)).json.events.filter((e: any) => e.kind === 'kevin_restructured');
    assert.equal(ev.length - eventsBefore, 1, 'one kevin_restructured event per burst');
    const last = ev[ev.length - 1];
    assert.equal(last.data.entries.length, 3);
    assert.equal(cue.correlationKey, `goal-structure:${v02GoalId}:${last.id}`);
  });

  await check('V02-5', 'JARVIS accept on a set node awaiting -> stays set, round cleared, node_agreed; push_back -> pushed_back, still set', async () => {
    const acc = await post(`/goals/${v02GoalId}/nodes/${v02DocsId}/accept`, { actor: 'jarvis' });
    assert.equal(acc.status, 200, JSON.stringify(acc.json));
    assert.equal(acc.json.node.state, 'set');
    assert.equal(acc.json.node.review_state, 'none');
    assert.equal(acc.json.node.last_edited_by, null);
    assert.equal(acc.json.node.kevin_moved_at, null);
    assert.equal(acc.json.node.kevin_move_from, null);
    assert.equal(acc.json.node.parent_id, biId, 'agreeing does not undo the move');
    const events = (await get(`/goals/${v02GoalId}/events?limit=500`)).json.events;
    assert.ok(events.some((e: any) => e.kind === 'node_agreed' && e.node_id === v02DocsId));
    const pb = await post(`/goals/${v02GoalId}/nodes/${biId}/push_back`, { note: 'BI is too broad a bucket — split it by module?' });
    assert.equal(pb.status, 200, JSON.stringify(pb.json));
    assert.equal(pb.json.node.state, 'set', 'push_back NEVER un-sets a set node');
    assert.equal(pb.json.node.review_state, 'pushed_back');
    assert.equal(pb.json.node.review_note, 'BI is too broad a bucket — split it by module?');
    // Kevin ✓ on a set row is not a thing → 409 (v0 rule unchanged)
    const kev = await post(`/goals/${v02GoalId}/nodes/${v02AddedId}/accept`, {});
    assert.equal(kev.status, 409);
    // JARVIS accept with no open round → 409 invalid_transition (v0 rule unchanged)
    const none = await post(`/goals/${v02GoalId}/nodes/${v02DocsId}/accept`, { actor: 'jarvis' });
    assert.equal(none.status, 409);
    assert.equal(none.json.error.code, 'invalid_transition');
    // Kevin edits the pushed-back node again → fresh round, note cleared, new digest
    const before = cueCountAt(v02GoalId);
    const ed = await patch(`/goals/${v02GoalId}/nodes/${biId}`, { title: 'BI' });
    assert.equal(ed.json.node.review_state, 'awaiting_jarvis');
    assert.equal(ed.json.node.review_note, null);
    await waitForCueCalls(cueCallCount() + 1, 1500);
    assert.equal(cueCountAt(v02GoalId) - before, 1, 'a fresh Kevin change re-cues');
    // close the rounds so the goal is clean for V02-6
    assert.equal((await post(`/goals/${v02GoalId}/nodes/${biId}/accept`, { actor: 'jarvis' })).status, 200);
    assert.equal((await post(`/goals/${v02GoalId}/nodes/${v02AddedId}/accept`, { actor: 'jarvis' })).status, 200);
  });

  await check('V02-6', 'JARVIS move on a set node -> 403; propose_move sets pending_parent_id; resolve accept performs it (no flag); reject clears', async () => {
    const direct = await post(`/goals/${v02GoalId}/nodes/${leafId}/move`, { parent_id: mbiId, actor: 'jarvis' });
    assert.equal(direct.status, 403, JSON.stringify(direct.json));
    assert.equal(direct.json.error.code, 'jarvis_must_propose');
    // tool op semantics: a JARVIS ghost moves directly
    const gh = await post(`/goals/${v02GoalId}/nodes/propose`, { parent_id: biId, items: [{ title: 'ghost to move', done_means: 'x' }], actor: 'jarvis' });
    const ghostId = gh.json.nodes[0].id;
    const gm = await post(`/goals/${v02GoalId}/nodes/${ghostId}/move`, { parent_id: null, actor: 'jarvis' });
    assert.equal(gm.status, 200, JSON.stringify(gm.json));
    assert.equal(gm.json.node.parent_id, null);
    assert.equal(gm.json.node.review_state, 'none', 'JARVIS moving its own ghost is not flagged');
    assert.equal((await post(`/goals/${v02GoalId}/nodes/${ghostId}/discard`, {})).status, 200);
    // propose_move: leaf (under Docs) → under root
    const same = await post(`/goals/${v02GoalId}/nodes/${leafId}/propose_move`, { parent_id: v02DocsId });
    assert.equal(same.status, 409);
    assert.equal(same.json.error.code, 'nothing_to_move');
    const pm = await post(`/goals/${v02GoalId}/nodes/${leafId}/propose_move`, { parent_id: null });
    assert.equal(pm.status, 200, JSON.stringify(pm.json));
    assert.equal(pm.json.node.pending_parent_id, -1, '-1 = to root');
    assert.equal(pm.json.node.pending_by, 'jarvis');
    assert.equal(pm.json.node.parent_id, v02DocsId, 'not moved yet');
    // reject → cleared
    const rj = await post(`/goals/${v02GoalId}/nodes/${leafId}/resolve_pending`, { accept: false });
    assert.equal(rj.status, 200, JSON.stringify(rj.json));
    assert.equal(rj.json.node.pending_parent_id, null);
    assert.equal(rj.json.node.parent_id, v02DocsId);
    let events = (await get(`/goals/${v02GoalId}/events?limit=500`)).json.events;
    assert.ok(events.some((e: any) => e.kind === 'move_rejected' && e.node_id === leafId));
    // propose again (+ a coexisting pending edit) → accept performs both, no review flag
    assert.equal((await post(`/goals/${v02GoalId}/nodes/${leafId}/propose_move`, { parent_id: mbiId })).status, 200);
    const pe = await post(`/goals/${v02GoalId}/nodes/${leafId}/propose_edit`, { title: 'Docs leaf (moved)' });
    assert.equal(pe.status, 200);
    assert.equal(pe.json.node.pending_parent_id, mbiId, 'a pending edit coexists with a pending move');
    const before = cueCountAt(v02GoalId);
    const ac = await post(`/goals/${v02GoalId}/nodes/${leafId}/resolve_pending`, { accept: true });
    assert.equal(ac.status, 200, JSON.stringify(ac.json));
    assert.equal(ac.json.node.parent_id, mbiId);
    assert.equal(ac.json.node.title, 'Docs leaf (moved)');
    assert.equal(ac.json.node.pending_parent_id, null);
    assert.equal(ac.json.node.review_state, 'none', 'Kevin accepting a JARVIS proposal is not flagged for JARVIS');
    assert.equal(ac.json.node.kevin_moved_at, null);
    events = (await get(`/goals/${v02GoalId}/events?limit=500`)).json.events;
    assert.ok(events.some((e: any) => e.kind === 'move_accepted' && e.node_id === leafId));
    assert.ok(events.some((e: any) => e.kind === 'edit_accepted' && e.node_id === leafId));
    assert.ok(events.some((e: any) => e.kind === 'node_moved' && e.node_id === leafId && e.data.new_parent_id === mbiId));
    // MBI was 'check' (V02-8) — a child moving under a check parent does not un-check it (consistent with route 9)
    const mbi = (await get(`/goals/${v02GoalId}`)).json.nodes.find((n: any) => n.id === mbiId);
    assert.equal(mbi.state, 'check');
    await sleep(200);
    assert.equal(cueCountAt(v02GoalId), before, 'no structure cue for a resolve_pending');
    // removal supersedes a pending move
    assert.equal((await post(`/goals/${v02GoalId}/nodes/${leafId}/propose_move`, { parent_id: biId })).status, 200);
    const rm = await post(`/goals/${v02GoalId}/nodes/${leafId}/propose_removal`, {});
    assert.equal(rm.status, 200);
    assert.equal(rm.json.node.pending_parent_id, null, 'removal clears the pending move');
    assert.equal((await post(`/goals/${v02GoalId}/nodes/${leafId}/resolve_pending`, { accept: false })).status, 200);
  });

  await check('V02-9', 'focus injection: ↕K / ✎K markers, AWAITING suffixes, ↕pending label; working leaf may move with tree_id', async () => {
    // Kevin moves Docs (set) → ↕K ; adds a row → ✎K (Kevin added this)
    const mv = await post(`/goals/${v02GoalId}/nodes/${v02DocsId}/move`, { parent_id: null });
    assert.equal(mv.status, 200);
    const added = await post(`/goals/${v02GoalId}/nodes`, { title: 'Fresh row', done_means: 'exists', parent_id: null });
    assert.equal(added.status, 201);
    assert.equal((await post(`/goals/${v02GoalId}/nodes/${v02AddedId}/propose_move`, { parent_id: null })).status, 200);
    await put(`/goals/${v02GoalId}/focus`, { node_id: null });
    const ctx: string = goalsModule.buildGoalThreadContext(`cockpit:goal-${v02GoalId}`);
    assert.match(ctx, new RegExp(`\\[set ↕K\\] #${v02DocsId} Docs — done: .* — AWAITING YOUR TAKE \\(moved from: "BI"\\)`));
    assert.match(ctx, new RegExp(`\\[set ✎K\\] #${added.json.node.id} Fresh row — done: .* — AWAITING YOUR TAKE \\(Kevin added this\\)`));
    assert.match(ctx, /awaiting_you="2"/);
    // the pending JARVIS move under BI is collapsed (no focus → root + direct children only), so focus it to see the marker
    await put(`/goals/${v02GoalId}/focus`, { node_id: v02AddedId });
    const ctx2: string = goalsModule.buildGoalThreadContext(`cockpit:goal-${v02GoalId}`);
    assert.match(ctx2, new RegExp(`\\[set ↕pending ▶\\] #${v02AddedId} `));
    assert.match(ctx2, /pending="move"/);
    await waitForCueCalls(cueCallCount() + 1, 1500);
    // tidy: close rounds + reject the pending move
    assert.equal((await post(`/goals/${v02GoalId}/nodes/${v02DocsId}/accept`, { actor: 'jarvis' })).status, 200);
    assert.equal((await post(`/goals/${v02GoalId}/nodes/${added.json.node.id}/accept`, { actor: 'jarvis' })).status, 200);
    assert.equal((await post(`/goals/${v02GoalId}/nodes/${v02AddedId}/resolve_pending`, { accept: false })).status, 200);
    // working leaf may move: machine leaf + plan + approve → working → Kevin moves it, tree_id rides along
    const w = await post(`/goals/${v02GoalId}/nodes`, { title: 'Build it', done_means: 'built', parent_id: v02DocsId, authored_by: 'kevin', actor: 'jarvis' });
    assert.equal(w.status, 201);
    const wId = w.json.node.id;
    assert.equal((await post(`/goals/${v02GoalId}/nodes/${wId}/leaf_kind`, { leaf_kind: 'machine' })).status, 200);
    const plan = { what: 'build', deliverable: 'branch', model: 'claude-sonnet-5', adapter: 'claude', nodes: [{ title: 'do it', spec: 'x', adapter: 'claude', model: 'claude-sonnet-5' }] };
    assert.equal((await post(`/goals/${v02GoalId}/nodes/${wId}/propose_plan`, { plan, actor: 'jarvis' })).status, 200);
    const ap = await post(`/goals/${v02GoalId}/nodes/${wId}/approve_plan`, {});
    assert.equal(ap.status, 200, JSON.stringify(ap.json));
    assert.equal(ap.json.node.state, 'working');
    const treeId = ap.json.node.tree_id;
    const wm = await post(`/goals/${v02GoalId}/nodes/${wId}/move`, { parent_id: biId });
    assert.equal(wm.status, 200, JSON.stringify(wm.json));
    assert.equal(wm.json.node.state, 'working');
    assert.equal(wm.json.node.tree_id, treeId, 'tree_id rides along');
    assert.equal(wm.json.node.parent_id, biId);
    // ...but JARVIS may not PROPOSE moving a working leaf
    const pw = await post(`/goals/${v02GoalId}/nodes/${wId}/propose_move`, { parent_id: null });
    assert.equal(pw.status, 409);
    assert.equal(pw.json.error.code, 'leaf_already_dispatched');
    await waitForCueCalls(cueCallCount() + 1, 1500);
    assert.equal((await post(`/goals/${v02GoalId}/nodes/${wId}/accept`, { actor: 'jarvis' })).status, 200);
  });

  await check(
    'V02-10',
    'FOCUS SURVIVES A MOVE: moving the focused node (or an ancestor of the focused node) refreshes its path via a ' +
      'goal_focus SSE, WITHOUT changing focus.node_id and WITHOUT a focus_set event; an unrelated move fires no goal_focus at all',
    async () => {
      // -- direct case: focus IS the node being moved --------------------------
      const target = await post(`/goals/${v02GoalId}/nodes`, {
        title: 'Focus target', done_means: 'x', parent_id: null, authored_by: 'kevin', actor: 'jarvis',
      });
      assert.equal(target.status, 201, JSON.stringify(target.json));
      const targetId = target.json.node.id;
      await put(`/goals/${v02GoalId}/focus`, { node_id: targetId });
      await waitFor('goal_focus SSE after focusing the target', async () =>
        sseV02.events.some((e: any) => e.type === 'goal_focus' && e.goal_id === v02GoalId && e.focus.node_id === targetId));

      const eventsBefore = (await get(`/goals/${v02GoalId}/events?limit=500`)).json.events.length;
      const sseBefore = sseV02.events.length;
      const mv = await post(`/goals/${v02GoalId}/nodes/${targetId}/move`, { parent_id: mbiId });
      assert.equal(mv.status, 200, JSON.stringify(mv.json));
      assert.equal(mv.json.node.parent_id, mbiId);
      assert.deepEqual(mv.json.node.path, ['v0.2 restructure drill', 'MBI', 'Focus target'], 'moved node\'s own path refreshed in the move response');

      await sleep(150);
      const focusEvents = sseV02.events.slice(sseBefore).filter((e: any) => e.type === 'goal_focus' && e.goal_id === v02GoalId) as any[];
      assert.equal(focusEvents.length, 1, 'exactly one goal_focus SSE for the move of the focused node itself');
      assert.equal(focusEvents[0].focus.node_id, targetId, 'focus.node_id UNCHANGED — the focus row itself is untouched');
      assert.deepEqual(focusEvents[0].focus.path, ['MBI', 'Focus target'], 'focus.path refreshed to reflect the new parent chain');

      const tree = (await get(`/goals/${v02GoalId}`)).json;
      assert.equal(tree.focus.node_id, targetId, 'GET /goals/:id focus still points at the same node after the move');
      assert.deepEqual(tree.focus.path, ['MBI', 'Focus target'], 'GET /goals/:id focus.path reflects the move');

      // The move itself logs exactly one node_moved event; the debounced structure
      // digest (§13.5, 60ms in the sim) ALSO lands within this window and logs its
      // own kevin_restructured event — that's expected (V02-4 covers the digest's
      // shape directly). The thing THIS check cares about: no focus_set event, i.e.
      // the focus row itself never changed, only its derived path was re-emitted.
      const eventsAfter = (await get(`/goals/${v02GoalId}/events?limit=500`)).json.events;
      const newEvents = eventsAfter.slice(eventsBefore);
      assert.ok(newEvents.some((e: any) => e.kind === 'node_moved'), 'expected a node_moved event');
      assert.ok(!newEvents.some((e: any) => e.kind === 'focus_set'), 'no focus_set event — the focus row did not change, only its derived path');

      // close the review round this move opened, so V02-2's awaiting_jarvis=0 still holds
      assert.equal((await post(`/goals/${v02GoalId}/nodes/${targetId}/accept`, { actor: 'jarvis' })).status, 200);

      // -- descendant case: focus is a CHILD of the node being moved ------------
      const child = await post(`/goals/${v02GoalId}/nodes`, {
        title: 'Focus target child', done_means: 'x', parent_id: targetId, authored_by: 'kevin', actor: 'jarvis',
      });
      assert.equal(child.status, 201);
      const childId = child.json.node.id;
      await put(`/goals/${v02GoalId}/focus`, { node_id: childId });
      // let the focus-change's own goal_focus SSE land before we baseline the
      // window for the move below (the SSE reader runs on its own async loop and
      // can lag the HTTP response by a beat).
      await waitFor('goal_focus SSE after focusing the child', async () =>
        sseV02.events.some((e: any) => e.type === 'goal_focus' && e.goal_id === v02GoalId && e.focus.node_id === childId));

      const sseBefore2 = sseV02.events.length;
      const mv2 = await post(`/goals/${v02GoalId}/nodes/${targetId}/move`, { parent_id: biId });
      assert.equal(mv2.status, 200, JSON.stringify(mv2.json));
      await sleep(150);
      const focusEvents2 = sseV02.events.slice(sseBefore2).filter((e: any) => e.type === 'goal_focus' && e.goal_id === v02GoalId) as any[];
      assert.equal(focusEvents2.length, 1, 'moving an ANCESTOR of the focused node also emits exactly one goal_focus');
      assert.equal(focusEvents2[0].focus.node_id, childId, 'focus.node_id still the descendant, unchanged');
      assert.deepEqual(
        focusEvents2[0].focus.path,
        ['BI', 'Focus target', 'Focus target child'],
        'focus.path re-derived through the moved ancestor\'s new location',
      );
      const tree2 = (await get(`/goals/${v02GoalId}`)).json;
      assert.deepEqual(tree2.focus.path, ['BI', 'Focus target', 'Focus target child']);

      // close the review round the second move opened
      assert.equal((await post(`/goals/${v02GoalId}/nodes/${targetId}/accept`, { actor: 'jarvis' })).status, 200);

      // -- negative control: moving something unrelated to the focus fires no goal_focus --
      const sseBefore3 = sseV02.events.length;
      const unrelated = await post(`/goals/${v02GoalId}/nodes`, {
        title: 'Unrelated', done_means: 'x', parent_id: null, authored_by: 'kevin', actor: 'jarvis',
      });
      assert.equal((await post(`/goals/${v02GoalId}/nodes/${unrelated.json.node.id}/move`, { parent_id: mbiId })).status, 200);
      await sleep(150);
      assert.equal(
        sseV02.events.slice(sseBefore3).filter((e: any) => e.type === 'goal_focus' && e.goal_id === v02GoalId).length,
        0,
        'a move that touches neither the focused node nor its ancestor fires no goal_focus event',
      );

      // tidy: close the round this last move opened (targetId's round was already
      // closed after the descendant-case move above)
      assert.equal((await post(`/goals/${v02GoalId}/nodes/${unrelated.json.node.id}/accept`, { actor: 'jarvis' })).status, 200);
    },
  );

  // ── REVIEW FIXES (node #483) ──────────────────────────────────────────────
  await check(
    'V02-11',
    'REVIEW FIX: a same-parent REORDER (the cockpit drag-before/after) writes sort_order + logs node_moved but is NOT a restructure — no review flag, no cue',
    async () => {
      // two siblings under BI so there is something to reorder against
      const mk = async (title: string, parent: number | null) => {
        const r = await post(`/goals/${v02GoalId}/nodes`, { title, done_means: `${title} is done`, parent_id: parent, authored_by: 'kevin', actor: 'jarvis' });
        assert.equal(r.status, 201, JSON.stringify(r.json));
        return r.json.node as any;
      };
      const first = await mk('Reorder A', biId);
      const second = await mk('Reorder B', biId);
      const before = cueCountAt(v02GoalId);
      const evBefore = ((await get(`/goals/${v02GoalId}/events?limit=200`)).json.events as any[]).length;

      const moved = await post(`/goals/${v02GoalId}/nodes/${second.id}/move`, { parent_id: biId, sort_order: first.sort_order - 0.5 });
      assert.equal(moved.status, 200, JSON.stringify(moved.json));
      assert.equal(moved.json.node.parent_id, biId);
      assert.equal(moved.json.node.sort_order, first.sort_order - 0.5, 'the reorder was applied');
      assert.equal(moved.json.node.review_state, 'none', 'a pure reorder does NOT open a weigh-in round');
      assert.equal(moved.json.node.kevin_moved_at, null, 'a pure reorder does NOT stamp kevin_moved_at');
      assert.equal(moved.json.node.last_edited_by, null, 'a pure reorder does not hand anyone the last word');

      const events = (await get(`/goals/${v02GoalId}/events?limit=200`)).json.events as any[];
      assert.ok(events.length > evBefore, 'the reorder is still logged');
      assert.ok(
        events.some((e) => e.kind === 'node_moved' && e.node_id === second.id),
        'node_moved is still written for a reorder (§13.2)',
      );

      await sleep(250);
      assert.equal(cueCountAt(v02GoalId), before, 'a pure reorder fires NO structure cue');

      // ...but a genuine RE-PARENT of the same node still does both
      const reparent = await post(`/goals/${v02GoalId}/nodes/${second.id}/move`, { parent_id: mbiId });
      assert.equal(reparent.status, 200, JSON.stringify(reparent.json));
      assert.equal(reparent.json.node.review_state, 'awaiting_jarvis', 'a re-parent IS a restructure');
      assert.equal(reparent.json.node.kevin_move_from, biId);
      await waitFor('reorder-vs-reparent cue', async () => cueCountAt(v02GoalId) === before + 1);
      assert.match(lastCueCall().text, /moved "Reorder B" under "MBI"/);

      // tidy: close the round so V02-2's awaiting_jarvis === 0 still holds
      assert.equal((await post(`/goals/${v02GoalId}/nodes/${second.id}/accept`, { actor: 'jarvis' })).status, 200);
    },
  );

  await check(
    'V02-12',
    'REVIEW FIX: the dispatched-leaf rule is a PRECONDITION — propose_move onto a working/planned leaf 409s up front, so Kevin\'s ✓ can never half-apply (edit written, move silently dropped)',
    async () => {
      // `leafId` sits under Docs; drive it to a dispatched machine leaf.
      assert.equal((await post(`/goals/${v02GoalId}/nodes/${leafId}/leaf_kind`, { leaf_kind: 'machine', actor: 'jarvis' })).status, 200);
      const plan = { what: 'probe', deliverable: 'probe', model: 'claude-sonnet-5', nodes: [{ title: 'n1', spec: 's' }] };
      assert.equal((await post(`/goals/${v02GoalId}/nodes/${leafId}/propose_plan`, { plan, actor: 'jarvis' })).status, 200);
      const approved = await post(`/goals/${v02GoalId}/nodes/${leafId}/approve_plan`, { actor: 'kevin' });
      assert.equal(approved.status, 200, JSON.stringify(approved.json));
      assert.ok(['planned', 'working'].includes(approved.json.node.state), `leaf is dispatched (${approved.json.node.state})`);

      // a direct Kevin move onto it 409s (unchanged v0.2 behaviour)...
      const direct = await post(`/goals/${v02GoalId}/nodes/${biId}/move`, { parent_id: leafId });
      assert.equal(direct.status, 409);
      assert.equal(direct.json.error.code, 'leaf_already_dispatched');

      // ...and so does the PROPOSAL, instead of being accepted now and blowing
      // up mid-resolve after the text edit had already been written.
      const editP = await post(`/goals/${v02GoalId}/nodes/${biId}/propose_edit`, { title: 'BI (renamed)', actor: 'jarvis' });
      assert.equal(editP.status, 200, JSON.stringify(editP.json));
      const moveP = await post(`/goals/${v02GoalId}/nodes/${biId}/propose_move`, { parent_id: leafId, actor: 'jarvis' });
      assert.equal(moveP.status, 409, JSON.stringify(moveP.json));
      assert.equal(moveP.json.error.code, 'leaf_already_dispatched');

      // the pending text edit is untouched and still resolvable on its own
      const resolved = await post(`/goals/${v02GoalId}/nodes/${biId}/resolve_pending`, { accept: true });
      assert.equal(resolved.status, 200, JSON.stringify(resolved.json));
      assert.equal(resolved.json.node.title, 'BI (renamed)');
      assert.equal(resolved.json.node.pending_parent_id, null);
      assert.equal(resolved.json.node.parent_id, null, 'BI stayed at root — no half-applied move');
    },
  );

  await check(
    'V02-13',
    'REVIEW FIX: a non-finite sort_order (NaN/Infinity) is ignored rather than silently parking the row at 0',
    async () => {
      const row = (await get(`/goals/${v02GoalId}`)).json.nodes.find((n: any) => n.id === v02DocsId);
      assert.ok(row.sort_order !== 0, `Docs has a non-zero sort_order to notice a clobber (${row.sort_order})`);
      const r = await post(`/goals/${v02GoalId}/nodes/${v02DocsId}/move`, { parent_id: row.parent_id, sort_order: Number.NaN });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.node.sort_order, row.sort_order, 'NaN did not clobber sort_order');
      assert.equal(r.json.node.review_state, 'none', 'and it stayed a no-op');
    },
  );

  await check('V02-2', 'V01 regressions intact: ghost round still needs Kevin ✓; sort_order-only ghost PATCH untouched (checked above); counts', async () => {
    const tree = (await get(`/goals/${v02GoalId}`)).json;
    assert.equal(tree.goal.counts.awaiting_jarvis, 0, 'every round closed');
    for (const n of tree.nodes) {
      assert.equal(n.pending_parent_id, null, `no stray pending move on #${n.id}`);
      assert.ok('kevin_moved_at' in n && 'kevin_move_from' in n, 'new columns present on every read');
    }
    sseV02.close();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // v0.3 §14 — NODE CHATS: a linked, pinned-focus chat for ONE node, on
  // Kevin's say-so. CONTRACT.md §14.9, checks V03-*.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[17] v0.3 §14: node chats — pinned scope, linked both ways, cue routing');
  const toolsModule = await import(path.join(distDir, 'tools', 'goals-tool.js'));
  const convDb = await import(path.join(distDir, 'conversation-db.js'));
  const tool = (args: Record<string, unknown>, externalId: string): Promise<any> =>
    toolsModule.goals.execute(args, { externalId } as any);

  let v03GoalId = -1;
  let nA = -1, nB = -1, nA1 = -1, nA1a = -1;
  let nodeExt = '';
  let goalExt = '';
  await check('V03-0', 'setup: set goal; A, B root-level; A1 under A; A1a under A1 (all set, no review rounds open)', async () => {
    const g = await post('/goals', { title: 'v0.3 node-chat drill', done_means: 'node chats work end to end' });
    assert.equal(g.status, 201, JSON.stringify(g.json));
    v03GoalId = g.json.goal.id;
    goalExt = `cockpit:goal-${v03GoalId}`;
    const roots = await post(`/goals/${v03GoalId}/nodes/propose`, {
      parent_id: null, actor: 'jarvis',
      items: [{ title: 'A', done_means: 'a done' }, { title: 'B', done_means: 'b done' }],
    });
    assert.equal(roots.status, 201, JSON.stringify(roots.json));
    nA = roots.json.nodes[0].id; nB = roots.json.nodes[1].id;
    assert.equal((await post(`/goals/${v03GoalId}/batches/${roots.json.batch_id}/accept`, {})).status, 200);
    const a1 = await post(`/goals/${v03GoalId}/nodes/propose`, { parent_id: nA, actor: 'jarvis', items: [{ title: 'A1', done_means: 'a1 done' }] });
    nA1 = a1.json.nodes[0].id;
    assert.equal((await post(`/goals/${v03GoalId}/nodes/${nA1}/accept`, {})).status, 200);
    const a1a = await post(`/goals/${v03GoalId}/nodes/propose`, { parent_id: nA1, actor: 'jarvis', items: [{ title: 'A1a', done_means: 'a1a done' }] });
    nA1a = a1a.json.nodes[0].id;
    assert.equal((await post(`/goals/${v03GoalId}/nodes/${nA1a}/accept`, {})).status, 200);
    const tree = (await get(`/goals/${v03GoalId}`)).json;
    assert.equal(tree.goal.counts.awaiting_jarvis, 0);
    assert.equal(tree.goal.counts.node_chats, 0, 'no node chats yet');
    for (const n of tree.nodes) assert.equal(n.thread_ext, null, 'thread_ext present + null on every read');
  });

  await check('V03-1', 'route 36 on A1 -> created:true, cockpit:goal-<g>-node-<n>, §14.2 seed, thread_ext set, node_thread_opened, labelled conversation; second call -> created:false; counts.node_chats=1', async () => {
    const r = await post(`/goals/${v03GoalId}/nodes/${nA1}/thread`, {});
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.created, true);
    nodeExt = r.json.external_id;
    assert.equal(nodeExt, `cockpit:goal-${v03GoalId}-node-${nA1}`);
    assert.ok(typeof r.json.seed_text === 'string' && r.json.seed_text.length > 0);
    assert.match(r.json.seed_text, new RegExp(`^💬 NODE CHAT — this thread belongs to node #${nA1} "A1" of goal #${v03GoalId} "v0.3 node-chat drill"`));
    assert.match(r.json.seed_text, /\nPath: v0\.3 node-chat drill › A\n/);
    assert.match(r.json.seed_text, new RegExp(`\\nNode: #${nA1} A1\\n`));
    assert.match(r.json.seed_text, /\n7\. Cues for this branch/);
    assert.equal(r.json.node.thread_ext, nodeExt);
    const conv = convDb.getConversation(nodeExt);
    assert.ok(conv, 'conversation row exists');
    assert.match(String(conv.title ?? ''), new RegExp(`^💬 #${nA1} A1 · 🎯 v0\\.3 node-chat drill`));
    const events = (await get(`/goals/${v03GoalId}/events?limit=1000`)).json.events;
    assert.ok(events.some((e: any) => e.kind === 'node_thread_opened' && e.node_id === nA1 && e.data?.external_id === nodeExt));
    const again = await get(`/goals/${v03GoalId}/nodes/${nA1}/thread`);
    assert.equal(again.status, 200);
    assert.equal(again.json.created, false);
    assert.equal(again.json.seed_text, null);
    assert.equal(again.json.external_id, nodeExt);
    const tree = (await get(`/goals/${v03GoalId}`)).json;
    assert.equal(tree.goal.counts.node_chats, 1);
    assert.equal(tree.nodes.find((n: any) => n.id === nA1).thread_ext, nodeExt);
    assert.equal(events.filter((e: any) => e.kind === 'node_thread_opened' && e.node_id === nA1).length, 1, 'opened once');
  });

  await check('V03-2', 'route 36 preconditions: discarded -> 409 node_discarded; promoted stub -> 409 already_promoted; other goal -> 404 node_not_found', async () => {
    const ghost = (await post(`/goals/${v03GoalId}/nodes/propose`, { parent_id: nB, actor: 'jarvis', items: [{ title: 'doomed', done_means: 'x' }] })).json.nodes[0];
    assert.equal((await post(`/goals/${v03GoalId}/nodes/${ghost.id}/discard`, {})).status, 200);
    const d = await post(`/goals/${v03GoalId}/nodes/${ghost.id}/thread`, {});
    assert.equal(d.status, 409); assert.equal(d.json.error.code, 'node_discarded');
    // promote B into its own goal -> B is a stub here
    const promoted = await post(`/goals/${v03GoalId}/nodes/${nB}/promote`, {});
    assert.equal(promoted.status, 201, JSON.stringify(promoted.json));
    const p = await post(`/goals/${v03GoalId}/nodes/${nB}/thread`, {});
    assert.equal(p.status, 409); assert.equal(p.json.error.code, 'already_promoted');
    const other = await post(`/goals/${promoted.json.goal.id}/nodes/${nA1}/thread`, {});
    assert.equal(other.status, 404); assert.equal(other.json.error.code, 'node_not_found');
    // fresh root-level C replaces B for the rest of the section (set, no round)
    const c = await post(`/goals/${v03GoalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'C', done_means: 'c done' }] });
    nB = c.json.nodes[0].id;
    assert.equal((await post(`/goals/${v03GoalId}/nodes/${nB}/accept`, {})).status, 200);
  });

  let ghostUnderC = -1;
  await check('V03-3a', 'tool scope in the node chat: propose with no parent_id lands under the pinned node; parent_id outside / null -> outside_pinned_scope', async () => {
    // goal focus is on C (outside the branch) -> implicit parent must still be A1
    assert.equal((await put(`/goals/${v03GoalId}/focus`, { node_id: nB })).status, 200);
    const inside = await tool({ operation: 'propose', items: [{ title: 'A1b', done_means: 'a1b done' }] }, nodeExt);
    assert.ok(inside.nodes, JSON.stringify(inside));
    assert.equal(inside.nodes[0].parent_id, nA1);
    const outside = await tool({ operation: 'propose', parent_id: nB, items: [{ title: 'nope', done_means: 'x' }] }, nodeExt);
    assert.equal(outside.code, 'outside_pinned_scope', JSON.stringify(outside));
    assert.match(outside.error, new RegExp(`#${nB} "C" is outside this chat's branch \\(#${nA1} "A1"\\)`));
    const root = await tool({ operation: 'propose', parent_id: null, items: [{ title: 'nope', done_means: 'x' }] }, nodeExt);
    assert.equal(root.code, 'outside_pinned_scope');
    // the goal chat is unrestricted: the same propose under C works there
    const fromGoal = await tool({ operation: 'propose', parent_id: nB, items: [{ title: 'C1', done_means: 'c1 done' }] }, goalExt);
    assert.ok(fromGoal.nodes, JSON.stringify(fromGoal));
    ghostUnderC = fromGoal.nodes[0].id;
  });

  await check('V03-3b', 'named ids outside the branch -> outside_pinned_scope on accept/propose_edit/move/focus/propose_guard; goal-level ops refused; descendants allowed', async () => {
    const refused = async (args: Record<string, unknown>) => {
      const r = await tool(args, nodeExt);
      assert.equal(r.code, 'outside_pinned_scope', `${JSON.stringify(args)} -> ${JSON.stringify(r)}`);
    };
    await refused({ operation: 'accept', node_id: ghostUnderC });
    await refused({ operation: 'propose_edit', node_id: nB, title: 'C!' });
    await refused({ operation: 'move', node_id: nA1a, parent_id: nB });
    await refused({ operation: 'move', node_id: nA1, parent_id: nB });
    await refused({ operation: 'focus', node_id: nB });
    await refused({ operation: 'propose_guard', node_id: nB, mode: 'query', title: 't', sql: 'select 1 as v', comparator: 'gte', threshold: 1 });
    await refused({ operation: 'set_goal_done_means', done_means: 'rewritten' });
    await refused({ operation: 'verify', goal: true, passed: true });
    await refused({ operation: 'promote', node_id: nA1 });
    await refused({ operation: 'park' });
    await refused({ operation: 'open_node_chat', node_id: nB });
    // descendant: allowed
    const ok = await tool({ operation: 'propose_edit', node_id: nA1a, title: 'A1a (sharper)' }, nodeExt);
    assert.equal(ok.node?.pending_title, 'A1a (sharper)', JSON.stringify(ok));
    assert.equal((await post(`/goals/${v03GoalId}/nodes/${nA1a}/resolve_pending`, { accept: false })).status, 200);
    const okPropose = await tool({ operation: 'propose', parent_id: nA1a, items: [{ title: 'A1a-i', done_means: 'x' }] }, nodeExt);
    assert.ok(okPropose.nodes, JSON.stringify(okPropose));
    assert.equal((await post(`/goals/${v03GoalId}/nodes/${okPropose.nodes[0].id}/discard`, {})).status, 200);
    // goal remains untouched by the refused goal-level ops
    const tree = (await get(`/goals/${v03GoalId}`)).json;
    assert.equal(tree.goal.done_means, 'node chats work end to end');
    assert.equal(tree.goal.status, 'set');
  });

  await check('V03-4', 'focus {node_id:null} in the node chat clamps to the pinned node (set_by jarvis); a descendant works; ONE focus pointer per goal', async () => {
    const f = await tool({ operation: 'focus', node_id: null }, nodeExt);
    assert.equal(f.focus?.node_id, nA1, JSON.stringify(f));
    assert.equal(f.focus.set_by, 'jarvis');
    const f2 = await tool({ operation: 'focus', node_id: nA1a }, nodeExt);
    assert.equal(f2.focus?.node_id, nA1a);
    const shared = (await get(`/goals/${v03GoalId}/focus`)).json.focus;
    assert.equal(shared.node_id, nA1a, 'the goal chat / tree pane sees the same pointer');
    const viaGoal = await tool({ operation: 'list' }, goalExt);
    assert.equal(viaGoal.focus.node_id, nA1a);
  });

  await check('V03-5a', 'injection, node chat: <goal_focus pinned>, the ↑ path line, pinned node at depth 0 + its subtree only — no ancestor/sibling node lines', async () => {
    // goal focus outside the branch -> effective focus = the pinned node
    assert.equal((await put(`/goals/${v03GoalId}/focus`, { node_id: nB })).status, 200);
    const ctx: string = goalsModule.buildGoalThreadContext(nodeExt);
    assert.ok(ctx.length > 0, 'non-empty for a node chat');
    assert.match(ctx, new RegExp(`^<goal_focus goal_id="${v03GoalId}" node_id="${nA1}" pinned="${nA1}" path="A › A1"`));
    assert.match(ctx, new RegExp(`<goal_tree goal_id="${v03GoalId}" pinned="${nA1}" `));
    assert.match(ctx, /\n# v0\.3 node-chat drill — done: node chats work end to end\n/);
    assert.match(ctx, /\n↑ A   \(above this chat — changes there happen in the goal chat\)\n/);
    assert.match(ctx, new RegExp(`\\n- \\[set ▶\\] #${nA1} A1 — done: a1 done\\n`), 'pinned node at depth 0, focused');
    assert.match(ctx, new RegExp(`\\n  - \\[set\\] #${nA1a} A1a — done: a1a done\\n`), 'child expanded one layer');
    assert.match(ctx, new RegExp(`\\n  - \\[ghost b:[0-9a-f]{4}\\] #\\d+ A1b`), 'the ghost proposed from this chat is visible');
    assert.doesNotMatch(ctx, new RegExp(`#${nA} A —`), 'ancestor A is not a node line');
    assert.doesNotMatch(ctx, new RegExp(`#${nB} C —`), 'sibling-of-ancestor C is not a node line');
    assert.doesNotMatch(ctx, /<node_chats/, 'a node chat carries no node_chats block');
    // goal focus inside the branch -> effective focus follows it
    assert.equal((await put(`/goals/${v03GoalId}/focus`, { node_id: nA1a })).status, 200);
    const ctx2: string = goalsModule.buildGoalThreadContext(nodeExt);
    assert.match(ctx2, new RegExp(`node_id="${nA1a}" pinned="${nA1}" path="A › A1 › A1a"`));
    assert.match(ctx2, new RegExp(`#${nA1a} A1a — done: a1a done ▶|\\[set ▶\\] #${nA1a} A1a`));
  });

  await check('V03-5b', 'injection, goal chat: 💬 on the chatted node line + <node_chats count="1"> ("no replies yet" -> latest assistant line ≤160 chars with age)', async () => {
    const ctx: string = goalsModule.buildGoalThreadContext(goalExt);
    assert.match(ctx, new RegExp(`#${nA1} A1 — done: a1 done 💬`), '💬 marker on the chatted node');
    assert.match(ctx, new RegExp(`</goal_tree>\\n<node_chats goal_id="${v03GoalId}" count="1">\\n#${nA1} chat, last: \\(no replies yet\\)\\n</node_chats>\\n$`));
    // an assistant reply lands in the node chat
    const conv = convDb.getConversation(nodeExt);
    const long = 'Proposed A1b under #' + nA1 + '; waiting on your ✓. ' + 'x'.repeat(200);
    convDb.addTurn(conv.id, 'user', 'hi');
    convDb.addTurn(conv.id, 'assistant', long);
    const ctx2: string = goalsModule.buildGoalThreadContext(goalExt);
    const m = new RegExp(`#${nA1} chat, last: "([^"]+)" \\((<1m|\\d+[mhd]) ago\\)`).exec(ctx2);
    assert.ok(m, `node_chats line with age: ${ctx2.split('<node_chats')[1]}`);
    assert.ok(m![1].length <= 160, `clipped to ≤160 (${m![1].length})`);
    assert.ok(m![1].endsWith('…'));
    assert.match(m![1], /^Proposed A1b under #/);
    assert.doesNotMatch(ctx2, /pinned=/, 'the goal chat is not pinned');
  });

  await check('V03-6a', 'cue routing — review cue: Kevin edits + ✓s a ghost under A1 -> cue posts to the NODE chat; the same on a ghost under C -> the GOAL chat', async () => {
    const tree = (await get(`/goals/${v03GoalId}`)).json;
    const a1b = tree.nodes.find((n: any) => n.title === 'A1b' && n.state === 'ghost');
    assert.ok(a1b, 'A1b ghost exists');
    assert.equal((await patch(`/goals/${v03GoalId}/nodes/${a1b.id}`, { title: 'A1b (Kevin)' })).status, 200);
    let before = cueCallCount();
    const acc = await post(`/goals/${v03GoalId}/nodes/${a1b.id}/accept`, {});
    assert.equal(acc.status, 200); assert.equal(acc.json.node.review_state, 'awaiting_jarvis');
    await waitForCueCalls(before + 1);
    assert.equal(cueCallCount(), before + 1);
    assert.equal(lastCueCall().externalId, nodeExt, 'review cue routed to the node chat');
    assert.match(lastCueCall().text, new RegExp(`^\\[goal #${v03GoalId} — Kevin edited 1 of your proposals? and OK'd it\\. Weigh in\\.\\]\\n#${a1b.id} now: "A1b \\(Kevin\\)"`));
    assert.match(lastCueCall().correlationKey ?? '', new RegExp(`^goal-cue:${v03GoalId}:`));
    // JARVIS agrees from the node chat (in scope)
    const agreed = await tool({ operation: 'accept', node_id: a1b.id }, nodeExt);
    assert.equal(agreed.node?.state, 'set', JSON.stringify(agreed));
    // same dance under C -> goal chat
    assert.equal((await patch(`/goals/${v03GoalId}/nodes/${ghostUnderC}`, { title: 'C1 (Kevin)' })).status, 200);
    before = cueCallCount();
    assert.equal((await post(`/goals/${v03GoalId}/nodes/${ghostUnderC}/accept`, {})).status, 200);
    await waitForCueCalls(before + 1);
    assert.equal(cueCallCount(), before + 1);
    assert.equal(lastCueCall().externalId, goalExt, 'no node chat above C -> goal chat');
    const agreed2 = await tool({ operation: 'accept', node_id: ghostUnderC }, goalExt);
    assert.equal(agreed2.node?.state, 'set', JSON.stringify(agreed2));
  });

  await check('V03-6b', 'cue routing — structure burst spanning both branches -> TWO cues (one per chat), each listing only its own nodes; ONE kevin_restructured event', async () => {
    const before = cueCallCount();
    const evBefore = (await get(`/goals/${v03GoalId}/events?limit=1000`)).json.events.filter((e: any) => e.kind === 'kevin_restructured').length;
    const k1 = await post(`/goals/${v03GoalId}/nodes`, { title: 'A1c (Kevin)', done_means: 'k', parent_id: nA1, authored_by: 'kevin' });
    const k2 = await post(`/goals/${v03GoalId}/nodes`, { title: 'C2 (Kevin)', done_means: 'k', parent_id: nB, authored_by: 'kevin' });
    assert.equal(k1.status, 201); assert.equal(k2.status, 201);
    await waitForCueCalls(before + 2, 3000);
    assert.equal(cueCallCount(), before + 2, 'exactly two cues for the burst');
    const cues = cueCalls().slice(before);
    const toNode = cues.find((c) => c.externalId === nodeExt);
    const toGoal = cues.find((c) => c.externalId === goalExt);
    assert.ok(toNode && toGoal, `one per target: ${cues.map((c) => c.externalId).join(', ')}`);
    assert.match(toNode!.text, new RegExp(`#${k1.json.node.id} added: "A1c \\(Kevin\\)"`));
    assert.doesNotMatch(toNode!.text, new RegExp(`#${k2.json.node.id} `), 'node chat cue lists only its branch');
    assert.match(toGoal!.text, new RegExp(`#${k2.json.node.id} added: "C2 \\(Kevin\\)"`));
    assert.doesNotMatch(toGoal!.text, new RegExp(`#${k1.json.node.id} `), 'goal chat cue lists only the unchatted branch');
    assert.equal(toNode!.correlationKey, toGoal!.correlationKey, 'same burst, same correlation key');
    const evAfter = (await get(`/goals/${v03GoalId}/events?limit=1000`)).json.events.filter((e: any) => e.kind === 'kevin_restructured');
    assert.equal(evAfter.length, evBefore + 1, 'one digest event for the burst');
    assert.deepEqual([...evAfter[evAfter.length - 1].data.targets].sort(), [goalExt, nodeExt].sort());
    // close both rounds
    assert.ok((await tool({ operation: 'accept', node_id: k1.json.node.id }, nodeExt)).node);
    assert.ok((await tool({ operation: 'accept', node_id: k2.json.node.id }, goalExt)).node);
  });

  await check('V03-6c', 'cue routing — guard health flip on a node under A1 -> node chat; a root guard -> goal chat', async () => {
    // A1a must be done to carry a guard: human leaf -> human_done -> verify
    assert.equal((await post(`/goals/${v03GoalId}/nodes/${nA1a}/leaf_kind`, { leaf_kind: 'human' })).status, 200);
    assert.equal((await post(`/goals/${v03GoalId}/nodes/${nA1a}/human_done`, {})).status, 200);
    assert.equal((await post(`/goals/${v03GoalId}/nodes/${nA1a}/verify`, { passed: true })).status, 200);
    const gp = await tool({ operation: 'propose_guard', node_id: nA1a, mode: 'query', title: 'a1a stays true', sql: 'select 1 as v', comparator: 'gte', threshold: 1 }, nodeExt);
    assert.ok(gp.guard, JSON.stringify(gp));
    const acc = await post(`/goals/${v03GoalId}/guards/${gp.guard.id}/accept`, {});
    assert.equal(acc.status, 200, JSON.stringify(acc.json));
    let before = cueCallCount();
    guardsModule.applyGuardHealth(gp.guard.id, { status: 'fail', value: 0, summary: 'a1a broke', at: new Date().toISOString() });
    await waitForCueCalls(before + 1);
    assert.equal(cueCallCount(), before + 1);
    assert.equal(lastCueCall().externalId, nodeExt, 'guard cue routed to the node chat');
    assert.match(lastCueCall().text, new RegExp(`guard on #${nA1a} "A1a" is FAILING: a1a broke`));
    // a root guard (goal-level) -> the goal chat. Root guards need a done goal;
    // use the promoted goal (B) which has no nodes -> verify it directly.
    const promotedGoal = (await get(`/goals?include_done=1`)).json.goals.find((g: any) => g.promoted_from_node_id != null && g.title === 'B');
    assert.ok(promotedGoal, 'promoted goal B exists');
    assert.equal((await post(`/goals/${promotedGoal.id}/verify`, { passed: true })).status, 200);
    const rootGuard = await post(`/goals/${promotedGoal.id}/guards/propose`, { node_id: null, mode: 'query', title: 'b root', sql: 'select 1 as v', comparator: 'gte', threshold: 1 });
    assert.equal(rootGuard.status, 201, JSON.stringify(rootGuard.json));
    assert.equal((await post(`/goals/${promotedGoal.id}/guards/${rootGuard.json.guard.id}/accept`, {})).status, 200);
    before = cueCallCount();
    guardsModule.applyGuardHealth(rootGuard.json.guard.id, { status: 'fail', value: 0, summary: 'root broke', at: new Date().toISOString() });
    await waitForCueCalls(before + 1);
    assert.equal(lastCueCall().externalId, `cockpit:goal-${promotedGoal.id}`, 'root guard -> goal chat');
  });

  await check('V03-6d', 'cue routing — a hopper tree planted from a machine leaf under A1 finishes -> tree cue posts to the NODE chat, not the tree origin (goal chat)', async () => {
    // tree-cue.js registers its listener at import; imported here (not at the
    // top) so the earlier sections' tree completions never added cue calls.
    await import(path.join(distDir, 'tree-cue.js'));
    const tree = (await get(`/goals/${v03GoalId}`)).json;
    const a1c = tree.nodes.find((n: any) => n.title === 'A1c (Kevin)');
    assert.ok(a1c);
    assert.equal((await post(`/goals/${v03GoalId}/nodes/${a1c.id}/leaf_kind`, { leaf_kind: 'machine' })).status, 200);
    const pp = await tool({ operation: 'propose_plan', node_id: a1c.id, plan: {
      what: 'one node', deliverable: 'x', model: 'claude-sonnet-5',
      nodes: [{ title: 'do the thing', spec: 'x', model: 'claude-sonnet-5' }],
    } }, nodeExt);
    assert.ok(pp.node, JSON.stringify(pp));
    const approve = await post(`/goals/${v03GoalId}/nodes/${a1c.id}/approve_plan`, {});
    assert.equal(approve.status, 200, JSON.stringify(approve.json));
    const treeId = approve.json.tree.id;
    const treeRow = (await get(`/hopper-trees/${treeId}`)).json.tree;
    assert.equal(treeRow.origin_thread_ext, goalExt, 'the tree itself is planted from the goal chat (unchanged)');
    assert.equal(goalsModule.cueTargetForTree(treeId), nodeExt, 'but its cue target is the node chat');
    const hopperNodeId = approve.json.hopper_nodes[0].id;
    await waitFor('hopper node -> running', async () => {
      const overlay = await get(`/goals/${v03GoalId}/nodes/${a1c.id}/tree`);
      return overlay.status === 200 && overlay.json.nodes.some((n: any) => n.id === hopperNodeId && n.status === 'running');
    });
    const before = cueCallCount();
    assert.equal((await post(`/hopper-nodes/${hopperNodeId}/finish`, { outcome: 'done', result: 'done.' })).status, 200);
    await waitFor('goal node -> check', async () => {
      const n = (await get(`/goals/${v03GoalId}`)).json.nodes.find((x: any) => x.id === a1c.id);
      return n?.state === 'check';
    });
    await waitForCueCalls(before + 1, 3000);
    const treeCue = cueCalls().slice(before).find((c) => (c.correlationKey ?? '').startsWith('tree-cue:'));
    assert.ok(treeCue, `tree cue fired: ${JSON.stringify(cueCalls().slice(before).map((c) => c.correlationKey))}`);
    assert.equal(treeCue!.externalId, nodeExt, 'tree-done cue routed to the node chat');
    assert.equal(treeCue!.correlationKey, `tree-cue:${treeId}:done`);
    assert.ok(!cueCalls().slice(before).some((c) => c.externalId === goalExt && (c.correlationKey ?? '').startsWith('tree-cue:')), 'never both');
  });

  await check('V03-7', 'open_node_chat op (Kevin asked in words) from the goal chat; two node chats -> counts.node_chats=2; a discarded chatted ghost does not count', async () => {
    const before = cueCallCount();
    const opened = await tool({ operation: 'open_node_chat', node_id: nB }, goalExt);
    assert.equal(opened.created, true, JSON.stringify(opened));
    assert.equal(opened.external_id, `cockpit:goal-${v03GoalId}-node-${nB}`);
    assert.equal(opened.node.thread_ext, opened.external_id);
    // the tool posted the seed itself (stubbed via goals-tool-sim-seed.hooks.mjs)
    await waitForCueCalls(before + 1);
    const seedPost = cueCalls().slice(before).find((c) => c.externalId === opened.external_id);
    assert.ok(seedPost, 'tool-side seed post went to the new node chat');
    assert.match(seedPost!.text, new RegExp(`^💬 NODE CHAT — this thread belongs to node #${nB} "C"`));
    const conv = convDb.getConversation(opened.external_id);
    assert.ok(conv);
    assert.match(String(conv.title ?? ''), new RegExp(`^💬 #${nB} C · 🎯 `));
    assert.equal((await tool({ operation: 'open_node_chat', node_id: nB }, goalExt)).created, false, 'find-or-create');
    let tree = (await get(`/goals/${v03GoalId}`)).json;
    assert.equal(tree.goal.counts.node_chats, 2);
    // a ghost may have a chat; discarding it drops it from the count
    const ghost = (await tool({ operation: 'propose', items: [{ title: 'A1z', done_means: 'z' }] }, nodeExt)).nodes[0];
    const nested = await tool({ operation: 'open_node_chat', node_id: ghost.id }, nodeExt);
    assert.equal(nested.created, true, JSON.stringify(nested));
    tree = (await get(`/goals/${v03GoalId}`)).json;
    assert.equal(tree.goal.counts.node_chats, 3);
    assert.equal((await post(`/goals/${v03GoalId}/nodes/${ghost.id}/discard`, {})).status, 200);
    tree = (await get(`/goals/${v03GoalId}`)).json;
    assert.equal(tree.goal.counts.node_chats, 2);
    assert.equal(goalsModule.resolveGoalScope(nested.external_id), null, 'a discarded node chat resolves to no scope');
    const gone = await tool({ operation: 'list' }, nested.external_id);
    assert.equal(gone.code, 'pinned_node_gone', JSON.stringify(gone));
    assert.equal(goalsModule.buildGoalThreadContext(nested.external_id), '', 'and injects nothing');
  });

  await check('V03-8', 'labels follow renames: node title PATCH and goal title PATCH re-label the node chat conversation', async () => {
    assert.equal((await patch(`/goals/${v03GoalId}/nodes/${nA1}`, { title: 'A1 renamed' })).status, 200);
    assert.match(String(convDb.getConversation(nodeExt)?.title ?? ''), new RegExp(`^💬 #${nA1} A1 renamed · 🎯 v0\\.3 node-chat drill`));
    assert.equal((await patch(`/goals/${v03GoalId}`, { title: 'v0.3 drill (renamed)' })).status, 200);
    assert.match(String(convDb.getConversation(nodeExt)?.title ?? ''), new RegExp(`^💬 #${nA1} A1 renamed · 🎯 v0\\.3 drill \\(renamed\\)`));
    // close the round the rename opened so the goal ends clean
    assert.ok((await tool({ operation: 'accept', node_id: nA1 }, nodeExt)).node);
  });

  await check('V03-9', 'REVIEW (node #491): the ops V03-3b skipped — discard {batch_id} spanning the boundary is refused while an in-branch batch works; log defaults to the pinned node; open_node_chat on the pin itself is refused; a node chat can never write outside its branch through any op', async () => {
    // a batch proposed from the GOAL chat under C (outside A1) vs one from the NODE chat under A1
    const outside = await tool({ operation: 'propose', parent_id: nB, items: [{ title: 'C-x', done_means: 'x' }, { title: 'C-y', done_means: 'y' }] }, goalExt);
    assert.ok(outside.nodes?.length === 2, JSON.stringify(outside));
    const inside = await tool({ operation: 'propose', items: [{ title: 'A1-z', done_means: 'z' }] }, nodeExt);
    assert.ok(inside.nodes?.length === 1, JSON.stringify(inside));
    assert.equal(inside.nodes[0].parent_id, nA1, 'no parent_id -> under the pinned node');
    const rOut = await tool({ operation: 'discard', batch_id: outside.batch_id ?? outside.nodes[0].proposal_batch }, nodeExt);
    assert.equal(rOut.code, 'outside_pinned_scope', JSON.stringify(rOut));
    const rAcc = await tool({ operation: 'accept', batch_id: outside.batch_id ?? outside.nodes[0].proposal_batch }, nodeExt);
    assert.equal(rAcc.code, 'outside_pinned_scope', JSON.stringify(rAcc));
    const rIn = await tool({ operation: 'discard', batch_id: inside.batch_id ?? inside.nodes[0].proposal_batch }, nodeExt);
    assert.ok(Array.isArray(rIn.nodes) && rIn.nodes.length === 1, JSON.stringify(rIn));
    // the outside batch is untouched by the refusals
    const tree = (await get(`/goals/${v03GoalId}`)).json;
    const cx = tree.nodes.find((n: any) => n.title === 'C-x');
    assert.equal(cx?.state, 'ghost', 'outside ghosts survived the refused discard/accept');
    // log without node_id -> the pinned node's timeline
    const lg = await tool({ operation: 'log', text: "That's above this branch — tell me in the goal chat." }, nodeExt);
    assert.equal(lg.event?.node_id, nA1, JSON.stringify(lg));
    const lgOut = await tool({ operation: 'log', text: 'x', node_id: nB }, nodeExt);
    assert.equal(lgOut.code, 'outside_pinned_scope');
    // open_node_chat on the pin itself / on an outside ghost
    assert.equal((await tool({ operation: 'open_node_chat', node_id: nA1 }, nodeExt)).code, 'outside_pinned_scope');
    assert.equal((await tool({ operation: 'open_node_chat', node_id: cx.id }, nodeExt)).code, 'outside_pinned_scope');
    // the remaining write ops named against an outside node
    for (const args of [
      { operation: 'push_back', node_id: cx.id, note: 'no' },
      { operation: 'edit_ghost', node_id: cx.id, title: 'C-x!' },
      { operation: 'propose_remove', node_id: nB },
      { operation: 'set_leaf_kind', node_id: nB, leaf_kind: 'human' },
      { operation: 'dispatch', node_id: nB },
      { operation: 'verify', node_id: nB, passed: true },
      { operation: 'human_done', node_id: nB },
      { operation: 'park', node_id: nB },
      { operation: 'unpark', node_id: nB },
      { operation: 'unpark' },
      { operation: 'set_from_kevin', title: 'k', done_means: 'k', parent_id: nB },
      { operation: 'set_from_kevin', title: 'k', done_means: 'k', parent_id: null },
      { operation: 'accept', all: true, parent_id: nB },
      { operation: 'accept', all: true, parent_id: null },
    ] as Record<string, unknown>[]) {
      const r = await tool(args, nodeExt);
      assert.equal(r.code, 'outside_pinned_scope', `${JSON.stringify(args)} -> ${JSON.stringify(r)}`);
    }
    // clean up the outside batch so the goal ends where V03-8 left it
    assert.equal((await post(`/goals/${v03GoalId}/nodes/${cx.id}/discard`, {})).status, 200);
    const cy = tree.nodes.find((n: any) => n.title === 'C-y');
    assert.equal((await post(`/goals/${v03GoalId}/nodes/${cy.id}/discard`, {})).status, 200);
  });

  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[18] v0.5 §16: forest payload — last_activity sources, hot_nodes ordering, additive shape');

  // GET /goals (the LIST route) is the only GoalSummary producer that populates
  // last_activity/hot_nodes (see the comment on GoalSummary in src/goals.ts) —
  // GET /goals/:id does NOT, so every check below reads through the list.
  async function getGoalSummary(goalId: number): Promise<any> {
    const r = await get('/goals');
    assert.equal(r.status, 200);
    const found = r.json.goals.find((g: any) => g.id === goalId);
    assert.ok(found, `goal ${goalId} present in GET /goals`);
    return found;
  }

  // A minimal fixture: one set goal with exactly one accepted node that has its
  // own node chat — gives all four last_activity candidate columns a row to
  // read from (goals.updated_at, goal_events.created_at, the goal thread's
  // conversations.updated_at, the node chat's conversations.updated_at).
  async function buildV05Fixture(title: string): Promise<{ goalId: number; goalExt: string; nodeExt: string }> {
    const g = await post('/goals', { title, done_means: 'v0.5 fixture' });
    assert.equal(g.status, 201, JSON.stringify(g.json));
    const goalId = g.json.goal.id;
    const goalExt = `cockpit:goal-${goalId}`;
    const propose = await post(`/goals/${goalId}/nodes/propose`, {
      parent_id: null, actor: 'jarvis', items: [{ title: 'leaf', done_means: 'x' }],
    });
    assert.equal(propose.status, 201, JSON.stringify(propose.json));
    const nodeId = propose.json.nodes[0].id;
    assert.equal((await post(`/goals/${goalId}/batches/${propose.json.batch_id}/accept`, {})).status, 200);
    const chat = await post(`/goals/${goalId}/nodes/${nodeId}/thread`, {});
    assert.equal(chat.status, 200, JSON.stringify(chat.json));
    return { goalId, goalExt, nodeExt: chat.json.external_id };
  }

  // Pins every candidate timestamp for this goal to the same offset (default
  // well in the past) so a subsequent single bump is unambiguously the max —
  // avoids flakiness from SQLite datetime('now')'s 1-second resolution when
  // several mutations land inside the same wall-clock second.
  function pinV05Timestamps(goalId: number, exts: string[], offset: string): void {
    convDb.sqliteDb.prepare(`UPDATE goals SET updated_at = datetime('now', ?) WHERE id = ?`).run(offset, goalId);
    convDb.sqliteDb.prepare(`UPDATE goal_events SET created_at = datetime('now', ?) WHERE goal_id = ?`).run(offset, goalId);
    for (const ext of exts) {
      convDb.sqliteDb.prepare(`UPDATE conversations SET updated_at = datetime('now', ?) WHERE external_id = ?`).run(offset, ext);
    }
  }

  await check('V05-1', 'last_activity source A: goals.updated_at wins when it is the newest of the four signals', async () => {
    const { goalId, goalExt, nodeExt } = await buildV05Fixture('V05 fixture A (goal.updated_at wins)');
    pinV05Timestamps(goalId, [goalExt, nodeExt], '-10 minutes');
    convDb.sqliteDb.prepare(`UPDATE goals SET updated_at = datetime('now', '+5 minutes') WHERE id = ?`).run(goalId);
    const expected = (convDb.sqliteDb.prepare(`SELECT updated_at FROM goals WHERE id = ?`).get(goalId) as any).updated_at;
    const summary = await getGoalSummary(goalId);
    assert.equal(summary.last_activity, expected);
  });

  await check('V05-2', "last_activity source B: last_event_at (goal_events, most recent by id) wins", async () => {
    const { goalId, goalExt, nodeExt } = await buildV05Fixture('V05 fixture B (last_event_at wins)');
    pinV05Timestamps(goalId, [goalExt, nodeExt], '-10 minutes');
    convDb.sqliteDb.prepare(`
      UPDATE goal_events SET created_at = datetime('now', '+5 minutes')
      WHERE id = (SELECT id FROM goal_events WHERE goal_id = ? ORDER BY id DESC LIMIT 1)
    `).run(goalId);
    const expected = (convDb.sqliteDb.prepare(
      `SELECT created_at FROM goal_events WHERE goal_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(goalId) as any).created_at;
    const summary = await getGoalSummary(goalId);
    assert.equal(summary.last_activity, expected);
  });

  await check('V05-3', "last_activity source C: the goal-thread conversation's updated_at wins", async () => {
    const { goalId, goalExt, nodeExt } = await buildV05Fixture('V05 fixture C (goal thread wins)');
    pinV05Timestamps(goalId, [goalExt, nodeExt], '-10 minutes');
    convDb.sqliteDb.prepare(`UPDATE conversations SET updated_at = datetime('now', '+5 minutes') WHERE external_id = ?`).run(goalExt);
    const expected = convDb.getConversation(goalExt).updated_at;
    const summary = await getGoalSummary(goalId);
    assert.equal(summary.last_activity, expected);
  });

  await check('V05-4', "last_activity source D: a node chat's conversation.updated_at wins", async () => {
    const { goalId, goalExt, nodeExt } = await buildV05Fixture('V05 fixture D (node chat wins)');
    pinV05Timestamps(goalId, [goalExt, nodeExt], '-10 minutes');
    convDb.sqliteDb.prepare(`UPDATE conversations SET updated_at = datetime('now', '+5 minutes') WHERE external_id = ?`).run(nodeExt);
    const expected = convDb.getConversation(nodeExt).updated_at;
    const summary = await getGoalSummary(goalId);
    assert.equal(summary.last_activity, expected);
  });

  await check('V05-5', 'MAX is taken across MULTIPLE node chats on the same goal, not just the first one queried', async () => {
    const g = await post('/goals', { title: 'V05 fixture E (multi node chat MAX)', done_means: 'x' });
    assert.equal(g.status, 201, JSON.stringify(g.json));
    const goalId = g.json.goal.id;
    const goalExt = `cockpit:goal-${goalId}`;
    const propose = await post(`/goals/${goalId}/nodes/propose`, {
      parent_id: null, actor: 'jarvis',
      items: [{ title: 'leaf1', done_means: 'x' }, { title: 'leaf2', done_means: 'x' }],
    });
    assert.equal(propose.status, 201, JSON.stringify(propose.json));
    const [n1, n2] = propose.json.nodes.map((n: any) => n.id);
    assert.equal((await post(`/goals/${goalId}/batches/${propose.json.batch_id}/accept`, {})).status, 200);
    const c1 = await post(`/goals/${goalId}/nodes/${n1}/thread`, {});
    const c2 = await post(`/goals/${goalId}/nodes/${n2}/thread`, {});
    assert.equal(c1.status, 200); assert.equal(c2.status, 200);
    const ext1 = c1.json.external_id, ext2 = c2.json.external_id;
    pinV05Timestamps(goalId, [goalExt, ext1, ext2], '-10 minutes');
    // bump the SECOND node chat (not the one that happens to sort first) —
    // proves the MAX aggregation, not a "first row wins" bug.
    convDb.sqliteDb.prepare(`UPDATE conversations SET updated_at = datetime('now', '+5 minutes') WHERE external_id = ?`).run(ext2);
    const expected = convDb.getConversation(ext2).updated_at;
    const summary = await getGoalSummary(goalId);
    assert.equal(summary.last_activity, expected);
  });

  await check(
    'V05-6',
    'additive-shape guard: every pre-v0.5 GoalSummary field is still present with the same shape, plus the two new fields',
    async () => {
      const g = await post('/goals', { title: 'V05 shape guard', notes: 'a note', done_means: 'x' });
      assert.equal(g.status, 201, JSON.stringify(g.json));
      const summary = await getGoalSummary(g.json.goal.id);

      const typeOf = (v: unknown): string => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
      const assertField = (key: string, allowed: string[]) => {
        assert.ok(key in summary, `field '${key}' missing from GET /goals row`);
        const t = typeOf(summary[key]);
        assert.ok(allowed.includes(t), `field '${key}': expected one of [${allowed}], got ${t} (${JSON.stringify(summary[key])})`);
      };

      // pre-v0.5 GoalRow fields (unchanged)
      assertField('id', ['number']);
      assertField('title', ['string']);
      assertField('done_means', ['string', 'null']);
      assertField('notes', ['string', 'null']);
      assertField('status', ['string']);
      assertField('authored_by', ['string']);
      assertField('thread_ext', ['string', 'null']);
      assertField('promoted_from_node_id', ['number', 'null']);
      assertField('sort_order', ['number']);
      assertField('verified_at', ['string', 'null']);
      assertField('archived', ['number']);
      assertField('autopilot', ['number']);
      assertField('autopilot_config', ['object', 'null']);
      assertField('created_at', ['string']);
      assertField('updated_at', ['string']);
      // pre-v0.5 GoalSummary additions (unchanged)
      assertField('counts', ['object']);
      for (const k of [
        'total', 'done', 'working', 'check', 'need_you', 'ghosts', 'human_open',
        'awaiting_jarvis', 'node_chats', 'guards', 'guards_failing', 'autopilot_set', 'parked', 'progress',
      ]) {
        assert.equal(typeOf(summary.counts[k]), 'number', `counts.${k} should be a number, got ${typeOf(summary.counts[k])}`);
      }
      assertField('focus_node_id', ['number', 'null']);
      assertField('last_event_at', ['string', 'null']);
      assertField('autopilot_next', ['object', 'null']);
      // v0.5 §16 additions — additive only
      assertField('last_activity', ['string']);
      assertField('hot_nodes', ['array']);
    },
  );

  await check(
    'V05-7',
    'empty goal (no nodes, no node chats, no turns) does not crash — last_activity falls back to goals.updated_at, hot_nodes is []',
    async () => {
      const g = await post('/goals', { title: 'V05 empty goal', done_means: 'x' });
      assert.equal(g.status, 201, JSON.stringify(g.json));
      const goalId = g.json.goal.id;
      const goalExt = `cockpit:goal-${goalId}`;
      // no nodes were ever created, so there is no node-chat row for this goal at
      // all (not even a null one) — push the other two signals into the past so
      // goals.updated_at is unambiguously the max, and confirm the fallback.
      convDb.sqliteDb.prepare(`UPDATE goal_events SET created_at = datetime('now', '-10 minutes') WHERE goal_id = ?`).run(goalId);
      convDb.sqliteDb.prepare(`UPDATE conversations SET updated_at = datetime('now', '-10 minutes') WHERE external_id = ?`).run(goalExt);
      convDb.sqliteDb.prepare(`UPDATE goals SET updated_at = datetime('now', '-1 minutes') WHERE id = ?`).run(goalId);
      const tree = await get(`/goals/${goalId}`);
      assert.equal(tree.status, 200);
      assert.deepEqual(tree.json.nodes, [], 'genuinely empty tree');
      const expected = (convDb.sqliteDb.prepare(`SELECT updated_at FROM goals WHERE id = ?`).get(goalId) as any).updated_at;
      const summary = await getGoalSummary(goalId);
      assert.equal(summary.last_activity, expected);
      assert.deepEqual(summary.hot_nodes, [], 'no candidate nodes -> empty hot_nodes, no crash');
    },
  );

  await check(
    'V05-8',
    'hot_nodes: priority working(1) > check(2) > need-you(3), recency tie-break within a tier, capped at 3',
    async () => {
      const g = await post('/goals', { title: 'V05 hot nodes', done_means: 'x' });
      assert.equal(g.status, 201, JSON.stringify(g.json));
      const goalId = g.json.goal.id;

      // N1: a ghost, will end up the OLDEST need-you candidate (excluded by the cap)
      const n1p = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'N1 ghost (oldest)', done_means: 'x' }] });
      assert.equal(n1p.status, 201, JSON.stringify(n1p.json));
      const n1 = n1p.json.nodes[0].id;

      // N2: an open human leaf (state=set, leaf_kind=human) — a second need-you candidate, also excluded by the cap
      const n2p = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'N2 human-open', done_means: 'x' }] });
      assert.equal(n2p.status, 201, JSON.stringify(n2p.json));
      const n2 = n2p.json.nodes[0].id;
      assert.equal((await post(`/goals/${goalId}/batches/${n2p.json.batch_id}/accept`, {})).status, 200);
      assert.equal((await post(`/goals/${goalId}/nodes/${n2}/leaf_kind`, { leaf_kind: 'human' })).status, 200);

      // N3: a machine leaf with an approved plan -> state=working, priority 1
      const n3p = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'N3 working', done_means: 'x' }] });
      assert.equal(n3p.status, 201, JSON.stringify(n3p.json));
      const n3 = n3p.json.nodes[0].id;
      assert.equal((await post(`/goals/${goalId}/batches/${n3p.json.batch_id}/accept`, {})).status, 200);
      assert.equal((await post(`/goals/${goalId}/nodes/${n3}/leaf_kind`, { leaf_kind: 'machine' })).status, 200);
      const planned = await post(`/goals/${goalId}/nodes/${n3}/propose_plan`, {
        plan: {
          what: 'x', deliverable: 'y', model: 'claude-sonnet-5', adapter: 'claude',
          nodes: [{ title: 'n', spec: 's', adapter: 'claude', model: 'claude-sonnet-5' }],
        },
      });
      assert.equal(planned.status, 200, JSON.stringify(planned.json));
      const approved = await post(`/goals/${goalId}/nodes/${n3}/approve_plan`, {});
      assert.equal(approved.status, 200, JSON.stringify(approved.json));
      assert.equal(approved.json.node.state, 'working');

      // N4: a human leaf taken to human_done -> state=check, priority 2
      const n4p = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'N4 check', done_means: 'x' }] });
      assert.equal(n4p.status, 201, JSON.stringify(n4p.json));
      const n4 = n4p.json.nodes[0].id;
      assert.equal((await post(`/goals/${goalId}/batches/${n4p.json.batch_id}/accept`, {})).status, 200);
      assert.equal((await post(`/goals/${goalId}/nodes/${n4}/leaf_kind`, { leaf_kind: 'human' })).status, 200);
      const done4 = await post(`/goals/${goalId}/nodes/${n4}/human_done`, {});
      assert.equal(done4.status, 200, JSON.stringify(done4.json));
      assert.equal(done4.json.node.state, 'check');

      // N5: a second, newer ghost — the need-you candidate that SHOULD win the 3rd slot
      const n5p = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'N5 ghost (newest)', done_means: 'x' }] });
      assert.equal(n5p.status, 201, JSON.stringify(n5p.json));
      const n5 = n5p.json.nodes[0].id;

      // Pin recency deterministically (all 5 mutations above can land inside the
      // same 1-second datetime('now') bucket during a fast run).
      const offsets: Array<[number, string]> = [
        [n1, '-20 minutes'], [n2, '-15 minutes'], [n3, '-10 minutes'], [n4, '-5 minutes'], [n5, '+5 minutes'],
      ];
      for (const [id, off] of offsets) {
        convDb.sqliteDb.prepare(`UPDATE goal_nodes SET updated_at = datetime('now', ?) WHERE id = ?`).run(off, id);
      }

      const summary = await getGoalSummary(goalId);
      assert.equal(summary.hot_nodes.length, 3, `expected the cap of 3, got ${JSON.stringify(summary.hot_nodes)}`);
      assert.deepEqual(
        summary.hot_nodes.map((n: any) => n.id),
        [n3, n4, n5],
        'working first, then check, then the single most-recent need-you node (N1/N2 excluded by the cap despite qualifying)',
      );
      assert.deepEqual(summary.hot_nodes.map((n: any) => n.state), ['working', 'check', 'ghost']);
      assert.deepEqual(summary.hot_nodes.map((n: any) => n.title), ['N3 working', 'N4 check', 'N5 ghost (newest)']);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // v0.6 §17 — COMMAND DECK board payload: GET /goals/board (map + attention +
  // in_flight), CONTRACT.md §17, checks V06-*.
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n[19] v0.6 §17: GET /goals/board — map + attention + in_flight');
  async function getBoard(): Promise<any> {
    const r = await get('/goals/board');
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return r.json;
  }
  function mapNode(board: any, nodeId: number): any {
    return board.map.find((n: any) => n.id === nodeId);
  }
  function attentionFor(board: any, kind: string, nodeId: number | null): any {
    return board.attention.find((a: any) => a.kind === kind && a.node_id === nodeId);
  }

  await check('V06-1', 'shape: goals/map/attention/in_flight all present; goals matches GET /goals?include_done=1', async () => {
    const board = await getBoard();
    assert.ok(Array.isArray(board.goals));
    assert.ok(Array.isArray(board.map));
    assert.ok(Array.isArray(board.attention));
    assert.ok(Array.isArray(board.in_flight));
    const listed = (await get('/goals?include_done=1')).json.goals;
    assert.deepEqual(board.goals.map((g: any) => g.id).sort((a: number, b: number) => a - b), listed.map((g: any) => g.id).sort((a: number, b: number) => a - b));
  });

  await check('V06-2', 'map: a plain ghost -> flag "ghost"; a plain set leaf -> flag null; has_chat/sort_order/leaf_kind carried', async () => {
    const g = await post('/goals', { title: 'V06 map drill', done_means: 'x' });
    const goalId = g.json.goal.id;
    const gp = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'V06 ghost', done_means: 'x' }] });
    const ghostId = gp.json.nodes[0].id;
    const sp = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'V06 set', done_means: 'x' }] });
    const setId = sp.json.nodes[0].id;
    assert.equal((await post(`/goals/${goalId}/batches/${sp.json.batch_id}/accept`, {})).status, 200);

    const board = await getBoard();
    const ghostRow = mapNode(board, ghostId);
    assert.ok(ghostRow, 'ghost node present in map');
    assert.equal(ghostRow.goal_id, goalId, 'each map row is tagged with its goal so the client can group without a second lookup');
    assert.equal(ghostRow.state, 'ghost');
    assert.equal(ghostRow.flag, 'ghost');
    assert.equal(ghostRow.has_chat, false);
    assert.equal(ghostRow.leaf_kind, 'none');
    assert.equal(typeof ghostRow.sort_order, 'number');

    const setRow = mapNode(board, setId);
    assert.ok(setRow, 'set node present in map');
    assert.equal(setRow.state, 'set');
    assert.equal(setRow.flag, null, 'a settled set node carries no flag');

    assert.ok(attentionFor(board, 'ghost_awaiting_you', ghostId), 'the ghost is in the Kevin-actionable queue');
  });

  await check('V06-3', 'map+attention: review_state=awaiting_jarvis -> flag "awaiting_jarvis" and EXCLUDED from attention (that is JARVIS\'s queue)', async () => {
    const g = await post('/goals', { title: 'V06 awaiting_jarvis drill', done_means: 'x' });
    const goalId = g.json.goal.id;
    const gp = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'V06 kevin-edited ghost', done_means: 'x' }] });
    const nodeId = gp.json.nodes[0].id;
    assert.equal((await patch(`/goals/${goalId}/nodes/${nodeId}`, { title: 'V06 kevin-edited ghost (reworded)', actor: 'kevin' })).status, 200);
    const accepted = await post(`/goals/${goalId}/nodes/${nodeId}/accept`, { actor: 'kevin' });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
    assert.equal(accepted.json.node.review_state, 'awaiting_jarvis');
    assert.equal(accepted.json.node.state, 'ghost', 'still a ghost — accept did not set it, JARVIS has not weighed in yet');

    const board = await getBoard();
    const row = mapNode(board, nodeId);
    assert.ok(row, 'node present in map');
    assert.equal(row.flag, 'awaiting_jarvis');
    assert.equal(attentionFor(board, 'ghost_awaiting_you', nodeId), undefined, 'not Kevin-actionable — the ball is with JARVIS');
    assert.equal(board.attention.find((a: any) => a.node_id === nodeId), undefined, 'no attention item of ANY kind for this node while awaiting_jarvis');
  });

  await check('V06-4', 'map+attention: a JARVIS pending edit on a set node -> flag "pending_edit", kind "ghost_awaiting_you"', async () => {
    const g = await post('/goals', { title: 'V06 pending-edit drill', done_means: 'x' });
    const goalId = g.json.goal.id;
    const sp = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'V06 will-be-edited', done_means: 'x' }] });
    const nodeId = sp.json.nodes[0].id;
    assert.equal((await post(`/goals/${goalId}/batches/${sp.json.batch_id}/accept`, {})).status, 200);
    const edited = await post(`/goals/${goalId}/nodes/${nodeId}/propose_edit`, { title: 'V06 will-be-edited (proposed)', actor: 'jarvis' });
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    assert.equal(edited.json.node.pending_title, 'V06 will-be-edited (proposed)');

    const board = await getBoard();
    const row = mapNode(board, nodeId);
    assert.equal(row.state, 'set', 'a pending edit never touches state');
    assert.equal(row.flag, 'pending_edit');
    const item = attentionFor(board, 'ghost_awaiting_you', nodeId);
    assert.ok(item, 'a pending JARVIS proposal on a set node is Kevin-actionable, same bucket as a plain ghost');
    assert.equal(item.goal_title, 'V06 pending-edit drill');
  });

  await check('V06-5', 'attention: an open human leaf -> kind "human_open"', async () => {
    const g = await post('/goals', { title: 'V06 human-open drill', done_means: 'x' });
    const goalId = g.json.goal.id;
    const sp = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'V06 human leaf', done_means: 'x' }] });
    const nodeId = sp.json.nodes[0].id;
    assert.equal((await post(`/goals/${goalId}/batches/${sp.json.batch_id}/accept`, {})).status, 200);
    assert.equal((await post(`/goals/${goalId}/nodes/${nodeId}/leaf_kind`, { leaf_kind: 'human' })).status, 200);

    const board = await getBoard();
    const item = attentionFor(board, 'human_open', nodeId);
    assert.ok(item, 'open human leaf present in attention');
    assert.equal(item.node_title, 'V06 human leaf');
  });

  await check('V06-6', 'attention+in_flight: a working leaf whose tree is blocked -> kind "need_you" AND still listed in in_flight', async () => {
    const g = await post('/goals', { title: 'V06 blocked-tree drill', done_means: 'x' });
    const goalId = g.json.goal.id;
    const sp = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'V06 working leaf', done_means: 'x' }] });
    const nodeId = sp.json.nodes[0].id;
    assert.equal((await post(`/goals/${goalId}/batches/${sp.json.batch_id}/accept`, {})).status, 200);
    assert.equal((await post(`/goals/${goalId}/nodes/${nodeId}/leaf_kind`, { leaf_kind: 'machine' })).status, 200);
    const planned = await post(`/goals/${goalId}/nodes/${nodeId}/propose_plan`, {
      plan: { what: 'x', deliverable: 'y', model: 'claude-sonnet-5', adapter: 'claude', nodes: [{ title: 'n', spec: 's', adapter: 'claude', model: 'claude-sonnet-5' }] },
    });
    assert.equal(planned.status, 200, JSON.stringify(planned.json));
    const approved = await post(`/goals/${goalId}/nodes/${nodeId}/approve_plan`, {});
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    assert.equal(approved.json.node.state, 'working');
    const treeId = approved.json.node.tree_id;
    assert.ok(treeId, 'tree_id set on dispatch');
    convDb.sqliteDb.prepare(`UPDATE goal_nodes SET tree_status_cache = 'blocked' WHERE id = ?`).run(nodeId);

    const board = await getBoard();
    const need = attentionFor(board, 'need_you', nodeId);
    assert.ok(need, 'blocked working leaf present in attention as need_you');
    const flight = board.in_flight.find((f: any) => f.node_id === nodeId);
    assert.ok(flight, 'a blocked leaf is STILL in_flight — it is working, just stuck');
    assert.equal(flight.tree_id, treeId);
    assert.equal(flight.goal_title, 'V06 blocked-tree drill');
    assert.equal(flight.node_title, 'V06 working leaf');
    assert.equal(typeof flight.since, 'string');
  });

  await check('V06-7', 'attention: a failing/error guard -> kind "guard_failing" (node-scoped and goal-scoped)', async () => {
    const g = await post('/goals', { title: 'V06 guard drill', done_means: 'x' });
    const goalId = g.json.goal.id;
    const sp = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'V06 guarded node', done_means: 'x' }] });
    const nodeId = sp.json.nodes[0].id;
    assert.equal((await post(`/goals/${goalId}/batches/${sp.json.batch_id}/accept`, {})).status, 200);
    // Direct insert — the guard lifecycle itself (propose/accept/poll) is
    // covered end-to-end by goals:guards-check; this only proves the board
    // reads goal_guards correctly.
    convDb.sqliteDb.prepare(`
      INSERT INTO goal_guards (goal_id, node_id, state, mode, title, health, authored_by)
      VALUES (?, ?, 'set', 'query', 'V06 node guard', 'failing', 'jarvis')
    `).run(goalId, nodeId);
    convDb.sqliteDb.prepare(`
      INSERT INTO goal_guards (goal_id, node_id, state, mode, title, health, authored_by)
      VALUES (?, NULL, 'set', 'query', 'V06 goal-level guard', 'error', 'jarvis')
    `).run(goalId);

    const board = await getBoard();
    const nodeGuard = attentionFor(board, 'guard_failing', nodeId);
    assert.ok(nodeGuard, 'node-scoped failing guard present');
    assert.equal(nodeGuard.node_title, 'V06 guarded node');
    const goalGuard = board.attention.find((a: any) => a.kind === 'guard_failing' && a.goal_id === goalId && a.node_id === null);
    assert.ok(goalGuard, 'goal-scoped (no node_id) error guard present with node_id null');
  });

  await check('V06-8', "attention: a node parked by a non-kevin actor on an autopilot goal -> kind \"autopilot_parked\"", async () => {
    const g = await post('/goals', { title: 'V06 autopilot-parked drill', done_means: 'x' });
    const goalId = g.json.goal.id;
    const sp = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'V06 park me', done_means: 'x' }] });
    const nodeId = sp.json.nodes[0].id;
    assert.equal((await post(`/goals/${goalId}/batches/${sp.json.batch_id}/accept`, {})).status, 200);
    // Flip autopilot on directly (bypasses route 37's own side effects — the
    // driver's 1s kick timer is irrelevant here since we read the board and
    // flip autopilot back off again in the same synchronous tick).
    convDb.sqliteDb.prepare(`UPDATE goals SET autopilot = 1 WHERE id = ?`).run(goalId);
    const parked = goalsModule.parkGoalNode(goalId, nodeId, 'system', 'verify failed 2/2: no gap text');
    assert.equal(parked.state, 'parked');
    convDb.sqliteDb.prepare(`UPDATE goals SET autopilot = 0 WHERE id = ?`).run(goalId);

    const board = await getBoard();
    const item = attentionFor(board, 'autopilot_parked', nodeId);
    assert.ok(item, 'autopilot-parked node present in attention');
    assert.equal(item.node_title, 'V06 park me');

    // A Kevin-actor park never fires the event -> never shows as autopilot_parked.
    const g2 = await post('/goals', { title: 'V06 kevin-parked drill', done_means: 'x' });
    const goalId2 = g2.json.goal.id;
    const sp2 = await post(`/goals/${goalId2}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'V06 kevin parks this', done_means: 'x' }] });
    const nodeId2 = sp2.json.nodes[0].id;
    assert.equal((await post(`/goals/${goalId2}/batches/${sp2.json.batch_id}/accept`, {})).status, 200);
    assert.equal((await post(`/goals/${goalId2}/nodes/${nodeId2}/park`, {})).status, 200);
    const board2 = await getBoard();
    assert.equal(attentionFor(board2, 'autopilot_parked', nodeId2), undefined, "Kevin's own park is not an autopilot park");
  });

  await check('V06-9', 'attention: a node sitting in `check` -> kind "goal_check" (node_id set)', async () => {
    const g = await post('/goals', { title: 'V06 node-check drill', done_means: 'x' });
    const goalId = g.json.goal.id;
    const sp = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'V06 human -> check', done_means: 'x' }] });
    const nodeId = sp.json.nodes[0].id;
    assert.equal((await post(`/goals/${goalId}/batches/${sp.json.batch_id}/accept`, {})).status, 200);
    assert.equal((await post(`/goals/${goalId}/nodes/${nodeId}/leaf_kind`, { leaf_kind: 'human' })).status, 200);
    const done = await post(`/goals/${goalId}/nodes/${nodeId}/human_done`, {});
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal(done.json.node.state, 'check');

    const board = await getBoard();
    const item = attentionFor(board, 'goal_check', nodeId);
    assert.ok(item, 'check-state node present in attention');
    assert.equal(item.goal_id, goalId);
  });

  await check('V06-10', 'attention: a goal root ready to verify -> kind "goal_check" (node_id null); a parked sibling does not block readiness (denom excludes parked)', async () => {
    const g = await post('/goals', { title: 'V06 root-ready drill', done_means: 'x' });
    const goalId = g.json.goal.id;
    const aP = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'V06 A (will be done)', done_means: 'x' }] });
    const nodeA = aP.json.nodes[0].id;
    const bP = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'V06 B (will be parked)', done_means: 'x' }] });
    const nodeB = bP.json.nodes[0].id;
    assert.equal((await post(`/goals/${goalId}/batches/${aP.json.batch_id}/accept`, {})).status, 200);
    assert.equal((await post(`/goals/${goalId}/batches/${bP.json.batch_id}/accept`, {})).status, 200);

    // Not ready yet: A still set, B still set.
    assert.equal(attentionFor(await getBoard(), 'goal_check', null), undefined);

    assert.equal((await post(`/goals/${goalId}/nodes/${nodeB}/park`, {})).status, 200);
    assert.equal((await post(`/goals/${goalId}/nodes/${nodeA}/leaf_kind`, { leaf_kind: 'human' })).status, 200);
    assert.equal((await post(`/goals/${goalId}/nodes/${nodeA}/human_done`, {})).status, 200);
    assert.equal((await post(`/goals/${goalId}/nodes/${nodeA}/verify`, { passed: true })).status, 200);

    const board = await getBoard();
    const item = board.attention.find((a: any) => a.kind === 'goal_check' && a.goal_id === goalId && a.node_id === null);
    assert.ok(item, 'root ready-to-verify present even though one sibling is parked, not done');
    assert.equal(item.node_title, null);
    assert.equal(item.goal_title, 'V06 root-ready drill');
  });

  await check('V06-11', 'in_flight: a plain (unblocked) working leaf is listed with the right tree_id/titles', async () => {
    const g = await post('/goals', { title: 'V06 in-flight drill', done_means: 'x' });
    const goalId = g.json.goal.id;
    const sp = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'V06 dispatched leaf', done_means: 'x' }] });
    const nodeId = sp.json.nodes[0].id;
    assert.equal((await post(`/goals/${goalId}/batches/${sp.json.batch_id}/accept`, {})).status, 200);
    assert.equal((await post(`/goals/${goalId}/nodes/${nodeId}/leaf_kind`, { leaf_kind: 'machine' })).status, 200);
    assert.equal((await post(`/goals/${goalId}/nodes/${nodeId}/propose_plan`, {
      plan: { what: 'x', deliverable: 'y', model: 'claude-sonnet-5', adapter: 'claude', nodes: [{ title: 'n', spec: 's', adapter: 'claude', model: 'claude-sonnet-5' }] },
    })).status, 200);
    const approved = await post(`/goals/${goalId}/nodes/${nodeId}/approve_plan`, {});
    assert.equal(approved.status, 200, JSON.stringify(approved.json));

    const board = await getBoard();
    const item = board.in_flight.find((f: any) => f.node_id === nodeId);
    assert.ok(item, 'dispatched leaf present in in_flight');
    assert.equal(item.goal_id, goalId);
    assert.equal(item.goal_title, 'V06 in-flight drill');
    assert.equal(item.node_title, 'V06 dispatched leaf');
    assert.equal(item.tree_id, approved.json.node.tree_id);
    assert.equal(attentionFor(board, 'need_you', nodeId), undefined, 'an unblocked working leaf is not need_you');
  });

  await check('V06-12', 'attention: sorted oldest-first across mixed kinds', async () => {
    const older = await post('/goals', { title: 'V06 order drill (older)', done_means: 'x' });
    const olderGoalId = older.json.goal.id;
    const olderP = await post(`/goals/${olderGoalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'V06 older ghost', done_means: 'x' }] });
    const olderNodeId = olderP.json.nodes[0].id;

    const newer = await post('/goals', { title: 'V06 order drill (newer)', done_means: 'x' });
    const newerGoalId = newer.json.goal.id;
    const newerP = await post(`/goals/${newerGoalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'V06 newer human', done_means: 'x' }] });
    const newerNodeId = newerP.json.nodes[0].id;
    assert.equal((await post(`/goals/${newerGoalId}/batches/${newerP.json.batch_id}/accept`, {})).status, 200);
    assert.equal((await post(`/goals/${newerGoalId}/nodes/${newerNodeId}/leaf_kind`, { leaf_kind: 'human' })).status, 200);

    convDb.sqliteDb.prepare(`UPDATE goal_nodes SET updated_at = datetime('now', '-1 hour') WHERE id = ?`).run(olderNodeId);
    convDb.sqliteDb.prepare(`UPDATE goal_nodes SET updated_at = datetime('now', '+1 hour') WHERE id = ?`).run(newerNodeId);

    const board = await getBoard();
    const olderIdx = board.attention.findIndex((a: any) => a.node_id === olderNodeId);
    const newerIdx = board.attention.findIndex((a: any) => a.node_id === newerNodeId);
    assert.ok(olderIdx !== -1 && newerIdx !== -1, 'both items present');
    assert.ok(olderIdx < newerIdx, 'the older item sorts before the newer one (oldest-first)');
  });

  await check('V06-13', 'map/attention/in_flight exclude archived goals; the goals array excludes them too', async () => {
    const g = await post('/goals', { title: 'V06 archive-me drill', done_means: 'x' });
    const goalId = g.json.goal.id;
    const sp = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'V06 node in an archived goal', done_means: 'x' }] });
    const nodeId = sp.json.nodes[0].id;
    assert.equal((await patch(`/goals/${goalId}`, { archived: true })).status, 200);

    const board = await getBoard();
    assert.equal(board.goals.find((x: any) => x.id === goalId), undefined, 'archived goal excluded from goals');
    assert.equal(mapNode(board, nodeId), undefined, 'its node excluded from map');
    assert.equal(board.attention.find((a: any) => a.goal_id === goalId), undefined, 'no attention items from an archived goal');
  });

  await check('V06-14', 'map: titles over 60 chars are truncated with an ellipsis; the full title is untouched elsewhere', async () => {
    const longTitle = 'V06 a very long node title that is deliberately well past the sixty character cap for the mini-map rail';
    assert.ok(longTitle.length > 60, 'fixture sanity');
    const g = await post('/goals', { title: 'V06 truncation drill', done_means: 'x' });
    const goalId = g.json.goal.id;
    const sp = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: longTitle, done_means: 'x' }] });
    const nodeId = sp.json.nodes[0].id;

    const board = await getBoard();
    const row = mapNode(board, nodeId);
    assert.ok(row, 'node present');
    assert.equal(row.title.length, 60);
    assert.ok(row.title.endsWith('…'));
    assert.ok(longTitle.startsWith(row.title.slice(0, 59)));

    const tree = (await get(`/goals/${goalId}`)).json;
    const full = tree.nodes.find((n: any) => n.id === nodeId);
    assert.equal(full.title, longTitle, 'the full-fidelity node read is never truncated');
  });

  await check('V06-15', 'additive guard: GET /goals and GET /goals/:id shapes are untouched by /goals/board — same keys, same values, no mutation', async () => {
    const g = await post('/goals', { title: 'V06 additive-guard drill', done_means: 'x' });
    const goalId = g.json.goal.id;
    const sp = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'V06 additive-guard node', done_means: 'x' }] });
    const nodeId = sp.json.nodes[0].id;
    assert.equal((await post(`/goals/${goalId}/batches/${sp.json.batch_id}/accept`, {})).status, 200);

    const listBefore = await get('/goals?include_done=1');
    const detailBefore = await get(`/goals/${goalId}`);
    assert.equal(listBefore.status, 200);
    assert.equal(detailBefore.status, 200);

    // buildGoalsBoard()'s `goals` field is listGoals(true,false) verbatim — the
    // SAME function GET /goals calls — so this is a code-sharing guarantee, not
    // a coincidence; the sim proves it holds at the wire level too.
    const board = await getBoard();
    const boardGoal = board.goals.find((x: any) => x.id === goalId);
    const listGoal = listBefore.json.goals.find((x: any) => x.id === goalId);
    assert.ok(boardGoal && listGoal);
    assert.deepEqual(boardGoal, listGoal, 'board.goals entry is byte-identical to the GET /goals entry for the same goal');
    assert.deepEqual(Object.keys(boardGoal).sort(), Object.keys(listGoal).sort(), 'no v0.6-only fields leaked onto the shared GoalSummary shape');

    // /goals/board is read-only: calling it changes nothing observable via the
    // pre-existing routes.
    const listAfter = await get('/goals?include_done=1');
    const detailAfter = await get(`/goals/${goalId}`);
    assert.deepEqual(listAfter.json, listBefore.json, 'GET /goals response unchanged by a GET /goals/board call in between');
    assert.deepEqual(detailAfter.json, detailBefore.json, 'GET /goals/:id response unchanged by a GET /goals/board call in between');

    // The map row's reduced/truncated shape never leaks new keys onto the
    // full-fidelity node object either.
    const fullNode = detailAfter.json.nodes.find((n: any) => n.id === nodeId);
    assert.ok(fullNode);
    assert.equal('flag' in fullNode, false, 'the board-only "flag" field does not appear on GET /goals/:id nodes');
    assert.equal('has_chat' in fullNode, false, 'the board-only "has_chat" field does not appear on GET /goals/:id nodes');
  });

  await check('V06-16', 'robustness: board payload never crashes and returns valid empty arrays when a slice has zero signal', async () => {
    // A true zero-goal DB isn't reachable this late in the suite (hundreds of
    // goals already exist from earlier sections), so this proves the same
    // property the CONTRACT cares about — "no crash, valid empty arrays" —
    // against slices that ARE genuinely empty at this point: no goal has ever
    // used an impossible id, and (freshly, for this check) a brand-new goal
    // with zero nodes has an empty map/attention/in_flight slice of its own.
    const board = await getBoard();
    assert.ok(Array.isArray(board.goals) && board.goals.length > 0, 'sanity: the scratch DB is not literally empty by this point');
    assert.equal(board.map.find((n: any) => n.goal_id === -1), undefined);
    assert.equal(board.attention.find((a: any) => a.goal_id === -1), undefined);
    assert.equal(board.in_flight.find((f: any) => f.goal_id === -1), undefined);

    const g = await post('/goals', { title: 'V06 empty-goal drill', done_means: 'x' });
    const goalId = g.json.goal.id;
    const board2 = await getBoard();
    assert.equal(board2.map.filter((n: any) => n.goal_id === goalId).length, 0, 'a goal with zero nodes contributes nothing to map');
    assert.equal(board2.attention.filter((a: any) => a.goal_id === goalId).length, 0, 'a goal with zero nodes contributes nothing to attention');
    assert.equal(board2.in_flight.filter((f: any) => f.goal_id === goalId).length, 0, 'a goal with zero nodes contributes nothing to in_flight');
    assert.ok(board2.goals.find((x: any) => x.id === goalId), 'the empty goal itself is still listed in goals');
  });

  await check('V06-17', 'REVIEW (node #607): guard_failing `since` is FAILING-since, not LAST-CHECKED — a guard re-polled red keeps its original age', async () => {
    const g = await post('/goals', { title: 'V06 guard-age drill', done_means: 'x' });
    const goalId = g.json.goal.id;
    const sp = await post(`/goals/${goalId}/nodes/propose`, { parent_id: null, actor: 'jarvis', items: [{ title: 'V06 aged guard node', done_means: 'x' }] });
    const nodeId = sp.json.nodes[0].id;
    assert.equal((await post(`/goals/${goalId}/batches/${sp.json.batch_id}/accept`, {})).status, 200);
    const info = convDb.sqliteDb.prepare(`
      INSERT INTO goal_guards (goal_id, node_id, state, mode, title, health, authored_by, last_checked_at, updated_at)
      VALUES (?, ?, 'set', 'query', 'V06 aged guard', 'failing', 'jarvis', datetime('now'), datetime('now'))
    `).run(goalId, nodeId);
    const guardId = Number(info.lastInsertRowid);
    // The transition event the poller writes when it first went red, three days ago.
    const threeDaysAgo = "datetime('now', '-3 days')";
    convDb.sqliteDb.prepare(`
      INSERT INTO goal_events (goal_id, node_id, actor, kind, text, data, created_at)
      VALUES (?, ?, 'system', 'guard_failed', 'went red', ?, ${threeDaysAgo})
    `).run(goalId, nodeId, JSON.stringify({ guard_id: guardId, health: 'failing' }));

    const board = await getBoard();
    const item = attentionFor(board, 'guard_failing', nodeId);
    assert.ok(item, 'failing guard still present in attention');
    const ageMs = Date.now() - new Date(`${item.since.replace(' ', 'T')}Z`).getTime();
    assert.ok(ageMs > 2.5 * 24 * 3600 * 1000, `since must date the FAILING transition, not the last poll (got ${item.since})`);

    // Another poll that leaves it red rewrites last_checked_at/updated_at but
    // must NOT rejuvenate the queue entry (the pre-fix bug).
    convDb.sqliteDb.prepare(`UPDATE goal_guards SET last_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(guardId);
    const board2 = await getBoard();
    const item2 = attentionFor(board2, 'guard_failing', nodeId);
    assert.equal(item2.since, item.since, 'a no-change re-poll leaves `since` untouched');

    // A guard that never transitioned (seeded red) still falls back cleanly.
    const info2 = convDb.sqliteDb.prepare(`
      INSERT INTO goal_guards (goal_id, node_id, state, mode, title, health, authored_by, last_checked_at)
      VALUES (?, NULL, 'set', 'query', 'V06 never-transitioned guard', 'error', 'jarvis', datetime('now'))
    `).run(goalId);
    assert.ok(info2.lastInsertRowid);
    const board3 = await getBoard();
    const rootGuard = board3.attention.find((a: any) => a.kind === 'guard_failing' && a.goal_id === goalId && a.node_id === null);
    assert.ok(rootGuard, 'an eventless guard still surfaces (fallback to last_checked_at)');
    assert.equal(typeof rootGuard.since, 'string');
  });
} finally {
  server.close();
  owServer?.close();
}

// ═══════════════════════════════════════════════════════════════════════════
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
console.log(`\n[goals-sim] ${passed}/${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ' ✅'}`);

const outDir = '/home/kevin/obsidian/paperclip-wiki/outbox/goals';
fs.mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, 'sim-report.md');
const lines: string[] = [];
lines.push('# GOALS — sim report (hopper node #459; v0.3 §14 node chats added by node #489; v0.5 §16 forest payload added by node #601; v0.6 §17 board payload added by node #604, additive-guard + empty-slice checks added by node #606, guard-age check added by the adversarial review node #607)');
lines.push('');
lines.push(`Run at ${new Date().toISOString()}. Scratch DB: \`${DB_PATH}\`. ${passed}/${results.length} checks passed.`);
lines.push('');
lines.push('Drives the real `createApiV1Router()` over real HTTP on a throwaway port, against a scratch');
lines.push('sqlite copy — never `jarvis.db`. Hopper worker spawn is stubbed with a fake `processMessage`');
lines.push('(mirrors `scripts/foundry-sim.mjs`) so `dispatchTick` runs for real (claims ready leaves,');
lines.push('applies dependency ordering) but **zero live model calls are made anywhere in this file**.');
lines.push('Tree completion is driven through the real finish contract, `POST /hopper-nodes/:id/finish`.');
lines.push('');
lines.push('| # | Check | Result |');
lines.push('|---|---|---|');
for (const r of results) {
  lines.push(`| ${r.id} | ${r.description} | ${r.pass ? '✅ pass' : `❌ **FAIL** — ${r.error}`} |`);
}
lines.push('');
if (failed.length) {
  lines.push('## Failures');
  lines.push('');
  for (const r of failed) {
    lines.push(`### [${r.id}] ${r.description}`);
    lines.push('');
    lines.push('```');
    lines.push(r.error ?? '(no error captured)');
    lines.push('```');
    lines.push('');
  }
} else {
  lines.push("All checks passed against `CONTRACT.md` §10's acceptance list during this run.");
}
lines.push('');
lines.push('## Notes for REVIEW-BACKEND (not treated as bugs, not patched here)');
lines.push('');
lines.push(
  '1. **`proposeRemoval`\'s error code on a `working` leaf.** CONTRACT.md §3.3 route 18 says propose_removal ' +
    'is "Only on `state ∈ {set}` … and not `working` (`409 leaf_already_dispatched`)". But the implementation\'s ' +
    'first-hit precondition is simply `state !== \'set\' → 409 invalid_transition`, and `working` is never `set` ' +
    '— so that specific branch is unreachable as literally worded; a working leaf 409s with `invalid_transition` ' +
    'instead of `leaf_already_dispatched`. The BLOCK itself is correct (removal is refused either way); this is ' +
    'purely an error-code-specificity question. Left as-is rather than guessing the intended fix (see check 7f).',
);
lines.push(
  '2. **`buildGoalThreadContext`\'s no-focus attribute rendering.** CONTRACT.md §6\'s example only shows a ' +
    '*focused* render (`node_id="87"`, real `path`/`state`/`leaf_kind` values). With no focus set, the ' +
    'implementation renders `node_id=""` and empty `path`/`state`/`leaf_kind` attrs rather than a literal `"null"` ' +
    'or omitting the line. Defensible, but worth a second look if any downstream prompt template string-matches ' +
    'on `node_id="null"` (see check 12c).',
);
fs.writeFileSync(reportPath, lines.join('\n') + '\n');
console.log(`[goals-sim] report written: ${reportPath}`);

if (failed.length) process.exitCode = 1;
