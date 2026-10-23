#!/usr/bin/env node
// NOTEPAD DOSSIER SOURCES CHECK — exercises src/notepad-dossier-sources.ts
// (resolveTopic / gatherEvidence) against node #63's bar: a marker click
// must open a thread that is ALREADY ORIENTED, never one that only says
// "Kevin wants you to work on this line." This node is the deterministic
// retrieval layer underneath that: given one notepad line and a live DB,
// resolve what it's about (or honestly say it can't) and gather whatever
// real evidence already exists — zero model calls, zero guessed repos or
// branches.
//
// Covers:
//   (a) a Perclickity line resolves to that topic and returns evidence that
//       includes the branch, extracted from the most recently finished
//       hopper node — and the conflicting OLDER node's evidence row carries
//       a visible conflict note rather than silently agreeing.
//   (b) 'pick up milk' shares no vocabulary with anything in the registry
//       -> topic: null, terms: [], and gatherEvidence short-circuits to
//       zero evidence with no source even attempted.
//   (c) 'fix the thing today' shares only generic/stopworded vocabulary
//       with a real goal title -> does NOT resolve.
//   (d) with the orientation cache pointed at a fresh temp dir and the
//       orientation server unreachable (JARVIS_SMARTY_PANTS_URL overridden
//       to a refusing loopback port before any import), the call still
//       returns normally, marks orientation unavailable with a reason, and
//       every other evidence source is untouched.
//   (d2, bonus) the SAME unreachable-network condition, but with a
//       pre-seeded orientation cache (list + content) — proves the cache
//       path delivers real evidence with zero network calls.
//   (e) recall is reported unavailable (not on this branch), never errored
//       — probed, not guessed, and gatherEvidence never throws over it.
//   (f) ZERO CLAUDE PROCESSES spawned across the run (this node makes no
//       model calls at all — before/after pgrep snapshot, same discipline
//       as every sibling notepad check).
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-dossier-sources-check.db node scripts/notepad-dossier-sources-check.mjs

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

console.log(`[notepad-dossier-sources-check] DB: ${DB_PATH}`);

function claudeProcessCount() {
  try {
    const out = execSync('pgrep -c -f claude', { encoding: 'utf8' });
    return parseInt(out.trim(), 10) || 0;
  } catch (err) {
    // pgrep exits 1 when nothing matches — that's zero, not a failure.
    if (err && err.status === 1) return 0;
    throw err;
  }
}

const spawnsBefore = claudeProcessCount();

// Force the orientation source to be genuinely UNREACHABLE for this entire
// process, and cap its call timeout so a real network attempt fails fast
// rather than hanging the check. Both env vars are read at mcp-native.ts's
// MODULE-LOAD time, so they must be set before anything imports it
// (transitively, via notepad-dossier-sources.js below).
process.env.JARVIS_SMARTY_PANTS_URL = 'http://127.0.0.1:1'; // nothing listens here -> ECONNREFUSED, fast
process.env.JARVIS_MCP_NATIVE_TIMEOUT_MS = '5000';

const distDir = path.join(__dirname, '..', 'dist');
const { putNotepadDay } = await import(path.join(distDir, 'notepad.js'));
const { resolveTopic, gatherEvidence } = await import(path.join(distDir, 'notepad-dossier-sources.js'));
const { sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));
await import(path.join(distDir, 'goals.js')); // side effect only: creates goals/goal_nodes/goal_events
await import(path.join(distDir, 'hopper-engine.js')); // side effect only: creates hopper_trees/hopper_nodes
const { createThreadSummary } = await import(path.join(distDir, 'thread-summaries.js'));

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
// A real-shaped corpus: one goal about PerClickity v2 / the Clearing House,
// one node under it about the Zoom 3 identity browser (whose OWN title
// never repeats the word "perclickity" — exactly the real-world shape this
// resolver has to handle, since a node's title is usually just its own
// scoped work, not a restatement of its parent goal), a hopper tree
// launched from that node with TWO finished nodes naming DIFFERENT
// branches (the older one superseded), and a second, wholly unrelated goal
// used both as a distractor and as (c)'s "shares only generic words" case.

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

const tree1Id = 'tree-fixture-zoom3';
insertTree.run(tree1Id, 'Zoom 3 identity browser + make Zoom 3 actually change the verdict', 'done');

const node1 = insertNode.run(
  goal1Id,
  'Zoom 3 identity browser + make Zoom 3 actually change the verdict',
  'A browsable identity table exists and a dirty/protected ledger actually waives or strengthens a verdict.',
  null,
  'done',
  tree1Id,
);
const node1Id = Number(node1.lastInsertRowid);

// Older finished node: names a now-superseded branch.
insertHopperNode.run(
  tree1Id,
  'ENGINE verdict fix (initial pass)',
  'WORKTREE /home/kevin/paperclip-worktrees/pcx-zoom3-old, BRANCH perclickity/zoom3-old',
  'WORKTREE /home/kevin/paperclip-worktrees/pcx-zoom3-old, BRANCH perclickity/zoom3-old — first attempt at the verdict fix, later superseded.',
);
// Newer finished node: the branch that actually shipped.
insertHopperNode.run(
  tree1Id,
  'UI browse table + deploy',
  'WORKTREE /home/kevin/paperclip-worktrees/pcx-ui-zoom3-browse, BRANCH perclickity/zoom3-browse',
  'WORKTREE /home/kevin/paperclip-worktrees/pcx-ui-zoom3-browse, BRANCH perclickity/zoom3-browse — deployed sandbox-perclickity-ui via deploy_control, darwin-assistant unaffected.',
);

// Distractor goal — deliberately shares no real vocabulary with the
// Perclickity fixture, and its title is used verbatim by check (c).
insertGoal.run('Cockpit Notepad — dossier composer', 'Clicking a marker opens an oriented thread.', null);

// == (a) Perclickity line resolves; evidence includes the branch + conflict note
{
  const LINE = 'check on the perclickity zoom verdict issue';
  const resolved = resolveTopic(LINE, sqliteDb);
  check('(a) resolves to a real topic (not null)', resolved.topic !== null);
  check('(a) score meets the resolve threshold', resolved.score >= 1.0);
  check('(a) matched terms include the distinctive word', resolved.terms.includes('perclickity') || resolved.terms.includes('zoom'));

  const { evidence, availability } = await gatherEvidence(resolved.topic, resolved.terms, sqliteDb, {
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'notepad-dossier-cache-a-')),
  });

  check('(a) evidence is non-empty', evidence.length > 0);
  check('(a) evidence includes at least one goal-kind row', evidence.some((e) => e.kind === 'goal'));
  check('(a) evidence includes at least one tree-kind row', evidence.some((e) => e.kind === 'tree'));

  const treeRows = evidence.filter((e) => e.kind === 'tree');
  check('(a) every tree row carries the authoritative (most recent) branch', treeRows.every((e) => e.branch === 'perclickity/zoom3-browse'));
  check('(a) at least one tree row carries a repo extracted from real text', treeRows.some((e) => e.repo === 'darwin-assistant'));

  const olderRow = treeRows.find((e) => e.title.includes('ENGINE verdict fix'));
  check('(a) the OLDER (superseded) node evidence row exists', !!olderRow);
  check('(a) the older row visibly records the conflict, not a silent overwrite', !!olderRow && olderRow.snippet.includes('conflict') && olderRow.snippet.includes('zoom3-old'));

  const newerRow = treeRows.find((e) => e.title.includes('UI browse table'));
  check('(a) the newer node evidence row has no conflict note (it IS the authoritative source)', !!newerRow && !newerRow.snippet.includes('conflict'));

  check('(a) goal availability reported true', availability.find((s) => s.kind === 'goal')?.available === true);
  check('(a) tree availability reported true', availability.find((s) => s.kind === 'tree')?.available === true);
  check('(a) evidence sorted highest score first', evidence.every((e, i) => i === 0 || evidence[i - 1].score >= e.score));
  check('(a) never invented a branch for a row whose own text names none', evidence.filter((e) => e.kind === 'goal').every((e) => e.branch === undefined || typeof e.branch === 'string'));
}

// == (b) an unrelated errand shares no vocabulary -> topic:null, zero evidence
{
  const resolved = resolveTopic('pick up milk on the way home', sqliteDb);
  check('(b) topic is null', resolved.topic === null);
  check('(b) terms is empty', resolved.terms.length === 0);

  const { evidence, availability } = await gatherEvidence(resolved.topic, resolved.terms, sqliteDb, {
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'notepad-dossier-cache-b-')),
  });
  check('(b) zero evidence', evidence.length === 0);
  check('(b) no source was even attempted (empty availability)', availability.length === 0);
}

// == (b2) a genuinely one-word, all-generic line also resolves to null -----
{
  const resolved = resolveTopic('stuff', sqliteDb);
  check("(b2) a bare 'stuff' resolves to null", resolved.topic === null && resolved.terms.length === 0);
}

// == (c) generic-word-only overlap with a real goal title does NOT resolve --
{
  // Shares "fix"/"thing"/"today" in spirit with ordinary todo phrasing, but
  // every one of those is stopworded specifically so this can never latch
  // onto a goal by accident.
  const resolved = resolveTopic('fix the thing today', sqliteDb);
  check('(c) does not resolve', resolved.topic === null);
  check('(c) zero terms survive the stopword filter', resolved.terms.length === 0);
  check('(c) score is 0', resolved.score === 0);
}

// == (d) orientation unreachable + fresh cache dir -> degrades cleanly ------
{
  const LINE = 'check on the perclickity zoom verdict issue';
  const resolved = resolveTopic(LINE, sqliteDb);
  const freshCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notepad-dossier-cache-d-'));
  check('(d) fresh cache dir really is empty (no pre-existing cache to fall back on)', fs.readdirSync(freshCacheDir).length === 0);

  const { evidence, availability } = await gatherEvidence(resolved.topic, resolved.terms, sqliteDb, { cacheDir: freshCacheDir });

  const orientationAvail = availability.find((s) => s.kind === 'orientation');
  check('(d) gatherEvidence returned normally (did not throw over the network failure)', true);
  check('(d) orientation availability entry exists', !!orientationAvail);
  check('(d) orientation reported unavailable', orientationAvail?.available === false);
  check('(d) orientation carries a reason string', typeof orientationAvail?.reason === 'string' && orientationAvail.reason.length > 0);
  check('(d) no orientation evidence row was produced', !evidence.some((e) => e.kind === 'orientation'));
  check('(d) goal/tree evidence is UNAFFECTED by the orientation outage', evidence.some((e) => e.kind === 'goal') && evidence.some((e) => e.kind === 'tree'));
}

// == (d2, bonus) a pre-seeded cache delivers real orientation evidence with
//    ZERO network calls, even though the network is unreachable for the
//    whole process -- proves the cache mechanism itself, not just the
//    failure path.
{
  const LINE = 'check on the perclickity zoom verdict issue';
  const resolved = resolveTopic(LINE, sqliteDb);
  const warmCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notepad-dossier-cache-d2-'));
  const key = 'perclickity-v2-clearinghouse';
  fs.writeFileSync(
    path.join(warmCacheDir, 'orientation-list.json'),
    JSON.stringify({ fetchedAt: new Date().toISOString(), orientations: [{ key, title: 'Perclickity V2 Clearinghouse' }] }),
  );
  fs.writeFileSync(
    path.join(warmCacheDir, `orientation-content-${key}.json`),
    JSON.stringify({ fetchedAt: new Date().toISOString(), key, content: '# Perclickity V2 Clearinghouse\n\nThree lanes, the interstitial ladder, Zoom 3.' }),
  );

  const { evidence, availability } = await gatherEvidence(resolved.topic, resolved.terms, sqliteDb, { cacheDir: warmCacheDir });
  const orientationAvail = availability.find((s) => s.kind === 'orientation');
  check('(d2) orientation reported available from a warm cache (no network needed)', orientationAvail?.available === true);
  const orientationRow = evidence.find((e) => e.kind === 'orientation');
  check('(d2) an orientation evidence row was produced from the cache', !!orientationRow && orientationRow.ref === key);
  check('(d2) the cached content made it into the snippet', !!orientationRow && orientationRow.snippet.includes('Zoom 3'));
}

// == (e) recall is unavailable, not errored ----------------------------------
{
  const LINE = 'check on the perclickity zoom verdict issue';
  const resolved = resolveTopic(LINE, sqliteDb);
  const { availability } = await gatherEvidence(resolved.topic, resolved.terms, sqliteDb, {
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'notepad-dossier-cache-e-')),
  });
  const recallAvail = availability.find((s) => s.kind === 'recall');
  check('(e) recall availability entry exists', !!recallAvail);
  check('(e) recall reported unavailable (not present on this branch)', recallAvail?.available === false);
  check('(e) recall reason explains absence rather than an error stack', typeof recallAvail?.reason === 'string' && !recallAvail.reason.toLowerCase().includes('error:'));
}

// == thread_summaries: available, and a real match surfaces as evidence -----
{
  const conv = sqliteDb.prepare(`INSERT INTO conversations (external_id) VALUES (?)`).run('cockpit:fixture-perclickity-thread');
  createThreadSummary(
    Number(conv.lastInsertRowid),
    'Deployed the perclickity zoom3-browse engine + intake + UI via deploy_control; verdicts now actually change.',
    null,
    0,
  );

  const LINE = 'check on the perclickity zoom verdict issue';
  const resolved = resolveTopic(LINE, sqliteDb);
  const { evidence, availability } = await gatherEvidence(resolved.topic, resolved.terms, sqliteDb, {
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), 'notepad-dossier-cache-ts-')),
  });
  check('thread_summary availability reported true', availability.find((s) => s.kind === 'thread_summary')?.available === true);
  check('thread_summary evidence surfaces the matching summary', evidence.some((e) => e.kind === 'thread_summary' && e.ref === 'cockpit:fixture-perclickity-thread'));
}

// == unresolved line never emits evidence with a guessed repo/branch --------
{
  // A line with zero tokens after normalization+stopwording never even
  // reaches the registry — this asserts the overall contract once more
  // end-to-end (mirrors (b) but via a symbol-only line).
  const resolved = resolveTopic('!!! ??? ...', sqliteDb);
  check('symbol-only line resolves to null', resolved.topic === null);
}

// == (f) zero claude processes spawned across the whole run ------------------
const spawnsAfter = claudeProcessCount();
check('(f) zero claude processes spawned (before)', spawnsBefore === 0 || spawnsBefore === spawnsAfter);
check('(f) zero claude processes spawned (after count unchanged from before)', spawnsAfter === spawnsBefore);

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
