// node --test scripts/improver-export.test.mjs
// Fixture db in /tmp with only the columns the exporter reads; never touches jarvis.db.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrub } from './improver-export.mjs';

const SCRIPT = fileURLToPath(new URL('./improver-export.mjs', import.meta.url));
const FIELDS = ['id', 'ts', 'kind', 'job_id', 'thread_id', 'model', 'exit_code', 'error_excerpt',
  'tokens_in', 'tokens_out', 'wall_ms', 'harness_commit'];

const FAKE_PW = 'Hunter2-Sup3rS3cret!';
const FAKE_BEARER = 'abc123DEF456ghi789JKL';
const FAKE_HEX = 'deadbeefcafebabe0123456789abcdef00ff';
const SECRET_EXCERPT =
  `mysql connect failed: DB_PASSWORD=${FAKE_PW} host=10.0.0.5\n` +
  `curl -H "Authorization: Bearer ${FAKE_BEARER}" https://api.example\n` +
  `session ${FAKE_HEX} contact ops@example.com / kevin@darwininvestornetwork.com`;

/** sqlite datetime text, `hoursAgo` before now (UTC). */
const ago = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600000).toISOString().replace('T', ' ').slice(0, 19);

function buildFixture(dir) {
  const path = join(dir, 'fixture.db');
  const db = new Database(path);
  db.exec(`
    CREATE TABLE conversations (id INTEGER PRIMARY KEY, external_id TEXT, thread_model TEXT);
    CREATE TABLE turns (id INTEGER PRIMARY KEY, conversation_id INTEGER, turn_index INTEGER, role TEXT,
      tool_name TEXT, created_at TEXT, timing_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER,
      model TEXT, error_detail TEXT, cache_read_tokens INTEGER);
    CREATE TABLE hopper_trees (id TEXT PRIMARY KEY, origin_thread_ext TEXT);
    CREATE TABLE hopper_nodes (id INTEGER PRIMARY KEY, tree_id TEXT, status TEXT, model TEXT, question TEXT,
      result TEXT, result_summary TEXT, worker_thread_ext TEXT, updated_at TEXT);
    CREATE TABLE watch_events (id INTEGER PRIMARY KEY, sentinel TEXT, subject_key TEXT, state TEXT,
      severity TEXT, message TEXT, updated_at TEXT);
  `);
  db.prepare(`INSERT INTO hopper_trees VALUES ('tree-aaa', 'cockpit:origin')`).run();
  const conv = db.prepare('INSERT INTO conversations (id, external_id, thread_model) VALUES (?, ?, ?)');
  const node = db.prepare(`INSERT INTO hopper_nodes (id, tree_id, status, model, question, result, result_summary,
    worker_thread_ext, updated_at) VALUES (?, 'tree-aaa', ?, 'claude-opus-5', ?, ?, ?, ?, ?)`);
  const turn = db.prepare(`INSERT INTO turns (id, conversation_id, turn_index, role, tool_name, created_at,
    timing_ms, input_tokens, output_tokens, model, error_detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  // 4 failed worker nodes, one normalized error (only req id / path / timestamp differ)
  const ids = [11, 12, 13, 14];
  ids.forEach((id, i) => {
    conv.run(100 + i, `cockpit:hopper-node-${id}-0000beef`, 'claude-opus-5');
    turn.run(1000 + i, 100 + i, 0, 'assistant', null, ago(10 + i), 5000, 1000, 50, 'claude-opus-5', null);
    node.run(id, 'blocked', null, null,
      `TypeError: Cannot read properties of undefined (reading 'tree_id') req ${(0xa1b2c3d4 + i).toString(16)}\n` +
      `    at claimNode (/home/kevin/paperclip-worktrees/w${i}/darwin-assistant/src/hopper-engine.ts:${1200 + i}:9)\n` +
      `    exited with code 1 at 2026-10-1${i}T03:00:00Z`,
      `cockpit:hopper-node-${id}-0000beef`, ago(10 + i));
  });
  // secret-bearing excerpt (blocked_question; worker thread missing → falls back to tree origin)
  node.run(15, 'blocked_question', SECRET_EXCERPT, null, null, null, ago(5));
  // healthy + out-of-window nodes must NOT export
  node.run(16, 'done', null, 'all good', 'all good', null, ago(3));
  node.run(17, 'blocked', null, null, 'old failure', null, ago(24 * 10));
  // reviewer FAIL verdict on a done node → exported with the technical result, not the layman summary
  node.run(18, 'done', null, 'VERDICT: FAIL\nmissing test for split()', 'Mostly fine, one small gap.', null, ago(6));

  // 20 ordinary turns + 1 token outlier → p95 = 1000, only the outlier exceeds it
  conv.run(200, 'cockpit:kevin-main', 'claude-opus-5');
  for (let i = 0; i < 20; i++) turn.run(2000 + i, 200, i, 'assistant', null, ago(1 + i / 10), 3000, 900 + (i % 5) * 20, 10, null, null);
  // outlier is mostly cached context: input 100 + cache_read 899900 = 900000 prompt tokens
  turn.run(2100, 200, 50, 'assistant', null, ago(2), 4000, 100, 10, 'claude-opus-5', null);
  db.prepare('UPDATE turns SET cache_read_tokens = 899900 WHERE id = 2100').run();
  // one stall turn (11 min) — its input_tokens sit at the median so it is NOT waste
  turn.run(2101, 200, 51, 'tool_result', 'Bash', ago(2), 11 * 60 * 1000, null, null, null, null);
  // out-of-window outlier/stall must NOT export
  turn.run(2102, 200, 52, 'assistant', null, ago(24 * 9), 20 * 60 * 1000, 5000000, 10, null, null);

  // watchdog: one dead_turn alarm (maps to turn-2005), one healthy row, one stale alarm
  db.prepare(`INSERT INTO watch_events (sentinel, subject_key, state, severity, message, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('dead_turn', '200:5', 'handled', 'warning', 'resumed dead turn', ago(4));
  db.prepare(`INSERT INTO watch_events (sentinel, subject_key, state, severity, message, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('hopper_stall', 'tree-x', 'flowing', 'success', 'flowing', ago(4));
  db.prepare(`INSERT INTO watch_events (sentinel, subject_key, state, severity, message, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('service', 'jarvis.service', 'inactive', 'error', 'down', ago(24 * 8));
  db.close();
  return path;
}

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('scrub removes password assignment, bearer token, long hex run and foreign emails', () => {
  const out = scrub(SECRET_EXCERPT);
  for (const s of [FAKE_PW, FAKE_BEARER, FAKE_HEX, 'ops@example.com']) assert.ok(!out.includes(s), `leaked ${s}: ${out}`);
  assert.doesNotMatch(out, /password/i);
  assert.doesNotMatch(out, /Bearer [A-Za-z0-9]/);
  assert.match(out, /kevin@darwininvestornetwork\.com/);
  // other shapes from the spec
  const more = scrub(`ghp_${'A1b2'.repeat(9)} sk-ant-api03-${'x9Y'.repeat(10)} eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig ` +
    `SECRET=topsecretvalue api_key: "abcd" the password is letmein mysql://root:pw123@db.local/x ${'Zx9'.repeat(8)}`);
  for (const s of ['A1b2A1b2', 'x9Yx9Y', 'eyJhbGci', 'topsecretvalue', 'abcd"', 'letmein', 'pw123', 'Zx9Zx9Zx9']) {
    assert.ok(!more.includes(s), `leaked ${s}: ${more}`);
  }
  assert.equal(scrub('x'.repeat(5000)).length, 2000);
  assert.equal(scrub(null), null);
  // ordinary diagnostics survive
  assert.equal(scrub('VERDICT: PASS\nat claimNode (/home/kevin/paperclip/src/hopper-engine.ts:12:9)'),
    'VERDICT: PASS\nat claimNode (/home/kevin/paperclip/src/hopper-engine.ts:12:9)');
});

test('exports the fixture to the spec schema with correct kinds, window and scrubbing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'improver-export-test-'));
  try {
    const db = buildFixture(dir);
    const out = join(dir, 'snap.jsonl');
    const r = run(['--db', db, '--out', out, '--days', '7']);
    assert.equal(r.status, 0, r.stderr);
    const raw = readFileSync(out, 'utf8');
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l));

    // 6 worker_fail (11-15, 18) + 1 watchdog + 1 waste + 1 stall
    assert.equal(lines.length, 9, raw);
    const byKind = (k) => lines.filter((e) => e.kind === k);
    assert.deepEqual(byKind('worker_fail').map((e) => e.job_id).sort(), ['node-11', 'node-12', 'node-13', 'node-14', 'node-15', 'node-18']);
    assert.match(lines.find((e) => e.job_id === 'node-18').error_excerpt, /^VERDICT: FAIL\nmissing test/);
    assert.deepEqual(byKind('waste').map((e) => e.job_id), ['turn-2100']);
    assert.deepEqual(byKind('stall').map((e) => e.job_id), ['turn-2101']);
    assert.deepEqual(byKind('watchdog').map((e) => e.job_id), ['turn-2005']);

    for (const e of lines) {
      assert.deepEqual(Object.keys(e), FIELDS);
      assert.match(e.id, /^evt_/);
      assert.match(e.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.ok(['worker_fail', 'watchdog', 'stall', 'waste'].includes(e.kind));
      assert.ok(typeof e.error_excerpt === 'string' && e.error_excerpt.length <= 2000);
      for (const k of ['exit_code', 'tokens_in', 'tokens_out', 'wall_ms']) assert.ok(e[k] === null || Number.isInteger(e[k]), k);
      assert.ok(typeof e.harness_commit === 'string' && e.harness_commit.length > 0);
    }
    assert.equal(new Set(lines.map((e) => e.id)).size, lines.length, 'ids unique');

    // the 4 clustered failures share one normalized first line; tokens/wall come from the worker thread
    const clustered = byKind('worker_fail').filter((e) => !['node-15', 'node-18'].includes(e.job_id));
    assert.equal(new Set(clustered.map((e) => e.error_excerpt.split('\n')[0].replace(/[0-9a-f]{8,}/g, 'H'))).size, 1);
    assert.ok(clustered.every((e) => e.tokens_in === 1000 && e.tokens_out === 50 && e.wall_ms === 5000 && e.exit_code === 1));
    assert.ok(clustered.every((e) => e.model === 'claude-opus-5' && e.thread_id.startsWith('cockpit:hopper-node-')));

    // secret-bearing node: scrubbed, thread falls back to the tree origin
    const secret = lines.find((e) => e.job_id === 'node-15');
    assert.equal(secret.thread_id, 'cockpit:origin');
    for (const s of [FAKE_PW, FAKE_BEARER, FAKE_HEX]) assert.ok(!raw.includes(s), `snapshot leaked ${s}`);
    assert.doesNotMatch(raw, /(password|Bearer [A-Za-z0-9])/);

    const waste = byKind('waste')[0];
    assert.equal(waste.tokens_in, 900000);
    assert.equal(byKind('stall')[0].wall_ms, 11 * 60 * 1000);
    assert.equal(byKind('watchdog')[0].thread_id, 'cockpit:kevin-main');

    // --days window: widen to 30 and the old node, old outlier/stall and stale alarm appear
    const out30 = join(dir, 'snap30.jsonl');
    assert.equal(run(['--db', db, '--out', out30, '--days', '30']).status, 0);
    const wide = readFileSync(out30, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const ids = new Set(wide.map((e) => e.job_id));
    for (const j of ['node-17', 'turn-2102', 'watch-service-jarvis.service']) assert.ok(ids.has(j), `missing ${j} at --days 30`);
    assert.ok(!ids.has('node-16'), 'done node never exports');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exits 2 with a clear message when --db is missing or does not exist', () => {
  const missing = run(['--out', '/tmp/never.jsonl']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--db is required/);
  const nofile = run(['--db', '/tmp/does-not-exist-improver.db', '--out', '/tmp/never.jsonl']);
  assert.equal(nofile.status, 2);
  assert.match(nofile.stderr, /--db file not found/);
});
