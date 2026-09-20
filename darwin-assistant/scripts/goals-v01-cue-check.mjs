// GOALS v0.1 REVIEW-CUE CHECK (hopper node #469) — manual exercise of CONTRACT
// §11.3 (the cue) + §11.4 (focus-injection markers) against the real goals.ts,
// on a SCRATCH sqlite DB. No real model call: dist/agent.js is intercepted by
// scripts/goals-v01-cue-check.hooks.mjs (an ESM loader hook) and swapped for a
// stub that just records what fireGoalReviewCue would have sent.
//
//   npm run build
//   node --import ./scripts/goals-v01-cue-check.hooks.mjs scripts/goals-v01-cue-check.mjs
//   (register() below does the same thing without the --import flag too)

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const raw = process.env.JARVIS_DB_PATH ?? '/tmp/goals-v01-cue-check.db';
const DB_PATH = path.resolve(raw);
const LIVE_DB = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
if (DB_PATH === LIVE_DB) {
  console.error('FATAL: refusing to run against the live jarvis.db. Use a /tmp scratch path.');
  process.exit(1);
}
process.env.JARVIS_DB_PATH = DB_PATH;
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
console.log(`[goals-v01-cue-check] scratch DB: ${DB_PATH}`);

process.env.HOPPER_GOV_ENABLED = '0';
delete process.env.ANTHROPIC_API_KEY;

register(pathToFileURL(path.join(__dirname, 'goals-v01-cue-check.hooks.mjs')), import.meta.url);

const distDir = path.join(repoRoot, 'dist');
const goals = await import(path.join(distDir, 'goals.js'));

function cueCalls() {
  return globalThis.__goalsCueCalls ?? [];
}

// fireGoalReviewCue fires-and-forgets a dynamic import().then(...) chain — give
// it a beat to settle before asserting on globalThis.__goalsCueCalls.
async function waitForCueCount(n, timeoutMs = 2000) {
  const start = Date.now();
  while (cueCalls().length < n) {
    if (Date.now() - start > timeoutMs) break;
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ── 1) build a goal + one JARVIS-proposed ghost, focus it ──────────────────
const { goal } = goals.createGoal({ title: 'v0.1 cue check', done_means: 'prove the review-cue + focus markers work', actor: 'kevin' });
const goalId = goal.id;
// createGoal seeds a thread lazily via getOrCreateGoalThread in the real HTTP
// path (routes 1/POST /goals) — call it directly so fireGoalReviewCue has a
// conversation to post into (CONTRACT §8).
const threadInfo = goals.getOrCreateGoalThread(goalId);
assert.equal(threadInfo.external_id, `cockpit:goal-${goalId}`);

const { nodes } = goals.proposeGoalNodes(goalId, {
  parent_id: null,
  items: [{ title: 'Ship the thing', done_means: 'thing is shipped and verified' }],
  actor: 'jarvis',
});
const nodeId = nodes[0].id;
goals.setGoalFocus(goalId, nodeId, 'jarvis');

// ── 2) Kevin edits the ghost, then OKs it → should NOT solidify; should fire ONE cue ──
goals.patchGoalNode(goalId, nodeId, { title: 'Ship the thing FAST', done_means: 'thing is shipped, verified, and fast', actor: 'kevin' });
let row = goals.getRawGoalNode(nodeId);
assert.equal(row.last_edited_by, 'kevin', 'expected last_edited_by=kevin after Kevin patch');
assert.equal(row.review_state, 'none', 'expected review_state=none right after the edit (not yet OK\'d)');
assert.ok(row.kevin_edit_original, 'expected kevin_edit_original snapshot to be set');

const accepted = goals.acceptGoalNode(goalId, nodeId, 'kevin');
assert.equal(accepted.state, 'ghost', 'a Kevin-edited ghost must NOT solidify on Kevin\'s own OK');
assert.equal(accepted.review_state, 'awaiting_jarvis', 'expected review_state=awaiting_jarvis after Kevin OK\'d his own edit');

await waitForCueCount(1);
assert.equal(cueCalls().length, 1, 'expected exactly ONE cue post for this accept');
const cue = cueCalls()[0];
assert.equal(cue.externalId, `cockpit:goal-${goalId}`);
console.log('\n=== §11.3 cue text (Kevin OK\'d his own edit) ===\n');
console.log(cue.text);

// a re-click while awaiting must 409, and must NOT fire a second cue
let reclickErr = null;
try { goals.acceptGoalNode(goalId, nodeId, 'kevin'); } catch (e) { reclickErr = e; }
assert.ok(reclickErr, 'expected the re-click to throw');
assert.equal(reclickErr.code, 'awaiting_jarvis');
await new Promise((r) => setTimeout(r, 100));
assert.equal(cueCalls().length, 1, 'a re-click while awaiting must not fire a second cue');

// ── 3) §11.4 focus-injection markers while awaiting ─────────────────────────
const ctxAwaiting = goals.buildGoalThreadContext(`cockpit:goal-${goalId}`);
console.log('\n=== §11.4 focus/tree context (awaiting_jarvis) ===\n');
console.log(ctxAwaiting);
assert.match(ctxAwaiting, /awaiting_you="1"/, 'expected <goal_tree awaiting_you="1"> while one node is awaiting');
assert.match(ctxAwaiting, /\[ghost b:\S* ✎K/, 'expected the ✎K marker on the Kevin-edited ghost');
assert.match(ctxAwaiting, /AWAITING YOUR TAKE \(was: "Ship the thing"\)/, 'expected the AWAITING YOUR TAKE suffix quoting JARVIS\'s original title');

// ── 4) JARVIS pushes back → stays ghost, note shown, tree updates ──────────
const pushedBack = goals.pushBackGhost(goalId, nodeId, 'Let\'s not promise "fast" until we\'ve actually measured it.', 'jarvis');
assert.equal(pushedBack.state, 'ghost');
assert.equal(pushedBack.review_state, 'pushed_back');
const ctxPushedBack = goals.buildGoalThreadContext(`cockpit:goal-${goalId}`);
console.log('\n=== §11.4 focus/tree context (pushed_back) ===\n');
console.log(ctxPushedBack);
assert.ok(ctxPushedBack.includes(`you pushed back: "${pushedBack.review_note}"`), 'expected the push-back note suffix on the tree line');
assert.match(ctxPushedBack, /awaiting_you="0"/, 'awaiting_you should drop back to 0 once JARVIS has weighed in (pushed_back, not awaiting)');

// re-OK after push-back (no further edit) → re-asks, cue fires again, quoting the push-back note
const reOk = goals.acceptGoalNode(goalId, nodeId, 'kevin');
assert.equal(reOk.review_state, 'awaiting_jarvis');
await waitForCueCount(2);
assert.equal(cueCalls().length, 2, 'expected a second cue for the re-ask after push-back');
console.log('\n=== §11.3 cue text (re-ask after push-back) ===\n');
console.log(cueCalls()[1].text);
assert.match(cueCalls()[1].text, /you pushed back with:/, 'expected the re-ask cue to quote the push-back note');

// ── 5) JARVIS agrees → solidifies, review fields clear ─────────────────────
const agreed = goals.acceptGoalNode(goalId, nodeId, 'jarvis');
assert.equal(agreed.state, 'set', 'expected the node to solidify once JARVIS agrees');
assert.equal(agreed.review_state, 'none');
assert.equal(agreed.last_edited_by, null);
assert.equal(agreed.kevin_edit_original, null);

const ctxSet = goals.buildGoalThreadContext(`cockpit:goal-${goalId}`);
assert.match(ctxSet, /awaiting_you="0"/);
assert.doesNotMatch(ctxSet, /✎K/, 'the ✎K marker must disappear once the node is set');

console.log('\n[goals-v01-cue-check] ALL CHECKS PASSED\n');
