import { buildNotepadReviewContext } from './notepad-review.js';
import type { NotepadReviewContext, ReviewLine } from './notepad-review.js';
import { decideNotepadMoves } from './notepad-moves.js';
import { reconcileNotepadMarker } from './notepad-markers.js';
import type { NotepadMarker } from './notepad-markers.js';
import { getNotepadLineState, markLineSeen } from './notepad.js';
import { notepadBlockId } from './notepad-blocks.js';

// Node #1059 -- Kevin clicked "Read & respond" on ONE headline and is
// waiting; that click IS the trigger. This module is a SEPARATE entry point
// into the exact same judgment pipeline notepad-speak.ts's runNotepadSpeak
// already wires up (buildNotepadReviewContext -> decideNotepadMoves ->
// reconcileNotepadMarker), not a rebuild of it -- it differs from
// runNotepadSpeak in exactly two ways:
//
//   1. It skips BOTH gates runNotepadPass would normally run first
//      (checkNotepadSettle -- has the note gone quiet; runNotepadGate --
//      did a complete thought land): Kevin asking IS the settle signal and
//      IS the "worth reviewing" verdict, so this calls
//      buildNotepadReviewContext(day) directly, the same function
//      runNotepadPass calls once it has cleared both gates.
//
//   2. It scopes the model's judgment to ONE block rather than every
//      currently-surfaced block. decideNotepadMoves derives its candidate
//      list (moveBlockCandidates) from which LINES the review context marks
//      `surfaced` -- so rather than re-deriving that selection logic, this
//      hands decideNotepadMoves a review context whose `lines` are
//      rewritten so ONLY the target block's members are surfaced. The whole
//      note (`rendered`, `blocks`) is left untouched, so the model still
//      reads the full day for context -- it is only ever asked to judge the
//      one block Kevin clicked.
//
// The daily noise budget (`notepad_moves_max_per_day`, settings-KV) is a cap
// decideNotepadMoves applies to the moves ONE call returns -- it never
// tracks a running total across calls, so a forced single-block call (which
// can propose at most one move) is never in a position to be blocked by it.
// There is nothing here to bypass beyond simply not adding a new gate of our
// own.

/** The outcome of one forced block read -- see the module doc above. */
export interface ForceNotepadBlockReadResult {
  block_id: number;
  /** Non-null only when the model decided a real move on this block. */
  marker: NotepadMarker | null;
  /** 'move' -- a marker was persisted. 'silent' -- judged, nothing worth
   *  saying; member lines were marked seen. 'fallback' -- the model call
   *  itself failed or timed out; nothing was written at all. */
  outcome: 'move' | 'silent' | 'fallback';
}

const BLANK_RE = /^\s*$/;

/**
 * Carry the headline's EXISTING action_ref forward when (and only when) it
 * was already 'acted' -- mirrors notepad-speak.ts's resolveActionRef. A
 * headline that was never acted has nothing to carry, so a fresh move's
 * action_ref is null -- a genuinely new marker, not a continuation of one.
 */
function resolveActionRef(review: NotepadReviewContext, blockId: number): string | null {
  const line = review.lines.find((l) => l.line_id === blockId);
  return line && line.state === 'acted' ? line.action_ref : null;
}

/**
 * Force the whole-note judgment pipeline to run its per-block move decision
 * on ONE block, right now, regardless of settle/gate/budget state.
 *
 * Throws if `blockId` does not name a real block on `day` (an unknown id is
 * a caller bug -- e.g. a stale headline from a client that hasn't refreshed
 * -- and must surface loudly, never resolve to a silent no-op).
 *
 * `opts.runOneShot`/`opts.timeoutMs` are the same injection seams
 * decideNotepadMoves exposes, threaded through unchanged for sims/checks.
 * `opts.now` is accepted for signature symmetry with the rest of the
 * notepad pipeline but unused here -- there is no settle check left to date.
 */
export async function forceNotepadBlockRead(
  day: string,
  blockId: number,
  opts?: { runOneShot?: (prompt: string) => Promise<string>; timeoutMs?: number; now?: Date },
): Promise<ForceNotepadBlockReadResult> {
  const review = buildNotepadReviewContext(day);
  const block = review.blocks.find((b) => notepadBlockId(b) === blockId);
  if (!block) {
    throw new Error(`notepad block ${blockId} not found on day ${day}`);
  }

  // Narrow the candidate set decideNotepadMoves will derive
  // (moveBlockCandidates) down to exactly this one block: force every
  // member line surfaced, and every OTHER line's surfaced flag off, so no
  // other block's own (possibly genuinely) surfaced lines sneak into this
  // forced, single-block judgment call.
  const memberIds = new Set(block.member_line_ids);
  const narrowedLines: ReviewLine[] = review.lines.map((line) => {
    if (memberIds.has(line.line_id)) {
      const kind: 'first_look' | 'reconcile' = line.line_id === blockId && line.state === 'acted' ? 'reconcile' : 'first_look';
      return { ...line, surfaced: true, surfaced_kind: kind };
    }
    return line.surfaced ? { ...line, surfaced: false, surfaced_kind: null } : line;
  });
  const narrowedReview: NotepadReviewContext = { ...review, lines: narrowedLines };

  const moves = await decideNotepadMoves(day, {
    review: narrowedReview,
    runOneShot: opts?.runOneShot,
    timeoutMs: opts?.timeoutMs,
  });

  // A broken/timed-out call must never be laundered into "read it, nothing
  // to say" -- write NOTHING.
  if (moves.outcome === 'fallback') {
    return { block_id: blockId, marker: null, outcome: 'fallback' };
  }

  const move = moves.moves.find((m) => m.block_id === blockId);
  if (move) {
    const actionRef = resolveActionRef(review, blockId);
    const marker = reconcileNotepadMarker(blockId, { kind: move.kind, reason: move.reason, action_ref: actionRef });
    return { block_id: blockId, marker, outcome: 'move' };
  }

  // Silent: the model read the block and had nothing worth saying. Mark
  // every text-bearing member line `seen` -- mirroring notepad-speak.ts's
  // node #1054 handling exactly, including its terminal-state guard: never
  // downgrade a line Kevin already closed (`dismissed`/`done`) or that
  // already carries an action_ref back to `seen`.
  const textByLineId = new Map(review.lines.map((l) => [l.line_id, l.text]));
  for (const lineId of block.member_line_ids) {
    const text = textByLineId.get(lineId);
    if (text === undefined || BLANK_RE.test(text)) continue;
    const prior = getNotepadLineState(lineId);
    if (prior && (prior.action_ref || prior.state === 'dismissed' || prior.state === 'done')) continue;
    markLineSeen(lineId);
  }

  return { block_id: blockId, marker: null, outcome: 'silent' };
}
