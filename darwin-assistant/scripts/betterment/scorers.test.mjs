// npx tsx --test scripts/betterment/scorers.test.mjs
// Hermetic: a tiny synthetic jarvis.db + memory file under /tmp; the replay points every src path
// at scratch (see replay.mjs). Never touches the live jarvis.db, memory file or ~/jarvis-betterment.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { writeCorpus } from './build-corpus.mjs';
import { readCorpus, replayCorpus, liveAssembler, cleanupScratch } from './replay.mjs';
import { scoreMemory, scoreMemoryReplay } from './score-memory.mjs';
import { scoreCache, scoreCacheSequences, commonPrefixBytes } from './score-cache.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'betterment-scorers-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); cleanupScratch(); });

const MARKERS = ['# 🚨 NON-NEGOTIABLES', 'NO API KEYS', 'hub1q'];
const MEMORY = `# JARVIS Memory (fixture)\n\n# 🚨 NON-NEGOTIABLES\n- NO API KEYS. Ever.\n- Use hub1q for Hub 1.0 reads.\n\n# 👤 KEVIN\n- likes short answers\n`;
const WORKER_CORE = '# Worker Core (fixture)\nFinish contract applies.\n';
const SECRET = 'AKIAABCDEFGHIJKLMNOP and Bearer abc123SECRETtoken';

function buildDb(file) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE conversations (id INTEGER PRIMARY KEY, external_id TEXT, session_adapter TEXT, thread_adapter TEXT, thread_model TEXT, created_at TEXT);
    CREATE TABLE turns (id INTEGER PRIMARY KEY, conversation_id INTEGER, turn_index INTEGER, role TEXT, content TEXT,
      created_at TEXT, input_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, model TEXT, error_detail TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
  const conv = db.prepare('INSERT INTO conversations (id, external_id, created_at) VALUES (?, ?, ?)');
  conv.run(1, 'cockpit:101', '2026-01-10 09:00:00');
  conv.run(2, 'cockpit:hopper-node-5-abcd1234', '2026-01-10 09:00:00');
  conv.run(3, 'cockpit:goal-3', '2026-01-10 09:00:00');
  const ins = db.prepare(`INSERT INTO turns (conversation_id, turn_index, role, content, created_at, input_tokens, cache_read_tokens, cache_write_tokens, model, error_detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const t = (c, i, role, content, at, ctx = null) => ins.run(c, i, role, content, at, ctx === null ? null : 1000, ctx === null ? null : ctx - 1000, ctx === null ? null : 0, ctx === null ? null : 'claude-opus-5-5', null);
  // conv 1 (interactive): 4 user turns; a context reset (150k → 30k) happens inside turn 2.
  t(1, 0, 'user', `first question ${SECRET}`, '2026-01-10 10:00:00');
  t(1, 1, 'assistant', 'a', '2026-01-10 10:00:10', 50_000);
  t(1, 2, 'user', 'second question', '2026-01-10 10:05:00');
  t(1, 3, 'assistant', 'b', '2026-01-10 10:05:10', 150_000);
  t(1, 4, 'tool_call', null, '2026-01-10 10:05:20', 30_000);
  t(1, 5, 'user', 'third question', '2026-01-10 10:10:00');
  t(1, 6, 'assistant', 'c', '2026-01-10 10:10:10', 40_000);
  t(1, 7, 'user', 'fourth question', '2026-01-10 10:15:00');
  t(1, 8, 'assistant', 'd', '2026-01-10 10:15:10', 45_000);
  // conv 2 (worker): one spec prompt.
  t(2, 0, 'user', 'node spec: build the thing', '2026-01-10 11:00:00');
  t(2, 1, 'assistant', 'done', '2026-01-10 11:00:30', 20_000);
  // conv 3 (goal): two turns.
  t(3, 0, 'user', 'goal cue one', '2026-01-10 12:00:00');
  t(3, 1, 'assistant', 'ok', '2026-01-10 12:00:10', 30_000);
  t(3, 2, 'user', 'goal cue two', '2026-01-10 12:30:00');
  t(3, 3, 'assistant', 'ok', '2026-01-10 12:30:10', 32_000);
  db.close();
}

const DB = path.join(tmp, 'jarvis.db');
buildDb(DB);
const MEM = path.join(tmp, 'memory.md');
const CORE = path.join(tmp, 'worker-core.md');
fs.writeFileSync(MEM, MEMORY);
fs.writeFileSync(CORE, WORKER_CORE);
function build(name) {
  const out = path.join(tmp, name);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'facts-checklist.json'), JSON.stringify({ markers: MARKERS }));
  writeCorpus({ db: DB, out, memory: MEM, workerCore: CORE, reseed: false });
  return out;
}
const A = build('corpus-a');
const B = build('corpus-b');

test('corpus build is deterministic (same db → identical bytes) and scrubbed', () => {
  for (const f of ['corpus.jsonl', 'meta.json']) {
    assert.equal(fs.readFileSync(path.join(A, f), 'utf8'), fs.readFileSync(path.join(B, f), 'utf8'), f);
  }
  const recs = readCorpus(A).records;
  assert.equal(recs.length, 7);
  const byConv = (c) => recs.filter((r) => r.conversation_id === c);
  assert.deepEqual(byConv(1).map((r) => r.session_position), [0, 1, 2, 3]);
  assert.deepEqual(byConv(1).map((r) => r.compactions_before), [0, 0, 1, 1], 'reset inside turn 2 shows from turn 3 on');
  assert.equal(byConv(2)[0].memory_profile, 'worker');
  assert.equal(byConv(3)[0].thread_class, 'goal');
  const raw = fs.readFileSync(path.join(A, 'corpus.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /AKIA[A-Z0-9]{16}|Bearer [A-Za-z0-9]/, 'scrub() ran on the input excerpt');
});

test('scorers are deterministic: double run → identical JSON', async () => {
  const m1 = await scoreMemory(A);
  const m2 = await scoreMemory(A);
  assert.deepEqual(m1, m2);
  const c1 = await scoreCache(A);
  const c2 = await scoreCache(A);
  assert.deepEqual(c1, c2);
  assert.equal(m1.valid, true, JSON.stringify(m1.violations));
  assert.ok(m1.score_tokens > 0);
  assert.equal(m1.per_class_breakdown.worker.turns, 1);
});

test('live replay follows token-diet: full, full, full-after-reset, unchanged', async () => {
  const r = replayCorpus(readCorpus(A), await liveAssembler());
  const conv1 = r.sessions.find((s) => s.key === 'c1').turns.map((t) => t.memory);
  assert.ok(conv1[0].includes('NO API KEYS') && !conv1[0].startsWith('<memory_refresh'), 'initial prompt memory');
  assert.ok(conv1[1].startsWith('<memory_refresh>'), 'first resume with no baseline sends full');
  assert.ok(conv1[2].startsWith('<memory_refresh>'), 'a compaction forces full');
  assert.ok(conv1[3].startsWith('<memory_refresh unchanged="true">'), 'then dedupes');
});

test('checklist violation ⇒ INVALID regardless of tokens', async () => {
  const corpus = readCorpus(A);
  const live = await liveAssembler();
  // (a) a candidate that strips a marker from every injection (and so is cheaper)
  const stripper = { name: 'strip', begin: (c) => live.begin(c), assemble: (rec, s) => {
    const o = live.assemble(rec, s);
    return { ...o, memory: o.memory.split('hub1q').join(''), prompt: o.prompt.split('hub1q').join('') };
  } };
  const liveScore = scoreMemoryReplay(replayCorpus(corpus, live), corpus.checklist);
  const stripScore = scoreMemoryReplay(replayCorpus(corpus, stripper), corpus.checklist);
  assert.equal(liveScore.valid, true);
  assert.ok(stripScore.score_tokens < liveScore.score_tokens);
  assert.equal(stripScore.valid, false);
  assert.ok(stripScore.violations.some((v) => v.missing.includes('hub1q')));
  // (b) a candidate that never resends after a compaction — the post-reset segment loses every marker
  const UNCHANGED = '<memory_refresh unchanged="true">same</memory_refresh>';
  const lazy = { name: 'lazy', begin: (c) => live.begin(c), assemble: (rec, s) => {
    const o = live.assemble(rec, s);
    return rec.session_position > 0 && rec.compactions_before > 0 ? { ...o, memory: UNCHANGED } : o;
  } };
  const lazyScore = scoreMemoryReplay(replayCorpus(corpus, lazy), corpus.checklist);
  assert.equal(lazyScore.valid, false);
  assert.deepEqual(lazyScore.violations.map((v) => v.session), ['c1']);
});

test('prefix scorer: hand-computed 3-turn example', () => {
  // pair 1: "abcdef" → "abcxyz": prefix 3 of 6 bytes; pair 2: "abcxyz" → "abcxyzw": prefix 6 of 7 bytes.
  const r = scoreCacheSequences({ s1: ['abcdef', 'abcxyz', 'abcxyzw'], solo: ['only one'] });
  assert.equal(r.stable_bytes, 9);
  assert.equal(r.total_bytes, 13);
  assert.equal(r.pairs, 2);
  assert.equal(r.stable_ratio, Math.round((9 / 13) * 1e6) / 1e6);
  assert.deepEqual(r.per_session.solo, { pairs: 0, stable_bytes: 0, total_bytes: 0, ratio: null });
  assert.equal(commonPrefixBytes('é1', 'é2'), 2, 'counts UTF-8 bytes, not chars');
});
