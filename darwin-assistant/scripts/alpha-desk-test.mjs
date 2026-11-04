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
const { buildAlphaDesk, readVerdicts, ctDay, descendantConversations, DESK_TIMEZONE } =
  await import('../dist/alpha-desk.js');
const pricing = await import('../dist/alpha-desk-pricing.js');

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
// Tokens live on ASSISTANT turns only (one row per model round-trip), which is
// how the live engine records them - verified by reading the live table.
const insertUsage = sqliteDb.prepare(
  `INSERT INTO turns (conversation_id, turn_index, role, content, model,
                      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at)
   VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?)`,
);
const dbTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

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

// ─── Token fixtures ──────────────────────────────────────────────────────────
// Alpha's OWN chat: one opus-5-5 round-trip.
//   input      500 x $4.00 /1e6 = $0.002
//   output   1,000 x $20.00/1e6 = $0.020
//   cacheRd  2.0M x $0.20 /1e6 = $0.400
//   cacheWr 50,000 x $5.00 /1e6 = $0.250   (1h rate $8.00 -> $0.400)
//   => usd $0.672   usd_max $0.822
const ALPHA_USD = 0.672;
const ALPHA_USD_MAX = 0.822;
insertUsage.run(origin.id, 0, 'alpha thinking', 'claude-opus-5-5', 500, 1000, 2_000_000, 50_000, dbTime(Date.now() - 20 * 60_000));

// The reported child: one opus-5 round-trip.
//   input    1,000 x $5.00 /1e6 = $0.005
//   output   2,000 x $25.00/1e6 = $0.050
//   cacheRd  4.0M  x $0.50 /1e6 = $2.000
//   cacheWr 100,000 x $6.25/1e6 = $0.625   (1h rate $10.00 -> $1.000)
//   => usd $2.680   usd_max $3.055
const CHILD_USD = 2.68;
const CHILD_USD_MAX = 3.055;
// Stamped onto the EXISTING final-reply turn, because that is where the live
// engine records usage: one row per model round-trip, on the assistant turn that
// ends it. Inserting a new row instead would invent a turn this child never took.
sqliteDb.prepare(
  `UPDATE turns SET model = ?, input_tokens = ?, output_tokens = ?,
                    cache_read_tokens = ?, cache_write_tokens = ?
     WHERE conversation_id = ? AND content = 'THE FINAL REPLY'`,
).run('claude-opus-5', 1000, 2000, 4_000_000, 100_000, reported.id);

// A model the price table does not know: its tokens must be counted and flagged,
// never silently priced at $0.
insertUsage.run(overdue.id, 1, 'on an unknown model', 'claude-zebra-9', 10, 20, 30, 40, dbTime(Date.now() - 40 * 60_000));

// A GRANDCHILD: a chat spawned BY a child. Still Alpha's cost, so the meter must
// follow it - but it is not a direct delegation, so it must NOT become a board row.
const grandchild = child('cockpit:spawn-grandchild', 'Grandchild of Alpha');
insertSpawn.run(reported.id, grandchild.id, dbTime(Date.now() - 25 * 60_000), null);
insertUsage.run(grandchild.id, 0, 'grandchild working', 'claude-opus-5', 1000, 2000, 4_000_000, 100_000, dbTime(Date.now() - 25 * 60_000));

// Spawned 10 minutes ago -> inside the rolling hour. Relative on purpose.
const fresh = child('cockpit:spawn-fresh', 'Opened ten minutes ago');
insertSpawn.run(origin.id, fresh.id, dbTime(Date.now() - 10 * 60_000), null);

// Spawned 3 hours ago -> outside the rolling hour, same calendar day.
const stale = child('cockpit:spawn-stale', 'Opened three hours ago');
insertSpawn.run(origin.id, stale.id, dbTime(Date.now() - 3 * 3600_000), null);

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

eq('only this orchestrator\'s children are listed', desk.rows.length, 7);
check('a foreign orchestrator\'s child is excluded', !byExt['cockpit:spawn-foreign']);
eq('newest spawn first', desk.rows[0].external_id, 'cockpit:spawn-stale');

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

eq('counts.total', desk.counts.total, 7);
eq('counts.open excludes only the reported one', desk.counts.open, 6);
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


// ─── Tokens, cost and the last hour ──────────────────────────────────────────

// -- the price table itself, against the model-id shapes the LIVE db contains --
eq('priceSlug strips the claude- prefix', pricing.priceSlug('claude-opus-5-5'), 'opus-5-5');
eq('priceSlug strips the [1m] long-context flag (1M context is standard priced)',
   pricing.priceSlug('claude-opus-5[1m]'), 'opus-5');
eq('priceSlug strips a dated snapshot id', pricing.priceSlug('claude-haiku-4-5-20251001'), 'haiku-4-5');
eq('priceSlug on null is null', pricing.priceSlug(null), null);
eq('priceSlug on empty is null', pricing.priceSlug('   '), null);
check('every model id present in the live db is priced',
  ['claude-fable-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5',
   'claude-opus-4-7', 'claude-opus-4-7[1m]', 'claude-opus-4-8', 'claude-opus-4-8[1m]',
   'claude-opus-5', 'claude-opus-5-5', 'claude-opus-5[1m]',
   'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-sonnet-5-5']
    .every((m) => pricing.costOf(m, { input_tokens: 1, output_tokens: 1, cache_read_tokens: 1, cache_write_tokens: 1 }) !== null),
  'a live model id is missing from MODEL_PRICES');
eq('an unknown model is unpriced, not free',
   pricing.costOf('claude-zebra-9', { input_tokens: 1, output_tokens: 1, cache_read_tokens: 1, cache_write_tokens: 1 }), null);

// the [1m] variant must price IDENTICALLY to its base model, not merely be known
{
  const t = { input_tokens: 1000, output_tokens: 1000, cache_read_tokens: 1000, cache_write_tokens: 1000 };
  eq('claude-opus-5[1m] costs exactly what claude-opus-5 costs',
     pricing.costOf('claude-opus-5[1m]', t).usd, pricing.costOf('claude-opus-5', t).usd);
}

// Haiku 5.5 is the one model priced BY PROMPT LENGTH, per request, counting cache
// reads toward the prompt. Hand-computed from the published rates:
//   short tier: in $0.10 out $0.50 read $0.01 /MTok
//     1,000 x 0.10/1e6 + 100 x 0.50/1e6 + 1,000 x 0.01/1e6 = 0.0001 + 0.00005 + 0.00001
{
  const short = pricing.costOf('claude-haiku-5-5', { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 1000, cache_write_tokens: 0 });
  check('haiku-5-5 under 100k uses the short tier', Math.abs(short.usd - 0.00016) < 1e-9, `got ${short.usd}`);
//   long tier: in $0.50 out $2.50 read $0.05 /MTok, prompt = 1,000 + 200,000 > 100,000
//     1,000 x 0.50/1e6 + 100 x 2.50/1e6 + 200,000 x 0.05/1e6 = 0.0005 + 0.00025 + 0.01
  const long = pricing.costOf('claude-haiku-5-5', { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 200_000, cache_write_tokens: 0 });
  check('haiku-5-5 over 100k uses the long tier', Math.abs(long.usd - 0.01075) < 1e-9, `got ${long.usd}`);
  check('the tier counts CACHE READS toward the prompt (the page says so)', long.usd > short.usd * 50, `${long.usd} vs ${short.usd}`);
}

// cache reads must NOT be priced as input - the whole point of the meter
{
  const t = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 1_000_000, cache_write_tokens: 0 };
  eq('1M opus-5 cache reads price at the cache-read rate ($0.50), not input ($5)',
     pricing.costOf('claude-opus-5', t).usd, 0.5);
}

// -- the roll-up --
const r = byExt['cockpit:spawn-reported'];
eq('a row carries its own measured token total', r.tokens.total, 1000 + 2000 + 4_000_000 + 100_000);
check('a row cost matches the hand-computed figure', Math.abs(r.tokens.cost_usd - CHILD_USD) < 1e-9, `got ${r.tokens.cost_usd}`);
check('a row 1h-cache ceiling matches the hand-computed figure', Math.abs(r.tokens.cost_usd_max - CHILD_USD_MAX) < 1e-9, `got ${r.tokens.cost_usd_max}`);
eq('tokens.turns counts MODEL REPLIES, not table rows', r.tokens.turns, 1);
check('turn_count and tokens.turns are different things', r.turn_count > r.tokens.turns, `${r.turn_count} vs ${r.tokens.turns}`);

const unp = byExt['cockpit:spawn-overdue'];
eq('an unpriced model yields a null cost, never 0', unp.tokens.cost_usd, null);
eq('an unpriced model still has its tokens counted', unp.tokens.unpriced_tokens, 10 + 20 + 30 + 40);
eq('an unpriced model is NAMED so the gap is visible', unp.tokens.unpriced_models.join(','), 'claude-zebra-9');

eq('a child with no model turns reads zero, not null', byExt['cockpit:spawn-quiet'].tokens.total, 0);
eq('a zero-token child has no cost rather than $0', byExt['cockpit:spawn-quiet'].tokens.cost_usd, null);

// -- alpha vs spawned --
check('alpha-itself cost matches the hand-computed figure',
  Math.abs(desk.tokens.all_time.alpha.cost_usd - ALPHA_USD) < 1e-9, `got ${desk.tokens.all_time.alpha.cost_usd}`);
check('alpha-itself 1h ceiling matches the hand-computed figure',
  Math.abs(desk.tokens.all_time.alpha.cost_usd_max - ALPHA_USD_MAX) < 1e-9, `got ${desk.tokens.all_time.alpha.cost_usd_max}`);
// 1,000 (child) + 1,000 (grandchild) + 10 (the unpriced-model row) = 2,010.
// Alpha's own 500 input tokens are absent, which is the point of the assertion.
eq('the origin chat is NOT counted as spawned', desk.tokens.all_time.spawned.input, 2010);
eq('combined = alpha + spawned, exactly',
   desk.tokens.all_time.combined.total,
   desk.tokens.all_time.alpha.total + desk.tokens.all_time.spawned.total);
check('combined cost = alpha + spawned cost',
  Math.abs(desk.tokens.all_time.combined.cost_usd - (ALPHA_USD + CHILD_USD * 2)) < 1e-9,
  `got ${desk.tokens.all_time.combined.cost_usd}`);

// -- the grandchild: counted by the meter, absent from the board --
eq('a grandchild is followed by the meter', descendantConversations(origin.id).length, 8);
check('a grandchild is NOT a board row', !byExt['cockpit:spawn-grandchild']);
check('the grandchild chat\'s tokens are inside the spawned total',
  desk.tokens.all_time.spawned.total === (1000 + 2000 + 4_000_000 + 100_000) * 2 + 100,
  `spawned total ${desk.tokens.all_time.spawned.total}`);
eq('descendant walk terminates and never returns the root', descendantConversations(origin.id).includes(origin.id), false);

// -- per-model breakdown --
{
  const m = Object.fromEntries(desk.tokens.by_model.map((x) => [x.model, x]));
  eq('by_model keeps models apart', m['claude-opus-5'].turns, 2);
  eq('by_model includes alpha\'s own model', m['claude-opus-5-5'].turns, 1);
  eq('by_model reports a null cost for an unpriced model', m['claude-zebra-9'].cost_usd, null);
  eq('by_model is sorted biggest-first', desk.tokens.by_model[0].model, 'claude-opus-5');
}

// -- the rolling last hour --
eq('last_hour counts chats opened in the last 60 minutes', desk.counts.last_hour, 1);
eq('the last-hour list matches the count', desk.last_hour_spawns.length, desk.counts.last_hour);
eq('the last-hour list is the chat opened 10 minutes ago', desk.last_hour_spawns[0].external_id, 'cockpit:spawn-fresh');
check('a chat opened 3 hours ago is NOT in the last hour',
  !desk.last_hour_spawns.some((x) => x.external_id === 'cockpit:spawn-stale'));
check('every last-hour entry carries a state for the pill',
  desk.last_hour_spawns.every((x) => ['running', 'reported', 'overdue', 'quiet'].includes(x.state)));
check('last-hour token window is a subset of all time',
  desk.tokens.last_hour.combined.total <= desk.tokens.all_time.combined.total);

// -- the day boundary is KEVIN'S day, not UTC --
eq('the desk states the timezone it means by today', desk.tokens.today_timezone, 'America/Chicago');
eq('DESK_TIMEZONE is America/Chicago', DESK_TIMEZONE, 'America/Chicago');
// 2026-01-15 03:00 UTC is still 2026-01-14 in Chicago. A UTC day would say the 15th.
eq('03:00 UTC is still yesterday in Chicago', ctDay(Date.parse('2026-01-15T03:00:00Z')), '2026-01-14');
eq('18:00 UTC is the same day in Chicago', ctDay(Date.parse('2026-01-15T18:00:00Z')), '2026-01-15');
// and the summer offset differs - proving Intl is doing DST, not a fixed -6
eq('DST is handled: 04:00 UTC in July is still yesterday in Chicago', ctDay(Date.parse('2026-07-15T04:00:00Z')), '2026-07-14');
eq('DST is handled: 05:00 UTC in July is already today in Chicago', ctDay(Date.parse('2026-07-15T05:00:00Z')), '2026-07-15');

// -- the price basis is stated, not implied --
check('the payload says where the prices came from', desk.tokens.price_source.includes('claude.com'));
check('the payload dates the prices', /^\d{4}-\d{2}-\d{2}$/.test(desk.tokens.price_as_of));
check('the payload says out loud that this is not a bill', /subscription/i.test(desk.tokens.basis));

// broken verdict files
fs.writeFileSync(verdictsPath, '{ this is not json');
const broken = buildAlphaDesk('cockpit:jarvis-alpha', isRunning);
check('invalid JSON is surfaced, not swallowed', !!broken.verdicts_error, `error was ${broken.verdicts_error}`);
eq('invalid JSON still renders every child as pending', broken.rows.every((r) => r.verdict.verdict === 'pending'), true);
eq('invalid JSON does not lose the rows', broken.rows.length, 7);

fs.writeFileSync(verdictsPath, '["an array is not a map"]');
check('an array verdict file is rejected', !!buildAlphaDesk('cockpit:jarvis-alpha', isRunning).verdicts_error);

fs.rmSync(verdictsPath);
const missing = buildAlphaDesk('cockpit:jarvis-alpha', isRunning);
check('a missing verdict file is surfaced', !!missing.verdicts_error);
eq('a missing verdict file still renders the rows', missing.rows.length, 7);
eq('readVerdicts reports empty on a missing file', Object.keys(readVerdicts().verdicts).length, 0);

// ─── Result ──────────────────────────────────────────────────────────────────
fs.rmSync(scratchDir, { recursive: true, force: true });
console.log(`alpha-desk: ${pass}/${pass + failures.length} checks passed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
