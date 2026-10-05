#!/usr/bin/env node
// COMPANION ACCEPT CHECK — acceptance test for node #1447, tree-02951798.
// Exercises acceptSidecar() (src/companion-accept.ts) against a scratch
// jarvis.db. No HTTP, no model calls. Proves:
//
//   (a) target=goal12_ghost creates a REAL ghost node under goal 12 via the
//       same proposeGoalNodes() the `goals` tool's `propose` op uses, carrying
//       'from <from_label>' provenance in its notes — queried back from the
//       goal tree, not just from acceptSidecar's return value.
//   (b) target=shim_task constructs the create_shim_task request (title,
//       personal mode, provenance) WITHOUT calling live SHIM — global.fetch
//       is monkeypatched to throw if invoked, proving no network call fires.
//   (c) both sidecar turn rows end up marked accepted (sidecar_accepted_at
//       set, sidecar_accept_target correct).
//   (d) accepting an already-accepted sidecar is rejected (409).
//
//   npm run build && JARVIS_DB_PATH=/tmp/companion-accept-check.db node scripts/companion-accept-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── scratch DB guard ─────────────────────────────────────────────────────────
const raw = process.env.JARVIS_DB_PATH;
if (!raw || !raw.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path.');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
const LIVE_DB = path.resolve(__dirname, '..', 'jarvis.db');
if (DB_PATH === LIVE_DB) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
if (!DB_PATH.startsWith('/tmp/')) {
  console.error(`FATAL: refusing a scratch path outside /tmp (${DB_PATH}).`);
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

console.log(`[companion-accept-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { getOrCreateConversation, getTurns, sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));
const { insertCrossChatSidecar } = await import(path.join(distDir, 'cross-chat-sidecar.js'));
const { acceptSidecar, AcceptError, GOAL_12_ID } = await import(path.join(distDir, 'companion-accept.js'));
const { getGoalTree } = await import(path.join(distDir, 'goals.js'));

let failed = false;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

// ── fixture: a real goal 12 + a bridged companion thread ──────────────────
const GOAL_EXT = `cockpit:goal-${GOAL_12_ID}`;
sqliteDb.prepare(`
  INSERT INTO goals (id, title, done_means, notes, status, authored_by, thread_ext)
  VALUES (?, 'Her wish catalog', 'n/a - test fixture', NULL, 'set', 'kevin', ?)
`).run(GOAL_12_ID, GOAL_EXT);
getOrCreateConversation(GOAL_EXT);

const COMPANION_EXT = 'cockpit:companion-accept-check';
getOrCreateConversation(COMPANION_EXT);

function insertSidecar(summary, fromLabel) {
  const inserted = insertCrossChatSidecar({
    from_thread_ext: COMPANION_EXT,
    to_thread_ext: GOAL_EXT,
    from_label: fromLabel,
    summary,
    origin_turn_ref: null,
  });
  if (!inserted) throw new Error('insertCrossChatSidecar returned null (recipient thread missing)');
  const goalConv = sqliteDb.prepare(`SELECT id FROM conversations WHERE external_id = ?`).get(GOAL_EXT);
  const turns = getTurns(goalConv.id);
  const turn = turns.find((t) => t.turn_index === inserted.turnIndex);
  if (!turn) throw new Error('could not find freshly-inserted sidecar turn');
  return turn.id;
}

// ── (a) goal12_ghost ────────────────────────────────────────────────────────
const fromLabelA = 'Companion (accept-check)';
const summaryA = 'Buy flowers for our anniversary next Friday';
const sidecarIdA = insertSidecar(summaryA, fromLabelA);

const resultA = acceptSidecar(sidecarIdA, 'goal12_ghost');
check('(a) acceptSidecar returns a node for goal12_ghost', !!resultA.node);
check('(a) node title matches the sidecar summary', resultA.node?.title === summaryA);
check('(a) node carries from-label provenance in notes', resultA.node?.notes === `from ${fromLabelA}`);
check('(a) node is a ghost (jarvis-authored proposal)', resultA.node?.state === 'ghost' && resultA.node?.authored_by === 'jarvis');

const treeAfterA = getGoalTree(GOAL_12_ID);
const nodeInTree = treeAfterA?.nodes.find((n) => n.id === resultA.node.id);
check('(a) the ghost node is queryable back from the real goal-12 tree', !!nodeInTree);
check('(a) the queried-back node still carries the provenance string', nodeInTree?.notes === `from ${fromLabelA}`);

// ── (b) shim_task — no live SHIM write ─────────────────────────────────────
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('UNEXPECTED live network call during shim_task accept'); };

const fromLabelB = 'Companion (accept-check)';
const summaryB = 'Look into a weekend trip to the coast';
const sidecarIdB = insertSidecar(summaryB, fromLabelB);

let resultB;
let fetchThrew = false;
try {
  resultB = acceptSidecar(sidecarIdB, 'shim_task');
} catch (err) {
  fetchThrew = true;
  console.error('  shim_task accept threw:', err);
}
globalThis.fetch = originalFetch;

check('(b) acceptSidecar did not call fetch (no live SHIM write)', !fetchThrew);
check('(b) shim_request has the sidecar summary as title', resultB?.shim_request?.title === summaryB);
check('(b) shim_request mode is personal', resultB?.shim_request?.mode === 'personal');
check('(b) shim_request carries from-label provenance', resultB?.shim_request?.description === `from ${fromLabelB}`);
check('(b) acceptSidecar result has no node (goal path untouched)', resultB?.node === undefined);

// ── (c) sidecar rows marked accepted ───────────────────────────────────────
const rowA = sqliteDb.prepare(`SELECT sidecar_accepted_at, sidecar_accept_target, sidecar_accept_result_id FROM turns WHERE id = ?`).get(sidecarIdA);
check('(c) sidecar A marked accepted', !!rowA.sidecar_accepted_at);
check('(c) sidecar A target recorded as goal12_ghost', rowA.sidecar_accept_target === 'goal12_ghost');
check('(c) sidecar A result id recorded as the node id', rowA.sidecar_accept_result_id === String(resultA.node.id));

const rowB = sqliteDb.prepare(`SELECT sidecar_accepted_at, sidecar_accept_target, sidecar_accept_result_id FROM turns WHERE id = ?`).get(sidecarIdB);
check('(c) sidecar B marked accepted', !!rowB.sidecar_accepted_at);
check('(c) sidecar B target recorded as shim_task', rowB.sidecar_accept_target === 'shim_task');
check('(c) sidecar B result id left null (nothing was actually created)', rowB.sidecar_accept_result_id === null);

// ── (d) double-accept is rejected ──────────────────────────────────────────
let doubleAcceptError = null;
try {
  acceptSidecar(sidecarIdA, 'goal12_ghost');
} catch (err) {
  doubleAcceptError = err;
}
check('(d) accepting an already-accepted sidecar throws AcceptError', doubleAcceptError instanceof AcceptError);
check('(d) double-accept error code is already_accepted', doubleAcceptError?.code === 'already_accepted');

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
