#!/usr/bin/env node
// NOTEPAD DOSSIER CHECK — exercises src/notepad-dossier.ts (buildTopicDossier),
// node #107's "assemble the dossier — and make it physically unable to invent
// a repo, a branch, or a goal." Drives the model seam with an INJECTED stub —
// never a real spawn — and proves the structural guarantee: repo/branch/goal
// are evidence-sourced facts a model can only ever get REJECTED for
// contradicting, never a source of.
//
// Covers:
//   (a) THE HEADLINE — a real Perclickity line against a seeded corpus
//       returns confidence 'strong', the correct branch, a goal reference,
//       at least one prior-work line, and a rendered block that names the
//       branch. The rendered dossier is printed so a human can read it.
//   (b) THE OTHER HEADLINE — 'call the dentist back' returns topic null,
//       confidence 'none', repo/branch/goal null, prior_work [], and a
//       rendered line admitting no context — proven STRUCTURAL by wiring
//       the stub to a lavish hallucinated response AND asserting it was
//       never called.
//   (c) a stub that cites a branch not in evidence ('hopper/does-not-exist')
//       is REJECTED wholesale, the deterministic fallback is used, and
//       unresolved_reason says so.
//   (d) a stub that times out still yields a usable deterministic dossier.
//   (d2) a stub that returns malformed JSON still yields a usable
//       deterministic dossier.
//   (e) the 'weak' path: topic resolves (a real goal, no branch anywhere in
//       its evidence) -> repo/branch/goal-linked-but-branchless, and the
//       rendered text says what's unknown.
//   (f) ZERO CLAUDE PROCESSES spawned across the whole run.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-dossier-check.db node scripts/notepad-dossier-check.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── scratch DB guard (copied verbatim from the sibling notepad checks) ──────
const raw = process.env.JARVIS_DB_PATH;
if (!raw || !raw.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path.');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

console.log(`[notepad-dossier-check] DB: ${DB_PATH}`);

function claudeProcessCount() {
  try {
    const out = execSync('pgrep -c -f claude', { encoding: 'utf8' });
    return parseInt(out.trim(), 10) || 0;
  } catch (err) {
    if (err && err.status === 1) return 0; // pgrep exits 1 when nothing matches
    throw err;
  }
}

const spawnsBefore = claudeProcessCount();

// Same isolation as the sibling dossier-sources check: force the
// orientation source unreachable (fast-fail) for the whole process, since
// this check has nothing to do with orientation and must not depend on the
// network being up.
process.env.JARVIS_SMARTY_PANTS_URL = 'http://127.0.0.1:1';
process.env.JARVIS_MCP_NATIVE_TIMEOUT_MS = '5000';

const distDir = path.join(__dirname, '..', 'dist');
const { putNotepadDay } = await import(path.join(distDir, 'notepad.js'));
const { buildTopicDossier } = await import(path.join(distDir, 'notepad-dossier.js'));
const { sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));
await import(path.join(distDir, 'goals.js')); // side effect only: creates goals/goal_nodes/goal_events
await import(path.join(distDir, 'hopper-engine.js')); // side effect only: creates hopper_trees/hopper_nodes

let failed = false;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

// == Fixture ==================================================================
//
// Goal 1: PerClickity v2, with a node + tree carrying TWO finished nodes so
// the branch/repo extraction is real (mirrors the dossier-sources fixture).
// Goal 2: a branch-free goal (kids teach-and-do) used for the 'weak' case --
// a topic that genuinely resolves but never names a repo or branch anywhere
// in its evidence.

const insertGoal = sqliteDb.prepare(`
  INSERT INTO goals (title, done_means, notes, status, authored_by) VALUES (?, ?, ?, 'set', 'kevin')
`);
const insertNode = sqliteDb.prepare(`
  INSERT INTO goal_nodes (goal_id, title, done_means, notes, state, tree_id) VALUES (?, ?, ?, ?, ?, ?)
`);
const insertTree = sqliteDb.prepare(`
  INSERT INTO hopper_trees (id, topic, status) VALUES (?, ?, ?)
`);
const insertHopperNode = sqliteDb.prepare(`
  INSERT INTO hopper_nodes (tree_id, title, spec, status, result) VALUES (?, ?, ?, 'done', ?)
`);

const goal1 = insertGoal.run(
  'PerClickity v2 / Clearing House',
  'Every sandbox lane deploys through deploy_control and Zoom 3 changes real verdicts.',
  null,
);
const goal1Id = Number(goal1.lastInsertRowid);

const tree1Id = 'tree-fixture-zoom3-dossier';
insertTree.run(tree1Id, 'Zoom 3 identity browser + make Zoom 3 actually change the verdict', 'done');

insertNode.run(
  goal1Id,
  'Zoom 3 identity browser + make Zoom 3 actually change the verdict',
  'A browsable identity table exists and a dirty/protected ledger actually waives or strengthens a verdict.',
  null,
  'done',
  tree1Id,
);

insertHopperNode.run(
  tree1Id,
  'ENGINE verdict fix (initial pass)',
  'WORKTREE /home/kevin/paperclip-worktrees/pcx-zoom3-old, BRANCH perclickity/zoom3-old',
  'WORKTREE /home/kevin/paperclip-worktrees/pcx-zoom3-old, BRANCH perclickity/zoom3-old — first attempt, superseded.',
);
insertHopperNode.run(
  tree1Id,
  'UI browse table + deploy',
  'WORKTREE /home/kevin/paperclip-worktrees/pcx-ui-zoom3-browse, BRANCH perclickity/zoom3-browse',
  'WORKTREE /home/kevin/paperclip-worktrees/pcx-ui-zoom3-browse, BRANCH perclickity/zoom3-browse — deployed sandbox-perclickity-ui via deploy_control, darwin-assistant unaffected.',
);

// Branch-free goal for the 'weak' case.
const goal2 = insertGoal.run(
  'Kids: Teach and Do weekly ritual',
  'Two picks a week land in the wiki bucket and Kevin gets a Sunday nudge.',
  null,
);
const goal2Id = Number(goal2.lastInsertRowid);
insertNode.run(goal2Id, 'Stock the weekly idea bucket', 'At least two fresh ideas sit ready before Sunday.', null, 'done', null);

const PERCLICKITY_LINE = 'check on the perclickity zoom verdict issue';
const DENTIST_LINE = 'call the dentist back';
const KIDS_LINE = 'check the kids teach and do bucket status';

function freshCacheDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `notepad-dossier-cache-${tag}-`));
}

// == (a) THE HEADLINE — strong confidence, real branch, real goal, printed ===
{
  let calls = 0;
  const stub = async (prompt) => {
    calls++;
    assert.ok(prompt.includes('perclickity/zoom3-browse'), '(a) prompt includes the authoritative branch');
    // Deliberately cites BOTH the authoritative branch AND the superseded
    // one mentioned in the older node's conflict-note evidence text -- this
    // is legitimate historical context the model actually saw, not an
    // invention, and proves the corpus scans evidence TEXT (not just the
    // single `.branch` field) so it is correctly accepted, not rejected.
    return JSON.stringify({
      narrative:
        'This is the Zoom 3 identity browser work — an earlier attempt on perclickity/zoom3-old was superseded by perclickity/zoom3-browse, deployed via deploy_control.',
      open_question: 'Has Kevin verified the browse table against a real dirty identity yet?',
    });
  };

  const dossier = await buildTopicDossier(
    { text: PERCLICKITY_LINE },
    { runOneShot: stub, cacheDir: freshCacheDir('a') },
  );

  console.log('\n--- (a) rendered dossier ---');
  console.log(dossier.rendered);
  console.log('--- end ---\n');

  check('(a) model call happened exactly once', calls === 1);
  check('(a) topic resolved', dossier.topic !== null);
  check('(a) confidence is strong', dossier.confidence === 'strong');
  check('(a) branch is the authoritative one', dossier.branch === 'perclickity/zoom3-browse');
  check('(a) repo extracted', dossier.repo === 'darwin-assistant');
  check('(a) goal reference present', dossier.goal !== null && dossier.goal.goal_id === goal1Id);
  check('(a) at least one prior-work line', dossier.prior_work.length > 0);
  check('(a) rendered names the branch', dossier.rendered.includes('perclickity/zoom3-browse'));
  check('(a) rendered includes the model narrative', dossier.rendered.includes('deploy_control'));
  check('(a) open_question carried through', dossier.open_question === 'Has Kevin verified the browse table against a real dirty identity yet?');
  check('(a) unresolved_reason is null (model output accepted)', dossier.unresolved_reason === null);
  check('(a) never contains the banned placeholder phrase', !/kevin wants you to work on this line from his notes/i.test(dossier.rendered));
}

// == (b) THE OTHER HEADLINE — structurally empty, proven by an unused, ======
//        lavish, hallucinating stub =========================================
{
  let calls = 0;
  const lavishHallucinatingStub = async () => {
    calls++;
    return JSON.stringify({
      narrative: 'This is definitely the accounting-bridge-cron migration on branch hopper/does-not-exist, node #999999.',
      open_question: 'Should we deploy hopper/does-not-exist today?',
    });
  };

  const dossier = await buildTopicDossier(
    { text: DENTIST_LINE },
    { runOneShot: lavishHallucinatingStub, cacheDir: freshCacheDir('b') },
  );

  check('(b) the hallucinating stub was NEVER called (structural, not behavioral)', calls === 0);
  check('(b) topic is null', dossier.topic === null);
  check('(b) confidence is none', dossier.confidence === 'none');
  check('(b) repo is null', dossier.repo === null);
  check('(b) branch is null', dossier.branch === null);
  check('(b) goal is null', dossier.goal === null);
  check('(b) prior_work is empty', dossier.prior_work.length === 0);
  check('(b) open_question is null', dossier.open_question === null);
  check('(b) evidence is empty', dossier.evidence.length === 0);
  check('(b) rendered admits no context', /no context|doesn't match|does not match/i.test(dossier.rendered));
  check('(b) rendered never invents accounting-bridge-cron', !dossier.rendered.includes('accounting-bridge-cron'));
  check('(b) rendered never invents hopper/does-not-exist', !dossier.rendered.includes('hopper/does-not-exist'));
  check('(b) never contains the banned placeholder phrase', !/kevin wants you to work on this line from his notes/i.test(dossier.rendered));
}

// == (c) a stub that cites an unknown branch is REJECTED wholesale ==========
{
  const stub = async () =>
    JSON.stringify({
      narrative: 'This work landed on branch hopper/does-not-exist and is fully deployed.',
      open_question: null,
    });

  const dossier = await buildTopicDossier(
    { text: PERCLICKITY_LINE },
    { runOneShot: stub, cacheDir: freshCacheDir('c') },
  );

  check('(c) confidence still computed from evidence (strong)', dossier.confidence === 'strong');
  check('(c) branch stays the REAL authoritative one, not the invented one', dossier.branch === 'perclickity/zoom3-browse');
  check('(c) rendered never contains the invented branch', !dossier.rendered.includes('hopper/does-not-exist'));
  check('(c) rendered still names the real branch (deterministic floor held)', dossier.rendered.includes('perclickity/zoom3-browse'));
  check('(c) unresolved_reason names the rejected branch', typeof dossier.unresolved_reason === 'string' && dossier.unresolved_reason.includes('hopper/does-not-exist'));
  check('(c) open_question was NOT carried through (whole output discarded)', dossier.open_question === null);
}

// == (c2) a stub that cites an unknown repo is also rejected wholesale ======
{
  const stub = async () =>
    JSON.stringify({ narrative: 'This landed in the accounting-bridge-cron repo.', open_question: null });

  const dossier = await buildTopicDossier(
    { text: PERCLICKITY_LINE },
    { runOneShot: stub, cacheDir: freshCacheDir('c2') },
  );
  check('(c2) rejected for an unknown repo citation', typeof dossier.unresolved_reason === 'string' && dossier.unresolved_reason.includes('accounting-bridge-cron'));
  check('(c2) real repo still stands', dossier.repo === 'darwin-assistant');
}

// == (c3) a stub that cites an unknown node reference is rejected too =======
{
  const stub = async () => JSON.stringify({ narrative: 'See node #999999 for the full history.', open_question: null });

  const dossier = await buildTopicDossier(
    { text: PERCLICKITY_LINE },
    { runOneShot: stub, cacheDir: freshCacheDir('c3') },
  );
  check('(c3) rejected for an unknown node reference', typeof dossier.unresolved_reason === 'string' && dossier.unresolved_reason.includes('#999999'));
}

// == (d) a stub that times out still yields a usable deterministic dossier ===
{
  const neverResolves = () => new Promise(() => {}); // never settles
  const dossier = await buildTopicDossier(
    { text: PERCLICKITY_LINE },
    { runOneShot: neverResolves, timeoutMs: 200, cacheDir: freshCacheDir('d') },
  );
  check('(d) confidence still computed (strong)', dossier.confidence === 'strong');
  check('(d) branch still present from evidence', dossier.branch === 'perclickity/zoom3-browse');
  check('(d) rendered is usable (non-empty, names the branch)', dossier.rendered.length > 0 && dossier.rendered.includes('perclickity/zoom3-browse'));
  check('(d) unresolved_reason explains the timeout', typeof dossier.unresolved_reason === 'string' && /timed out/i.test(dossier.unresolved_reason));
}

// == (d2) a stub that returns malformed JSON still yields a usable dossier ===
{
  const stub = async () => 'this is not json at all, just prose that trails off';
  const dossier = await buildTopicDossier(
    { text: PERCLICKITY_LINE },
    { runOneShot: stub, cacheDir: freshCacheDir('d2') },
  );
  check('(d2) confidence still computed (strong)', dossier.confidence === 'strong');
  check('(d2) branch still present from evidence', dossier.branch === 'perclickity/zoom3-browse');
  check('(d2) rendered is usable', dossier.rendered.includes('perclickity/zoom3-browse'));
  check('(d2) unresolved_reason present', typeof dossier.unresolved_reason === 'string' && dossier.unresolved_reason.length > 0);
}

// == (e) the 'weak' path — topic resolves, no branch anywhere in evidence ====
{
  const stub = async () =>
    JSON.stringify({ narrative: 'Kevin is tracking the weekly kids ritual bucket.', open_question: 'Which two ideas go up this week?' });

  const dossier = await buildTopicDossier(
    { text: KIDS_LINE },
    { runOneShot: stub, cacheDir: freshCacheDir('e') },
  );

  check('(e) topic resolved', dossier.topic !== null);
  check('(e) confidence is weak', dossier.confidence === 'weak');
  check('(e) repo is null', dossier.repo === null);
  check('(e) branch is null', dossier.branch === null);
  check('(e) goal reference present (found the goal, just not a branch)', dossier.goal !== null && dossier.goal.goal_id === goal2Id);
  check('(e) rendered says what is unknown', /does not know/i.test(dossier.rendered) && /repo or branch/i.test(dossier.rendered));
  check('(e) accepted model narrative still included', dossier.rendered.includes('weekly kids ritual bucket'));
}

// == (e2) weak path, model output REJECTED — the "does not know" disclosure =
//         must still appear even without any model contribution.
{
  const stub = async () => JSON.stringify({ narrative: 'Landed on hopper/does-not-exist.', open_question: null });
  const dossier = await buildTopicDossier(
    { text: KIDS_LINE },
    { runOneShot: stub, cacheDir: freshCacheDir('e2') },
  );
  check('(e2) confidence still weak', dossier.confidence === 'weak');
  check('(e2) unresolved_reason set', typeof dossier.unresolved_reason === 'string');
  check('(e2) "does not know" disclosure present even with a rejected model call', /does not know/i.test(dossier.rendered));
  check('(e2) invented branch never leaked into rendered', !dossier.rendered.includes('hopper/does-not-exist'));
}

// == line_id path — resolves a real notepad line, not just raw text =========
{
  const day = putNotepadDay('2026-09-25', PERCLICKITY_LINE);
  const lineId = day.lines[0].id;
  const stub = async () => JSON.stringify({ narrative: 'Real line lookup path.', open_question: null });
  const dossier = await buildTopicDossier({ line_id: lineId }, { runOneShot: stub, cacheDir: freshCacheDir('lineid') });
  check('line_id path: line_id carried through', dossier.line_id === lineId);
  check('line_id path: text matches the stored line', dossier.text === PERCLICKITY_LINE);
  check('line_id path: resolves the same as the raw-text path', dossier.confidence === 'strong');
}

// == an unresolvable line_id throws, not a silent wrong answer ==============
{
  let threw = false;
  try {
    await buildTopicDossier({ line_id: 999999 }, { runOneShot: async () => '{}' });
  } catch {
    threw = true;
  }
  check('a nonexistent line_id throws rather than silently answering', threw);
}

// == zero writes: the notepad_markers / notepad_line_state tables are =======
//    untouched by anything this file does (they may not even exist yet in
//    this DB, which is itself proof nothing here created them).
{
  const markerTableExists = sqliteDb
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='notepad_markers'`)
    .get();
  check('zero writes: buildTopicDossier never created notepad_markers', markerTableExists === undefined);
}

// == (f) zero claude processes spawned across the whole run ------------------
const spawnsAfter = claudeProcessCount();
check('(f) zero claude processes spawned (before)', spawnsBefore === 0 || spawnsBefore === spawnsAfter);
check('(f) zero claude processes spawned (after count unchanged from before)', spawnsAfter === spawnsBefore);

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
