#!/usr/bin/env node
// WORK BOARD TESTS — hermetic unit tests for src/work-board.ts (tree-afe07b31,
// node #1547). No live data, no model calls.
//
//   npm run build
//   npm run work-board:test
//
// (drives the compiled dist/, like scripts/spawn-monitor-test.mjs. Importing
// dist/work-board.js pulls in conversation-db.js, which opens a sqlite handle
// at import time, so a JARVIS_DB_PATH scratch guard is required.)

import assert from 'node:assert/strict';
import fs from 'node:fs';
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
console.log(`[work-board-test] scratch DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const convDb = await import(path.join(distDir, 'conversation-db.js'));
const { getOrCreateConversation, addTurn, renameConversation, sqliteDb } = convDb;
const { listWorkBoardItems, parseWorkBoardRef, pinWorkBoardItem, updateWorkBoardItem, getWorkBoardSince, resetWorkBoardSince, consumeWorkBoardWatch } =
  await import(path.join(distDir, 'work-board.js'));

// The board's start point is FIXED (set once at now−5h in prod). Fixtures below
// use turns up to 10h old, so widen it for the suite; TEST 15 exercises the
// fixed-point rule itself.
resetWorkBoardSince({ hours: 24 });

// ── fixture helpers ──────────────────────────────────────────────────────
let seq = 0;
function makeConv(prefix = 'cockpit:wb-test-') {
  seq += 1;
  const externalId = `${prefix}${seq}`;
  const conv = getOrCreateConversation(externalId, null);
  return conv;
}
function hoursAgoStr(h) {
  return new Date(Date.now() - h * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
}
function daysAgoStr(d) {
  return hoursAgoStr(d * 24);
}
// Add a turn, then force its created_at to a specific timestamp (addTurn only
// ever writes datetime('now'), so tests that need stale/fresh activity must
// backdate directly). addTurn returns the turn_index, not the row id, so the
// backdate UPDATE keys off (conversation_id, turn_index).
function addTurnAt(conversationId, role, content, when) {
  const turnIndex = addTurn(conversationId, role, content);
  sqliteDb
    .prepare(`UPDATE turns SET created_at = ? WHERE conversation_id = ? AND turn_index = ?`)
    .run(when, conversationId, turnIndex);
  return turnIndex;
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── TEST 1: auto-population — recent user turn → included ──────────────────
{
  const conv = makeConv();
  addTurnAt(conv.id, 'user', 'hello', hoursAgoStr(1));
  const items = listWorkBoardItems(false);
  assert.ok(items.some((i) => i.external_id === conv.external_id), 'fresh cockpit chat with a user turn is on the board');
  ok('auto-population: recent user turn → included');
}

// ── TEST 2: ephemeral prefixes excluded even with a recent user turn ───────
{
  for (const prefix of ['cockpit:hopper-node-', 'cockpit:unblocker-', 'cockpit:shift-', 'cockpit:workstream-']) {
    const conv = makeConv(prefix);
    addTurnAt(conv.id, 'user', 'hi', hoursAgoStr(1));
    const items = listWorkBoardItems(false);
    assert.ok(!items.some((i) => i.external_id === conv.external_id), `${prefix} chat is excluded`);
  }
  ok('ephemeral prefixes (hopper-node-/unblocker-/shift-/workstream-) excluded');
}

// ── TEST 3: cockpit:goal- is explicitly KEPT ────────────────────────────────
{
  const conv = makeConv('cockpit:goal-');
  addTurnAt(conv.id, 'user', 'goal chat', hoursAgoStr(1));
  const items = listWorkBoardItems(false);
  assert.ok(items.some((i) => i.external_id === conv.external_id), 'cockpit:goal- chat is kept, not excluded as ephemeral');
  ok('cockpit:goal- kept (not treated as ephemeral)');
}

// ── TEST 4: non-cockpit prefix never auto-populates ─────────────────────────
{
  const conv = makeConv('slack:wb-test-');
  addTurnAt(conv.id, 'user', 'hi', hoursAgoStr(1));
  const items = listWorkBoardItems(false);
  assert.ok(!items.some((i) => i.external_id === conv.external_id), 'non-cockpit external_id is never auto-added');
  ok('non-cockpit prefix excluded from auto-population');
}

// ── TEST 5: user turn before the fixed start point (set once at now−5h) → excluded; assistant-only recency doesn't count ──
{
  const conv = makeConv();
  addTurnAt(conv.id, 'user', 'old message', daysAgoStr(20));
  addTurnAt(conv.id, 'assistant', 'fresh reply', hoursAgoStr(1));
  const items = listWorkBoardItems(false);
  assert.ok(!items.some((i) => i.external_id === conv.external_id), 'stale user turn (20d) with only a fresh assistant turn is excluded');
  ok('fixed start point keys off the user role specifically, not any turn');
}

// ── TEST 6: ASC ordering — oldest last_activity first ───────────────────────
{
  const convOld = makeConv();
  addTurnAt(convOld.id, 'user', 'oldest', hoursAgoStr(10));
  const convMid = makeConv();
  addTurnAt(convMid.id, 'user', 'middle', hoursAgoStr(5));
  const convNew = makeConv();
  addTurnAt(convNew.id, 'user', 'newest', hoursAgoStr(1));
  const items = listWorkBoardItems(false);
  const idx = (ext) => items.findIndex((i) => i.external_id === ext);
  assert.ok(idx(convOld.external_id) < idx(convMid.external_id), 'oldest sorts before middle');
  assert.ok(idx(convMid.external_id) < idx(convNew.external_id), 'middle sorts before newest');
  ok('sorted by last_activity ASC (oldest at top)');
}

// ── TEST 7: done hides the row by default ───────────────────────────────────
let doneConv;
{
  doneConv = makeConv();
  addTurnAt(doneConv.id, 'user', 'work on this', hoursAgoStr(3));
  const marked = updateWorkBoardItem(doneConv.external_id, { done: true });
  assert.ok(marked.done_at, 'done_at set after marking done');
  const items = listWorkBoardItems(false);
  assert.ok(!items.some((i) => i.external_id === doneConv.external_id), 'done row is hidden from the default list');
  ok('marking done hides the row (include_done=0)');
}

// ── TEST 8: include_done=1 shows it, greyed-out data intact ────────────────
{
  const items = listWorkBoardItems(true);
  const row = items.find((i) => i.external_id === doneConv.external_id);
  assert.ok(row, 'done row appears when include_done=1');
  assert.ok(row.done_at, 'done_at still populated');
  ok('include_done=1 surfaces the done row');
}

// ── TEST 9: Kevin replying after done_at auto-reopens it ────────────────────
{
  // Backdate done_at itself so the next (default-"now") turn is unambiguously later.
  sqliteDb.prepare(`UPDATE work_board_items SET done_at = ? WHERE external_id = ?`)
    .run(hoursAgoStr(2), doneConv.external_id);
  addTurn(doneConv.id, 'user', 'actually reopening this'); // created_at = now, after done_at

  const items = listWorkBoardItems(false);
  const row = items.find((i) => i.external_id === doneConv.external_id);
  assert.ok(row, 'reopened row is back on the default (not-done) list');
  assert.equal(row.done_at, null, 'done_at cleared');
  assert.equal(row.reopened, true, 'reopened flag set on the read that triggered the undo');
  ok('Kevin message after done_at auto-reopens the row');
}

// ── TEST 10: link parsing — all 3 pasted shapes + bare id ───────────────────
{
  const uuid = 'cockpit:1b9c1629-5fff-4065-8c12-061ae8ee577c';
  assert.equal(parseWorkBoardRef(uuid), uuid, 'bare external id');
  assert.equal(
    parseWorkBoardRef(`http://jarvis.ai:8080/threads?open=${encodeURIComponent(uuid)}`),
    uuid,
    'full threads?open= URL',
  );
  assert.equal(parseWorkBoardRef(`/threads?open=${encodeURIComponent(uuid)}`), uuid, 'relative threads?open= URL');
  assert.equal(parseWorkBoardRef(`http://jarvis.ai:8080/thread/${encodeURIComponent(uuid)}`), uuid, 'encoded pop-out /thread/ path');
  assert.equal(parseWorkBoardRef(`/thread/${uuid}`), uuid, 'unencoded pop-out /thread/ path');
  assert.equal(parseWorkBoardRef('not a link'), null, 'garbage input → null');
  assert.equal(parseWorkBoardRef('slack:abc'), null, 'non-cockpit bare id → null');
  ok('parseWorkBoardRef handles bare id + both pasted link shapes, rejects garbage');
}

// ── TEST 11: pin a chat explicitly; 404-equivalent (null) for unknown id ────
{
  const conv = makeConv();
  // No turns at all — would never auto-populate, but pinning puts it on the board.
  const pinned = pinWorkBoardItem(conv.external_id);
  assert.ok(pinned, 'pin succeeds for an existing conversation');
  assert.equal(pinned.pinned, true);
  const items = listWorkBoardItems(false);
  assert.ok(items.some((i) => i.external_id === conv.external_id), 'pinned-with-no-turns chat is still on the board');
  assert.equal(pinWorkBoardItem('cockpit:does-not-exist-xyz'), null, 'pinning an unknown external_id returns null');
  ok('pin surfaces a no-activity chat; unknown id returns null');
}

// ── TEST 12: PATCH on an unknown conversation returns null ─────────────────
{
  assert.equal(updateWorkBoardItem('cockpit:does-not-exist-xyz', { done: true }), null, 'patching an unknown id returns null');
  ok('updateWorkBoardItem on unknown conversation returns null');
}

// ── TEST 13: title override resolution — topic prefers override, falls back, clears ──
{
  const conv = makeConv();
  renameConversation(conv.id, 'Real Thread Title');
  addTurnAt(conv.id, 'user', 'go', hoursAgoStr(1));

  let items = listWorkBoardItems(false);
  let row = items.find((i) => i.external_id === conv.external_id);
  assert.equal(row.topic, 'Real Thread Title', 'topic falls back to conversation title with no override');

  updateWorkBoardItem(conv.external_id, { title_override: 'Kevin override' });
  items = listWorkBoardItems(false);
  row = items.find((i) => i.external_id === conv.external_id);
  assert.equal(row.topic, 'Kevin override', 'topic prefers title_override once set');
  assert.equal(row.title, 'Real Thread Title', 'raw title is still reported alongside the override');

  updateWorkBoardItem(conv.external_id, { title_override: '' });
  items = listWorkBoardItems(false);
  row = items.find((i) => i.external_id === conv.external_id);
  assert.equal(row.title_override, null, 'empty-string override clears back to null');
  assert.equal(row.topic, 'Real Thread Title', 'topic falls back to title again once override is cleared');

  ok('title_override resolution: set → clear → fall back to title');
}

// ── TEST 14: link field is always the relative, encoded threads?open= form ─
{
  const conv = makeConv();
  addTurnAt(conv.id, 'user', 'go', hoursAgoStr(1));
  const items = listWorkBoardItems(false);
  const row = items.find((i) => i.external_id === conv.external_id);
  assert.equal(row.link, `/threads?open=${encodeURIComponent(conv.external_id)}`, 'link is relative + url-encoded');
  ok('link field is the relative, encoded /threads?open= form');
}

for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });
// ── TEST 15: FIXED start point, not a rolling window ────────────────────────
{
  const convBefore = makeConv();
  addTurnAt(convBefore.id, 'user', 'before the line', hoursAgoStr(8));
  const convAfter = makeConv();
  addTurnAt(convAfter.id, 'user', 'after the line', hoursAgoStr(1));
  const s0 = getWorkBoardSince();
  assert.ok(s0.since && typeof s0.since_turn_id === 'number', 'since is persisted and readable');
  resetWorkBoardSince({ hours: 4 });
  let items = listWorkBoardItems(false);
  assert.ok(!items.some((i) => i.external_id === convBefore.external_id), 'user turn before the start point is excluded');
  assert.ok(items.some((i) => i.external_id === convAfter.external_id), 'user turn after the start point is included');
  const s1 = getWorkBoardSince();
  assert.equal(getWorkBoardSince().since, s1.since, 'start point does not move between reads (not rolling)');
  resetWorkBoardSince({ hours: 24 });
  items = listWorkBoardItems(false);
  assert.ok(items.some((i) => i.external_id === convBefore.external_id), 'moving the start point back brings the chat in');
  ok('fixed start point: set once, stays put, movable only by reset');
}

// ── TEST 16: auto importance — normal by default, hot when pinned, cool when cold ──
{
  const fresh = makeConv();
  addTurnAt(fresh.id, 'user', 'go', hoursAgoStr(1));
  let row = listWorkBoardItems(false).find((i) => i.external_id === fresh.external_id);
  assert.equal(row.importance, 2, 'a live chat sits at normal');
  assert.equal(row.importance_source, 'auto', 'and the level is automatic');

  pinWorkBoardItem(fresh.external_id);
  row = listWorkBoardItems(false).find((i) => i.external_id === fresh.external_id);
  assert.equal(row.importance, 3, 'pinning a chat makes it hot');

  const cold = makeConv();
  addTurnAt(cold.id, 'user', 'ancient', hoursAgoStr(30));
  resetWorkBoardSince({ hours: 48 }); // widen so a 30h-old chat is still listed
  row = listWorkBoardItems(false).find((i) => i.external_id === cold.external_id);
  assert.equal(row.importance, 1, 'a chat untouched for over a day goes cool');
  resetWorkBoardSince({ hours: 24 });
  ok('auto importance: normal by default, hot when pinned, cool after a day');
}

// ── TEST 17: a hand-set level wins, and null hands it back to automatic ────
{
  const conv = makeConv();
  addTurnAt(conv.id, 'user', 'go', hoursAgoStr(1));
  let row = updateWorkBoardItem(conv.external_id, { importance: 3 });
  assert.equal(row.importance, 3, 'the level Kevin set is the level in force');
  assert.equal(row.importance_source, 'manual', 'and it is reported as his, not the machine guess');
  assert.equal(row.importance_auto, 2, 'the automatic level is still reported alongside');

  row = updateWorkBoardItem(conv.external_id, { importance: null });
  assert.equal(row.importance_source, 'auto', 'clearing hands the chat back to the automatic level');
  assert.equal(row.importance, 2, 'and the automatic level takes over');
  ok('manual importance overrides the auto level; null clears it');
}

// ── TEST 18: waiting_on follows the last real speaker, not tool rows ───────
{
  const empty = makeConv();
  pinWorkBoardItem(empty.external_id);
  let row = listWorkBoardItems(false).find((i) => i.external_id === empty.external_id);
  assert.equal(row.waiting_on, null, 'a chat with no messages is waiting on nobody');

  const conv = makeConv();
  addTurnAt(conv.id, 'user', 'question', hoursAgoStr(1));
  row = listWorkBoardItems(false).find((i) => i.external_id === conv.external_id);
  assert.equal(row.waiting_on, 'jarvis', 'Kevin spoke last → it is JARVIS that owes a reply');

  addTurnAt(conv.id, 'assistant', 'answer', hoursAgoStr(1));
  addTurnAt(conv.id, 'tool', 'ran something', hoursAgoStr(1));
  row = listWorkBoardItems(false).find((i) => i.external_id === conv.external_id);
  assert.equal(row.waiting_on, 'kevin', 'a trailing tool row does not change whose move it is');
  assert.equal(row.running, false, 'nothing is in flight in a test process');
  ok('waiting_on follows the last user/assistant turn and ignores tool rows');
}

// ── TEST 19: the one-shot watch fires once; a hand-set hot level keeps firing ──
{
  const quiet = makeConv();
  addTurnAt(quiet.id, 'user', 'go', hoursAgoStr(1));
  assert.equal(consumeWorkBoardWatch(quiet.external_id), false, 'a normal chat does not ping');

  updateWorkBoardItem(quiet.external_id, { watch: true });
  assert.equal(consumeWorkBoardWatch(quiet.external_id), true, 'an armed watch pings');
  assert.equal(consumeWorkBoardWatch(quiet.external_id), false, 'and disarms itself after one ping');

  const hot = makeConv();
  addTurnAt(hot.id, 'user', 'go', hoursAgoStr(1));
  updateWorkBoardItem(hot.external_id, { importance: 3 });
  assert.equal(consumeWorkBoardWatch(hot.external_id), true, 'a hand-set hot chat pings');
  assert.equal(consumeWorkBoardWatch(hot.external_id), true, 'and keeps pinging — hot is standing, not one-shot');

  const pinned = makeConv();
  addTurnAt(pinned.id, 'user', 'go', hoursAgoStr(1));
  pinWorkBoardItem(pinned.external_id);
  assert.equal(consumeWorkBoardWatch(pinned.external_id), false, 'an automatically-hot chat never pings on its own');
  ok('watch: one-shot fires once, hand-set hot keeps firing, auto-hot stays quiet');
}

console.log(`\n[work-board-test] ALL ${passed} tests passed ✅`);
