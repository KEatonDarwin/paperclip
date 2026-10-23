#!/usr/bin/env node
// PER-THREAD CLAUDE ACCOUNT PIN + WEEKLY-INELIGIBILITY TESTS (tree-b32ef869).
//
//   npm run build
//   npm run claude-account-pin:test
//
// Two halves, both against fixtures — no model calls, no network, no touch of
// the live jarvis.db or the live /tmp/claude-usage-*.json:
//
//   A. PURE (src/claude-accounts.ts): the weekly>=100 / locked_reason
//      ineligibility fix, and decideClaudeAccountForTurn's precedence
//      (pin > stickiness > least-used), including the no-pin regression that
//      must stay byte-identical to the pre-pin behavior.
//   B. HTTP (src/handlers/api-v1.ts): PATCH /threads/:ext/model's optional
//      `claude_account`, its validation, that the pin survives a model change,
//      that adapter:null clears it, and that threadDescriptor exposes it.
//
// CLAUDE_USAGE_DIR is redirected to a temp dir BEFORE importing the module, so
// account 'a' resolves to <tmp>/claude-usage-live.json, never the live file.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── scratch DB guard (same shape as scripts/claude-accounts-test.mjs) ────────
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

const USAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-account-pin-usage-'));
process.env.CLAUDE_USAGE_DIR = USAGE_DIR;
// Pin the ceiling so the test is independent of the live governor setting.
process.env.HOPPER_GOV_5H_CEILING = '90';

const distDir = path.join(__dirname, '..', 'dist');
const accounts = await import(path.join(distDir, 'claude-accounts.js'));
const convDb = await import(path.join(distDir, 'conversation-db.js'));
const { selectActiveClaudeAccount, decideClaudeAccountForTurn, claudeFiveHourCeiling } = accounts;

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

/** Write one account's usage fixture. `weekly`/`locked` default to healthy. */
function writeUsage(key, { fiveHour, weekly = 10, locked = null } = {}) {
  const file = key === 'a'
    ? path.join(USAGE_DIR, 'claude-usage-live.json')
    : path.join(USAGE_DIR, `claude-usage-${key}-live.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      five_hour: { utilization: fiveHour, locked_reason: locked },
      seven_day: { utilization: weekly, locked_reason: null },
    }),
  );
}

function registerAB() {
  convDb.setSetting(
    'claude_accounts',
    JSON.stringify([
      { key: 'a', label: 'Claude A', config_dir: null, enabled: true },
      { key: 'b', label: 'Claude B', config_dir: '/home/kevin/.claude-b', enabled: true },
    ]),
  );
}

// ═════════ A. PURE: selector eligibility + turn decision ════════════════════
console.log('\nA. selector + decision (pure)');
registerAB();
const CEIL = claudeFiveHourCeiling();
assert.equal(CEIL, 90, 'test assumes a 90% 5h ceiling');

// A1 — REGRESSION: no pin, both healthy ⇒ least-used wins, exactly as before.
check('no pin + both healthy -> least-used account wins (unchanged)', () => {
  writeUsage('a', { fiveHour: 40 });
  writeUsage('b', { fiveHour: 5 });
  const sel = selectActiveClaudeAccount(CEIL);
  assert.equal(sel.account.key, 'b');
  const d = decideClaudeAccountForTurn({ pinnedKey: null, sessionId: null, storedAccount: null, selection: sel });
  assert.equal(d.account.key, 'b');
  assert.equal(d.source, 'auto');
  assert.equal(d.dropSession, false);
  assert.equal(d.pinIgnoredReason, null);
});

// A2 — THE BUG: weekly at 100% must make an account ineligible for AUTO.
check('weekly >= 100 makes an account ineligible for AUTO selection', () => {
  writeUsage('a', { fiveHour: 40, weekly: 9 });
  writeUsage('b', { fiveHour: 1, weekly: 100 }); // least-used by 5h, but spent for the week
  const sel = selectActiveClaudeAccount(CEIL);
  const b = sel.perAccount.find((e) => e.account.key === 'b');
  assert.equal(b.eligible, false, 'b must be ineligible with a spent weekly window');
  assert.equal(sel.account.key, 'a', 'auto-selection must land on a, not the weekly-spent b');
});

// A3 — a lock Claude reports directly also makes an account ineligible.
check('locked_reason makes an account ineligible for AUTO selection', () => {
  writeUsage('a', { fiveHour: 40 });
  writeUsage('b', { fiveHour: 1, locked: 'usage_limit_reached' });
  const sel = selectActiveClaudeAccount(CEIL);
  const b = sel.perAccount.find((e) => e.account.key === 'b');
  assert.equal(b.eligible, false);
  assert.equal(b.usage.locked_reason, 'usage_limit_reached');
  assert.equal(sel.account.key, 'a');
});

// A4 — an unknown weekly number must NOT take an account out of rotation.
check('unknown weekly (null) does not make an account ineligible', () => {
  writeUsage('a', { fiveHour: 40 });
  fs.writeFileSync(
    path.join(USAGE_DIR, 'claude-usage-b-live.json'),
    JSON.stringify({ five_hour: { utilization: 3 }, seven_day: null }),
  );
  const sel = selectActiveClaudeAccount(CEIL);
  const b = sel.perAccount.find((e) => e.account.key === 'b');
  assert.equal(b.usage.weekly, null);
  assert.equal(b.eligible, true);
  assert.equal(sel.account.key, 'b');
});

// A5 — THE ASK: a pin routes there even though AUTO would pick the other one.
check('pin is honoured over the least-used auto pick', () => {
  writeUsage('a', { fiveHour: 40 });
  writeUsage('b', { fiveHour: 5 });
  const sel = selectActiveClaudeAccount(CEIL); // would pick b
  const d = decideClaudeAccountForTurn({ pinnedKey: 'a', sessionId: null, storedAccount: null, selection: sel });
  assert.equal(d.account.key, 'a');
  assert.equal(d.source, 'pin');
});

// A6 — a pin wins even over the 5h ceiling (Kevin's own interactive turn).
check('pin is honoured even when the pinned account is over the 5h ceiling', () => {
  writeUsage('a', { fiveHour: 97 }); // over the 90 ceiling → ineligible for AUTO
  writeUsage('b', { fiveHour: 5 });
  const sel = selectActiveClaudeAccount(CEIL);
  assert.equal(sel.perAccount.find((e) => e.account.key === 'a').eligible, false);
  assert.equal(sel.account.key, 'b', 'auto would avoid the over-ceiling account');
  const d = decideClaudeAccountForTurn({ pinnedKey: 'a', sessionId: null, storedAccount: null, selection: sel });
  assert.equal(d.account.key, 'a', 'an explicit pin outranks the ceiling');
  assert.equal(d.source, 'pin');
});

// A7 — a pin routes to a weekly-spent account too (still Kevin's call).
check('pin routes to a weekly-spent account that AUTO refuses', () => {
  writeUsage('a', { fiveHour: 10, weekly: 9 });
  writeUsage('b', { fiveHour: 2, weekly: 100 });
  const sel = selectActiveClaudeAccount(CEIL);
  assert.equal(sel.account.key, 'a', 'auto must refuse the weekly-spent b');
  const d = decideClaudeAccountForTurn({ pinnedKey: 'b', sessionId: null, storedAccount: null, selection: sel });
  assert.equal(d.account.key, 'b');
  assert.equal(d.source, 'pin');
});

// A8 — an unknown pin falls back; it must never null out the account.
check('pin naming an unregistered account falls back to auto', () => {
  writeUsage('a', { fiveHour: 40 });
  writeUsage('b', { fiveHour: 5 });
  const sel = selectActiveClaudeAccount(CEIL);
  const d = decideClaudeAccountForTurn({ pinnedKey: 'zz', sessionId: null, storedAccount: null, selection: sel });
  assert.equal(d.account.key, 'b');
  assert.equal(d.source, 'auto');
  assert.equal(d.pinIgnoredReason, 'unknown_account');
});

// A9 — a pin on a DISABLED account falls back too.
check('pin naming a disabled account falls back to auto', () => {
  convDb.setSetting(
    'claude_accounts',
    JSON.stringify([
      { key: 'a', label: 'Claude A', config_dir: null, enabled: true },
      { key: 'b', label: 'Claude B', config_dir: '/home/kevin/.claude-b', enabled: false },
    ]),
  );
  writeUsage('a', { fiveHour: 40 });
  writeUsage('b', { fiveHour: 5 });
  const sel = selectActiveClaudeAccount(CEIL);
  assert.equal(sel.account.key, 'a', 'a disabled account is never auto-selected');
  const d = decideClaudeAccountForTurn({ pinnedKey: 'b', sessionId: null, storedAccount: null, selection: sel });
  assert.equal(d.account.key, 'a');
  assert.equal(d.source, 'auto');
  assert.equal(d.pinIgnoredReason, 'disabled');
  registerAB();
});

// A10 — a pin beats session stickiness, and drops the per-account session id.
check('pin beats session stickiness and drops the session id', () => {
  writeUsage('a', { fiveHour: 10 }); // stored account, still perfectly eligible
  writeUsage('b', { fiveHour: 20 });
  const sel = selectActiveClaudeAccount(CEIL);
  assert.equal(sel.perAccount.find((e) => e.account.key === 'a').eligible, true);
  const d = decideClaudeAccountForTurn({ pinnedKey: 'b', sessionId: 'sess-123', storedAccount: 'a', selection: sel });
  assert.equal(d.account.key, 'b', 'the pin must move the thread off its sticky account');
  assert.equal(d.dropSession, true, 'a --resume id cannot cross accounts');
});

// A11 — REGRESSION: with no pin, stickiness still holds an eligible account.
check('no pin -> stickiness still keeps an eligible stored account (unchanged)', () => {
  writeUsage('a', { fiveHour: 40 });
  writeUsage('b', { fiveHour: 5 }); // least-used would move us to b
  const sel = selectActiveClaudeAccount(CEIL);
  const d = decideClaudeAccountForTurn({ pinnedKey: null, sessionId: 'sess-1', storedAccount: 'a', selection: sel });
  assert.equal(d.account.key, 'a', 'the live session stays put');
  assert.equal(d.dropSession, false);
});

// A12 — REGRESSION: an ineligible stored account still swaps + drops, no pin.
check('no pin -> ineligible stored account still swaps and drops the session', () => {
  writeUsage('a', { fiveHour: 99 }); // over ceiling → stored account can't serve
  writeUsage('b', { fiveHour: 5 });
  const sel = selectActiveClaudeAccount(CEIL);
  const d = decideClaudeAccountForTurn({ pinnedKey: null, sessionId: 'sess-1', storedAccount: 'a', selection: sel });
  assert.equal(d.account.key, 'b');
  assert.equal(d.dropSession, true);
});

// A13 — a pin equal to the stored account keeps the session (no churn).
check('pin equal to the stored account keeps the live session', () => {
  writeUsage('a', { fiveHour: 40 });
  writeUsage('b', { fiveHour: 5 });
  const sel = selectActiveClaudeAccount(CEIL);
  const d = decideClaudeAccountForTurn({ pinnedKey: 'a', sessionId: 'sess-1', storedAccount: 'a', selection: sel });
  assert.equal(d.account.key, 'a');
  assert.equal(d.dropSession, false);
});

// A14 — single-account default (no registry at all) stays byte-identical.
check('single-account default is unchanged (no registry, no pin)', () => {
  convDb.setSetting('claude_accounts', '');
  writeUsage('a', { fiveHour: 12 });
  const sel = selectActiveClaudeAccount(CEIL);
  assert.deepEqual(sel.allNames, ['a']);
  assert.equal(sel.account.key, 'a');
  assert.equal(sel.account.config_dir, null, 'the default account must leave CLAUDE_CONFIG_DIR untouched');
  const d = decideClaudeAccountForTurn({ pinnedKey: null, sessionId: 'sess-1', storedAccount: 'a', selection: sel });
  assert.equal(d.account.key, 'a');
  assert.equal(d.dropSession, false);
  registerAB();
});

// ═════════ B. HTTP: PATCH /threads/:ext/model { claude_account } ═════════════
console.log('\nB. PATCH /threads/:ext/model + threadDescriptor (real HTTP)');

const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));

writeUsage('a', { fiveHour: 10 });
writeUsage('b', { fiveHour: 20 });

const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const key = mintApiKey('pin-test-admin', 'admin').plaintext;

const EXT = 'cockpit:claude-account-pin-test';
convDb.getOrCreateConversation(EXT, null);

async function patchModel(body) {
  const r = await fetch(`${base}/threads/${encodeURIComponent(EXT)}/model`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}
async function getThread() {
  const r = await fetch(`${base}/threads/${encodeURIComponent(EXT)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  return r.json();
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

// B1 — a fresh thread reports no pin (Auto), and the column defaults to null.
await acheck('a fresh thread reports claude_account: null (Auto)', async () => {
  const t = await getThread();
  assert.equal(t.claude_account, null);
});

// B2 — REGRESSION: a model-only PATCH still works and leaves the pin alone.
await acheck('model-only PATCH works and leaves the pin untouched', async () => {
  const r = await patchModel({ adapter: 'claude', model: 'claude-sonnet-5' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.model_override, { adapter: 'claude', model: 'claude-sonnet-5' });
  assert.equal(r.json.claude_account, null);
});

// B3 — the ask: pin the thread to Claude B via the dropdown's PATCH.
await acheck('PATCH { claude_account: "b" } pins the thread', async () => {
  const r = await patchModel({ adapter: 'claude', model: 'claude-opus-5', claude_account: 'b' });
  assert.equal(r.status, 200);
  assert.equal(r.json.claude_account, 'b');
  assert.equal(convDb.getConversation(EXT).pinned_claude_account, 'b');
});

// B4 — the pin survives a model change WITHIN the claude adapter.
await acheck('pin survives a model change inside the claude adapter', async () => {
  const r = await patchModel({ adapter: 'claude', model: 'claude-sonnet-5' });
  assert.equal(r.status, 200);
  assert.equal(r.json.claude_account, 'b', 'changing model must not clear the account pin');
});

// B5 — an unknown key is a 400 and must not half-apply the model change.
await acheck('unknown claude_account -> 400, nothing applied', async () => {
  const before = convDb.getConversation(EXT);
  const r = await patchModel({ adapter: 'claude', model: 'claude-opus-5', claude_account: 'zz' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error?.code ?? r.json.code, 'invalid_request');
  const after = convDb.getConversation(EXT);
  assert.equal(after.thread_model, before.thread_model, 'the model must not change on a rejected pin');
  assert.equal(after.pinned_claude_account, 'b', 'the existing pin must survive a rejected PATCH');
});

// B6 — a non-string key is rejected the same way.
await acheck('non-string claude_account -> 400', async () => {
  const r = await patchModel({ adapter: 'claude', claude_account: 7 });
  assert.equal(r.status, 400);
});

// B7 — explicit null clears the pin back to Auto.
await acheck('PATCH { claude_account: null } clears the pin', async () => {
  const r = await patchModel({ adapter: 'claude', model: 'claude-sonnet-5', claude_account: null });
  assert.equal(r.status, 200);
  assert.equal(r.json.claude_account, null);
  assert.equal(convDb.getConversation(EXT).pinned_claude_account, null);
});

// B8 — clearing the adapter override clears the pin too.
await acheck('PATCH { adapter: null } clears the pin as well', async () => {
  await patchModel({ adapter: 'claude', model: 'claude-opus-5', claude_account: 'a' });
  assert.equal(convDb.getConversation(EXT).pinned_claude_account, 'a');
  const r = await patchModel({ adapter: null });
  assert.equal(r.status, 200);
  assert.equal(r.json.claude_account, null);
  assert.deepEqual(r.json.model_override, { adapter: null, model: null });
});

// B9 — GET /claude-accounts exposes the meters the picker renders, incl. locks.
await acheck('GET /claude-accounts returns per-account meters + eligibility', async () => {
  const r = await fetch(`${base}/claude-accounts`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j.accounts.map((a) => a.key), ['a', 'b']);
  for (const a of j.accounts) {
    for (const field of ['key', 'label', 'enabled', 'five_hour', 'weekly', 'stale', 'locked_reason', 'eligible']) {
      assert.ok(field in a, `account payload is missing ${field}`);
    }
  }
  assert.equal(j.active_account, 'a');
});

server.close();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
