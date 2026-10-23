#!/usr/bin/env node
// NOTEPAD MARKER ROUTE CHECK — exercises node #854's two additions:
//   (a) GET /notepad's `markers` field (active markers only, always an
//       array, never null/omitted)
//   (b) POST /notepad/markers/:lineId/dismiss
//
// There is no existing "drive the real express router" check convention
// anywhere in this repo (grepped scripts/ for *route-check*/*api-check* —
// nothing). Per this node's spec, this check instead calls the handler
// LOGIC directly against a scratch DB: it re-implements the exact two
// compositions api-v1.ts's routes perform (notepadDayWithMarkers() and the
// dismiss route's 404-then-dismiss-then-respond sequence) over the same
// exported store functions the real routes call
// (getNotepadDay/activeNotepadMarkers/getNotepadMarker/dismissNotepadMarker/
// getNotepadLineDay). No HTTP, no model calls.
//
// Covers:
//   (1) a day with no markers returns markers: [] (never null/omitted).
//   (2) after reconciling two markers onto two of three lines, GET /notepad
//       returns exactly those two with correct kind/reason/line_id, and the
//       third (unmarked) line still appears in `lines` with no marker.
//   (3) POST dismiss on one of them: the immediate response's `markers` no
//       longer contains it, AND a follow-up GET /notepad for that day still
//       doesn't contain it (dismissal sticks across requests, not just the
//       one response).
//   (4) POST dismiss on a line with no marker at all -> 404 marker_not_found
//       (mirrors the /notepad/line-state 404 shape: {error, message}).
//   (5) ZERO CLAUDE PROCESSES spawned across the run (before/after pgrep
//       snapshot) — this node makes no model calls at all.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-marker-route-check.db node scripts/notepad-marker-route-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';

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

console.log(`[notepad-marker-route-check] DB: ${DB_PATH}`);

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

const distDir = path.join(__dirname, '..', 'dist');
const { getNotepadDay, putNotepadDay, getNotepadLineDay } = await import(path.join(distDir, 'notepad.js'));
const { reconcileNotepadMarker, dismissNotepadMarker, getNotepadMarker, activeNotepadMarkers } = await import(
  path.join(distDir, 'notepad-markers.js'),
);

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

// The SAME composition api-v1.ts's notepadDayWithMarkers() performs —
// reimplemented here (not imported, since it's a route-local closure, not
// an exported function) so this check proves the STORE-LEVEL contract the
// route is built on: additive `markers` field, active-only, always an array.
function notepadDayWithMarkers(day) {
  const base = getNotepadDay(day);
  const markers = activeNotepadMarkers(day).map((m) => ({
    line_id: m.line_id,
    kind: m.kind,
    reason: m.reason,
    action_ref: m.action_ref,
  }));
  return { ...base, markers };
}

// Mirrors the POST /notepad/markers/:lineId/dismiss route body exactly:
// 404 marker_not_found when there's no marker at all, else dismiss and
// return the day's full payload.
function dismissRoute(lineId) {
  const marker = getNotepadMarker(lineId);
  if (!marker) {
    return { status: 404, body: { error: 'marker_not_found', message: `no notepad marker on line '${lineId}'` } };
  }
  dismissNotepadMarker(lineId);
  const day = getNotepadLineDay(lineId);
  return { status: 200, body: notepadDayWithMarkers(day) };
}

// -- (1) a day with no markers at all: markers: [], never null/omitted -----
const DAY1 = '2026-09-25';
{
  putNotepadDay(DAY1, ['line with no marker'].join('\n'));
  const payload = notepadDayWithMarkers(DAY1);
  check('markers is present and an array on a clean day', Array.isArray(payload.markers));
  check('markers is empty on a clean day', payload.markers.length === 0);
  check('base fields (day/text/lines) are untouched by the extension', payload.day === DAY1 && typeof payload.text === 'string' && Array.isArray(payload.lines));
}

// -- (2) two of three lines get markers; GET /notepad returns exactly those,
//    the third line stays present with no marker -----------------------------
const DAY2 = '2026-09-26';
let lineA, lineB, lineC;
{
  const saved = putNotepadDay(DAY2, ['- Call Mike about the invoice', 'a plain note with nothing to do', '- fix the composer bug'].join('\n'));
  lineA = lineIdByText(saved, '- Call Mike about the invoice');
  lineB = lineIdByText(saved, 'a plain note with nothing to do');
  lineC = lineIdByText(saved, '- fix the composer bug');

  reconcileNotepadMarker(lineA, { kind: 'take_it', reason: 'a concrete task JARVIS can do', action_ref: 'cockpit:thread-a' });
  reconcileNotepadMarker(lineC, { kind: 'question', reason: 'needs a decision from Kevin' });

  const payload = notepadDayWithMarkers(DAY2);
  check('markers has exactly the two marked lines', payload.markers.length === 2);
  const mA = payload.markers.find((m) => m.line_id === lineA);
  const mC = payload.markers.find((m) => m.line_id === lineC);
  check('line A marker present with correct kind/reason/action_ref', !!mA && mA.kind === 'take_it' && mA.reason === 'a concrete task JARVIS can do' && mA.action_ref === 'cockpit:thread-a');
  check('line C marker present with correct kind/reason', !!mC && mC.kind === 'question' && mC.reason === 'needs a decision from Kevin');
  check('the unmarked line has no marker in the payload', !payload.markers.some((m) => m.line_id === lineB));
  check('the unmarked line still appears in `lines`', payload.lines.some((l) => l.id === lineB));
}

// -- (3) dismiss one: gone from the IMMEDIATE response, and gone from a
//    FOLLOW-UP GET /notepad too (sticks across requests) --------------------
{
  const dismissResult = dismissRoute(lineA);
  check('dismiss returns 200', dismissResult.status === 200);
  check('dismiss response no longer contains the dismissed marker', !dismissResult.body.markers.some((m) => m.line_id === lineA));
  check('dismiss response still contains the OTHER marker (line C)', dismissResult.body.markers.some((m) => m.line_id === lineC));
  check('dismiss response is for the correct day', dismissResult.body.day === DAY2);

  // A follow-up GET, independent of the dismiss response — proves it's a
  // durable write, not just an artifact of the one response object.
  const followUp = notepadDayWithMarkers(DAY2);
  check('follow-up GET /notepad still excludes the dismissed marker', !followUp.markers.some((m) => m.line_id === lineA));
  check('follow-up GET /notepad still includes line C', followUp.markers.some((m) => m.line_id === lineC));
}

// -- (4) dismiss on a line with no marker at all -> 404 marker_not_found ----
{
  const saved = putNotepadDay('2026-09-27', ['a line nobody ever marked'].join('\n'));
  const bareLineId = lineIdByText(saved, 'a line nobody ever marked');
  const result = dismissRoute(bareLineId);
  check('dismiss on an unmarked line returns 404', result.status === 404);
  check('dismiss on an unmarked line returns marker_not_found', result.body.error === 'marker_not_found');
}

// -- (5) zero claude processes spawned across the whole run -----------------
const spawnsAfter = claudeProcessCount();
check(`no net new claude processes spawned (before=${spawnsBefore}, after=${spawnsAfter})`, spawnsAfter <= spawnsBefore);

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
