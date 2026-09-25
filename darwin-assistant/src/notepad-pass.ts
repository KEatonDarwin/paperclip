import { checkNotepadSettle } from './notepad-settle.js';
import type { NotepadSettle } from './notepad-settle.js';
import { runNotepadGate } from './notepad-gate.js';
import type { GateVerdict } from './notepad-gate.js';
import { buildNotepadReviewContext } from './notepad-review.js';
import type { NotepadReviewContext } from './notepad-review.js';

// The settle-and-reread pass itself (node #61's third piece — the wiring,
// after #97's settle detection, #98's gate, and #99's whole-note assembly
// already exist independently). This module does not introduce any new
// logic of its own: it calls the three existing seams in order and stops.
//
//   1. checkNotepadSettle(day) — has the note gone quiet, and is this a NEW
//      quiet period we haven't already reported? (src/notepad-settle.ts)
//   2. runNotepadGate(day) — for whatever unscannedLines(day) currently
//      returns, did a complete thought land? (src/notepad-gate.ts)
//   3. buildNotepadReviewContext(day) — the whole note, in order, every
//      line's ledger history pinned to it. (src/notepad-review.ts)
//
// "The handoff stops there" is the load-bearing design decision: this
// function does NOT mark any line seen/acted/dismissed, does NOT decide
// whether something is worth telling Kevin about, and does NOT spawn a
// second model call to act on what it found. It hands back a plain result
// object; a caller (JARVIS "speaking," node #62 — out of scope here) reads
// that result and decides what, if anything, to do about it. Keeping the
// ledger writes and the "should I say something" judgement out of this
// module is what keeps a pass idempotent and safe to call repeatedly.
//
// ── WHY A BURST IS ONE PASS, NOT FORTY ─────────────────────────────────────
// This function adds no dedupe logic of its own — it doesn't need to, because
// step 1 already owns that guarantee. checkNotepadSettle() only returns a
// non-null NotepadSettle on the FIRST call for a given notepad_days.updated_at
// value; every other call — whether it's mid-burst (elapsed time hasn't
// cleared notepad_settle_seconds yet) or a repeat poll after the note already
// settled — returns null. So no matter how often (or how naively) a caller
// invokes runNotepadPass — on every autosave, on a fixed timer, both — steps
// 2 and 3 only ever run once per distinct settle event: a typing burst of any
// length produces at most one gate call and at most one assembled review,
// because every call in that burst except (at most) one exits at step 1.

/** The outcome of one call to runNotepadPass — see the module doc above. */
export interface NotepadPassResult {
  day: string;
  /** Non-null only when this call is the one that detected a NEW settle. */
  settle: NotepadSettle | null;
  /** null when the pass never got past step 1 (not settled / already reported). */
  gate: GateVerdict[] | null;
  /** True iff at least one gate verdict came back complete_thought: true. */
  worth_reviewing: boolean;
  /** Assembled only when worth_reviewing — no reason to build the whole-note
   *  view when the gate found nothing worth a second look. */
  review: NotepadReviewContext | null;
}

/**
 * Run one settle-and-reread pass for `day`.
 *
 *  - Not settled yet, or already reported for the current write: returns
 *    immediately with `settle: null`, `gate: null`, `review: null`. Zero DB
 *    writes beyond what checkNotepadSettle itself performs, zero model calls.
 *  - Settled (a genuinely new quiet period): runs the gate over whatever
 *    unscannedLines(day) currently returns. If nothing came back
 *    complete_thought: true, stops there (`review: null`) — nothing worth
 *    assembling the whole note for.
 *  - At least one complete thought: assembles the whole-note review context
 *    and returns it alongside the settle + gate detail. This is the handoff;
 *    the function does nothing further with it.
 *
 * `opts.now`/`opts.runOneShot`/`opts.timeoutMs` are the same injection seams
 * checkNotepadSettle/runNotepadGate already expose, threaded through
 * unchanged so a caller (a sim, a check script) can make the whole pass
 * deterministic without touching a real clock or spawning a real model.
 */
export async function runNotepadPass(
  day: string,
  opts?: { now?: Date; runOneShot?: (prompt: string) => Promise<string>; timeoutMs?: number },
): Promise<NotepadPassResult> {
  const settle = checkNotepadSettle(day, opts?.now);
  if (!settle) {
    return { day, settle: null, gate: null, worth_reviewing: false, review: null };
  }

  const gate = await runNotepadGate(day, { runOneShot: opts?.runOneShot, timeoutMs: opts?.timeoutMs });
  const worthReviewing = gate.some((v) => v.complete_thought);
  const review = worthReviewing ? buildNotepadReviewContext(day) : null;

  return { day, settle, gate, worth_reviewing: worthReviewing, review };
}
