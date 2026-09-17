#!/usr/bin/env node
// CLAUDE-ACCOUNTS UNIT TESTS — pure-function tests for src/claude-accounts.ts.
// No live data, no model calls, no writes to the live usage files.
//
//   npm run build
//   npm run claude-accounts:test
//
// (drives the compiled dist/, like scripts/spawn-monitor-test.mjs. Importing
// dist/claude-accounts.js pulls in conversation-db.js, which opens a sqlite
// handle at import time, so a JARVIS_DB_PATH scratch guard is required even
// though every assertion runs against fixtures.)
//
// CLAUDE_USAGE_DIR is pointed at a throwaway temp dir BEFORE importing the
// module, so account 'a' resolves to <tmp>/claude-usage-live.json — the LIVE
// /tmp/claude-usage-live.json is never read or written.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function guardDbPath() {
  const raw = process.env.JARVIS_DB_PATH;
  if (!raw || !raw.trim()) {
    console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path before running this script.');
    process.exit(1);
  }
  const resolved = path.resolve(raw);
  const live = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
  if (resolved === live) {
    console.error(`FATAL: refusing to run against the live jarvis.db (${live}). Use a /tmp scratch path.`);
    process.exit(1);
  }
  return resolved;
}

const DB_PATH = guardDbPath();
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

// Throwaway usage dir — set BEFORE the dynamic import so USAGE_DIR picks it up.
const USAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-accounts-usage-'));
process.env.CLAUDE_USAGE_DIR = USAGE_DIR;
// Deterministic staleness threshold for the test (10 min, the production default).
process.env.HOPPER_GOV_STALE_MIN = '10';
console.log(`[claude-accounts-test] scratch DB: ${DB_PATH}`);
console.log(`[claude-accounts-test] usage dir: ${USAGE_DIR}`);

const distDir = path.join(__dirname, '..', 'dist');
const { listClaudeAccounts, readAccountUsage, selectActiveClaudeAccount, usageFilePath } =
  await import(path.join(distDir, 'claude-accounts.js'));
const { setSetting, deleteSetting } = await import(path.join(distDir, 'conversation-db.js'));

// ── fixture helpers ────────────────────────────────────────────────────────
function writeUsage(key, fiveHour, weekly, { ageMinutes = 0 } = {}) {
  const file = usageFilePath(key);
  fs.writeFileSync(
    file,
    JSON.stringify({ five_hour: { utilization: fiveHour }, seven_day: { utilization: weekly } }),
  );
  if (ageMinutes > 0) {
    const t = new Date(Date.now() - ageMinutes * 60_000);
    fs.utimesSync(file, t, t); // backdate mtime → stale
  }
}
function clearUsage() {
  for (const f of fs.readdirSync(USAGE_DIR)) fs.rmSync(path.join(USAGE_DIR, f), { force: true });
}
function setAccounts(arr) {
  setSetting('claude_accounts', JSON.stringify(arr));
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── TEST 1: single-account default (no claude_accounts setting) ─────────────
{
  deleteSetting('claude_accounts');
  clearUsage();
  const accounts = listClaudeAccounts();
  assert.equal(accounts.length, 1, 'exactly one default account');
  assert.equal(accounts[0].key, 'a');
  assert.equal(accounts[0].config_dir, null, "default account maps to ~/.claude (config_dir null)");
  assert.equal(accounts[0].enabled, true);
  // usage file uses the legacy path (byte-identical single-account behavior)
  assert.ok(usageFilePath('a').endsWith('/claude-usage-live.json'));

  writeUsage('a', 40, 55);
  const sel = selectActiveClaudeAccount(90);
  assert.equal(sel.account.key, 'a', 'single healthy account is selected');
  assert.deepEqual(sel.allNames, ['a']);
  assert.equal(sel.perAccount.length, 1);
  assert.equal(sel.perAccount[0].eligible, true);
  ok('single-account default → account a selected');
}

// ── TEST 2: A full → B selected (serial swap) ───────────────────────────────
{
  clearUsage();
  setAccounts([
    { key: 'a', label: 'Claude A' },
    { key: 'b', label: 'Claude B', config_dir: '/home/kevin/.claude-b' },
  ]);
  writeUsage('a', 95, 60); // over the 90 ceiling
  writeUsage('b', 20, 30); // headroom
  const sel = selectActiveClaudeAccount(90);
  assert.equal(sel.account.key, 'b', 'A over ceiling → B selected');
  assert.deepEqual(sel.allNames, ['a', 'b']);
  assert.equal(sel.perAccount.find((e) => e.account.key === 'a').eligible, false);
  assert.equal(sel.perAccount.find((e) => e.account.key === 'b').eligible, true);
  ok('A full → B selected');
}

// ── TEST 3: all full → least-used fallback ("so we still try") ──────────────
{
  clearUsage();
  setAccounts([{ key: 'a' }, { key: 'b' }]);
  writeUsage('a', 96, 60);
  writeUsage('b', 92, 40);
  const sel = selectActiveClaudeAccount(90);
  assert.equal(sel.account.key, 'b', 'all over ceiling → lowest-usage account (b)');
  assert.ok(sel.perAccount.every((e) => e.eligible === false), 'no account eligible');
  ok('all full → least-used (b) fallback');
}

// ── TEST 4: stale file skipped ──────────────────────────────────────────────
{
  clearUsage();
  setAccounts([{ key: 'a' }, { key: 'b' }]);
  writeUsage('a', 5, 10, { ageMinutes: 30 }); // very low usage BUT stale (30m old)
  writeUsage('b', 50, 40); // fresh, under ceiling
  const uA = readAccountUsage('a');
  assert.equal(uA.stale, true, 'backdated file reads as stale');
  const uB = readAccountUsage('b');
  assert.equal(uB.stale, false);
  const sel = selectActiveClaudeAccount(90);
  assert.equal(sel.account.key, 'b', 'stale low-usage A is skipped; fresh B selected');
  assert.equal(sel.perAccount.find((e) => e.account.key === 'a').eligible, false, 'stale = ineligible');
  ok('stale file skipped');
}

// ── TEST 5: parallel spread — least-used wins when BOTH have headroom ────────
// (distinguishes least-used from first-with-headroom; the DESIGN-ADDENDUM behavior)
{
  clearUsage();
  setAccounts([{ key: 'a' }, { key: 'b' }]);
  writeUsage('a', 30, 20); // first in registry order, but MORE used
  writeUsage('b', 10, 15); // less used
  const sel = selectActiveClaudeAccount(90);
  assert.equal(sel.account.key, 'b', 'both under ceiling → least-used (b), not first (a)');
  ok('parallel spread → least-used account wins');
}

// ── TEST 6: robustness — malformed setting falls back to default ────────────
{
  clearUsage();
  setSetting('claude_accounts', 'not json{');
  const accounts = listClaudeAccounts();
  assert.equal(accounts.length, 1, 'malformed JSON → single default account');
  assert.equal(accounts[0].key, 'a');
  // empty array also → default
  setSetting('claude_accounts', '[]');
  assert.equal(listClaudeAccounts().length, 1, 'empty array → single default account');
  // all-disabled → account null, but registry still lists them
  setAccounts([
    { key: 'a', enabled: false },
    { key: 'b', enabled: false },
  ]);
  writeUsage('a', 10, 10);
  writeUsage('b', 10, 10);
  const sel = selectActiveClaudeAccount(90);
  assert.equal(sel.account, null, 'all disabled → no account selected');
  assert.deepEqual(sel.allNames, ['a', 'b']);
  ok('malformed / empty / all-disabled robustness');
}

deleteSetting('claude_accounts');
clearUsage();
fs.rmSync(USAGE_DIR, { recursive: true, force: true });
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
console.log(`\n[claude-accounts-test] ALL ${passed} tests passed ✅`);
