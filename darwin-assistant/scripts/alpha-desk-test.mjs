// ALPHA DESK — hermetic checks for the desk roll-up (src/alpha-desk.ts).
//
// Runs against a THROWAWAY sqlite db (JARVIS_DB_PATH, deleted and rebuilt each run)
// and a throwaway vault root. Never touches live jarvis.db or the real wiki.
//
// Fixture schema is NOT invented: chat_spawns and watch_commitments are created from
// the DDL read out of the live database's own sqlite_master (read-only), because a
// hand-written fixture schema only ever proves the fixture is self-consistent.
//
//   node scripts/alpha-desk-test.mjs
//
// Expects `npm run build` first (it imports dist/).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const LIVE_DB = process.env.ALPHA_DESK_LIVE_DB ?? '/home/kevin/paperclip/darwin-assistant/jarvis.db';
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-desk-test-'));
const scratchDb = path.join(scratchDir, 'scratch.db');
const vaultRoot = path.join(scratchDir, 'vault');
const deskDir = path.join(vaultRoot, 'agent-memory/jarvis-alpha/desk');
fs.mkdirSync(deskDir, { recursive: true });

process.env.JARVIS_DB_PATH = scratchDb;
process.env.ALPHA_DESK_VAULT_ROOT = vaultRoot;
process.env.JARVIS_SIM = '1';

let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; return; }
  failures.push(detail ? `${name} — ${detail}` : name);
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ─── Borrow the real DDL for the two tables conversation-db does not create ──
const liveDdl = (() => {
  const live = new Database(LIVE_DB, { readonly: true, fileMustExist: true });
  const out = {};
  for (const name of ['chat_spawns', 'watch_commitments']) {
    const row = live.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(name);
    if (!row?.sql) throw new Error(`live db has no ${name} table — cannot build an honest fixture`);
    out[name] = row.sql;
  }
  live.close();
  return out;
})();

// Importing conversation-db creates the real conversations/turns schema in the scratch db.
const { sqliteDb, getOrCreateConversation } = await import('../dist/conversation-db.js');
const { buildAlphaDesk, readVerdicts } = await import('../dist/alpha-desk.js');

sqliteDb.exec(liveDdl.chat_spawns);
sqliteDb.exec(liveDdl.watch_commitments);

// ─── Fixtures ────────────────────────────────────────────────────────────────
const origin = getOrCreateConversation('cockpit:jarvis-alpha');
const other = getOrCreateConversation('cockpit:some-other-orchestrator');

const insertSpawn = sqliteDb.prepare(
  `INSERT INTO chat_spawns (origin_conversation_id, child_conversation_id, created_at, reported_at)
   VALUES (?, ?, ?, ?)`,
);
const insertTurn = sqliteDb.prepare(
  `INSERT INTO turns (conversation_id, turn_index, role, content, tool_name, tool_args, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
const insertCommitment = sqliteDb.prepare(
  `INSERT INTO watch_commitments (subject, thread_ext, check_type, check_ref, due_at, status)
   VALUES (?, ?, 'chat_report', ?, ?, ?)`,
);

const past = new Date(Date.now() - 6 * 3600_000).toISOString();
const future = new Date(Date.now() + 6 * 3600_000).toISOString();
const todayUtc = new Date().toISOString().slice(0, 19).replace('T', ' ');

function child(ext, title) {
  const conv = getOrCreateConversation(ext);
  sqliteDb.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(title, conv.id);
  return conv;
}

// 1. reported, with a brief, a report_back marker and a final reply
const reported = child('cockpit:spawn-reported', 'Reported child');
insertSpawn.run(origin.id, reported.id, '2026-10-15 10:00:00', todayUtc);
insertTurn.run(reported.id, 0, 'user', 'THE BRIEF for the reported child', null, null, '2026-10-15 10:00:00');
insertTurn.run(reported.id, 1, 'assistant', 'an earlier, non-final reply', null, null, '2026-10-15 10:01:00');
insertTurn.run(reported.id, 2, 'tool_call', null, 'report_back', JSON.stringify({ summary: 'IT WORKED.' }), '2026-10-15 10:05:00');
insertTurn.run(reported.id, 3, 'assistant', 'THE FINAL REPLY', null, null, '2026-10-15 10:06:00');
// A SECOND user turn (Alpha following up in the child). Without this the brief
// assertion cannot tell "first user turn" from "last user turn" - the mutation run
// caught exactly that hole.
insertTurn.run(reported.id, 4, 'user', 'a LATER follow-up message, not the brief', null, null, '2026-10-15 10:07:00');
insertCommitment.run('s', 'cockpit:jarvis-alpha', 'cockpit:spawn-reported', past, 'satisfied');

// 2. overdue: past due, no report
const overdue = child('cockpit:spawn-overdue', 'Overdue child');
insertSpawn.run(origin.id, overdue.id, '2026-10-15 09:00:00', null);
insertTurn.run(overdue.id, 0, 'user', 'brief for overdue', null, null, '2026-10-15 09:00:00');
insertCommitment.run('s', 'cockpit:jarvis-alpha', 'cockpit:spawn-overdue', past, 'open');

// 3. quiet: due in the future, no report, not running
const quiet = child('cockpit:spawn-quiet', 'Quiet child');
insertSpawn.run(origin.id, quiet.id, '2026-10-15 11:00:00', null);
insertCommitment.run('s', 'cockpit:jarvis-alpha', 'cockpit:spawn-quiet', future, 'open');

// 4. running: past due AND unreported, but a turn is in flight — running wins
const running = child('cockpit:spawn-running', 'Running child');
insertSpawn.run(origin.id, running.id, '2026-10-15 12:00:00', null);
insertCommitment.run('s', 'cockpit:jarvis-alpha', 'cockpit:spawn-running', past, 'open');

// 5. no commitment row at all (report_back=false) and no report → quiet, null due_at
const nocommit = child('cockpit:spawn-nocommit', 'No commitment');
insertSpawn.run(origin.id, nocommit.id, '2026-10-15 12:30:00', null);

// 6. belongs to a DIFFERENT orchestrator — must never appear on Alpha's desk
const foreign = child('cockpit:spawn-foreign', 'Someone else');
insertSpawn.run(other.id, foreign.id, '2026-10-15 12:45:00', null);

// ─── Verdict file ────────────────────────────────────────────────────────────
const verdictsPath = path.join(deskDir, 'verdicts.json');
fs.writeFileSync(verdictsPath, JSON.stringify({
  'cockpit:spawn-reported': { verdict: 'accepted', note: 'Good.', next_step: 'Kevin picks.', updated_at: '2026-10-15T10:10:00-05:00' },
  'cockpit:spawn-overdue': { verdict: 'NONSENSE', note: 'x', next_step: 'y', updated_at: 'z' },
  'cockpit:spawn-quiet': 'not even an object',
}, null, 2));

const isRunning = (id) => id === running.id;

// ─── Assertions ──────────────────────────────────────────────────────────────
const desk = buildAlphaDesk('cockpit:jarvis-alpha', isRunning);
const byExt = Object.fromEntries(desk.rows.map((r) => [r.external_id, r]));

eq('only this orchestrator\'s children are listed', desk.rows.length, 5);
check('a foreign orchestrator\'s child is excluded', !byExt['cockpit:spawn-foreign']);
eq('newest spawn first', desk.rows[0].external_id, 'cockpit:spawn-nocommit');

eq('state: reported', byExt['cockpit:spawn-reported'].state, 'reported');
eq('state: overdue', byExt['cockpit:spawn-overdue'].state, 'overdue');
eq('state: quiet', byExt['cockpit:spawn-quiet'].state, 'quiet');
eq('state: running beats overdue', byExt['cockpit:spawn-running'].state, 'running');
eq('state: no commitment and no report is quiet, never overdue', byExt['cockpit:spawn-nocommit'].state, 'quiet');
eq('no commitment leaves due_at null', byExt['cockpit:spawn-nocommit'].due_at, null);

eq('brief is the FIRST user turn', byExt['cockpit:spawn-reported'].brief, 'THE BRIEF for the reported child');
eq('report summary comes out of tool_args', byExt['cockpit:spawn-reported'].report_summary, 'IT WORKED.');
eq('final reply is the LAST assistant turn', byExt['cockpit:spawn-reported'].final_reply, 'THE FINAL REPLY');
eq('missing report reads null', byExt['cockpit:spawn-overdue'].report_summary, null);
eq('missing brief reads null', byExt['cockpit:spawn-quiet'].brief, null);
eq('turn_count counts the child\'s turns', byExt['cockpit:spawn-reported'].turn_count, 5);

eq('verdict is read from the file', byExt['cockpit:spawn-reported'].verdict.verdict, 'accepted');
eq('verdict note survives', byExt['cockpit:spawn-reported'].verdict.note, 'Good.');
eq('an unrecognised verdict degrades to pending', byExt['cockpit:spawn-overdue'].verdict.verdict, 'pending');
eq('a non-object entry degrades to pending', byExt['cockpit:spawn-quiet'].verdict.verdict, 'pending');
eq('a child absent from the file is pending', byExt['cockpit:spawn-nocommit'].verdict.verdict, 'pending');
eq('a healthy verdict file reports no error', desk.verdicts_error, null);

eq('counts.total', desk.counts.total, 5);
eq('counts.open excludes only the reported one', desk.counts.open, 4);
eq('counts.running', desk.counts.running, 1);
eq('counts.overdue', desk.counts.overdue, 1);
eq('counts.reported_today', desk.counts.reported_today, 1);

// reported_today must not count a report from another day
sqliteDb.prepare(`UPDATE chat_spawns SET reported_at = '2026-10-01 10:00:00' WHERE child_conversation_id = ?`).run(reported.id);
eq('counts.reported_today ignores older reports', buildAlphaDesk('cockpit:jarvis-alpha', isRunning).counts.reported_today, 0);
sqliteDb.prepare(`UPDATE chat_spawns SET reported_at = ? WHERE child_conversation_id = ?`).run(todayUtc, reported.id);

// reported_at missing but the marker turn exists → still reported
sqliteDb.prepare(`UPDATE chat_spawns SET reported_at = NULL WHERE child_conversation_id = ?`).run(reported.id);
const noStamp = buildAlphaDesk('cockpit:jarvis-alpha', isRunning).rows.find((r) => r.external_id === 'cockpit:spawn-reported');
eq('an unstamped report still reads as reported (marker turn fallback)', noStamp.state, 'reported');
sqliteDb.prepare(`UPDATE chat_spawns SET reported_at = ? WHERE child_conversation_id = ?`).run(todayUtc, reported.id);

// default isRunning: nothing claims to be running
eq('the default in-flight check never claims running', buildAlphaDesk('cockpit:jarvis-alpha').counts.running, 0);

// unknown orchestrator → empty, never a throw
const empty = buildAlphaDesk('cockpit:does-not-exist', isRunning);
eq('unknown orchestrator yields no rows', empty.rows.length, 0);
eq('unknown orchestrator reports a null conversation_id', empty.origin.conversation_id, null);

// broken verdict files
fs.writeFileSync(verdictsPath, '{ this is not json');
const broken = buildAlphaDesk('cockpit:jarvis-alpha', isRunning);
check('invalid JSON is surfaced, not swallowed', !!broken.verdicts_error, `error was ${broken.verdicts_error}`);
eq('invalid JSON still renders every child as pending', broken.rows.every((r) => r.verdict.verdict === 'pending'), true);
eq('invalid JSON does not lose the rows', broken.rows.length, 5);

fs.writeFileSync(verdictsPath, '["an array is not a map"]');
check('an array verdict file is rejected', !!buildAlphaDesk('cockpit:jarvis-alpha', isRunning).verdicts_error);

fs.rmSync(verdictsPath);
const missing = buildAlphaDesk('cockpit:jarvis-alpha', isRunning);
check('a missing verdict file is surfaced', !!missing.verdicts_error);
eq('a missing verdict file still renders the rows', missing.rows.length, 5);
eq('readVerdicts reports empty on a missing file', Object.keys(readVerdicts().verdicts).length, 0);

// ─── Result ──────────────────────────────────────────────────────────────────
fs.rmSync(scratchDir, { recursive: true, force: true });
console.log(`alpha-desk: ${pass}/${pass + failures.length} checks passed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
