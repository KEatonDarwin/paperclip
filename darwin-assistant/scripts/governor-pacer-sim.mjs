#!/usr/bin/env node
// GOVERNOR-PACER SIMULATION (tree-2482c4ea node #1620, sprint:pacer-governor)
//
//   npm run build
//   npm run governor-pacer:sim
//
// Drives the REAL compiled hopper governor + throttle status against a
// scratch DB, scratch per-account usage files, and a scratch pacer.json
// (via PACER_JSON). Proves the frozen pacer contract end to end: advise mode
// changes nothing; enforce prefers release over hold; hold is skipped only
// when another account allows; flush never crosses the reserve; ceilings stay
// hard; a stale or missing pacer.json is ignored; the throttle status surface
// carries the pace block correctly in every mode.
// Never opens the live jarvis.db, the live /tmp usage files, or
// /home/kevin/window-burn/pacer.json.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// -- scratch DB guard (mirrors governor-multiclaude-sim) --------------------
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

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-pacer-'));

// Env must be set BEFORE importing the compiled modules (module-load consts).
process.env.HOPPER_GOV_ENABLED = '1';
process.env.HOPPER_GOV_IDLE_MIN = '15';
process.env.HOPPER_GOV_STALE_MIN = '10';
process.env.CLAUDE_USAGE_DIR = scratchDir;
process.env.CLAUDE_USAGE_FILE = path.join(scratchDir, 'claude-usage-live.json');
process.env.HOPPER_WORKER_ADAPTER = 'claude';
// ⚡ PACER: never point this at the real /home/kevin/window-burn/pacer.json.
process.env.PACER_JSON = path.join(scratchDir, 'pacer.json');

const distDir = path.join(repoRoot, 'dist');
const convDb = await import(path.join(distDir, 'conversation-db.js'));
const governor = await import(path.join(distDir, 'hopper-governor.js'));
const { fullThrottleStatus } = await import(path.join(distDir, 'throttle-status.js'));
await import(path.join(distDir, 'notifications.js'));
// Module-load DDL only — never call startHopperEngine(). Absent hopper tables
// just make the throttle-status running/caps queries degrade to empty, which
// is fine here since we only assert on the accounts/pace fields.
await import(path.join(distDir, 'hopper-engine.js'));
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
  const ext = 'cockpit:gov-pacer-kevin';
  sqliteDb.prepare(`DELETE FROM turns WHERE conversation_id IN (SELECT id FROM conversations WHERE external_id = ?)`).run(ext);
  sqliteDb.prepare(`DELETE FROM conversations WHERE external_id = ?`).run(ext);
  if (!active) return;
  const c = convDb.getOrCreateConversation(ext);
  convDb.addTurn(c.id, 'user', 'simulated Kevin activity');
}

/** Writes PACER_JSON in the real file's shape. Each value in `entries` is
 *  {recommendation, ts?, reserve?, target?, behind_pace?, headroom_pct?,
 *  minutes_to_reset?}; `ts` defaults to now (fresh). */
function writePacer(entries) {
  const now = new Date().toISOString();
  const out = {};
  for (const [key, e] of Object.entries(entries)) {
    out[key] = {
      now,
      ts: e.ts ?? now,
      projected_at_reset: null,
      minutes_to_reset: e.minutes_to_reset ?? 120,
      target: e.target ?? 95,
      reserve: e.reserve ?? 0,
      behind_pace: e.behind_pace ?? true,
      headroom_pct: e.headroom_pct ?? 50,
      recommendation: e.recommendation,
    };
  }
  fs.writeFileSync(process.env.PACER_JSON, JSON.stringify(out));
}
function removePacer() {
  fs.rmSync(process.env.PACER_JSON, { force: true });
}
function setPacerMode(v) {
  convDb.setSetting('gov_pacer_mode', v);
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

// 1: ADVISE IS INERT.
check('advise mode: pacer advice changes nothing (active_account=a either way)', () => {
  setPacerMode(''); // clears the setting -> default 'advise'
  setAccounts(TWO);
  writeAccountUsage('a', 10);
  writeAccountUsage('b', 40);
  writePacer({ claude_a: { recommendation: 'hold' }, claude_b: { recommendation: 'release' } });
  const v1 = governor.governorStatus('claude');
  assert.equal(v1.active_account, 'a', `expected a; got ${v1.active_account} (${v1.reason}/${v1.detail})`);
  removePacer();
  const v2 = governor.governorStatus('claude');
  assert.equal(v2.active_account, v1.active_account);
  assert.equal(v2.reason, v1.reason);
});

// 2: ENFORCE PREFERS RELEASE OVER HOLD.
check('enforce mode: prefers the release account over the hold account', () => {
  setPacerMode('enforce');
  setAccounts(TWO);
  writeAccountUsage('a', 10);
  writeAccountUsage('b', 40);
  writePacer({ claude_a: { recommendation: 'hold' }, claude_b: { recommendation: 'release' } });
  const v = governor.governorStatus('claude');
  assert.equal(v.allow, true, `expected allow; got ${v.reason} (${v.detail})`);
  assert.equal(v.active_account, 'b');
});

// 3: ALL HOLD NEVER BLOCKS.
check('enforce mode: both accounts on hold never blocks dispatch', () => {
  setPacerMode('enforce');
  setAccounts(TWO);
  writeAccountUsage('a', 10);
  writeAccountUsage('b', 40);
  writePacer({ claude_a: { recommendation: 'hold' }, claude_b: { recommendation: 'hold' } });
  const v = governor.governorStatus('claude');
  assert.equal(v.allow, true, `expected allow; got ${v.reason} (${v.detail})`);
  assert.equal(v.active_account, 'a');
});

// 4: FLUSH RESPECTS THE RESERVE (single default account, legacy path).
check('enforce mode: flush override respects the reserve, not just the ceiling', () => {
  setPacerMode('enforce');
  setAccounts(null); // legacy single-account path
  removeAccountUsage('b');
  setKevinActive(true);

  // (a) usage 85%, reserve 20 -> 85 is NOT < 100-20=80 -> hold kevin_active.
  writeAccountUsage('a', 85);
  writePacer({ claude_a: { recommendation: 'flush', reserve: 20 } });
  const va = governor.governorStatus('claude');
  assert.equal(va.allow, false, `expected hold; got allow (${va.detail})`);
  assert.equal(va.reason, 'kevin_active');

  // (b) usage 70%, reserve 20 -> 70 < 80 -> flush override waives kevin_active.
  writeAccountUsage('a', 70);
  writePacer({ claude_a: { recommendation: 'flush', reserve: 20 } });
  const vb = governor.governorStatus('claude');
  assert.equal(vb.allow, true, `expected allow; got ${vb.reason} (${vb.detail})`);
  assert.match(vb.detail, /pacer flush override/);

  // (c) usage 85%, reserve 0 -> 85 < 100 -> allow (the reserve, not the
  // waiver threshold, is the bound).
  writeAccountUsage('a', 85);
  writePacer({ claude_a: { recommendation: 'flush', reserve: 0 } });
  const vc = governor.governorStatus('claude');
  assert.equal(vc.allow, true, `expected allow; got ${vc.reason} (${vc.detail})`);

  setKevinActive(false);
});

// 5: CEILINGS ARE STILL HARD.
check('enforce mode: a flush pacer can never spend past the 5h ceiling', () => {
  setPacerMode('enforce');
  setAccounts(null);
  writePacer({ claude_a: { recommendation: 'flush', reserve: 0 } });

  setKevinActive(true);
  writeAccountUsage('a', 95); // >= gov_5h_ceiling (90)
  const v1 = governor.governorStatus('claude');
  assert.equal(v1.allow, false);
  assert.equal(v1.reason, 'five_hour_ceiling');

  setKevinActive(false);
  const v2 = governor.governorStatus('claude');
  assert.equal(v2.allow, false);
  assert.equal(v2.reason, 'five_hour_ceiling');
});

// 6: FLUSH IS A LAST RESORT.
check('enforce mode: flush override does not fire when another account can serve', () => {
  setPacerMode('enforce');
  setAccounts(TWO);
  writeAccountUsage('a', 70);
  writeAccountUsage('b', 10);
  writePacer({
    claude_a: { recommendation: 'flush', reserve: 20 },
    claude_b: { recommendation: 'release' },
  });
  setKevinActive(true);
  const v = governor.governorStatus('claude');
  assert.equal(v.allow, true, `expected allow; got ${v.reason} (${v.detail})`);
  assert.equal(v.active_account, 'b');
  assert.doesNotMatch(v.detail, /pacer flush override/);
  setKevinActive(false);
});

// 7: STALE PACER IS IGNORED.
check('enforce mode: a stale (>15m) pacer.json is ignored, same as no pacer', () => {
  setPacerMode('enforce');
  setAccounts(TWO);
  writeAccountUsage('a', 10);
  writeAccountUsage('b', 40);
  const staleTs = new Date(Date.now() - 20 * 60_000).toISOString();
  writePacer({ claude_a: { recommendation: 'hold', ts: staleTs } });
  const v = governor.governorStatus('claude');
  assert.equal(v.active_account, 'a', `expected a; got ${v.active_account} (${v.reason}/${v.detail})`);
});

// 8: MISSING PACER IS IGNORED.
check('enforce mode: a missing pacer.json never throws and is ignored', () => {
  setPacerMode('enforce');
  setAccounts(TWO);
  writeAccountUsage('a', 10);
  writeAccountUsage('b', 40);
  removePacer();
  const v = governor.governorStatus('claude');
  assert.equal(v.allow, true, `expected allow; got ${v.reason} (${v.detail})`);
  assert.equal(v.active_account, 'a');
});

// 9: STATUS SURFACE.
check('throttle status surfaces the pace block and per-account advice', () => {
  setPacerMode('enforce');
  setAccounts(TWO);
  setKevinActive(false);
  writeAccountUsage('a', 10);
  writeAccountUsage('b', 40);
  writePacer({ claude_a: { recommendation: 'hold' }, claude_b: { recommendation: 'release' } });

  const status1 = fullThrottleStatus();
  assert.equal(status1.pace.mode, 'enforce');
  assert.equal(typeof status1.pace.selection_note, 'string');
  assert.ok(status1.pace.selection_note.includes('a') && status1.pace.selection_note.includes('b'),
    `selection_note should name both accounts: ${status1.pace.selection_note}`);
  assert.ok(status1.accounts.length > 0, 'expected at least one account in the status payload');
  for (const acct of status1.accounts) {
    assert.ok(acct.pace && typeof acct.pace === 'object', `account ${acct.key} missing pace object`);
    assert.equal(typeof acct.pace.fresh, 'boolean');
    assert.ok(typeof acct.pace.sentence === 'string' && acct.pace.sentence.length > 0, `account ${acct.key} missing pace sentence`);
  }
  const gv1 = governor.governorStatus('claude');
  assert.ok(gv1.claude_accounts[0].pace && typeof gv1.claude_accounts[0].pace === 'object');

  setPacerMode('off');
  const status2 = fullThrottleStatus();
  assert.equal(status2.pace.mode, 'off');
  for (const acct of status2.accounts) assert.equal(acct.pace, null);
  const gv2 = governor.governorStatus('claude');
  assert.equal(gv2.claude_accounts[0].pace, null);

  setPacerMode('');
  const status3 = fullThrottleStatus();
  assert.equal(status3.pace.mode, 'advise');
  assert.equal(status3.pace.selection_note, null);
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
console.log(`\n[governor-pacer-sim] ${results.length - failed}/${results.length} checks passed`);
fs.rmSync(scratchDir, { recursive: true, force: true });
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
process.exit(failed === 0 ? 0 : 1);
