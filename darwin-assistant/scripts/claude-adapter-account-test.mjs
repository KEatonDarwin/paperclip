#!/usr/bin/env node
// CLAUDE ADAPTER ⇄ ACCOUNT WIRING TESTS — exercises the REAL runClaude() env
// path (tree-44d2ff4a node #291). No live model calls: CLAUDE_BIN is pointed at
// a tiny fake `claude` that echoes the CLAUDE_CONFIG_DIR / ANTHROPIC_API_KEY it
// was spawned with back as a stream-json result line, so we can assert exactly
// what the adapter injected into the child env.
//
//   npm run build
//   npm run claude-adapter-account:test
//
// Proves:
//   1. Single-account default (no `claude_accounts`) → CLAUDE_CONFIG_DIR is NOT
//      injected (byte-identical single-subscription path), accountKey='a'.
//   2. Two accounts with config_dirs → the least-used one's config_dir IS
//      injected as CLAUDE_CONFIG_DIR, and result.accountKey matches it.
//   3. ANTHROPIC_API_KEY is still deleted from the child env (NO API KEYS).
//   4. claudeFiveHourCeiling() reads settings-KV `gov_5h_ceiling` / env / default 90.

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
const USAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-adapter-usage-'));
process.env.CLAUDE_USAGE_DIR = USAGE_DIR;
process.env.HOPPER_GOV_STALE_MIN = '10';

// ── fake `claude` binary: drains stdin, prints one stream-json result line that
//    reports the env it was spawned with. Set BEFORE importing agent.js because
//    ADAPTERS.claude.bin = process.env.CLAUDE_BIN is read at module load. ───────
const FAKE_BIN = path.join(USAGE_DIR, 'fake-claude.sh');
fs.writeFileSync(
  FAKE_BIN,
  `#!/usr/bin/env bash
cat >/dev/null 2>&1 || true
CFG="\${CLAUDE_CONFIG_DIR:-NONE}"
if [ -n "\${ANTHROPIC_API_KEY:-}" ]; then KEY=SET; else KEY=UNSET; fi
printf '%s\\n' "{\\"type\\":\\"result\\",\\"result\\":\\"CFG=\${CFG}|KEY=\${KEY}\\",\\"session_id\\":\\"sess-test\\"}"
`,
  { mode: 0o755 },
);
process.env.CLAUDE_BIN = FAKE_BIN;
// Prove the guardrail: a stray key in the parent env must be stripped by the adapter.
process.env.ANTHROPIC_API_KEY = 'sk-should-be-deleted';
// Ensure no ambient CLAUDE_CONFIG_DIR leaks into case 1's assertion.
delete process.env.CLAUDE_CONFIG_DIR;

console.log(`[adapter-account-test] scratch DB: ${DB_PATH}`);
console.log(`[adapter-account-test] usage dir:  ${USAGE_DIR}`);

const distDir = path.join(__dirname, '..', 'dist');
const { runClaude } = await import(path.join(distDir, 'agent.js'));
const { claudeFiveHourCeiling } = await import(path.join(distDir, 'claude-accounts.js'));
const { setSetting, deleteSetting } = await import(path.join(distDir, 'conversation-db.js'));

// Drive runClaude through the global-adapter path (no runtime arg) → it
// self-resolves the claude adapter AND self-resolves the account, exactly like a
// one-shot caller (briefings) does.
setSetting('adapter', 'claude');
deleteSetting('model');

let passed = 0;
let failed = 0;
function ok(name) { passed++; console.log(`  ✓ ${name}`); }
function bad(name, err) { failed++; console.log(`  ✗ ${name}\n      ${err?.message ?? err}`); }

function writeUsage(key, fiveHour) {
  const file = key === 'a'
    ? path.join(USAGE_DIR, 'claude-usage-live.json')
    : path.join(USAGE_DIR, `claude-usage-${key}-live.json`);
  fs.writeFileSync(file, JSON.stringify({ five_hour: { utilization: fiveHour }, seven_day: { utilization: 5 } }));
}

// ── Case 1: single-account default — no CLAUDE_CONFIG_DIR injection ───────────
try {
  deleteSetting('claude_accounts');
  writeUsage('a', 10);
  const res = await runClaude('ping');
  assert.equal(res.text, 'CFG=NONE|KEY=UNSET', `expected default account to leave CLAUDE_CONFIG_DIR unset + key deleted, got "${res.text}"`);
  assert.equal(res.accountKey, 'a', `expected accountKey 'a', got ${res.accountKey}`);
  ok("single-account default → CLAUDE_CONFIG_DIR NOT injected, ANTHROPIC_API_KEY deleted, accountKey='a'");
} catch (e) { bad('single-account default', e); }

// ── Case 2: two accounts → least-used config_dir is injected ──────────────────
try {
  const cfgA = path.join(USAGE_DIR, 'cc-a');
  const cfgB = path.join(USAGE_DIR, 'cc-b');
  setSetting('claude_accounts', JSON.stringify([
    { key: 'a', label: 'A', config_dir: cfgA },
    { key: 'b', label: 'B', config_dir: cfgB },
  ]));
  writeUsage('a', 82); // A heavily used
  writeUsage('b', 9);  // B least-used → should win
  const res = await runClaude('ping');
  assert.equal(res.text, `CFG=${cfgB}|KEY=UNSET`, `expected least-used account B's config_dir injected, got "${res.text}"`);
  assert.equal(res.accountKey, 'b', `expected accountKey 'b', got ${res.accountKey}`);
  ok("two accounts → least-used (B) config_dir injected as CLAUDE_CONFIG_DIR, accountKey='b'");
} catch (e) { bad('two-account least-used injection', e); }

// ── Case 3: swap — once B crosses the ceiling, A wins and A's dir is injected ──
try {
  const cfgA = path.join(USAGE_DIR, 'cc-a');
  const cfgB = path.join(USAGE_DIR, 'cc-b');
  setSetting('gov_5h_ceiling', '90');
  setSetting('claude_accounts', JSON.stringify([
    { key: 'a', label: 'A', config_dir: cfgA },
    { key: 'b', label: 'B', config_dir: cfgB },
  ]));
  writeUsage('a', 40);
  writeUsage('b', 95); // B now over the 90 ceiling → ineligible → A wins
  const res = await runClaude('ping');
  assert.equal(res.text, `CFG=${cfgA}|KEY=UNSET`, `expected A's config_dir after B exhausted, got "${res.text}"`);
  assert.equal(res.accountKey, 'a', `expected accountKey 'a', got ${res.accountKey}`);
  ok("account swap → B over ceiling, A selected + A's config_dir injected");
  deleteSetting('gov_5h_ceiling');
} catch (e) { bad('account swap injection', e); }

// ── Case 4: claudeFiveHourCeiling() settings/env/default ──────────────────────
try {
  deleteSetting('gov_5h_ceiling');
  delete process.env.HOPPER_GOV_5H_CEILING;
  assert.equal(claudeFiveHourCeiling(), 90, 'default ceiling should be 90');
  process.env.HOPPER_GOV_5H_CEILING = '77';
  assert.equal(claudeFiveHourCeiling(), 77, 'env HOPPER_GOV_5H_CEILING should apply');
  setSetting('gov_5h_ceiling', '55');
  assert.equal(claudeFiveHourCeiling(), 55, 'settings-KV gov_5h_ceiling should win over env');
  deleteSetting('gov_5h_ceiling');
  delete process.env.HOPPER_GOV_5H_CEILING;
  ok('claudeFiveHourCeiling() honors settings-KV > env > default(90)');
} catch (e) { bad('claudeFiveHourCeiling', e); }

console.log('');
if (failed === 0) {
  console.log(`[adapter-account-test] ALL ${passed} tests passed ✅`);
  process.exit(0);
} else {
  console.log(`[adapter-account-test] ${failed} FAILED, ${passed} passed ❌`);
  process.exit(1);
}
