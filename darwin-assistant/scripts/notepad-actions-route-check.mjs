#!/usr/bin/env node
// NOTEPAD ACTIONS ROUTE CHECK (node #877) — the read side of the routing
// chain: resolveActionRef (src/notepad-action-resolver.ts) and
// GET /api/v1/notepad/:date/actions.
//
// Unlike the sibling notepad-marker-route-check.mjs / notepad-handoff-route-
// check.mjs (which reimplement each route's two inline guards over the
// exported store functions), this check drives the REAL express router via
// the REAL startUiServer() — the route is a plain read composed of several
// existing exports with no seam worth stubbing, so hitting it over HTTP on a
// spare port is the more direct proof and avoids maintaining a second copy
// of the route's logic. JARVIS_UI_PORT is set before ui-server.js is ever
// imported, since UI_PORT is computed at module-load time. Auth is real too:
// a fresh admin-scope key is minted straight into the scratch DB via
// api-keys.js and sent as the bearer token, exactly as a real cockpit caller
// would.
//
//   npm run build && JARVIS_DB_PATH=/tmp/np-actions-<ts>.db node scripts/notepad-actions-route-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

// ── scratch DB guard (copied verbatim from the sibling notepad checks) ──────
const raw = process.env.JARVIS_DB_PATH;
if (!raw || !raw.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path.');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

console.log(`[notepad-actions-route-check] DB: ${DB_PATH}`);

function claudeProcessCount() {
  try {
    const out = execSync('pgrep -c -f claude', { encoding: 'utf8' });
    return parseInt(out.trim(), 10) || 0;
  } catch (err) {
    // pgrep exits 1 when nothing matches — that's zero, not a failure.
    if (err && err.status === 1) return 0;
    throw err;
  }
}

const spawnsBefore = claudeProcessCount();

// No real Smarty Pants / model reachable from this scratch run.
process.env.JARVIS_SMARTY_PANTS_URL = 'http://127.0.0.1:1';
process.env.JARVIS_MCP_NATIVE_TIMEOUT_MS = '5000';

// A spare port, set BEFORE ui-server.js is imported (UI_PORT is computed at
// module-load time from this env var, not read lazily inside startUiServer).
const PORT = 34567 + (process.pid % 1000);
process.env.JARVIS_UI_PORT = String(PORT);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

const distDir = path.join(repoRoot, 'dist');
const { putNotepadDay, markLineActed } = await import(path.join(distDir, 'notepad.js'));
const { sqliteDb, getOrCreateConversation } = await import(path.join(distDir, 'conversation-db.js'));
const { createGoal, createGoalNode } = await import(path.join(distDir, 'goals.js'));
const { createHopperItem } = await import(path.join(distDir, 'hopper.js'));
const { createWorkstream } = await import(path.join(distDir, 'workstreams.js'));
const { buildActionRef } = await import(path.join(distDir, 'notepad-dispatch.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const { startUiServer } = await import(path.join(distDir, 'ui-server.js'));

let failed = false;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

function lineIdByText(saved, text) {
  const line = saved.lines.find((l) => l.text === text);
  assert.ok(line, `fixture line '${text}' must exist`);
  return line.id;
}

startUiServer();

const { plaintext: apiKey } = mintApiKey('notepad-actions-route-check', 'admin');

async function get(pathAndQuery) {
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// -- fixtures: one real target per ref kind ---------------------------------
const goal = createGoal({ title: 'Actions route check goal', done_means: 'the check passes', authored_by: 'kevin' });
const node = createGoalNode(goal.goal.id, {
  title: 'A real node the check resolves',
  done_means: 'exists for the fixture',
  authored_by: 'kevin',
});
const hopperItem = createHopperItem({ title: 'Fix the composer route check fixture', source: 'test' });
const workstream = createWorkstream({ title: 'Route check fixture workstream', turn: 'jarvis', next_action: 'resolve me' });
const threadExt = 'cockpit:actions-route-check-thread';
getOrCreateConversation(threadExt);

const GOAL_REF = buildActionRef({ sink: 'goal_proposal', goal_id: goal.goal.id, node_id: node.id });
const HOPPER_REF = buildActionRef({ sink: 'hopper', candidate_id: hopperItem.id });
const WORKSTREAM_REF = buildActionRef({ sink: 'workstream', workstream_id: workstream.id });
const THREAD_REF = buildActionRef({ sink: 'thread', thread_ext: threadExt });

const DAY = '2026-09-25';
const GOAL_TEXT = 'goal-shaped acted line';
const HOPPER_TEXT = 'hopper-shaped acted line';
const WORKSTREAM_TEXT = 'workstream-shaped acted line';
const THREAD_TEXT = 'thread-shaped acted line';
const MALFORMED_TEXT = 'a line with a malformed ref';
const UNACTED_TEXT = 'a line nobody ever acted on';

const saved = putNotepadDay(
  DAY,
  [GOAL_TEXT, HOPPER_TEXT, WORKSTREAM_TEXT, THREAD_TEXT, MALFORMED_TEXT, UNACTED_TEXT].join('\n'),
);
const goalLineId = lineIdByText(saved, GOAL_TEXT);
const hopperLineId = lineIdByText(saved, HOPPER_TEXT);
const workstreamLineId = lineIdByText(saved, WORKSTREAM_TEXT);
const threadLineId = lineIdByText(saved, THREAD_TEXT);
const malformedLineId = lineIdByText(saved, MALFORMED_TEXT);
lineIdByText(saved, UNACTED_TEXT); // exists but deliberately never acted

markLineActed(goalLineId, GOAL_REF);
markLineActed(hopperLineId, HOPPER_REF);
markLineActed(workstreamLineId, WORKSTREAM_REF);
markLineActed(threadLineId, THREAD_REF);
markLineActed(malformedLineId, 'not-a-real-ref');

// -- (1) malformed date -> 400, matching GET /notepad's error shape ---------
{
  const result = await get('/notepad/2026-13-40/actions');
  check('malformed date returns 400', result.status === 400);
  check('malformed date returns invalid_date', result.body?.error?.code === 'invalid_date');
}

// -- (2) the day's acted lines resolve, each of the four kinds exists:true --
{
  const result = await get(`/notepad/${DAY}/actions`);
  check('GET returns 200', result.status === 200);
  const rows = result.body;
  check('response is an array', Array.isArray(rows));
  check('the unacted line is omitted (not acted -> not in the list)', !rows.some((r) => r.line_text === UNACTED_TEXT));
  check('exactly five acted lines are present (4 real + 1 malformed)', rows.length === 5);

  const byText = (t) => rows.find((r) => r.line_text === t);

  const g = byText(GOAL_TEXT);
  check('goal row present with correct action_ref', g?.action_ref === GOAL_REF);
  check('goal row resolves exists:true', g?.resolved.exists === true);
  check('goal row label carries the node number and title', g?.resolved.label === `#${node.id} A real node the check resolves`);
  check('goal row url is /goals/<goal_id>', g?.resolved.url === `/goals/${goal.goal.id}`);
  check('goal row broken_reason is null on success', g?.resolved.broken_reason === null);
  check('goal row kind is goal_proposal', g?.resolved.kind === 'goal_proposal');

  const h = byText(HOPPER_TEXT);
  check('hopper row resolves exists:true with the item title', h?.resolved.exists === true && h.resolved.label === hopperItem.title);
  check('hopper row url is /hopper', h?.resolved.url === '/hopper');

  const w = byText(WORKSTREAM_TEXT);
  check('workstream row resolves exists:true with the workstream title', w?.resolved.exists === true && w.resolved.label === workstream.title);
  check('workstream row url is /flight-deck', w?.resolved.url === '/flight-deck');

  const t = byText(THREAD_TEXT);
  check('thread row resolves exists:true', t?.resolved.exists === true);
  check('thread row url is /thread/<encoded ext>', t?.resolved.url === `/thread/${encodeURIComponent(threadExt)}`);
  check('thread row label falls back to the external_id (no title set)', t?.resolved.label === threadExt);

  const m = byText(MALFORMED_TEXT);
  check('malformed ref row is a 200, not a 500 (never omitted, never crashes)', result.status === 200 && !!m);
  check('malformed ref resolves exists:false', m?.resolved.exists === false);
  check('malformed ref has a non-empty broken_reason', typeof m?.resolved.broken_reason === 'string' && m.resolved.broken_reason.length > 0);
  check('malformed ref kind is unknown', m?.resolved.kind === 'unknown');
  check('malformed ref label/url are null', m?.resolved.label === null && m?.resolved.url === null);

  check('move_kind is present (null when no marker) on every row', rows.every((r) => 'move_kind' in r));
}

// -- (3) delete the goal node from the scratch DB -> broken ref, still present
{
  // Clear rows that FK-reference this node (goal_events logged its own
  // creation) before the hard delete — simulating a target that is
  // genuinely gone, not one merely orphaned by a half-cleaned test fixture.
  sqliteDb.prepare('DELETE FROM goal_events WHERE node_id = ?').run(node.id);
  sqliteDb.prepare('UPDATE goal_focus SET node_id = NULL WHERE node_id = ?').run(node.id);
  sqliteDb.prepare('DELETE FROM goal_nodes WHERE id = ?').run(node.id);
  const result = await get(`/notepad/${DAY}/actions`);
  const g = result.body.find((r) => r.line_text === GOAL_TEXT);
  check('a line whose target was deleted is STILL present in the response', !!g);
  check('its resolution flips to exists:false', g?.resolved.exists === false);
  check('its broken_reason names the missing node', typeof g?.resolved.broken_reason === 'string' && g.resolved.broken_reason.includes(String(node.id)));
  check('label/url are null once broken', g?.resolved.label === null && g?.resolved.url === null);
}

// -- (4) a day with no acted lines -> empty array, not null -----------------
{
  const EMPTY_DAY = '2026-09-26';
  putNotepadDay(EMPTY_DAY, ['a line, but nobody acted on it'].join('\n'));
  const result = await get(`/notepad/${EMPTY_DAY}/actions`);
  check('a day with no acted lines returns 200', result.status === 200);
  check('a day with no acted lines returns an empty array (not null)', Array.isArray(result.body) && result.body.length === 0);

  const NEVER_SEEN_DAY = '2026-09-27';
  const result2 = await get(`/notepad/${NEVER_SEEN_DAY}/actions`);
  check('a day that was never touched at all also returns an empty array', Array.isArray(result2.body) && result2.body.length === 0);
}

// -- (5) zero net new claude processes spawned across the whole run ---------
const spawnsAfter = claudeProcessCount();
check(`no net new claude processes spawned (before=${spawnsBefore}, after=${spawnsAfter})`, spawnsAfter <= spawnsBefore);

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
