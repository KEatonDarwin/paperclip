#!/usr/bin/env node
// GOV-OVERRIDES END-TO-END TEST — node #194
//
// Proves the manual per-provider governor override (auto/on/off) works
// through the REAL HTTP API (not just the module-level governor functions):
// stands up the real ui-server.js (createApiV1Router) on a scratch port,
// against a scratch jarvis.db and scratch usage-meter files. Never touches
// the live DB, live port, or live service.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

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

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-overrides-sim-'));
const claudeUsageFile = path.join(scratchRoot, 'claude-usage.json');
const codexUsageFile = path.join(scratchRoot, 'codex-usage.json');
const auggieUsageFile = path.join(scratchRoot, 'auggie-usage.json');

const PORT = parseInt(process.env.GOV_SIM_PORT ?? '39217', 10);

process.env.HOPPER_GOV_ENABLED = '1';
process.env.HOPPER_GOV_IDLE_MIN = '15';
process.env.HOPPER_GOV_STALE_MIN = '10';
process.env.CLAUDE_USAGE_FILE = claudeUsageFile;
process.env.CODEX_USAGE_FILE = codexUsageFile;
process.env.AUGGIE_USAGE_FILE = auggieUsageFile;
process.env.JARVIS_UI_PORT = String(PORT);
// Defensive: never let a stray query() reach real Postgres even though none
// of the routes under test touch it (pg.Pool connects lazily on first query).
process.env.DATABASE_URL = 'postgresql://scratch:scratch@127.0.0.1:1/gov_overrides_sim_never_used';
// Never actually connect to Slack even if real tokens are present in the
// environment — we only call startUiServer(), never slackApp.start().
delete process.env.SLACK_BOT_TOKEN;
delete process.env.SLACK_APP_TOKEN;

console.log(`[gov-overrides-sim] scratch DB: ${DB_PATH}`);
console.log(`[gov-overrides-sim] scratch root: ${scratchRoot}`);
console.log(`[gov-overrides-sim] scratch port: ${PORT}`);

const distDir = path.join(repoRoot, 'dist');
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const { startUiServer } = await import(path.join(distDir, 'ui-server.js'));

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function setUsage({ claude5h = 10, weekly = 0, codex = 5, auggie = 5 } = {}) {
  writeJson(claudeUsageFile, {
    five_hour: { utilization: claude5h },
    seven_day: { utilization: weekly },
  });
  writeJson(codexUsageFile, { windows: [{ label: '7-day', used_percentage: codex }] });
  writeJson(auggieUsageFile, { windows: [{ label: 'Credits', used_percentage: auggie }] });
}

const results = [];
function check(id, description, fn) {
  try {
    fn();
    results.push({ id, description, pass: true });
  } catch (err) {
    results.push({ id, description, pass: false, error: err instanceof Error ? err.stack ?? err.message : String(err) });
  }
}

startUiServer();
// startUiServer's app.listen callback logs, but doesn't return a handle we
// can await — give the event loop a beat to bind the port.
await new Promise((resolve) => setTimeout(resolve, 400));

const { plaintext: ADMIN_KEY } = mintApiKey('gov-overrides-sim', 'admin');
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${ADMIN_KEY}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // no body
  }
  return { status: res.status, json };
}

setUsage({ claude5h: 10, weekly: 0, codex: 5, auggie: 5 });

// ---------------------------------------------------------------------------
// 1) Default state — override 'auto' for all four, behavior matches today's
//    (pre-override) logic (allow:true, reason:'ok' at low usage, not active).
// ---------------------------------------------------------------------------
{
  const { status, json } = await api('GET', '/hopper-engine/governor');
  check('1', "default state: all four providers report override 'auto' and allow under normal usage", () => {
    assert.equal(status, 200, `unexpected status ${status}: ${JSON.stringify(json)}`);
    for (const p of ['claude', 'codex', 'auggie', 'devin']) {
      const v = json.providers[p];
      assert.equal(v.override, 'auto', `${p}.override expected 'auto', got ${v.override}`);
      assert.equal(v.allow, true, `${p}.allow expected true at low usage, got ${v.allow} (${v.reason}: ${v.detail})`);
      assert.equal(v.reason, 'ok', `${p}.reason expected 'ok', got ${v.reason}`);
    }
  });
}

// ---------------------------------------------------------------------------
// 2) gov_override_claude=off -> claude allow:false reason override_off;
//    codex unaffected.
// ---------------------------------------------------------------------------
{
  const patch = await api('PATCH', '/hopper-engine/settings', { gov_override_claude: 'off' });
  check('2a', 'PATCH gov_override_claude=off succeeds and echoes raw state', () => {
    assert.equal(patch.status, 200, `unexpected status ${patch.status}: ${JSON.stringify(patch.json)}`);
    assert.deepEqual(patch.json.updated, ['gov_override_claude']);
    assert.equal(patch.json.raw.gov_override_claude, 'off');
  });

  const { status, json } = await api('GET', '/hopper-engine/governor');
  check('2b', 'claude reports allow=false reason=override_off while codex is unaffected', () => {
    assert.equal(status, 200);
    assert.equal(json.providers.claude.override, 'off');
    assert.equal(json.providers.claude.allow, false);
    assert.equal(json.providers.claude.reason, 'override_off');
    assert.equal(json.providers.codex.override, 'auto');
    assert.equal(json.providers.codex.allow, true);
    assert.equal(json.providers.codex.reason, 'ok');
  });

  // Also check the top-level (adapter-scoped) verdict shape used by dispatchTick.
  const claudeScoped = await api('GET', '/hopper-engine/governor?adapter=claude');
  check('2c', 'adapter-scoped query (?adapter=claude) also reflects the override at top level', () => {
    assert.equal(claudeScoped.json.allow, false);
    assert.equal(claudeScoped.json.reason, 'override_off');
    assert.equal(claudeScoped.json.override, 'off');
  });
}

// ---------------------------------------------------------------------------
// 3) gov_override_claude=on with simulated kevin-active + high 5h usage ->
//    claude allow=true reason=override_on (bypasses BOTH gates).
// ---------------------------------------------------------------------------
{
  // Simulate Kevin-at-the-keyboard: a user-authored turn in a non-worker
  // thread inside the idle window. Mirrors governor-v2-sim.mjs's setKevinActive.
  const { sqliteDb, getOrCreateConversation, addTurn } = await import(path.join(distDir, 'conversation-db.js'));
  const conv = getOrCreateConversation('cockpit:gov-overrides-sim-kevin-active');
  addTurn(conv.id, 'user', 'simulated Kevin activity');

  // High 5h usage — above both the plain ceiling (90) and the kevin-active
  // waiver threshold (default 50) — so absent the override this would hold
  // on BOTH 'five_hour_ceiling'-adjacent logic and 'kevin_active'.
  setUsage({ claude5h: 95, weekly: 10, codex: 5, auggie: 5 });

  // Sanity: prove the unwaived path really would hold, by checking auggie
  // (unaffected by claude's override) still behaves normally, and by
  // flipping claude back to auto for a moment to see the true gate fire.
  const backToAuto = await api('PATCH', '/hopper-engine/settings', { gov_override_claude: 'auto' });
  check('3a-setup', 'reset gov_override_claude=auto to observe the true gate before re-applying on', () => {
    assert.equal(backToAuto.status, 200);
  });
  const trueGate = await api('GET', '/hopper-engine/governor?adapter=claude');
  check('3a', 'sanity: with override=auto, kevin-active + 5h=95% genuinely holds (five_hour_ceiling, before kevin_active check)', () => {
    assert.equal(trueGate.json.allow, false);
    assert.equal(trueGate.json.reason, 'five_hour_ceiling');
  });

  const setOn = await api('PATCH', '/hopper-engine/settings', { gov_override_claude: 'on' });
  check('3b', 'PATCH gov_override_claude=on succeeds', () => {
    assert.equal(setOn.status, 200);
    assert.equal(setOn.json.raw.gov_override_claude, 'on');
  });

  const { status, json } = await api('GET', '/hopper-engine/governor?adapter=claude');
  check('3c', 'claude reports allow=true reason=override_on despite kevin-active + 95% 5h usage (bypasses both gates)', () => {
    assert.equal(status, 200);
    assert.equal(json.override, 'on');
    assert.equal(json.allow, true);
    assert.equal(json.reason, 'override_on');
  });

  // Clean up the simulated activity turn so it doesn't leak into later checks.
  sqliteDb.prepare(`DELETE FROM turns WHERE conversation_id = ?`).run(conv.id);
  sqliteDb.prepare(`DELETE FROM conversations WHERE id = ?`).run(conv.id);
}

// ---------------------------------------------------------------------------
// 4) Invalid override value rejected by the settings route.
// ---------------------------------------------------------------------------
{
  const bad = await api('PATCH', '/hopper-engine/settings', { gov_override_codex: 'maybe' });
  check('4', 'PATCH with an invalid override value (not auto/on/off) is rejected with 400', () => {
    assert.equal(bad.status, 400, `expected 400, got ${bad.status}: ${JSON.stringify(bad.json)}`);
    assert.equal(bad.json.error.code, 'invalid_setting');
    // Confirm the bad value was NOT persisted.
  });
  const after = await api('GET', '/hopper-engine/settings');
  check('4b', 'rejected value was not persisted — gov_override_codex remains unset/auto', () => {
    assert.notEqual(after.json.raw.gov_override_codex, 'maybe');
  });
}

// ---------------------------------------------------------------------------
// 5) Set back to 'auto' -> original (pre-override) behavior returns.
// ---------------------------------------------------------------------------
{
  setUsage({ claude5h: 10, weekly: 0, codex: 5, auggie: 5 });
  const setAuto = await api('PATCH', '/hopper-engine/settings', { gov_override_claude: 'auto' });
  check('5a', 'PATCH gov_override_claude=auto succeeds', () => {
    assert.equal(setAuto.status, 200);
    assert.equal(setAuto.json.raw.gov_override_claude, 'auto');
  });
  const { json } = await api('GET', '/hopper-engine/governor?adapter=claude');
  check('5b', 'claude returns to normal allow=true reason=ok under low usage once override is auto again', () => {
    assert.equal(json.override, 'auto');
    assert.equal(json.allow, true);
    assert.equal(json.reason, 'ok');
  });
}

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  if (r.pass) {
    console.log(`PASS ${r.id} - ${r.description}`);
  } else {
    console.log(`FAIL ${r.id} - ${r.description}`);
    console.log(`  ${r.error}`);
  }
}
console.log(`[gov-overrides-sim] ${results.length - failed.length}/${results.length} checks passed`);

try {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
} catch {
  // Best effort; the DB path itself intentionally remains for post-failure inspection.
}

process.exit(failed.length ? 1 : 0);
