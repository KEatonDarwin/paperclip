#!/usr/bin/env node
// SESSION ⇄ ACCOUNT CONTINUITY TESTS — exercises the REAL processMessage() /
// runConversationTurn() path across turns (tree-44d2ff4a node #296, adversarial
// review). No live model calls: CLAUDE_BIN is a fake `claude` that records the
// CLAUDE_CONFIG_DIR + whether `--resume <id>` was passed, and mints a session id
// per account so we can watch the harness's resume/fresh decision.
//
//   npm run build
//   npm run claude-session-account:test
//
// Proves:
//   1. First turn → least-used account picked, session id + session_account persisted.
//   2. STICKINESS: next turn, the OTHER account is now marginally less used but the
//      stored account is still eligible → the thread STAYS on its account and
//      `--resume <id>` is passed (native session preserved, no transcript replay).
//   3. REAL SWAP: the stored account goes over the 5h ceiling → the thread moves to
//      the other account with a FRESH session (no --resume), and session_account
//      is re-stamped to the new account.
//   4. Single-account default (no `claude_accounts`) → CLAUDE_CONFIG_DIR never set,
//      resume passed on turn 2 exactly as before this feature (byte-identical path).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── scratch DB guard (agent.js/conversation-db.js open sqlite at import) ──────
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

// ── throwaway usage dir (so account 'a' never reads the live usage file) ──────
const USAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-session-acct-'));
process.env.CLAUDE_USAGE_DIR = USAGE_DIR;
process.env.HOPPER_GOV_STALE_MIN = '10';

const cfgA = path.join(USAGE_DIR, 'cc-a');
const cfgB = path.join(USAGE_DIR, 'cc-b');
const CALL_LOG = path.join(USAGE_DIR, 'calls.log');

// ── fake `claude`: drains stdin, logs "<cfg>|<resume-id-or-NONE>", answers with
//    a per-account session id (sess-a / sess-b / sess-default).
const FAKE_BIN = path.join(USAGE_DIR, 'fake-claude.sh');
fs.writeFileSync(
  FAKE_BIN,
  `#!/usr/bin/env bash
cat >/dev/null 2>&1 || true
CFG="\${CLAUDE_CONFIG_DIR:-NONE}"
RESUME="NONE"
while [ $# -gt 0 ]; do
  if [ "$1" = "--resume" ]; then RESUME="$2"; shift; fi
  shift
done
echo "\${CFG##*/}|\${RESUME}" >> "${CALL_LOG}"
case "\$CFG" in
  *cc-a) SID="sess-a" ;;
  *cc-b) SID="sess-b" ;;
  *)     SID="sess-default" ;;
esac
printf '%s\\n' "{\\"type\\":\\"result\\",\\"result\\":\\"OK\\",\\"session_id\\":\\"\${SID}\\"}"
`,
  { mode: 0o755 },
);
process.env.CLAUDE_BIN = FAKE_BIN;
process.env.ANTHROPIC_API_KEY = 'sk-should-be-deleted';
delete process.env.CLAUDE_CONFIG_DIR;

console.log(`[session-account-test] scratch DB: ${DB_PATH}`);
console.log(`[session-account-test] usage dir:  ${USAGE_DIR}`);

const distDir = path.join(__dirname, '..', 'dist');
const { processMessage } = await import(path.join(distDir, 'agent.js'));
const { setSetting, deleteSetting, getConversation } = await import(path.join(distDir, 'conversation-db.js'));

setSetting('adapter', 'claude');
deleteSetting('model');
setSetting('gov_5h_ceiling', '90');

function writeUsage(key, fiveHour) {
  const file = key === 'a'
    ? path.join(USAGE_DIR, 'claude-usage-live.json')
    : path.join(USAGE_DIR, `claude-usage-${key}-live.json`);
  fs.writeFileSync(file, JSON.stringify({ five_hour: { utilization: fiveHour }, seven_day: { utilization: 5 } }));
}
function setAccounts(arr) { setSetting('claude_accounts', JSON.stringify(arr)); }
function lastCall() {
  const lines = fs.readFileSync(CALL_LOG, 'utf8').trim().split('\n');
  const [cfg, resume] = lines[lines.length - 1].split('|');
  return { cfg, resume };
}

let passed = 0, failed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }
function bad(name, err) { failed++; console.log(`  ✗ ${name}\n      ${err?.stack ?? err?.message ?? err}`); }

const EXT = 'cockpit:session-account-test-1';

// ── TEST 1: first turn → least-used picked, session + account stamped ─────────
try {
  setAccounts([{ key: 'a', config_dir: cfgA }, { key: 'b', config_dir: cfgB }]);
  writeUsage('a', 10);
  writeUsage('b', 30);
  await processMessage('hello', EXT);
  const c = lastCall();
  assert.equal(c.cfg, 'cc-a', `expected first turn on A, got ${c.cfg}`);
  assert.equal(c.resume, 'NONE', 'first turn must not pass --resume');
  const conv = getConversation(EXT);
  assert.equal(conv.claude_session_id, 'sess-a');
  assert.equal(conv.session_account, 'a', `session_account should be 'a', got ${conv.session_account}`);
  ok('turn 1 → least-used A, session sess-a + session_account=a persisted');
} catch (e) { bad('turn 1', e); }

// ── TEST 2: B now marginally less used, A still eligible → STICK to A + resume ─
try {
  writeUsage('a', 40);
  writeUsage('b', 20); // least-used is now B, but A is still under the 90 ceiling
  await processMessage('again', EXT);
  const c = lastCall();
  assert.equal(c.cfg, 'cc-a', `expected the live session to stay on A, got ${c.cfg}`);
  assert.equal(c.resume, 'sess-a', `expected --resume sess-a (native session kept), got ${c.resume}`);
  const conv = getConversation(EXT);
  assert.equal(conv.session_account, 'a');
  ok('turn 2 → stored account still eligible → sticks to A with --resume (no session drop)');
} catch (e) { bad('stickiness', e); }

// ── TEST 3: A over ceiling → real swap to B with a FRESH session ──────────────
try {
  writeUsage('a', 95); // A no longer eligible
  writeUsage('b', 20);
  await processMessage('and again', EXT);
  const c = lastCall();
  assert.equal(c.cfg, 'cc-b', `expected swap to B, got ${c.cfg}`);
  assert.equal(c.resume, 'NONE', `expected a fresh session on account change, but --resume ${c.resume} was passed`);
  const conv = getConversation(EXT);
  assert.equal(conv.claude_session_id, 'sess-b');
  assert.equal(conv.session_account, 'b', `session_account should be re-stamped to 'b', got ${conv.session_account}`);
  ok('turn 3 → A over ceiling → swaps to B, fresh session (no --resume), session_account=b');
} catch (e) { bad('account swap drops session', e); }

// ── TEST 4: single-account default → no CLAUDE_CONFIG_DIR, resume works as before
try {
  deleteSetting('claude_accounts');
  writeUsage('a', 10);
  const EXT2 = 'cockpit:session-account-test-single';
  await processMessage('hello', EXT2);
  let c = lastCall();
  assert.equal(c.cfg, 'NONE', 'single-account default must NOT set CLAUDE_CONFIG_DIR');
  assert.equal(c.resume, 'NONE');
  await processMessage('again', EXT2);
  c = lastCall();
  assert.equal(c.cfg, 'NONE', 'single-account default must NOT set CLAUDE_CONFIG_DIR (turn 2)');
  assert.equal(c.resume, 'sess-default', `single-account turn 2 must --resume as before, got ${c.resume}`);
  const conv = getConversation(EXT2);
  assert.equal(conv.session_account, 'a');
  ok('single-account default → env untouched, --resume on turn 2 (byte-identical path)');
} catch (e) { bad('single-account', e); }

deleteSetting('claude_accounts');
deleteSetting('gov_5h_ceiling');
fs.rmSync(USAGE_DIR, { recursive: true, force: true });
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

console.log('');
if (failed === 0) {
  console.log(`[session-account-test] ALL ${passed} tests passed ✅`);
  process.exit(0);
} else {
  console.log(`[session-account-test] ${failed} FAILED, ${passed} passed ❌`);
  process.exit(1);
}
