#!/usr/bin/env node
// GOVERNOR v2 / HOPPER HARDENING SIMULATION
//
// Permanent scratch-DB regression script:
//   npm run build
//   npm run governor-v2:sim
//
// This drives the real compiled hopper governor/engine code against a temp DB
// and temp usage-meter files. It never opens the live jarvis.db.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

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
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'governor-v2-sim-'));
const claudeUsageFile = path.join(scratchRoot, 'claude-usage.json');
const codexUsageFile = path.join(scratchRoot, 'codex-usage.json');
const auggieUsageFile = path.join(scratchRoot, 'auggie-usage.json');
const fakeCockpitEnv = path.join(scratchRoot, 'cockpit.env');
fs.writeFileSync(fakeCockpitEnv, 'JARVIS_COCKPIT_KEY=governor-v2-sim\n');

process.env.HOPPER_GOV_ENABLED = '1';
process.env.HOPPER_ENGINE_SLOTS = '20';
process.env.HOPPER_GOV_IDLE_MIN = '15';
process.env.HOPPER_GOV_STALE_MIN = '10';
process.env.CLAUDE_USAGE_FILE = claudeUsageFile;
process.env.CODEX_USAGE_FILE = codexUsageFile;
process.env.AUGGIE_USAGE_FILE = auggieUsageFile;
process.env.HOPPER_WORKER_MODEL = 'claude-sonnet-5';
process.env.HOPPER_WORKER_ADAPTER = 'claude';

console.log(`[governor-v2-sim] scratch DB: ${DB_PATH}`);
console.log(`[governor-v2-sim] scratch root: ${scratchRoot}`);

const distDir = path.join(repoRoot, 'dist');
const convDb = await import(path.join(distDir, 'conversation-db.js'));
const hopperEngine = await import(path.join(distDir, 'hopper-engine.js'));
const governor = await import(path.join(distDir, 'hopper-governor.js'));
await import(path.join(distDir, 'notifications.js'));

const { sqliteDb } = convDb;

const results = [];
function check(id, description, fn) {
  try {
    fn();
    results.push({ id, description, pass: true });
  } catch (err) {
    results.push({ id, description, pass: false, error: err instanceof Error ? err.message : String(err) });
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function setUsage({ claude5h = 10, weekly = 0, codex = 5, auggie = 5 } = {}) {
  writeJson(claudeUsageFile, {
    five_hour: { utilization: claude5h },
    seven_day: { utilization: weekly },
  });
  writeJson(codexUsageFile, {
    windows: [{ label: '7-day', used_percentage: codex }],
  });
  writeJson(auggieUsageFile, {
    windows: [{ label: 'Credits', used_percentage: auggie }],
  });
}

function setGovernorSettings(overrides = {}) {
  const settings = {
    gov_auggie_ceiling: '85',
    gov_codex_ceiling: '90',
    gov_kevin_active_claude_max_5h: '50',
    gov_weekly_ceiling: '30',
    gov_weekly_mode: 'hard',
    gov_concurrency_cap: '10',
    // Cross-pool diversion is default-ON in production, but the legacy gating
    // checks below assert pure own-pool governor behavior (a blocked node stays
    // pending). Keep it OFF by default here so those tests verify the
    // byte-identical no-diversion path; the dedicated diversion block (10)
    // turns it on explicitly.
    gov_diversion_enabled: 'false',
    ...overrides,
  };
  for (const [key, value] of Object.entries(settings)) convDb.setSetting(key, String(value));
}

function resetHopperState() {
  sqliteDb.exec(`
    DELETE FROM spawn_tasks;
    DELETE FROM hopper_nodes;
    DELETE FROM hopper_trees;
    DELETE FROM turns;
    DELETE FROM conversations;
  `);
}

function setKevinActive(active) {
  sqliteDb.prepare(`
    DELETE FROM turns
    WHERE conversation_id IN (SELECT id FROM conversations WHERE external_id = 'cockpit:governor-v2-kevin-active-sim')
  `).run();
  sqliteDb.prepare(`DELETE FROM conversations WHERE external_id = 'cockpit:governor-v2-kevin-active-sim'`).run();
  if (!active) return;
  const c = convDb.getOrCreateConversation('cockpit:governor-v2-kevin-active-sim');
  convDb.addTurn(c.id, 'user', 'simulated Kevin activity');
}

function nodeByTitle(treeId, title) {
  const node = hopperEngine.listTreeNodes(treeId).find((n) => n.title === title);
  assert.ok(node, `missing node '${title}' in ${treeId}`);
  return node;
}

async function flushDispatch(reason) {
  await hopperEngine.dispatchTick(reason);
  await new Promise((resolve) => setImmediate(resolve));
}

async function createActiveTree(topic, nodes) {
  const created = hopperEngine.createHopperTree(topic, 'cockpit:governor-v2-sim', nodes);
  hopperEngine.agreeHopperTree(created.tree.id);
  await flushDispatch(`sim:${topic}`);
  return created.tree.id;
}

function notificationMarker() {
  return sqliteDb.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM notifications`).get().id;
}

function notificationsSince(marker, where = '1=1') {
  return sqliteDb.prepare(`
    SELECT * FROM notifications
    WHERE id > ? AND ${where}
    ORDER BY id ASC
  `).all(marker);
}

function runProcess(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => resolve({ status: 1, stdout, stderr: `${stderr}${err.stack ?? err.message}\n` }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const dispatched = [];
async function fakeProcessMessage(prompt, conversationId) {
  const m = /node #(\d+)/.exec(prompt);
  dispatched.push({ nodeId: m ? Number(m[1]) : null, conversationId, prompt });
  return 'GOVERNOR_V2_SIM_WORKER_NOOP';
}
hopperEngine.startHopperEngine(fakeProcessMessage);
setUsage();
setGovernorSettings();

// ---------------------------------------------------------------------------
// 1) Auggie ceiling blocks only Auggie; Codex and Claude continue.
// ---------------------------------------------------------------------------
resetHopperState();
setUsage({ claude5h: 10, weekly: 0, codex: 20, auggie: 91 });
setGovernorSettings();
setKevinActive(false);
{
  const treeId = await createActiveTree('governor-v2: provider ceilings', [
    { title: 'auggie held', spec: 'should stay pending', adapter: 'auggie', model: 'opus4.8' },
    { title: 'codex open', spec: 'should dispatch', adapter: 'codex', model: 'gpt-5.5' },
    { title: 'claude open', spec: 'should dispatch', adapter: 'claude', model: 'claude-sonnet-5' },
  ]);
  check('1', 'Auggie claims block above gov_auggie_ceiling while Codex and Claude continue', () => {
    assert.equal(nodeByTitle(treeId, 'auggie held').status, 'pending');
    assert.equal(nodeByTitle(treeId, 'codex open').status, 'running');
    assert.equal(nodeByTitle(treeId, 'claude open').status, 'running');
    assert.equal(governor.governorStatus('auggie').reason, 'provider_ceiling');
    assert.equal(governor.governorStatus('codex').allow, true);
    assert.equal(governor.governorStatus('claude').allow, true);
  });
}

// ---------------------------------------------------------------------------
// 2) Claude can run while Kevin is active below the 5h waiver threshold, and
//    holds while Kevin is active at/above that threshold.
// ---------------------------------------------------------------------------
resetHopperState();
setGovernorSettings();
setKevinActive(true);
setUsage({ claude5h: 20, weekly: 0, codex: 20, auggie: 20 });
{
  const treeId = await createActiveTree('governor-v2: claude active allowed', [
    { title: 'claude active 20', spec: 'should dispatch under active waiver', adapter: 'claude', model: 'claude-sonnet-5' },
  ]);
  check('2a', 'Claude dispatches while Kevin is active when 5h=20 < threshold 50', () => {
    assert.equal(nodeByTitle(treeId, 'claude active 20').status, 'running');
    assert.equal(governor.governorStatus('claude').allow, true);
  });
}

resetHopperState();
setGovernorSettings();
setKevinActive(true);
setUsage({ claude5h: 60, weekly: 0, codex: 20, auggie: 20 });
{
  const treeId = await createActiveTree('governor-v2: claude active held', [
    { title: 'claude active 60', spec: 'should hold above active waiver threshold', adapter: 'claude', model: 'claude-sonnet-5' },
  ]);
  check('2b', 'Claude holds while Kevin is active when 5h=60 >= threshold 50', () => {
    const n = nodeByTitle(treeId, 'claude active 60');
    assert.equal(n.status, 'pending');
    assert.equal(governor.governorStatus('claude').reason, 'kevin_active');
  });
}
setKevinActive(false);

// ---------------------------------------------------------------------------
// 3) Weekly ceiling: soft mode notifies and continues; hard mode holds.
// ---------------------------------------------------------------------------
resetHopperState();
setKevinActive(false);
setUsage({ claude5h: 10, weekly: 30, codex: 20, auggie: 20 });
{
  setGovernorSettings({ gov_weekly_mode: 'soft' });
  const marker = notificationMarker();
  const verdict = governor.governorCheck('claude');
  check('3a', 'weekly>=30 in soft mode emits a budget notification and continues', () => {
    assert.equal(verdict.allow, true);
    assert.equal(verdict.reason, 'ok');
    const notes = notificationsSince(marker, `source = 'hopper-engine' AND title LIKE '%weekly budget reached%'`);
    assert.equal(notes.length, 1, `expected one weekly soft notification, got ${notes.length}`);
  });

  setGovernorSettings({ gov_weekly_mode: 'hard' });
  const treeId = await createActiveTree('governor-v2: weekly hard hold', [
    { title: 'claude weekly hard', spec: 'should hold on weekly hard ceiling', adapter: 'claude', model: 'claude-sonnet-5' },
  ]);
  check('3b', 'weekly>=30 in hard mode holds Claude dispatch', () => {
    assert.equal(nodeByTitle(treeId, 'claude weekly hard').status, 'pending');
    assert.equal(governor.governorStatus('claude').reason, 'weekly_ceiling');
  });
}

// ---------------------------------------------------------------------------
// 4) Cross-provider retry ladder skips a held candidate pool.
// ---------------------------------------------------------------------------
resetHopperState();
setKevinActive(false);
setGovernorSettings({ gov_weekly_mode: 'hard' });
setUsage({ claude5h: 10, weekly: 0, codex: 20, auggie: 91 });
{
  const treeId = await createActiveTree('governor-v2: retry ladder', [
    { title: 'codex retry', spec: 'expire once; should skip held Auggie and reroute to Claude', adapter: 'codex', model: 'gpt-5.5' },
  ]);
  const first = nodeByTitle(treeId, 'codex retry');
  assert.equal(first.status, 'running', 'retry scenario setup failed: codex node did not dispatch');
  const firstThread = first.worker_thread_ext;
  sqliteDb.prepare(`UPDATE hopper_nodes SET lease_expires_at = datetime('now', '-1 minute') WHERE id = ?`).run(first.id);
  await flushDispatch('sim:retry-expiry');
  const retried = hopperEngine.getHopperNode(first.id);
  const oldSpawn = sqliteDb.prepare(`SELECT * FROM spawn_tasks WHERE thread_ext = ?`).get(firstThread);
  check('4', 'cross-provider retry ladder picks Claude when Auggie is held', () => {
    assert.equal(retried.status, 'running');
    assert.equal(retried.attempts, 2);
    assert.equal(retried.adapter, 'claude');
    assert.equal(retried.model, 'claude-sonnet-5');
    assert.equal(oldSpawn.status, 'failed');
    assert.match(oldSpawn.error, /HOPPER_RETRY_REROUTE/);
    assert.match(oldSpawn.error, /codex\/gpt-5\.5 -> claude\/claude-sonnet-5/);
  });
}

// ---------------------------------------------------------------------------
// 5) Initial DAG planting uses depends_on only; sanitizer nulls poisoned
//    parent_id values before agreement.
// ---------------------------------------------------------------------------
resetHopperState();
setUsage({ claude5h: 10, weekly: 0, codex: 20, auggie: 20 });
setGovernorSettings();
{
  const { tree, nodes } = hopperEngine.createHopperTree('governor-v2: planter parent ids', 'cockpit:governor-v2-sim', [
    { title: 'A', spec: 'first' },
    { title: 'B', spec: 'second', parent_index: 0, depends_on_indexes: [0] },
    { title: 'C', spec: 'third', parent_index: 1, depends_on_indexes: [1] },
  ]);
  check('5a', 'chain-tree planting produces zero parent_ids while preserving depends_on DAG links', () => {
    assert.ok(nodes.every((n) => n.parent_id == null), `expected all parent_id null, got ${JSON.stringify(nodes.map((n) => n.parent_id))}`);
    const bDeps = JSON.parse(nodeByTitle(tree.id, 'B').depends_on);
    const cDeps = JSON.parse(nodeByTitle(tree.id, 'C').depends_on);
    assert.deepEqual(bDeps, [nodeByTitle(tree.id, 'A').id]);
    assert.deepEqual(cDeps, [nodeByTitle(tree.id, 'B').id]);
  });
  sqliteDb.prepare(`UPDATE hopper_nodes SET parent_id = ? WHERE id = ?`).run(nodeByTitle(tree.id, 'A').id, nodeByTitle(tree.id, 'B').id);
  hopperEngine.agreeHopperTree(tree.id);
  await new Promise((resolve) => setImmediate(resolve));
  check('5b', 'agreeHopperTree sanitizer nulls a poisoned initial parent_id', () => {
    const after = hopperEngine.listTreeNodes(tree.id);
    assert.ok(after.every((n) => n.parent_id == null), `expected sanitized parent_id nulls, got ${JSON.stringify(after.map((n) => n.parent_id))}`);
    assert.deepEqual(JSON.parse(nodeByTitle(tree.id, 'B').depends_on), [nodeByTitle(tree.id, 'A').id]);
  });
}

// ---------------------------------------------------------------------------

// Fake cockpit API for reconciler runs: thread descriptors from a Map, finish
// POSTs routed into the REAL finishHopperNode so the engine's guards apply.
async function startFakeCockpit(descriptors) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(`${JSON.stringify(body)}\n`);
    };
    if (req.method === 'GET' && url.pathname.startsWith('/api/v1/threads/')) {
      const ext = decodeURIComponent(url.pathname.slice('/api/v1/threads/'.length));
      send(200, descriptors.get(ext) ?? { running: false, turn_count: 0, updated_at: new Date().toISOString() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/notifications') {
      req.resume();
      send(200, { ok: true });
      return;
    }
    const finishMatch = /^\/api\/v1\/hopper-nodes\/(\d+)\/finish$/.exec(url.pathname);
    if (req.method === 'POST' && finishMatch) {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(raw || '{}');
          const node = hopperEngine.finishHopperNode(Number(finishMatch[1]), payload.outcome, payload);
          send(200, { node });
        } catch (err) {
          send(500, { error: err instanceof Error ? err.message : String(err) });
        }
      });
      return;
    }
    send(404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return { server, port };
}

// 6) Existing reconciler recovers a running node from committed-work evidence.
// ---------------------------------------------------------------------------
resetHopperState();
setKevinActive(false);
setUsage({ claude5h: 10, weekly: 0, codex: 20, auggie: 20 });
setGovernorSettings();
{
  const workRepo = path.join(repoRoot, '.governor-v2-sim-recovery-repo');
  fs.rmSync(workRepo, { recursive: true, force: true });
  fs.mkdirSync(workRepo, { recursive: true });
  execFileSync('git', ['init', '-b', 'hopper/sim-recovery'], { cwd: workRepo, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'governor-v2-sim@example.test'], { cwd: workRepo });
  execFileSync('git', ['config', 'user.name', 'Governor V2 Sim'], { cwd: workRepo });

  const treeId = await createActiveTree('governor-v2: finish recovery', [
    {
      title: 'finish recovery node',
      spec: `Worktree: ${workRepo}\nBranch: hopper/sim-recovery\nMake a small commit, then finish.`,
      adapter: 'claude',
      model: 'claude-sonnet-5',
    },
  ]);
  const running = nodeByTitle(treeId, 'finish recovery node');
  assert.equal(running.status, 'running', 'finish recovery setup failed: node did not dispatch');

  fs.writeFileSync(path.join(workRepo, 'proof.txt'), 'committed work for finish recovery\n');
  execFileSync('git', ['add', 'proof.txt'], { cwd: workRepo });
  execFileSync('git', ['commit', '-m', 'sim: committed worker output'], { cwd: workRepo, stdio: 'pipe' });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workRepo, encoding: 'utf8' }).trim();
  sqliteDb.prepare(`UPDATE hopper_nodes SET lease_expires_at = datetime('now', '+1 minute') WHERE id = ?`).run(running.id);

  const descriptors = new Map();
  descriptors.set(running.worker_thread_ext, {
    running: false,
    turn_count: 1,
    updated_at: new Date().toISOString(),
    latest_summary: `Worker committed ${sha} on branch hopper/sim-recovery in ${workRepo} but the final finish POST failed.`,
  });

  const { server, port } = await startFakeCockpit(descriptors);
  const reconciler = await runProcess('python3', ['scripts/jarvis-spawn-reconcile.py'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      JARVIS_DB_PATH: DB_PATH,
      JARVIS_COCKPIT_ENV: fakeCockpitEnv,
      JARVIS_COCKPIT_API_BASE: `http://127.0.0.1:${port}/api/v1`,
      PYTHONUNBUFFERED: '1',
    },
    encoding: 'utf8',
  });
  await new Promise((resolve) => server.close(resolve));
  const recovered = hopperEngine.getHopperNode(running.id);
  const spawn = sqliteDb.prepare(`SELECT * FROM spawn_tasks WHERE hopper_node_id = ?`).get(running.id);
  check('6', "finish-POST recovery completes a running node whose idle worker committed work", () => {
    const debug = `\nSTDOUT:\n${reconciler.stdout}\nSTDERR:\n${reconciler.stderr}\nnode=${JSON.stringify(recovered, null, 2)}\nspawn=${JSON.stringify(spawn, null, 2)}`;
    assert.equal(reconciler.status, 0, `reconciler failed${debug}`);
    assert.equal(recovered.status, 'done', debug);
    assert.match(recovered.result, /\[recovered from spawn ledger\]/);
    assert.match(recovered.result, new RegExp(sha.slice(0, 12)));
    assert.equal(spawn.status, 'done');
    assert.match(reconciler.stdout, /recovered node .* from commit evidence/);
  });
  fs.rmSync(workRepo, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 7) Stale-attempt guard: a ledger row from an EXPIRED attempt must never finish
//    a node that has since been re-leased to a new worker thread — even when
//    the old worker's text carries a perfectly well-formed finish JSON.
// ---------------------------------------------------------------------------
resetHopperState();
setKevinActive(false);
setUsage({ claude5h: 10, weekly: 0, codex: 20, auggie: 20 });
setGovernorSettings();
{
  const treeId = await createActiveTree('governor-v2: stale attempt guard', [
    { title: 'stale attempt node', spec: 'Do the thing, then finish.', adapter: 'claude', model: 'claude-sonnet-5' },
  ]);
  const first = nodeByTitle(treeId, 'stale attempt node');
  assert.equal(first.status, 'running', 'stale-attempt setup failed: node did not dispatch');
  const oldExt = first.worker_thread_ext;
  // Expire the lease and tick: the engine reroutes + re-claims under a NEW ext.
  sqliteDb.prepare(`UPDATE hopper_nodes SET lease_expires_at = datetime('now', '-1 minute') WHERE id = ?`).run(first.id);
  await flushDispatch('sim_stale_attempt');
  const released = hopperEngine.getHopperNode(first.id);
  assert.notEqual(released.worker_thread_ext, oldExt, 'stale-attempt setup failed: node was not re-leased');
  // Keep the OLD attempt's ledger row 'running' (as it would be if that worker died quietly).
  sqliteDb.prepare(`UPDATE spawn_tasks SET status = 'running' WHERE thread_ext = ?`).run(oldExt);

  const descriptors = new Map();
  descriptors.set(oldExt, {
    running: false,
    turn_count: 1,
    updated_at: new Date().toISOString(),
    latest_summary: 'Finished. Payload: {"outcome":"done","result":"stale attempt claims victory"}',
  });
  descriptors.set(released.worker_thread_ext, { running: true, turn_count: 1, updated_at: new Date().toISOString() });
  const { server, port } = await startFakeCockpit(descriptors);
  const reconciler = await runProcess('python3', ['scripts/jarvis-spawn-reconcile.py'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      JARVIS_DB_PATH: DB_PATH,
      JARVIS_COCKPIT_ENV: fakeCockpitEnv,
      JARVIS_COCKPIT_API_BASE: `http://127.0.0.1:${port}/api/v1`,
      PYTHONUNBUFFERED: '1',
    },
    encoding: 'utf8',
  });
  await new Promise((resolve) => server.close(resolve));
  const after = hopperEngine.getHopperNode(first.id);
  const oldSpawn = sqliteDb.prepare(`SELECT * FROM spawn_tasks WHERE thread_ext = ?`).get(oldExt);
  check('7', 'stale-attempt ledger row cannot finish a re-leased node (attempt pin)', () => {
    const debug = `\nSTDOUT:\n${reconciler.stdout}\nSTDERR:\n${reconciler.stderr}\nnode=${JSON.stringify(after, null, 2)}`;
    assert.equal(reconciler.status, 0, `reconciler failed${debug}`);
    assert.equal(after.status, 'running', `node must still be running under the live attempt${debug}`);
    assert.equal(after.worker_thread_ext, released.worker_thread_ext, debug);
    assert.doesNotMatch(after.result ?? '', /stale attempt claims victory/);
    assert.match(reconciler.stdout, /stale attempt .* no recovery/);
    assert.equal(oldSpawn.status, 'done', 'old ledger row should still be reconciled to done');
  });
}

// ---------------------------------------------------------------------------
// 10) Cross-pool diversion (tree-6ecf478c): a ceiling-blocked ready node whose
//     own pool is denied for a CEILING reason diverts to an alternate pool that
//     clears the raised diversion band, restamping its loadout. Non-ceiling
//     denials, override_off targets, and the master-off switch are respected.
// ---------------------------------------------------------------------------
function spawnLabelForNode(nodeId) {
  return sqliteDb.prepare(`SELECT label FROM spawn_tasks WHERE hopper_node_id = ? ORDER BY rowid DESC LIMIT 1`).get(nodeId)?.label ?? '';
}

// 10a — provider_ceiling source diverts to the first clear pool (claude), and
//       the node's stored loadout is restamped to the tier-equivalent there
//       (auggie opus4.8 = frontier → claude-opus-5), with a [DIVERTED …] label.
resetHopperState();
setKevinActive(false);
setUsage({ claude5h: 10, weekly: 0, codex: 20, auggie: 91 });
setGovernorSettings({ gov_diversion_enabled: 'true', gov_diversion_ceiling_5h: '85', gov_diversion_pool_order: 'claude,codex,auggie' });
{
  const treeId = await createActiveTree('gov-diversion: provider_ceiling → claude', [
    { title: 'auggie stuck', spec: 'diverts to claude', adapter: 'auggie', model: 'opus4.8' },
  ]);
  check('10a', 'Auggie node over ceiling diverts to Claude (frontier→opus-5), loadout restamped + labeled', () => {
    const n = nodeByTitle(treeId, 'auggie stuck');
    assert.equal(n.status, 'running', 'diverted node should be running');
    assert.equal(n.adapter, 'claude', 'adapter restamped to claude');
    assert.equal(n.model, 'claude-opus-5', 'opus4.8 (frontier) maps to claude-opus-5');
    assert.match(spawnLabelForNode(n.id), /^\[DIVERTED /, 'spawn label records the diversion');
    // governor itself is unchanged: auggie is still genuinely over its ceiling.
    assert.equal(governor.governorStatus('auggie').reason, 'provider_ceiling');
  });
}

// 10b — raised band: a codex node (over its ceiling) diverts onto Claude even
//       though Claude is normally kevin_active-blocked — the diversion ceiling
//       floor raises the waiver threshold (50→85) so 5h=60 clears as a target.
resetHopperState();
setKevinActive(true);
setUsage({ claude5h: 60, weekly: 0, codex: 95, auggie: 20 });
setGovernorSettings({ gov_diversion_enabled: 'true', gov_diversion_ceiling_5h: '85', gov_diversion_pool_order: 'claude,codex,auggie' });
{
  const treeId = await createActiveTree('gov-diversion: raised band vs kevin_active', [
    { title: 'codex stuck', spec: 'diverts to claude under raised band', adapter: 'codex', model: 'gpt-5.5' },
  ]);
  check('10b', 'Codex node diverts to Claude under the raised band even while Kevin is active', () => {
    const n = nodeByTitle(treeId, 'codex stuck');
    assert.equal(n.status, 'running', 'diverted node should be running');
    assert.equal(n.adapter, 'claude');
    assert.equal(n.model, 'claude-sonnet-5', 'gpt-5.5 (standard) maps to claude-sonnet-5');
    // Normal governor would hold claude (kevin_active), but the diversion probe clears it at the band.
    assert.equal(governor.governorStatus('claude').reason, 'kevin_active');
    assert.equal(governor.governorCheckDiversionTarget('claude', 85).allow, true);
    assert.equal(governor.governorCheckDiversionTarget('claude', 85).reason, 'ok');
  });
}
setKevinActive(false);

// 10c — a WEEKLY-ceiling denial is not divertible (hard budget), so the node
//       holds even with an alternate pool wide open.
resetHopperState();
setKevinActive(false);
setUsage({ claude5h: 10, weekly: 35, codex: 20, auggie: 20 });
setGovernorSettings({ gov_diversion_enabled: 'true', gov_weekly_mode: 'hard', gov_diversion_pool_order: 'claude,codex,auggie' });
{
  const treeId = await createActiveTree('gov-diversion: weekly not divertible', [
    { title: 'claude weekly', spec: 'must hold', adapter: 'claude', model: 'claude-sonnet-5' },
  ]);
  check('10c', 'A weekly_ceiling denial is NOT divertible — node holds even with clear pools', () => {
    assert.equal(nodeByTitle(treeId, 'claude weekly').status, 'pending');
    assert.equal(governor.governorStatus('claude').reason, 'weekly_ceiling');
  });
}

// 10d — an override_off pool is never a diversion target (explicit human hold).
resetHopperState();
setKevinActive(false);
setUsage({ claude5h: 10, weekly: 0, codex: 20, auggie: 91 });
setGovernorSettings({ gov_diversion_enabled: 'true', gov_diversion_pool_order: 'claude', gov_override_claude: 'off' });
{
  const treeId = await createActiveTree('gov-diversion: override_off target excluded', [
    { title: 'auggie no target', spec: 'no eligible target', adapter: 'auggie', model: 'opus4.8' },
  ]);
  check('10d', 'override_off pool is refused as a diversion target — node holds', () => {
    assert.equal(nodeByTitle(treeId, 'auggie no target').status, 'pending');
    assert.equal(governor.governorCheckDiversionTarget('claude', 85).reason, 'override_off');
  });
  convDb.setSetting('gov_override_claude', 'auto');
}

// 10e — master switch off ⇒ byte-identical no-diversion behavior (node holds).
resetHopperState();
setKevinActive(false);
setUsage({ claude5h: 10, weekly: 0, codex: 20, auggie: 91 });
setGovernorSettings({ gov_diversion_enabled: 'false', gov_diversion_pool_order: 'claude,codex,auggie' });
{
  const treeId = await createActiveTree('gov-diversion: disabled holds', [
    { title: 'auggie disabled', spec: 'diversion off', adapter: 'auggie', model: 'opus4.8' },
  ]);
  check('10e', 'gov_diversion_enabled=false ⇒ blocked node holds (no diversion)', () => {
    const n = nodeByTitle(treeId, 'auggie disabled');
    assert.equal(n.status, 'pending');
    assert.equal(n.adapter, 'auggie', 'loadout untouched when diversion is off');
  });
}

// ---------------------------------------------------------------------------
// 11) SIM (node #301, tree-6ecf478c): dry-run the acceptance scenarios from the
//     spec verbatim, on top of 10a–10e's coverage of the mechanism itself.
// ---------------------------------------------------------------------------

// 11a — THE ACTUAL CASE: a codex/gpt-5.5 ready node whose own pool (codex) is
//       over its normal ceiling (91% ≥ 90%) diverts to Claude, which has plain
//       headroom (61%, under both its own ceiling and the diversion band) with
//       Kevin NOT active — this is the exact n266-stall shape (codex 91%),
//       reproduced end-to-end without the kevin_active wrinkle from 10b.
resetHopperState();
setKevinActive(false);
setUsage({ claude5h: 61, weekly: 0, codex: 91, auggie: 20 });
setGovernorSettings({ gov_diversion_enabled: 'true', gov_diversion_ceiling_5h: '85', gov_diversion_pool_order: 'claude,codex,auggie' });
{
  const treeId = await createActiveTree('gov-diversion: n266 reproduction', [
    { title: 'codex 91pct ready', spec: 'reproduces the real ceiling-blocked stall', adapter: 'codex', model: 'gpt-5.5' },
  ]);
  check('11a', 'THE ACTUAL CASE — codex 91% + claude 61% (no kevin_active) diverts to claude-sonnet-5 and dispatches', () => {
    assert.equal(governor.governorStatus('codex').reason, 'provider_ceiling', 'setup: codex must genuinely be ceiling-blocked');
    const n = nodeByTitle(treeId, 'codex 91pct ready');
    assert.equal(n.status, 'running', 'node should have dispatched via diversion, not sat pending');
    assert.equal(n.adapter, 'claude');
    assert.equal(n.model, 'claude-sonnet-5', 'gpt-5.5 (standard) maps to claude-sonnet-5');
    assert.match(spawnLabelForNode(n.id), /^\[DIVERTED codex\/gpt-5\.5→claude\/claude-sonnet-5: provider_ceiling/);
  });
}

// 11b — all candidate pools over the diversion band ⇒ node holds, no dispatch.
//       Own pool codex is blocked (91% ≥ 90%); BOTH alternates in the pool
//       order (claude 95%, auggie 95%) are also over their own ceiling AND the
//       85% band, so no diversion target clears — the node must stay pending
//       with its original loadout untouched (not silently reassigned).
resetHopperState();
setKevinActive(false);
setUsage({ claude5h: 95, weekly: 0, codex: 91, auggie: 95 });
setGovernorSettings({ gov_diversion_enabled: 'true', gov_diversion_ceiling_5h: '85', gov_diversion_pool_order: 'claude,codex,auggie' });
{
  const treeId = await createActiveTree('gov-diversion: no target clears', [
    { title: 'codex all-maxed', spec: 'no alternate pool clears the band', adapter: 'codex', model: 'gpt-5.5' },
  ]);
  check('11b', 'all candidate pools over the diversion band ⇒ node holds (no dispatch)', () => {
    assert.equal(governor.governorCheckDiversionTarget('claude', 85).allow, false, 'setup: claude must be over the band too');
    assert.equal(governor.governorCheckDiversionTarget('auggie', 85).allow, false, 'setup: auggie must be over the band too');
    const n = nodeByTitle(treeId, 'codex all-maxed');
    assert.equal(n.status, 'pending', 'no eligible target ⇒ node must not dispatch');
    assert.equal(n.adapter, 'codex', 'loadout must stay untouched when no diversion happens');
    assert.equal(n.model, 'gpt-5.5');
  });
}

// 11c — a normal ready node whose OWN pool already has headroom is claimed
//       directly — diversion is enabled but must never fire on a node that was
//       never blocked in the first place (throughput not inflated by routing
//       healthy work through the diversion path).
resetHopperState();
setKevinActive(false);
setUsage({ claude5h: 10, weekly: 0, codex: 20, auggie: 20 });
setGovernorSettings({ gov_diversion_enabled: 'true', gov_diversion_ceiling_5h: '85', gov_diversion_pool_order: 'claude,codex,auggie' });
{
  const treeId = await createActiveTree('gov-diversion: healthy pool no-op', [
    { title: 'codex healthy', spec: 'own pool has headroom, must claim normally', adapter: 'codex', model: 'gpt-5.5' },
  ]);
  check('11c', 'own-pool-has-headroom node dispatches normally with NO diversion (loadout + label untouched)', () => {
    const n = nodeByTitle(treeId, 'codex healthy');
    assert.equal(n.status, 'running');
    assert.equal(n.adapter, 'codex', 'must NOT be diverted when its own pool already allows it');
    assert.equal(n.model, 'gpt-5.5');
    assert.doesNotMatch(spawnLabelForNode(n.id), /^\[DIVERTED/, 'no diversion label on an undiverted claim');
  });
}

// 11d — gov_diversion_enabled=false behaves EXACTLY like today, using the same
//       "actual case" numbers as 11a: with the switch off, the codex-91%/
//       claude-61% node must hold pending (today's pre-diversion behavior),
//       not divert — proving the flag is a true kill-switch, not just a
//       preference that only matters when no target would clear anyway.
resetHopperState();
setKevinActive(false);
setUsage({ claude5h: 61, weekly: 0, codex: 91, auggie: 20 });
setGovernorSettings({ gov_diversion_enabled: 'false', gov_diversion_pool_order: 'claude,codex,auggie' });
{
  const treeId = await createActiveTree('gov-diversion: disabled = today, actual-case numbers', [
    { title: 'codex 91pct disabled', spec: 'same numbers as 11a but the switch is off', adapter: 'codex', model: 'gpt-5.5' },
  ]);
  check('11d', 'gov_diversion_enabled=false ⇒ the actual-case node holds exactly like pre-diversion today, even though a target (claude 61%) would have cleared', () => {
    const n = nodeByTitle(treeId, 'codex 91pct disabled');
    assert.equal(n.status, 'pending');
    assert.equal(n.adapter, 'codex', 'loadout untouched when diversion is off');
    assert.equal(n.model, 'gpt-5.5');
  });
}

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  if (r.pass) {
    console.log(`PASS ${r.id} - ${r.description}`);
  } else {
    console.log(`FAIL ${r.id} - ${r.description}`);
    console.log(`  ${r.error}`);
  }
}
console.log(`[governor-v2-sim] ${results.length - failed.length}/${results.length} checks passed`);

try {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
} catch {
  // Best effort; the DB path itself intentionally remains for post-failure inspection.
}

if (failed.length) process.exit(1);
