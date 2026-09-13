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
