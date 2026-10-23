#!/usr/bin/env node
// MULTI-CLAUDE END-TO-END DRY RUN (tree-44d2ff4a node #295)
//
//   npm run build
//   npm run multi-claude:e2e-sim
//
// Ties the THREE modules built by nodes #290-294 into ONE flow per scenario —
// selector (claude-accounts.ts) + governor (hopper-governor.ts) + adapter
// (agent.ts runClaude, via a fake `claude` binary that echoes back the env it
// was spawned with) — on a scratch DB + scratch/stub usage files. No live
// login, no jarvis.service restart, no real model call.
//
// Covers exactly the 4 scenarios from the node #295 spec:
//   1. Default single account  → adapter leaves CLAUDE_CONFIG_DIR unset,
//      governor behaves identically to the pre-multi-account gate.
//   2. Two accounts, A 5h=95% B 5h=10% → selector picks B, governor allows
//      with active_account=b, adapter injects CLAUDE_CONFIG_DIR=<B's dir>.
//   3. Both accounts ≥ ceiling → governor holds with claude_all_accounts_full.
//   4. One account's usage file is stale → it is skipped (never selected).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-claude-e2e-'));
process.env.CLAUDE_USAGE_DIR = scratchDir;
process.env.HOPPER_GOV_ENABLED = '1';
process.env.HOPPER_GOV_IDLE_MIN = '15';
process.env.HOPPER_GOV_STALE_MIN = '10';
process.env.HOPPER_WORKER_ADAPTER = 'claude';

// Fake `claude` binary — drains stdin, reports the env it was spawned with.
// Set CLAUDE_BIN BEFORE importing agent.js (ADAPTERS.claude.bin reads it at
// module load). No network, no real model call, no live auth touched.
const FAKE_BIN = path.join(scratchDir, 'fake-claude.sh');
fs.writeFileSync(
  FAKE_BIN,
  `#!/usr/bin/env bash
cat >/dev/null 2>&1 || true
CFG="\${CLAUDE_CONFIG_DIR:-NONE}"
if [ -n "\${ANTHROPIC_API_KEY:-}" ]; then KEY=SET; else KEY=UNSET; fi
printf '%s\\n' "{\\"type\\":\\"result\\",\\"result\\":\\"CFG=\${CFG}|KEY=\${KEY}\\",\\"session_id\\":\\"sess-e2e\\"}"
`,
  { mode: 0o755 },
);
process.env.CLAUDE_BIN = FAKE_BIN;
process.env.ANTHROPIC_API_KEY = 'sk-should-be-deleted'; // prove the adapter still strips it
delete process.env.CLAUDE_CONFIG_DIR;

console.log(`[multi-claude-e2e-sim] scratch DB:  ${DB_PATH}`);
console.log(`[multi-claude-e2e-sim] scratch dir: ${scratchDir}`);

const distDir = path.join(repoRoot, 'dist');
const convDb = await import(path.join(distDir, 'conversation-db.js'));
const governor = await import(path.join(distDir, 'hopper-governor.js'));
const accounts = await import(path.join(distDir, 'claude-accounts.js'));
const { runClaude } = await import(path.join(distDir, 'agent.js'));
const { sqliteDb, setSetting, deleteSetting } = convDb;

setSetting('adapter', 'claude');
deleteSetting('model');

// ── helpers ──────────────────────────────────────────────────────────────
function writeUsage(key, five, weekly = 0, ageMinutes = 0) {
  const file = accounts.usageFilePath(key);
  fs.writeFileSync(file, `${JSON.stringify({ five_hour: { utilization: five }, seven_day: { utilization: weekly } })}\n`);
  if (ageMinutes > 0) {
    const t = (Date.now() - ageMinutes * 60_000) / 1000;
    fs.utimesSync(file, t, t);
  }
}
function removeUsage(key) {
  fs.rmSync(accounts.usageFilePath(key), { force: true });
}
function setAccounts(arr) {
  if (arr == null) deleteSetting('claude_accounts');
  else setSetting('claude_accounts', JSON.stringify(arr));
}
function setKevinActive(active) {
  const ext = 'cockpit:e2e-sim-kevin';
  sqliteDb.prepare(`DELETE FROM turns WHERE conversation_id IN (SELECT id FROM conversations WHERE external_id = ?)`).run(ext);
  sqliteDb.prepare(`DELETE FROM conversations WHERE external_id = ?`).run(ext);
  if (!active) return;
  const c = convDb.getOrCreateConversation(ext);
  convDb.addTurn(c.id, 'user', 'simulated Kevin activity');
}
setKevinActive(false);
setSetting('gov_5h_ceiling', '90');
setSetting('gov_weekly_ceiling', '30');
setSetting('gov_weekly_mode', 'soft');

const cfgA = path.join(scratchDir, 'cc-a');
const cfgB = path.join(scratchDir, 'cc-b');
const TWO = [
  { key: 'a', label: 'Claude A', config_dir: cfgA, enabled: true },
  { key: 'b', label: 'Claude B', config_dir: cfgB, enabled: true },
];

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

// ── Scenario 1: default single account ──────────────────────────────────
await scenario('1. Default single account → adapter CLAUDE_CONFIG_DIR unset, governor byte-identical to legacy gate', async () => {
  setAccounts(null);
  removeUsage('b');
  writeUsage('a', 12, 5);

  const sel = accounts.selectActiveClaudeAccount(accounts.claudeFiveHourCeiling());
  assert.equal(sel.account?.key, 'a');
  assert.equal(sel.account?.config_dir, null);

  const gov = governor.governorStatus('claude');
  assert.equal(gov.allow, true, `expected allow; got ${gov.reason} (${gov.detail})`);
  assert.equal(gov.reason, 'ok');
  assert.equal(gov.active_account, 'a');
  assert.match(gov.detail, /clear to dispatch/, 'legacy detail string must be preserved verbatim');

  const res = await runClaude('ping');
  assert.equal(res.text, 'CFG=NONE|KEY=UNSET', `adapter must NOT inject CLAUDE_CONFIG_DIR for the default account, got "${res.text}"`);
  assert.equal(res.accountKey, 'a');
});

// ── Scenario 2: A=95% B=10% → selector/governor/adapter all pick B ───────
await scenario('2. Two accounts A=95% B=10% → selector picks B, governor allows active_account=b, adapter injects CLAUDE_CONFIG_DIR=B', async () => {
  setAccounts(TWO);
  writeUsage('a', 95);
  writeUsage('b', 10);

  const sel = accounts.selectActiveClaudeAccount(accounts.claudeFiveHourCeiling());
  assert.equal(sel.account?.key, 'b');
  assert.equal(sel.account?.config_dir, cfgB);

  const gov = governor.governorStatus('claude');
  assert.equal(gov.allow, true, `expected allow; got ${gov.reason} (${gov.detail})`);
  assert.equal(gov.active_account, 'b');
  assert.equal(gov.five_hour, 10);

  const res = await runClaude('ping');
  assert.equal(res.text, `CFG=${cfgB}|KEY=UNSET`, `adapter must inject B's config_dir, got "${res.text}"`);
  assert.equal(res.accountKey, 'b');
});

// ── Scenario 3: both ≥ ceiling → governor holds ──────────────────────────
await scenario('3. Both accounts ≥ ceiling → governor holds claude_all_accounts_full (no worker dispatched)', async () => {
  setAccounts(TWO);
  writeUsage('a', 95);
  writeUsage('b', 92);

  // selectActiveClaudeAccount always hands back a best-effort FALLBACK pick
  // (see its docstring) — it is the GOVERNOR's job to refuse to dispatch when
  // nothing is truly eligible, not the selector returning null. Assert the
  // eligibility flags are correctly all-false, and that the governor (the
  // thing an actual dispatch loop consults) holds.
  const sel = accounts.selectActiveClaudeAccount(accounts.claudeFiveHourCeiling());
  assert.equal(sel.perAccount.every((e) => e.eligible === false), true, 'no account should be eligible when both are over ceiling');

  const gov = governor.governorStatus('claude');
  assert.equal(gov.allow, false);
  assert.equal(gov.reason, 'claude_all_accounts_full');
  assert.equal(gov.active_account, null);
  // A worker dispatch loop consults governorCheck (not the selector) before
  // ever calling runClaude — confirm the same verdict from that entry point.
  assert.equal(governor.governorCheck('claude').allow, false);
});

// ── Scenario 4: a stale usage file is skipped ────────────────────────────
await scenario('4. One account stale (usage file >10min old) → skipped, other account with headroom wins', async () => {
  setAccounts(TWO);
  writeUsage('a', 20, 0, 30); // fresh headroom but STALE (30 min old)
  writeUsage('b', 55, 0, 0); // fresher, more used, but readable

  const sel = accounts.selectActiveClaudeAccount(accounts.claudeFiveHourCeiling());
  assert.equal(sel.account?.key, 'b', 'stale account a must be skipped even though its recorded % is lower');
  const aEntry = sel.perAccount.find((e) => e.account.key === 'a');
  assert.equal(aEntry.usage.stale, true);
  assert.equal(aEntry.eligible, false);

  const gov = governor.governorStatus('claude');
  assert.equal(gov.allow, true, `expected allow via b; got ${gov.reason} (${gov.detail})`);
  assert.equal(gov.active_account, 'b');

  const res = await runClaude('ping');
  assert.equal(res.text, `CFG=${cfgB}|KEY=UNSET`);
  assert.equal(res.accountKey, 'b');
});

// ── Scenario 4b: ALL accounts stale → governor holds usage_stale (not full) ─
await scenario('4b. All accounts stale → governor holds usage_stale (selector finds nothing eligible)', async () => {
  setAccounts(TWO);
  writeUsage('a', 10, 0, 30);
  writeUsage('b', 10, 0, 30);

  const sel = accounts.selectActiveClaudeAccount(accounts.claudeFiveHourCeiling());
  assert.equal(sel.perAccount.every((e) => e.usage.stale === true && e.eligible === false), true);

  const gov = governor.governorStatus('claude');
  assert.equal(gov.allow, false);
  assert.equal(gov.reason, 'usage_stale');
});

// ── report ───────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass).length;
console.log(`\n[multi-claude-e2e-sim] ${results.length - failed}/${results.length} scenarios passed`);
fs.rmSync(scratchDir, { recursive: true, force: true });
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
process.exit(failed === 0 ? 0 : 1);
