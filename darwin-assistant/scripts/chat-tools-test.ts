#!/usr/bin/env -S npx tsx
// CHAT TOOLS TESTS (lean/harness-gaps, 2026-10-17; src/tools/chat-search-tool.ts).
//
//   npm run chat-tools:test
//
// Scratch DB only (the FTS sidecar lands next to it in /tmp). No model calls, no network, never
// touches the live jarvis.db. Covers: full-text find, recent list, self/worker/ephemeral hiding,
// password-locked chats giving up only a title, every way of naming a chat, tail/head/match/summary
// modes, the character budget, and brief-only replies expanded to full.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const raw = process.env.JARVIS_DB_PATH;
if (!raw || !raw.startsWith('/tmp/')) {
  console.error('FATAL: JARVIS_DB_PATH must be a /tmp scratch path.');
  process.exit(1);
}
for (const f of [raw, `${raw}-wal`, `${raw}-shm`, path.join(path.dirname(raw), 'jarvis-search.db')]) fs.rmSync(f, { force: true });

const db = await import('../src/conversation-db.js');
const { createThreadSummary } = await import('../src/thread-summaries.js');
const { findChats, readChat, resolveChat } = await import('../src/tools/chat-search-tool.js');

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n${(e as Error).stack}`); process.exitCode = 1; }
};
type Any = Record<string, any>;
const find = async (args: Any, self?: number) => (await findChats.execute(args, { conversationId: self } as never)) as Any;
const read = async (args: Any) => (await readChat.execute(args, {} as never)) as Any;

const mk = (ext: string, turns: [string, string][], title?: string) => {
  const c = db.getOrCreateConversation(ext);
  for (const [role, content] of turns) db.addTurn(c.id, role, content);
  if (title) db.renameConversation(c.id, title);
  return c;
};

const forex = mk('cockpit:11111111-aaaa', [
  ['user', 'set up the MT5 forex lab and the backtest sweep'],
  ['assistant', 'Forex lab is up; the sweep is running.'],
], 'Forex lab');
const cpa = mk('cockpit:22222222-bbbb', [
  ['user', 'check the CPA reconciliation for september invoices'],
  ['assistant', 'CPA recon matched within 0.09 percent.'],
]);
const secret = mk('cockpit:33333333-cccc', [['user', 'private forex salary numbers here']], 'Private');
db.setThreadPassword(secret.id, 'pw');
const worker = mk('cockpit:hopper-node-9-abc', [['user', 'worker building the forex importer']]);
mk('ephemeral:zzz', [['user', 'ephemeral forex scratch']]);
const self = mk('cockpit:44444444-dddd', [['user', 'where is the forex chat?']]);
const long = mk('cockpit:55555555-eeee', Array.from({ length: 30 }, (_, i) =>
  [i % 2 ? 'assistant' : 'user', `message ${i} ${'x'.repeat(3000)}`] as [string, string]));
createThreadSummary(cpa.id, 'Summary: CPA recon for September matched.', null, 1);
const pp = mk('cockpit:pp-desk', [['user', 'pipeline desk: portfolio follow-ups']], '$ Pipeline');
const brief = mk('cockpit:66666666-ffff', [
  ['user', 'status?'],
  ['assistant', 'Short version here.\n<!--JARVIS-FULL-->\nThe full detailed reply about the importer.'],
]);

console.log('chat tools tests');

await t('find by words ranks the matching chat and returns a same-origin link', async () => {
  const r = await find({ query: 'forex lab backtest' }, self.id);
  assert.equal(r.chats[0].thread_id, forex.external_id);
  assert.equal(r.chats[0].title, 'Forex lab');
  assert.equal(r.chats[0].link, '/threads?open=cockpit%3A11111111-aaaa');
  assert.ok(r.chats[0].snippet.toLowerCase().includes('forex'));
});

await t('hides the calling chat, ephemeral chats and workers by default', async () => {
  const ids = (await find({ query: 'forex' }, self.id)).chats.map((c: Any) => c.thread_id);
  assert.ok(!ids.includes(self.external_id));
  assert.ok(!ids.includes('ephemeral:zzz'));
  assert.ok(!ids.includes(worker.external_id));
  const withW = (await find({ query: 'forex', include_workers: true }, self.id)).chats.map((c: Any) => c.thread_id);
  assert.ok(withW.includes(worker.external_id));
  assert.ok(!withW.includes('ephemeral:zzz'), 'ephemeral never shows');
});

await t('a locked chat shows its title but no snippet or summary', async () => {
  const hit = (await find({ query: 'salary' }, self.id)).chats.find((c: Any) => c.thread_id === secret.external_id);
  assert.ok(hit, 'locked chat is findable by title/existence');
  assert.equal(hit.locked, true);
  assert.equal(hit.snippet, null);
  assert.equal(hit.summary, null);
  const r = await read({ thread_id: secret.external_id });
  assert.equal(r.locked, true);
  assert.equal(r.messages, undefined);
  assert.ok(!JSON.stringify(r).includes('salary'));
});

await t('untitled chat gets its first user line as the title; summary rides along', async () => {
  const hit = (await find({ query: 'reconciliation' }, self.id)).chats[0];
  assert.equal(hit.thread_id, cpa.external_id);
  assert.ok(hit.title.startsWith('check the CPA reconciliation'));
  assert.ok(hit.summary.includes('matched'));
});

await t('no query lists recent chats, newest Kevin message first', async () => {
  const r = await find({}, self.id);
  assert.ok(r.count >= 4);
  const ats = r.chats.map((c: Any) => c.last_kevin_message_at);
  assert.deepEqual(ats, [...ats].sort().reverse());
});

await t('the private job lane stays out of the recent list but is found by name', async () => {
  const recent = (await find({ limit: 25 }, self.id)).chats.map((c: Any) => c.thread_id);
  assert.ok(!recent.includes(pp.external_id));
  const named = (await find({ query: 'pipeline desk portfolio' }, self.id)).chats.map((c: Any) => c.thread_id);
  assert.ok(named.includes(pp.external_id));
});

await t('nothing matched is an honest empty result', async () => {
  const r = await find({ query: 'qwertyuiop' }, self.id);
  assert.equal(r.count, 0);
  assert.ok(r.note);
});

await t('resolves external id, bare uuid, numeric id and a pasted link', () => {
  assert.equal(resolveChat('cockpit:11111111-aaaa')?.id, forex.id);
  assert.equal(resolveChat('11111111-aaaa')?.id, forex.id);
  assert.equal(resolveChat(String(forex.id))?.id, forex.id);
  assert.equal(resolveChat('http://x/threads?open=cockpit%3A11111111-aaaa')?.id, forex.id);
  assert.equal(resolveChat('nope'), undefined);
});

await t('tail returns the latest N messages in order', async () => {
  const r = await read({ thread_id: long.external_id, turns: 4, max_chars: 24000 });
  assert.equal(r.total_messages, 30);
  assert.deepEqual(r.messages.map((m: Any) => m.i), [26, 27, 28, 29]);
});

await t('head returns the first N messages', async () => {
  const r = await read({ thread_id: long.external_id, mode: 'head', turns: 2 });
  assert.deepEqual(r.messages.map((m: Any) => m.i), [0, 1]);
});

await t('the character budget is enforced and flagged', async () => {
  const r = await read({ thread_id: long.external_id, mode: 'full', max_chars: 7000 });
  const used = r.messages.reduce((n: number, m: Any) => n + m.content.length, 0);
  assert.ok(used <= 7000, `used ${used}`);
  assert.equal(r.truncated, true);
  assert.equal(r.messages.at(-1).i, 29, 'full keeps the newest when it must cut');
});

await t('match keeps only messages containing the text', async () => {
  const r = await read({ thread_id: long.external_id, match: 'message 7 ', mode: 'full' });
  assert.equal(r.matched_messages, 1);
  assert.equal(r.messages[0].i, 7);
});

await t('summary mode returns the cached summary', async () => {
  const r = await read({ thread_id: cpa.external_id, mode: 'summary' });
  assert.ok(r.summary.includes('matched'));
});

await t('brief-only replies come back as the full reply', async () => {
  const r = await read({ thread_id: brief.external_id });
  const a = r.messages.find((m: Any) => m.role === 'assistant');
  assert.ok(a.content.includes('full detailed reply'));
  assert.ok(!a.content.includes('JARVIS-FULL'));
});

await t('unknown chat is an error that points at find_chats', async () => {
  const r = await read({ thread_id: 'cockpit:does-not-exist' });
  assert.ok(String(r.error).includes('find_chats'));
});

console.log(`\n${pass} passed${process.exitCode ? ', SOME FAILED' : ''}`);
process.exit(process.exitCode ?? 0);
