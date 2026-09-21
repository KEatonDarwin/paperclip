#!/usr/bin/env node
// BIG BOARD CHECK — exercises gatherBigBoardSnapshot() (the exact function
// GET /api/v1/big-board delegates to) against the REAL, LIVE jarvis.db.
//
// Every JARVIS_DB_PATH-guarded scratch-DB script elsewhere in this repo
// refuses the live path on purpose — THEIR assertions write rows, and a stray
// write against production would be destructive. This script is the
// deliberate exception: it performs zero INSERT/UPDATE/DELETE of its own
// (every store it touches is read through a `list*`/`get*` accessor, plus the
// harmless `CREATE TABLE IF NOT EXISTS` DDL each imported module runs at
// startup, which is a no-op against a DB that already has those tables) — the
// whole point of this check is to prove the aggregator reads Kevin's real
// data correctly end to end, which a scratch/empty DB can't demonstrate.
//
//   npm run build && npm run big-board:check
//   BIG_BOARD_CHECK_DB=/path/to/other.db npm run big-board:check   # override

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIVE_DB = '/home/kevin/paperclip/darwin-assistant/jarvis.db';
const DB_PATH = process.env.BIG_BOARD_CHECK_DB ?? LIVE_DB;
process.env.JARVIS_DB_PATH = DB_PATH;

console.log(`[big-board-check] DB: ${DB_PATH} (read-only aggregation — this script performs no writes)`);

const distDir = path.join(__dirname, '..', 'dist');
const { gatherBigBoardSnapshot } = await import(path.join(distDir, 'big-board.js'));
const { listAllConversations } = await import(path.join(distDir, 'conversation-db.js'));

const snapshot = gatherBigBoardSnapshot({});

let failed = false;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

// -- every top-level section from CONTRACT.md Part 1 is present -------------
const REQUIRED_KEYS = [
  'generated_at', 'monitors', 'sentinels', 'commitments', 'in_motion',
  'goal_spotlight', 'radar', 'landed', 'providers', 'governor',
];
for (const key of REQUIRED_KEYS) check(`top-level key "${key}" present`, key in snapshot);

// -- structural shape (values vary — this is live data, not a fixture) ------
check('generated_at is an ISO timestamp', typeof snapshot.generated_at === 'string' && !Number.isNaN(Date.parse(snapshot.generated_at)));
check('monitors.open is an array', Array.isArray(snapshot.monitors?.open));
check(
  'monitors.summary has numeric active/failing',
  typeof snapshot.monitors?.summary?.active === 'number' && typeof snapshot.monitors?.summary?.failing === 'number',
);
check('sentinels.sentinels is an array', Array.isArray(snapshot.sentinels?.sentinels));
check('sentinels.fresh is a boolean', typeof snapshot.sentinels?.fresh === 'boolean');
check('commitments.open is an array', Array.isArray(snapshot.commitments?.open));
check(
  'commitments.open only contains open/breached rows',
  (snapshot.commitments?.open ?? []).every((c) => c.status === 'open' || c.status === 'breached'),
);
check('in_motion.hopper_nodes is an array', Array.isArray(snapshot.in_motion?.hopper_nodes));
check('in_motion.threads is an array', Array.isArray(snapshot.in_motion?.threads));
check('in_motion.threads only contains running threads', (snapshot.in_motion?.threads ?? []).every((t) => t.running === true));
check('goal_spotlight has a nodes array', Array.isArray(snapshot.goal_spotlight?.nodes));
check('radar is an array', Array.isArray(snapshot.radar));
check('landed is an array capped at 8', Array.isArray(snapshot.landed) && snapshot.landed.length <= 8);
check(
  'landed entries carry kind/text/at',
  (snapshot.landed ?? []).every((l) => ['tree', 'commitment', 'notification'].includes(l.kind) && typeof l.text === 'string' && typeof l.at === 'string'),
);
check(
  'providers carries all 4 fields',
  !!snapshot.providers && 'claude' in snapshot.providers && 'claude_accounts' in snapshot.providers && 'openai_codex' in snapshot.providers && 'augment' in snapshot.providers,
);
check(
  'governor has allow/reason + a providers breakdown',
  typeof snapshot.governor?.allow === 'boolean' && typeof snapshot.governor?.reason === 'string' && !!snapshot.governor?.providers,
);

// -- worker/ephemeral threads must never leak into radar or in_motion.threads
const EXCLUDE_RES = [/^ephemeral:/, /^checkin:/, /^cockpit:hopper-node-/];
const combined = [...(snapshot.radar ?? []), ...(snapshot.in_motion?.threads ?? [])];
const leaks = combined.filter((t) => EXCLUDE_RES.some((re) => re.test(t.thread_id)));
check(`no ephemeral/checkin/hopper-node-worker threads in radar or in_motion.threads (checked ${combined.length})`, leaks.length === 0);
if (leaks.length) console.error('  leaked thread_ids:', leaks.map((t) => t.thread_id));

// -- review fix (node #520): password-locked + archived threads never reach the TV
const byExt = new Map(listAllConversations().map((c) => [c.external_id, c]));
const shown = combined.map((t) => byExt.get(t.thread_id)).filter(Boolean);
check(`no password-locked threads in radar or in_motion.threads (checked ${shown.length})`, shown.every((c) => !c.password_hash));
check('no archived threads in radar or in_motion.threads', shown.every((c) => c.status !== 'archived'));
check(
  'sentinels grid never collapses (fixed 5 names present even when the heartbeat is missing)',
  snapshot.sentinels.sentinels.length >= 5,
);

console.log(
  `\n[big-board-check] monitors=${snapshot.monitors.open.length} ` +
    `commitments_open=${snapshot.commitments.open.length} ` +
    `running_hopper_nodes=${snapshot.in_motion.hopper_nodes.length} ` +
    `running_threads=${snapshot.in_motion.threads.length} ` +
    `radar=${snapshot.radar.length} ` +
    `goal_spotlight=${snapshot.goal_spotlight.goal ? JSON.stringify(snapshot.goal_spotlight.goal.title) : '(no active goals)'} ` +
    `landed=${snapshot.landed.length}`,
);

if (failed) {
  console.error('\n[big-board-check] FAILED');
  process.exit(1);
}
console.log('\n[big-board-check] PASSED');
