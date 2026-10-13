// FIND ANY CHAT — acceptance check (overnight 2026-10-12, tree-ed4fb24a).
//
// Runs the REAL createApiV1Router() on a throwaway express app against a
// SCRATCH jarvis.db (+ its jarvis-search.db sidecar) in /tmp, with the model
// ranker stubbed by thread-search-check.hooks.mjs — zero claude processes,
// zero contact with the live DB or live server.
//
//   npx tsc -p . && JARVIS_SIM=1 node scripts/thread-search-check.mjs
//
// Exits 0 only when every check passes.
import path from 'node:path';
import fs from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const here = path.dirname(new URL(import.meta.url).pathname);
register(pathToFileURL(path.join(here, 'thread-search-check.hooks.mjs')), import.meta.url);

const DIR = process.env.THREAD_SEARCH_CHECK_DIR ?? '/tmp/find-any-chat/check';
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
const DB = path.join(DIR, 'jarvis.db');
process.env.JARVIS_DB_PATH = DB;
process.env.JARVIS_SIM = '1';
process.env.HEALTH_MONITOR = '0';
const PORT = Number(process.env.THREAD_SEARCH_CHECK_PORT ?? 3997);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ---- 1. FTS5 in the bundled better-sqlite3 (everything else is moot without it)
{
  const Database = (await import('better-sqlite3')).default;
  let ok = false;
  let detail = '';
  try {
    const m = new Database(':memory:');
    m.exec(`CREATE VIRTUAL TABLE t USING fts5(content)`);
    m.prepare(`INSERT INTO t VALUES (?)`).run('accounting data recovery');
    ok = m.prepare(`SELECT count(*) n FROM t WHERE t MATCH 'recovery'`).get().n === 1;
    detail = `sqlite ${m.prepare('select sqlite_version() v').get().v}`;
    m.close();
  } catch (err) {
    detail = String(err);
  }
  check('1 FTS5 available in bundled better-sqlite3', ok, detail);
  if (!ok) process.exit(1);
}

const dist = path.resolve(here, '..', 'dist');
const express = (await import('express')).default;
const C = await import(path.join(dist, 'conversation-db.js'));
const F = await import(path.join(dist, 'thread-fts.js'));
const { createApiV1Router } = await import(path.join(dist, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(dist, 'api-keys.js'));
const db = C.sqliteDb;

// ---- seed: 150 chats, oldest first. Each has 8 turns; the OLDEST chat's
// turn 7 (index 6) is the only place "accounting data recovery" appears.
const ts = (daysAgo) => new Date(Date.now() - daysAgo * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
const setTurnTime = db.prepare(`UPDATE turns SET created_at = ? WHERE conversation_id = ?`);
const setConvTime = db.prepare(`UPDATE conversations SET updated_at = ?, created_at = ? WHERE id = ?`);
const seeded = [];
for (let i = 0; i < 150; i += 1) {
  const conv = C.getOrCreateConversation(`cockpit:seed-${String(i).padStart(3, '0')}`);
  for (let t = 0; t < 8; t += 1) {
    const role = t % 2 === 0 ? 'user' : 'assistant';
    const text = i === 0 && t === 6
      ? 'We need to plan the accounting data recovery after the bridge outage.'
      : `Chat ${i} message ${t} about routine widgets and weather.`;
    C.addTurn(conv.id, role, text);
  }
  const at = ts(300 - i); // seed-000 is the oldest by ~300 days
  setTurnTime.run(at, conv.id);
  setConvTime.run(at, at, conv.id);
  seeded.push(conv);
}
const oldest = seeded[0];

const { plaintext } = mintApiKey('thread-search-check', 'admin');
const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = app.listen(PORT);
await new Promise((r) => server.once('listening', r));
const hdr = { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' };
const get = async (p) => {
  const r = await fetch(`http://localhost:${PORT}/api/v1${p}`, { headers: hdr });
  return { status: r.status, body: await r.json() };
};
const search = async (body) => {
  const r = await fetch(`http://localhost:${PORT}/api/v1/threads/search`, { method: 'POST', headers: hdr, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const lastPrompt = () => (globalThis.__rankerPrompts ?? []).at(-1) ?? '';

try {
  // ---- 2. the oldest chat is findable; today's candidate list excludes it
  const oldPath = C.listAllConversations().some((c) => c.id === oldest.id);
  F.catchUp();
  const cands = F.searchCandidates('accounting data recovery');
  const hit = cands.find((c) => c.conversationId === oldest.id);
  check('2a searchCandidates finds turn 7 of the oldest chat', !!hit && cands[0].conversationId === oldest.id,
    hit ? `snippet="${hit.snippet}" lastUserAt=${hit.lastUserAt}` : `got ${JSON.stringify(cands.slice(0, 3))}`);
  check('2b today\'s path (listAllConversations top-100) excludes it', oldPath === false);
  const r2 = await search({ query: 'accounting data recovery' });
  const row2 = (r2.body.results ?? []).find((x) => x.external_id === oldest.external_id || x.thread_id === oldest.external_id || x.id === oldest.external_id);
  check('2c POST /threads/search returns it with snippet + last_user_at',
    r2.status === 200 && lastPrompt().includes(oldest.external_id) && !!row2 &&
      /accounting data recovery/.test(row2.search_snippet ?? '') && typeof row2.last_user_at === 'string',
    `status=${r2.status} results=${(r2.body.results ?? []).length} snippet=${row2?.search_snippet} last_user_at=${row2?.last_user_at}`);

  // ---- 3. GET /threads honours limit past 100, and drops ephemeral: in SQL
  const r3 = await get('/threads?limit=200');
  check('3a GET /threads?limit=200 returns 150', r3.status === 200 && r3.body.threads.length === 150, `got ${r3.body.threads?.length}`);
  for (let i = 0; i < 20; i += 1) {
    const e = C.getOrCreateConversation(`ephemeral:junk-${i}`);
    C.addTurn(e.id, 'user', 'ephemeral accounting data recovery chatter');
  }
  const r3b = await get('/threads?limit=200');
  check('3b with 20 extra ephemeral: rows it still returns 150', r3b.body.threads.length === 150, `got ${r3b.body.threads?.length}`);
  const r3c = await get('/threads?limit=50&offset=140');
  check('3c offset pages past the first 100', r3c.body.threads.length === 10, `got ${r3c.body.threads?.length}`);

  // ---- 4. a turn added after the first search is found on the next one
  const mid = seeded[50];
  C.addTurn(mid.id, 'user', 'Remember the zanzibar quokka ledger idea.');
  const r4 = await search({ query: 'zanzibar quokka' });
  const c4 = F.searchCandidates('zanzibar quokka');
  check('4 watermark catch-up indexes the new turn',
    c4.length === 1 && c4[0].conversationId === mid.id && r4.status === 200 && lastPrompt().includes(mid.external_id),
    `candidates=${JSON.stringify(c4.map((c) => c.conversationId))} status=${r4.status}`);

  const c4b = F.searchCandidates('accounting data recovery');
  check('4b ephemeral: chats are never indexed', c4b.length === 1 && c4b[0].conversationId === oldest.id,
    `candidates=${JSON.stringify(c4b.map((c) => c.conversationId))}`);

  // ---- 5. before/after key on the newest USER turn, not updated_at
  const a = C.getOrCreateConversation('cockpit:date-a');
  const b = C.getOrCreateConversation('cockpit:date-b');
  C.addTurn(a.id, 'user', 'marmalade pipeline from A');
  C.addTurn(b.id, 'user', 'marmalade pipeline from B');
  db.prepare(`UPDATE turns SET created_at = '2026-10-10 12:00:00' WHERE conversation_id = ?`).run(a.id);
  db.prepare(`UPDATE conversations SET updated_at = '2026-01-01 00:00:00' WHERE id = ?`).run(a.id); // old updated_at
  db.prepare(`UPDATE turns SET created_at = '2026-09-01 12:00:00' WHERE conversation_id = ?`).run(b.id);
  db.prepare(`UPDATE conversations SET updated_at = '2026-10-11 00:00:00' WHERE id = ?`).run(b.id); // new updated_at
  F.catchUp();
  const ids = (xs) => xs.map((x) => x.conversationId).sort();
  const before = F.searchCandidates('marmalade', { before: '2026-10-01' });
  const after = F.searchCandidates('marmalade', { after: '2026-10-01T00:00:00Z' });
  const r5 = await search({ query: 'marmalade', before: '2026-10-01' });
  check('5 before excludes a chat whose last user turn is newer, despite old updated_at',
    JSON.stringify(ids(before)) === JSON.stringify([b.id]) && JSON.stringify(ids(after)) === JSON.stringify([a.id]) &&
      r5.status === 200 && lastPrompt().includes('cockpit:date-b') && !lastPrompt().includes('cockpit:date-a'),
    `before=${JSON.stringify(ids(before))} after=${JSON.stringify(ids(after))} (a=${a.id} b=${b.id})`);

  // ---- 6. sidecar unwritable → search still answers via the fallback
  const errs = [];
  const origErr = console.error;
  console.error = (...args) => { errs.push(args.join(' ')); };
  const side = F.searchDbPath();
  // 6a: a populated sidecar made read-only, with new turns waiting to index.
  F.closeSearchDb();
  for (const p of [side, `${side}-wal`, `${side}-shm`]) if (fs.existsSync(p)) fs.chmodSync(p, 0o444);
  C.addTurn(seeded[149].id, 'user', 'fresh turn that cannot be indexed');
  const r6a = await search({ query: 'routine widgets' });
  // 6b: a brand-new sidecar that cannot be created (empty read-only file).
  F.closeSearchDb();
  for (const p of [side, `${side}-wal`, `${side}-shm`]) { try { fs.chmodSync(p, 0o644); } catch {} fs.rmSync(p, { force: true }); }
  fs.writeFileSync(side, '');
  fs.chmodSync(side, 0o444);
  let threw = false;
  try { F.catchUp(); } catch { threw = true; }
  const r6b = await search({ query: 'routine widgets' });
  // 6c: the fallback still answers — and still honours — a date window
  // (date-a's last user turn is 2026-10-10, so before=2026-10-01 drops it).
  db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(a.id); // a is now top of the recent list
  const r6c = await search({ query: 'marmalade', before: '2026-10-01' });
  const p6c = lastPrompt();
  console.error = origErr;
  const fellBack = errs.filter((e) => e.includes('FTS unavailable')).length;
  check('6 unwritable sidecar → results via fallback',
    r6a.status === 200 && r6a.body.results.length > 0 && r6b.status === 200 && r6b.body.results.length > 0 && threw && fellBack === 3 &&
      r6c.status === 200 && p6c.includes('cockpit:date-b') && !p6c.includes('cockpit:date-a'),
    `6a status=${r6a.status} n=${r6a.body.results?.length}; 6b status=${r6b.status} n=${r6b.body.results?.length}; 6c (before) status=${r6c.status} date-b in=${p6c.includes('cockpit:date-b')} date-a in=${p6c.includes('cockpit:date-a')}; catchUp threw=${threw}; fallbacks logged=${fellBack}`);
  fs.chmodSync(side, 0o644);
  F.closeSearchDb();

  // ---- 7. listAllConversations is untouched (still capped at 100)
  const total = db.prepare(`SELECT count(*) n FROM conversations`).get().n;
  check('7 listAllConversations().length is still 100', C.listAllConversations().length === 100, `rows in table=${total}`);
} finally {
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
