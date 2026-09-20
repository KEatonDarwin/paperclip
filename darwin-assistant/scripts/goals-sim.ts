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

const distDir = path.join(repoRoot, 'dist');
const express = (await import('express')).default;
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const hopperEngine = await import(path.join(distDir, 'hopper-engine.js'));
const goalsModule = await import(path.join(distDir, 'goals.js'));

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

  await check('V02-2', 'V01 regressions intact: ghost round still needs Kevin ✓; sort_order-only ghost PATCH untouched (checked above); counts', async () => {
    const tree = (await get(`/goals/${v02GoalId}`)).json;
    assert.equal(tree.goal.counts.awaiting_jarvis, 0, 'every round closed');
    for (const n of tree.nodes) {
      assert.equal(n.pending_parent_id, null, `no stray pending move on #${n.id}`);
      assert.ok('kevin_moved_at' in n && 'kevin_move_from' in n, 'new columns present on every read');
    }
    sseV02.close();
  });
} finally {
  server.close();
}

// ═══════════════════════════════════════════════════════════════════════════
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);
console.log(`\n[goals-sim] ${passed}/${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ' ✅'}`);

const outDir = '/home/kevin/obsidian/paperclip-wiki/outbox/goals';
fs.mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, 'sim-report.md');
const lines: string[] = [];
lines.push('# GOALS — sim report (hopper node #459)');
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
