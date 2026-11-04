#!/usr/bin/env node
// LAYMAN LAYER WIRING CHECK (tree-9e15d8a7, node #1073) — hermetic proof that
// the three new wirings (goal_nodes.verdict_summary via recordAutopilotVerdict,
// night_items.result_gloss via finishItem, and the report TL;DR-first sections)
// never block or throw when the claude CLI is unavailable, and that the report
// builders fall back to a deterministic TL;DR.
//
//   JARVIS_DB_PATH=/tmp/layman-layer-wiring-check.db JARVIS_SIM=1 CLAUDE_CLI_PATH=/bin/false node scripts/layman-layer-wiring-check.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
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
if (DB_PATH === path.resolve(repoRoot, 'jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
if (process.env.JARVIS_SIM !== '1') {
  console.error('FATAL: JARVIS_SIM=1 is required for this check.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

process.env.NIGHT_SHIFT_DRIVER = '0';
process.env.NIGHT_SHIFT_KICK_MS = '999999999';
process.env.GOALS_AUTOPILOT_DRIVER = '0';
process.env.GOALS_AUTOPILOT_KICK_MS = '999999999';
process.env.CLAUDE_CLI_PATH = process.env.CLAUDE_CLI_PATH || '/bin/false';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

let unhandled = null;
process.on('unhandledRejection', (err) => { unhandled = err; });

const dist = path.join(repoRoot, 'dist');
const { sqliteDb } = await import(path.join(dist, 'conversation-db.js'));
const goals = await import(path.join(dist, 'goals.js'));
const night = await import(path.join(dist, 'night-shift.js'));
const autopilot = await import(path.join(dist, 'goals-autopilot.js'));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok    ${name}`); }
  else { fail += 1; console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

console.log('== 1. recordAutopilotVerdict — goal_nodes.verdict_summary ==');
{
  const { goal } = goals.createGoal({ title: 'layman-check goal', done_means: 'wiring proven', actor: 'kevin' });
  const node = goals.createGoalNode(goal.id, { title: 'leaf', done_means: 'leaf done', authored_by: 'kevin', leaf_kind: 'machine', actor: 'kevin' });

  const start = Date.now();
  const result = goals.recordAutopilotVerdict(goal.id, node.id, {
    verdict: 'PASS', evidence: 'the thing works', gaps: [], tree_id: 'tree-check-1', at: new Date().toISOString(),
  });
  const elapsedMs = Date.now() - start;
  check('recordAutopilotVerdict returns synchronously', elapsedMs < 500, `took ${elapsedMs}ms`);
  check('recordAutopilotVerdict returns the node row', result && result.id === node.id);

  await sleep(1500);
  const fresh = sqliteDb.prepare('SELECT verdict_summary FROM goal_nodes WHERE id = ?').get(node.id);
  check('verdict_summary stays null with no claude CLI (never throws into the caller)', fresh.verdict_summary === null, JSON.stringify(fresh));
  check('no unhandled rejection after recordAutopilotVerdict', unhandled === null, String(unhandled));
}

console.log('== 2. finishItem (via tickNightShift syncItems) — night_items.result_gloss ==');
{
  const runInfo = sqliteDb.prepare(`
    INSERT INTO night_runs (status, mode, config, goal_ids, started_at)
    VALUES ('running', 'until_stop', '{}', '[]', datetime('now'))
  `).run();
  const runId = Number(runInfo.lastInsertRowid);
  const itemInfo = sqliteDb.prepare(`
    INSERT INTO night_items (run_id, position, goal_id, node_id, kind, title, status)
    VALUES (?, 1, 999999, 999999, 'verify', 'orphaned check item', 'running')
  `).run(runId);
  const itemId = Number(itemInfo.lastInsertRowid);

  const start = Date.now();
  await night.tickNightShift('layman-check');
  const elapsedMs = Date.now() - start;
  check('tickNightShift (syncItems -> finishItem) completes quickly', elapsedMs < 5000, `took ${elapsedMs}ms`);

  await sleep(1500);
  const item = sqliteDb.prepare('SELECT status, result_gloss, result_summary FROM night_items WHERE id = ?').get(itemId);
  check('item was finished (node is gone -> failed)', item.status === 'failed', JSON.stringify(item));
  check('result_gloss stays null with no claude CLI (never throws)', item.result_gloss === null, JSON.stringify(item));
  check('no unhandled rejection after finishItem', unhandled === null, String(unhandled));
}

console.log('== 3. buildNightShiftReport — TL;DR first, deterministic fallback ==');
{
  const runInfo = sqliteDb.prepare(`
    INSERT INTO night_runs (status, mode, config, goal_ids, started_at, ended_at, stop_reason)
    VALUES ('stopped', 'until_stop', '{"lanes":1}', '[]', datetime('now'), datetime('now'), 'kevin')
  `).run();
  const runId = Number(runInfo.lastInsertRowid);

  const report = await night.buildNightShiftReport(runId);
  check('report written', report.written === true, JSON.stringify(report));
  const lines = report.markdown.split('\n');
  const firstHeading = lines.findIndex((l) => l.startsWith('## '));
  check('## TL;DR is the FIRST section', lines[firstHeading] === '## TL;DR', lines.slice(0, 6).join(' | '));
  const tldrLine = lines[firstHeading + 1] || '';
  check('TL;DR falls back to the deterministic line (no claude CLI)', /\d+ done, \d+ failed, \d+ blocked, \d+ skipped\./.test(tldrLine), tldrLine);
}

console.log('== 4. buildNightReport (goals-autopilot) — TL;DR first, deterministic fallback ==');
{
  const { goal } = goals.createGoal({ title: 'layman-check autopilot goal', done_means: 'wiring proven', actor: 'kevin' });
  goals.setGoalAutopilot(goal.id, true, undefined, 'jarvis');

  const report = await autopilot.buildNightReport(goal.id);
  check('autopilot report written', report.written === true, JSON.stringify(report));
  const lines = report.markdown.split('\n');
  const firstHeading = lines.findIndex((l) => l.startsWith('## '));
  check('## TL;DR is the FIRST section', lines[firstHeading] === '## TL;DR', lines.slice(0, 6).join(' | '));
  const tldrLine = lines[firstHeading + 1] || '';
  check('TL;DR falls back to the deterministic line (no claude CLI)', /\d+ dispatch(es)? — \d+ passed, \d+ failed\./.test(tldrLine), tldrLine);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
