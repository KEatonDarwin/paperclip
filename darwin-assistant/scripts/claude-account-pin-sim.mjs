#!/usr/bin/env node
// PER-THREAD CLAUDE ACCOUNT PIN — independent end-to-end SIM (tree-b32ef869 node #700).
//
//   npm run build
//   npm run claude-account-pin:sim
//
// This is a SEPARATE, independently-authored check from
// scripts/claude-account-pin-test.mjs (the backend node's own test) — it exists
// to verify node #698's claims hold, not to re-trust them. It covers the exact
// scenarios from the node #700 spec:
//
//   (a) no pin              -> least-used account picked
//   (b) pin 'b'              -> 'b' picked even though A is less used
//   (c) pin 'b' @ 95% 5h     -> still 'b' (a pin outranks the ceiling)
//   (d) pin -> disabled acct -> falls back to auto (+ logs, verified via
//                                pinIgnoredReason, not a log-scrape)
//   (e) pin != session acct  -> session dropped (sessionId cleared BEFORE the
//                                adapter builds its args, so no --resume flows)
//   (f) weekly=100% account  -> skipped by AUTO selection
//   (g) PATCH route          -> unknown key 400, null clears, adapter:null
//                                clears too
//
// PLUS one thing scripts/claude-account-pin-test.mjs does NOT cover: an actual
// spawn-level proof. runConversationTurn (private, only reachable through the
// sim-guarded processMessage) resolves decideClaudeAccountForTurn() once and
// hands the result straight to runClaude() as runtime.claudeAccount, and turns
// a dropSession decision into `sessionId = null` before that call. This sim
// reproduces that exact composition — decideClaudeAccountForTurn() -> runClaude()
// with a fake `claude` binary (same technique as multi-claude-e2e-sim.mjs) — so
// scenarios (b)/(c)/(e) are proven all the way down to "what CLAUDE_CONFIG_DIR
// and --resume flag would the real CLI have seen", not just at the pure-function
// layer. No live login, no jarvis.service restart, no real model call — see
// src/sim-guard.ts, which this script respects by construction (it never calls
// processMessage; it calls the same lower-level seams multi-claude-e2e-sim.mjs
// already uses safely).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ── scratch DB guard (mirrors every other multi-claude script) ─────────────
const rawDb = process.env.JARVIS_DB_PATH;
if (!rawDb || !rawDb.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path.');
  process.exit(1);
}
const DB_PATH = path.resolve(rawDb);
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-account-pin-sim-'));
process.env.CLAUDE_USAGE_DIR = scratchDir;
process.env.HOPPER_GOV_5H_CEILING = '90';

// Fake `claude` binary — drains stdin, reports the env + argv it was spawned
// with (CLAUDE_CONFIG_DIR + whether --resume was passed and with what id).
// Set CLAUDE_BIN before importing agent.js (ADAPTERS.claude.bin reads it at
// module load, same as multi-claude-e2e-sim.mjs).
const FAKE_BIN = path.join(scratchDir, 'fake-claude.sh');
fs.writeFileSync(
  FAKE_BIN,
  `#!/usr/bin/env bash
cat >/dev/null 2>&1 || true
CFG="\${CLAUDE_CONFIG_DIR:-NONE}"
RESUME=NONE
prev=""
for a in "$@"; do
  if [ "$prev" = "--resume" ]; then RESUME="$a"; fi
  prev="$a"
done
printf '%s\\n' "{\\"type\\":\\"result\\",\\"result\\":\\"CFG=\${CFG}|RESUME=\${RESUME}\\",\\"session_id\\":\\"sess-sim\\"}"
`,
  { mode: 0o755 },
);
process.env.CLAUDE_BIN = FAKE_BIN;
process.env.ANTHROPIC_API_KEY = 'sk-should-be-deleted';
delete process.env.CLAUDE_CONFIG_DIR;

console.log(`[claude-account-pin-sim] scratch DB:  ${DB_PATH}`);
console.log(`[claude-account-pin-sim] scratch dir: ${scratchDir}`);

const distDir = path.join(repoRoot, 'dist');
const convDb = await import(path.join(distDir, 'conversation-db.js'));
const accountsMod = await import(path.join(distDir, 'claude-accounts.js'));
const { runClaude } = await import(path.join(distDir, 'agent.js'));
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const { setSetting, deleteSetting, getConversation, getOrCreateConversation } = convDb;
const { selectActiveClaudeAccount, decideClaudeAccountForTurn, claudeFiveHourCeiling } = accountsMod;

const cfgA = path.join(scratchDir, 'cc-a');
const cfgB = path.join(scratchDir, 'cc-b');
function registerAB() {
  setSetting(
    'claude_accounts',
    JSON.stringify([
      { key: 'a', label: 'Claude A', config_dir: null, enabled: true },
      { key: 'b', label: 'Claude B', config_dir: cfgB, enabled: true },
    ]),
  );
}
function registerBDisabled() {
  setSetting(
    'claude_accounts',
    JSON.stringify([
      { key: 'a', label: 'Claude A', config_dir: null, enabled: true },
      { key: 'b', label: 'Claude B', config_dir: cfgB, enabled: false },
    ]),
  );
}
function writeUsage(key, { fiveHour, weekly = 10, locked = null, ageMinutes = 0 } = {}) {
  const file = accountsMod.usageFilePath(key);
  fs.writeFileSync(
    file,
    JSON.stringify({
      five_hour: { utilization: fiveHour, locked_reason: locked },
      seven_day: { utilization: weekly, locked_reason: null },
    }),
  );
  if (ageMinutes > 0) {
    const t = (Date.now() - ageMinutes * 60_000) / 1000;
    fs.utimesSync(file, t, t);
  }
}

const CEIL = claudeFiveHourCeiling();
assert.equal(CEIL, 90, 'sim assumes a 90% 5h ceiling');

// runClaude falls back to getActiveAdapter()/getSetting('model') when runtime
// doesn't carry them (see agent.ts:1032) — set those globally once, same as
// multi-claude-e2e-sim.mjs, so the sim's runtime object only needs to carry
// the one thing under test: claudeAccount.
setSetting('adapter', 'claude');
deleteSetting('model');

const results = [];
async function scenario(desc, fn) {
  try {
    await fn();
    results.push({ desc, pass: true });
    console.log(`  ✓ ${desc}`);
  } catch (err) {
    results.push({ desc, pass: false, error: err instanceof Error ? err.message : String(err) });
    console.log(`  ✗ ${desc}\n      ${err instanceof Error ? err.message : err}`);
  }
}

// Reproduces the exact composition runConversationTurn performs: resolve the
// decision, then (if dropSession) null the sessionId, then hand
// { claudeAccount: decision.account } + that sessionId to runClaude.
async function runThroughDecision({ pinnedKey, sessionId, storedAccount }) {
  const selection = selectActiveClaudeAccount(CEIL);
  const decision = decideClaudeAccountForTurn({ pinnedKey, sessionId, storedAccount, selection });
  const effectiveSessionId = decision.dropSession ? null : sessionId;
  const res = await runClaude('ping', effectiveSessionId, undefined, {
    model: null,
    claudeAccount: decision.account,
  });
  return { decision, res };
}

registerAB();

// ── (a) no pin -> least-used account picked ────────────────────────────────
await scenario('(a) no pin, both healthy -> least-used (b) wins, no CLAUDE_CONFIG_DIR surprise', async () => {
  writeUsage('a', { fiveHour: 40 });
  writeUsage('b', { fiveHour: 5 });
  const { decision, res } = await runThroughDecision({ pinnedKey: null, sessionId: null, storedAccount: null });
  assert.equal(decision.account.key, 'b');
  assert.equal(decision.source, 'auto');
  assert.equal(res.text, `CFG=${cfgB}|RESUME=NONE`, `expected the CLI to see b's config_dir, got "${res.text}"`);
});

// ── (b) pin 'b' -> 'b' wins even though A is less used ──────────────────────
await scenario('(b) pin b, a is less used -> b still wins, spawn uses CLAUDE_CONFIG_DIR=b', async () => {
  writeUsage('a', { fiveHour: 5 });
  writeUsage('b', { fiveHour: 60 });
  const { decision, res } = await runThroughDecision({ pinnedKey: 'b', sessionId: null, storedAccount: null });
  assert.equal(decision.account.key, 'b');
  assert.equal(decision.source, 'pin');
  assert.equal(res.text, `CFG=${cfgB}|RESUME=NONE`);
});

// ── (c) pin 'b' at 95% 5h -> still b (pin outranks the ceiling) ─────────────
await scenario('(c) pin b while b is at 95% 5h (over the 90 ceiling) -> still b', async () => {
  writeUsage('a', { fiveHour: 5 });
  writeUsage('b', { fiveHour: 95 });
  const selection = selectActiveClaudeAccount(CEIL);
  assert.equal(
    selection.perAccount.find((e) => e.account.key === 'b').eligible,
    false,
    'sim setup check: b must be AUTO-ineligible at 95%',
  );
  const { decision, res } = await runThroughDecision({ pinnedKey: 'b', sessionId: null, storedAccount: null });
  assert.equal(decision.account.key, 'b', 'a pin overrides the 5h ceiling');
  assert.equal(decision.source, 'pin');
  assert.equal(res.text, `CFG=${cfgB}|RESUME=NONE`);
});

// ── (d) pin to a disabled account -> falls back + reason is surfaced ───────
await scenario('(d) pin to a disabled account -> falls back to auto, pinIgnoredReason=disabled', async () => {
  registerBDisabled();
  writeUsage('a', { fiveHour: 20 });
  writeUsage('b', { fiveHour: 1 });
  const { decision, res } = await runThroughDecision({ pinnedKey: 'b', sessionId: null, storedAccount: null });
  assert.equal(decision.account.key, 'a', 'a disabled pin target must never be selected');
  assert.equal(decision.source, 'auto');
  assert.equal(decision.pinIgnoredReason, 'disabled');
  // account 'a' has config_dir: null -> env is left untouched, same as the
  // single-account default path.
  assert.equal(res.text, 'CFG=NONE|RESUME=NONE');
  registerAB();
});

// ── (e) pin != session's account -> session dropped, no --resume reaches the CLI ─
await scenario('(e) pin differs from the sticky session account -> session dropped, no --resume flows', async () => {
  writeUsage('a', { fiveHour: 10 }); // the stored/sticky account, still eligible
  writeUsage('b', { fiveHour: 20 });
  const { decision, res } = await runThroughDecision({
    pinnedKey: 'b',
    sessionId: 'sess-was-on-a-123',
    storedAccount: 'a',
  });
  assert.equal(decision.account.key, 'b', 'the pin must move the thread off its sticky account');
  assert.equal(decision.dropSession, true);
  // The proof that matters: the CLI never actually saw --resume sess-was-on-a-123.
  assert.equal(res.text, `CFG=${cfgB}|RESUME=NONE`, 'a per-account session id must never cross accounts');
});
// Regression half of (e): NO pin, session matches the least-used pick -> kept.
await scenario('(e-regression) no pin, sticky account still eligible -> session KEPT, --resume flows', async () => {
  writeUsage('a', { fiveHour: 10 });
  writeUsage('b', { fiveHour: 5 }); // least-used would move us to b
  const { decision, res } = await runThroughDecision({
    pinnedKey: null,
    sessionId: 'sess-still-good-456',
    storedAccount: 'a',
  });
  assert.equal(decision.account.key, 'a', 'stickiness keeps the live session on its account');
  assert.equal(decision.dropSession, false);
  assert.equal(res.text, 'CFG=NONE|RESUME=sess-still-good-456', 'the resume id must reach the CLI unchanged');
});

// ── (f) weekly=100% -> skipped by AUTO selection (the folded-in bug fix) ───
await scenario('(f) weekly >= 100 on the least-5h account -> AUTO skips it, spawns on the other one', async () => {
  writeUsage('a', { fiveHour: 40, weekly: 9 });
  writeUsage('b', { fiveHour: 1, weekly: 100 }); // least-used by 5h, spent for the week
  const { decision, res } = await runThroughDecision({ pinnedKey: null, sessionId: null, storedAccount: null });
  assert.equal(decision.account.key, 'a', 'AUTO must refuse the weekly-spent account even though it looks least-used');
  assert.equal(res.text, 'CFG=NONE|RESUME=NONE');
});
await scenario('(f-2) a pin still routes to a weekly-spent account (Kevin explicitly asked for it)', async () => {
  writeUsage('a', { fiveHour: 40, weekly: 9 });
  writeUsage('b', { fiveHour: 1, weekly: 100 });
  const { decision, res } = await runThroughDecision({ pinnedKey: 'b', sessionId: null, storedAccount: null });
  assert.equal(decision.account.key, 'b', 'an explicit pin is Kevin overriding the weekly-spent guard on purpose');
  assert.equal(res.text, `CFG=${cfgB}|RESUME=NONE`);
});

// ── (g) PATCH /threads/:ext/model { claude_account } — real HTTP, ephemeral port ─
console.log('\n(g) PATCH /threads/:ext/model claude_account (real HTTP, in-process, ephemeral port — never the live :3201)');
writeUsage('a', { fiveHour: 10 });
writeUsage('b', { fiveHour: 20 });

const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const key = mintApiKey('pin-sim-admin', 'admin').plaintext;
const EXT = 'cockpit:claude-account-pin-sim';
getOrCreateConversation(EXT, null);

async function patchModel(body) {
  const r = await fetch(`${base}/threads/${encodeURIComponent(EXT)}/model`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

await scenario('(g1) unknown claude_account -> 400, no partial apply', async () => {
  await patchModel({ adapter: 'claude', model: 'claude-sonnet-5', claude_account: 'b' });
  const before = getConversation(EXT);
  const r = await patchModel({ adapter: 'claude', model: 'claude-opus-5', claude_account: 'nope' });
  assert.equal(r.status, 400);
  const after = getConversation(EXT);
  assert.equal(after.pinned_claude_account, 'b', 'a rejected pin must not clobber the existing one');
  assert.equal(after.thread_model, before.thread_model, 'the model must not change either, on a rejected pin');
});

await scenario('(g2) valid claude_account pins the thread and threadDescriptor reflects it', async () => {
  const r = await patchModel({ adapter: 'claude', model: 'claude-opus-5', claude_account: 'a' });
  assert.equal(r.status, 200);
  assert.equal(r.json.claude_account, 'a');
  assert.equal(getConversation(EXT).pinned_claude_account, 'a');
});

await scenario('(g3) explicit null clears the pin back to Auto', async () => {
  const r = await patchModel({ adapter: 'claude', claude_account: null });
  assert.equal(r.status, 200);
  assert.equal(r.json.claude_account, null);
  assert.equal(getConversation(EXT).pinned_claude_account, null);
});

await scenario('(g4) adapter:null clears the pin too', async () => {
  await patchModel({ adapter: 'claude', claude_account: 'b' });
  assert.equal(getConversation(EXT).pinned_claude_account, 'b');
  const r = await patchModel({ adapter: null });
  assert.equal(r.status, 200);
  assert.equal(r.json.claude_account, null);
});

// (g5)/(g6) added by the adversarial review (node #701): picking an account
// must NOT create a per-thread MODEL override as a side effect — the picker
// sends `claude_account` alone, and the thread keeps inheriting the global
// default model.
await scenario('(g5) account-only PATCH pins without creating a model override', async () => {
  await patchModel({ adapter: null }); // back to inheriting the global default
  const before = getConversation(EXT);
  assert.equal(before.thread_adapter, null);
  assert.equal(before.thread_model, null);

  const r = await patchModel({ claude_account: 'b' });
  assert.equal(r.status, 200);
  assert.equal(r.json.claude_account, 'b');
  const after = getConversation(EXT);
  assert.equal(after.pinned_claude_account, 'b');
  assert.equal(after.thread_adapter, null, 'model override must be untouched');
  assert.equal(after.thread_model, null, 'model override must be untouched');
  assert.equal(r.json.model_override.adapter, null);
});

await scenario('(g6) account-only PATCH with a bad key 400s and changes nothing', async () => {
  const r = await patchModel({ claude_account: 'nope' });
  assert.equal(r.status, 400);
  assert.equal(getConversation(EXT).pinned_claude_account, 'b');
  // and an account-only clear still works
  const c = await patchModel({ claude_account: null });
  assert.equal(c.status, 200);
  assert.equal(getConversation(EXT).pinned_claude_account, null);
});

server.close();

// ── report ───────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass).length;
console.log(`\n[claude-account-pin-sim] ${results.length - failed}/${results.length} scenarios passed`);
fs.rmSync(scratchDir, { recursive: true, force: true });
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
process.exit(failed === 0 ? 0 : 1);
