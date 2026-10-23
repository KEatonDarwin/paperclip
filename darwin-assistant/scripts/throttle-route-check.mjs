#!/usr/bin/env node
// ⚡ THROTTLE ROUTE CHECK — exercises the REAL Express router (CONTRACT §7.3)
// end to end over real HTTP on a throwaway port against a scratch DB.
// Covers the layer scripts/throttle-check.mjs (module-level) cannot:
// auth posture (AC-17), the one-call GET payload, PATCH all-or-nothing +
// clamping, and preset apply/404. No model calls, no live DB.
//
//   npm run build && npm run throttle:route-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const raw = process.env.JARVIS_DB_PATH;
if (!raw?.trim()) { console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path.'); process.exit(1); }
const DB_PATH = path.resolve(raw);
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.'); process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
process.env.CLAUDE_USAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'throttle-route-usage-'));

const distDir = path.join(__dirname, '..', 'dist');
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const { getSetting } = await import(path.join(distDir, 'conversation-db.js'));

const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
async function req(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const admin = mintApiKey('throttle-route-admin', 'admin').plaintext;
const plain = mintApiKey('throttle-route-plain', 'jarvis').plaintext;
let pass = 0; const ok = (m) => { console.log(`  ✓ ${m}`); pass++; };

const { sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));
const settingsSnapshot = () =>
  JSON.stringify(sqliteDb.prepare('SELECT key, value FROM settings ORDER BY key').all());

try {
  // AC-16 (fresh-DB half) — the presets were seeded at ROUTER CREATION, so the
  // very FIRST GET on a fresh DB is already pure. Seeding inside the GET handler
  // would make first-GET a settings write, which is exactly what AC-16 forbids.
  assert.ok(getSetting('throttle_presets') != null, 'presets must be seeded at router creation, not by GET');
  const freshSnap = settingsSnapshot();
  assert.equal((await req('GET', '/throttle', { token: plain })).status, 200);
  assert.equal(settingsSnapshot(), freshSnap, 'the FIRST GET /throttle on a fresh DB must not write any setting');
  ok('AC-16 fresh-DB: presets seeded at router creation; the very first GET writes nothing');

  // AC-17 — auth posture.
  assert.equal((await req('GET', '/throttle')).status, 401);
  assert.equal((await req('GET', '/throttle', { token: plain })).status, 200);
  const p403 = await req('PATCH', '/throttle', { token: plain, body: { hopper_slots: 5 } });
  assert.equal(p403.status, 403); assert.equal(p403.json.error.code, 'admin_scope_required');
  const pre403 = await req('POST', '/throttle/preset', { token: plain, body: { name: 'turned_up' } });
  assert.equal(pre403.status, 403);
  assert.ok(getSetting('hopper_slots') == null, 'a 403 must write nothing');
  ok('AC-17 auth: GET open to any key, PATCH/preset 403 non-admin and write nothing');

  // §7.3 — the GET carries everything the UI needs in ONE call.
  const g = (await req('GET', '/throttle', { token: plain })).json;
  for (const k of ['dials','clamps','stop_loss','admission','running','accounts','providers','hold','reroutes','presets','presets_source'])
    assert.ok(g[k] !== undefined, `GET /throttle missing '${k}'`);
  assert.equal(g.dials.throttle_claude_mode, 'auto');
  assert.equal(g.dials.throttle_max_per_goal, 0);
  assert.equal(g.clamps.stop_loss_max, 98);
  assert.ok(typeof g.hold.dispatching === 'boolean' && typeof g.hold.reason === 'string');
  assert.equal(Object.keys(g.presets).length, 4);
  ok('§7.3 GET returns the whole one-call payload at documented defaults');

  // §1.3 — clamping is reported, not silently applied.
  const pc = await req('PATCH', '/throttle', { token: admin, body: { hopper_slots: 99, gov_5h_ceiling: 100 } });
  assert.equal(pc.status, 200);
  assert.equal(getSetting('hopper_slots'), '12');
  assert.equal(getSetting('gov_5h_ceiling'), '98');
  assert.ok(pc.json.clamped.some((c) => c.key === 'hopper_slots' && String(c.stored) === '12'));
  assert.ok(pc.json.clamped.some((c) => c.key === 'gov_5h_ceiling' && String(c.stored) === '98'));
  ok('§1.3 rails: slots→12 and stop-loss→98, both reported in `clamped`');

  // §2 — a slot write raises admission through the route.
  assert.ok(Number(getSetting('max_concurrent_auto_turns')) >= 14, 'admission floor should have been raised');
  assert.equal(pc.json.admission.satisfied, true);
  ok('§2 admission floor raised by the PATCH route itself');

  // §1.3 rule 1 — unknown key rejects the WHOLE request.
  const before = getSetting('throttle_max_per_goal');
  const bad = await req('PATCH', '/throttle', { token: admin, body: { throttle_max_per_goal: 2, nonsense_key: 1 } });
  assert.equal(bad.status, 400); assert.equal(bad.json.error.code, 'invalid_setting');
  assert.equal(getSetting('throttle_max_per_goal'), before, 'no partial write on rejection');
  ok('§1.3 an unknown key 400s and writes NOTHING (no partial writes)');

  // §7.3 — gov_override_* is not settable through the throttle.
  const ov = await req('PATCH', '/throttle', { token: admin, body: { gov_override_claude: 'off' } });
  assert.equal(ov.status, 400);
  assert.ok(getSetting('gov_override_claude') == null);
  ok('§7.3 gov_override_* is rejected by the throttle API');

  // §6.3 — preset apply + unknown name.
  const ap = await req('POST', '/throttle/preset', { token: admin, body: { name: 'turned_up' } });
  assert.equal(ap.status, 200);
  assert.equal(getSetting('hopper_slots'), '6');
  assert.equal(getSetting('throttle_max_per_goal'), '2');
  assert.equal(getSetting('throttle_claude_mode'), 'ordered');
  assert.equal(getSetting('throttle_preset'), 'turned_up');
  assert.equal(ap.json.dials.throttle_preset, 'turned_up');
  const nf = await req('POST', '/throttle/preset', { token: admin, body: { name: 'nope' } });
  assert.equal(nf.status, 404); assert.equal(nf.json.error.code, 'unknown_preset');
  ok('§6.3 preset turned_up applies its dials + sets throttle_preset; unknown name → 404');

  // AC-16 — GET is pure (steady-state half; the fresh-DB half ran first).
  const snap = settingsSnapshot();
  for (let i = 0; i < 25; i++) await req('GET', '/throttle', { token: plain });
  assert.equal(settingsSnapshot(), snap, 'GET /throttle must not mutate any setting');
  ok('AC-16 25× GET /throttle mutates no settings row');

  console.log(`\n[throttle-route-check] ${pass}/${pass} checks passed`);
} catch (e) {
  console.error(`\n[throttle-route-check] FAILED: ${e.message}`); process.exitCode = 1;
} finally { server.close(); }
