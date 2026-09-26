#!/usr/bin/env node
// HOPPER RESOURCE LEASES CHECK — docs/hopper/PARALLEL-CONTRACT.md §5
// (tree-383bb55b node #950)
//
//   npm run hopper-leases:check
//
// Drives the REAL compiled dist/hopper-engine.js — the real dispatchTick, the
// real claim/finish/expiry paths — against a scratch DB. No git needed: §5 is
// not integration-tree-specific, so every fixture here is a plain legacy tree
// (no repo_path/integration_branch), which keeps this check fast and hermetic
// with zero filesystem/git surface.
//
// Hermetic (§10): scratch DB via JARVIS_DB_PATH, JARVIS_SIM=1, ZERO model calls
// (the engine is started with a stub that RECORDS a spawn instead of calling a
// model, and the run asserts the count at the end).
//
// Covers:
//   LC-1  two nodes sharing 'perclickity-sandbox-rules' run STRICTLY SERIALLY
//         while an unrelated third node (no shared resource) runs IN PARALLEL
//   LC-2  the lease releases on FINISH — any outcome (done AND blocked both
//         tested), and the waiter claims on the very next tick
//   LC-3  the lease releases on EXPIRY — a crashed/expired holder's lease frees
//         the name even though the holder never called finish
//   LC-4  multi-resource nodes acquire ALL-OR-NOTHING: a node naming two
//         resources is blocked if EITHER is held, and a single-resource node
//         can still claim the other name while the multi-resource node waits
//   LC-5  a resource conflict is a SKIP, never a park: status stays `pending`,
//         no attempt is consumed, no lease is set

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const rawDb = process.env.JARVIS_DB_PATH;
if (!rawDb || !rawDb.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path.');
  process.exit(1);
}
const DB_PATH = path.resolve(rawDb);
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

process.env.JARVIS_SIM = '1';
process.env.HOPPER_GOV_ENABLED = '0';
process.env.HOPPER_ENGINE_SLOTS = '8';
process.env.NIGHT_SHIFT_DRIVER = '0';
process.env.NIGHT_SHIFT_KICK_MS = '999999999';
process.env.GOALS_AUTOPILOT_DRIVER = '0';
process.env.GOALS_AUTOPILOT_KICK_MS = '999999999';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ok    ${name}`);
  } else {
    fail += 1;
    console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const dist = path.join(repoRoot, 'dist');
const { sqliteDb } = await import(path.join(dist, 'conversation-db.js'));
const engine = await import(path.join(dist, 'hopper-engine.js'));

// A REAL model call would be a policy violation. This records instead.
let spawnCalls = 0;
const spawnedPrompts = [];
engine.startHopperEngine(async (prompt) => {
  spawnCalls += 1;
  spawnedPrompts.push(prompt);
  return '';
});

const mkTree = (id) => {
  sqliteDb.prepare(`INSERT INTO hopper_trees (id, topic, status) VALUES (?, ?, 'active')`).run(id, `lease check ${id}`);
  return engine.getHopperTree(id);
};
const mkNode = (treeId, title, resources = null) => {
  const info = sqliteDb
    .prepare(`INSERT INTO hopper_nodes (tree_id, title, spec, status, resources) VALUES (?, ?, ?, 'pending', ?)`)
    .run(treeId, title, `do ${title}`, resources ? JSON.stringify(resources) : null);
  return engine.getHopperNode(Number(info.lastInsertRowid));
};
const running = (treeId) => engine.listTreeNodes(treeId).filter((n) => n.status === 'running');
const pendingNodes = (treeId) => engine.listTreeNodes(treeId).filter((n) => n.status === 'pending');

// ===========================================================================
console.log("\n[LC-1] two nodes sharing 'perclickity-sandbox-rules' run strictly serially; an unrelated third runs in parallel");
const LC1 = { tree: 'tree-lc-serial' };
{
  const TREE = LC1.tree;
  mkTree(TREE);
  const a = mkNode(TREE, 'A wants the sandbox rules lease', ['perclickity-sandbox-rules']);
  const b = mkNode(TREE, 'B wants the sandbox rules lease too', ['perclickity-sandbox-rules']);
  const c = mkNode(TREE, 'C wants nothing shared');
  LC1.ids = { a: a.id, b: b.id, c: c.id };

  await engine.dispatchTick('lc-1 t0');
  const t0 = running(TREE).map((n) => n.id);
  check('exactly one of A/B claimed (never both — they share a resource)',
    (t0.includes(a.id) ? 1 : 0) + (t0.includes(b.id) ? 1 : 0) === 1, t0.join(','));
  check('C claimed IN PARALLEL — it holds nothing shared, so it is never held up by A/B',
    t0.includes(c.id), t0.join(','));
  check('exactly 2 nodes are running (the resource winner + C), not 3', t0.length === 2, t0.join(','));
  LC1.winner = t0.includes(a.id) ? a.id : b.id;
  LC1.loser = LC1.winner === a.id ? b.id : a.id;
  check('the loser is still pending, unmodified', engine.getHopperNode(LC1.loser).status === 'pending');
  check('the loser burned NO attempt (a resource hold is a SKIP, not a park)', engine.getHopperNode(LC1.loser).attempts === 0);
  check('the loser has no lease', engine.getHopperNode(LC1.loser).lease_expires_at === null);

  // A second tick with nothing changed must not flip the winner either — proves
  // the hold is stable, not a one-tick fluke of claim ordering.
  await engine.dispatchTick('lc-1 t0-again');
  check('a repeat tick changes nothing: winner still running, loser still pending, C still running',
    engine.getHopperNode(LC1.winner).status === 'running' &&
    engine.getHopperNode(LC1.loser).status === 'pending' &&
    engine.getHopperNode(c.id).status === 'running');
}

// ===========================================================================
console.log('\n[LC-2] the lease releases on FINISH — done and blocked both tested — and the waiter claims next tick');
{
  const { tree: TREE, winner, loser } = LC1;
  engine.finishHopperNode(winner, 'done', { result: 'winner done' });
  check('the winner is done', engine.getHopperNode(winner).status === 'done');
  await engine.dispatchTick('lc-2 after-finish');
  check('the loser claimed the freed resource on the very next tick', engine.getHopperNode(loser).status === 'running', engine.getHopperNode(loser).status);

  // Prove BLOCKED also releases (not just done): reuse the resource name on a
  // fresh pair so this section is independent of LC-1's state.
  const TREE2 = 'tree-lc-finish-blocked';
  mkTree(TREE2);
  const p = mkNode(TREE2, 'P holds it then gets blocked', ['lease-check-finish']);
  const q = mkNode(TREE2, 'Q waits on the same name', ['lease-check-finish']);
  await engine.dispatchTick('lc-2b t0');
  check('P claimed, Q waits', engine.getHopperNode(p.id).status === 'running' && engine.getHopperNode(q.id).status === 'pending');
  engine.finishHopperNode(p.id, 'blocked', { result: 'genuinely stuck' });
  check('P is blocked (not running, not pending)', engine.getHopperNode(p.id).status === 'blocked');
  await engine.dispatchTick('lc-2b t1');
  check('Q claimed once P (the holder) left `running`, regardless of P\'s final outcome',
    engine.getHopperNode(q.id).status === 'running', engine.getHopperNode(q.id).status);
}

// ===========================================================================
console.log('\n[LC-3] the lease releases on EXPIRY — a holder that never calls finish still frees the name');
{
  const TREE = 'tree-lc-expiry';
  mkTree(TREE);
  const holder = mkNode(TREE, 'HOLDER — will be left to expire', ['lease-check-expiry']);
  const waiter = mkNode(TREE, 'WAITER — same resource', ['lease-check-expiry']);

  await engine.dispatchTick('lc-3 t0');
  check('the holder (lower id) claimed at t0', engine.getHopperNode(holder.id).status === 'running');
  check('the waiter is held — the resource is taken', engine.getHopperNode(waiter.id).status === 'pending');

  // Give the waiter higher priority NOW, after t0's outcome is already settled,
  // so that once the name frees up, PRIORITY — not id order — decides who gets
  // it next. If expiry did not actually release the resource, this would be
  // irrelevant; the waiter claiming next proves the name was genuinely freed,
  // not that the same node quietly re-claimed itself.
  sqliteDb.prepare(`UPDATE hopper_nodes SET priority = 10 WHERE id = ?`).run(waiter.id);

  // Simulate a crashed worker: push the lease into the past. No finish call.
  sqliteDb.prepare(`UPDATE hopper_nodes SET lease_expires_at = datetime('now', '-1 minute') WHERE id = ?`).run(holder.id);
  await engine.dispatchTick('lc-3 t1-expiry');
  check('the old holder is no longer running — the expiry sweep pulled it back to pending',
    engine.getHopperNode(holder.id).status !== 'running', engine.getHopperNode(holder.id).status);
  check('the WAITER (higher priority) claimed the freed name in the very same tick — proving expiry released it',
    engine.getHopperNode(waiter.id).status === 'running', engine.getHopperNode(waiter.id).status);
  check('the old holder is back to pending, behind the new holder', engine.getHopperNode(holder.id).status === 'pending');
}

// ===========================================================================
console.log('\n[LC-4] multi-resource nodes acquire ALL-OR-NOTHING');
{
  const TREE = 'tree-lc-multi';
  mkTree(TREE);
  const single = mkNode(TREE, 'SINGLE — holds only resource Y', ['lc4-y']);
  const multi = mkNode(TREE, 'MULTI — needs X and Y both', ['lc4-x', 'lc4-y']);
  const other = mkNode(TREE, 'OTHER — wants only X, which nobody holds yet', ['lc4-x']);

  await engine.dispatchTick('lc-4 t0');
  const t0 = { single: engine.getHopperNode(single.id).status, multi: engine.getHopperNode(multi.id).status, other: engine.getHopperNode(other.id).status };
  check('SINGLE (lower id) claimed Y first', t0.single === 'running', JSON.stringify(t0));
  check('MULTI is blocked because Y (one of its two names) is held — all-or-nothing, not partial',
    t0.multi === 'pending', JSON.stringify(t0));
  check('MULTI never partially acquired X while waiting on Y', engine.getHopperNode(multi.id).resources === JSON.stringify(['lc4-x', 'lc4-y']));
  check('OTHER (wants only X, free) claimed anyway — X was never actually taken by MULTI', t0.other === 'running', JSON.stringify(t0));

  engine.finishHopperNode(single.id, 'done', { result: 'single done' });
  await engine.dispatchTick('lc-4 t1');
  check('MULTI still cannot claim: X is now held by OTHER', engine.getHopperNode(multi.id).status === 'pending');

  engine.finishHopperNode(other.id, 'done', { result: 'other done' });
  await engine.dispatchTick('lc-4 t2');
  check('MULTI claims only once BOTH names are free simultaneously', engine.getHopperNode(multi.id).status === 'running', engine.getHopperNode(multi.id).status);
}

// ===========================================================================
console.log('\n[LC-5] a resource conflict is a SKIP, never a park — no other tree/node was disturbed');
{
  // Cross-check against everything created in LC-1..LC-4: nothing was ever
  // driven to 'blocked' or 'blocked_question' as a side effect of a resource
  // hold (the only 'blocked' node in the whole run is LC-2's deliberate one).
  const allTrees = ['tree-lc-serial', 'tree-lc-finish-blocked', 'tree-lc-expiry', 'tree-lc-multi'];
  const blockedNodes = allTrees.flatMap((t) => engine.listTreeNodes(t)).filter((n) => n.status === 'blocked' || n.status === 'blocked_question');
  check('the ONLY blocked node across every fixture is LC-2\'s deliberate one', blockedNodes.length === 1 && blockedNodes[0].title.includes('P holds it'), blockedNodes.map((n) => n.title).join(' | '));
  // Every claim in this run went through the STUBBED processMessageRef (never a
  // real model/network call) — the sim-guard on a non-live JARVIS_DB_PATH makes
  // that structural, not just observed; this just confirms the stub was really
  // exercised (a silent no-spawn bug would hide as a false pass elsewhere).
  check('the stub recorded at least one spawn per fixture tree (dispatch really ran, not a no-op)', spawnCalls >= allTrees.length, `spawnCalls=${spawnCalls}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
