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

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ---- 0. scratch safety. The scratch dir is ALWAYS a fresh mkdtemp under
// ROOT; no env var can point it anywhere, and only what this run created is
// ever removed. Proof: a sentinel dir is planted under ROOT and the old
// override variable is aimed at it — it must survive scratch setup.
const ROOT = '/tmp/find-any-chat';
fs.mkdirSync(ROOT, { recursive: true });
const sentinel = fs.mkdtempSync(path.join(ROOT, 'sentinel-'));
fs.writeFileSync(path.join(sentinel, 'keep.txt'), 'must survive');
process.env.THREAD_SEARCH_CHECK_DIR = sentinel; // a "bad" override — must be ignored
const DIR = fs.mkdtempSync(path.join(ROOT, 'check-'));
const underRoot = (p) => path.resolve(p).startsWith(`${ROOT}/`) && path.resolve(p) !== ROOT;
check('0 scratch dir is a fresh mkdtemp under /tmp/find-any-chat/ and ignores THREAD_SEARCH_CHECK_DIR',
  underRoot(DIR) && DIR !== sentinel && fs.existsSync(path.join(sentinel, 'keep.txt')) && fs.readdirSync(DIR).length === 0,
  `dir=${DIR} sentinel kept=${fs.existsSync(path.join(sentinel, 'keep.txt'))}`);
fs.rmSync(sentinel, { recursive: true, force: true }); // ours: created above
const DB = path.join(DIR, 'jarvis.db');
process.env.JARVIS_DB_PATH = DB;
process.env.JARVIS_SIM = '1';
process.env.HEALTH_MONITOR = '0';
const PORT = Number(process.env.THREAD_SEARCH_CHECK_PORT ?? 3997);

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
const { createThreadSummary } = await import(path.join(dist, 'thread-summaries.js'));
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
const search = async (body, headers = hdr) => {
  const r = await fetch(`http://localhost:${PORT}/api/v1/threads/search`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const lastPrompt = () => (globalThis.__rankerPrompts ?? []).at(-1) ?? '';
const resultIds = (r) => (r.body.results ?? []).map((x) => x.thread_id);
// The ranker-prompt block for one thread (from its "- thread_id:" line up to
// the next block / the instructions).
const promptBlock = (prompt, externalId) => {
  const start = prompt.indexOf(`- thread_id: ${externalId}\n`);
  if (start === -1) return null;
  const rest = prompt.slice(start + 1);
  const end = rest.search(/\n- thread_id: |\n\nRespond with ONLY/);
  return '-' + (end === -1 ? rest : rest.slice(0, end));
};

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
    c4.length === 1 && c4[0].conversationId === mid.id && r4.status === 200 && lastPrompt().includes(mid.external_id) &&
      JSON.stringify(resultIds(r4)) === JSON.stringify([mid.external_id]),
    `candidates=${JSON.stringify(c4.map((c) => c.conversationId))} status=${r4.status} results=${JSON.stringify(resultIds(r4))}`);

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
      r5.status === 200 && lastPrompt().includes('cockpit:date-b') && !lastPrompt().includes('cockpit:date-a') &&
      JSON.stringify(resultIds(r5)) === JSON.stringify(['cockpit:date-b']),
    `before=${JSON.stringify(ids(before))} after=${JSON.stringify(ids(after))} (a=${a.id} b=${b.id}) results=${JSON.stringify(resultIds(r5))}`);

  // ---- 8. (review blocker #2) a match buried in an EARLY turn of a long chat
  // — outside the last 4 turns and absent from its summary — reaches the
  // ranker as that candidate's "matched text", so the (honest) ranker picks it.
  const buried = C.getOrCreateConversation('cockpit:buried');
  for (let t = 0; t < 12; t += 1) {
    const role = t % 2 === 0 ? 'user' : 'assistant';
    C.addTurn(buried.id, role, t === 1
      ? 'Noted — the pelican invoice reconciliation is parked until the vendor files arrive.'
      : `Buried chat line ${t}: lunch plans, parking, and the printer.`);
  }
  createThreadSummary(buried.id, 'Mostly lunch plans, parking and a broken printer.', null, 11);
  const r8 = await search({ query: 'pelican invoice reconciliation' });
  const b8 = promptBlock(lastPrompt(), 'cockpit:buried') ?? '';
  const m8 = (b8.match(/\n  matched text: (.*)/) ?? [])[1] ?? '';
  check('8 buried early-turn match reaches the ranker prompt and the results',
    r8.status === 200 && /pelican invoice reconciliation/i.test(m8) && m8.length <= 300 &&
      !/pelican/i.test(b8.replace(/\n  matched text: .*/, '')) && resultIds(r8).includes('cockpit:buried'),
    `status=${r8.status} matched="${m8}" results=${JSON.stringify(resultIds(r8))}`);

  // ---- 9. (review blocker #3) the stubbed ranker is honest: candidates that
  // don't contain the phrase are NOT returned, so the API checks above can fail.
  const r9 = await search({ query: 'routine zebra marmalade' });
  const blocks9 = (lastPrompt().match(/\n- thread_id: /g) ?? []).length;
  check('9 ranker stub returns nothing when no candidate block contains the phrase',
    r9.status === 200 && blocks9 >= 5 && resultIds(r9).length === 0,
    `status=${r9.status} candidate blocks=${blocks9} results=${JSON.stringify(resultIds(r9))}`);

  // ---- 10. (advisory) visibility before limit: a non-admin caller's own hit
  // isn't crowded out of the 40-candidate cap by chats it can't see.
  const { id: userKeyId, plaintext: userKey } = mintApiKey('thread-search-check-user', 'jarvis');
  const userPrefix = `api:${userKeyId}:`;
  for (let i = 0; i < 45; i += 1) {
    const o = C.getOrCreateConversation(`cockpit:vis-${i}`);
    C.addTurn(o.id, 'user', 'quasar quasar quasar nebula');
  }
  const mine = C.getOrCreateConversation(`${userPrefix}mine`);
  C.addTurn(mine.id, 'user', `A long note that mentions a quasar once, among ${'many other ordinary words '.repeat(20)}`);
  db.prepare(`UPDATE conversations SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`).run(mine.id); // out of the recent-100 fallback
  F.catchUp();
  const crowd = F.searchCandidates('quasar').map((c) => c.conversationId);
  const own = F.searchCandidates('quasar', { prefix: userPrefix }).map((c) => c.conversationId);
  const r10 = await search({ query: 'quasar' }, { Authorization: `Bearer ${userKey}`, 'Content-Type': 'application/json' });
  check('10 non-admin caller still gets its own hit when 40+ hidden chats outrank it',
    crowd.length === 40 && !crowd.includes(mine.id) && JSON.stringify(own) === JSON.stringify([mine.id]) &&
      r10.status === 200 && JSON.stringify(resultIds(r10)) === JSON.stringify([mine.external_id]),
    `unfiltered top-40 has mine=${crowd.includes(mine.id)} prefixed=${JSON.stringify(own)} status=${r10.status} results=${JSON.stringify(resultIds(r10))}`);

  // ---- 11. (advisory) title catch-up: a rename stamped in the SAME second as
  // the title watermark, on a lower id, is still indexed on the next pass.
  F.catchUp();
  const Database = (await import('better-sqlite3')).default;
  const side0 = new Database(F.searchDbPath(), { readonly: true });
  const wm = Object.fromEntries(side0.prepare(`SELECT key, value FROM meta`).all().map((r) => [r.key, r.value]));
  side0.close();
  const victim = seeded[1];
  db.prepare(`UPDATE conversations SET title = 'Gryphon fiscal atlas', updated_at = ? WHERE id = ?`).run(wm.conv_updated_at, victim.id);
  F.catchUp();
  const c11 = F.searchCandidates('gryphon atlas').map((c) => c.conversationId);
  check('11 same-second rename on a lower id is caught by the 2s overlap',
    victim.id < Number(wm.conv_id) && c11.includes(victim.id),
    `watermark=(${wm.conv_updated_at}, ${wm.conv_id}) victim=${victim.id} hits=${JSON.stringify(c11)}`);

  // ---- 12. (review r2) a tail of ONLY skipped turns still moves the watermark
  const tailConv = C.getOrCreateConversation('ephemeral:tail-only');
  for (let i = 0; i < 30; i += 1) C.addTurn(tailConv.id, 'user', `ephemeral tail ${i}`);
  const toolConv = seeded[2];
  for (let i = 0; i < 30; i += 1) db.prepare(`INSERT INTO turns (conversation_id, role, content, turn_index) VALUES (?, 'tool', ?, ?)`).run(toolConv.id, `tool output ${i}`, 9000 + i);
  const maxTurn = db.prepare(`SELECT MAX(id) AS m FROM turns`).get().m;
  const s12 = F.catchUp();
  const s12b = F.catchUp();
  check('12 watermark advances past a tail of only skipped (ephemeral/tool) turns',
    s12.lastTurnId === maxTurn && s12b.lastTurnId === maxTurn && s12b.turns === 0,
    `max turn id=${maxTurn} watermark=${s12.lastTurnId} second pass turns=${s12b.turns}`);

  // ---- 13. (review r2) a chat deleted from jarvis.db can't take a candidate slot
  const gone = C.getOrCreateConversation('cockpit:deleted-later');
  C.addTurn(gone.id, 'user', 'obsidian walrus manifest');
  F.catchUp();
  db.prepare(`DELETE FROM turns WHERE conversation_id = ?`).run(gone.id);
  db.prepare(`DELETE FROM conversations WHERE id = ?`).run(gone.id);
  const c13 = F.searchCandidates('obsidian walrus').map((c) => c.conversationId);
  check('13 deleted chat is skipped by searchCandidates', !c13.includes(gone.id), `hits=${JSON.stringify(c13)}`);

  // ---- 14. (review r3) a password-locked chat's matched text never leaves the server
  const lockedConv = C.getOrCreateConversation('cockpit:locked-secret');
  C.addTurn(lockedConv.id, 'user', 'the platypus vault combination is private');
  db.prepare(`UPDATE conversations SET title = 'Platypus vault planning' WHERE id = ?`).run(lockedConv.id);
  C.setThreadPassword(lockedConv.id, 'hunter2');
  const r14 = await search({ query: 'platypus vault' });
  const row14 = (r14.body.results ?? []).find((r) => r.thread_id === 'cockpit:locked-secret');
  const block14 = (lastPrompt().split('cockpit:locked-secret')[1] ?? '').split('thread_id:')[0];
  check('14 locked chat: found by title only — no content of it in the ranker prompt (any line) or the response',
    r14.status === 200 && !!row14 && row14.search_snippet === null && row14.locked === true && block14.length > 0 &&
      !/combination is private/i.test(block14) && !/matched text:/i.test(block14) &&
      !/combination is private/i.test(JSON.stringify(row14)),
    `status=${r14.status} found=${!!row14} snippet=${JSON.stringify(row14?.search_snippet)} locked=${row14?.locked} block_has_matched=${/matched text:/i.test(block14)}`);

  // ---- 15. (review r5) a working index with zero hits → [] and the ranker is never called
  const promptsBefore = (globalThis.__rankerPrompts ?? []).length;
  const r15 = await search({ query: 'xyzzyquux plughfrob' });
  check('15 zero FTS hits → empty result, no recent-100 fallback, ranker not invoked',
    r15.status === 200 && Array.isArray(r15.body.results) && r15.body.results.length === 0 &&
      (globalThis.__rankerPrompts ?? []).length === promptsBefore,
    `status=${r15.status} results=${r15.body.results?.length} ranker calls=${(globalThis.__rankerPrompts ?? []).length - promptsBefore}`);

  // ---- 16. (review r5) summary watermark advances past summaries of skipped chats
  let s16 = null;
  try {
    const eph = C.getOrCreateConversation('ephemeral:summary-tail');
    for (let i = 0; i < 5; i += 1) db.prepare(`INSERT INTO thread_summaries (conversation_id, content, anchor_turn_index) VALUES (?, ?, ?)`).run(eph.id, `ephemeral summary ${i}`, i);
    const maxSum = db.prepare(`SELECT MAX(id) AS m FROM thread_summaries`).get().m;
    const a16 = F.catchUp();
    s16 = { maxSum, wm: a16.lastSummaryId };
  } catch (e) { s16 = { err: String(e.message).slice(0, 120) }; }
  check('16 summary watermark advances past a tail of skipped summaries',
    !!s16 && !s16.err && s16.wm === s16.maxSum, JSON.stringify(s16));

  // ---- 17. (review r5) a locked chat's latest_summary is not in its search result
  db.prepare(`INSERT INTO thread_summaries (conversation_id, content, anchor_turn_index) VALUES (?, ?, ?)`)
    .run(lockedConv.id, 'Summary: the platypus vault combination is private', 0);
  const r17 = await search({ query: 'platypus vault' });
  const row17 = (r17.body.results ?? []).find((r) => r.thread_id === 'cockpit:locked-secret');
  check('17 locked result carries latest_summary=null even when the chat HAS a summary',
    !!row17 && row17.latest_summary === null && !/combination is private/i.test(JSON.stringify(r17.body)),
    `found=${!!row17} latest_summary=${JSON.stringify(row17?.latest_summary)?.slice(0, 80)}`);

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
      r6c.status === 200 && p6c.includes('cockpit:date-b') && !p6c.includes('cockpit:date-a') && resultIds(r6c).includes('cockpit:date-b'),
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
// Remove only the mkdtemp dir this run created (kept on failure for a look).
if (!failed.length && underRoot(DIR)) fs.rmSync(DIR, { recursive: true, force: true });
else console.log(`scratch kept for inspection: ${DIR}`);
process.exit(failed.length ? 1 : 0);
