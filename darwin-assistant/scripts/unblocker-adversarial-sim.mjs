#!/usr/bin/env node
// ADVERSARIAL probes for the Smart Unblocker (node #223 review). Scratch DB only.
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const DB_PATH = process.env.JARVIS_DB_PATH;
if (!DB_PATH || DB_PATH.includes('/home/kevin/paperclip/darwin-assistant/jarvis.db')) { console.error('need scratch JARVIS_DB_PATH'); process.exit(1); }
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'unblocker-adv-'));
const claudeUsageFile = path.join(scratch, 'claude.json'), codexUsageFile = path.join(scratch, 'codex.json'), auggieUsageFile = path.join(scratch, 'auggie.json');
Object.assign(process.env, { HOPPER_GOV_ENABLED: '1', HOPPER_ENGINE_SLOTS: '20', HOPPER_GOV_IDLE_MIN: '0', HOPPER_GOV_STALE_MIN: '10',
  CLAUDE_USAGE_FILE: claudeUsageFile, CODEX_USAGE_FILE: codexUsageFile, AUGGIE_USAGE_FILE: auggieUsageFile, HOPPER_WORKER_ADAPTER: 'claude', HOPPER_WORKER_MODEL: 'claude-sonnet-5' });
const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
const convDb = await import(path.join(dist, 'conversation-db.js'));
const eng = await import(path.join(dist, 'hopper-engine.js'));
await import(path.join(dist, 'notifications.js'));
const { sqliteDb } = convDb;
const wj = (f, v) => fs.writeFileSync(f, JSON.stringify(v));
function setUsage({ claude5h = 10, weekly = 0, codex = 5, auggie = 5 } = {}) {
  wj(claudeUsageFile, { five_hour: { utilization: claude5h }, seven_day: { utilization: weekly } });
  wj(codexUsageFile, { windows: [{ label: '7-day', used_percentage: codex }] });
  wj(auggieUsageFile, { windows: [{ label: 'Credits', used_percentage: auggie }] });
}
function setSettings(o = {}) { for (const [k, v] of Object.entries({ gov_weekly_ceiling: '30', gov_weekly_mode: 'hard', gov_5h_ceiling: '90', gov_auggie_ceiling: '85', gov_codex_ceiling: '90', unblocker_enabled: 'on', unblocker_max_5h: '60', unblocker_model: 'claude-opus-5', ...o })) convDb.setSetting(k, String(v)); }
function reset() { sqliteDb.exec(`DELETE FROM spawn_tasks; DELETE FROM hopper_unblock_passes; DELETE FROM hopper_nodes; DELETE FROM hopper_trees; DELETE FROM turns; DELETE FROM conversations; DELETE FROM notifications; DELETE FROM settings;`); setUsage(); setSettings(); spawns.length = 0; }
const spawns = []; let failNextSpawn = false;
async function fakePM(prompt, conversationId) { if (conversationId.startsWith('cockpit:unblocker-')) { if (failNextSpawn) { failNextSpawn = false; throw new Error('adapter busy'); } spawns.push(conversationId); } return 'NOOP'; }
eng.startHopperEngine(fakePM);
const tick = async (r) => { await eng.dispatchTick(r); await new Promise((res) => setImmediate(res)); };
const passes = () => sqliteDb.prepare(`SELECT * FROM hopper_unblock_passes ORDER BY id`).all();
const notes = () => sqliteDb.prepare(`SELECT * FROM notifications WHERE source='hopper-unblocker' ORDER BY id`).all();
const results = [];
const check = (id, d, fn) => { try { fn(); results.push({ id, d, pass: true }); } catch (e) { results.push({ id, d, pass: false, e: e.message }); } };
async function runningTree(topic, titles = ['probe']) {
  const c = eng.createHopperTree(topic, 'cockpit:adv-sim', titles.map((t) => ({ title: t, spec: 'sim', adapter: 'claude', model: 'claude-sonnet-5' })));
  eng.agreeHopperTree(c.tree.id); await tick(topic);
  return { treeId: c.tree.id, nodes: eng.listTreeNodes(c.tree.id) };
}

// R1: recursion — FIX node planted by an unblocker blocks → does a 2nd unblocker spawn? then its FIX blocks → 3rd?
reset();
{
  const { treeId, nodes } = await runningTree('adv: recursion');
  const orig = nodes[0];
  eng.finishHopperNode(orig.id, 'blocked', { result: 'block 1' }); await tick('b1');
  assert.equal(spawns.length, 1);
  let depth = 1; let lastFix = null; let blockedId = orig.id;
  for (let i = 0; i < 5; i++) {
    const r = eng.appendHopperRemediationNodes(blockedId, [{ title: `fix level ${i}`, spec: 'sim', adapter: 'claude', model: 'claude-sonnet-5' }]);
    lastFix = r.fix_nodes[0];
    await tick('dispatch fix'); // FIX node should dispatch (orig now depends on it)
    const running = eng.getHopperNode(lastFix.id);
    if (running.status !== 'running') break;
    eng.finishHopperNode(lastFix.id, 'blocked', { result: `fix ${i} blocked` }); await tick('fix blocked');
    if (spawns.length > depth) { depth = spawns.length; blockedId = lastFix.id; } else break;
  }
  check('R1', 'RECURSION: an unblocker-planted FIX node that blocks must NOT spawn a fresh unblocker (cascade)', () => {
    assert.equal(spawns.length, 1, `unblocker spawns cascaded to depth ${spawns.length}: ${spawns.join(', ')}`);
  });
  console.log(`  [R1 evidence] unblocker spawns after 5 FIX-blocks: ${spawns.length} → ${spawns.join(', ')}; passes=${passes().length}`);
}

// R2: FIX leaf on the REAL Fable 5.1 id and a FIX on auggie/opus frontier → accepted?
reset();
{
  const { nodes } = await runningTree('adv: fix model bypass');
  eng.finishHopperNode(nodes[0].id, 'blocked', { result: 'b' }); await tick('b');
  let accepted = null, err = null;
  try { accepted = eng.appendHopperRemediationNodes(nodes[0].id, [{ title: 'x', spec: 'sim', adapter: 'claude', model: 'claude-fable-5-1' }]); } catch (e) { err = e.message; }
  check('R2', 'FIX leaf on claude-fable-5-1 (the real Fable 5.1 id) must be rejected', () => { assert.ok(err, `accepted: fix node ${accepted?.fix_nodes?.[0]?.id} model=${accepted?.fix_nodes?.[0]?.model}`); });
}

// R3: concurrency — 5 nodes block at once → 5 parallel high-tier unblockers?
reset();
{
  const { nodes } = await runningTree('adv: fan-out', ['a', 'b', 'c', 'd', 'e']);
  for (const n of nodes) eng.finishHopperNode(n.id, 'blocked', { result: 'missing toolchain: composer' });
  await tick('all blocked');
  check('R3', 'N simultaneous red blocks spawn N concurrent Opus unblockers (no concurrency cap)', () => { assert.ok(spawns.length <= 1, `spawned ${spawns.length} unblockers concurrently`); });
  console.log(`  [R3 evidence] 5 nodes blocked → ${spawns.length} unblocker workers spawned in the same tick`);
}

// R4: spawn failure (adapter busy) burns the one-pass fuse permanently
reset();
{
  const { nodes } = await runningTree('adv: spawn failure');
  failNextSpawn = true;
  eng.finishHopperNode(nodes[0].id, 'blocked', { result: 'b' }); await tick('b');
  const p = passes()[0];
  check('R4', 'a transient spawn failure must not consume the one-pass fuse', () => { assert.notEqual(p?.status, 'failed', `pass status=${p?.status} worker_ext=${p?.worker_ext} — fuse burned, node stays blocked with no retry path`); });
  console.log(`  [R4 evidence] pass=${JSON.stringify({ status: p?.status, worker_ext: p?.worker_ext })} node.status=${eng.getHopperNode(nodes[0].id).status}`);
}

// R5: juice closed at block time → is a waiting_for_juice marker written / anything to sweep later?
reset(); setUsage({ claude5h: 80 });
{
  const { nodes } = await runningTree('adv: juice closed');
  eng.finishHopperNode(nodes[0].id, 'blocked', { result: 'b' }); await tick('b');
  const p = passes();
  setUsage({ claude5h: 10 }); await tick('juice reopened'); await tick('again');
  check('R5', 'node that blocked while juice was closed gets picked up when juice reopens', () => { assert.equal(spawns.length, 1, `passes=${p.length}, spawns after reopen=${spawns.length}`); });
  console.log(`  [R5 evidence] markers at hold time=${p.length}; spawns after juice reopened + 2 ticks=${spawns.length}`);
}

// R6: stale usage file → hold (expected pass)
reset(); fs.utimesSync(claudeUsageFile, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
{
  const { nodes } = await runningTree('adv: stale');
  eng.finishHopperNode(nodes[0].id, 'blocked', { result: 'b' }); await tick('b');
  check('R6', 'stale claude usage file holds the unblocker', () => assert.equal(spawns.length, 0));
}
// R7: sonnet setting → fallback opus-5 (expected pass); opus4.8 with auggie frozen → falls back to claude opus-5
reset(); setSettings({ unblocker_model: 'claude-sonnet-5' });
{ const { nodes } = await runningTree('adv: sonnet'); eng.finishHopperNode(nodes[0].id, 'blocked', { result: 'b' }); await tick('b');
  check('R7a', 'unblocker_model=sonnet falls back to opus-5', () => assert.equal(passes()[0].model, 'claude-opus-5')); }
reset(); setSettings({ unblocker_model: 'opus4.8' }); setUsage({ auggie: 90 });
{ const { nodes } = await runningTree('adv: auggie frozen'); eng.finishHopperNode(nodes[0].id, 'blocked', { result: 'b' }); await tick('b');
  check('R7b', 'opus4.8 with auggie frozen falls back to claude/opus-5', () => { assert.equal(passes()[0].adapter, 'claude'); assert.equal(passes()[0].model, 'claude-opus-5'); }); }
// R8: re-pended original blocks again after FIX chain → needs_kevin, no 2nd spawn (expected pass)
reset();
{ const { nodes } = await runningTree('adv: repend'); const o = nodes[0];
  eng.finishHopperNode(o.id, 'blocked', { result: 'b1' }); await tick('b1');
  const r = eng.appendHopperRemediationNodes(o.id, [{ title: 'f', spec: 's', adapter: 'claude', model: 'claude-sonnet-5' }]); await tick('fix');
  eng.finishHopperNode(r.fix_nodes[0].id, 'done', { result: 'fixed' }); await tick('fix done');
  assert.equal(eng.getHopperNode(o.id).status, 'running');
  eng.finishHopperNode(o.id, 'blocked', { result: 'b2' }); await tick('b2');
  check('R8', 're-pended original blocking again → needs_kevin, no second spawn', () => { assert.equal(spawns.length, 1); assert.equal(passes()[0].status, 'needs_kevin'); assert.equal(notes().length, 1); }); }
// R9: draft tree / archived tree never triggers (blocked via finish on running node only) — finish-line FULL-missing-handoff triggers unblocker
reset();
{ const { nodes } = await runningTree('adv: remediate route on blocked_question');
  eng.finishHopperNode(nodes[0].id, 'blocked_question', { question: 'q' });
  const r = eng.appendHopperRemediationNodes(nodes[0].id, [{ title: 'f', spec: 's', adapter: 'claude', model: 'claude-sonnet-5' }]);
  check('R9', 'remediate helper refuses blocked_question nodes', () => assert.equal(r, null)); }

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.id} - ${r.d}${r.e ? `\n   ${r.e}` : ''}`);
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
fs.rmSync(scratch, { recursive: true, force: true });
