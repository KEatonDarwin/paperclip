#!/usr/bin/env node
// NOTEPAD BLOCK STATE CHECK — exercises src/notepad-block-state.ts
// (notepadBlockStates) against node #187's done_means: every topic block's
// HEADLINE must carry a deterministic gutter state so silence is visible.
// No HTTP, no model call — a pure derivation over the existing per-line
// ledger (notepad.ts) and marker store (notepad-markers.ts), neither of
// which this node changes.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-block-state-check.db node scripts/notepad-block-state-check.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

console.log(`[notepad-block-state-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { putNotepadDay, getNotepadDay, markLineSeen, markLineActed } = await import(path.join(distDir, 'notepad.js'));
const { reconcileNotepadMarker, dismissNotepadMarker } = await import(path.join(distDir, 'notepad-markers.js'));
const { carryForwardInto } = await import(path.join(distDir, 'notepad-rollover.js'));
const { sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));
const { notepadBlockStates } = await import(path.join(distDir, 'notepad-block-state.js'));

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

function stateFor(day, headlineText) {
  const saved = getNotepadDay(day);
  const headlineId = lineIdByText(saved, headlineText);
  const rows = notepadBlockStates(day);
  return rows.find((r) => r.headline_line_id === headlineId);
}

// -- empty day -> blocks: [] -------------------------------------------------
{
  const rows = notepadBlockStates('2026-01-01');
  check('an empty/never-touched day returns zero block rows', Array.isArray(rows) && rows.length === 0);
}

// -- 1. UNSEEN: brand-new block, no ledger row on any line -------------------
const D1 = '2026-09-01';
{
  putNotepadDay(D1, ['Topic one', '  - child one'].join('\n'));
  const r = stateFor(D1, 'Topic one');
  check('unseen: a never-examined block reports unseen', r?.state === 'unseen');
}

// -- 2. SEEN: every line examined, no marker, no edits -----------------------
const D2 = '2026-09-02';
{
  const saved = putNotepadDay(D2, ['Topic two', '  - child two'].join('\n'));
  markLineSeen(lineIdByText(saved, 'Topic two'));
  markLineSeen(lineIdByText(saved, '  - child two'));
  const r = stateFor(D2, 'Topic two');
  check('seen: every line examined and judged not-actionable reports seen', r?.state === 'seen');
}

// -- 3. MOVE: active marker with no action_ref yet ---------------------------
const D3 = '2026-09-03';
{
  const saved = putNotepadDay(D3, ['Topic three', '  - child three'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic three');
  reconcileNotepadMarker(headlineId, { kind: 'question', reason: 'needs a decision from Kevin' });
  const r = stateFor(D3, 'Topic three');
  check('move: an open marker with no action_ref reports move', r?.state === 'move');
}

// -- 4a. ACTED via marker carrying an action_ref -----------------------------
const D4A = '2026-09-04';
{
  const saved = putNotepadDay(D4A, ['Topic four a', '  - child four a'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic four a');
  reconcileNotepadMarker(headlineId, { kind: 'take_it', reason: 'a real task', action_ref: 'cockpit:thread-2' });
  const r = stateFor(D4A, 'Topic four a');
  check('acted (via marker): a marker carrying action_ref reports acted', r?.state === 'acted');
  check('acted (via marker): reason names the ref', r?.state_reason.includes('cockpit:thread-2'));
}

// -- 4b. ACTED via ledger only (no marker at all) ----------------------------
const D4B = '2026-09-05';
{
  const saved = putNotepadDay(D4B, ['Topic four b', '  - child four b'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic four b');
  markLineActed(headlineId, 'cockpit:thread-3');
  const r = stateFor(D4B, 'Topic four b');
  check('acted (via ledger, no marker): reports acted', r?.state === 'acted');
  check('acted (via ledger, no marker): reason names the ref', r?.state_reason.includes('cockpit:thread-3'));
}

// -- 5. CHANGED: a member was edited after being examined --------------------
const D5 = '2026-09-06';
{
  const saved = putNotepadDay(D5, ['Topic five', '  - child five'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic five');
  const childId = lineIdByText(saved, '  - child five');
  markLineSeen(headlineId);
  markLineSeen(childId);
  const before = stateFor(D5, 'Topic five');
  check('changed: fully-seen block reports seen before the edit', before?.state === 'seen');

  putNotepadDay(D5, ['Topic five', '  - child five, now with more detail'].join('\n'));
  const after = stateFor(D5, 'Topic five');
  check('changed: editing a member after it was seen reports changed', after?.state === 'changed');
  check('changed: reason names the edited line', after?.state_reason.includes(String(childId)));
}

// -- PRECEDENCE: a marker (move) AND an edited member -> move, not changed --
const D6 = '2026-09-07';
{
  const saved = putNotepadDay(D6, ['Topic six', '  - child six'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic six');
  const childId = lineIdByText(saved, '  - child six');
  markLineSeen(childId);
  reconcileNotepadMarker(headlineId, { kind: 'question', reason: 'ambiguous, needs Kevin' });

  putNotepadDay(D6, ['Topic six', '  - child six, edited after the marker'].join('\n'));
  const r = stateFor(D6, 'Topic six');
  check('precedence: an open marker outranks an edited member -> move, not changed', r?.state === 'move');
}

// -- DISMISSED marker -> never reports move ----------------------------------
const D7 = '2026-09-08';
{
  const saved = putNotepadDay(D7, ['Topic seven', '  - child seven'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic seven');
  const childId = lineIdByText(saved, '  - child seven');
  reconcileNotepadMarker(headlineId, { kind: 'question', reason: 'will be dismissed' });
  dismissNotepadMarker(headlineId);
  markLineSeen(childId); // both lines now carry a ledger row
  const r = stateFor(D7, 'Topic seven');
  check('dismissed marker: never reports move', r?.state !== 'move');
  check('dismissed marker: never reports acted', r?.state !== 'acted');
  check('dismissed marker: a dismissed-but-examined headline + seen child reports seen', r?.state === 'seen');
}

// -- CARRIED LINE: origin acted, carried forward -> acted, not unseen -------
const DAY_CA = '2026-09-10';
const DAY_CB = '2026-09-11';
{
  const saved = putNotepadDay(DAY_CA, ['Topic carry', '  - child carry'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic carry');
  markLineActed(headlineId, 'cockpit:thread-9');

  carryForwardInto(sqliteDb, DAY_CB, { now: '2026-09-11T08:00:00.000Z' });
  const carriedSaved = getNotepadDay(DAY_CB);
  const carriedHeadlineId = lineIdByText(carriedSaved, 'Topic carry');
  check('carried line: gets a brand-new line id', carriedHeadlineId !== headlineId);

  const rows = notepadBlockStates(DAY_CB);
  const r = rows.find((row) => row.headline_line_id === carriedHeadlineId);
  check('carried line: origin acted resolves through lineage to acted, not unseen', r?.state === 'acted');
}

// -- THE NODE'S HEADLINE CLAIM: every block examined, zero markers ----------
// -> every block reports seen, none report unseen.
const D8 = '2026-09-12';
{
  const NOTE = ['Topic A', '  - child a1', '  - child a2', 'Topic B', '  - child b1'].join('\n');
  const saved = putNotepadDay(D8, NOTE);
  for (const line of saved.lines) markLineSeen(line.id);

  const rows = notepadBlockStates(D8);
  check('headline claim: exactly 2 blocks', rows.length === 2);
  check('headline claim: every block reports seen', rows.every((r) => r.state === 'seen'));
  check('headline claim: no block reports unseen', !rows.some((r) => r.state === 'unseen'));
}

// -- headline: null lead-in block does not crash and resolves via notepadBlockId --
const D9 = '2026-09-13';
{
  const NOTE = ['  stray indented line before any headline', 'Topic nine'].join('\n');
  putNotepadDay(D9, NOTE);
  const rows = notepadBlockStates(D9);
  check('headline:null block: still returns a row for the lead-in block', rows.length === 2);
  check('headline:null block: lead-in block reports unseen (never examined)', rows[0]?.state === 'unseen');
}

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
