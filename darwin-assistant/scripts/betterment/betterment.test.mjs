// node --test scripts/betterment/betterment.test.mjs
// Hermetic: builds a fixture jarvis.db + betterment dir under /tmp, spawns the
// real CLIs against them, never touches the live jarvis.db or /home/kevin/jarvis-betterment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betterment-test-'));
const SRC = path.join(tmp, 'jarvis.db');
const DIR = path.join(tmp, 'bdir');
const env = { ...process.env, BETTERMENT_DIR: DIR };
const run = (script, ...args) => execFileSync(process.execPath, [path.join(here, script), ...args], { env, encoding: 'utf8' });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const DAYS = ['2026-01-10', '2026-01-11', '2026-01-12', '2026-01-13'];

// Day 1: 1000 input + 9000 cache_read per call (ratio 0.9). Days 2-4: 3000 + 3000 (ratio 0.5).
// Worker calls carry an extra 2000 output tokens. Per day: worker = 2 assistant + 1 tool_call,
// interactive = 2 assistant, plus 2 user rows + 1 tool_result → 8 rows/day, 32 rows total.
function buildFixture() {
  const db = new Database(SRC);
  db.pragma('journal_mode = DELETE');
  db.exec(`
    CREATE TABLE conversations (id INTEGER PRIMARY KEY, external_id TEXT, status TEXT, created_at TEXT);
    CREATE TABLE turns (id INTEGER PRIMARY KEY, conversation_id INTEGER, turn_index INTEGER, role TEXT, content TEXT,
      created_at TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
      model TEXT, error_detail TEXT);
    CREATE TABLE hopper_nodes (id INTEGER PRIMARY KEY, tree_id TEXT, title TEXT, spec TEXT, status TEXT, created_at TEXT,
      integrates_node_id INTEGER);
    INSERT INTO conversations VALUES (1, 'cockpit:hopper-node-42-abc', 'active', '2026-01-01'),
                                     (2, 'cockpit:unblocker-7', 'active', '2026-01-01'),
                                     (3, 'cockpit:kevin-chat', 'active', '2026-01-01');
  `);
  const ins = db.prepare(`INSERT INTO turns (conversation_id, turn_index, role, content, created_at, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, error_detail) VALUES (?, 0, ?, 'x', ?, ?, ?, ?, ?, ?)`);
  DAYS.forEach((day, i) => {
    const [inp, cr] = i === 0 ? [1000, 9000] : [3000, 3000];
    const at = (h) => `${day} ${String(h).padStart(2, '0')}:00:00`;
    ins.run(3, 'user', at(1), null, null, null, null, null);
    ins.run(1, 'user', at(2), null, null, null, null, null);
    ins.run(1, 'tool_call', at(3), inp, 2000, cr, 0, null);
    ins.run(1, 'tool_result', at(3), null, null, null, null, null);
    ins.run(1, 'assistant', at(4), inp, 2000, cr, 0, null);
    ins.run(2, 'assistant', at(5), inp, 2000, cr, 0, null);
    ins.run(3, 'assistant', at(6), inp, 0, cr, 0, null);
    ins.run(3, 'assistant', at(7), inp, 0, cr, 0, null);
  });
  // Day 3 failures: one hung (counts), one user stop (excluded).
  ins.run(3, 'assistant', '2026-01-12 08:00:00', null, null, null, null, 'model call produced no output for 600s and was terminated as hung');
  ins.run(3, 'assistant', '2026-01-12 09:00:00', null, null, null, null, 'Run stopped by user\n\nError: Run stopped by user');
  // Out-of-window row (must be ignored by --end/--days).
  ins.run(3, 'assistant', '2026-01-09 12:00:00', 1, 1, 1, 1, null);
  const node = db.prepare('INSERT INTO hopper_nodes (tree_id, title, spec, status, created_at, integrates_node_id) VALUES (?, ?, ?, ?, ?, ?)');
  node.run('t', 'Build a thing', 's', 'done', '2026-01-11 10:00:00', null);
  node.run('t', 'integrate n5', 's', 'done', '2026-01-11 11:00:00', 5);
  node.run('t', 'integrate n9', 's', 'pending', '2026-01-13 11:00:00', null);
  db.close();
}

buildFixture();
const metric = (m) => {
  const db = new Database(path.join(DIR, 'betterment.db'), { readonly: true });
  const rows = db.prepare('SELECT day, value FROM metrics_daily WHERE metric = ? ORDER BY day').all(m);
  db.close();
  return Object.fromEntries(rows.map((r) => [r.day, r.value]));
};

test('report with an empty ledger does not crash', () => {
  const out = JSON.parse(run('report.mjs'));
  assert.equal(out.summary.live_changes, 0);
  assert.deepEqual(out.changes, []);
  assert.ok(fs.existsSync(path.join(DIR, 'report.html')));
});

test('collector aggregates the fixture and leaves the source bytes unchanged', () => {
  const before = sha(SRC);
  const out = JSON.parse(run('collect.mjs', '--source', SRC, '--days', '4', '--end', '2026-01-13'));
  assert.equal(sha(SRC), before, 'source jarvis.db bytes changed');
  assert.deepEqual(out.skipped, []);
  assert.equal(out.start, '2026-01-10');

  // 5 calls/day: 3 worker @ (inp+cr+2000), 2 interactive @ (inp+cr).
  assert.deepEqual(metric('tokens_per_turn'), { '2026-01-10': 11200, '2026-01-11': 7200, '2026-01-12': 7200, '2026-01-13': 7200 });
  assert.equal(metric('tokens_per_turn_worker')['2026-01-10'], 12000);
  assert.equal(metric('tokens_per_turn_interactive')['2026-01-11'], 6000);
  assert.equal(metric('cache_ratio')['2026-01-10'], 0.9);
  assert.equal(metric('cache_ratio')['2026-01-13'], 0.5);
  assert.deepEqual(metric('turns_per_day'), { '2026-01-10': 4, '2026-01-11': 4, '2026-01-12': 6, '2026-01-13': 4 });
  assert.deepEqual(metric('repair_nodes_per_day'), { '2026-01-10': 0, '2026-01-11': 1, '2026-01-12': 0, '2026-01-13': 1 });
  assert.deepEqual(metric('dead_turns_per_day'), { '2026-01-10': 0, '2026-01-11': 0, '2026-01-12': 1, '2026-01-13': 0 });
  assert.equal(metric('turns_per_day')['2026-01-09'], undefined, 'out-of-window day leaked in');

  // Idempotent upsert: a second run changes nothing.
  run('collect.mjs', '--source', SRC, '--days', '4', '--end', '2026-01-13');
  assert.equal(metric('tokens_per_turn')['2026-01-11'], 7200);
  assert.equal(sha(SRC), before);
});

test('ledger + report: improving change is green, regressing change is red with ALERT', () => {
  const a = JSON.parse(run('ledger.mjs', 'add', '--title', 'Trim worker prompt', '--kind', 'flag', '--flag', 'trim_v1',
    '--ref', 'hopper/x@abc', '--metric', 'tokens_per_turn', '--direction', 'down', '--promise', '20', '--applied-at', '2026-01-11'));
  const b = JSON.parse(run('ledger.mjs', 'add', '--title', 'Reorder system prompt', '--kind', 'code',
    '--ref', 'deadbeef', '--metric', 'cache_ratio', '--direction', 'up', '--applied-at', '2026-01-11'));
  const c = JSON.parse(run('ledger.mjs', 'add', '--title', 'Reverted experiment', '--kind', 'code',
    '--metric', 'turns_per_day', '--direction', 'up', '--applied-at', '2026-01-11'));
  run('ledger.mjs', 'revert', String(c.id));
  assert.throws(() => run('ledger.mjs', 'add', '--title', 'bad', '--kind', 'code', '--metric', 'nope', '--direction', 'up'));

  const out = JSON.parse(run('report.mjs'));
  const ra = out.changes.find((x) => x.id === a.id);
  const rb = out.changes.find((x) => x.id === b.id);
  assert.equal(out.changes.length, 2, 'reverted change must not be judged');
  assert.equal(out.reverted[0].id, c.id);

  assert.equal(ra.baseline, 11200);
  assert.equal(ra.live, 7200);
  assert.equal(ra.delta_pct, -35.71);
  assert.equal(ra.verdict, 'green');
  assert.equal(ra.promise, 'met');
  assert.equal(ra.guard, 'ok');

  assert.equal(rb.baseline, 0.9);
  assert.equal(rb.live, 0.5);
  assert.equal(rb.delta_pct, -44.44);
  assert.equal(rb.verdict, 'red');
  assert.equal(rb.red_streak_days, 3);
  assert.equal(rb.guard, 'ALERT');

  assert.equal(out.summary.alerts, 1);
  const html = fs.readFileSync(path.join(DIR, 'report.html'), 'utf8');
  assert.match(html, /Trim worker prompt/);
  assert.match(html, /Alert:/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DIR, 'report.json'), 'utf8')).summary, out.summary);
});

test('a change with fewer than 3 live days is warming, not judged', () => {
  run('ledger.mjs', 'add', '--title', 'Late change', '--kind', 'code', '--metric', 'tokens_per_turn', '--direction', 'down', '--applied-at', '2026-01-13');
  const r = JSON.parse(run('report.mjs')).changes.find((x) => x.title === 'Late change');
  assert.equal(r.status, 'warming');
  assert.equal(r.verdict, null);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
