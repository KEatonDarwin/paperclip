#!/usr/bin/env node
// SMART UNBLOCKER SIMULATION
//
// Permanent scratch-DB regression script:
//   npm run build
//   npm run unblocker:sim
//
// This drives the real compiled Hopper engine against temp SQLite and temp
// usage-meter files. It never opens the live jarvis.db and makes no model calls.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unblocker-sim-'));
const claudeUsageFile = path.join(scratchRoot, 'claude-usage.json');
const codexUsageFile = path.join(scratchRoot, 'codex-usage.json');
const auggieUsageFile = path.join(scratchRoot, 'auggie-usage.json');

process.env.HOPPER_GOV_ENABLED = '1';
process.env.HOPPER_ENGINE_SLOTS = '20';
process.env.HOPPER_GOV_IDLE_MIN = '0';
process.env.HOPPER_GOV_STALE_MIN = '10';
process.env.CLAUDE_USAGE_FILE = claudeUsageFile;
process.env.CODEX_USAGE_FILE = codexUsageFile;
process.env.AUGGIE_USAGE_FILE = auggieUsageFile;
process.env.HOPPER_WORKER_ADAPTER = 'claude';
process.env.HOPPER_WORKER_MODEL = 'claude-sonnet-5';

console.log(`[unblocker-sim] scratch DB: ${DB_PATH}`);
console.log(`[unblocker-sim] scratch root: ${scratchRoot}`);

const distDir = path.join(repoRoot, 'dist');
const convDb = await import(path.join(distDir, 'conversation-db.js'));
const hopperEngine = await import(path.join(distDir, 'hopper-engine.js'));
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
  writeJson(codexUsageFile, { windows: [{ label: '7-day', used_percentage: codex }] });
  writeJson(auggieUsageFile, { windows: [{ label: 'Credits', used_percentage: auggie }] });
}

function setSettings(overrides = {}) {
  const settings = {
    gov_weekly_ceiling: '30',
    gov_weekly_mode: 'hard',
    gov_5h_ceiling: '90',
    gov_auggie_ceiling: '85',
    gov_codex_ceiling: '90',
    unblocker_enabled: 'on',
    unblocker_max_5h: '60',
    unblocker_model: 'claude-opus-5',
    ...overrides,
  };
  for (const [key, value] of Object.entries(settings)) convDb.setSetting(key, String(value));
}

function resetHopperState() {
  sqliteDb.exec(`
    DELETE FROM spawn_tasks;
    DELETE FROM hopper_unblock_passes;
    DELETE FROM hopper_nodes;
    DELETE FROM hopper_trees;
    DELETE FROM turns;
    DELETE FROM conversations;
    DELETE FROM notifications;
    DELETE FROM settings;
  `);
  setUsage();
  setSettings();
  unblockerDispatches.length = 0;
  ordinaryDispatches.length = 0;
}

async function flushDispatch(reason) {
  await hopperEngine.dispatchTick(reason);
  await new Promise((resolve) => setImmediate(resolve));
}

const unblockerDispatches = [];
const ordinaryDispatches = [];
async function fakeProcessMessage(prompt, conversationId) {
  const record = { conversationId, prompt };
  if (conversationId.startsWith('cockpit:unblocker-')) unblockerDispatches.push(record);
  else ordinaryDispatches.push(record);
  return 'UNBLOCKER_SIM_NOOP';
}

hopperEngine.startHopperEngine(fakeProcessMessage);

function nodeByTitle(treeId, title) {
  const node = hopperEngine.listTreeNodes(treeId).find((n) => n.title === title);
  assert.ok(node, `missing node '${title}' in ${treeId}`);
  return node;
}

async function createRunningNode(topic, title = 'blocked probe') {
  const created = hopperEngine.createHopperTree(topic, 'cockpit:unblocker-sim', [
    { title, spec: `Simulated node for ${topic}`, adapter: 'claude', model: 'claude-sonnet-5' },
  ]);
  hopperEngine.agreeHopperTree(created.tree.id);
  await flushDispatch(`sim:${topic}`);
  const node = nodeByTitle(created.tree.id, title);
  assert.equal(node.status, 'running', `setup failed for ${topic}: node did not dispatch`);
  return { treeId: created.tree.id, node };
}

function unblockPasses() {
  return sqliteDb.prepare(`SELECT * FROM hopper_unblock_passes ORDER BY id`).all();
}

function unblockerNotifications() {
  return sqliteDb.prepare(`SELECT * FROM notifications WHERE source = 'hopper-unblocker' ORDER BY id`).all();
}

// ---------------------------------------------------------------------------
// 1) blocked node + juice -> exactly one Smart Unblocker spawn.
// ---------------------------------------------------------------------------
resetHopperState();
{
  const { treeId, node } = await createRunningNode('unblocker: open juice');
  hopperEngine.finishHopperNode(node.id, 'blocked', { result: 'simulated red block: missing toolchain' });
  await new Promise((resolve) => setImmediate(resolve));
  const passes = unblockPasses();
  const pass = passes[0];
  const conv = convDb.getConversation(pass?.worker_ext ?? '');
  const spawn = sqliteDb.prepare(`SELECT * FROM spawn_tasks WHERE thread_ext = ?`).get(pass?.worker_ext);
  check('1', 'blocked node with open juice spawns exactly one tracked unblocker worker', () => {
    assert.equal(passes.length, 1);
    assert.match(pass.worker_ext, new RegExp(`^cockpit:unblocker-${node.id}-[a-f0-9]{8}$`));
    assert.equal(pass.adapter, 'claude');
    assert.equal(pass.model, 'claude-opus-5');
    assert.equal(spawn.hopper_tree_id, treeId);
    assert.equal(spawn.hopper_node_id, node.id);
    assert.equal(spawn.model, 'claude-opus-5');
    assert.equal(conv.thread_adapter, 'claude');
    assert.equal(conv.thread_model, 'claude-opus-5');
    assert.equal(unblockerDispatches.length, 1);
    assert.ok(unblockerDispatches[0].prompt.includes(`Hopper node ${node.id} in tree ${treeId}`));
    assert.ok(!unblockerDispatches[0].prompt.includes('<node_id>'));
  });
}

// ---------------------------------------------------------------------------
// 2) second block on same node -> no second spawn, needs-Kevin bell path.
// ---------------------------------------------------------------------------
{
  const pass = unblockPasses()[0];
  const node = hopperEngine.getHopperNode(pass.node_id);
  sqliteDb.prepare(`
    UPDATE hopper_nodes
    SET status = 'running', result = NULL, worker_thread_ext = 'cockpit:hopper-node-second-pass'
    WHERE id = ?
  `).run(node.id);
  hopperEngine.finishHopperNode(node.id, 'blocked', { result: 'simulated red block remained after fix chain' });
  await new Promise((resolve) => setImmediate(resolve));
  const passes = unblockPasses();
  const notes = unblockerNotifications();
  check('2', 'second red block on same node does not spawn again and creates needs-Kevin fallback bell', () => {
    assert.equal(passes.length, 1);
    assert.equal(passes[0].status, 'needs_kevin');
    assert.equal(unblockerDispatches.length, 1, 'should still have only the first unblocker spawn');
    assert.equal(notes.length, 1);
    assert.match(notes[0].title, /Hopper node still needs Kevin/);
  });
}

// ---------------------------------------------------------------------------
// 3) juice gate closed -> no Smart Unblocker spawn and no unblocker bell.
// ---------------------------------------------------------------------------
resetHopperState();
setUsage({ claude5h: 60, weekly: 0 });
setSettings({ unblocker_max_5h: '60' });
{
  const { node } = await createRunningNode('unblocker: exact threshold hold');
  hopperEngine.finishHopperNode(node.id, 'blocked', { result: 'simulated red block at exact threshold' });
  await new Promise((resolve) => setImmediate(resolve));
  check('3', 'claude 5h exactly equal to unblocker_max_5h holds without spawning (finding 5: parks a waiting_for_juice marker for the sweep, never spawns)', () => {
    const passes = unblockPasses();
    assert.equal(passes.length, 1);
    assert.equal(passes[0].status, 'waiting_for_juice');
    assert.equal(passes[0].worker_ext, null);
    assert.equal(unblockerDispatches.length, 0);
    assert.equal(unblockerNotifications().length, 0);
  });
}

// ---------------------------------------------------------------------------
// 4) bad unblocker_model setting -> fallback to claude-opus-5.
// ---------------------------------------------------------------------------
resetHopperState();
setSettings({ unblocker_model: 'gpt-6-astra' });
{
  const { node } = await createRunningNode('unblocker: bad model fallback');
  hopperEngine.finishHopperNode(node.id, 'blocked', { result: 'simulated red block with bad model setting' });
  await new Promise((resolve) => setImmediate(resolve));
  const pass = unblockPasses()[0];
  const conv = convDb.getConversation(pass.worker_ext);
  check('4', 'invalid unblocker_model falls back to claude-opus-5', () => {
    assert.equal(pass.adapter, 'claude');
    assert.equal(pass.model, 'claude-opus-5');
    assert.equal(conv.thread_model, 'claude-opus-5');
    assert.equal(unblockerDispatches.length, 1);
  });
}

// ---------------------------------------------------------------------------
// 5) blocked_question remains Kevin-facing and never spawns an unblocker.
// ---------------------------------------------------------------------------
resetHopperState();
{
  const { node } = await createRunningNode('unblocker: blocked question skip');
  hopperEngine.finishHopperNode(node.id, 'blocked_question', { question: 'Which product behavior should win?' });
  await new Promise((resolve) => setImmediate(resolve));
  check('5', 'blocked_question does not trigger Smart Unblocker', () => {
    assert.equal(unblockPasses().length, 0);
    assert.equal(unblockerDispatches.length, 0);
  });
}

// ---------------------------------------------------------------------------
// 6) remediation helper inserts flat FIX nodes and re-pends the original.
// ---------------------------------------------------------------------------
resetHopperState();
setSettings({ unblocker_enabled: 'off' });
{
  const { node } = await createRunningNode('unblocker: remediation helper');
  hopperEngine.finishHopperNode(node.id, 'blocked', { result: 'prior red-block result to preserve' });
  const remediated = hopperEngine.appendHopperRemediationNodes(node.id, [
    {
      title: 'install missing local package',
      spec: 'Install the missing local-only package and prove the command runs.',
      adapter: 'claude',
      model: 'claude-sonnet-5',
    },
  ]);
  check('6', 'appendHopperRemediationNodes plants flat FIX leaf and re-pends original behind it', () => {
    assert.ok(remediated, 'remediation helper returned null');
    assert.equal(remediated.fix_nodes.length, 1);
    const fix = remediated.fix_nodes[0];
    assert.equal(fix.parent_id, null);
    assert.match(fix.title, /^FIX:/);
    assert.equal(fix.status, 'pending');
    assert.equal(remediated.blocked_node.status, 'pending');
    assert.equal(remediated.blocked_node.attempts, 0);
    assert.equal(remediated.blocked_node.result, null);
    assert.deepEqual(JSON.parse(remediated.blocked_node.depends_on), [fix.id]);
    assert.match(remediated.blocked_node.spec, /Prior blocked result/);
    assert.match(remediated.blocked_node.spec, /prior red-block result to preserve/);
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
console.log(`[unblocker-sim] ${results.length - failed.length}/${results.length} checks passed`);

try {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
} catch {
  // Best effort; DB remains for post-failure inspection.
}

if (failed.length) process.exit(1);
