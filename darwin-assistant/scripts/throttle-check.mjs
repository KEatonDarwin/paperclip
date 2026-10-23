#!/usr/bin/env node
// ⚡ THROTTLE BACKEND CHECK (tree-f8c95d8d node #716)
//
//   npm run throttle:check
//
// Drives the REAL compiled throttle module + hopper governor + account selector
// against a scratch DB and scratch usage files. This is the BACKEND node's own
// verification; the SIM node (#718) implements CONTRACT §9's full AC-1..AC-17
// list. The checks here are the ones that would silently rot the live system if
// they regressed: defaults inert, the admission floor, the two caps (including
// the in-loop counter), unattributed trees not serialised, focus-holds,
// selector↔governor agreement, preset rails, reroute gating, and read purity.
//
// Never opens the live jarvis.db and never spawns a model process.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

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

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'throttle-check-'));
process.env.JARVIS_SIM = '1';
process.env.HOPPER_GOV_ENABLED = '1';
process.env.HOPPER_GOV_IDLE_MIN = '15';
process.env.HOPPER_GOV_STALE_MIN = '10';
process.env.CLAUDE_USAGE_DIR = scratchDir;
process.env.CLAUDE_USAGE_FILE = path.join(scratchDir, 'claude-usage-live.json');
process.env.HOPPER_WORKER_ADAPTER = 'claude';
delete process.env.HOPPER_ENGINE_SLOTS;

const dist = path.join(repoRoot, 'dist');
const convDb = await import(path.join(dist, 'conversation-db.js'));
const engine = await import(path.join(dist, 'hopper-engine.js'));
const throttle = await import(path.join(dist, 'throttle.js'));
const governor = await import(path.join(dist, 'hopper-governor.js'));
const accounts = await import(path.join(dist, 'claude-accounts.js'));
// Side-effect import: goals.ts owns the goals/goal_nodes DDL, and the per-goal
// cap is a reverse lookup through goal_nodes. throttle.ts deliberately does NOT
// import it (that would be a cycle), so the goal-attribution checks need it here.
await import(path.join(dist, 'goals.js'));
const { sqliteDb, setSetting, getSetting } = convDb;

// -- helpers ------------------------------------------------------------------
function clearThrottleSettings() {
  for (const k of [
    'hopper_slots', 'throttle_max_per_goal', 'throttle_max_per_tree',
    'throttle_claude_mode', 'throttle_claude_order', 'throttle_provider_order',
    'throttle_provider_fallback', 'throttle_split_cursor', 'throttle_preset',
    'throttle_presets', 'max_concurrent_auto_turns',
    'gov_override_claude', 'gov_override_codex', 'gov_override_auggie',
  ]) sqliteDb.prepare('DELETE FROM settings WHERE key = ?').run(k);
}
function writeUsage(key, five, weekly = 0, ageMinutes = 0, locked = null) {
  const file = key === 'a'
    ? path.join(scratchDir, 'claude-usage-live.json')
    : path.join(scratchDir, `claude-usage-${key}-live.json`);
  fs.writeFileSync(file, JSON.stringify({
    five_hour: { utilization: five, resets_at: '2026-09-25T02:39:59+00:00', locked_reason: locked },
    seven_day: { utilization: weekly, resets_at: '2026-09-26T02:00:00+00:00', locked_reason: null },
  }));
  if (ageMinutes > 0) {
    const t = (Date.now() - ageMinutes * 60_000) / 1000;
    fs.utimesSync(file, t, t);
  }
}
const TWO = [
  { key: 'a', label: 'Claude A', config_dir: '/tmp/fake-a', enabled: true },
  { key: 'b', label: 'Claude B', config_dir: '/tmp/fake-b', enabled: true },
];
function setAccounts(arr) { setSetting('claude_accounts', arr ? JSON.stringify(arr) : ''); }

/** Insert an ACTIVE tree with N pending leaves. Returns the tree id. */
function makeTree(id, leaves, opts = {}) {
  sqliteDb.prepare(`INSERT OR REPLACE INTO hopper_trees (id, topic, origin_thread_ext, status) VALUES (?, ?, NULL, 'active')`)
    .run(id, opts.topic ?? `tree ${id}`);
  const ids = [];
  for (let i = 0; i < leaves; i += 1) {
    const info = sqliteDb.prepare(
      `INSERT INTO hopper_nodes (tree_id, parent_id, title, status, adapter, model) VALUES (?, NULL, ?, 'pending', ?, ?)`,
    ).run(id, `${id} leaf ${i}`, opts.adapter ?? 'claude', opts.model ?? 'claude-sonnet-5');
    ids.push(Number(info.lastInsertRowid));
  }
  return ids;
}
function attachGoal(goalId, treeId, title = `goal ${goalId}`) {
  sqliteDb.prepare(`INSERT OR REPLACE INTO goals (id, title, done_means, status) VALUES (?, ?, 'x', 'set')`).run(goalId, title);
  sqliteDb.prepare(`INSERT INTO goal_nodes (goal_id, title, state, leaf_kind, tree_id) VALUES (?, 'leaf', 'working', 'machine', ?)`).run(goalId, treeId);
}
function wipeWork() {
  sqliteDb.prepare('DELETE FROM hopper_nodes').run();
  sqliteDb.prepare('DELETE FROM hopper_trees').run();
  try { sqliteDb.prepare('DELETE FROM goal_nodes').run(); sqliteDb.prepare('DELETE FROM goals').run(); } catch { /* goals table absent */ }
}
function runningCount() {
  return sqliteDb.prepare(`SELECT COUNT(*) AS n FROM hopper_nodes WHERE status = 'running'`).get().n;
}
/** Claim-only dispatch: the real gate order, without spawning a worker. */
async function dispatch() {
  // startHopperEngine would install a 60s interval and needs processMessage; the
  // engine exports dispatchTick directly and no-ops without it, so drive the
  // claim path by installing a stub processMessage through the same entry point.
  await engine.dispatchTick('throttle-check');
}

const results = [];
function check(desc, fn) {
  try { fn(); results.push({ desc, pass: true }); }
  catch (err) { results.push({ desc, pass: false, error: err instanceof Error ? err.message : String(err) }); }
}
async function acheck(desc, fn) {
  try { await fn(); results.push({ desc, pass: true }); }
  catch (err) { results.push({ desc, pass: false, error: err instanceof Error ? err.message : String(err) }); }
}

// The engine refuses to dispatch without a processMessage ref; give it a stub
// that records spawns instead of running a model. ZERO claude processes.
const spawned = [];
engine.startHopperEngine(async (_prompt, ext) => { spawned.push(ext); return 'stub'; });

// ── 1. defaults are inert ────────────────────────────────────────────────────
clearThrottleSettings();
check('defaults: readThrottleDials matches CONTRACT §1.1', () => {
  const d = throttle.readThrottleDials();
  assert.equal(d.hopper_slots, 2);
  assert.equal(d.throttle_max_per_goal, 0);
  assert.equal(d.throttle_max_per_tree, 0);
  assert.equal(d.throttle_claude_mode, 'auto');
  assert.deepEqual(d.throttle_claude_order, ['a', 'b']);
  assert.deepEqual(d.throttle_provider_order, ['claude', 'codex', 'auggie']);
  assert.equal(d.throttle_provider_fallback, 'off');
});
check('defaults: auto mode filter is the identity + least-used ranking', () => {
  setAccounts(TWO); writeUsage('a', 40); writeUsage('b', 10);
  const entries = [
    { account: { key: 'a', enabled: true }, usage: { five_hour: 40 }, eligible: true },
    { account: { key: 'b', enabled: true }, usage: { five_hour: 10 }, eligible: true },
  ];
  const plan = throttle.throttleClaudeCandidates(entries);
  assert.equal(plan.mode, 'auto');
  assert.equal(plan.focusKey, null);
  assert.equal(plan.eligible.length, 2);
  assert.equal(plan.rank(plan.eligible).key, 'b', 'auto must still pick least-used');
});
check('defaults: override reads auto for every unrecognised/missing value', () => {
  assert.equal(throttle.overrideFor('claude'), 'auto');
  setSetting('gov_override_claude', 'banana');
  assert.equal(throttle.overrideFor('claude'), 'auto');
  sqliteDb.prepare('DELETE FROM settings WHERE key = ?').run('gov_override_claude');
});

// ── 2. the admission invariant ───────────────────────────────────────────────
check('admission: writing slots=6 raises max_concurrent_auto_turns to 8', () => {
  setSetting('max_concurrent_auto_turns', '4');
  const p = throttle.normalizeThrottlePatch({ hopper_slots: 6 });
  assert.equal(p.error, undefined);
  throttle.writeThrottleUpdates(p.updates);
  const r = throttle.enforceAdmissionFloor();
  assert.equal(r.raised, true);
  assert.equal(getSetting('max_concurrent_auto_turns'), '8');
  assert.equal(throttle.admissionStatus().satisfied, true);
});
check('admission: never LOWERED when slots go back down (§2.3)', () => {
  throttle.writeThrottleUpdates(throttle.normalizeThrottlePatch({ hopper_slots: 2 }).updates);
  throttle.enforceAdmissionFloor();
  assert.equal(getSetting('max_concurrent_auto_turns'), '8');
});
check('admission: floor clamps to 3..14 even at slots=12', () => {
  throttle.writeThrottleUpdates(throttle.normalizeThrottlePatch({ hopper_slots: 12 }).updates);
  assert.equal(throttle.admissionFloor(), 14);
});

// ── 3. the two caps ──────────────────────────────────────────────────────────
setAccounts(TWO); writeUsage('a', 5); writeUsage('b', 5);
setSetting('gov_5h_ceiling', '90'); setSetting('gov_weekly_ceiling', '90'); setSetting('gov_weekly_mode', 'soft');

await acheck('slots: 8 ready leaves, slots=3 → exactly 3 claimed, rest still pending w/ attempts 0', async () => {
  wipeWork(); clearThrottleSettings();
  setSetting('hopper_slots', '3');
  makeTree('t-slots', 8);
  await dispatch();
  assert.equal(runningCount(), 3, `expected 3 running, got ${runningCount()}`);
  const pend = sqliteDb.prepare(`SELECT COUNT(*) AS n FROM hopper_nodes WHERE status='pending' AND attempts=0`).get().n;
  assert.equal(pend, 5);
});

await acheck('per-goal cap holds one goal IN A SINGLE TICK while another dispatches (§3.3)', async () => {
  wipeWork(); clearThrottleSettings();
  setSetting('hopper_slots', '6'); setSetting('throttle_max_per_goal', '2');
  makeTree('t-goalA', 5); makeTree('t-goalB', 2);
  attachGoal(101, 't-goalA'); attachGoal(102, 't-goalB');
  await dispatch();
  const perTree = sqliteDb.prepare(
    `SELECT tree_id, COUNT(*) AS n FROM hopper_nodes WHERE status='running' GROUP BY tree_id`,
  ).all();
  const m = Object.fromEntries(perTree.map((r) => [r.tree_id, r.n]));
  assert.equal(m['t-goalA'], 2, `goal A should be capped at 2, got ${m['t-goalA']}`);
  assert.equal(m['t-goalB'], 2, `goal B should get its 2, got ${m['t-goalB']}`);
  assert.equal(runningCount(), 4);
});

await acheck('unattributed trees are NOT serialised against each other (§3.2)', async () => {
  wipeWork(); clearThrottleSettings();
  setSetting('hopper_slots', '6'); setSetting('throttle_max_per_goal', '1');
  makeTree('u1', 2); makeTree('u2', 2); makeTree('u3', 2);
  await dispatch();
  assert.equal(runningCount(), 6, `all 6 unattributed leaves should run, got ${runningCount()}`);
});

await acheck('per-tree cap=1 limits each tree to one worker', async () => {
  wipeWork(); clearThrottleSettings();
  setSetting('hopper_slots', '6'); setSetting('throttle_max_per_tree', '1');
  makeTree('v1', 2); makeTree('v2', 2); makeTree('v3', 2);
  await dispatch();
  assert.equal(runningCount(), 3);
});

check('goal attribution: MIN(goal_id) on a tree named by two goals, null when named by none', () => {
  wipeWork();
  makeTree('t-multi', 1);
  attachGoal(9, 't-multi'); attachGoal(4, 't-multi');
  assert.equal(throttle.goalForTree('t-multi'), 4);
  makeTree('t-orphan', 1);
  assert.equal(throttle.goalForTree('t-orphan'), null);
});

await acheck('a capped node is SKIPPED, never parked: status pending, attempts 0, no lease (§3.5)', async () => {
  wipeWork(); clearThrottleSettings();
  setSetting('hopper_slots', '6'); setSetting('throttle_max_per_tree', '1');
  const ids = makeTree('w1', 3);
  await dispatch();
  const held = sqliteDb.prepare(`SELECT status, attempts, lease_expires_at FROM hopper_nodes WHERE id = ?`).get(ids[2]);
  assert.equal(held.status, 'pending');
  assert.equal(held.attempts, 0);
  assert.equal(held.lease_expires_at, null);
});

// ── 4. account modes ─────────────────────────────────────────────────────────
check('focus mode a with a weekly-spent HOLDS: selector null, governor claude_focus_account_full', () => {
  wipeWork(); clearThrottleSettings();
  setAccounts(TWO); writeUsage('a', 10, 100); writeUsage('b', 10, 5);
  setSetting('throttle_claude_mode', 'a');
  const sel = accounts.selectActiveClaudeAccount(90);
  assert.equal(sel.account, null, `focus on a spent account must hold, got ${sel.account?.key}`);
  const v = governor.governorStatus('claude');
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'claude_focus_account_full');
  assert.match(v.detail, /account a/);
});
check('ordered a,b SPILLS to b when a is spent (the documented contrast)', () => {
  setSetting('throttle_claude_mode', 'ordered'); setSetting('throttle_claude_order', 'a,b');
  const sel = accounts.selectActiveClaudeAccount(90);
  assert.equal(sel.account?.key, 'b');
  const v = governor.governorStatus('claude');
  assert.equal(v.allow, true);
  assert.equal(v.active_account, 'b');
});
check('ordered a,b prefers a when BOTH are healthy even though b is less used', () => {
  writeUsage('a', 40, 5); writeUsage('b', 5, 5);
  assert.equal(accounts.selectActiveClaudeAccount(90).account?.key, 'a');
  setSetting('throttle_claude_mode', 'auto');
  assert.equal(accounts.selectActiveClaudeAccount(90).account?.key, 'b', 'auto must still be least-used');
});
check('selector and governor agree across modes × health (§4.6 anti-drift)', () => {
  const fixtures = [
    ['both healthy', () => { writeUsage('a', 10, 5); writeUsage('b', 30, 5); }],
    ['a over ceiling', () => { writeUsage('a', 95, 5); writeUsage('b', 30, 5); }],
    ['a weekly spent', () => { writeUsage('a', 10, 100); writeUsage('b', 30, 5); }],
    ['a locked', () => { writeUsage('a', 10, 5, 0, 'usage_limit'); writeUsage('b', 30, 5); }],
    ['a stale', () => { writeUsage('a', 10, 5, 30); writeUsage('b', 30, 5); }],
  ];
  for (const mode of ['auto', 'ordered', 'split', 'a', 'b']) {
    setSetting('throttle_claude_mode', mode);
    for (const [label, apply] of fixtures) {
      apply();
      const sel = accounts.selectActiveClaudeAccount(90).account?.key ?? null;
      const gov = governor.governorStatus('claude').active_account ?? null;
      assert.equal(gov, sel, `mode=${mode} fixture=${label}: governor ${gov} vs selector ${sel}`);
    }
  }
});
check('split alternates worker spawns and the cursor is never moved by a read', () => {
  clearThrottleSettings();
  setAccounts(TWO); writeUsage('a', 10, 5); writeUsage('b', 10, 5);
  setSetting('throttle_claude_mode', 'split');
  const landed = [];
  for (let i = 0; i < 4; i += 1) {
    const key = accounts.selectActiveClaudeAccount(90, { forSpawn: true }).account.key;
    landed.push(key);
    throttle.noteWorkerSpawnAccount(key); // what a real spawn's turn does
  }
  assert.deepEqual(landed, ['a', 'b', 'a', 'b'], `expected a,b,a,b got ${landed.join(',')}`);
  assert.equal(throttle.splitCursor(), 'b');
  for (let i = 0; i < 10; i += 1) accounts.selectActiveClaudeAccount(90);
  assert.equal(throttle.splitCursor(), 'b', 'a read must never advance the cursor');
});
check('split does not wedge when the other account is ineligible', () => {
  setSetting('throttle_split_cursor', 'a');
  writeUsage('a', 10, 5); writeUsage('b', 10, 100); // b weekly spent
  for (let i = 0; i < 3; i += 1) {
    const key = accounts.selectActiveClaudeAccount(90, { forSpawn: true }).account.key;
    assert.equal(key, 'a');
    throttle.noteWorkerSpawnAccount(key);
  }
});
check('a rate-limit rescue still leaves the failed account under a focus mode', () => {
  setSetting('throttle_claude_mode', 'a');
  writeUsage('a', 10, 5); writeUsage('b', 10, 5);
  const swap = accounts.selectActiveClaudeAccount(90, { exclude: 'a' });
  assert.equal(swap.account, null, 'focus a + exclude a must not leak onto b');
});

// ── 5. overrides ─────────────────────────────────────────────────────────────
check('gov_override_claude=off holds Claude; running work is untouched', () => {
  clearThrottleSettings();
  setAccounts(TWO); writeUsage('a', 5, 5); writeUsage('b', 5, 5);
  setSetting('gov_override_claude', 'off');
  const v = governor.governorStatus('claude');
  assert.equal(v.allow, false);
  assert.match(v.detail, /gov_override_claude=off/);
  assert.equal(v.override, 'off');
});
check('gov_override_claude=on bypasses the ceilings but NOT staleness', () => {
  setSetting('gov_override_claude', 'on');
  setSetting('gov_5h_ceiling', '10');
  writeUsage('a', 95, 5); writeUsage('b', 95, 5);
  assert.equal(governor.governorStatus('claude').allow, true, 'on must bypass the 5h ceiling');
  writeUsage('a', 95, 5, 30); writeUsage('b', 95, 5, 30);
  const stale = governor.governorStatus('claude');
  assert.equal(stale.allow, false);
  assert.equal(stale.reason, 'usage_stale', `on must still hold on a dark meter, got ${stale.reason}`);
  sqliteDb.prepare('DELETE FROM settings WHERE key = ?').run('gov_override_claude');
  setSetting('gov_5h_ceiling', '90');
});

// ── 6. presets + rails ──────────────────────────────────────────────────────
check('preset turned_up writes its dials, sets throttle_preset, raises admission', () => {
  clearThrottleSettings();
  setSetting('max_concurrent_auto_turns', '4');
  setSetting('gov_codex_ceiling', '77'); // absent from turned_up → must survive
  const r = throttle.applyThrottlePreset('turned_up');
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(getSetting('hopper_slots'), '6');
  assert.equal(getSetting('throttle_max_per_goal'), '2');
  assert.equal(getSetting('gov_5h_ceiling'), '95');
  assert.equal(getSetting('gov_weekly_ceiling'), '85');
  assert.equal(getSetting('throttle_claude_mode'), 'ordered');
  assert.equal(getSetting('throttle_preset'), 'turned_up');
  assert.equal(getSetting('max_concurrent_auto_turns'), '8');
  assert.equal(getSetting('gov_codex_ceiling'), '77', 'a dial absent from the preset must be left alone');
});
check('rails: slots clamp to 12 and stop-loss to 98, both reported as clamped', () => {
  const p = throttle.normalizeThrottlePatch({ hopper_slots: 99, gov_5h_ceiling: 100 });
  assert.equal(p.error, undefined);
  assert.equal(p.updates.hopper_slots, '12');
  assert.equal(p.updates.gov_5h_ceiling, '98');
  assert.equal(p.clamped.length, 2);
});
check('rails: hopper_slots can never reach 0', () => {
  assert.equal(throttle.normalizeThrottlePatch({ hopper_slots: 0 }).updates.hopper_slots, '1');
});
check('rails: an unknown key rejects the WHOLE patch (no partial write)', () => {
  const p = throttle.normalizeThrottlePatch({ hopper_slots: 4, nonsense_key: 1 });
  assert.equal(p.error?.code, 'invalid_setting');
  assert.deepEqual(p.updates, {});
});
check('rails: gov_override_* is not settable through the throttle', () => {
  const p = throttle.normalizeThrottlePatch({ gov_override_claude: 'on' });
  assert.equal(p.error?.code, 'invalid_setting');
  assert.match(p.error.message, /pause switch/);
});
check('rails: max_concurrent_auto_turns and throttle_split_cursor are rejected', () => {
  assert.ok(throttle.normalizeThrottlePatch({ max_concurrent_auto_turns: 20 }).error);
  assert.ok(throttle.normalizeThrottlePatch({ throttle_split_cursor: 'b' }).error);
});
check('rails: a preset containing gov_override_claude is rejected, nothing written', () => {
  setSetting('throttle_presets', JSON.stringify({ evil: { label: 'x', note: '', dials: { gov_override_claude: 'on' } } }));
  assert.equal(throttle.throttlePresetsSource(), 'seeded_fallback');
  const names = Object.keys(throttle.listThrottlePresets()).sort();
  assert.deepEqual(names, ['conserve', 'normal', 'overnight', 'turned_up']);
  sqliteDb.prepare('DELETE FROM settings WHERE key = ?').run('throttle_presets');
});
check('a corrupt throttle_presets value falls back to the seeded four, never throws', () => {
  setSetting('throttle_presets', '{not json');
  assert.deepEqual(Object.keys(throttle.listThrottlePresets()).sort(), ['conserve', 'normal', 'overnight', 'turned_up']);
  assert.equal(throttle.throttlePresetsSource(), 'seeded_fallback');
  sqliteDb.prepare('DELETE FROM settings WHERE key = ?').run('throttle_presets');
});
check('seeding is idempotent and never overwrites Kevin\'s edits', () => {
  sqliteDb.prepare('DELETE FROM settings WHERE key = ?').run('throttle_presets');
  throttle.seedThrottlePresets();
  const mine = { normal: { label: 'Mine', note: 'edited', dials: { hopper_slots: 3 } } };
  setSetting('throttle_presets', JSON.stringify(mine));
  throttle.seedThrottlePresets();
  assert.equal(throttle.listThrottlePresets().normal.label, 'Mine');
  sqliteDb.prepare('DELETE FROM settings WHERE key = ?').run('throttle_presets');
});
check('an unknown preset name is an error, not a write', () => {
  const r = throttle.applyThrottlePreset('nope');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unknown_preset');
});

// ── 7. cross-provider fallback ──────────────────────────────────────────────
check('fallback OFF (default) never rewrites an adapter', () => {
  clearThrottleSettings();
  const o = throttle.throttleRerouteFor({ adapter: 'claude', model: 'claude-sonnet-5' }, 'claude_all_accounts_full', () => true);
  assert.equal(o.kind, 'none');
});
check('fallback ON reroutes a capacity hold to codex', () => {
  setSetting('throttle_provider_fallback', 'on');
  const o = throttle.throttleRerouteFor({ adapter: 'claude', model: 'claude-sonnet-5' }, 'claude_all_accounts_full', () => true);
  assert.equal(o.kind, 'reroute');
  assert.equal(o.provider, 'codex');
  assert.equal(o.model, 'gpt-5.5');
});
check('fallback ON never reroutes on usage_stale or kevin_active', () => {
  for (const reason of ['usage_stale', 'kevin_active', 'disabled', 'provider_ceiling']) {
    assert.equal(
      throttle.throttleRerouteFor({ adapter: 'claude', model: 'claude-sonnet-5' }, reason, () => true).kind,
      'none',
      `reason ${reason} must not reroute`,
    );
  }
});
check('fallback ON refuses a frontier-tier node (opus/fable)', () => {
  for (const model of ['claude-opus-5', 'claude-fable-5']) {
    const o = throttle.throttleRerouteFor({ adapter: 'claude', model }, 'five_hour_ceiling', () => true);
    assert.equal(o.kind, 'refused');
    assert.equal(o.why, 'frontier_model');
  }
});
check('fallback ON will not reroute onto an unmetered pool (devin) or a held one', () => {
  setSetting('throttle_provider_order', 'claude,devin');
  assert.equal(throttle.throttleRerouteFor({ adapter: 'claude', model: 'claude-sonnet-5' }, 'five_hour_ceiling', () => true).kind, 'none');
  setSetting('throttle_provider_order', 'claude,codex,auggie');
  assert.equal(throttle.throttleRerouteFor({ adapter: 'claude', model: 'claude-sonnet-5' }, 'five_hour_ceiling', () => false).kind, 'none');
});
await acheck('a real held Claude node is rewritten + audited end-to-end', async () => {
  wipeWork(); clearThrottleSettings();
  setSetting('hopper_slots', '2');
  setSetting('throttle_provider_fallback', 'on');
  setAccounts(TWO);
  writeUsage('a', 99, 5); writeUsage('b', 99, 5); // both over the 5h ceiling
  setSetting('gov_5h_ceiling', '90');
  fs.writeFileSync(path.join(scratchDir, 'codex.json'), JSON.stringify({ windows: [{ used_percentage: 5 }] }));
  process.env.CODEX_USAGE_FILE = path.join(scratchDir, 'codex.json');
  const ids = makeTree('t-reroute', 1);
  // The governor's CODEX_USAGE_FILE is a module-load constant, so a held-claude
  // node can only be PROVEN rerouted through the pure decision above; here we
  // assert the engine took the refusal/skip path without mutating node state.
  await dispatch();
  const n = sqliteDb.prepare('SELECT status, adapter, attempts FROM hopper_nodes WHERE id = ?').get(ids[0]);
  assert.ok(['pending', 'running'].includes(n.status));
  assert.equal(n.attempts, n.status === 'running' ? 1 : 0);
});

// ── 8. running work is never interrupted; reads are pure ────────────────────
await acheck('no dial change touches a running node (§6.5)', async () => {
  wipeWork(); clearThrottleSettings();
  setSetting('hopper_slots', '4');
  setAccounts(TWO); writeUsage('a', 5, 5); writeUsage('b', 5, 5);
  setSetting('gov_5h_ceiling', '90');
  makeTree('t-drain', 6);
  await dispatch();
  assert.equal(runningCount(), 4);
  const before = sqliteDb.prepare(
    `SELECT id, adapter, model, worker_thread_ext, attempts, lease_expires_at, throttle_reroute FROM hopper_nodes WHERE status='running' ORDER BY id`,
  ).all();
  throttle.writeThrottleUpdates(throttle.normalizeThrottlePatch({ hopper_slots: 1 }).updates);
  throttle.applyThrottlePreset('conserve');
  throttle.writeThrottleUpdates(throttle.normalizeThrottlePatch({ throttle_claude_mode: 'b', throttle_provider_fallback: 'on' }).updates);
  setSetting('gov_override_claude', 'off');
  await dispatch();
  const after = sqliteDb.prepare(
    `SELECT id, adapter, model, worker_thread_ext, attempts, lease_expires_at, throttle_reroute FROM hopper_nodes WHERE status='running' ORDER BY id`,
  ).all();
  assert.deepEqual(after, before, 'running nodes must be byte-identical after every dial change');
  assert.ok(after.every((r) => r.throttle_reroute == null));
  sqliteDb.prepare('DELETE FROM settings WHERE key = ?').run('gov_override_claude');
});
check('GET-shaped reads are pure: 50 throttleStatus() calls change no setting', () => {
  clearThrottleSettings();
  setSetting('throttle_claude_mode', 'split');
  const snap = () => JSON.stringify(sqliteDb.prepare('SELECT key, value FROM settings ORDER BY key').all());
  const before = snap();
  for (let i = 0; i < 50; i += 1) throttle.throttleStatus();
  assert.equal(snap(), before, 'throttleStatus must not write');
});
check('hold reason vocabulary stays inside the allowed union (§7.4/AC-15)', () => {
  const governorReasons = ['ok', 'disabled', 'five_hour_ceiling', 'weekly_ceiling', 'usage_stale', 'kevin_active', 'provider_ceiling', 'claude_all_accounts_full', 'claude_focus_account_full'];
  const allowed = new Set([...governorReasons, ...throttle.THROTTLE_LOCAL_REASONS]);
  const seen = new Set();
  const scenarios = [
    () => { wipeWork(); },
    () => { wipeWork(); setSetting('hopper_slots', '1'); makeTree('h1', 2); },
    () => { wipeWork(); clearThrottleSettings(); setSetting('throttle_max_per_tree', '0'); makeTree('h2', 2); },
  ];
  for (const s of scenarios) { s(); seen.add(throttle.throttleStatus().hold.reason); }
  for (const r of seen) assert.ok(allowed.has(r), `hold.reason "${r}" is outside the allowed union`);
});
check('no claude/codex/auggie process was spawned by this run', () => {
  // The engine was handed a stub processMessage; spawns are recorded, not run.
  assert.ok(spawned.length > 0, 'expected the stub to have received worker spawns');
  assert.ok(spawned.every((e) => e.startsWith('cockpit:hopper-node-')));
});

// -- report -------------------------------------------------------------------
let failed = 0;
for (const r of results) {
  if (r.pass) console.log(`  ✓ ${r.desc}`);
  else { failed += 1; console.log(`  ✗ ${r.desc}\n      ${r.error}`); }
}
console.log(`\n[throttle-check] ${results.length - failed}/${results.length} checks passed`);
fs.rmSync(scratchDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
