// SPAWN-CHAT CHECK (overnight 2026-10-12) — the six acceptance tests for
// src/tools/spawn-chat-tool.ts against a SCRATCH sqlite DB. Dispatch is stubbed
// by scripts/spawn-chat-check.hooks.mjs: no model turn ever runs.
//
//   npx tsc -p .
//   JARVIS_DB_PATH=/tmp/spawn-chat-tool/check.db node scripts/spawn-chat-check.mjs

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');

const DB_PATH = path.resolve(process.env.JARVIS_DB_PATH ?? '/tmp/spawn-chat-tool/check.db');
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db') || !DB_PATH.startsWith('/tmp/')) {
  console.error('FATAL: refusing to run outside a /tmp scratch DB.');
  process.exit(1);
}
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
process.env.JARVIS_DB_PATH = DB_PATH;
process.env.JARVIS_SIM = '1';
process.env.HOPPER_GOV_ENABLED = '0';
process.env.NIGHT_SHIFT_DRIVER = '0';
process.env.SPAWN_CHAT_ENABLED = '1';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

register(pathToFileURL(path.join(__dirname, 'spawn-chat-check.hooks.mjs')), import.meta.url);

const convDb = await import(path.join(distDir, 'conversation-db.js'));
const { sqliteDb } = convDb;
const { sseBus } = await import(path.join(distDir, 'sse-bus.js'));
const tools = await import(path.join(distDir, 'tools', 'index.js'));
const spawnMod = await import(path.join(distDir, 'tools', 'spawn-chat-tool.js'));

// Two registered Claude accounts so 'b' is a valid pin.
convDb.setSetting('claude_accounts', JSON.stringify([
  { key: 'a', label: 'Claude A', config_dir: null },
  { key: 'b', label: 'Claude B', config_dir: '/tmp/spawn-chat-tool/claude-b' },
]));

let pass = 0;
const fails = [];
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (err) { fails.push(name); console.log(`  ✗ ${name}\n      ${err.message.split('\n')[0]}`); }
}
const calls = () => globalThis.__spawnCalls ?? [];
const counts = () => ({
  conv: sqliteDb.prepare(`SELECT COUNT(*) n FROM conversations`).get().n,
  spawns: sqliteDb.prepare(`SELECT COUNT(*) n FROM chat_spawns`).get().n,
  commits: sqliteDb.prepare(`SELECT COUNT(*) n FROM watch_commitments`).get().n,
  queue: sqliteDb.prepare(`SELECT COUNT(*) n FROM thread_message_queue`).get().n,
});
function ctx(ext) {
  const c = convDb.getOrCreateConversation(ext);
  return { conversationId: c.id, externalId: ext, sourceMessageId: 'test', sourceTimestamp: new Date().toISOString(), originalText: '' };
}
const spawn = (args, ext) => tools.TOOL_MAP.get('spawn_chat').execute(args, ctx(ext));
const report = (args, ext) => tools.TOOL_MAP.get('report_back').execute(args, ctx(ext));
const REAL = repoRoot; // an absolute path that exists
const goodBrief = (extra = {}) => ({
  goal: 'Help Kevin finish the media-buy stats page.',
  context: `Repo lives at ${REAL}. API route /api/v1/threads is not a file.`,
  constraints: 'Never touch the live checkout.',
  done_means: 'Page renders with real numbers and Kevin says ship it.',
  ...extra,
});

const queued = [];
sseBus.on('sse', (ev) => { if (ev.type === 'queued_message') queued.push(ev); });

const ORIGIN = 'cockpit:spawn-check-origin';
let child1;

console.log('[spawn-chat-check] scratch DB:', DB_PATH);

await check('1. spawn {model:opus-5, account:b} → pinned child + chat_spawns row + brief is first queued message', async () => {
  const r = await spawn({ title: 'Media buy helper', model: 'opus-5', account: 'b', brief: goodBrief() }, ORIGIN);
  assert.equal(r.ok, true, JSON.stringify(r));
  child1 = r.external_id;
  assert.match(child1, /^cockpit:spawn-/);
  assert.equal(r.url, `/threads?open=${encodeURIComponent(child1)}`);
  const row = convDb.getConversation(child1);
  assert.ok(row, 'child conversation row exists');
  assert.equal(row.pinned_claude_account, 'b');
  assert.equal(row.thread_adapter, 'claude');
  assert.equal(row.thread_model, 'claude-opus-5');
  assert.equal(row.title, 'Media buy helper');
  const sp = sqliteDb.prepare(`SELECT * FROM chat_spawns WHERE child_conversation_id = ?`).get(row.id);
  assert.ok(sp, 'chat_spawns row');
  assert.equal(sp.origin_conversation_id, convDb.getConversation(ORIGIN).id);
  assert.equal(sp.reported_at, null);
  const childQueued = queued.filter((e) => e.conversationId === row.id);
  assert.equal(childQueued[0]?.action, 'created', 'brief went through the message queue');
  assert.match(childQueued[0].item.content, /## Goal\nHelp Kevin finish/);
  const childCalls = calls().filter((c) => c.externalId === child1);
  assert.equal(childCalls.length, 1, 'exactly one dispatch to the child');
  assert.equal(childCalls[0].text, childQueued[0].item.content, 'first dispatched message == queued brief');
  assert.match(childCalls[0].text, /## Done means\nPage renders/);
  assert.match(childCalls[0].text, /report_back/);
  assert.equal(childCalls[0].key, `spawn-chat:${sp.id}`);
});

for (const [label, brief, want] of [
  ['no done_means', goodBrief({ done_means: '' }), 'missing_done_means'],
  ['no goal', goodBrief({ goal: '   ' }), 'missing_goal'],
  ['nonexistent path', goodBrief({ context: 'See /home/kevin/definitely-not-here-spawn-check/notes.md for details.' }), 'path_not_found:/home/kevin/definitely-not-here-spawn-check/notes.md'],
  ['sk- secret', goodBrief({ constraints: 'use key sk-ant-api03-abcdef123456' }), 'secret_detected:sk-'],
  ['ghp_ secret', goodBrief({ context: 'token ghp_abcdefABCDEF123456' }), 'secret_detected:ghp_'],
  ['xox secret', goodBrief({ context: 'slack xoxb-1234-5678' }), 'secret_detected:xox'],
  ['AKIA secret', goodBrief({ context: 'aws AKIAIOSFODNN7EXAMPLE' }), 'secret_detected:AKIA'],
  ['PEM header', goodBrief({ context: '-----BEGIN RSA PRIVATE KEY-----\nMIIE' }), 'secret_detected:pem'],
  ['over 12k', goodBrief({ context: 'x'.repeat(12_500) }), 'brief_too_long:'],
]) {
  await check(`2. brief with ${label} refused (${want}) and no rows written`, async () => {
    const before = counts();
    const r = await spawn({ title: 'Bad brief', brief }, 'cockpit:spawn-check-bad');
    const after = counts();
    assert.equal(r.error, 'brief_rejected', JSON.stringify(r));
    assert.ok(r.errors.some((e) => e.startsWith(want)), `errors ${JSON.stringify(r.errors)} lack ${want}`);
    // the origin conversation is created by ctx() before the call — exclude it
    assert.equal(after.spawns, before.spawns, 'chat_spawns unchanged');
    assert.equal(after.commits, before.commits, 'watch_commitments unchanged');
    assert.equal(after.queue, before.queue, 'queue unchanged');
    assert.ok(after.conv - before.conv <= 1 && !convDb.listAllConversations().some((c) => c.title === 'Bad brief'), 'no child conversation');
  });
}

await check('2b. checkBrief is pure: URLs / API routes / ?#: routes are not files; ok brief passes', async () => {
  const r = spawnMod.checkBrief(goodBrief({ context: 'https://example.com/home/x and /api/v1/threads and /threads?open=cockpit%3Ax and /hopper-nodes/:id/finish and /tmp' }), { title: 't' });
  assert.deepEqual(r, { ok: true, errors: [] });
  const r2 = spawnMod.checkBrief(goodBrief({ context: 'look at /home/kevin/zzz' }), { pathExists: (p) => p === '/home' });
  assert.deepEqual(r2.errors, ['path_not_found:/home/kevin/zzz']);
});

await check('2c. a typo in the TOP-level dir is refused, not skipped (/hom/kevin/x, /definitely-not-real/x)', async () => {
  for (const p of ['/hom/kevin/x', '/definitely-not-real/x']) {
    const r = spawnMod.checkBrief(goodBrief({ context: `read ${p} first` }), { title: 't' });
    assert.deepEqual(r.errors, [`path_not_found:${p}`], `${p}: ${JSON.stringify(r)}`);
  }
});

await check('2d. over-cap brief is refused before any path/secret scan', async () => {
  let scanned = 0;
  const r = spawnMod.checkBrief(goodBrief({ context: '/home/kevin/nope ' + 'x'.repeat(13000) }), { title: 't', pathExists: () => { scanned++; return false; } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('brief_too_long:')), JSON.stringify(r.errors));
  assert.equal(scanned, 0, 'path scan ran on an over-cap brief');
});

await check('3. 6th spawn within an hour from one origin is refused', async () => {
  const O = 'cockpit:spawn-check-rate';
  for (let i = 1; i <= 5; i++) {
    const r = await spawn({ title: `rate ${i}`, brief: goodBrief(), report_back: false }, O);
    assert.equal(r.ok, true, `spawn ${i}: ${JSON.stringify(r)}`);
  }
  const before = counts();
  const r6 = await spawn({ title: 'rate 6', brief: goodBrief() }, O);
  assert.equal(r6.error, 'rate_limited', JSON.stringify(r6));
  assert.deepEqual(counts(), before, 'refused 6th wrote nothing');
  // a different origin is unaffected
  const other = await spawn({ title: 'other origin', brief: goodBrief(), report_back: false }, 'cockpit:spawn-check-rate-2');
  assert.equal(other.ok, true);
});

await check('4. commitment row: check_type=chat_report, thread_ext=origin, check_ref=child, due ≈ +4h', async () => {
  const rows = sqliteDb.prepare(`SELECT * FROM watch_commitments WHERE check_ref = ?`).all(child1);
  assert.equal(rows.length, 1);
  const c = rows[0];
  assert.equal(c.check_type, 'chat_report');
  assert.equal(c.thread_ext, ORIGIN);
  assert.equal(c.status, 'open');
  const hrs = (Date.parse(c.due_at) - Date.now()) / 3600_000;
  assert.ok(hrs > 3.9 && hrs <= 4.01, `due in ${hrs}h`);
  // overridable, and report_back:false writes none (the rate test spawned 5 with false)
  const r = await spawn({ title: 'due override', brief: goodBrief(), report_due_hours: 1 }, 'cockpit:spawn-check-due');
  const c2 = sqliteDb.prepare(`SELECT * FROM watch_commitments WHERE check_ref = ?`).get(r.external_id);
  const hrs2 = (Date.parse(c2.due_at) - Date.now()) / 3600_000;
  assert.ok(hrs2 > 0.9 && hrs2 <= 1.01, `override due in ${hrs2}h`);
  const none = sqliteDb.prepare(`SELECT COUNT(*) n FROM watch_commitments WHERE thread_ext = 'cockpit:spawn-check-rate'`).get().n;
  assert.equal(none, 0);
});

await check('5. report_back from child posts [report:<child>] turn to the ORIGIN; no-spawn chat refused', async () => {
  const originRow = convDb.getConversation(ORIGIN);
  const r = await report({ summary: 'Stats page is live on the branch.' }, child1);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.origin_external_id, ORIGIN);
  const call = calls().filter((c) => c.externalId === ORIGIN).at(-1);
  assert.ok(call, 'dispatched to origin');
  assert.equal(call.text, `[report:${child1}] Stats page is live on the branch.`);
  assert.match(call.key, /^spawn-report:\d+$/);
  const turns = convDb.getTurns(originRow.id).filter((t) => (t.content ?? '').includes(`[report:${child1}]`));
  assert.equal(turns.length, 1, 'one marker turn on the origin');
  assert.equal(calls().filter((c) => c.externalId === child1).length, 1, 'nothing extra posted to the child');
  const sp = sqliteDb.prepare(`SELECT reported_at FROM chat_spawns WHERE child_conversation_id = ?`).get(convDb.getConversation(child1).id);
  assert.ok(sp.reported_at, 'reported_at set');

  // origin busy → it lands on the origin's queue instead
  globalThis.__inFlight = new Set([originRow.id]);
  const r2 = await report({ summary: 'second note' }, child1);
  globalThis.__inFlight = new Set();
  assert.equal(r2.ok, true);
  const q = sqliteDb.prepare(`SELECT content FROM thread_message_queue WHERE conversation_id = ?`).all(originRow.id);
  assert.ok(q.some((x) => x.content === `[report:${child1}] second note`), 'queued on origin while busy');

  const before = calls().length;
  const bad = await report({ summary: 'hi' }, 'cockpit:spawn-check-not-a-child');
  assert.equal(bad.error, 'not_a_spawned_chat');
  assert.equal(calls().length, before, 'refused report dispatched nothing');
  const badOrigin = await report({ summary: 'hi' }, ORIGIN);
  assert.equal(badOrigin.error, 'not_a_spawned_chat', 'the origin itself is not a spawned chat');
});

await check('6. SPAWN_CHAT_ENABLED unset → tools absent; =1 → present (and in the MCP manifest source)', async () => {
  const names = tools.ALL_TOOLS.map((t) => t.name);
  assert.ok(names.includes('spawn_chat') && names.includes('report_back'), 'present when enabled');
  const probe = `const t = await import(${JSON.stringify(pathToFileURL(path.join(distDir, 'tools', 'index.js')).href)}); console.log(JSON.stringify(t.ALL_TOOLS.map(x => x.name))); process.exit(0);`;
  const env = { ...process.env, JARVIS_DB_PATH: path.join(path.dirname(DB_PATH), 'probe.db') };
  delete env.SPAWN_CHAT_ENABLED;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', probe], { env, encoding: 'utf8', timeout: 60_000 });
  const off = JSON.parse(out.trim().split('\n').at(-1));
  assert.ok(off.length > 30, `probe listed ${off.length} tools`);
  assert.ok(!off.includes('spawn_chat') && !off.includes('report_back'), 'absent when unset');
});

console.log(`\n[spawn-chat-check] ${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
process.exit(0);
