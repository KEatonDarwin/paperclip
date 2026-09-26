import { runNotepadPass } from './notepad-pass.js';
import type { NotepadPassResult } from './notepad-pass.js';
import { decideNotepadMoves } from './notepad-moves.js';
import type { NotepadMovesResult } from './notepad-moves.js';
import { reconcileNotepadMarker } from './notepad-markers.js';
import type { NotepadMarker } from './notepad-markers.js';

// The pipeline wiring node #850's dependency chain has been building toward:
// runNotepadPass (#61 — settle -> gate -> whole-note review) hands off a
// plain result object and stops; decideNotepadMoves (#62/#103 — the
// speaking bar) turns that review into a sparse set of real moves and
// stops; reconcileNotepadMarker (#104 — the marker store) knows how to
// persist ONE move against ONE line_id without ever duplicating or
// resurrecting a dismissed judgement, but nothing calls it. This module is
// that missing call: it connects the three seams in order and is the first
// place any of this pipeline actually reaches the database table Kevin's
// notepad UI would read from.
//
// It adds NO new judgement of its own -- every decision (is this worth a
// second look, is there a real move, what does dismissing mean) already
// lives in the module it calls. The only new logic here is the one thing
// none of those three modules could do on their own: mapping a decided
// move back to the ORIGINAL action_ref when the candidate it came from was
// a RECONCILE (an edited, already-acted line) rather than a first look --
// see resolveActionRef() below. Getting that mapping right is what makes
// "edit an acted line and get ONE marker" true at the pipeline level and
// not just at the unit level notepad-markers-check.mjs already proves.
//
// NODE #943 -- ONE MARKER PER BLOCK. decideNotepadMoves now decides about
// topic BLOCKS (docs/notepad/BLOCKS.md), so a move carries a `block_id` --
// the headline line's id, or the first member's id for a headline:null
// lead-in block. That is the line the marker is persisted against: ONE
// marker per topic, on its headline, never one per dash underneath it. The
// marker store itself is unchanged and still per-line, because a block_id IS
// one of the block's own line ids -- exactly what makes the block layer a
// judgement layer and not a second identity scheme.

/** The outcome of one call to runNotepadSpeak -- see the module doc above. */
export interface NotepadSpeakResult {
  day: string;
  /** Exactly what runNotepadPass returned -- nothing here reinterprets it. */
  pass: NotepadPassResult;
  /** Null whenever pass.worth_reviewing is false (nothing to decide moves
   *  about) -- decideNotepadMoves is never invoked in that case, mirroring
   *  runNotepadPass's own "don't build what nothing needs" discipline. */
  moves: NotepadMovesResult | null;
  /** Every marker reconciled THIS call, in the same order as moves.moves.
   *  Empty whenever moves is null, or moves.moves is empty (a normal,
   *  common, correct outcome -- silence is not a failure). */
  markers: NotepadMarker[];
}

/**
 * A decided move's action_ref: carried forward from the HEADLINE line's
 * EXISTING action_ref when (and only when) that line surfaced as a
 * 'reconcile' (an acted line whose text changed) -- never invented, never
 * left to whatever the model happened to say (the model isn't even asked for
 * one; NotepadMove has no action_ref field). A first_look headline has no
 * prior action to carry, so its move's action_ref is null -- a genuinely new
 * marker, not a continuation of one.
 *
 * The headline line is the right one to ask, and the only one: it is where
 * the marker and the `acted` ledger row for this block live (see
 * notepad-dispatch.ts), so it is the only member whose action_ref could be
 * this block's prior action.
 */
function resolveActionRef(pass: NotepadPassResult, blockId: number): string | null {
  const line = pass.review?.lines.find((l) => l.line_id === blockId);
  if (!line) return null;
  return line.surfaced && line.surfaced_kind === 'reconcile' ? line.action_ref : null;
}

/**
 * Run one full settle -> gate -> review -> decide -> persist cycle for
 * `day`.
 *
 *  - `pass.worth_reviewing` false (not settled, already reported, or
 *    nothing survived the gate): returns immediately with `moves: null`,
 *    `markers: []`. Zero additional DB writes, zero additional model
 *    calls beyond whatever runNotepadPass itself made.
 *  - Otherwise: decideNotepadMoves is called ONCE, handed the review
 *    context runNotepadPass already assembled (opts.review) rather than
 *    re-querying the DB for it -- the same injection seam
 *    decideNotepadMoves exposes for exactly this reason. For every real
 *    move it returns (often none), reconcileNotepadMarker persists it
 *    against that move's line_id, carrying the original action_ref
 *    forward on a reconcile per resolveActionRef() above.
 *
 * `opts.now`/`opts.runOneShot`/`opts.timeoutMs` are threaded through
 * unchanged to BOTH the gate call (inside runNotepadPass) and the moves
 * call -- a caller that wants to distinguish the two stages inspects the
 * prompt text itself (the gate's prompt asks for "verdicts"/
 * "complete_thought"; the moves prompt asks for "moves"/"kind"), the same
 * way a sim would have to for any two-stage batched pipeline sharing one
 * injection seam.
 */
export async function runNotepadSpeak(
  day: string,
  opts?: { now?: Date; runOneShot?: (prompt: string) => Promise<string>; timeoutMs?: number },
): Promise<NotepadSpeakResult> {
  const pass = await runNotepadPass(day, opts);
  if (!pass.worth_reviewing || !pass.review) {
    return { day, pass, moves: null, markers: [] };
  }

  const moves = await decideNotepadMoves(day, {
    review: pass.review,
    runOneShot: opts?.runOneShot,
    timeoutMs: opts?.timeoutMs,
  });

  const markers: NotepadMarker[] = [];
  for (const move of moves.moves) {
    // One marker per BLOCK, on its headline line (move.block_id).
    const actionRef = resolveActionRef(pass, move.block_id);
    markers.push(
      reconcileNotepadMarker(move.block_id, { kind: move.kind, reason: move.reason, action_ref: actionRef }),
    );
  }

  return { day, pass, moves, markers };
}
