#!/usr/bin/env node
// REPLY BREVITY DIAL TESTS (tree-c8e32ef9, docs/reply-brevity/CONTRACT.md).
//
//   npm run build
//   npm run reply-brevity:test
//
// Three parts, all against a scratch DB — no model calls, no network, no
// touch of the live jarvis.db:
//
//   A. PURE (src/reply-brevity.ts): splitBrevityReply / stripBrevityMarker /
//      briefOnly on fixture strings — no DB involved at all.
//   B. DB-backed (src/reply-brevity.ts + src/conversation-db.ts):
//      resolveBrevity precedence (worker-exclusion > thread override >
//      global > default) and brevityPromptBlock(0) === ''.
//   C. HTTP (src/handlers/api-v1.ts): GET/PATCH /reply-brevity and
//      PATCH /threads/:ext/reply-brevity, including 'inherit' clearing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── scratch DB guard (same shape as scripts/claude-account-pin-test.mjs) ────
const raw = process.env.JARVIS_DB_PATH;
if (!raw || !raw.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path.');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

const distDir = path.join(__dirname, '..', 'dist');
const brevity = await import(path.join(distDir, 'reply-brevity.js'));
const convDb = await import(path.join(distDir, 'conversation-db.js'));

const {
  FULL_MARKER,
  splitBrevityReply,
  stripBrevityMarker,
  briefOnly,
  resolveBrevity,
  brevityPromptBlock,
  getGlobalBrevityLevel,
  getGlobalBrevityView,
  setGlobalBrevityLevel,
  setGlobalBrevityView,
} = brevity;

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}
async function acheck(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}

// ═════════ A. PURE: split / strip / briefOnly ═══════════════════════════════
console.log('\nA. splitBrevityReply / stripBrevityMarker / briefOnly (pure)');

check('no marker -> brief null, full is the whole text', () => {
  const r = splitBrevityReply('just a plain reply, no marker here');
  assert.equal(r.brief, null);
  assert.equal(r.full, 'just a plain reply, no marker here');
});

check('marker with blank lines on both sides', () => {
  const text = `Short bit.\n\n${FULL_MARKER}\n\nFull bit.`;
  const r = splitBrevityReply(text);
  assert.equal(r.brief, 'Short bit.');
  assert.equal(r.full, 'Full bit.');
});

check('marker with NO blank lines around it', () => {
  const text = `Short bit.\n${FULL_MARKER}\nFull bit.`;
  const r = splitBrevityReply(text);
  assert.equal(r.brief, 'Short bit.');
  assert.equal(r.full, 'Full bit.');
});

check('CRLF line endings', () => {
  const text = `Short bit.\r\n\r\n${FULL_MARKER}\r\n\r\nFull bit.\r\nSecond line.`;
  const r = splitBrevityReply(text);
  assert.equal(r.brief, 'Short bit.');
  assert.equal(r.full, 'Full bit.\r\nSecond line.');
});

check('marker appearing twice splits on the FIRST, rest stays in full untouched', () => {
  const text = `Short.\n\n${FULL_MARKER}\n\nFull part one.\n\n${FULL_MARKER}\n\nFull part two (literal marker text preserved).`;
  const r = splitBrevityReply(text);
  assert.equal(r.brief, 'Short.');
  assert.equal(r.full, `Full part one.\n\n${FULL_MARKER}\n\nFull part two (literal marker text preserved).`);
});

check('marker as the very first line -> brief is null, not empty string', () => {
  const text = `${FULL_MARKER}\n\nFull bit only.`;
  const r = splitBrevityReply(text);
  assert.equal(r.brief, null);
  assert.equal(r.full, 'Full bit only.');
});

check('marker trailing whitespace on the marker line is tolerated', () => {
  const text = `Short bit.\n\n${FULL_MARKER}   \n\nFull bit.`;
  const r = splitBrevityReply(text);
  assert.equal(r.brief, 'Short bit.');
  assert.equal(r.full, 'Full bit.');
});

check('marker inside a fenced code block is NOT treated as the split point', () => {
  const text = [
    'Short bit with a code sample:',
    '',
    '```',
    'some code',
    FULL_MARKER,
    'more code',
    '```',
    '',
    FULL_MARKER,
    '',
    'Full bit.',
  ].join('\n');
  const r = splitBrevityReply(text);
  assert.ok(r.brief && r.brief.includes('```'), 'the fenced block must stay part of the brief');
  assert.ok(r.brief.includes(FULL_MARKER), 'the in-fence marker text must NOT have triggered the split');
  assert.equal(r.full, 'Full bit.');
});

check('stripBrevityMarker removes only the marker line, keeps both halves', () => {
  const text = `Short bit.\n\n${FULL_MARKER}\n\nFull bit.`;
  const stripped = stripBrevityMarker(text);
  assert.ok(!stripped.includes(FULL_MARKER));
  assert.ok(stripped.includes('Short bit.'));
  assert.ok(stripped.includes('Full bit.'));
});

check('stripBrevityMarker is a no-op when there is no marker', () => {
  assert.equal(stripBrevityMarker('plain text'), 'plain text');
});

check('briefOnly returns the brief when there is one', () => {
  const text = `Short bit.\n\n${FULL_MARKER}\n\nFull bit.`;
  assert.equal(briefOnly(text), 'Short bit.');
});

check('briefOnly returns the whole text when there is no usable brief', () => {
  assert.equal(briefOnly('plain text, no marker'), 'plain text, no marker');
  const firstLineMarker = `${FULL_MARKER}\n\nFull only.`;
  assert.equal(briefOnly(firstLineMarker), firstLineMarker);
});

// ═════════ B. brevityPromptBlock + resolveBrevity (DB-backed) ═══════════════
console.log('\nB. brevityPromptBlock(0) + resolveBrevity precedence (scratch DB)');

check('brevityPromptBlock(0) is exactly the empty string', () => {
  assert.equal(brevityPromptBlock(0), '');
});

check('brevityPromptBlock(1|2|3) is non-empty and carries the marker constant', () => {
  for (const level of [1, 2, 3]) {
    const block = brevityPromptBlock(level);
    assert.ok(block.length > 0);
    assert.ok(block.includes(FULL_MARKER));
    assert.ok(block.includes(`level="${level}"`));
  }
});

check('default resolution (no settings, no override) is level 0 / view brief', () => {
  const EXT = 'cockpit:reply-brevity-default-test';
  convDb.getOrCreateConversation(EXT, null);
  const r = resolveBrevity(EXT);
  assert.equal(r.level, 0);
  assert.equal(r.view, 'brief');
});

check('global setting applies when there is no per-thread override', () => {
  const EXT = 'cockpit:reply-brevity-global-test';
  convDb.getOrCreateConversation(EXT, null);
  setGlobalBrevityLevel(2);
  setGlobalBrevityView('full');
  const r = resolveBrevity(EXT);
  assert.equal(r.level, 2);
  assert.equal(r.view, 'full');
  assert.equal(getGlobalBrevityLevel(), 2);
  assert.equal(getGlobalBrevityView(), 'full');
  setGlobalBrevityLevel(0);
  setGlobalBrevityView('brief');
});

check('per-thread override wins over the global setting, per axis independently', () => {
  const EXT = 'cockpit:reply-brevity-override-test';
  const conv = convDb.getOrCreateConversation(EXT, null);
  setGlobalBrevityLevel(1);
  setGlobalBrevityView('brief');
  convDb.setThreadBrevityOverride(conv.id, 3, undefined); // only override level
  let r = resolveBrevity(EXT);
  assert.equal(r.level, 3, 'thread-level override must win');
  assert.equal(r.view, 'brief', 'view axis untouched -> still follows global');

  convDb.setThreadBrevityOverride(conv.id, undefined, 'full'); // only override view, leave level=3
  r = resolveBrevity(EXT);
  assert.equal(r.level, 3, 'previously-set level override must be untouched by a view-only call');
  assert.equal(r.view, 'full', 'view override must now win');

  setGlobalBrevityLevel(0);
  setGlobalBrevityView('brief');
});

check("per-thread override of 'inherit' (null) clears back to global", () => {
  const EXT = 'cockpit:reply-brevity-inherit-test';
  const conv = convDb.getOrCreateConversation(EXT, null);
  setGlobalBrevityLevel(2);
  convDb.setThreadBrevityOverride(conv.id, 3, 'full');
  assert.deepEqual(resolveBrevity(EXT), { level: 3, view: 'full' });
  convDb.setThreadBrevityOverride(conv.id, null, null); // 'inherit' on both axes
  assert.deepEqual(resolveBrevity(EXT), { level: 2, view: 'brief' });
  setGlobalBrevityLevel(0);
});

check('worker-thread hard exclusion beats BOTH a thread override and the global setting', () => {
  for (const EXT of ['cockpit:hopper-node-1569', 'cockpit:unblocker-abc123']) {
    const conv = convDb.getOrCreateConversation(EXT, null);
    setGlobalBrevityLevel(3);
    setGlobalBrevityView('full');
    convDb.setThreadBrevityOverride(conv.id, 2, 'full');
    const r = resolveBrevity(EXT);
    assert.equal(r.level, 0, `${EXT} must always resolve to level 0`);
    assert.equal(brevityPromptBlock(r.level), '', `${EXT} must get the empty prompt block`);
  }
  setGlobalBrevityLevel(0);
  setGlobalBrevityView('brief');
});

check('a non-worker thread with the same number suffix is NOT excluded (prefix match, not substring)', () => {
  const EXT = 'cockpit:some-other-thread-hopper-node-1569'; // does not START WITH the worker prefix
  convDb.getOrCreateConversation(EXT, null);
  setGlobalBrevityLevel(2);
  const r = resolveBrevity(EXT);
  assert.equal(r.level, 2, 'only a true external_id PREFIX match is a worker thread');
  setGlobalBrevityLevel(0);
});

// ═════════ C. HTTP: GET/PATCH /reply-brevity + PATCH /threads/:ext/reply-brevity ═
console.log('\nC. HTTP routes (real HTTP, admin-scoped key)');

const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));

const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const adminKey = mintApiKey('reply-brevity-test-admin', 'admin').plaintext;
const jarvisKey = mintApiKey('reply-brevity-test-jarvis', 'jarvis').plaintext;

async function getGlobal(key = adminKey) {
  const r = await fetch(`${base}/reply-brevity`, { headers: { Authorization: `Bearer ${key}` } });
  return { status: r.status, json: await r.json() };
}
async function patchGlobal(body, key = adminKey) {
  const r = await fetch(`${base}/reply-brevity`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}
async function patchThread(ext, body, key = adminKey) {
  const r = await fetch(`${base}/threads/${encodeURIComponent(ext)}/reply-brevity`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

await acheck('GET /reply-brevity reports the global defaults', async () => {
  const r = await getGlobal();
  assert.equal(r.status, 200);
  assert.equal(r.json.level, 0);
  assert.equal(r.json.view, 'brief');
});

await acheck('PATCH /reply-brevity sets level + view', async () => {
  const r = await patchGlobal({ level: 2, view: 'full' });
  assert.equal(r.status, 200);
  assert.equal(r.json.level, 2);
  assert.equal(r.json.view, 'full');
  const g = await getGlobal();
  assert.equal(g.json.level, 2);
  assert.equal(g.json.view, 'full');
});

await acheck('PATCH /reply-brevity rejects an invalid level', async () => {
  const r = await patchGlobal({ level: 7 });
  assert.equal(r.status, 400);
});

await acheck('PATCH /reply-brevity requires admin scope', async () => {
  const r = await patchGlobal({ level: 1 }, jarvisKey);
  assert.equal(r.status, 403);
});

await acheck('PATCH /threads/:ext/reply-brevity sets a per-thread override', async () => {
  const EXT = 'cockpit:reply-brevity-http-thread-test';
  convDb.getOrCreateConversation(EXT, null);
  const r = await patchThread(EXT, { level: 3, view: 'brief' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.override, { level: 3, view: 'brief' });
  assert.deepEqual(r.json.effective, { level: 3, view: 'brief' });
});

await acheck("PATCH /threads/:ext/reply-brevity 'inherit' clears the override back to global", async () => {
  const EXT = 'cockpit:reply-brevity-http-inherit-test';
  convDb.getOrCreateConversation(EXT, null);
  await patchGlobal({ level: 1, view: 'brief' });
  await patchThread(EXT, { level: 3 });
  let r = await patchThread(EXT, { level: 'inherit' });
  assert.equal(r.status, 200);
  assert.equal(r.json.override.level, null);
  assert.equal(r.json.effective.level, 1, 'must fall back to the global level');
});

await acheck('PATCH /threads/:ext/reply-brevity rejects an invalid view', async () => {
  const EXT = 'cockpit:reply-brevity-http-badview-test';
  convDb.getOrCreateConversation(EXT, null);
  const r = await patchThread(EXT, { view: 'wide' });
  assert.equal(r.status, 400);
});

await acheck('PATCH /threads/:ext/reply-brevity on a worker thread still accepts the write, but resolveBrevity stays 0', async () => {
  const EXT = 'cockpit:hopper-node-999999';
  convDb.getOrCreateConversation(EXT, null);
  const r = await patchThread(EXT, { level: 3, view: 'full' });
  assert.equal(r.status, 200, 'the write itself is not blocked at the API layer');
  assert.equal(resolveBrevity(EXT).level, 0, 'resolution still hard-excludes the worker thread');
});

server.close();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
