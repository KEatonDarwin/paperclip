#!/usr/bin/env node
// NOTEPAD FORCE-READ CHECK — exercises src/notepad-force-read.ts against
// node #191's done_means, which SUPERSEDED node #1059's: a forced read
// ALWAYS answers ("read — nothing to add" was a non-answer to a direct
// question, Kevin 2026-09-27), the full take lands in the block's chat
// thread as a real assistant message, the one-liner lands on the marker
// (the hover) with action_ref = thread:<ext>, and a broken model call
// still writes NOTHING anywhere. Silence no longer exists on this path —
// it stays a feature of the UNPROMPTED pass only (notepad-speak.ts, #62).
//
// Hermetic — scratch DB, JARVIS_SIM=1, no ANTHROPIC_API_KEY, every model
// call stubbed via the runOneShot seam, zero claude processes.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-force-read-check.db JARVIS_SIM=1 node scripts/notepad-force-read-check.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
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

function claudeProcessCount() {
  try {
    return Number(execSync("pgrep -c -f 'claude.*--output-format json' || true", { encoding: 'utf8' }).trim() || '0');
  } catch {
    return 0;
  }
}
const spawnsBefore = claudeProcessCount();

const distDir = path.join(__dirname, '..', 'dist');
const { putNotepadDay, getNotepadLineState } = await import(path.join(distDir, 'notepad.js'));
const { checkNotepadSettle } = await import(path.join(distDir, 'notepad-settle.js'));
const { getNotepadMarker, dismissNotepadMarker, reconcileNotepadMarker } = await import(
  path.join(distDir, 'notepad-markers.js'),
);
const { getConversation, getTurns } = await import(path.join(distDir, 'conversation-db.js'));
const { forceNotepadBlockRead, parseForcedTake } = await import(path.join(distDir, 'notepad-force-read.js'));
const { notepadHandoffThreadExt } = await import(path.join(distDir, 'notepad-handoff.js'));

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

const GOOD = JSON.stringify({
  kind: 'take_it',
  take: 'This could work, with a few caveats:\n\n- caveat one\n- caveat two\n\nNext step: prototype the router split.',
  one_liner: 'Workable with two caveats — start by prototyping the router split.',
});

// ── (1) THE HEADLINE CONTRACT: a forced read ALWAYS answers ────────────────
// Unsettled day (settle gate bypassed), stub returns a valid take: the
// outcome is 'answered', the take is IN the thread, the one-liner is ON the
// marker, and the marker links to the thread. Asserted by asking the STORES
// (conversation-db + marker store + ledger), never by trusting the result.
const D1 = '2026-09-01';
{
  const saved = putNotepadDay(D1, ['Jarvis Harness idea', '  - split into a stable of agents'].join('\n'));
  const headlineId = lineIdByText(saved, 'Jarvis Harness idea');

  check('(1) precondition: the day is genuinely unsettled', checkNotepadSettle(D1) === null);

  const stub = countingStub(() => GOOD);
  const r = await forceNotepadBlockRead(D1, headlineId, { runOneShot: stub });

  check('(1) outcome is answered — never silent', r.outcome === 'answered');
  check('(1) exactly ONE one-shot was made', stub.calls() === 1);

  const ext = notepadHandoffThreadExt(headlineId);
  check('(1) result names the deterministic per-line thread ext', r.thread_ext === ext);
  const conv = getConversation(ext);
  check('(1) THE CHAT EXISTS — asked the conversation store, not the result', !!conv);
  const turns = conv ? getTurns(conv.id) : [];
  check('(1) thread holds the action record + the take (2 turns)', turns.length === 2);
  check('(1) turn 1 is the visible [Read & respond] action record', turns[0]?.role === 'user' && /\[Read & respond\]/.test(turns[0]?.content ?? ''));
  check('(1) turn 2 is the ASSISTANT take, verbatim', turns[1]?.role === 'assistant' && /caveat one/.test(turns[1]?.content ?? ''));

  const marker = getNotepadMarker(headlineId);
  check('(1) THE HOVER: marker reason is the one-liner', marker?.reason === 'Workable with two caveats — start by prototyping the router split.');
  check('(1) THE LINK: marker action_ref is thread:<ext> (canonical prefix)', marker?.action_ref === `thread:${ext}`);
  check('(1) marker is ACTIVE, kind carried from the model', marker?.dismissed === false && marker?.kind === 'take_it');
  check('(1) ledger: headline is acted + linked', getNotepadLineState(headlineId)?.state === 'acted' && getNotepadLineState(headlineId)?.action_ref === `thread:${ext}`);
}

// ── (2) SECOND READ, SAME BLOCK: same thread, appended, never a duplicate ──
{
  const saved = putNotepadDay(D1, ['Jarvis Harness idea', '  - split into a stable of agents'].join('\n'));
  const headlineId = lineIdByText(saved, 'Jarvis Harness idea');
  const r2 = await forceNotepadBlockRead(D1, headlineId, { runOneShot: countingStub(() => GOOD) });
  check('(2) reuses the SAME thread (created:false)', r2.outcome === 'answered' && r2.thread_created === false);
  const turns = getTurns(getConversation(notepadHandoffThreadExt(headlineId)).id);
  check('(2) turns appended (4 total), no second conversation', turns.length === 4);
}

// ── (3) FORCED OVERRIDES DISMISSAL: his click today outranks yesterday's ✕ ─
// The unprompted pass must NEVER resurrect a dismissed marker (#104). A
// forced read is Kevin explicitly re-asking — it must.
const D3 = '2026-09-03';
{
  const saved = putNotepadDay(D3, ['Dismissed topic', '  - detail line'].join('\n'));
  const headlineId = lineIdByText(saved, 'Dismissed topic');

  reconcileNotepadMarker(headlineId, { kind: 'context', reason: 'first pass reason' });
  dismissNotepadMarker(headlineId);
  check('(3) precondition: marker is dismissed', getNotepadMarker(headlineId)?.dismissed === true);

  // Control: the UNPROMPTED path (reconcile without forced) stays quiet on
  // the same text — proves the forced flag is doing the work, not a hole in
  // #104's memory.
  const still = reconcileNotepadMarker(headlineId, { kind: 'context', reason: 'unprompted retry' });
  check('(3) control: an unprompted reconcile does NOT resurrect it', still.dismissed === true);

  const r = await forceNotepadBlockRead(D3, headlineId, { runOneShot: countingStub(() => GOOD) });
  const marker = getNotepadMarker(headlineId);
  check('(3) THE OVERRIDE: forced read answers on a dismissed block', r.outcome === 'answered');
  check('(3) marker is ACTIVE again with the fresh one-liner', marker?.dismissed === false && /Workable with two caveats/.test(marker?.reason ?? ''));
}

// ── (4) FALLBACK WRITES NOTHING — thrown call and garbage JSON alike ───────
const D4 = '2026-09-04';
{
  const saved = putNotepadDay(D4, ['Broken read topic', '  - child'].join('\n'));
  const headlineId = lineIdByText(saved, 'Broken read topic');
  const ext = notepadHandoffThreadExt(headlineId);

  for (const [label, impl] of [
    ['thrown call', () => { throw new Error('model exploded'); }],
    ['garbage output', () => 'sorry, as an AI I cannot produce JSON today'],
    ['JSON missing take', () => JSON.stringify({ kind: 'context', one_liner: 'no take field' })],
  ]) {
    const r = await forceNotepadBlockRead(D4, headlineId, { runOneShot: countingStub(impl) });
    check(`(4) ${label} -> outcome fallback`, r.outcome === 'fallback');
    check(`(4) ${label} -> NO thread created`, getConversation(ext) === undefined);
    check(`(4) ${label} -> NO marker written`, getNotepadMarker(headlineId) === undefined);
    check(`(4) ${label} -> NO ledger row`, getNotepadLineState(headlineId) === undefined);
  }
}

// ── (5) parseForcedTake edges ──────────────────────────────────────────────
{
  const fenced = parseForcedTake('```json\n' + GOOD + '\n```');
  check('(5) tolerates code fences', fenced?.one_liner.startsWith('Workable'));
  const noLiner = parseForcedTake(JSON.stringify({ kind: 'question', take: 'Line one of the take\nMore detail' }));
  check('(5) missing one_liner degrades to the take’s first line — never to silence', noLiner?.one_liner === 'Line one of the take');
  const badKind = parseForcedTake(JSON.stringify({ kind: 'banana', take: 'A take', one_liner: 'x' }));
  check('(5) unknown kind degrades to context, still answers', badKind?.kind === 'context');
  check('(5) pure garbage -> null (caller treats as fallback)', parseForcedTake('not json at all') === null);
}

// ── (6) unknown block id throws (route turns it into a 404) ────────────────
{
  let threw = false;
  try {
    await forceNotepadBlockRead(D1, 999999999, { runOneShot: countingStub(() => GOOD) });
  } catch {
    threw = true;
  }
  check('(6) unknown block id throws — no silent no-op', threw);
}

// ── (7) zero net new claude processes across the whole run ─────────────────
check(`(7) no net new claude processes (before=${spawnsBefore}, after=${claudeProcessCount()})`, claudeProcessCount() <= spawnsBefore);

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
