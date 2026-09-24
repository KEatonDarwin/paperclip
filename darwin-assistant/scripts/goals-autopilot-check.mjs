// GOALS AUTOPILOT CHECK (CONTRACT §15, tree-a2a9e6b2 node #538) — scratch-DB
// smoke for the v0.4 backend: goal → autopilot on (route 37) → JARVIS propose
// lands born-set 🌙 → propose_plan appends the VERIFY node + dispatches in the
// same call (node `working`, real hopper tree) → pre-pass parses a PASS verdict
// → night report writes. Plus the §15.3 verdict parser and the §15.1.1 config
// validation edges. NO API KEYS / no model calls (agent.js is stubbed by the
// loader hook; the driver interval is disabled; a stop file holds stray kicks).
//
//   npm run goals:autopilot-check
//   (or: JARVIS_DB_PATH=/tmp/goals-autopilot-check.db node scripts/goals-autopilot-check.mjs)

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

register(pathToFileURL(path.join(__dirname, 'goals-autopilot-check.hooks.mjs')), import.meta.url);

// ── scratch DB guard (before any dist/ module opens the sqlite handle) ──────
const raw = process.env.JARVIS_DB_PATH ?? '/tmp/goals-autopilot-check.db';
const DB_PATH = path.resolve(raw);
const LIVE_DB = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
if (DB_PATH === LIVE_DB) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
process.env.JARVIS_DB_PATH = DB_PATH;
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
console.log(`[autopilot-check] scratch DB: ${DB_PATH}`);

// Envs BEFORE any dist import: no driver interval, no guard poller, no governor,
// a stop file so any stray kick-tick holds at gate 2, and a scratch vault for
// the night report file.
process.env.GOALS_AUTOPILOT_DRIVER = '0';
process.env.GOAL_GUARD_POLLER = '0';
process.env.HOPPER_GOV_ENABLED = '0';
process.env.HOPPER_ENGINE_SLOTS = process.env.HOPPER_ENGINE_SLOTS ?? '8';
const STOP_FILE = '/tmp/goals-autopilot-check.stop';
process.env.GOALS_AUTOPILOT_STOP_FILE = STOP_FILE;
fs.writeFileSync(STOP_FILE, 'goals-autopilot-check holds ticks\n');
const VAULT = '/tmp/goals-autopilot-check-vault';
fs.rmSync(VAULT, { recursive: true, force: true });
process.env.GOALS_VAULT_ROOT = VAULT;
delete process.env.ANTHROPIC_API_KEY;

const distDir = path.join(repoRoot, 'dist');
const express = (await import('express')).default;
const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const goals = await import(path.join(distDir, 'goals.js'));
const ap = await import(path.join(distDir, 'goals-autopilot.js'));
const { sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));

let passed = 0;
function ok(name, cond, extra) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { console.error(`  ✗ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`); process.exitCode = 1; throw new Error(`check failed: ${name}`); }
}
function events(goalId, kind) {
  return sqliteDb.prepare(`SELECT * FROM goal_events WHERE goal_id = ? AND kind = ? ORDER BY id ASC`).all(goalId, kind);
}

// ── throwaway HTTP server for routes 37–39 ──────────────────────────────────
const key = mintApiKey('autopilot-check-admin', 'cockpit').plaintext;
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/v1', createApiV1Router());
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const PORT = server.address().port;
async function api(method, urlPath, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}/api/v1${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  // errors arrive as {error:{code,message,...extra}} — flatten for the checks
  const code = json?.error?.code ?? json?.code ?? null;
  const reason = json?.error?.reason ?? json?.extra?.reason ?? null;
  return { status: res.status, json, code, reason };
}

try {
  // [1] §15.3 parseVerdict (pure) -------------------------------------------
  console.log('[1] parseVerdict');
  const pv = ap.parseVerdict;
  ok('PASS parses', pv('VERDICT: PASS\nevidence:\n- ran tests, 12/12\ngaps:\n- none').verdict === 'PASS');
  ok('PASS evidence text', pv('VERDICT: PASS\nevidence:\n- ran tests, 12/12\ngaps:\n- none').evidence === '- ran tests, 12/12');
  ok('FAIL gap parses', pv('VERDICT: FAIL\nevidence:\n- hit the endpoint\ngaps:\n- endpoint 500s on empty body').gaps[0] === 'endpoint 500s on empty body');
  ok('no VERDICT line = FAIL no-verdict', pv('all good').gaps[0].startsWith('no verdict'));
  ok('empty result = FAIL no-verdict', pv('').verdict === 'FAIL');
  ok('non-done hopper status = FAIL', pv('VERDICT: PASS\ngaps:\n- none', 'split').gaps[0].startsWith('no verdict'));
  // Changed 2026-09-24: a PASS that also lists gaps STAYS a PASS. The old
  // downgrade cost real re-plan trees on goal-5 nodes #49 and #52 when the
  // verifier passed and then listed nice-to-haves. The contract says the first
  // line's token IS the verdict; gaps survive as advisory follow-ups.
  const advisory = pv('VERDICT: PASS\nevidence:\n- looked\ngaps:\n- one real gap');
  ok('PASS with gaps STAYS pass (no phantom re-plan round)', advisory.verdict === 'PASS');
  ok('...and its gaps are kept, marked advisory', advisory.gaps.length === 1 && advisory.gaps[0] === 'advisory (did not block PASS): one real gap');
  ok('a real FAIL is still a FAIL', pv('VERDICT: FAIL\ngaps:\n- broken').verdict === 'FAIL');

  // [2] goal + route 37 on --------------------------------------------------
  console.log('[2] autopilot on (route 37)');
  const { goal } = goals.createGoal({ title: 'Autopilot smoke goal', done_means: 'the smoke passes end to end', actor: 'kevin' });
  const gid = goal.id;

  const badDepth = await api('POST', `/goals/${gid}/autopilot`, { on: true, config: { max_depth: 9 } });
  ok('config max_depth 9 → 400 autopilot_config_invalid', badDepth.status === 400 && badDepth.code === 'autopilot_config_invalid', badDepth);
  const badModel = await api('POST', `/goals/${gid}/autopilot`, { on: true, config: { verify_model: 'claude-fable-5' } });
  ok('config verify_model fable → 400', badModel.status === 400 && badModel.code === 'autopilot_config_invalid', badModel);
  const badKey = await api('POST', `/goals/${gid}/autopilot`, { on: true, config: { nope: 1 } });
  ok('unknown config key → 400', badKey.status === 400 && badKey.code === 'autopilot_config_invalid', badKey);

  const on = await api('POST', `/goals/${gid}/autopilot`, { on: true });
  ok('on → 200', on.status === 200, on);
  ok('goal.autopilot=1', on.json?.goal?.autopilot === 1, on.json?.goal);
  ok('config merged over defaults', on.json?.goal?.autopilot_config?.build_model === 'claude-sonnet-5' && on.json.goal.autopilot_config.max_attempts === 2);
  ok('started_at set', typeof on.json?.goal?.autopilot_config?.started_at === 'string');
  ok('autopilot_on event', events(gid, 'autopilot_on').length === 1);
  ok('status in response', on.json?.autopilot?.autopilot === 1, on.json?.autopilot);

  const ghostGoal = goals.createGoal({ title: 'Ghost goal (no done_means)', actor: 'kevin' });
  const notSet = await api('POST', `/goals/${ghostGoal.goal.id}/autopilot`, { on: true });
  ok('on a ghost goal → 409 goal_not_set', notSet.status === 409 && notSet.code === 'goal_not_set', notSet);

  // [3] JARVIS propose lands born set 🌙 --------------------------------------
  console.log('[3] propose → born set');
  const proposal = goals.proposeGoalNodes(gid, {
    parent_id: null,
    items: [
      { title: 'Build the widget', done_means: 'widget builds clean', leaf_kind: 'machine' },
      { title: 'Something vaguer', done_means: 'the vaguer thing is true' },
    ],
    actor: 'jarvis',
  });
  ok('rows born set', proposal.nodes.every((n) => n.state === 'set'));
  ok('rows carry autopilot_set=1', proposal.nodes.every((n) => n.autopilot_set === 1));
  ok('no proposal_batch on rows', proposal.nodes.every((n) => n.proposal_batch === null));
  ok('autopilot_set events ×2, no node_proposed', events(gid, 'autopilot_set').length === 2 && events(gid, 'node_proposed').length === 0);
  const leaf = proposal.nodes[0];

  // [4] propose_plan appends VERIFY + dispatches in the same call -------------
  console.log('[4] propose_plan → VERIFY appended + working');
  const tooLong = await api('POST', `/goals/${gid}/nodes/${leaf.id}/propose_plan`, {
    plan: { what: 'w', deliverable: 'd', model: 'claude-sonnet-5', nodes: Array.from({ length: 12 }, (_v, i) => ({ title: `n${i}`, spec: 's', model: 'claude-sonnet-5' })) },
    actor: 'jarvis',
  });
  ok('12 build nodes → 400 autopilot_plan_too_long', tooLong.status === 400 && tooLong.reason === 'autopilot_plan_too_long', tooLong);
  const reserved = await api('POST', `/goals/${gid}/nodes/${leaf.id}/propose_plan`, {
    plan: { what: 'w', deliverable: 'd', model: 'claude-sonnet-5', nodes: [{ title: 'VERIFY: mine', spec: 's', model: 'claude-sonnet-5' }] },
    actor: 'jarvis',
  });
  ok('VERIFY-titled node → 400 verify_node_reserved', reserved.status === 400 && reserved.reason === 'verify_node_reserved', reserved);

  const planned = await api('POST', `/goals/${gid}/nodes/${leaf.id}/propose_plan`, {
    plan: {
      what: 'build the widget', deliverable: 'a widget', model: 'claude-sonnet-5', estimate: '2 nodes',
      nodes: [
        { title: 'write it', spec: 'write the widget', model: 'claude-sonnet-5' },
        { title: 'wire it', spec: 'wire the widget', model: 'claude-haiku-4-5-20251001', depends_on_indexes: [0] },
      ],
    },
    actor: 'jarvis',
  });
  ok('dispatched in the same call (tree in response)', planned.status === 200 && !!planned.json?.tree?.id, planned);
  ok('node working', planned.json?.node?.state === 'working');
  const plan = JSON.parse(sqliteDb.prepare(`SELECT plan FROM goal_nodes WHERE id = ?`).get(leaf.id).plan);
  ok('plan has 3 nodes (2 builds + VERIFY)', plan.nodes.length === 3, plan.nodes.map((n) => n.title));
  ok('VERIFY is last, titled, on verify_model', plan.verify_index === 2 && plan.nodes[2].title === `VERIFY: ${leaf.title}` && plan.nodes[2].model === 'claude-opus-5');
  ok('VERIFY depends on every build node', JSON.stringify(plan.nodes[2].depends_on_indexes) === '[0,1]');
  ok('verify_hopper_node_id stored', typeof plan.verify_hopper_node_id === 'number');
  const treeId = planned.json.tree.id;
  const hopperCount = sqliteDb.prepare(`SELECT COUNT(*) AS n FROM hopper_nodes WHERE tree_id = ?`).get(treeId).n;
  ok('hopper tree has 3 nodes', hopperCount === 3, hopperCount);
  const verifySpec = sqliteDb.prepare(`SELECT spec FROM hopper_nodes WHERE id = ?`).get(plan.verify_hopper_node_id).spec;
  ok('VERIFY spec carries the done_means verbatim', verifySpec.includes(leaf.done_means));
  ok('VERIFY spec had {{tree_id}} substituted', verifySpec.includes(treeId) && !verifySpec.includes('{{tree_id}}'));
  ok('autopilot_dispatched event (attempt 1)', JSON.parse(events(gid, 'autopilot_dispatched')[0].data).attempt === 1);
  ok('plan_approved actor system', events(gid, 'plan_approved').every((e) => e.actor === 'system'));

  // [5] route 38 status -------------------------------------------------------
  console.log('[5] status (route 38)');
  const status = await api('GET', `/goals/${gid}/autopilot`);
  ok('status 200 autopilot=1', status.status === 200 && status.json?.autopilot === 1, status);
  ok('blocked_by=stop_file (gate 2 held by the check)', status.json?.blocked_by === 'stop_file', status.json);
  ok('working=1 counted', status.json?.working === 1);

  // [6] pre-pass parses a PASS verdict (held tick still resolves it) ----------
  console.log('[6] pre-pass PASS');
  sqliteDb.prepare(`UPDATE hopper_nodes SET status = 'done', result = ? WHERE id = ?`)
    .run('VERDICT: PASS\nevidence:\n- ran the widget, it widgeted\ngaps:\n- none', plan.verify_hopper_node_id);
  // tree done → node check (normally goalsOnTreeStatus does this; set it directly here)
  sqliteDb.prepare(`UPDATE goal_nodes SET state = 'check', tree_status_cache = 'done' WHERE id = ?`).run(leaf.id);
  await ap.tickAutopilot(gid, 'check-script');
  const afterTick = sqliteDb.prepare(`SELECT state, autopilot_verdict, autopilot_attempts FROM goal_nodes WHERE id = ?`).get(leaf.id);
  ok('node done after PASS', afterTick.state === 'done', afterTick);
  ok('verdict stored with tree_id', JSON.parse(afterTick.autopilot_verdict).tree_id === treeId);
  ok('no attempt consumed on PASS', afterTick.autopilot_attempts === 0);
  ok('node_verified actor system', events(gid, 'node_verified').some((e) => e.actor === 'system' && e.node_id === leaf.id));

  // [7] night report (route 39) ----------------------------------------------
  console.log('[7] night report (route 39)');
  const report = await api('GET', `/goals/${gid}/autopilot/report`);
  ok('report 200 + written', report.status === 200 && report.json?.written === true, report);
  ok('report file exists in the scratch vault', fs.existsSync(path.join(VAULT, report.json.path)));
  for (const h of ['# 🌙 Autopilot night report', '## Plan (the tree as JARVIS shaped it)', '## What ran', "## What's waiting on you", '## Where it stopped and why', "## The orchestrator's own read", '## Event trail']) {
    ok(`report section: ${h.slice(0, 34)}…`, report.json.markdown.includes(h));
  }
  ok('report What-ran row for the dispatch', report.json.markdown.includes(treeId));
  const noRun = await api('GET', `/goals/${ghostGoal.goal.id}/autopilot/report`);
  ok('never-on goal → 404 no_autopilot_run', noRun.status === 404 && noRun.code === 'no_autopilot_run', noRun);

  // [8] off restores v0.3 gating ----------------------------------------------
  console.log('[8] off (route 37)');
  const off = await api('POST', `/goals/${gid}/autopilot`, { on: false, actor: 'kevin' });
  ok('off → autopilot=0 stop_reason kevin', off.json?.goal?.autopilot === 0 && off.json?.goal?.autopilot_config?.stop_reason === 'kevin', off.json?.goal);
  ok('autopilot_off event', events(gid, 'autopilot_off').length === 1);
  const ghostAgain = goals.proposeGoalNodes(gid, { parent_id: null, items: [{ title: 'post-off ghost', done_means: 'stays a ghost' }], actor: 'jarvis' });
  ok('propose after off → ghost again', ghostAgain.nodes[0].state === 'ghost' && ghostAgain.nodes[0].proposal_batch !== null);
  ok('node_proposed event returns', events(gid, 'node_proposed').length === 1);
  const offNoop = await api('POST', `/goals/${gid}/autopilot`, { on: false });
  ok('off on an off goal → 200 no-op', offNoop.status === 200 && events(gid, 'autopilot_off').length === 1);

  console.log(`\n[autopilot-check] ALL ${passed} CHECKS PASSED`);
} finally {
  server.close();
  fs.rmSync(STOP_FILE, { force: true });
}
process.exit(process.exitCode ?? 0);
