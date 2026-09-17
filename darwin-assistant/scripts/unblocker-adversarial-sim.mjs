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
// CONTRACT UPDATE (2026-09-17, finding-1 remediation): the cap governs how many
// unblockers run CONCURRENTLY, not the lifetime total. Once finding-1 gave a pass
// a `done` transition, a completed pass frees its slot and the next parked node
// runs on a later tick — so "5 simultaneous blocks" no longer means "1 spawn
// ever" (that was only true while a finished pass wrongly held the slot forever).
// Measure the real invariant: at the instant of the simultaneous burst (before
// any tick lets the instant fake-worker complete), only ONE spawned and the rest
// are parked waiting_for_juice. That is the "no N parallel Opus workers" contract.
reset();
{
  const { nodes } = await runningTree('adv: fan-out', ['a', 'b', 'c', 'd', 'e']);
  for (const n of nodes) eng.finishHopperNode(n.id, 'blocked', { result: 'missing toolchain: composer' });
  const spawnedAtBurst = spawns.length;
  const parkedAtBurst = passes().filter((p) => p.status === 'waiting_for_juice').length;
  await tick('all blocked');
  check('R3', 'N simultaneous red blocks must NOT spawn N concurrent Opus unblockers — the cap holds all but one', () => {
    assert.equal(spawnedAtBurst, 1, `spawned ${spawnedAtBurst} unblockers concurrently at the burst (cap=1)`);
    assert.ok(parkedAtBurst >= 4, `only ${parkedAtBurst}/4 siblings parked waiting_for_juice under the cap`);
  });
  console.log(`  [R3 evidence] 5 nodes blocked in one burst → ${spawnedAtBurst} spawned concurrently, ${parkedAtBurst} parked (cap=1); after a tick the instant fake-workers complete and parked nodes run serially → cumulative spawns=${spawns.length}`);
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


// ---------------------------------------------------------------------------
// Review #223 re-run (2026-09-15) after the fix pass afeca0e5d — probes R10+.
// ---------------------------------------------------------------------------

// R10: PASS LIFECYCLE / PERMANENT LOCKOUT. A successful unblocker pass (worker
// turn completed, FIX planted, original re-pended, FIX done, original done)
// must release the concurrency slot. Otherwise the default cap of 1 means the
// feature works exactly once per DB lifetime and parks every later block forever.
reset();
{
  const a = await runningTree('adv: lockout tree A');
  eng.finishHopperNode(a.nodes[0].id, 'blocked', { result: 'A blocked' }); await tick('A blocked');
  assert.equal(spawns.length, 1);
  // The unblocker worker (fakePM) has already returned. Now it "did its job":
  const r = eng.appendHopperRemediationNodes(a.nodes[0].id, [{ title: 'fix A', spec: 's', adapter: 'claude', model: 'claude-sonnet-5' }]); await tick('fix A dispatch');
  eng.finishHopperNode(r.fix_nodes[0].id, 'done', { result: 'fixed' }); await tick('fix A done');
  eng.finishHopperNode(a.nodes[0].id, 'done', { result: 'A done' }); await tick('A done');
  const treeA = eng.getHopperTree(a.treeId);
  const passA = passes()[0];
  // Completely unrelated tree B blocks with the gate wide open:
  const b = await runningTree('adv: lockout tree B');
  eng.finishHopperNode(b.nodes[0].id, 'blocked', { result: 'B blocked' }); await tick('B blocked');
  for (let i = 0; i < 5; i++) await tick(`sweep ${i}`);
  const passB = passes().find((p) => p.node_id === b.nodes[0].id);
  check('R10', 'after a SUCCESSFUL pass (tree A done), an unrelated block on tree B must still get its unblocker', () => {
    assert.equal(spawns.length, 2, `tree A status=${treeA?.status}, pass A status=${passA?.status} (never leaves running); tree B pass=${passB?.status}; spawns=${spawns.length} after 5 sweeps — concurrency cap ${1} permanently held by a finished pass`);
  });
  console.log(`  [R10 evidence] tree A=${treeA?.status}, pass A=${passA?.status}, tree B block → pass B=${passB?.status}, spawns=${spawns.length}`);
}

// R11: RECURSION VIA SPLIT. A FIX node that finishes `split` creates children
// WITHOUT remediation_of; a child that blocks is a fresh, unmarked node and
// spawns a new unblocker → FIX → split → child blocks → ... Raise the cap so
// R10's lockout does not mask it.
reset(); setSettings({ unblocker_max_concurrent: '10' });
{
  const { treeId, nodes } = await runningTree('adv: split recursion');
  let blockedId = nodes[0].id;
  eng.finishHopperNode(blockedId, 'blocked', { result: 'root blocked' }); await tick('root blocked');
  assert.equal(spawns.length, 1);
  const chain = [];
  for (let depth = 0; depth < 4; depth++) {
    const r = eng.appendHopperRemediationNodes(blockedId, [{ title: `fix d${depth}`, spec: 's', adapter: 'claude', model: 'claude-sonnet-5' }]);
    const fix = r.fix_nodes[0]; await tick('fix dispatch');
    if (eng.getHopperNode(fix.id).status !== 'running') break;
    eng.finishHopperNode(fix.id, 'split', { children: [{ title: `sub d${depth}`, spec: 's' }] }); await tick('split');
    const child = eng.listTreeNodes(treeId).find((n) => n.parent_id === fix.id);
    if (!child) break;
    await tick('child dispatch');
    if (eng.getHopperNode(child.id).status !== 'running') break;
    eng.finishHopperNode(child.id, 'blocked', { result: `sub d${depth} blocked` }); await tick('child blocked');
    chain.push({ fix: fix.id, child: child.id, child_remediation_of: child.remediation_of, spawns: spawns.length });
    blockedId = child.id;
  }
  check('R11', 'RECURSION via split: a FIX node that splits must not let its children re-arm the unblocker (cascade)', () => {
    assert.equal(spawns.length, 1, `spawns cascaded to ${spawns.length}: ${JSON.stringify(chain)}`);
  });
  console.log(`  [R11 evidence] FIX→split→child-blocks chain: ${JSON.stringify(chain)}; total unblocker spawns=${spawns.length}`);
}

// R12: UNBOUNDED SPAWN-FAIL RETRY. finding-4's fix resets a failed spawn to
// waiting_for_juice and the sweep retries it every tick, with no attempt cap.
// A deterministic failure (bad model on the plan, prompt too large, CLI broken)
// = one high-tier spawn attempt + one error bell per tick, forever.
reset();
let failAlways = false; let attempts = 0;
const origFakePM = fakePM;
{
  // swap the hook: count every attempt, throw while failAlways
  eng.startHopperEngine(async (prompt, cid) => { if (cid.startsWith('cockpit:unblocker-')) { attempts++; if (failAlways && attempts <= 200) throw new Error('CLI exited 1: model not available on this plan'); /* bounded at 200: the unbounded version wrote 493,299 error bells before being killed */ spawns.push(cid); } return 'NOOP'; });
  failAlways = true;
  const { nodes } = await runningTree('adv: spawn fail loop');
  eng.finishHopperNode(nodes[0].id, 'blocked', { result: 'b' }); await tick('b');
  for (let i = 0; i < 8; i++) await tick(`sweep ${i}`);
  await new Promise((r) => setTimeout(r, 50));
  const errBells = notes().filter((n) => n.title.startsWith('Hopper unblocker failed to start')).length;
  check('R12', 'a deterministic spawn failure must not retry unboundedly (one attempt + one error bell per tick forever)', () => {
    assert.ok(attempts <= 2, `spawn attempts=${attempts} (sim caps the failing hook at 200 — the loop is a queueMicrotask→dispatchTick→sweep→spawn→throw cycle with no timer between iterations; unbounded run wrote 493,299 error notifications before being killed), error bells=${errBells}, pass=${passes()[0]?.status}`);
  });
  console.log(`  [R12 evidence] spawn attempts=${attempts}, error bells=${errBells}, pass status=${passes()[0]?.status} after 9 ticks`);
  failAlways = false;
  eng.startHopperEngine(origFakePM);
}

// R13: lease exhaustion → blocked must NOT trigger (contract: not an intentional red block). Expected pass.
reset();
{
  const { nodes } = await runningTree('adv: lease exhausted');
  const n = nodes[0];
  sqliteDb.prepare(`UPDATE hopper_nodes SET attempts = 2, lease_expires_at = datetime('now', '-1 hour') WHERE id = ?`).run(n.id);
  await tick('expire'); await tick('again');
  const after = eng.getHopperNode(n.id);
  check('R13', 'lease-exhausted block does not spawn or park an unblocker pass', () => { assert.equal(after.status, 'blocked'); assert.equal(spawns.length, 0); assert.equal(passes().length, 0); });
  console.log(`  [R13 evidence] node=${after.status} spawns=${spawns.length} passes=${passes().length}`);
}

// R14: needs_kevin on a FIX-node block must land on the ROOT pass even when the
// FIX was planted by hand on a node that never had a pass row (no crash, one bell).
reset();
{
  const { nodes } = await runningTree('adv: manual remediation no pass row');
  convDb.setSetting('unblocker_enabled', 'off');
  eng.finishHopperNode(nodes[0].id, 'blocked', { result: 'b' }); await tick('b');
  assert.equal(passes().length, 1); // waiting marker (enabled=off is a gate-fail)
  convDb.setSetting('unblocker_enabled', 'on');
  const r = eng.appendHopperRemediationNodes(nodes[0].id, [{ title: 'f', spec: 's', adapter: 'claude', model: 'claude-sonnet-5' }]); await tick('fix');
  eng.finishHopperNode(r.fix_nodes[0].id, 'blocked', { result: 'fix blocked' }); await tick('fix blocked');
  check('R14', 'FIX blocked on a root whose pass was only waiting: escalates needs_kevin, no spawn, one bell', () => {
    assert.equal(spawns.length, 0); assert.equal(passes()[0].status, 'needs_kevin'); assert.equal(notes().length, 1);
  });
  console.log(`  [R14 evidence] pass=${passes()[0]?.status} spawns=${spawns.length} bells=${notes().length}`);
}

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.id} - ${r.d}${r.e ? `\n   ${r.e}` : ''}`);
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
fs.rmSync(scratch, { recursive: true, force: true });
