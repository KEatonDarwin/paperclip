// SPEND SPLIT — hermetic checks for src/spend-split.ts.
// Throwaway sqlite db (deleted each run); never touches live jarvis.db.
//   npm run build && node scripts/spend-split-test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const LIVE_DB = process.env.ALPHA_DESK_LIVE_DB ?? '/home/kevin/paperclip/darwin-assistant/jarvis.db';
const DIST = process.env.SPEND_SPLIT_DIST ?? new URL('../dist/', import.meta.url).pathname;
const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-split-test-'));
process.env.JARVIS_DB_PATH = path.join(scratchDir, 'scratch.db');
process.env.JARVIS_SIM = '1';

let pass = 0;
const failures = [];
const eq = (name, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass++;
  else failures.push(`${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const ok = (name, cond, detail) => { if (cond) pass++; else failures.push(detail ? `${name} — ${detail}` : name); };

const live = new Database(LIVE_DB, { readonly: true, fileMustExist: true });
const spawnsDdl = live.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_spawns'`).get().sql;
live.close();

const { sqliteDb, getOrCreateConversation } = await import(pathToFileURL(DIST + 'conversation-db.js').href);
const { buildSpendSplit } = await import(pathToFileURL(DIST + 'spend-split.js').href);
sqliteDb.exec(spawnsDdl);

const now = Date.now();
const dbTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const conv = (ext, adapter = 'claude', account = null) => {
  const c = getOrCreateConversation(ext);
  sqliteDb.prepare(`UPDATE conversations SET thread_adapter=?, session_account=? WHERE id=?`).run(adapter, account, c.id);
  return c;
};
let idx = 0;
const usage = (c, model, i, o, cr, cw, at = now - 1000) =>
  sqliteDb.prepare(
    `INSERT INTO turns (conversation_id, turn_index, role, content, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, created_at)
     VALUES (?, ?, 'assistant', 'x', ?, ?, ?, ?, ?, ?)`,
  ).run(c.id, idx++, model, i, o, cr, cw, dbTime(at));
const spawn = (o, k) => sqliteDb.prepare(`INSERT INTO chat_spawns (origin_conversation_id, child_conversation_id, created_at, reported_at) VALUES (?, ?, ?, NULL)`).run(o.id, k.id, dbTime(now));

const talk = conv('cockpit:alpha-talk', 'claude', 'b');
const jobhunt = conv('cockpit:jobhunt-talk', 'claude', 'a');       // matched by the -talk pattern, not the list
const kid = conv('cockpit:spawn-aaaaaaaa-1', 'claude', 'a');
const lane = conv('cockpit:alpha-lane-demo', 'claude', 'b');       // NO chat_spawns row — the whole point
const laneHelper = conv('cockpit:spawn-bbbbbbbb-2', 'claude', 'b');
const laneCodex = conv('cockpit:alpha-lane-codexy', 'codex');
const hopper = conv('cockpit:hopper-node-9-deadbeef', 'claude', 'a');
const direct = conv('cockpit:11111111-2222-3333-4444-555555555555', 'claude', 'a');
spawn(talk, kid); spawn(lane, laneHelper);

usage(talk, 'claude-opus-4-8', 100, 50, 1000, 10);
usage(talk, 'claude-opus-4-8', 1000, 0, 0, 0, now - 3 * 864e5);   // 3 days old: 7d only
usage(talk, 'claude-opus-4-8', 99999, 0, 0, 0, now - 10 * 864e5); // 10 days old: nowhere
usage(jobhunt, 'claude-opus-4-8', 10, 5, 0, 0);
usage(kid, 'claude-sonnet-5-5', 200, 100, 0, 0);
usage(lane, 'claude-opus-4-8', 1000, 0, 0, 0);
usage(laneHelper, 'claude-sonnet-5-5', 500, 0, 0, 0);
usage(laneCodex, null, 7000, 0, 0, 0);
usage(hopper, 'claude-opus-4-8', 40, 0, 0, 0);
usage(direct, 'claude-opus-4-8', 60, 0, 0, 0);

const r = buildSpendSplit(now);
const d = r.windows.last_24h, w = r.windows.last_7d;
eq('24h prime tokens (alpha-talk 1160 + jobhunt-talk 15)', d.prime.total, 1175);
eq('24h spawned tokens (child 300 + lane 1000 + helper 500 + codex lane 7000)', d.spawned.total, 8800);
eq('24h other tokens (hopper 40 + direct 60)', d.other.total, 100);
eq('7d prime includes the 3-day-old turn but not the 10-day-old', w.prime.total, 2175);
eq('today prime = the fresh turns only', r.windows.today.prime.total, 1175);
ok('share = spawned ÷ (prime+spawned)', Math.abs(d.spawned_share.tokens - 8800 / 9975) < 1e-9, String(d.spawned_share.tokens));
const g = Object.fromEntries(d.groups.map((x) => [x.key, x]));
eq('lane without a chat_spawns row counts as spawned', [g.lanes.side, g.lanes.totals.total], ['spawned', 8000]);
eq('lane helper counts beneath lanes', g.beneath_lanes.totals.total, 500);
eq('spawn_chat child counts', g.spawn_chat.totals.total, 300);
eq('hopper and direct stay out of both sides', [g.workers_hopper.side, g.direct.side], ['other', 'other']);
eq('chats are counted per group', [g.prime.chats, g.lanes.chats], [2, 2]);
const codex = d.by_provider.find((p) => p.provider === 'codex');
eq('codex tokens kept but unpriced', [codex.totals.total, codex.totals.unpriced_tokens, codex.totals.cost_usd], [7000, 7000, null]);
ok('claude accounts are split a / b', d.by_provider.some((p) => p.provider === 'claude-a') && d.by_provider.some((p) => p.provider === 'claude-b'));
const sbp = Object.fromEntries(d.side_by_provider.map((x) => [x.provider, x]));
eq('claude-b prime vs spawned', [sbp['claude-b'].prime.total, sbp['claude-b'].spawned.total], [1160, 1500]);
ok('priced claude cost range is ordered', d.prime.cost_usd != null && d.prime.cost_usd_max >= d.prime.cost_usd);
eq('an empty bucket reads null dollars, not 0', buildSpendSplit(now + 400 * 864e5).windows.last_24h.prime.cost_usd, null);

fs.rmSync(scratchDir, { recursive: true, force: true });
if (failures.length) { console.error(`spend-split-test: ${pass} passed, ${failures.length} failed`); for (const f of failures) console.error('  ✗ ' + f); process.exit(1); }
console.log(`spend-split-test: ${pass} passed, 0 failed`);
