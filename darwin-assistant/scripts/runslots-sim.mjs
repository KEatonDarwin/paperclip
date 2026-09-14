#!/usr/bin/env node
// FOUNDRY GO v2 RUN-SLOTS LIFECYCLE SIMULATION — drives the real engine + real
// HTTP API (foundry.ts + handlers/api-v1.ts + ui-server.ts) against a scratch
// DB, a scratch UI port, and real spawned `python3 -m http.server` occupant
// processes. Never touches the live service, the live jarvis.db, or ports
// 4310-4312.
//
// Two phases, run as two SEPARATE `node` process invocations against the SAME
// scratch DB file — this is what actually proves BOOT RECONCILE (not just the
// 10s health tick), and it has to be two truly independent OS processes (not
// a parent that spawnSync-blocks waiting on a child) so that phase 1 fully
// exits before phase 2 starts, exactly like a real jarvis.service restart:
//
//   node scripts/runslots-sim.mjs                    # phase 1
//   RUNSLOTS_SIM_PHASE2=1 node scripts/runslots-sim.mjs   # phase 2
//
// (run `npm run build` first — this drives the compiled dist/, not tsx.)
// `npm run runslots:sim` runs both phases back to back and merges the report.

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHASE = process.env.RUNSLOTS_SIM_PHASE2 === '1' ? 2 : 1;

// ---------------------------------------------------------------------------
// GUARDS — must run before any dist/ module is imported (conversation-db.js
// reads JARVIS_DB_PATH at import time and opens the sqlite handle immediately).
// ---------------------------------------------------------------------------
const LIVE_DB = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
const DB_PATH = path.resolve(process.env.JARVIS_DB_PATH || `/tmp/runslots-sim.db`);
if (DB_PATH === LIVE_DB) {
  console.error(`FATAL: refusing to run against the live jarvis.db (${LIVE_DB}). Use a /tmp scratch path.`);
  process.exit(1);
}
if (PHASE === 1) fs.rmSync(DB_PATH, { force: true });
process.env.JARVIS_DB_PATH = DB_PATH;
console.log(`[runslots-sim] phase ${PHASE} — scratch DB: ${DB_PATH}`);

const UI_PORT = parseInt(process.env.JARVIS_UI_PORT || (PHASE === 1 ? '39231' : '39232'), 10);
if (UI_PORT === 3201) {
  console.error('FATAL: refusing to bind the live UI port 3201. Pick a throwaway port.');
  process.exit(1);
}
process.env.JARVIS_UI_PORT = String(UI_PORT);
console.log(`[runslots-sim] phase ${PHASE} — scratch UI port: ${UI_PORT}`);

// Scratch run-slot ports, never the live 4310-4312 defaults.
const SLOT_PORTS = [48310, 48311, 48312];
if (SLOT_PORTS.some((p) => [4310, 4311, 4312, 3201].includes(p))) {
  console.error('FATAL: refusing to reuse a live port for scratch run slots.');
  process.exit(1);
}
process.env.FOUNDRY_RUN_PORTS = SLOT_PORTS.join(',');
console.log(`[runslots-sim] scratch run-slot ports: ${SLOT_PORTS.join(',')}`);

const REPO_ROOT = path.resolve('/tmp/runslots-sim-repos');
const STATE_FILE = path.join(REPO_ROOT, 'state.json');
const RESULTS_FILE = path.join(REPO_ROOT, `phase${PHASE}-results.json`);
if (PHASE === 1) {
  fs.rmSync(REPO_ROOT, { recursive: true, force: true });
  fs.mkdirSync(REPO_ROOT, { recursive: true });
}
console.log(`[runslots-sim] scratch project repos: ${REPO_ROOT}`);

const BASE_URL = `http://127.0.0.1:${UI_PORT}`;
const PREVIEW_HOST = '127.0.0.1';

// Dynamic imports ONLY after the guards pass.
const distDir = path.join(__dirname, '..', 'dist');
const uiServer = await import(path.join(distDir, 'ui-server.js'));
const apiKeys = await import(path.join(distDir, 'api-keys.js'));
const convDb = await import(path.join(distDir, 'conversation-db.js'));
const foundry = await import(path.join(distDir, 'foundry.js'));

const { sqliteDb } = convDb;

// ---------------------------------------------------------------------------
// Results table
// ---------------------------------------------------------------------------
const results = [];
async function checkAsync(id, description, fn) {
  try {
    await fn();
    results.push({ id, description, pass: true });
    console.log(`  [PASS] ${id}: ${description}`);
  } catch (err) {
    results.push({ id, description, pass: false, error: err instanceof Error ? err.message : String(err) });
    console.log(`  [FAIL] ${id}: ${description}\n         ${err instanceof Error ? err.stack : err}`);
  }
}

foundry.startFoundry();
uiServer.startUiServer();

// ---------------------------------------------------------------------------
// HTTP helpers — real network calls against the scratch server.
// ---------------------------------------------------------------------------
const { plaintext: API_KEY } = apiKeys.mintApiKey(`runslots-sim-phase${PHASE}`, 'admin');

async function httpFetch(pathAndQuery, init = {}) {
  const res = await fetch(`${BASE_URL}${pathAndQuery}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${pathAndQuery}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}
const httpGet = (p) => httpFetch(p);
const httpPost = (p, json) => httpFetch(p, { method: 'POST', body: JSON.stringify(json ?? {}) });

async function waitFor(fn, { timeoutMs = 20_000, intervalMs = 300, label = 'condition' } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms${lastErr ? `; last error: ${lastErr.message}` : ''}`);
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Kill the WHOLE process group, not just the recorded pid. The recorded pid
// is `/bin/sh -c "<run_command>"` (spawn's shell:true wrapper) — a plain
// `process.kill(pid, 'SIGKILL')` only kills that shell and leaves its real
// child (e.g. python3) orphaned-but-alive on the port, since SIGKILL gives sh
// no chance to forward the signal. This is what a genuine crash/OOM-kill of
// the whole occupant looks like, and it's what "manually kill a slot's pid"
// in the spec means. See SIM-RESULTS.md finding F-2 for what happens if only
// the shell dies (a real, separate limitation this script deliberately does
// NOT reproduce here).
function killProcessTree(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
  }
}

// A process we (or the server) just SIGTERM/SIGKILL'd goes through a brief
// zombie window ("Z" state, `<defunct>`) before its parent's event loop gets
// a chance to reap it — kill(pid,0) reports a zombie as "alive" until reaped.
// See SIM-RESULTS.md finding F-1: this window is normally <100ms once the
// event loop is free to run, but callers must poll rather than assume the
// pid vanishes the instant a kill/stop call returns.
async function waitForDead(pid, { timeoutMs = 3_000, label = 'pid death' } = {}) {
  return waitFor(async () => !pidAlive(pid), { timeoutMs, intervalMs: 25, label });
}

function orphanHttpServerCount() {
  try {
    const out = execSync(`pgrep -f "http.server (${SLOT_PORTS.join('|')})"`, { encoding: 'utf8' });
    return out.split('\n').map((l) => l.trim()).filter(Boolean).length;
  } catch (err) {
    // pgrep exits 1 with empty stdout when nothing matches.
    if (err.status === 1) return 0;
    throw err;
  }
}

async function fetchStatus(url) {
  const res = await fetch(url);
  return res.status;
}

// Wait for the scratch HTTP server to actually accept connections before
// hitting it — app.listen()'s callback fires async relative to our import.
await waitFor(
  async () => {
    try {
      await httpGet('/api/v1/foundry/run-slots');
      return true;
    } catch {
      return false;
    }
  },
  { timeoutMs: 10_000, label: 'server up' },
);
console.log(`[runslots-sim] phase ${PHASE} scratch server is up`);

// =============================================================================
// PHASE 2 — fresh, independent process, same scratch DB. Proves boot reconcile.
// =============================================================================
if (PHASE === 2) {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

  await checkAsync('7-2', 'boot reconcile (fresh process, same DB) marks slot 2 dead from the out-of-band kill', async () => {
    const { slots } = await httpGet('/api/v1/foundry/run-slots');
    const s2 = slots.find((s) => s.slot_no === 2);
    assert.equal(s2.status, 'dead', 'slot 2 should be reconciled to dead at boot, not left as stale "running"');
    assert.equal(s2.pid, null);
    assert.equal(s2.project_id, state.projD, 'occupant metadata should be preserved on the dead row');
  });

  await checkAsync('7-3', 'boot reconcile leaves already-stopped slot 1 as stopped', async () => {
    const { slots } = await httpGet('/api/v1/foundry/run-slots');
    const s1 = slots.find((s) => s.slot_no === 1);
    assert.equal(s1.status, 'stopped');
    assert.equal(s1.pid, null);
  });

  await checkAsync('7-4', 'boot reconcile leaves already-dead slot 3 as dead', async () => {
    const { slots } = await httpGet('/api/v1/foundry/run-slots');
    const s3 = slots.find((s) => s.slot_no === 3);
    assert.equal(s3.status, 'dead');
    assert.equal(s3.pid, null);
  });

  // Final cleanup — kill every spawned process from either phase before finishing.
  for (const pid of [state.slot1Pid, state.slot2PidReplacement, state.slot3Pid]) {
    if (pidAlive(pid)) {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* not a group leader / already dead */ }
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  const remainingOrphans = orphanHttpServerCount();
  await checkAsync('8-1', 'no orphan http.server processes remain on the scratch ports after cleanup', async () => {
    assert.equal(remainingOrphans, 0, `expected 0 orphan http.server processes, found ${remainingOrphans}`);
  });

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results));
  const failCount = results.filter((r) => !r.pass).length;
  console.log(`\n[runslots-sim] phase 2: ${results.length - failCount}/${results.length} checks passed.`);
  process.exit(failCount > 0 ? 1 : 0);
}

// =============================================================================
// PHASE 1
// =============================================================================

// Seed a fake "ready" foundry project directly in the DB (no planner run —
// this node tests run-slot mechanics, not the blueprint pipeline).
const insertReadyProjectStmt = sqliteDb.prepare(`
  INSERT INTO foundry_projects (id, name, prompt, repo_path, base_branch, status, run_command)
  VALUES (?, ?, 'sim fixture', ?, 'main', 'ready', ?)
`);
let projectSeq = 0;
function seedReadyProject(label) {
  projectSeq += 1;
  const id = `runslots-sim-${label}-${projectSeq}`;
  const repoPath = path.join(REPO_ROOT, id);
  fs.mkdirSync(repoPath, { recursive: true });
  insertReadyProjectStmt.run(id, `Sim ${label}`, repoPath, 'python3 -m http.server {{port}}');
  return id;
}

// ===========================================================================
// 0 — baseline: three free slots
// ===========================================================================
await checkAsync('0-1', 'GET /foundry/run-slots returns exactly three free slots at boot', async () => {
  const { slots } = await httpGet('/api/v1/foundry/run-slots');
  assert.equal(slots.length, 3);
  assert.deepEqual(slots.map((s) => s.slot_no), [1, 2, 3]);
  assert.deepEqual(slots.map((s) => s.status), ['free', 'free', 'free']);
  assert.deepEqual(slots.map((s) => s.port), SLOT_PORTS);
});

// ===========================================================================
// 1 — GO with no slot_no fills slot 1
// ===========================================================================
let projA, slot1Pid, previewA;
await checkAsync('1-1', 'GO (no slot_no) on project A allocates slot 1, spawns a real process, curl 200s', async () => {
  projA = seedReadyProject('a');
  const res = await httpPost(`/api/v1/foundry/projects/${projA}/go`, {});
  assert.equal(res.launched, true);
  assert.equal(res.slot.slot_no, 1);
  assert.equal(res.slot.port, SLOT_PORTS[0]);
  assert.equal(res.slot.status, 'running');
  assert.ok(res.slot.pid > 0);
  assert.equal(res.preview_url, `http://${PREVIEW_HOST}:${SLOT_PORTS[0]}`);
  assert.equal(res.project.preview_url, res.preview_url);
  slot1Pid = res.slot.pid;
  previewA = res.preview_url;
  assert.ok(pidAlive(slot1Pid), 'spawned pid should be alive immediately after GO');

  const status = await waitFor(() => fetchStatus(previewA), { label: 'slot 1 http 200' });
  assert.equal(status, 200);
});

await checkAsync('1-2', 'GET /foundry/run-slots shows slot 1 occupied by project A with a preview_url', async () => {
  const { slots } = await httpGet('/api/v1/foundry/run-slots');
  const s1 = slots.find((s) => s.slot_no === 1);
  assert.equal(s1.project_id, projA);
  assert.equal(s1.status, 'running');
  assert.equal(s1.pid, slot1Pid);
  assert.equal(s1.preview_url, previewA);
});

// ===========================================================================
// 2 — two more projects fill slots 2-3
// ===========================================================================
let projB, projC, slot2PidOriginal, slot3Pid;
await checkAsync('2-1', 'GO project B (no slot_no) allocates slot 2', async () => {
  projB = seedReadyProject('b');
  const res = await httpPost(`/api/v1/foundry/projects/${projB}/go`, {});
  assert.equal(res.slot.slot_no, 2);
  assert.equal(res.slot.port, SLOT_PORTS[1]);
  slot2PidOriginal = res.slot.pid;
  await waitFor(() => fetchStatus(`http://${PREVIEW_HOST}:${SLOT_PORTS[1]}`), { label: 'slot 2 http 200' });
});

await checkAsync('2-2', 'GO project C (no slot_no) allocates slot 3', async () => {
  projC = seedReadyProject('c');
  const res = await httpPost(`/api/v1/foundry/projects/${projC}/go`, {});
  assert.equal(res.slot.slot_no, 3);
  assert.equal(res.slot.port, SLOT_PORTS[2]);
  slot3Pid = res.slot.pid;
  await waitFor(() => fetchStatus(`http://${PREVIEW_HOST}:${SLOT_PORTS[2]}`), { label: 'slot 3 http 200' });
});

// ===========================================================================
// 3 — a 4th GO with all slots busy -> 409 foundry_slots_full with occupants
// ===========================================================================
let projD;
await checkAsync('3-1', 'a 4th GO with no target and all slots running -> 409 foundry_slots_full with occupant list', async () => {
  projD = seedReadyProject('d');
  let rejected = null;
  try {
    await httpPost(`/api/v1/foundry/projects/${projD}/go`, {});
  } catch (err) {
    rejected = err;
  }
  assert.ok(rejected, 'GO should have been rejected while all 3 slots are busy');
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body?.error?.code, 'foundry_slots_full');
  const slots = rejected.body.error.slots;
  assert.equal(slots.length, 3);
  const bySlot = Object.fromEntries(slots.map((s) => [s.slot_no, s]));
  assert.equal(bySlot[1].project_id, projA);
  assert.equal(bySlot[2].project_id, projB);
  assert.equal(bySlot[3].project_id, projC);
  assert.equal(bySlot[1].pid, slot1Pid);
  assert.equal(bySlot[2].pid, slot2PidOriginal);
  assert.equal(bySlot[3].pid, slot3Pid);
});

// ===========================================================================
// 4 — GO with replace on slot 2: old process actually dead, new one serving
// ===========================================================================
let slot2PidReplacement;
await checkAsync('4-1', 'GO project D targeting slot 2 without replace -> 409 foundry_slot_occupied', async () => {
  let rejected = null;
  try {
    await httpPost(`/api/v1/foundry/projects/${projD}/go`, { slot_no: 2 });
  } catch (err) {
    rejected = err;
  }
  assert.ok(rejected);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body?.error?.code, 'foundry_slot_occupied');
});

await checkAsync('4-2', 'GO project D targeting slot 2 with replace=true evicts B and serves D', async () => {
  assert.ok(pidAlive(slot2PidOriginal), 'sanity: project B pid should still be alive before replace');
  const t0 = Date.now();
  const res = await httpPost(`/api/v1/foundry/projects/${projD}/go`, { slot_no: 2, replace: true });
  console.log(`         (GO+replace round trip took ${Date.now() - t0}ms — see SIM-RESULTS.md finding F-1)`);
  assert.equal(res.slot.slot_no, 2);
  assert.equal(res.slot.project_id, projD);
  assert.equal(res.slot.status, 'running');
  slot2PidReplacement = res.slot.pid;
  assert.notEqual(slot2PidReplacement, slot2PidOriginal, 'replacement pid must differ from the evicted pid');
});

await checkAsync('4-3', 'old project B pid is actually dead after replace (kill -0 eventually fails)', async () => {
  await waitForDead(slot2PidOriginal, { label: 'evicted project B pid' });
});

await checkAsync('4-4', 'new project D process on slot 2 is alive and serving http 200', async () => {
  assert.ok(pidAlive(slot2PidReplacement));
  const status = await waitFor(() => fetchStatus(`http://${PREVIEW_HOST}:${SLOT_PORTS[1]}`), { label: 'slot 2 replacement http 200' });
  assert.equal(status, 200);
});

// ===========================================================================
// 5 — stop endpoint frees the slot and the process group is gone
// ===========================================================================
await checkAsync('5-1', 'POST /foundry/run-slots/1/stop frees slot 1 and kills the process group (no orphan)', async () => {
  assert.ok(pidAlive(slot1Pid), 'sanity: project A pid should still be alive before stop');
  const t0 = Date.now();
  const { slot } = await httpPost('/api/v1/foundry/run-slots/1/stop', {});
  console.log(`         (stop round trip took ${Date.now() - t0}ms — see SIM-RESULTS.md finding F-1)`);
  assert.equal(slot.slot_no, 1);
  assert.equal(slot.status, 'stopped');
  assert.equal(slot.pid, null);
  await waitForDead(slot1Pid, { label: 'stopped project A pid' });
  const status = await fetchStatus(`http://${PREVIEW_HOST}:${SLOT_PORTS[0]}`).catch(() => null);
  assert.equal(status, null, 'slot 1 port should no longer accept connections');
});

await checkAsync('5-2', 'GET /foundry/run-slots reflects slot 1 as stopped', async () => {
  const { slots } = await httpGet('/api/v1/foundry/run-slots');
  const s1 = slots.find((s) => s.slot_no === 1);
  assert.equal(s1.status, 'stopped');
  assert.equal(s1.pid, null);
});

// ===========================================================================
// 6 — kill a slot pid manually -> health sweep marks it dead within ~15s
// ===========================================================================
await checkAsync('6-1', 'manually killing slot 3 occupant pid -> health tick marks the slot dead within ~15s', async () => {
  assert.ok(pidAlive(slot3Pid), 'sanity: project C pid should still be alive before manual kill');
  killProcessTree(slot3Pid, 'SIGKILL');
  const startedAt = Date.now();
  const got = await waitFor(
    async () => {
      const { slots } = await httpGet('/api/v1/foundry/run-slots');
      const s3 = slots.find((s) => s.slot_no === 3);
      return s3.status === 'dead' ? s3 : null;
    },
    { timeoutMs: 16_000, intervalMs: 500, label: 'slot 3 marked dead by health tick' },
  );
  const elapsedMs = Date.now() - startedAt;
  assert.equal(got.pid, null);
  console.log(`         (health tick marked slot 3 dead after ${elapsedMs}ms)`);
});

// ===========================================================================
// 7-1 — kill project D's slot-2 occupant out-of-band (simulating a death that
// happens while the service is down), then this process fully exits so a
// genuinely independent phase-2 process can prove boot reconcile.
// ===========================================================================
await checkAsync('7-1', 'kill project D (slot 2) out-of-band while the service is "down"', async () => {
  const { slots } = await httpGet('/api/v1/foundry/run-slots');
  const s2 = slots.find((s) => s.slot_no === 2);
  assert.equal(s2.status, 'running');
  assert.equal(s2.pid, slot2PidReplacement);
  killProcessTree(slot2PidReplacement, 'SIGKILL');
  await waitForDead(slot2PidReplacement, { label: 'out-of-band-killed project D pid' });
});

fs.writeFileSync(STATE_FILE, JSON.stringify({
  projA, projB, projC, projD,
  slot1Pid, slot2PidOriginal, slot2PidReplacement, slot3Pid,
}));
fs.writeFileSync(RESULTS_FILE, JSON.stringify(results));

const failCount = results.filter((r) => !r.pass).length;
console.log(`\n[runslots-sim] phase 1: ${results.length - failCount}/${results.length} checks passed.`);
console.log('[runslots-sim] phase 1 complete — this process is exiting now. Run phase 2 as a SEPARATE');
console.log('  process (RUNSLOTS_SIM_PHASE2=1 node scripts/runslots-sim.mjs) to prove boot reconcile.');
process.exit(failCount > 0 ? 1 : 0);
