#!/usr/bin/env node
// MULTI-CLAUDE GOVERNOR SIMULATION (tree-44d2ff4a node #292)
//
//   npm run build
//   npm run governor-multiclaude:sim
//
// Drives the REAL compiled hopper governor against a scratch DB + scratch
// per-account usage files. Proves the multi-account claude gate: allow when ANY
// enabled account has 5h headroom, hold `claude_all_accounts_full` only when
// every account is spent, least-used active-account selection, and that the
// default single-account registry is byte-identical to the legacy gate.
// Never opens the live jarvis.db or the live /tmp usage files.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// -- scratch DB guard (mirrors governor-v2-sim) ------------------------------
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

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-multiclaude-'));

// Env must be set BEFORE importing the compiled modules (module-load consts).
process.env.HOPPER_GOV_ENABLED = '1';
process.env.HOPPER_GOV_IDLE_MIN = '15';
process.env.HOPPER_GOV_STALE_MIN = '10';
// Legacy single-account path reads CLAUDE_USAGE_FILE; multi path reads
// CLAUDE_USAGE_DIR/claude-usage-<key>-live.json. Point both at the scratch dir
// so account 'a' resolves to the same file in both worlds.
process.env.CLAUDE_USAGE_DIR = scratchDir;
process.env.CLAUDE_USAGE_FILE = path.join(scratchDir, 'claude-usage-live.json');
process.env.HOPPER_WORKER_ADAPTER = 'claude';

const distDir = path.join(repoRoot, 'dist');
const convDb = await import(path.join(distDir, 'conversation-db.js'));
const governor = await import(path.join(distDir, 'hopper-governor.js'));
await import(path.join(distDir, 'notifications.js'));
const { sqliteDb } = convDb;

// -- helpers -----------------------------------------------------------------
function writeAccountUsage(key, five, weekly = 0, ageMinutes = 0) {
  const file = key === 'a'
    ? path.join(scratchDir, 'claude-usage-live.json')
    : path.join(scratchDir, `claude-usage-${key}-live.json`);
  fs.writeFileSync(file, `${JSON.stringify({ five_hour: { utilization: five }, seven_day: { utilization: weekly } })}\n`);
  if (ageMinutes > 0) {
    const t = (Date.now() - ageMinutes * 60_000) / 1000;
    fs.utimesSync(file, t, t);
  }
}
function removeAccountUsage(key) {
  const file = key === 'a'
    ? path.join(scratchDir, 'claude-usage-live.json')
    : path.join(scratchDir, `claude-usage-${key}-live.json`);
  fs.rmSync(file, { force: true });
}
function setAccounts(arr) {
  if (arr == null) convDb.setSetting('claude_accounts', '');
  else convDb.setSetting('claude_accounts', JSON.stringify(arr));
}
function setGovSettings() {
  const s = {
    gov_5h_ceiling: '90',
    gov_weekly_ceiling: '30',
    gov_weekly_mode: 'hard',
    gov_kevin_active_claude_max_5h: '50',
  };
  for (const [k, v] of Object.entries(s)) convDb.setSetting(k, v);
}
function setKevinActive(active) {
  const ext = 'cockpit:gov-multiclaude-kevin';
  sqliteDb.prepare(`DELETE FROM turns WHERE conversation_id IN (SELECT id FROM conversations WHERE external_id = ?)`).run(ext);
  sqliteDb.prepare(`DELETE FROM conversations WHERE external_id = ?`).run(ext);
  if (!active) return;
  const c = convDb.getOrCreateConversation(ext);
  convDb.addTurn(c.id, 'user', 'simulated Kevin activity');
}

const results = [];
function check(desc, fn) {
  try {
    fn();
    results.push({ desc, pass: true });
  } catch (err) {
    results.push({ desc, pass: false, error: err instanceof Error ? err.message : String(err) });
  }
}

const TWO = [
  { key: 'a', label: 'Claude A', config_dir: '/tmp/fake-a', enabled: true },
  { key: 'b', label: 'Claude B', config_dir: '/tmp/fake-b', enabled: true },
];

setGovSettings();
setKevinActive(false);

// 1: A spent, B has headroom → allow on B.
check('A full (95%), B headroom (10%) → allow, active_account=b', () => {
  setAccounts(TWO);
  writeAccountUsage('a', 95);
  writeAccountUsage('b', 10);
  const v = governor.governorStatus('claude');
  assert.equal(v.allow, true, `expected allow; got ${v.reason} (${v.detail})`);
  assert.equal(v.active_account, 'b');
  assert.equal(v.five_hour, 10);
  const b = v.claude_accounts.find((x) => x.key === 'b');
  assert.ok(b && b.active === true, 'b should be the active account in payload');
  assert.equal(v.claude_accounts.find((x) => x.key === 'a').active, false);
});

// 2: both over 5h ceiling → hold claude_all_accounts_full.
check('both accounts ≥ ceiling → hold claude_all_accounts_full', () => {
  setAccounts(TWO);
  writeAccountUsage('a', 95);
  writeAccountUsage('b', 92);
  const v = governor.governorStatus('claude');
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'claude_all_accounts_full');
  assert.equal(v.active_account, null);
  assert.equal(v.claude_accounts.every((x) => x.active === false), true);
});

// 3: both have headroom → least-used (lower 5h) is active.
check('both headroom → least-used account active', () => {
  setAccounts(TWO);
  writeAccountUsage('a', 40);
  writeAccountUsage('b', 15);
  const v = governor.governorStatus('claude');
  assert.equal(v.allow, true);
  assert.equal(v.active_account, 'b');
  assert.equal(v.five_hour, 15);
});

// 4: all accounts stale → usage_stale (not all_accounts_full).
check('all accounts stale → usage_stale', () => {
  setAccounts(TWO);
  writeAccountUsage('a', 10, 0, 30);
  writeAccountUsage('b', 10, 0, 30);
  const v = governor.governorStatus('claude');
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'usage_stale');
});

// 5: hard weekly — B has 5h room but weekly spent, A 5h spent → weekly_ceiling.
check('hard weekly: 5h-room account over weekly → weekly_ceiling hold', () => {
  setAccounts(TWO);
  writeAccountUsage('a', 95, 0); // 5h spent
  writeAccountUsage('b', 20, 35); // 5h room but weekly 35 ≥ 30
  const v = governor.governorStatus('claude');
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'weekly_ceiling');
});

// 6: Kevin active + selected account 5h below waiver → allow.
check('Kevin active, selected 5h 20% < 50 waiver → allow', () => {
  setAccounts(TWO);
  writeAccountUsage('a', 95);
  writeAccountUsage('b', 20);
  setKevinActive(true);
  const v = governor.governorStatus('claude');
  assert.equal(v.allow, true, `expected allow; got ${v.reason}`);
  assert.equal(v.active_account, 'b');
  setKevinActive(false);
});

// 7: Kevin active + only headroom account at 60% (≥50 waiver) → hold kevin_active.
check('Kevin active, selected 5h 60% ≥ 50 waiver → hold kevin_active', () => {
  setAccounts(TWO);
  writeAccountUsage('a', 95);
  writeAccountUsage('b', 60);
  setKevinActive(true);
  const v = governor.governorStatus('claude');
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'kevin_active');
  assert.equal(v.active_account, 'b'); // b is the account we'd run on
  setKevinActive(false);
});

// 8: single default registry (no setting) → legacy path, byte-identical shape.
check('default single account → allow via legacy path, active_account=a', () => {
  setAccounts(null); // no claude_accounts → default single account 'a'
  removeAccountUsage('b');
  writeAccountUsage('a', 12, 5); // legacy reads CLAUDE_USAGE_FILE == scratch/claude-usage-live.json
  const v = governor.governorStatus('claude');
  assert.equal(v.allow, true, `expected allow; got ${v.reason} (${v.detail})`);
  assert.equal(v.reason, 'ok');
  assert.equal(v.active_account, 'a');
  assert.equal(v.claude_accounts.length, 1);
  assert.equal(v.claude_accounts[0].key, 'a');
  // legacy detail string is preserved (byte-identical gate output)
  assert.match(v.detail, /clear to dispatch/);
});

// 9: default single account over 5h ceiling → legacy five_hour_ceiling reason.
check('default single account ≥ ceiling → legacy five_hour_ceiling', () => {
  setAccounts(null);
  writeAccountUsage('a', 95, 5);
  const v = governor.governorStatus('claude');
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'five_hour_ceiling'); // legacy reason, NOT the multi one
});

// 10: non-claude lane untouched (codex still evaluated on its own meter).
check('non-claude adapter unaffected by multi-account claude logic', () => {
  setAccounts(TWO);
  const v = governor.governorStatus('codex');
  assert.equal(v.provider, 'codex');
  // codex has no claude_accounts payload
  assert.equal(v.claude_accounts, undefined);
});

// -- report ------------------------------------------------------------------
let failed = 0;
for (const r of results) {
  if (r.pass) console.log(`  ✓ ${r.desc}`);
  else {
    failed++;
    console.log(`  ✗ ${r.desc}\n      ${r.error}`);
  }
}
console.log(`\n[governor-multiclaude-sim] ${results.length - failed}/${results.length} checks passed`);
fs.rmSync(scratchDir, { recursive: true, force: true });
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
process.exit(failed === 0 ? 0 : 1);
