#!/usr/bin/env node
// COMPANION BRIDGE CHECK — acceptance test for node #1408 (two-way context
// bridge between linked chats, tree-a9775da1). Exercises getBridgedThreads
// against a scratch jarvis.db. No HTTP, no model calls. Proves:
//
//   (a) a fresh scratch DB + one thread_bridges row linking the wife's
//       companion thread to her goal-12 thread resolves symmetrically: the
//       companion side's getBridgedThreads returns the goal thread, and the
//       goal side's getBridgedThreads returns the companion thread.
//   (b) an unrelated thread with no bridge row returns [].
//
//   npm run build && JARVIS_DB_PATH=/tmp/companion-bridge-check.db node scripts/companion-bridge-check.mjs

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
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

console.log(`[companion-bridge-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { getBridgedThreads, sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));

let failed = false;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

const COMPANION_THREAD = 'cockpit:companion-abc123';
const GOAL_THREAD = 'cockpit:goal-12';
const UNRELATED_THREAD = 'cockpit:unrelated';

sqliteDb
  .prepare(`INSERT INTO thread_bridges (thread_a_ext, thread_b_ext) VALUES (?, ?)`)
  .run(COMPANION_THREAD, GOAL_THREAD);

// -- (a) symmetric resolution ---------------------------------------------------
const fromCompanion = getBridgedThreads(COMPANION_THREAD);
check('(a) companion side resolves to exactly one partner', fromCompanion.length === 1);
check('(a) companion side resolves to the goal thread', fromCompanion[0] === GOAL_THREAD);

const fromGoal = getBridgedThreads(GOAL_THREAD);
check('(a) goal side resolves to exactly one partner', fromGoal.length === 1);
check('(a) goal side resolves to the companion thread', fromGoal[0] === COMPANION_THREAD);

// -- (b) unrelated thread has no bridge ------------------------------------------
const fromUnrelated = getBridgedThreads(UNRELATED_THREAD);
check('(b) unrelated thread resolves to zero partners', fromUnrelated.length === 0);

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
