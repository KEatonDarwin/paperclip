#!/usr/bin/env node
// NOTEPAD FORCE-READ CHECK — exercises src/notepad-force-read.ts
// (forceNotepadBlockRead) against node #1059's done_means: a forced,
// block-scoped read that ignores the settle gate and the daily marker
// budget entirely, makes exactly ONE claude-sonnet-5 one-shot, and never
// launders a broken pass into silence. Hermetic — scratch DB, JARVIS_SIM=1,
// no ANTHROPIC_API_KEY, every model call stubbed via the runOneShot seam.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-force-read-check.db JARVIS_SIM=1 node scripts/notepad-force-read-check.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.env.JARVIS_SIM = '1';
delete process.env.ANTHROPIC_API_KEY;

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

console.log(`[notepad-force-read-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { putNotepadDay, markLineActed, markLineDismissed, markLineDone, getNotepadLineState } = await import(
  path.join(distDir, 'notepad.js')
);
const { checkNotepadSettle } = await import(path.join(distDir, 'notepad-settle.js'));
const { getNotepadMarker, listNotepadMarkers } = await import(path.join(distDir, 'notepad-markers.js'));
const { setSetting } = await import(path.join(distDir, 'conversation-db.js'));
const { forceNotepadBlockRead } = await import(path.join(distDir, 'notepad-force-read.js'));

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

function countingStub(impl) {
  let calls = 0;
  const fn = async (prompt) => {
    calls += 1;
    return impl(prompt);
  };
  fn.calls = () => calls;
  return fn;
}

// ── (1) UNSETTLED DAY STILL RUNS -- the settle gate is bypassed entirely ────
const D1 = '2026-09-01';
{
  const saved = putNotepadDay(D1, ['Topic one', '  - child one'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic one');

  // A fresh write is NOT settled (elapsed time since the write is ~0s,
  // nowhere near notepad_settle_seconds) -- checkNotepadSettle proves it.
  const settle = checkNotepadSettle(D1);
  check('(1) precondition: the day is genuinely unsettled', settle === null);

  const stub = countingStub(async () => JSON.stringify({ moves: [{ block_id: headlineId, kind: 'take_it', reason: 'JARVIS can take this' }] }));
  const result = await forceNotepadBlockRead(D1, headlineId, { runOneShot: stub });

  check('(1) THE FIX: a forced read on an unsettled day still runs', result.outcome === 'move');
  check('(1) exactly one one-shot was issued', stub.calls() === 1);
  check('(1) block_id echoes the target', result.block_id === headlineId);
  check('(1) a marker was returned', result.marker?.line_id === headlineId && result.marker?.kind === 'take_it');
}

// ── (2) BUDGET-EXHAUSTED DAY STILL RUNS -- the daily cap never blocks a
//        forced call, even when the day already has markers at the
//        configured (very low) max ──────────────────────────────────────────
const D2 = '2026-09-02';
{
  const saved = putNotepadDay(D2, ['Topic A', '  - a1', 'Topic B', '  - b1'].join('\n'));
  const aId = lineIdByText(saved, 'Topic A');
  const bId = lineIdByText(saved, 'Topic B');

  setSetting('notepad_moves_max_per_day', '1');
  try {
    // Fill the "budget" with one real marker, via a forced read of block A.
    const stubA = countingStub(async () => JSON.stringify({ moves: [{ block_id: aId, kind: 'take_it', reason: 'take A' }] }));
    await forceNotepadBlockRead(D2, aId, { runOneShot: stubA });
    check('(2) precondition: the day is now at the configured max (1 marker)', listNotepadMarkers(D2).length === 1);

    // A forced read on a DIFFERENT block must still run and still persist.
    const stubB = countingStub(async () => JSON.stringify({ moves: [{ block_id: bId, kind: 'question', reason: 'needs Kevin' }] }));
    const result = await forceNotepadBlockRead(D2, bId, { runOneShot: stubB });

    check('(2) THE FIX: a forced read still runs once the day is at max_per_day', result.outcome === 'move');
    check('(2) exactly one one-shot was issued for the forced block', stubB.calls() === 1);
    check('(2) THE FIX: the budget did not block the second marker from persisting', listNotepadMarkers(D2).length === 2);
  } finally {
    setSetting('notepad_moves_max_per_day', '5');
  }
}

// ── (3) A MOVE PERSISTS EXACTLY ONE MARKER, ON THE HEADLINE LINE ───────────
const D3 = '2026-09-03';
{
  const saved = putNotepadDay(D3, ['Topic Three', '  - three child one', '  - three child two'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic Three');
  const childId = lineIdByText(saved, '  - three child one');

  const stub = countingStub(async () => JSON.stringify({ moves: [{ block_id: headlineId, kind: 'context', reason: 'here is context' }] }));
  const result = await forceNotepadBlockRead(D3, headlineId, { runOneShot: stub });

  check('(3) outcome is move', result.outcome === 'move');
  check('(3) exactly one marker exists for the whole day', listNotepadMarkers(D3).length === 1);
  check('(3) the marker lives on the HEADLINE line id, not a child', getNotepadMarker(headlineId)?.line_id === headlineId);
  check('(3) a move outcome does not also stamp member lines seen', getNotepadLineState(childId) === undefined);
}

// ── (4) A SILENT OUTCOME WRITES SEEN ON MEMBER LINES AND NO MARKER ─────────
const D4 = '2026-09-04';
{
  const saved = putNotepadDay(D4, ['Topic Silent', '  - silent child one', '  - silent child two'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic Silent');
  const child1 = lineIdByText(saved, '  - silent child one');
  const child2 = lineIdByText(saved, '  - silent child two');

  const stub = countingStub(async () => JSON.stringify({ moves: [] }));
  const result = await forceNotepadBlockRead(D4, headlineId, { runOneShot: stub });

  check('(4) outcome is silent', result.outcome === 'silent');
  check('(4) exactly one one-shot was issued', stub.calls() === 1);
  check('(4) no marker was created', getNotepadMarker(headlineId) === undefined);
  check('(4) the headline itself was marked seen', getNotepadLineState(headlineId)?.state === 'seen');
  check('(4) member line one was marked seen', getNotepadLineState(child1)?.state === 'seen');
  check('(4) member line two was marked seen', getNotepadLineState(child2)?.state === 'seen');
}

// ── (5) A SILENT OUTCOME NEVER DOWNGRADES A TERMINAL LEDGER STATE ──────────
// Mutation-tested by hand while building this check: removing the
// `prior.action_ref || state === 'dismissed' || state === 'done'` guard in
// src/notepad-force-read.ts made every assertion in this block fail (every
// member line came back 'seen'), confirming the assertions actually bite.
const D5 = '2026-09-05';
{
  const saved = putNotepadDay(
    D5,
    ['Topic Guard', '  - guard dismissed child', '  - guard done child', '  - guard acted child', '  - guard plain child'].join('\n'),
  );
  const headlineId = lineIdByText(saved, 'Topic Guard');
  const dismissedChildId = lineIdByText(saved, '  - guard dismissed child');
  const doneChildId = lineIdByText(saved, '  - guard done child');
  const actedChildId = lineIdByText(saved, '  - guard acted child');
  const plainChildId = lineIdByText(saved, '  - guard plain child');

  markLineDismissed(dismissedChildId);
  markLineDone(doneChildId);
  markLineActed(actedChildId, 'cockpit:thread-force-read-test');

  const stub = countingStub(async () => JSON.stringify({ moves: [] }));
  const result = await forceNotepadBlockRead(D5, headlineId, { runOneShot: stub });

  check('(5) outcome is silent', result.outcome === 'silent');
  check('(5) THE GUARD: a dismissed member line stays dismissed', getNotepadLineState(dismissedChildId)?.state === 'dismissed');
  check('(5) THE GUARD: a done member line stays done', getNotepadLineState(doneChildId)?.state === 'done');
  check(
    '(5) THE GUARD: an acted member line keeps its action_ref, not downgraded to seen',
    getNotepadLineState(actedChildId)?.state === 'acted' && getNotepadLineState(actedChildId)?.action_ref === 'cockpit:thread-force-read-test',
  );
  check('(5) an untouched plain member line DOES get marked seen', getNotepadLineState(plainChildId)?.state === 'seen');
  check('(5) the never-touched headline also gets marked seen', getNotepadLineState(headlineId)?.state === 'seen');
}

// ── (6) A FALLBACK OUTCOME WRITES NOTHING AT ALL ───────────────────────────
const D6 = '2026-09-06';
{
  const saved = putNotepadDay(D6, ['Topic Fallback', '  - fallback child'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic Fallback');
  const childId = lineIdByText(saved, '  - fallback child');

  const stub = countingStub(async () => {
    throw new Error('simulated moves-model failure');
  });
  const result = await forceNotepadBlockRead(D6, headlineId, { runOneShot: stub, timeoutMs: 2000 });

  check('(6) outcome is fallback', result.outcome === 'fallback');
  check('(6) exactly one one-shot was attempted', stub.calls() === 1);
  check('(6) marker is null', result.marker === null);
  check('(6) THE GUARANTEE: no ledger row was written for the headline', getNotepadLineState(headlineId) === undefined);
  check('(6) THE GUARANTEE: no ledger row was written for the child', getNotepadLineState(childId) === undefined);
  check('(6) THE GUARANTEE: no marker was created', getNotepadMarker(headlineId) === undefined);
}

// ── (6b) A TIMEOUT ALSO RESOLVES TO FALLBACK, NOT A HANG OR A GUESS ────────
const D6B = '2026-09-07';
{
  const saved = putNotepadDay(D6B, ['Topic Timeout', '  - timeout child'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic Timeout');

  const neverResolves = countingStub(() => new Promise(() => {}));
  const result = await forceNotepadBlockRead(D6B, headlineId, { runOneShot: neverResolves, timeoutMs: 200 });

  check('(6b) a timed-out call also resolves to fallback', result.outcome === 'fallback');
  check('(6b) nothing was written on timeout either', getNotepadLineState(headlineId) === undefined);
}

// ── (7) JUDGEMENT IS SCOPED TO THE ONE BLOCK, EVEN WITH ANOTHER GENUINELY-
//        SURFACED BLOCK ON THE SAME DAY ────────────────────────────────────
const D7 = '2026-09-08';
{
  const saved = putNotepadDay(D7, ['Topic One', '  - one child', 'Topic Two', '  - two child'].join('\n'));
  const idOne = lineIdByText(saved, 'Topic One');
  const idTwo = lineIdByText(saved, 'Topic Two');

  let capturedPrompt = null;
  const stub = countingStub(async (prompt) => {
    capturedPrompt = prompt;
    return JSON.stringify({ moves: [] });
  });
  await forceNotepadBlockRead(D7, idOne, { runOneShot: stub });

  const candidateLines = [...capturedPrompt.matchAll(/^- block (\d+):/gm)].map((m) => Number(m[1]));
  check('(7) exactly one candidate block was put in front of the model', candidateLines.length === 1);
  check('(7) it is the requested block, not the other one', candidateLines[0] === idOne && !candidateLines.includes(idTwo));
}

// ── (8) UNKNOWN BLOCK ID THROWS -- NO SILENT NO-OP ─────────────────────────
{
  await assert.rejects(
    () => forceNotepadBlockRead(D7, 999999999, { runOneShot: async () => JSON.stringify({ moves: [] }) }),
    /not found/,
  );
  check('(8) an unknown block id throws rather than silently no-opping', true);
}

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
