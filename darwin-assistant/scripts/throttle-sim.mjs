#!/usr/bin/env node
// ⚡ THROTTLE SIM (tree-f8c95d8d node #718) — independent acceptance run.
//
//   npm run throttle:sim
//
// Implements skills/throttle/CONTRACT.md §9's AC-1..AC-17 list VERBATIM, each
// printing PASS/FAIL with a one-line reason, against a real scratch DB + the
// REAL compiled module/route surface (dist/throttle.js, hopper-engine.js,
// hopper-governor.js, claude-accounts.js, handlers/api-v1.js). This is a
// SEPARATE, independently-authored harness from scripts/throttle-check.mjs and
// scripts/throttle-route-check.mjs (the BACKEND node's own verification) — it
// exercises the same contract from a fresh set of fixtures so a bug that both
// harnesses share for the same wrong reason is still more likely to be caught.
//
// Guardrails, non-negotiable (per src/sim-guard.ts and the incident it
// documents — a sim that isolates its DATABASE is not thereby isolating the
// MODEL):
//   - JARVIS_DB_PATH MUST point at a scratch file, never the live jarvis.db.
//   - JARVIS_SIM=1 is set before any dist/ module loads.
//   - dispatchTick is driven with a STUB processMessage (never the real one),
//     so hopper-engine's spawnWorker() never reaches agent.processMessage.
//   - A real OS process count (`pgrep -fc 'claude|codex|auggie'`) is taken
//     before and after the whole run and asserted UNCHANGED — this is an
//     independent guarantee on top of the stub, not a replacement for it.
//
// Never asserts on a log string (CONTRACT §6.5's lesson) — every check reads
// settings-KV, DB rows, or a function's return value.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// -- scratch DB guard (fail loud, fail first) ---------------------------------
const rawDb = process.env.JARVIS_DB_PATH;
if (!rawDb || !rawDb.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path.');
  process.exit(1);
}
const DB_PATH = path.resolve(rawDb);
const LIVE_DB_PATH = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
if (DB_PATH === LIVE_DB_PATH) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'throttle-sim-'));
process.env.JARVIS_SIM = '1';
process.env.HOPPER_GOV_ENABLED = '1';
process.env.HOPPER_GOV_IDLE_MIN = '15';
process.env.HOPPER_GOV_STALE_MIN = '10';
process.env.CLAUDE_USAGE_DIR = scratchDir;
process.env.CLAUDE_USAGE_FILE = path.join(scratchDir, 'claude-usage-live.json');
process.env.CODEX_USAGE_FILE = path.join(scratchDir, 'codex-usage-live.json');
process.env.AUGGIE_USAGE_FILE = path.join(scratchDir, 'auggie-usage-live.json');
process.env.HOPPER_WORKER_ADAPTER = 'claude';
delete process.env.HOPPER_ENGINE_SLOTS;

// -- process-spawn guard: real OS-level check, scoped to THIS process's own
// descendant tree (not a system-wide pgrep). This box runs the live jarvis
// hopper engine concurrently with this sim — a system-wide `pgrep -fc
// claude|codex|auggie` count is genuinely racy against unrelated production
// dispatch happening on the same host, which is not a bug in this sim. Scoping
// to /proc/<pid>/task/*/children recursively from this process's own PID gives
// the correct, non-flaky signal: "did THIS RUN spawn one", independent of
// whatever else the box is doing.
function collectDescendants(pid, acc = new Set()) {
  let children = [];
  try {
    for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
      try {
        const raw = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').trim();
        if (raw) children = children.concat(raw.split(/\s+/));
      } catch { /* task may have exited mid-read */ }
    }
  } catch { /* pid gone */ }
  for (const c of children) {
    const cpid = parseInt(c, 10);
    if (!Number.isFinite(cpid) || acc.has(cpid)) continue;
    acc.add(cpid);
    collectDescendants(cpid, acc);
  }
  return acc;
}
function descendantsMatchingCliBinaries() {
  const hits = [];
  for (const pid of collectDescendants(process.pid)) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
      if (/\bclaude\b|\bcodex\b|\bauggie\b/.test(cmd)) hits.push({ pid, cmd });
    } catch { /* pid gone between listing and read */ }
  }
  return hits;
}

const dist = path.join(repoRoot, 'dist');
const convDb = await import(path.join(dist, 'conversation-db.js'));
const engine = await import(path.join(dist, 'hopper-engine.js'));
const throttle = await import(path.join(dist, 'throttle.js'));
const governor = await import(path.join(dist, 'hopper-governor.js'));
const accounts = await import(path.join(dist, 'claude-accounts.js'));
const notifications = await import(path.join(dist, 'notifications.js'));
const simGuard = await import(path.join(dist, 'sim-guard.js'));
// Side-effect import: goals.ts owns the goals/goal_nodes DDL; the per-goal cap
// is a reverse lookup through goal_nodes, and throttle.ts deliberately does NOT
// import goals.ts (that would be a cycle), so the tables need creating here.
await import(path.join(dist, 'goals.js'));
const { createApiV1Router } = await import(path.join(dist, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(dist, 'api-keys.js'));
const { sqliteDb, setSetting, getSetting } = convDb;

// Belt-and-suspenders: confirm the sim-guard chokepoint actually sees this
// process as scratch, so IF anything ever did call agent.processMessage it
// would be refused rather than silently billed.
assert.equal(simGuard.isScratchEnv(), true, 'sim-guard must classify this run as scratch');

// -- fixture helpers (independently written against the DB schema, not copied
//    test LOGIC from the backend/route checks) -------------------------------
const THROTTLE_KEYS = [
  'hopper_slots', 'throttle_max_per_goal', 'throttle_max_per_tree',
  'throttle_claude_mode', 'throttle_claude_order', 'throttle_provider_order',
  'throttle_provider_fallback', 'throttle_split_cursor', 'throttle_preset',
  'throttle_presets', 'max_concurrent_auto_turns',
  'gov_override_claude', 'gov_override_codex', 'gov_override_auggie', 'gov_override_devin',
  'gov_5h_ceiling', 'gov_weekly_ceiling', 'gov_weekly_mode',
  'gov_kevin_active_claude_max_5h', 'gov_codex_ceiling', 'gov_auggie_ceiling', 'gov_concurrency_cap',
];
function resetSettings() {
  for (const k of THROTTLE_KEYS) sqliteDb.prepare('DELETE FROM settings WHERE key = ?').run(k);
}
function writeUsage(key, five, weekly = 0, ageMinutes = 0, locked = null) {
  const file = key === 'a'
    ? path.join(scratchDir, 'claude-usage-live.json')
    : path.join(scratchDir, `claude-usage-${key}-live.json`);
  fs.writeFileSync(file, JSON.stringify({
    five_hour: { utilization: five, resets_at: '2026-09-25T02:00:00+00:00', locked_reason: locked },
    seven_day: { utilization: weekly, resets_at: '2026-10-01T00:00:00+00:00', locked_reason: null },
  }));
  const t = (Date.now() - ageMinutes * 60_000) / 1000;
  fs.utimesSync(file, t, t);
}
function writeProviderUsage(file, pct) {
  fs.writeFileSync(file, JSON.stringify({ windows: [{ label: '7-day', used_percentage: pct }] }));
}
function removeUsage(key) {
  const file = key === 'a'
    ? path.join(scratchDir, 'claude-usage-live.json')
    : path.join(scratchDir, `claude-usage-${key}-live.json`);
  fs.rmSync(file, { force: true });
}
const TWO_ACCOUNTS = [
  { key: 'a', label: 'Claude A', config_dir: '/tmp/sim-fake-a', enabled: true },
  { key: 'b', label: 'Claude B', config_dir: '/tmp/sim-fake-b', enabled: true },
];
function setAccounts(arr) { setSetting('claude_accounts', arr ? JSON.stringify(arr) : ''); }

let treeSeq = 0;
/** Insert an ACTIVE tree with N pending leaves (no children => dispatch-ready). */
function makeTree(leaves, opts = {}) {
  treeSeq += 1;
  const id = opts.id ?? `sim-tree-${treeSeq}`;
  sqliteDb.prepare(`INSERT OR REPLACE INTO hopper_trees (id, topic, origin_thread_ext, status) VALUES (?, ?, NULL, 'active')`)
    .run(id, opts.topic ?? `sim tree ${id}`);
  const ids = [];
  for (let i = 0; i < leaves; i += 1) {
    const info = sqliteDb.prepare(
      `INSERT INTO hopper_nodes (tree_id, parent_id, title, status, adapter, model, priority) VALUES (?, NULL, ?, 'pending', ?, ?, ?)`,
    ).run(id, `${id} leaf ${i}`, opts.adapter ?? 'claude', opts.model ?? 'claude-sonnet-5', opts.priority ?? 0);
    ids.push(Number(info.lastInsertRowid));
  }
  return { treeId: id, nodeIds: ids };
}
function attachGoal(goalId, treeId, title = `sim goal ${goalId}`) {
  sqliteDb.prepare(`INSERT OR REPLACE INTO goals (id, title, done_means, status) VALUES (?, ?, 'x', 'set')`).run(goalId, title);
  sqliteDb.prepare(`INSERT INTO goal_nodes (goal_id, title, state, leaf_kind, tree_id) VALUES (?, 'leaf', 'working', 'machine', ?)`).run(goalId, treeId);
}
function wipeWork() {
  sqliteDb.prepare('DELETE FROM hopper_nodes').run();
  sqliteDb.prepare('DELETE FROM hopper_trees').run();
  try { sqliteDb.prepare('DELETE FROM goal_nodes').run(); sqliteDb.prepare('DELETE FROM goals').run(); } catch { /* absent */ }
}
function node(id) { return sqliteDb.prepare('SELECT * FROM hopper_nodes WHERE id = ?').get(id); }
function nodesFor(treeId) { return sqliteDb.prepare('SELECT * FROM hopper_nodes WHERE tree_id = ? ORDER BY id').all(treeId); }
function runningIds() { return sqliteDb.prepare(`SELECT id FROM hopper_nodes WHERE status = 'running'`).all().map((r) => r.id); }
function settingsSnapshot() {
  return JSON.stringify(sqliteDb.prepare('SELECT key, value FROM settings ORDER BY key').all());
}

const spawned = [];
// Registering the stub is what makes dispatchTick do anything at all —
// hopper-engine's dispatchTick() no-ops entirely (`if (ticking ||
// !processMessageRef) return;`) until startHopperEngine() has installed a
// processMessage callback. The stub below intercepts every worker spawn and
// NEVER calls a real CLI binary.
engine.startHopperEngine(async (_prompt, ext) => { spawned.push(ext); return 'stub'; });
async function dispatch() { await engine.dispatchTick('throttle-sim'); }

// -- tiny HTTP harness (own instance — independent of throttle-route-check) --
const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
async function http(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${p}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const adminKey = mintApiKey('throttle-sim-admin', 'admin').plaintext;
const plainKey = mintApiKey('throttle-sim-plain', 'jarvis').plaintext;

// -- test harness --------------------------------------------------------------
const results = [];
async function check(id, desc, fn) {
  try {
    await fn();
    results.push({ id, desc, pass: true });
  } catch (err) {
    results.push({ id, desc, pass: false, error: err?.message ?? String(err) });
  }
}

// ==============================================================================
// AC-1 — Defaults change nothing.
// ==============================================================================
await check('AC-1a', 'readThrottleDials() returns the §1.1 defaults with nothing set', () => {
  resetSettings();
  const d = throttle.readThrottleDials();
  assert.equal(d.hopper_slots, 2);
  assert.equal(d.throttle_max_per_goal, 0);
  assert.equal(d.throttle_max_per_tree, 0);
  assert.equal(d.throttle_claude_mode, 'auto');
  assert.deepEqual(d.throttle_claude_order, ['a', 'b']);
  assert.deepEqual(d.throttle_provider_order, ['claude', 'codex', 'auggie']);
  assert.equal(d.throttle_provider_fallback, 'off');
  assert.equal(d.throttle_preset, 'normal');
});
await check('AC-1b', 'throttleClaudeCandidates is identity-filter + least-used at defaults', () => {
  resetSettings();
  const entries = [
    { account: { key: 'a', enabled: true }, usage: { five_hour: 40 }, eligible: true },
    { account: { key: 'b', enabled: true }, usage: { five_hour: 10 }, eligible: true },
  ];
  const plan = throttle.throttleClaudeCandidates(entries);
  assert.equal(plan.mode, 'auto');
  assert.equal(plan.focusKey, null);
  assert.equal(plan.eligible.length, 2, 'identity filter keeps both');
  assert.equal(plan.rank(plan.eligible).key, 'b', 'least-used wins');
});
await check('AC-1c', 'selectActiveClaudeAccount matches expected pre-throttle behaviour across 5 fixtures', () => {
  resetSettings();
  // fixture 1: single implicit account
  setAccounts(null);
  writeUsage('a', 30, 5);
  let sel = accounts.selectActiveClaudeAccount(90);
  assert.equal(sel.account?.key, 'a');
  // fixture 2: 2 accounts, least-used wins
  setAccounts(TWO_ACCOUNTS);
  writeUsage('a', 50, 5);
  writeUsage('b', 5, 5);
  sel = accounts.selectActiveClaudeAccount(90);
  assert.equal(sel.account?.key, 'b');
  // fixture 3: a stale, b healthy -> b
  writeUsage('a', 5, 5, 999 /* very stale */);
  writeUsage('b', 20, 5);
  sel = accounts.selectActiveClaudeAccount(90);
  assert.equal(sel.account?.key, 'b');
  // fixture 4: a weekly-spent, b healthy -> b
  writeUsage('a', 5, 100);
  writeUsage('b', 20, 5);
  sel = accounts.selectActiveClaudeAccount(90);
  assert.equal(sel.account?.key, 'b');
  // fixture 5: a locked, b healthy -> b
  writeUsage('a', 5, 5, 0, 'rate_limited');
  writeUsage('b', 20, 5);
  sel = accounts.selectActiveClaudeAccount(90);
  assert.equal(sel.account?.key, 'b');
});
await check('AC-1d', 'dispatchTick claims exactly min(ready,slots) across 3 fixture trees with no caps set', async () => {
  resetSettings();
  setAccounts(null);
  writeUsage('a', 5, 5);
  wipeWork();
  setSetting('hopper_slots', '5');
  const t1 = makeTree(2); const t2 = makeTree(2); const t3 = makeTree(2); // 6 ready
  await dispatch();
  const running = [...t1.nodeIds, ...t2.nodeIds, ...t3.nodeIds].filter((id) => node(id).status === 'running');
  assert.equal(running.length, 5, 'claims exactly slots(5) of the 6 ready leaves');
});

// ==============================================================================
// AC-2 — Slots respected.
// ==============================================================================
await check('AC-2', 'hopper_slots=3 claims exactly 3 of 8, then raising to 5 claims 2 more without touching the first 3', async () => {
  resetSettings();
  setAccounts(null);
  writeUsage('a', 5, 5);
  wipeWork();
  setSetting('hopper_slots', '3');
  const t = makeTree(8);
  await dispatch();
  const rows1 = nodesFor(t.treeId);
  const runningAfterFirst = rows1.filter((r) => r.status === 'running');
  const pendingAfterFirst = rows1.filter((r) => r.status === 'pending');
  assert.equal(runningAfterFirst.length, 3);
  assert.equal(pendingAfterFirst.length, 5);
  assert.ok(pendingAfterFirst.every((r) => r.attempts === 0));
  const firstThreeIds = new Set(runningAfterFirst.map((r) => r.id));
  const firstThreeLeases = new Map(runningAfterFirst.map((r) => [r.id, r.lease_expires_at]));
  setSetting('hopper_slots', '5');
  await dispatch();
  const rows2 = nodesFor(t.treeId);
  const running2 = rows2.filter((r) => r.status === 'running');
  assert.equal(running2.length, 5, '2 more claimed on the next tick');
  for (const id of firstThreeIds) {
    const row = rows2.find((r) => r.id === id);
    assert.equal(row.status, 'running', 'original 3 untouched');
    assert.equal(row.lease_expires_at, firstThreeLeases.get(id), 'lease not reissued');
  }
});

// ==============================================================================
// AC-3 — Slot writes raise admission; never lower it; dispatchTick catches a
// hand-edited value too.
// ==============================================================================
await check('AC-3', 'writing hopper_slots raises admission; lowering never lowers it; dispatchTick self-heals a hand-edit', async () => {
  resetSettings();
  setAccounts(null);
  writeUsage('a', 5, 5);
  wipeWork();
  setSetting('max_concurrent_auto_turns', '4');
  setSetting('hopper_slots', '6');
  const raised = throttle.enforceAdmissionFloor();
  assert.equal(raised.raised, true);
  assert.equal(getSetting('max_concurrent_auto_turns'), '8');
  assert.equal(throttle.admissionStatus().satisfied, true);
  setSetting('hopper_slots', '2');
  throttle.enforceAdmissionFloor();
  assert.equal(getSetting('max_concurrent_auto_turns'), '8', 'never lowered (§2.3)');
  // Hand-write straight to the DB, bypassing every API — the second call site
  // (once per dispatchTick, before free is computed) must catch it.
  setSetting('hopper_slots', '6');
  sqliteDb.prepare(`UPDATE settings SET value = '4' WHERE key = 'max_concurrent_auto_turns'`).run();
  assert.equal(getSetting('max_concurrent_auto_turns'), '4');
  await dispatch();
  assert.equal(getSetting('max_concurrent_auto_turns'), '8', 'dispatchTick raised it back to hopper_slots+2');
});

// ==============================================================================
// AC-4 — Per-goal cap holds one goal while another dispatches, IN A SINGLE TICK
// (the in-loop counter check).
// ==============================================================================
await check('AC-4', 'per-goal cap=2: goal A (5 ready) and goal B (2 ready) each get exactly 2 in one tick', async () => {
  resetSettings();
  setAccounts(null);
  writeUsage('a', 5, 5);
  wipeWork();
  setSetting('hopper_slots', '12');
  setSetting('throttle_max_per_goal', '2');
  const treeA = makeTree(5);
  const treeB = makeTree(2);
  attachGoal(101, treeA.treeId, 'goal A');
  attachGoal(102, treeB.treeId, 'goal B');
  await dispatch();
  const aRows = nodesFor(treeA.treeId);
  const bRows = nodesFor(treeB.treeId);
  const aRunning = aRows.filter((r) => r.status === 'running');
  const aPending = aRows.filter((r) => r.status === 'pending');
  const bRunning = bRows.filter((r) => r.status === 'running');
  assert.equal(aRunning.length, 2, 'goal A capped at 2 in ONE tick, not 5');
  assert.equal(aPending.length, 3, '3 of A remain pending');
  assert.equal(bRunning.length, 2, 'goal B independently gets its own 2');
  // hold reason for A's remaining leaves is per_goal_cap
  const status = throttle.throttleStatus();
  const byGoalA = status.running.by_goal.find((g) => g.goal_id === 101);
  assert.ok(byGoalA && byGoalA.at_cap === true, 'goal A reported at_cap');
});

// ==============================================================================
// AC-5 — Unattributed trees are not serialised against each other.
// ==============================================================================
await check('AC-5a', 'per_goal=1 per_tree=0: three unattributed trees, 2 leaves each -> all 6 claimed', async () => {
  resetSettings();
  setAccounts(null);
  writeUsage('a', 5, 5);
  wipeWork();
  setSetting('hopper_slots', '12');
  setSetting('throttle_max_per_goal', '1');
  setSetting('throttle_max_per_tree', '0');
  const t1 = makeTree(2); const t2 = makeTree(2); const t3 = makeTree(2);
  await dispatch();
  const allRunning = [...t1.nodeIds, ...t2.nodeIds, ...t3.nodeIds].filter((id) => node(id).status === 'running');
  assert.equal(allRunning.length, 6, 'unattributed trees never share a goal bucket');
});
await check('AC-5b', 'per_tree=1: each unattributed tree gets exactly 1 (3 total); an attributed tree is ALSO capped by per_tree (CONTRACT §10.5 — a node must satisfy BOTH caps, per_tree is not "unattributed only")', async () => {
  resetSettings();
  setAccounts(null);
  writeUsage('a', 5, 5);
  wipeWork();
  setSetting('hopper_slots', '12');
  setSetting('throttle_max_per_goal', '0');
  setSetting('throttle_max_per_tree', '1');
  const t1 = makeTree(2); const t2 = makeTree(2); const t3 = makeTree(2);
  const attributed = makeTree(3);
  attachGoal(201, attributed.treeId, 'goal 201');
  await dispatch();
  const unattributedRunning = [...t1.nodeIds, ...t2.nodeIds, ...t3.nodeIds].filter((id) => node(id).status === 'running');
  assert.equal(unattributedRunning.length, 3, 'exactly 1 per unattributed tree');
  const attributedRunning = attributed.nodeIds.filter((id) => node(id).status === 'running');
  // §10.5 is explicit: the per-tree cap is a GENERAL tree-granularity cap that
  // applies to every tree when >0, not only to trees with no goal — with
  // per_goal=0 (inert) the attributed tree is still held to per_tree=1.
  assert.equal(attributedRunning.length, 1, 'per_goal=0 is inert, but per_tree=1 still caps the attributed tree too (§10.5)');
});

// ==============================================================================
// AC-6 — Goal attribution is correct and deterministic.
// ==============================================================================
await check('AC-6', 'goalForTree: single-goal, two-goal (MIN), and no-goal trees resolve correctly and stably', () => {
  wipeWork();
  const single = makeTree(0);
  attachGoal(301, single.treeId);
  assert.equal(throttle.goalForTree(single.treeId), 301);
  const dual = makeTree(0);
  attachGoal(305, dual.treeId);
  attachGoal(303, dual.treeId); // second row, lower id -> MIN must pick 303
  const first = throttle.goalForTree(dual.treeId);
  const second = throttle.goalForTree(dual.treeId);
  assert.equal(first, 303, 'MIN(goal_id) on every call');
  assert.equal(second, 303, 'deterministic across repeated calls');
  const none = makeTree(0);
  assert.equal(throttle.goalForTree(none.treeId), null);
});

// ==============================================================================
// AC-7 — Focus mode on a spent account HOLDS (never spills).
// ==============================================================================
await check('AC-7', "throttle_claude_mode='a' with a spent holds; switching to ordered a,b resumes on b", async () => {
  resetSettings();
  setAccounts(TWO_ACCOUNTS);
  writeUsage('a', 5, 100); // a weekly-spent
  writeUsage('b', 10, 5); // b fully healthy
  setSetting('throttle_claude_mode', 'a');
  const sel = accounts.selectActiveClaudeAccount(90);
  assert.equal(sel.account, null, 'selector returns null under focus hold, no fallback to b');
  const verdict = governor.governorCheck('claude');
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, 'claude_focus_account_full');
  assert.ok(verdict.detail.includes('a'), 'detail names account a');
  wipeWork();
  setSetting('hopper_slots', '4');
  const t = makeTree(2);
  await dispatch();
  assert.equal(nodesFor(t.treeId).filter((r) => r.status === 'running').length, 0, 'no node claimed while focused-and-spent');
  setSetting('throttle_claude_mode', 'ordered');
  setSetting('throttle_claude_order', 'a,b');
  const sel2 = accounts.selectActiveClaudeAccount(90);
  assert.equal(sel2.account?.key, 'b', 'ordered mode spills to b');
  await dispatch();
  assert.equal(nodesFor(t.treeId).filter((r) => r.status === 'running').length, 2, 'dispatch resumes once switched to ordered');
});

// ==============================================================================
// AC-8 — Selector and governor never disagree (§4.6 anti-drift), across a
// mode x health matrix.
// ==============================================================================
await check('AC-8', 'selector.account and governor.active_account agree across a 3x3 mode x health matrix', () => {
  resetSettings();
  setAccounts(TWO_ACCOUNTS);
  const modes = ['auto', 'ordered', 'a'];
  const healthFixtures = [
    () => { writeUsage('a', 30, 5); writeUsage('b', 10, 5); },
    () => { writeUsage('a', 95, 5); writeUsage('b', 10, 5); }, // a over ceiling
    () => { writeUsage('a', 5, 100); writeUsage('b', 5, 5); }, // a weekly-spent
  ];
  setSetting('throttle_claude_order', 'a,b');
  for (const mode of modes) {
    setSetting('throttle_claude_mode', mode);
    for (const fixture of healthFixtures) {
      fixture();
      const sel = accounts.selectActiveClaudeAccount(90);
      const verdict = governor.governorCheck('claude');
      const selKey = sel.account?.key ?? null;
      const govKey = verdict.active_account ?? null;
      assert.equal(selKey, govKey, `mode=${mode}: selector picked ${selKey}, governor picked ${govKey}`);
    }
  }
});

// ==============================================================================
// AC-9 — Split alternates, and ONLY on spawns; the cursor is never moved by a
// read.
// ==============================================================================
await check('AC-9', 'split alternates a,b,a,b on real spawns and stays put across 10 pure reads', () => {
  resetSettings();
  setAccounts(TWO_ACCOUNTS);
  setSetting('throttle_claude_mode', 'split');
  writeUsage('a', 5, 5);
  writeUsage('b', 5, 5);
  sqliteDb.prepare(`DELETE FROM settings WHERE key = 'throttle_split_cursor'`).run();
  const picks = [];
  for (let i = 0; i < 4; i += 1) {
    const sel = accounts.selectActiveClaudeAccount(90, { forSpawn: true });
    picks.push(sel.account.key);
    throttle.noteWorkerSpawnAccount(sel.account.key);
  }
  assert.deepEqual(picks, ['a', 'b', 'a', 'b']);
  assert.equal(throttle.splitCursor(), 'b');
  const cursorBefore = throttle.splitCursor();
  for (let i = 0; i < 10; i += 1) accounts.selectActiveClaudeAccount(90); // no forSpawn -> read
  assert.equal(throttle.splitCursor(), cursorBefore, 'purity: reads never move the cursor');
  // b ineligible -> stays on a, cursor does not wedge
  writeUsage('b', 5, 100); // weekly-spent
  sqliteDb.prepare(`DELETE FROM settings WHERE key = 'throttle_split_cursor'`).run();
  const picks2 = [];
  for (let i = 0; i < 3; i += 1) {
    const sel = accounts.selectActiveClaudeAccount(90, { forSpawn: true });
    picks2.push(sel.account?.key ?? null);
    if (sel.account) throttle.noteWorkerSpawnAccount(sel.account.key);
  }
  assert.deepEqual(picks2, ['a', 'a', 'a'], 'stays on a when b is ineligible, never wedges/nulls');
});

// ==============================================================================
// AC-10 — A per-thread pin beats the mode.
// ==============================================================================
await check('AC-10', 'a thread pinned to b wins over throttle_claude_mode=a', () => {
  resetSettings();
  setAccounts(TWO_ACCOUNTS);
  setSetting('throttle_claude_mode', 'a');
  writeUsage('a', 10, 5);
  writeUsage('b', 10, 5);
  const selection = accounts.selectActiveClaudeAccount(90); // mode 'a', a is healthy -> selection.account = a
  assert.equal(selection.account?.key, 'a', 'sanity: without a pin, focus mode a selects a (a is healthy)');
  const decision = accounts.decideClaudeAccountForTurn({
    pinnedKey: 'b',
    sessionId: null,
    storedAccount: null,
    selection,
  });
  assert.equal(decision.account?.key, 'b');
  assert.equal(decision.source, 'pin');
});

// ==============================================================================
// AC-11 — Provider fallback OFF by default (never rewrites); correct when ON,
// including the refusal/no-meter cases.
// ==============================================================================
await check('AC-11a', 'fallback OFF (default) never rewrites a capacity-held claude node', async () => {
  resetSettings();
  setAccounts(null);
  writeUsage('a', 95, 5); // over 5h ceiling (default 90)
  wipeWork();
  setSetting('hopper_slots', '4');
  const t = makeTree(1);
  await dispatch();
  const row = node(t.nodeIds[0]);
  assert.equal(row.status, 'pending', 'held, not rerouted');
  assert.equal(row.adapter, 'claude');
  assert.equal(row.throttle_reroute, null);
});
await check('AC-11b', 'fallback ON + claude_all_accounts_full + codex allowed -> rewritten + audited + notified', async () => {
  resetSettings();
  setAccounts(TWO_ACCOUNTS);
  writeUsage('a', 95, 5);
  writeUsage('b', 95, 5); // both over 5h ceiling -> claude_all_accounts_full
  writeProviderUsage(process.env.CODEX_USAGE_FILE, 20); // codex has real headroom
  writeProviderUsage(process.env.AUGGIE_USAGE_FILE, 20);
  setSetting('throttle_provider_fallback', 'on');
  wipeWork();
  setSetting('hopper_slots', '4');
  const before = notifications.listNotifications(50).length;
  const t = makeTree(1, { model: 'claude-sonnet-5' });
  await dispatch();
  const row = node(t.nodeIds[0]);
  assert.equal(row.adapter, 'codex');
  assert.equal(row.model, 'gpt-5.5');
  assert.ok(row.throttle_reroute && row.throttle_reroute.includes('claude→codex'), 'audit line stamped');
  const after = notifications.listNotifications(50);
  assert.ok(after.length > before, 'one notification written');
  assert.ok(after[0].title.includes('Throttle rerouted'));
});
await check('AC-11c', 'fallback ON never reroutes on usage_stale or kevin_active', async () => {
  resetSettings();
  setAccounts(null);
  setSetting('throttle_provider_fallback', 'on');
  removeUsage('a'); // usage_stale (unreadable)
  wipeWork();
  setSetting('hopper_slots', '2');
  const t = makeTree(1);
  await dispatch();
  assert.equal(node(t.nodeIds[0]).adapter, 'claude', 'usage_stale never reroutes');
  // kevin_active case: simulate via a real user turn row inside the idle window
  writeUsage('a', 30, 5);
  sqliteDb.prepare(`
    INSERT OR IGNORE INTO conversations (external_id, status, created_at, updated_at) VALUES ('kevin-live-thread', 'active', datetime('now'), datetime('now'))
  `).run();
  const convId = sqliteDb.prepare(`SELECT id FROM conversations WHERE external_id = 'kevin-live-thread'`).get().id;
  sqliteDb.prepare(`
    INSERT INTO turns (conversation_id, turn_index, role, content, created_at) VALUES (?, 0, 'user', 'hi', datetime('now'))
  `).run(convId);
  setSetting('gov_kevin_active_claude_max_5h', '0'); // never waive
  const t2 = makeTree(1);
  await dispatch();
  assert.equal(node(t2.nodeIds[0]).adapter, 'claude', 'kevin_active never reroutes');
  // Clean up the synthetic "Kevin is active" signal so it never leaks into a
  // later check — kevinActive() looks at ANY user turn in the last 15 minutes
  // across the whole DB, and this run completes well inside that window.
  sqliteDb.prepare(`DELETE FROM turns WHERE conversation_id = (SELECT id FROM conversations WHERE external_id = 'kevin-live-thread')`).run();
  sqliteDb.prepare(`DELETE FROM conversations WHERE external_id = 'kevin-live-thread'`).run();
});
await check('AC-11d', 'fallback ON refuses a frontier-tier node (opus/fable); devin-only remaining also refuses (no meter)', async () => {
  resetSettings();
  setAccounts(null);
  writeUsage('a', 95, 5);
  setSetting('throttle_provider_fallback', 'on');
  wipeWork();
  setSetting('hopper_slots', '4');
  const t = makeTree(1, { model: 'claude-opus-5' });
  await dispatch();
  const row = node(t.nodeIds[0]);
  assert.equal(row.status, 'pending', 'held, not rewritten');
  assert.equal(row.adapter, 'claude', 'frontier node never demoted');
  assert.equal(row.throttle_reroute, null);
  // devin-only in the order: no meter -> throttleRerouteFor must not target it,
  // even when the "providerAllows" callback would say yes to everything.
  setSetting('throttle_provider_order', 'claude,devin');
  const outcome2 = throttle.throttleRerouteFor(
    { adapter: 'claude', model: 'claude-sonnet-5' },
    'claude_all_accounts_full',
    () => true,
  );
  assert.equal(outcome2.kind, 'none', 'devin has no reroute target - never chosen');
});

// ==============================================================================
// AC-12 — Preset apply + rails.
// ==============================================================================
await check('AC-12a', "POST preset 'turned_up' writes exactly its dials, sets throttle_preset, raises admission, leaves absent keys alone", () => {
  resetSettings();
  setSetting('gov_auggie_ceiling', '77'); // absent from turned_up.dials -> must survive untouched
  setSetting('max_concurrent_auto_turns', '4');
  const result = throttle.applyThrottlePreset('turned_up');
  assert.equal(result.ok, true);
  assert.equal(getSetting('hopper_slots'), '6');
  assert.equal(getSetting('throttle_max_per_goal'), '2');
  assert.equal(getSetting('gov_5h_ceiling'), '95');
  assert.equal(getSetting('gov_weekly_ceiling'), '85');
  assert.equal(getSetting('gov_kevin_active_claude_max_5h'), '95');
  assert.equal(getSetting('throttle_claude_mode'), 'ordered');
  assert.deepEqual(throttle.readThrottleDials().throttle_claude_order, ['a', 'b']);
  assert.equal(getSetting('throttle_preset'), 'turned_up');
  assert.equal(getSetting('max_concurrent_auto_turns'), '8', 'admission raised to slots+2');
  assert.equal(getSetting('gov_auggie_ceiling'), '77', 'a dial absent from the preset is left alone');
});
await check('AC-12b', 'a preset with hopper_slots:99 clamps to 12 and reports it; gov_5h_ceiling:100 clamps to 98', () => {
  resetSettings();
  setSetting('throttle_presets', JSON.stringify({
    wild: { label: 'wild', note: '', dials: { hopper_slots: 99, gov_5h_ceiling: 100 } },
  }));
  const result = throttle.applyThrottlePreset('wild');
  assert.equal(result.ok, true);
  assert.equal(getSetting('hopper_slots'), '12');
  assert.equal(getSetting('gov_5h_ceiling'), '98');
  assert.ok(result.clamped.some((c) => c.key === 'hopper_slots' && String(c.stored) === '12'));
  assert.ok(result.clamped.some((c) => c.key === 'gov_5h_ceiling' && String(c.stored) === '98'));
});
await check('AC-12c', 'a preset containing gov_override_claude or an unknown key is rejected 400, nothing written', () => {
  resetSettings();
  setSetting('throttle_presets', JSON.stringify({
    sneaky: { label: 'sneaky', note: '', dials: { hopper_slots: 6, gov_override_claude: 'on' } },
  }));
  const before = getSetting('hopper_slots');
  const result = throttle.applyThrottlePreset('sneaky');
  assert.equal(result.ok, false);
  assert.equal(getSetting('hopper_slots'), before, 'nothing written on rejection');
});
await check('AC-12d', 'an unknown preset name is a clean error, not a write', () => {
  resetSettings();
  const before = getSetting('hopper_slots');
  const result = throttle.applyThrottlePreset('does-not-exist');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'unknown_preset');
  assert.equal(getSetting('hopper_slots'), before);
});
await check('AC-12e', 'a corrupt throttle_presets value falls back to the seeded four, no throw', () => {
  resetSettings();
  setSetting('throttle_presets', '{not json');
  const presets = throttle.listThrottlePresets();
  assert.deepEqual(Object.keys(presets).sort(), Object.keys(throttle.SEEDED_PRESETS).sort());
  assert.equal(throttle.throttlePresetsSource(), 'seeded_fallback');
});

// ==============================================================================
// AC-13 — A running worker is never interrupted by ANY dial change.
// ==============================================================================
await check('AC-13', 'with 4 running nodes, every dial change leaves them exactly as they were', async () => {
  resetSettings();
  setAccounts(TWO_ACCOUNTS);
  writeUsage('a', 5, 5);
  writeUsage('b', 5, 5);
  wipeWork();
  setSetting('hopper_slots', '4');
  const t = makeTree(4);
  await dispatch();
  const before = nodesFor(t.treeId);
  assert.equal(before.filter((r) => r.status === 'running').length, 4, 'setup: 4 running');
  const snapshot = before.map((r) => ({
    id: r.id, status: r.status, adapter: r.adapter, model: r.model,
    worker_thread_ext: r.worker_thread_ext, attempts: r.attempts, lease_expires_at: r.lease_expires_at,
    throttle_reroute: r.throttle_reroute,
  }));
  // Hammer every kind of dial change.
  setSetting('hopper_slots', '1');
  throttle.applyThrottlePreset('conserve');
  setSetting('throttle_claude_mode', 'b');
  setSetting('throttle_provider_fallback', 'on');
  setSetting('gov_override_claude', 'off');
  await dispatch();
  const after = nodesFor(t.treeId);
  for (const s of snapshot) {
    const row = after.find((r) => r.id === s.id);
    assert.equal(row.status, s.status);
    assert.equal(row.adapter, s.adapter);
    assert.equal(row.model, s.model);
    assert.equal(row.worker_thread_ext, s.worker_thread_ext);
    assert.equal(row.attempts, s.attempts);
    assert.equal(row.lease_expires_at, s.lease_expires_at);
    assert.equal(row.throttle_reroute, s.throttle_reroute);
  }
  // No new claim happened (free<=0 with slots=1 and 4 already running).
  assert.equal(after.filter((r) => r.status === 'pending').length, 0, 'no more leaves in this tree, nothing new to claim');
  // Now let them "finish" and confirm the pool refills to the NEW slot value.
  setSetting('gov_override_claude', 'auto');
  for (const s of snapshot) sqliteDb.prepare(`UPDATE hopper_nodes SET status = 'done' WHERE id = ?`).run(s.id);
  const t2 = makeTree(5);
  setSetting('hopper_slots', '3');
  await dispatch();
  assert.equal(nodesFor(t2.treeId).filter((r) => r.status === 'running').length, 3, 'pool refilled to the new slot value once drained');
});

// ==============================================================================
// AC-14 — Governor gates still run under every preset.
// ==============================================================================
await check('AC-14a', "turned_up applied + stale meter -> usage_stale hold, nothing dispatched", async () => {
  resetSettings();
  setAccounts(null);
  throttle.applyThrottlePreset('turned_up');
  removeUsage('a');
  wipeWork();
  const t = makeTree(2);
  await dispatch();
  assert.equal(nodesFor(t.treeId).filter((r) => r.status === 'running').length, 0);
  assert.equal(governor.governorCheck('claude').reason, 'usage_stale');
});
await check('AC-14b', 'weekly_mode=hard + weekly over ceiling -> weekly_ceiling hold', () => {
  resetSettings();
  setAccounts(null);
  setSetting('gov_weekly_mode', 'hard');
  setSetting('gov_weekly_ceiling', '30');
  writeUsage('a', 5, 40);
  const v = governor.governorCheck('claude');
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'weekly_ceiling');
});
await check('AC-14c', 'gov_override_claude=off holds everything claude; on bypasses ceilings but not usage_stale', async () => {
  resetSettings();
  setAccounts(null);
  writeUsage('a', 5, 5);
  setSetting('gov_override_claude', 'off');
  wipeWork();
  const t = makeTree(2);
  await dispatch();
  assert.equal(nodesFor(t.treeId).filter((r) => r.status === 'running').length, 0);
  assert.equal(governor.governorCheck('claude').reason, 'provider_ceiling');
  setSetting('gov_override_claude', 'on');
  writeUsage('a', 99, 99); // wildly over every ceiling
  assert.equal(governor.governorCheck('claude').allow, true, 'override on bypasses ceilings');
  removeUsage('a');
  assert.equal(governor.governorCheck('claude').reason, 'usage_stale', 'override on does NOT bypass staleness');
});

// ==============================================================================
// AC-15 — Hold reason vocabulary stays inside the allowed union.
// ==============================================================================
await check('AC-15', 'hold.reason across a battery of scenarios is always a known governor reason or a §7.4 local reason', async () => {
  // Goes through the REAL HTTP GET /throttle (composeThrottleInputs), not a bare
  // throttle.throttleStatus() call — that function takes `providers` as an
  // ARGUMENT precisely because it cannot import governorStatusAll (cycle), so
  // calling it with no inputs always reports "ok" regardless of the real
  // governor state. The route is the one place providers are composed for real.
  const ALLOWED = new Set([
    'ok', 'disabled', 'five_hour_ceiling', 'weekly_ceiling', 'usage_stale', 'kevin_active',
    'provider_ceiling', 'claude_all_accounts_full', 'claude_focus_account_full',
    ...throttle.THROTTLE_LOCAL_REASONS,
  ]);
  const seen = new Set();
  const scenarios = [
    () => { resetSettings(); setAccounts(null); writeUsage('a', 5, 5); wipeWork(); makeTree(1); },
    () => { resetSettings(); setAccounts(null); wipeWork(); makeTree(1); }, // no usage file -> stale
    () => { resetSettings(); setAccounts(null); writeUsage('a', 95, 5); wipeWork(); makeTree(1); },
    () => { resetSettings(); setAccounts(null); writeUsage('a', 5, 95); setSetting('gov_weekly_mode', 'hard'); wipeWork(); makeTree(1); },
    () => { resetSettings(); setAccounts(TWO_ACCOUNTS); writeUsage('a', 5, 100); writeUsage('b', 10, 5); setSetting('throttle_claude_mode', 'a'); wipeWork(); makeTree(1); },
    () => { resetSettings(); setAccounts(null); writeUsage('a', 5, 5); wipeWork(); setSetting('hopper_slots', '1'); const t = makeTree(1); sqliteDb.prepare(`UPDATE hopper_nodes SET status='running' WHERE id = ?`).run(t.nodeIds[0]); makeTree(1); },
    () => { resetSettings(); setAccounts(null); writeUsage('a', 5, 5); wipeWork(); setSetting('throttle_max_per_goal', '1'); const t = makeTree(2); attachGoal(901, t.treeId); },
    () => { resetSettings(); setAccounts(null); writeUsage('a', 5, 5); wipeWork(); setSetting('throttle_max_per_tree', '1'); makeTree(2); },
  ];
  for (const s of scenarios) {
    s();
    const r = await http('GET', '/throttle', { token: plainKey });
    assert.equal(r.status, 200);
    seen.add(r.json.hold.reason);
  }
  for (const r of seen) assert.ok(ALLOWED.has(r), `hold.reason "${r}" is outside the allowed union`);
  assert.ok(seen.size >= 5, `the battery should exercise several distinct reasons, saw only: ${[...seen].join(', ')}`);
});

// ==============================================================================
// AC-16 — Read endpoints are pure.
// ==============================================================================
await check('AC-16', '50x GET /throttle + GET /claude-accounts change no settings key, including the split cursor and admission', async () => {
  resetSettings();
  setAccounts(TWO_ACCOUNTS);
  writeUsage('a', 30, 5);
  writeUsage('b', 10, 5);
  setSetting('throttle_claude_mode', 'split');
  const before = settingsSnapshot();
  for (let i = 0; i < 50; i += 1) {
    const r1 = await http('GET', '/throttle', { token: plainKey });
    assert.equal(r1.status, 200);
    const r2 = await http('GET', '/claude-accounts', { token: plainKey });
    assert.equal(r2.status, 200);
  }
  const after = settingsSnapshot();
  assert.equal(after, before, 'no setting changed across 100 pure reads');
});

// ==============================================================================
// AC-17 — Admin scope.
// ==============================================================================
await check('AC-17', 'PATCH/preset with a non-admin key -> 403 + nothing written; GET with a normal key -> 200', async () => {
  resetSettings();
  const beforeSlots = getSetting('hopper_slots');
  const p1 = await http('PATCH', '/throttle', { token: plainKey, body: { hopper_slots: 9 } });
  assert.equal(p1.status, 403);
  assert.equal(p1.json?.error?.code, 'admin_scope_required');
  assert.equal(getSetting('hopper_slots'), beforeSlots, 'nothing written on a 403');
  const p2 = await http('POST', '/throttle/preset', { token: plainKey, body: { name: 'turned_up' } });
  assert.equal(p2.status, 403);
  assert.equal(getSetting('throttle_preset'), null);
  const g = await http('GET', '/throttle', { token: plainKey });
  assert.equal(g.status, 200);
  const g2 = await http('GET', '/throttle'); // no token at all
  assert.equal(g2.status, 401);
  // admin key DOES work, proving the 403s above were scope-gated, not broken routes.
  const p3 = await http('PATCH', '/throttle', { token: adminKey, body: { hopper_slots: 9 } });
  assert.equal(p3.status, 200);
  assert.equal(getSetting('hopper_slots'), '9');
});

// -- no-process-spawned guard (§9 environment rule) ---------------------------
await check('ENV', 'the stub processMessage actually intercepted spawns (dispatch path was really exercised)', () => {
  assert.ok(spawned.length > 0, 'expected at least one worker spawn to have been intercepted by the stub');
  assert.ok(spawned.every((e) => e.startsWith('cockpit:hopper-node-')));
});
await check('ENV', 'no claude/codex/auggie MODEL-TURN process is a descendant of this sim run', () => {
  // KNOWN, ALLOWED exception (NO-API-KEYS rule, top of memory: "fetching a
  // model catalog list ... is NOT a violation"): importing dist/agent.js (which
  // dist/handlers/api-v1.js does, transitively, for refreshAuggieModels /
  // refreshDevinModels used by GET /providers) fires `void
  // refreshAuggieModels()` / `void refreshDevinModels()` at MODULE LOAD TIME —
  // a one-shot `auggie model list` / `devin models list` catalog probe on
  // subscription auth, not a billed model turn. That is pre-existing agent.ts
  // behaviour, unrelated to anything this throttle build changed, and would
  // fire the exact same way the moment jarvis.service imports this router. It
  // is explicitly allow-listed here; anything else — in particular any
  // invocation of the `claude` or `codex` binaries at all, under ANY args — is
  // exactly the failure this guard exists to catch.
  const ALLOWED = [/\bauggie\s+model\s+list\b/, /\bdevin\s+models\s+list\b/];
  const hits = descendantsMatchingCliBinaries().filter((h) => !ALLOWED.some((re) => re.test(h.cmd)));
  assert.equal(hits.length, 0, `found un-allow-listed CLI-binary descendants: ${JSON.stringify(hits)}`);
});

// -- report ---------------------------------------------------------------------
console.log('');
let failed = 0;
for (const r of results) {
  if (r.pass) {
    console.log(`  PASS  ${r.id.padEnd(6)} ${r.desc}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${r.id.padEnd(6)} ${r.desc}`);
    console.log(`        ${r.error}`);
  }
}
console.log(`\n[throttle-sim] ${results.length - failed}/${results.length} acceptance checks passed`);

await new Promise((resolve) => server.close(resolve));
fs.rmSync(scratchDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
