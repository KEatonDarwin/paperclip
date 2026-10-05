#!/usr/bin/env node
// BRIDGE_SEND CHECK — acceptance test for node #1430 (wish-catalog pilot,
// tree-3e526df9): the real send-to-Kevin-style relay tool. Exercises the
// real tool against a scratch DB, real bootstrap (dist/*.js, same modules
// the server runs). No model calls, no HTTP, no touch of the live jarvis.db.
//
//   npm run build && JARVIS_DB_PATH=/tmp/bridge-send-check.db node scripts/bridge-send-check.mjs
//
// Proves:
//   (a) bridge_send from the companion side inserts a cross_chat_sidecar row
//       into the bridged goal-12 partner, with a non-empty summary + from_label.
//   (b) the stored summary is a digest, not the raw idea verbatim.
//   (c) 'cross_chat_sidecar' is registered in sse-bus.ts's GLOBAL_STREAM_EVENT_TYPES
//       (the binding rule: unregistered SSE types never reach a client), and the
//       dedicated SSE event actually fires on insert.
//   (d) bridge_send from an UNBRIDGED thread returns a clean no-bridge error,
//       never a throw/500.
//   (e) the companion thread's resolved tool list is still exactly
//       {bridge_send} — no widening of the fail-closed allow-list (#1383 style).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── scratch DB guard ─────────────────────────────────────────────────────────
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

console.log(`[bridge-send-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { getConversation, getOrCreateConversation, getTurns, sqliteDb } = await import(
  path.join(distDir, 'conversation-db.js')
);
const { companionThreadExt, getOrCreateCompanionThread, allowedToolsForThread, COMPANION_BRIDGE_TOOL_NAME } =
  await import(path.join(distDir, 'companion-chat.js'));
const { ALL_TOOLS } = await import(path.join(distDir, 'tools/index.js'));
const { sseBus, GLOBAL_STREAM_EVENT_TYPES } = await import(path.join(distDir, 'sse-bus.js'));

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`PASS: ${label}`);
  } else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

const bridgeSend = ALL_TOOLS.find((t) => t.name === COMPANION_BRIDGE_TOOL_NAME);
check('bridge_send is registered in ALL_TOOLS', !!bridgeSend);

// ── setup: companion thread bridged to cockpit:goal-12 ───────────────────────
const COMPANION_ID = 'wish-pilot-1430';
const companionExt = companionThreadExt(COMPANION_ID);
const { external_id: createdCompanionExt } = getOrCreateCompanionThread(COMPANION_ID);
check('companion thread created with the expected external_id', createdCompanionExt === companionExt);

const GOAL_EXT = 'cockpit:goal-12';
const goalConv = getOrCreateConversation(GOAL_EXT);

sqliteDb
  .prepare(`INSERT INTO thread_bridges (thread_a_ext, thread_b_ext) VALUES (?, ?)`)
  .run(companionExt, GOAL_EXT);

const companionConv = getConversation(companionExt);

function buildContext(externalId, conversationId) {
  return {
    conversationId,
    externalId,
    sourceMessageId: 'test-msg',
    sourceTimestamp: new Date().toISOString(),
    originalText: 'test',
  };
}

// ── (c) listen for the dedicated SSE event before calling the tool ──────────
let capturedSidecarEvent = null;
const sseHandler = (ev) => {
  if (ev.type === 'cross_chat_sidecar') capturedSidecarEvent = ev;
};
sseBus.on('sse', sseHandler);

// ── (a)/(b) bridge_send from the companion side ──────────────────────────────
const RAW_IDEA =
  'Idea for the wish catalog: a "surprise me" button that picks a small gift ' +
  'from the Circle & Flip board at random, with a short note on why it fits ' +
  'this week, so the list stays fun instead of turning into another chore. ' +
  'Also maybe a monthly theme (cozy, adventurous, practical) to keep it varied ' +
  'and not just the same three categories every time someone opens it up.\n\n' +
  'Second half of the idea, on a new line, to make sure a raw dump would look ' +
  'nothing like the stored digest: price ceiling per item, and a running tally ' +
  'so it never silently blows the monthly budget.';

const sendResult = await bridgeSend.execute({ idea: RAW_IDEA }, buildContext(companionExt, companionConv.id));

check('(a) bridge_send delivered to the goal-12 partner', Array.isArray(sendResult.delivered_to) && sendResult.delivered_to.includes(GOAL_EXT));

const goalTurns = getTurns(goalConv.id);
const sidecarTurn = goalTurns.find((t) => t.role === 'cross_chat_sidecar');
check('(a) a cross_chat_sidecar row now exists in goal-12', !!sidecarTurn);

const payload = sidecarTurn ? JSON.parse(sidecarTurn.tool_args) : null;
check('(a) the row carries a non-empty summary', !!payload?.summary && payload.summary.trim().length > 0);
check('(a) the row carries a non-empty from_label', !!payload?.from_label && payload.from_label.trim().length > 0);
check('(a) the row carries the origin + destination thread ids', payload?.from_thread_ext === companionExt && payload?.to_thread_ext === GOAL_EXT);

check('(b) the stored summary is a digest, not the raw idea verbatim', payload?.summary !== RAW_IDEA);
check('(b) the digest is shorter than the raw idea', (payload?.summary.length ?? Infinity) < RAW_IDEA.length);
check('(b) the digest has no embedded newlines (raw turns were not dumped)', !payload?.summary.includes('\n'));

check('(c) cross_chat_sidecar is in GLOBAL_STREAM_EVENT_TYPES', GLOBAL_STREAM_EVENT_TYPES.includes('cross_chat_sidecar'));
check('(c) the dedicated SSE event fired with the goal-12 conversationId', capturedSidecarEvent?.conversationId === goalConv.id);
check('(c) the dedicated SSE event carries the same summary', capturedSidecarEvent?.sidecar?.summary === payload?.summary);

sseBus.off('sse', sseHandler);

// ── (d) bridge_send from an unbridged thread ─────────────────────────────────
const UNBRIDGED_ID = 'wish-pilot-no-bridge';
const unbridgedExt = companionThreadExt(UNBRIDGED_ID);
const { external_id: createdUnbridgedExt } = getOrCreateCompanionThread(UNBRIDGED_ID);
const unbridgedConv = getConversation(createdUnbridgedExt);

let unbridgedThrew = false;
let unbridgedResult;
try {
  unbridgedResult = await bridgeSend.execute({ idea: 'anything' }, buildContext(unbridgedExt, unbridgedConv.id));
} catch {
  unbridgedThrew = true;
}
check('(d) bridge_send from an unbridged thread does not throw', !unbridgedThrew);
check('(d) bridge_send from an unbridged thread returns a clean no_bridge error', typeof unbridgedResult?.error === 'string' && unbridgedResult.error.startsWith('no_bridge'));

// ── (e) companion tool list is still exactly {bridge_send} ──────────────────
const allToolNames = ALL_TOOLS.map((t) => t.name);
const allowed = allowedToolsForThread(companionExt);
const companionTools = allowed ? allToolNames.filter((n) => allowed.has(n)) : allToolNames;
check(
  '(e) companion thread resolved tool list is exactly {bridge_send}',
  companionTools.length === 1 && companionTools[0] === COMPANION_BRIDGE_TOOL_NAME && COMPANION_BRIDGE_TOOL_NAME === 'bridge_send',
);
const OPS_TOOLS = ['goals', 'hopper', 'throttle', 'work_switch', 'deploy_control', 'supabase_execute_sql', 'mcp_call'];
for (const name of OPS_TOOLS) {
  check(`(e) ops tool "${name}" is NOT in the companion allow-list`, !companionTools.includes(name));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
} else {
  console.log('\nAll checks passed.');
}
