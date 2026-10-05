#!/usr/bin/env node
// BRIDGED CONTEXT CHECK — acceptance test for node #1413 (two-way context
// bridge digest injection, tree-a9775da1, built on top of #1408's
// thread_bridges/getBridgedThreads). Exercises buildBridgedContext against a
// scratch jarvis.db. No HTTP, no model calls (summaries are pre-seeded fresh
// so the stale-cache branch that would call runClaude never fires). Proves:
//
//   (a) SYMMETRIC: a companion thread's assembled bridged_context reflects
//       its goal-12 partner's recent turns, and the goal-12 thread's
//       assembled bridged_context reflects the companion partner's recent
//       turns — same function, driven by the bridge row either direction.
//   (b) GATED: a third, unbridged thread's bridged context is '' (no
//       bridged_context block at all — byte-identical to before this
//       feature for normal threads).
//   (c) #276 SAFETY: the companion side's bridged_context block contains
//       none of the operator-context markers (autonomy dial / hard limiter /
//       live Hub 2.0 project ref) — the digest only ever carries the
//       partner's own conversation content.
//
//   npm run build && JARVIS_DB_PATH=/tmp/bridged-context-check.db node scripts/bridged-context-check.mjs

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

console.log(`[bridged-context-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { getOrCreateConversation, addTurn, sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));
const { createThreadSummary } = await import(path.join(distDir, 'thread-summaries.js'));
const { buildBridgedContext } = await import(path.join(distDir, 'bridged-context.js'));

let failed = false;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

const COMPANION_EXT = 'cockpit:companion-xyz';
const GOAL_EXT = 'cockpit:goal-12';
const UNBRIDGED_EXT = 'cockpit:unrelated-thread';

const companionConv = getOrCreateConversation(COMPANION_EXT);
const goalConv = getOrCreateConversation(GOAL_EXT);
getOrCreateConversation(UNBRIDGED_EXT);

// Seed a few turns on each side of the bridge.
addTurn(companionConv.id, 'user', 'How do I use the wish catalog?');
const companionLastTurnId = addTurn(companionConv.id, 'assistant', 'You browse items and send a wish to Kevin.');
addTurn(goalConv.id, 'user', 'Status on the companion chat pilot?');
const goalLastTurnId = addTurn(goalConv.id, 'assistant', 'Pilot is live, wish-catalog bridge next.');

// Pre-seed a FRESH (non-stale) summary for each side so buildBridgedContext
// takes the cached-summary path and never calls generateThreadSummary/
// runClaude in this test — exactly the "stale" branch in group-chat-context.ts.
const COMPANION_SUMMARY_NEEDLE = 'wish to Kevin via the companion pilot';
const GOAL_SUMMARY_NEEDLE = 'wish-catalog bridge is the next milestone';
createThreadSummary(companionConv.id, `## Done\n- Sent a ${COMPANION_SUMMARY_NEEDLE}`, companionLastTurnId, 1);
createThreadSummary(goalConv.id, `## Planned Next\n- The ${GOAL_SUMMARY_NEEDLE}`, goalLastTurnId, 1);

sqliteDb
  .prepare(`INSERT INTO thread_bridges (thread_a_ext, thread_b_ext) VALUES (?, ?)`)
  .run(COMPANION_EXT, GOAL_EXT);

// -- (a) symmetric: each side's assembled context reflects the OTHER side's turns --
const companionBridged = await buildBridgedContext(COMPANION_EXT);
check('(a) companion side gets a bridged_context block', companionBridged.includes('<bridged_context'));
check('(a) companion side block is sourced from the goal thread', companionBridged.includes(`source="${GOAL_EXT}"`));
check('(a) companion side digest reflects the goal partner\'s recent turns', companionBridged.includes(GOAL_SUMMARY_NEEDLE));

const goalBridged = await buildBridgedContext(GOAL_EXT);
check('(a) goal side gets a bridged_context block', goalBridged.includes('<bridged_context'));
check('(a) goal side block is sourced from the companion thread', goalBridged.includes(`source="${COMPANION_EXT}"`));
check('(a) goal side digest reflects the companion partner\'s recent turns', goalBridged.includes(COMPANION_SUMMARY_NEEDLE));

// -- (b) unbridged thread gets no block at all ---------------------------------
const unbridged = await buildBridgedContext(UNBRIDGED_EXT);
check('(b) unbridged thread gets an empty string', unbridged === '');
check('(b) unbridged thread has no bridged_context tag', !unbridged.includes('<bridged_context'));

// -- (c) #276 safety: no operator-context markers leak into the companion digest --
const OPERATOR_MARKERS = ['jarvis_autonomy_dial', 'AUTONOMY_HARD_LIMITER', 'kuojrvfdjjqhqyvkuiam'];
for (const marker of OPERATOR_MARKERS) {
  check(`(c) companion bridged block does not contain '${marker}'`, !companionBridged.includes(marker));
}

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
