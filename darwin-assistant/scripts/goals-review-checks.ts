// GOALS — REVIEW regression checks (hopper node #460, adversarial review).
// One focused check per defect the review found + fixed, so the fixes are
// proven rather than merely compiled. Scratch DB, zero model calls; same
// harness shape as scripts/goals-sim.ts.
//
//   npm run goals:review-checks

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const raw = process.env.JARVIS_DB_PATH ?? '/tmp/goals-review.db';
const DB_PATH = path.resolve(raw);
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
process.env.JARVIS_DB_PATH = DB_PATH;
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
process.env.HOPPER_GOV_ENABLED = '0';
process.env.HOPPER_ENGINE_SLOTS = process.env.HOPPER_ENGINE_SLOTS ?? '8';
delete process.env.ANTHROPIC_API_KEY;

const distDir = path.join(repoRoot, 'dist');
const express = (await import('express')).default;
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const hopperEngine = await import(path.join(distDir, 'hopper-engine.js'));
const goalsModule = await import(path.join(distDir, 'goals.js'));
const toolsModule = await import(path.join(distDir, 'tools', 'goals-tool.js'));

hopperEngine.startHopperEngine(async () => 'FAKE_WORKER_OK — no model call made.');

const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise<import('node:http').Server>((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s as import('node:http').Server));
});
const addr = server.address();
const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api/v1`;
const key = mintApiKey('goals-review', 'cockpit').plaintext;

async function req(method: string, p: string, body?: unknown) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}
const get = (p: string) => req('GET', p);
const post = (p: string, b: unknown = {}) => req('POST', p, b);
const patch = (p: string, b: unknown = {}) => req('PATCH', p, b);

let pass = 0;
const failures: string[] = [];
async function check(id: string, what: string, fn: () => Promise<void>) {
  try { await fn(); pass += 1; console.log(`  ✓ [${id}] ${what}`); }
  catch (err) { failures.push(`[${id}] ${what} — ${err instanceof Error ? err.message : String(err)}`); console.log(`  ✗ [${id}] ${what}\n      ${err}`); }
}

// ── fixture: a set goal with one machine leaf and one plain child ──────────
const goalId: number = (await post('/goals', { title: 'Review fixture', done_means: 'every review check passes' })).json.goal.id;
const leafId: number = (await post(`/goals/${goalId}/nodes`, { title: 'Machine leaf', done_means: 'branch pushed' })).json.node.id;
const plainId: number = (await post(`/goals/${goalId}/nodes`, { title: 'Plain child', done_means: 'note written' })).json.node.id;

const PLAN = {
  what: 'build the thing', deliverable: 'a branch', model: 'claude-sonnet-5',
  nodes: [{ title: 'build', spec: 's', model: 'claude-sonnet-5', depends_on_indexes: [] }],
};

console.log('\n[R1] park-while-working + tree finishes -> unpark must not strand the node at `working`');
await post(`/goals/${goalId}/nodes/${leafId}/leaf_kind`, { leaf_kind: 'machine' });
await post(`/goals/${goalId}/nodes/${leafId}/propose_plan`, { plan: PLAN, actor: 'jarvis' });
const approved = await post(`/goals/${goalId}/nodes/${leafId}/approve_plan`);
const treeId: string = approved.json.tree.id;

await check('R1a', 'approve_plan -> node working with a live tree', async () => {
  assert.equal(approved.status, 200);
  assert.equal(approved.json.node.state, 'working');
  assert.equal(approved.json.node.tree_id, treeId);
});

await check('R1b', 'park a working node — legal, hopper tree untouched (CONTRACT §2.1)', async () => {
  const r = await post(`/goals/${goalId}/nodes/${leafId}/park`);
  assert.equal(r.json.node.state, 'parked');
  assert.equal(hopperEngine.getHopperTree(treeId).status, 'active');
});

await check('R1c', 'the tree finishes WHILE parked -> completion is recorded on tree_status_cache', async () => {
  for (const n of hopperEngine.listTreeNodes(treeId)) {
    if (n.status !== 'done') {
      hopperEngine.claimHopperNode?.(n.id);
      const fin = await post(`/hopper-nodes/${n.id}/finish`, { outcome: 'done', result: 'ok' });
      if (fin.status !== 200) {
        // node wasn't running yet — drive it through the engine's own claim path
        await new Promise((r) => setTimeout(r, 400));
        await post(`/hopper-nodes/${n.id}/finish`, { outcome: 'done', result: 'ok' });
      }
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(hopperEngine.getHopperTree(treeId).status, 'done', 'hopper tree should be done');
  const node = goalsModule.getRawGoalNode(leafId);
  assert.equal(node.state, 'parked', 'parked node must not auto-flip to check behind Kevin\'s back');
  assert.equal(node.tree_status_cache, 'done', 'REGRESSION: completion was dropped while parked');
});

await check('R1d', 'unpark lands on `check`, not a stranded `working` (the bug this fixes)', async () => {
  const r = await post(`/goals/${goalId}/nodes/${leafId}/unpark`);
  assert.equal(r.status, 200);
  assert.equal(r.json.node.state, 'check', 'REGRESSION: unpark restored `working` with a finished tree — node is stuck forever');
});

console.log('\n[R2] leaf_kind is frozen once a leaf is dispatched');
await check('R2a', 'leaf_kind change on a check/working node -> 409 leaf_already_dispatched', async () => {
  const r = await post(`/goals/${goalId}/nodes/${leafId}/leaf_kind`, { leaf_kind: 'human' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'leaf_already_dispatched');
  assert.equal(goalsModule.getRawGoalNode(leafId).plan_state, 'approved', 'the live plan must survive the rejected re-classification');
});

console.log('\n[R3] a pending EDIT and a pending REMOVAL can never coexist');
await check('R3a', 'propose_removal then propose_edit -> removal flag cleared; ✓ applies the EDIT', async () => {
  await post(`/goals/${goalId}/nodes/${plainId}/propose_removal`, { actor: 'jarvis', reason: 'maybe drop' });
  const pe = await post(`/goals/${goalId}/nodes/${plainId}/propose_edit`, { actor: 'jarvis', title: 'Plain child v2' });
  assert.equal(pe.json.node.pending_removal, 0, 'REGRESSION: stale removal flag would silently discard the node');
  const res = await post(`/goals/${goalId}/nodes/${plainId}/resolve_pending`, { accept: true });
  assert.equal(res.json.node.state, 'set');
  assert.equal(res.json.node.title, 'Plain child v2');
});

await check('R3b', 'propose_edit then propose_removal -> text edit cleared; ✓ removes', async () => {
  await post(`/goals/${goalId}/nodes/${plainId}/propose_edit`, { actor: 'jarvis', done_means: 'note written twice' });
  const pr = await post(`/goals/${goalId}/nodes/${plainId}/propose_removal`, { actor: 'jarvis' });
  assert.equal(pr.json.node.pending_title, null);
  assert.equal(pr.json.node.pending_done_means, null);
  const res = await post(`/goals/${goalId}/nodes/${plainId}/resolve_pending`, { accept: true });
  assert.equal(res.json.node.state, 'discarded');
});

console.log('\n[R4] done_means can never be stripped off a node that is already set');
await check('R4a', 'PATCH done_means:"" on a set node -> 409 done_means_required', async () => {
  const n = (await post(`/goals/${goalId}/nodes`, { title: 'Keeps its done_means', done_means: 'x' })).json.node;
  const r = await patch(`/goals/${goalId}/nodes/${n.id}`, { done_means: '   ' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'done_means_required');
});

console.log('\n[R5] verify passed:false is a 200 no-op on a goal, whatever its status');
await check('R5a', 'POST /goals/:id/verify {passed:false} on a ghost goal -> 200, verified:false', async () => {
  const g = (await post('/goals', { title: 'Ghost goal' })).json.goal;
  const r = await post(`/goals/${g.id}/verify`, { passed: false });
  assert.equal(r.status, 200);
  assert.equal(r.json.verified, false);
});

console.log('\n[R6] the conversation label follows a goal rename (CONTRACT §8)');
await check('R6a', 'PATCH title -> the cockpit:goal-<id> conversation is renamed', async () => {
  const convDb = await import(path.join(distDir, 'conversation-db.js'));
  await patch(`/goals/${goalId}`, { title: 'Review fixture RENAMED' });
  const conv = convDb.getConversation(`cockpit:goal-${goalId}`);
  assert.equal(conv.title ?? conv.label ?? conv.name, '🎯 Review fixture RENAMED');
});

console.log('\n[R7] focus-injection snapshot format (CONTRACT §6)');
await check('R7a', "a collapsed branch carries `(+N)` ON its own row, not as an extra line", async () => {
  const g = (await post('/goals', { title: 'Snapshot goal', done_means: 'snapshot reads right' })).json.goal;
  const a = (await post(`/goals/${g.id}/nodes`, { title: 'Branch A', done_means: 'a' })).json.node;
  const b = (await post(`/goals/${g.id}/nodes`, { title: 'Branch B', done_means: 'b' })).json.node;
  const a1 = (await post(`/goals/${g.id}/nodes`, { title: 'A child', done_means: 'a1', parent_id: a.id })).json.node;
  await post(`/goals/${g.id}/nodes`, { title: 'A grandchild', done_means: 'a2', parent_id: a1.id });
  await post(`/goals/${g.id}/nodes`, { title: 'B child', done_means: 'b1', parent_id: b.id });
  await req('PUT', `/goals/${g.id}/focus`, { node_id: b.id });

  const block: string = goalsModule.buildGoalThreadContext(`cockpit:goal-${g.id}`);
  assert.ok(block.includes('<goal_focus'), 'focus line missing');
  assert.ok(!/^\s*\(\+\d+ more\)\s*$/m.test(block), 'REGRESSION: `(+N more)` emitted as its own line');
  assert.ok(/- \[set\] #\d+ Branch A — done: a \(\+2\)/.test(block), `collapsed row not in CONTRACT format:\n${block}`);
  assert.ok(/#\d+ Branch B — done: b$/m.test(block), 'focused branch must not be collapsed');
  assert.ok(block.includes('B child'), "the focused node's children must be shown");
  assert.ok(!block.includes('A grandchild'), 'an unfocused branch must stay collapsed');
});

await check('R7b', 'angle brackets in a title cannot break the pseudo-XML attrs', async () => {
  const g = (await post('/goals', { title: 'Escaping', done_means: 'escaped' })).json.goal;
  const n = (await post(`/goals/${g.id}/nodes`, { title: 'fix <script> tag', done_means: 'x' })).json.node;
  await req('PUT', `/goals/${g.id}/focus`, { node_id: n.id });
  const block: string = goalsModule.buildGoalThreadContext(`cockpit:goal-${g.id}`);
  const focusLine = block.split('\n')[0];
  assert.ok(!/<script>/.test(focusLine), `REGRESSION: raw angle brackets leaked into the focus attrs:\n${focusLine}`);
  assert.ok(focusLine.includes('&lt;script&gt;'));
});

console.log('\n[R8] the `goals` tool can morph its own ghost, and still cannot write a real node');
await check('R8a', 'edit_ghost rewords a ghost in place (keeps id + batch)', async () => {
  const g = (await post('/goals', { title: 'Tool goal', done_means: 'tool works' })).json.goal;
  const ext = `cockpit:goal-${g.id}`;
  const proposed: any = await toolsModule.goals.execute(
    { operation: 'propose', items: [{ title: 'Draft', done_means: 'd' }] }, { externalId: ext } as any);
  const nodeId = proposed.nodes[0].id;
  const edited: any = await toolsModule.goals.execute(
    { operation: 'edit_ghost', node_id: nodeId, title: 'Draft, reworded' }, { externalId: ext } as any);
  assert.equal(edited.node?.id, nodeId, `edit_ghost failed: ${JSON.stringify(edited)}`);
  assert.equal(edited.node.title, 'Draft, reworded');
  assert.equal(edited.node.state, 'ghost');
  assert.equal(edited.node.authored_by, 'jarvis');
});

await check('R8b', 'edit_ghost on a SET node is refused (403 jarvis_must_propose) — JARVIS still cannot write real content', async () => {
  const g = (await post('/goals', { title: 'Tool goal 2', done_means: 'tool works' })).json.goal;
  const ext = `cockpit:goal-${g.id}`;
  const real = (await post(`/goals/${g.id}/nodes`, { title: 'Kevin node', done_means: 'k' })).json.node;
  const res: any = await toolsModule.goals.execute(
    { operation: 'edit_ghost', node_id: real.id, title: 'sneaky rewrite' }, { externalId: ext } as any);
  assert.equal(res.code, 'jarvis_must_propose', `expected refusal, got ${JSON.stringify(res)}`);
  assert.equal(goalsModule.getRawGoalNode(real.id).title, 'Kevin node');
});

console.log(`\n[goals-review-checks] ${pass}/${pass + failures.length} checks passed ${failures.length ? '❌' : '✅'}`);
for (const f of failures) console.log(`  - ${f}`);
server.close();
process.exit(failures.length ? 1 : 0);
