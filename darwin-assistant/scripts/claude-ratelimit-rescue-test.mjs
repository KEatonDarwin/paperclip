#!/usr/bin/env node
// RATE-LIMIT ACCOUNT-SWAP RESCUE TESTS — exercises the REAL runConversationTurn()
// mid-flight rescue (tree-44d2ff4a node #294). No live model calls: CLAUDE_BIN is
// a tiny fake `claude` that FAILS with a usage-limit error when spawned against
// account A's config dir and SUCCEEDS against account B's, so we can prove a
// walled claude turn is auto-continued on the next account with headroom.
//
//   npm run build
//   npm run claude-ratelimit-rescue:test
//
// Proves:
//   1. A hits the wall → the turn is rescued on B (final reply comes from B),
//      no error surfaces to the caller ("continue on it" guarantee).
//   2. A walls AND the only other account is over ceiling (no headroom) → the
//      turn fails/rethrows exactly as today (finish/hold; the hopper engine's
//      model-tier ladder takes it from there).
//   3. Single-account setups never attempt a swap — a usage-limit error throws
//      just like before this feature (byte-identical path, guarded by >1 enabled).

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
const USAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-rescue-usage-'));
process.env.CLAUDE_USAGE_DIR = USAGE_DIR;
process.env.HOPPER_GOV_STALE_MIN = '10';

const cfgA = path.join(USAGE_DIR, 'cc-a');
const cfgB = path.join(USAGE_DIR, 'cc-b');

// ── fake `claude`: drains stdin, then branches on CLAUDE_CONFIG_DIR.
//    - account A dir  → exits non-zero with a usage-limit line on stderr (the wall)
//    - account B dir  → a normal stream-json success result
//    - no dir (single account, config_dir null) → also walls, to prove the
//      single-account path just throws (no swap attempted).
const FAKE_BIN = path.join(USAGE_DIR, 'fake-claude.sh');
fs.writeFileSync(
  FAKE_BIN,
  `#!/usr/bin/env bash
cat >/dev/null 2>&1 || true
CFG="\${CLAUDE_CONFIG_DIR:-NONE}"
case "\$CFG" in
  *cc-a) echo "Claude AI usage limit reached - 5-hour limit reached, resets 3pm" >&2; exit 1 ;;
  *cc-b) printf '%s\\n' '{"type":"result","result":"RESCUED_ON_B","session_id":"sess-b"}' ;;
  NONE)  echo "Claude AI usage limit reached - 5-hour limit reached, resets 3pm" >&2; exit 1 ;;
  *)     printf '%s\\n' '{"type":"result","result":"OK_OTHER","session_id":"sess-x"}' ;;
esac
`,
  { mode: 0o755 },
);
process.env.CLAUDE_BIN = FAKE_BIN;
process.env.ANTHROPIC_API_KEY = 'sk-should-be-deleted'; // proves the no-keys strip still runs
delete process.env.CLAUDE_CONFIG_DIR;

console.log(`[rescue-test] scratch DB: ${DB_PATH}`);
console.log(`[rescue-test] usage dir:  ${USAGE_DIR}`);

const distDir = path.join(__dirname, '..', 'dist');
const { processMessage } = await import(path.join(distDir, 'agent.js'));
const { setSetting, deleteSetting } = await import(path.join(distDir, 'conversation-db.js'));

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

let passed = 0, failed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }
function bad(name, err) { failed++; console.log(`  ✗ ${name}\n      ${err?.stack ?? err?.message ?? err}`); }

// ── TEST 1: A walls mid-flight → rescued on B ────────────────────────────────
try {
  setAccounts([{ key: 'a', config_dir: cfgA }, { key: 'b', config_dir: cfgB }]);
  writeUsage('a', 10); // least-used → picked first, then it walls
  writeUsage('b', 20); // headroom → the rescue lands here
  const reply = await processMessage('hello', 'cockpit:rescue-test-1');
  assert.equal(reply, 'RESCUED_ON_B', `expected rescue reply from B, got "${reply}"`);
  ok('A hits the wall → turn auto-continues on B (no error surfaced)');
} catch (e) { bad('rescue onto B', e); }

// ── TEST 2: A walls, B over ceiling (no headroom) → throws (finish/hold) ──────
try {
  setAccounts([{ key: 'a', config_dir: cfgA }, { key: 'b', config_dir: cfgB }]);
  writeUsage('a', 10); // picked first, walls
  writeUsage('b', 96); // over the 90 ceiling → NOT an eligible rescue target
  let threw = false;
  try {
    await processMessage('hello', 'cockpit:rescue-test-2');
  } catch {
    threw = true;
  }
  assert.equal(threw, true, 'expected the turn to fail when no account has headroom');
  ok('A walls + only other account exhausted → fails/holds as today (no rescue)');
} catch (e) { bad('all-exhausted throws', e); }

// ── TEST 3: single account → no swap attempted, usage-limit just throws ───────
try {
  deleteSetting('claude_accounts'); // implicit single account 'a' (config_dir null)
  writeUsage('a', 10);
  let threw = false;
  try {
    await processMessage('hello', 'cockpit:rescue-test-3');
  } catch {
    threw = true;
  }
  assert.equal(threw, true, 'single-account usage-limit error should throw, byte-identical to before');
  ok('single-account → no swap, error throws (byte-identical path)');
} catch (e) { bad('single-account throws', e); }

deleteSetting('claude_accounts');
deleteSetting('gov_5h_ceiling');
fs.rmSync(USAGE_DIR, { recursive: true, force: true });
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

console.log('');
if (failed === 0) {
  console.log(`[rescue-test] ALL ${passed} tests passed ✅`);
  process.exit(0);
} else {
  console.log(`[rescue-test] ${failed} FAILED, ${passed} passed ❌`);
  process.exit(1);
}
