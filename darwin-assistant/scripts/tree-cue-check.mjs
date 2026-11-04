// TREE-CUE CHECK (tree-c82544e2, node #473) — exercises src/tree-cue.ts against
// a SCRATCH sqlite DB. No real model call: dist/agent.js's dynamic import from
// tree-cue.js is intercepted by scripts/tree-cue-check.hooks.mjs and swapped for
// a stub that records what treeCueOnTreeStatus would have posted.
//
//   npm run build
//   node --import ./scripts/tree-cue-check.hooks.mjs scripts/tree-cue-check.mjs
//   (register() below does the same thing without the --import flag too)

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const raw = process.env.JARVIS_DB_PATH ?? '/tmp/tree-cue-check.db';
const DB_PATH = path.resolve(raw);
const LIVE_DB = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
if (DB_PATH === LIVE_DB) {
  console.error('FATAL: refusing to run against the live jarvis.db. Use a /tmp scratch path.');
  process.exit(1);
}
process.env.JARVIS_DB_PATH = DB_PATH;
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
console.log(`[tree-cue-check] scratch DB: ${DB_PATH}`);

process.env.HOPPER_GOV_ENABLED = '0';
delete process.env.ANTHROPIC_API_KEY;

register(pathToFileURL(path.join(__dirname, 'tree-cue-check.hooks.mjs')), import.meta.url);

const distDir = path.join(repoRoot, 'dist');
const treeCue = await import(path.join(distDir, 'tree-cue.js'));
const hopper = await import(path.join(distDir, 'hopper-engine.js'));
const convDb = await import(path.join(distDir, 'conversation-db.js'));
const { sqliteDb } = convDb;

function cueCalls() {
  return globalThis.__treeCueCalls ?? [];
}
// treeCueOnTreeStatus fires-and-forgets a dynamic import().then(...) chain — give
// it a beat to settle before asserting on globalThis.__treeCueCalls.
async function waitForCueCount(n, timeoutMs = 2000) {
  const start = Date.now();
  while (cueCalls().length < n) {
    if (Date.now() - start > timeoutMs) break;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const setStatus = sqliteDb.prepare(`UPDATE hopper_nodes SET status = ?, result = ? WHERE id = ?`);
function finishAll(nodes, status = 'done', result = null) {
  for (const n of nodes) setStatus.run(status, result, n.id);
}

// ── 1) DONE tree with a real origin thread → exactly ONE cue ────────────────
const ORIGIN = 'cockpit:test-origin';
convDb.getOrCreateConversation(ORIGIN);
const { tree, nodes } = hopper.createHopperTree('build the tree-cue seam', ORIGIN, [
  { title: 'BACKEND — tree done/blocked cue' },
  { title: 'SIM — scratch-DB test' },
  { title: 'DOCS + push' },
]);
finishAll(nodes, 'done');

treeCue.treeCueOnTreeStatus(tree.id, 'done');
await waitForCueCount(1);
assert.equal(cueCalls().length, 1, 'expected exactly ONE done cue');
const doneCue = cueCalls()[0];
assert.equal(doneCue.externalId, ORIGIN, 'cue must post into the origin thread');
assert.equal(doneCue.correlationKey, `tree-cue:${tree.id}:done`, 'correlation key shape');
assert.match(doneCue.text, new RegExp(`^\\[tree ${tree.id} "build the tree-cue seam" DONE — 3/3 nodes done\\]`), 'done header');
assert.match(doneCue.text, /nodes:/, 'node list label');
assert.match(doneCue.text, /#\d+ done BACKEND/, 'node line with status');
assert.match(doneCue.text, /Next: review the deliverables against the original ask/, 'done Next line');
console.log('\n=== DONE cue text ===\n');
console.log(doneCue.text);

// ── 2) fire DONE again → dedupe, NO second cue ──────────────────────────────
treeCue.treeCueOnTreeStatus(tree.id, 'done');
await new Promise((r) => setTimeout(r, 150));
assert.equal(cueCalls().length, 1, 'a repeat done transition must NOT fire a second cue');

// ── 3) BLOCKED tree → one blocked cue with the blocked node + its last result ─
const ORIGIN2 = 'cockpit:test-origin-2';
convDb.getOrCreateConversation(ORIGIN2);
const t2 = hopper.createHopperTree('foundation gate build', ORIGIN2, [
  { title: 'RECON' },
  { title: 'BACKEND scaffold' },
  { title: 'REVIEW' },
]);
setStatus.run('done', null, t2.nodes[0].id);
setStatus.run('blocked', 'composer create-project failed: missing PHP toolchain on the box', t2.nodes[1].id);
// leave node 3 pending

treeCue.treeCueOnTreeStatus(t2.tree.id, 'blocked');
await waitForCueCount(2);
assert.equal(cueCalls().length, 2, 'expected ONE blocked cue');
const blockedCue = cueCalls()[1];
assert.equal(blockedCue.externalId, ORIGIN2);
assert.match(blockedCue.text, new RegExp(`^\\[tree ${t2.tree.id} "foundation gate build" BLOCKED — 1/3 nodes done, 1 blocked\\]`), 'blocked header w/ blocked count');
assert.match(blockedCue.text, /blocked node\(s\):/, 'blocked node section');
assert.match(blockedCue.text, /missing PHP toolchain/, 'blocked node last result line');
assert.match(blockedCue.text, /Next: unstick the blocked node\(s\) per the Smart Unblocker rule/, 'blocked Next line');
console.log('\n=== BLOCKED cue text ===\n');
console.log(blockedCue.text);

// ── 4) 'active' never cues ──────────────────────────────────────────────────
treeCue.treeCueOnTreeStatus(t2.tree.id, 'active');
await new Promise((r) => setTimeout(r, 150));
assert.equal(cueCalls().length, 2, "'active' must never fire a cue");

// ── 5) blocked → active → blocked again → MAY cue again ─────────────────────
treeCue.treeCueOnTreeStatus(t2.tree.id, 'blocked');
await waitForCueCount(3);
assert.equal(cueCalls().length, 3, 'a re-block after active must cue again');
console.log('\n=== RE-BLOCK cue (after active re-armed the guard) fired: OK ===');

// ── 6) settings kill switch: hopper_tree_cue=off → no cue ───────────────────
convDb.setSetting('hopper_tree_cue', 'off');
const ORIGIN3 = 'cockpit:test-origin-3';
convDb.getOrCreateConversation(ORIGIN3);
const t3 = hopper.createHopperTree('silenced tree', ORIGIN3, [{ title: 'X' }]);
finishAll(t3.nodes, 'done');
treeCue.treeCueOnTreeStatus(t3.tree.id, 'done');
await new Promise((r) => setTimeout(r, 150));
assert.equal(cueCalls().length, 3, 'hopper_tree_cue=off must suppress the cue');
convDb.setSetting('hopper_tree_cue', 'on');
console.log('=== kill switch (hopper_tree_cue=off) suppressed the cue: OK ===');

// ── 7) worker / ephemeral / quick origin threads are never woken ────────────
convDb.setSetting('hopper_tree_cue', 'on');
for (const badOrigin of ['cockpit:hopper-node-99-abcd', 'ephemeral:checkin:x', 'quick:hub-1.0:y']) {
  convDb.getOrCreateConversation(badOrigin);
  const tw = hopper.createHopperTree(`worker-origin ${badOrigin}`, badOrigin, [{ title: 'X' }]);
  finishAll(tw.nodes, 'done');
  treeCue.treeCueOnTreeStatus(tw.tree.id, 'done');
}
await new Promise((r) => setTimeout(r, 200));
assert.equal(cueCalls().length, 3, 'ephemeral/worker/quick origin threads must never be cued');
console.log('=== worker/ephemeral/quick origins skipped: OK ===');

// ── 8) no origin thread → no cue, no crash ──────────────────────────────────
const tNoOrigin = hopper.createHopperTree('orphan tree', null, [{ title: 'X' }]);
finishAll(tNoOrigin.nodes, 'done');
treeCue.treeCueOnTreeStatus(tNoOrigin.tree.id, 'done');
await new Promise((r) => setTimeout(r, 150));
assert.equal(cueCalls().length, 3, 'a tree with no origin thread must not cue');
console.log('=== null origin skipped: OK ===');

// ── 9) REVIEW (#474): foundry module/integration trees never cue ────────────
// A foundry project plants one tree per module + an integration tree, all
// carrying the PROJECT's origin thread — cueing each would storm that thread
// and fight foundry's own auto-decide ladder.
const ORIGIN_F = 'cockpit:test-origin-foundry';
convDb.getOrCreateConversation(ORIGIN_F);
const before9 = cueCalls().length;
for (const topic of ['foundry:proj-1/api', 'foundry:proj-1/integration']) {
  const tf = hopper.createHopperTree(topic, ORIGIN_F, [{ title: 'BUILD' }]);
  finishAll(tf.nodes, 'done');
  treeCue.treeCueOnTreeStatus(tf.tree.id, 'done');
}
await new Promise((r) => setTimeout(r, 200));
assert.equal(cueCalls().length, before9, 'foundry: trees must never cue the origin thread');
console.log('=== foundry module/integration trees skipped: OK ===');

// ── 10) REVIEW (#474): blocked_question shows the QUESTION and is Kevin's call ─
const ORIGIN_Q = 'cockpit:test-origin-question';
convDb.getOrCreateConversation(ORIGIN_Q);
const tq = hopper.createHopperTree('needs a product call', ORIGIN_Q, [
  { title: 'RECON' },
  { title: 'BUILD the export' },
]);
sqliteDb.prepare(`UPDATE hopper_nodes SET status = 'done' WHERE id = ?`).run(tq.nodes[0].id);
sqliteDb
  .prepare(`UPDATE hopper_nodes SET status = 'blocked_question', question = ? WHERE id = ?`)
  .run('CSV or XLSX for the advertiser export?', tq.nodes[1].id);
treeCue.treeCueOnTreeStatus(tq.tree.id, 'blocked');
await waitForCueCount(before9 + 1);
assert.equal(cueCalls().length, before9 + 1, 'blocked_question must still cue once');
const qCue = cueCalls()[before9];
assert.match(qCue.text, /CSV or XLSX for the advertiser export\?/, 'blocked_question text must come from `question`, not `result`');
assert.match(qCue.text, /\[needs Kevin\]/, 'blocked_question node is tagged for Kevin');
assert.match(qCue.text, /Kevin's call, not yours/, 'question-only tree must not invite JARVIS to answer it');
assert.doesNotMatch(qCue.text, /Smart Unblocker/, 'the Smart Unblocker line must not appear on a question-only tree');
console.log('\n=== BLOCKED_QUESTION cue text ===\n');
console.log(qCue.text);

// ── 11) REVIEW (#474): a `split` parent counts as done in the header ─────────
const ORIGIN_S = 'cockpit:test-origin-split';
convDb.getOrCreateConversation(ORIGIN_S);
const ts = hopper.createHopperTree('tree with a split parent', ORIGIN_S, [
  { title: 'PLAN' },
  { title: 'BUILD' },
]);
sqliteDb.prepare(`UPDATE hopper_nodes SET status = 'split' WHERE id = ?`).run(ts.nodes[0].id);
sqliteDb.prepare(`UPDATE hopper_nodes SET status = 'done' WHERE id = ?`).run(ts.nodes[1].id);
treeCue.treeCueOnTreeStatus(ts.tree.id, 'done');
await waitForCueCount(before9 + 2);
assert.match(cueCalls()[before9 + 1].text, /DONE — 2\/2 nodes done\]/, 'a split parent is settled and must count as done');
console.log('=== split parent counted as done: OK ===');

// ── 12) REVIEW (#474): re-agreeing a DONE tree re-arms the guard ─────────────
// agreeHopperTree now notifies 'active'; without that re-arm a repair /
// continuation run of an already-cued tree stayed deduped forever.
const countBefore12 = cueCalls().length;
hopper.agreeHopperTree(tree.id); // the tree from check 1 — already cued 'done'
sqliteDb.prepare(`UPDATE hopper_nodes SET status = 'done' WHERE tree_id = ?`).run(tree.id);
treeCue.treeCueOnTreeStatus(tree.id, 'done');
await waitForCueCount(countBefore12 + 1);
assert.equal(cueCalls().length, countBefore12 + 1, 'a re-agreed tree must cue again when it finishes the second time');
console.log('=== re-agreed tree cues again: OK ===');

console.log('\nALL TREE-CUE CHECKS PASSED ✅');
process.exit(0);
