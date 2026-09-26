#!/usr/bin/env node
// NOTEPAD PASS CHECK — end-to-end proof for runNotepadPass (src/notepad-pass.ts),
// node #61's wiring of settle (#97) -> gate (#98) -> whole-note review (#99).
// The one thing this node exists to prove: a TYPING BURST — dozens of rapid
// autosaves, each of which may independently trigger a caller to invoke
// runNotepadPass (an on-save hook, a fixed timer, or both) — produces AT
// MOST ONE gate call and AT MOST ONE assembled review per settle event, never
// one per save. No HTTP. The gate's model half is driven entirely through
// opts.runOneShot, so this file spawns zero real claude processes — proven,
// not assumed, by the before/after pgrep snapshot at the end.
//
// Covers:
//   (A) a typing burst (one line growing one character at a time, ending on
//       a genuine complete sentence) with a runNotepadPass probe after EVERY
//       keystroke, each probe landing 3s after its own save (inside the
//       default 20s quiet window) -> ZERO settles, ZERO gate calls across
//       every probe.
//   (A2) the same burst, but a handful of the intermediate keystrokes are
//       each probed TWICE in immediate succession (an on-save hook AND a
//       fixed timer both firing for the same save) -> still zero settles,
//       zero gate calls — proves double-probing one save doesn't double
//       anything.
//   (B) advancing `now` one tick past the quiet period after the burst's
//       final (complete-thought) save -> EXACTLY ONE settle, EXACTLY ONE
//       gate call (the stub's call counter), worth_reviewing true, and a
//       review whose lines include the finished sentence.
//   (C) 6 further repeated polls after that settle, with time continuing to
//       advance and no new save -> zero further settles, zero further gate
//       calls -- the stub's call count stays frozen at 1.
//   (D) a burst that ends on junk only (too-short fragments, a bare URL) ->
//       settle still fires exactly once, but worth_reviewing is false,
//       review is null, and the gate stub is NEVER invoked at all (0 calls)
//       because prefilterGateCandidates leaves zero candidates and
//       runNotepadGate returns before ever reaching opts.runOneShot.
//   (E) the real spawn path (no opts.runOneShot, a genuine candidate
//       present) throws OUT of runNotepadPass itself under this scratch DB
//       -- the guard is not silently swallowed partway up the call chain.
//   (F) ZERO CLAUDE PROCESSES spawned across the whole run (before/after
//       pgrep snapshot).
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-pass-check.db node scripts/notepad-pass-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

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

console.log(`[notepad-pass-check] DB: ${DB_PATH}`);

function claudeProcessCount() {
  try {
    const out = execSync('pgrep -c -f claude', { encoding: 'utf8' });
    return parseInt(out.trim(), 10) || 0;
  } catch (err) {
    if (err && err.status === 1) return 0; // pgrep exits 1 on no match — that's zero, not a failure
    throw err;
  }
}

const spawnsBefore = claudeProcessCount();

const distDir = path.join(__dirname, '..', 'dist');
const { putNotepadDay, getNotepadDay, markLineActed } = await import(path.join(distDir, 'notepad.js'));
const { runNotepadPass } = await import(path.join(distDir, 'notepad-pass.js'));
const { sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));

let failed = false;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failed = true;
  }
}

// ── deterministic time injection (same tick scheme as notepad-settle-check) ─
const EPOCH_MS = Date.parse('2026-01-01T00:00:00Z');
function tickDate(n) {
  return new Date(EPOCH_MS + n * 1000); // one tick = one second
}
function sqliteDatetimeString(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}
const setUpdatedAtStmt = sqliteDb.prepare(`UPDATE notepad_days SET updated_at = ? WHERE day = ?`);
function saveAtTick(day, text, tick) {
  putNotepadDay(day, text);
  setUpdatedAtStmt.run(sqliteDatetimeString(tickDate(tick)), day);
}

let totalProbes = 0;
let totalSettles = 0;
let totalGateCalls = 0; // counts stub INVOCATIONS across the whole file, not verdicts
let totalReconciled = 0; // counts lines that surfaced as surfaced_kind === 'reconcile' across the whole file

function countedStub(verdictFor) {
  return async (prompt) => {
    totalGateCalls += 1;
    return JSON.stringify({ verdicts: verdictFor(prompt) });
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// (A) + (A2) — a typing burst building ONE line character by character,
// probed after every keystroke (some keystrokes probed twice).
// ═══════════════════════════════════════════════════════════════════════════
const DAY_A = '2026-09-27';
const SENTENCE = 'Email the vendor about overdue invoice'; // 39 chars — the full, complete thought
const stubA = countedStub((prompt) => {
  // whichever line_ids are in the prompt, say every one is a complete thought
  const ids = [...prompt.matchAll(/block_id (\d+)/g)].map((m) => Number(m[1]));
  return ids.map((block_id) => ({ block_id, complete_thought: true }));
});

{
  const doubleProbeTicks = new Set([5, 13, 27]); // a few keystrokes get probed twice, like an onSave hook + a timer racing
  for (let tick = 1; tick <= SENTENCE.length - 1; tick++) {
    const partial = SENTENCE.slice(0, tick);
    saveAtTick(DAY_A, partial, tick);

    const probesThisTick = doubleProbeTicks.has(tick) ? 2 : 1;
    for (let p = 0; p < probesThisTick; p++) {
      totalProbes += 1;
      const result = await runNotepadPass(DAY_A, { now: tickDate(tick + 3), runOneShot: stubA });
      if (result.settle) totalSettles += 1;
      check(
        `(A) keystroke #${tick} probe #${p + 1}: no settle mid-burst (3s later, still inside quiet window)`,
        result.settle === null && result.gate === null && result.review === null,
      );
    }
  }
  check('(A/A2) zero gate calls across the entire typing burst', totalGateCalls === 0, `got ${totalGateCalls}`);
  check('(A2) the double-probed keystrokes really were probed twice', totalProbes === SENTENCE.length - 1 + doubleProbeTicks.size);
}

// ── final save: the whole, complete sentence lands ──────────────────────────
const finalTick = SENTENCE.length; // one past the last partial keystroke
saveAtTick(DAY_A, SENTENCE, finalTick);

// ═══════════════════════════════════════════════════════════════════════════
// (B) — advance past the quiet window: exactly one settle, exactly one gate
// call, worth_reviewing true, a review that contains the finished sentence.
// ═══════════════════════════════════════════════════════════════════════════
{
  const pastBoundary = tickDate(finalTick + 20 + 1); // 21s after the final save
  const result = await runNotepadPass(DAY_A, { now: pastBoundary, runOneShot: stubA });

  check('(B) the pass reports a settle', result.settle !== null);
  if (result.settle) totalSettles += 1;
  check('(B) exactly one settle across the whole burst so far', totalSettles === 1, `got ${totalSettles}`);
  check('(B) exactly one gate call for the whole burst (batched, not per-keystroke)', totalGateCalls === 1, `got ${totalGateCalls}`);
  check('(B) gate came back non-null with at least one verdict', Array.isArray(result.gate) && result.gate.length > 0);
  check('(B) worth_reviewing is true', result.worth_reviewing === true);
  check('(B) review was assembled', result.review !== null);
  if (result.review) {
    check('(B) review.day matches the day', result.review.day === DAY_A);
    check(
      '(B) the finished sentence appears in the assembled review',
      result.review.lines.some((l) => l.text === SENTENCE),
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// (C) — repeated polls after the settle already fired: no further settles,
// no further gate calls, no matter how many times or how far time advances.
// ═══════════════════════════════════════════════════════════════════════════
{
  for (let i = 1; i <= 6; i++) {
    const later = tickDate(finalTick + 20 + 1 + i * 30);
    const result = await runNotepadPass(DAY_A, { now: later, runOneShot: stubA });
    check(
      `(C) repeat poll #${i} after the settle: no re-fire`,
      result.settle === null && result.gate === null && result.review === null,
    );
  }
  check('(C) gate call count is still frozen at 1 after 6 more polls', totalGateCalls === 1, `got ${totalGateCalls}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// (D) — a burst that ends on junk only: settle fires, but the gate stub is
// never invoked at all (zero candidates survive the deterministic prefilter).
// ═══════════════════════════════════════════════════════════════════════════
const DAY_D = '2026-09-28';
let gateCallsAtStartOfD;
{
  gateCallsAtStartOfD = totalGateCalls;
  const junkLines = ['ok', '#', 'hi', 'https://example.com/x', '1.', '---'].join('\n');
  saveAtTick(DAY_D, junkLines, 1000);

  const pastBoundary = tickDate(1000 + 20 + 1);
  const result = await runNotepadPass(DAY_D, { now: pastBoundary, runOneShot: stubA });

  check('(D) settle still fires for a junk-only note', result.settle !== null);
  if (result.settle) totalSettles += 1;
  check('(D) gate is non-null (the prefilter ran) but empty of real candidates', Array.isArray(result.gate) && result.gate.every((v) => v.reason === 'prefilter'));
  check('(D) worth_reviewing is false', result.worth_reviewing === false);
  check('(D) review stayed null — nothing worth assembling the whole note for', result.review === null);
  check('(D) the gate stub was never called (all lines disposed before reaching the model)', totalGateCalls === gateCallsAtStartOfD, `got ${totalGateCalls - gateCallsAtStartOfD} extra calls`);
}

// ═══════════════════════════════════════════════════════════════════════════
// (E) — the real spawn path: with a genuine candidate and no opts.runOneShot,
// the scratch-env guard propagates OUT of runNotepadPass itself (not caught
// and silently downgraded to a fake pass).
// ═══════════════════════════════════════════════════════════════════════════
const DAY_E = '2026-09-29';
{
  saveAtTick(DAY_E, 'Call the bank about the wire transfer today', 2000);
  const pastBoundary = tickDate(2000 + 20 + 1);

  let threw = false;
  let message = '';
  try {
    await runNotepadPass(DAY_E, { now: pastBoundary }); // no runOneShot — real spawn path
  } catch (err) {
    threw = true;
    message = err && err.message ? err.message : String(err);
  }
  check('(E) runNotepadPass throws under this scratch DB rather than faking a pass', threw);
  check('(E) the thrown message identifies itself as the notepad-gate spawn guard', message.includes('[notepad-gate]'));
}

// ═══════════════════════════════════════════════════════════════════════════
// (G) — the highest-risk race: an on-save hook and a fixed timer firing for
// the SAME settle boundary genuinely concurrently (Promise.all, not a
// sequential await-then-await), at the exact same injected `now`. Still
// exactly one settle and one gate call across the whole group — because
// checkNotepadSettle's read-check-write against the idempotence marker runs
// fully synchronously before runNotepadPass's first `await`, so two
// concurrently-started calls can never both observe "not yet marked".
// ═══════════════════════════════════════════════════════════════════════════
const DAY_G = '2026-09-30';
{
  saveAtTick(DAY_G, 'File the expense report before month end', 3000);
  const pastBoundary = tickDate(3000 + 20 + 1);
  const gateCallsBeforeG = totalGateCalls;

  const stubG = countedStub((prompt) => {
    const ids = [...prompt.matchAll(/block_id (\d+)/g)].map((m) => Number(m[1]));
    return ids.map((block_id) => ({ block_id, complete_thought: true }));
  });

  const results = await Promise.all([
    runNotepadPass(DAY_G, { now: pastBoundary, runOneShot: stubG }),
    runNotepadPass(DAY_G, { now: pastBoundary, runOneShot: stubG }),
    runNotepadPass(DAY_G, { now: pastBoundary, runOneShot: stubG }),
  ]);

  const settledCount = results.filter((r) => r.settle !== null).length;
  totalSettles += settledCount;
  check('(G) exactly one of the 3 concurrent racers observed the settle', settledCount === 1, `got ${settledCount}`);
  check(
    '(G) exactly one gate call across the whole concurrent group',
    totalGateCalls === gateCallsBeforeG + 1,
    `got ${totalGateCalls - gateCallsBeforeG}`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// (H) — the whole-note assertion + the reconcile/action_ref block. Every
// other section above proves the DEBOUNCE (one pass per settle); this one
// proves the HANDOFF is actually the whole note, per the module doc's step
// 3 ("the whole note, in order, every line's ledger history pinned to it"),
// and that a line already ACTED in a prior cycle re-surfaces as a RECONCILE
// against its ORIGINAL action_ref (never a fresh first_look, never a second
// action) when its text changes -- while an untouched acted line stays
// silent. A single sentence appearing somewhere in `review.lines` (as (B)
// checks) does not exercise any of this.
// ═══════════════════════════════════════════════════════════════════════════
const DAY_H = '2026-10-01';
{
  const L1 = 'Email the vendor about overdue invoice'; // acted, left UNCHANGED -> must stay silent
  const L2 = 'Call the bank about the wire transfer'; // acted, then EDITED -> must reconcile
  const L3 = 'Renew the office lease before it expires'; // brand-new complete thought -> first_look
  const L4 = 'ok'; // junk -> present in the whole note, never a gate candidate
  const ACTION_REF_L1 = 'thread:vendor-email-abc123';
  const ACTION_REF_L2 = 'thread:bank-wire-xyz789';

  saveAtTick(DAY_H, [L1, L2, L3, L4].join('\n'), 4000);
  const { lines: linesH } = getNotepadDay(DAY_H);
  const [l1, l2, l3, l4] = linesH;

  // Simulate a prior cycle's consumer (node #62, out of scope here) having
  // already acted on L1 and L2 before this pass ever runs.
  markLineActed(l1.id, ACTION_REF_L1);
  markLineActed(l2.id, ACTION_REF_L2);

  // Edit ONLY L2's text. L1, L3, L4 are re-saved byte-identical.
  const L2_EDITED = 'Call the bank about the wire transfer -- ask about the fee';
  saveAtTick(DAY_H, [L1, L2_EDITED, L3, L4].join('\n'), 4010);

  const gateCallsBeforeH = totalGateCalls;
  const stubH = countedStub((prompt) => {
    const ids = [...prompt.matchAll(/block_id (\d+)/g)].map((m) => Number(m[1]));
    return ids.map((block_id) => ({ block_id, complete_thought: true }));
  });

  const pastBoundary = tickDate(4010 + 20 + 1);
  const result = await runNotepadPass(DAY_H, { now: pastBoundary, runOneShot: stubH });

  check('(H) settle fires for the edit', result.settle !== null);
  if (result.settle) totalSettles += 1;
  check(
    '(H) both L2 (reconcile) and L3 (first_look) went through the SAME single batched gate call',
    totalGateCalls === gateCallsBeforeH + 1,
    `got ${totalGateCalls - gateCallsBeforeH} calls`,
  );
  check('(H) worth_reviewing is true', result.worth_reviewing === true);
  check('(H) review was assembled', result.review !== null);

  if (result.review) {
    const { review } = result;
    totalReconciled += review.lines.filter((l) => l.surfaced_kind === 'reconcile').length;

    // ── whole-note assertion: the handoff is the ENTIRE note, in document
    // order, not just the line(s) the gate flagged. ──────────────────────────
    check('(H) whole-note: review contains all 4 lines of the note', review.lines.length === 4, `got ${review.lines.length}`);
    check('(H) whole-note: counts.total matches the line count', review.counts.total === 4, `got ${review.counts.total}`);
    check(
      '(H) whole-note: document order preserved (idx 0..3)',
      review.lines.every((l, i) => l.idx === i),
    );
    check(
      '(H) whole-note: the rendered block contains every line\'s CURRENT text',
      [L1, L2_EDITED, L3, L4].every((t) => review.rendered.includes(t)),
    );

    // ── reconcile/action_ref block: L2 carries its ORIGINAL action_ref and
    // surfaces as a reconcile, never a bare first_look or a second action. ──
    const l2Review = review.lines.find((l) => l.line_id === l2.id);
    check('(H) reconcile: L2 state is still acted (not reset by the edit)', l2Review?.state === 'acted');
    check('(H) reconcile: L2 kept its ORIGINAL action_ref', l2Review?.action_ref === ACTION_REF_L2);
    check('(H) reconcile: L2 is surfaced', l2Review?.surfaced === true);
    check('(H) reconcile: L2 surfaced_kind is reconcile, not first_look', l2Review?.surfaced_kind === 'reconcile');
    check(
      '(H) reconcile: the rendered line carries the RECONCILE tag with the original action_ref',
      review.rendered.includes(`[RECONCILE — was ACTED -> ${ACTION_REF_L2}, text changed since] ${L2_EDITED}`),
    );

    // ── L1 (acted, byte-identical) must stay silent -- proves the pass never
    // re-litigates a settled decision just because the DAY changed elsewhere. ─
    const l1Review = review.lines.find((l) => l.line_id === l1.id);
    check('(H) L1 (acted, unchanged) does not resurface', l1Review?.surfaced === false && l1Review?.surfaced_kind === null);
    check(
      '(H) L1 (acted, unchanged) still renders plain ACTED, no RECONCILE tag',
      review.rendered.includes(`[ACTED -> ${ACTION_REF_L1}] ${L1}`) &&
        !review.rendered.includes(`RECONCILE — was ACTED -> ${ACTION_REF_L1}`),
    );

    // ── L3 (brand-new complete thought) surfaces as first_look alongside L2's
    // reconcile, both flagged complete_thought in the same gate verdict set. ─
    const l3Review = review.lines.find((l) => l.line_id === l3.id);
    check('(H) L3 (new, unseen) surfaced as first_look', l3Review?.surfaced === true && l3Review?.surfaced_kind === 'first_look');

    // ── L4 (junk) is present in the whole-note handoff even though it never
    // reached the model -- the whole note, not just what the gate flagged. ──
    const l4Review = review.lines.find((l) => l.line_id === l4.id);
    check('(H) L4 (junk) is still present in the whole-note review', l4Review !== undefined && l4Review.text === L4);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// (F) — zero real claude processes were ever spawned by this whole run.
// ═══════════════════════════════════════════════════════════════════════════
const spawnsAfter = claudeProcessCount();
check('(F) zero net claude processes spawned across the entire run', spawnsAfter <= spawnsBefore, `before=${spawnsBefore} after=${spawnsAfter}`);

console.log(
  `\nprobes: ${totalProbes}  settles: ${totalSettles}  gate calls: ${totalGateCalls}  reconciled: ${totalReconciled}  violations: ${failed ? 'yes' : 0}`,
);
console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
