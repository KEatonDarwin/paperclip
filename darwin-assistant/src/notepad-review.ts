import { getNotepadDay, getNotepadLineState, unscannedLines } from './notepad.js';

// The settle-and-reread pass (node #61's consumer) needs more than "here are
// the lines the gate flagged" — a reader judging whether something is worth
// acting on has to see the WHOLE note, in order, with every line's history
// pinned to it, per docs/notepad/LINE-IDENTITY.md. This module assembles
// that view. It makes no judgment calls of its own (that's node #62) and it
// never writes to the ledger (a read that mutates state would corrupt the
// very thing it's reporting on) — it only reads notepad.ts's existing
// exports and renders what they say.

export type NotepadLineState = 'unseen' | 'seen' | 'acted' | 'dismissed' | 'done';

export interface ReviewLine {
  line_id: number;
  idx: number; // document order, 0-based
  text: string;
  state: NotepadLineState; // 'unseen' when no notepad_line_state row exists
  action_ref: string | null;
  surfaced: boolean; // is unscannedLines(day) currently returning this line
  surfaced_kind: 'first_look' | 'reconcile' | null;
}

export interface NotepadReviewContext {
  day: string;
  lines: ReviewLine[]; // document order, no gaps, no deleted lines
  rendered: string; // the prose block a reader consumes top-to-bottom
  counts: {
    total: number;
    unseen: number;
    seen: number;
    acted: number;
    dismissed: number;
    done: number;
    surfaced: number;
  };
}

/**
 * The whole note for `day`, in document order, with every line's ledger
 * state and (if applicable) why it's currently up for a scan pinned to it.
 * Deterministic and pure: same DB contents in, byte-identical output out —
 * no timestamps, no Date.now(), no randomness, no model call, no write.
 */
export function buildNotepadReviewContext(day: string): NotepadReviewContext {
  const { lines: rawLines } = getNotepadDay(day);

  // unscannedLines(day) is the authoritative "what's currently surfaced and
  // why" — reuse it rather than re-deriving the decision table here.
  const surfacedKindByLineId = new Map<number, 'first_look' | 'reconcile'>();
  for (const u of unscannedLines(day)) {
    surfacedKindByLineId.set(u.line_id, u.kind);
  }

  const counts = { total: 0, unseen: 0, seen: 0, acted: 0, dismissed: 0, done: 0, surfaced: 0 };
  const lines: ReviewLine[] = rawLines.map((line) => {
    const stateRow = getNotepadLineState(line.id);
    // No row -> 'unseen' per LINE-IDENTITY.md §3: absence of a record, not a
    // row whose state literally says 'unseen'.
    const state: NotepadLineState = stateRow ? stateRow.state : 'unseen';
    const action_ref = stateRow ? stateRow.action_ref : null;
    const surfaced_kind = surfacedKindByLineId.get(line.id) ?? null;
    const surfaced = surfaced_kind !== null;

    counts.total += 1;
    counts[state] += 1;
    if (surfaced) counts.surfaced += 1;

    return { line_id: line.id, idx: line.idx, text: line.text, state, action_ref, surfaced, surfaced_kind };
  });

  return { day, lines, rendered: renderReviewLines(lines), counts };
}

function renderReviewLines(lines: ReviewLine[]): string {
  if (lines.length === 0) return '(no lines)';
  return lines.map(renderReviewLine).join('\n');
}

/**
 * Rendering rules (docs/notepad/LINE-IDENTITY.md §4 made visible):
 *  - Document order always; caller controls that by not re-sorting `lines`.
 *  - An acted line is UNMISTAKABLY marked acted and carries its action_ref
 *    on the same line, whether or not it's currently surfaced — this is
 *    what makes "never re-act on something already handled" legible to a
 *    reader skimming fast.
 *  - A reconcile line (acted, then the text changed) is visually distinct
 *    from a first-look line, but still carries the ORIGINAL action_ref —
 *    per the contract it is re-examined against that existing action, never
 *    fanned out into a second one.
 *  - seen/dismissed lines whose text changed are "new material" per the
 *    decision table, not "still seen/dismissed" — they render as such
 *    (tagged NEW, not masked behind their stale prior judgment), while
 *    still noting what they used to be for transparency.
 *  - unseen lines render plain (the default state, no ledger row).
 */
function renderReviewLine(line: ReviewLine): string {
  const { state, action_ref, surfaced, surfaced_kind, text } = line;

  if (state === 'acted') {
    if (surfaced && surfaced_kind === 'reconcile') {
      return `[RECONCILE — was ACTED -> ${action_ref}, text changed since] ${text}`;
    }
    return `[ACTED -> ${action_ref}] ${text}`;
  }

  if (state === 'dismissed') {
    if (surfaced && surfaced_kind === 'first_look') {
      return `[NEW — previously dismissed, text changed] ${text}`;
    }
    return `[dismissed] ${text}`;
  }

  if (state === 'done') {
    if (surfaced && surfaced_kind === 'first_look') {
      return `[NEW — previously done, text changed] ${text}`;
    }
    return `[done] ${text}`;
  }

  if (state === 'seen') {
    if (surfaced && surfaced_kind === 'first_look') {
      return `[NEW — previously seen, text changed] ${text}`;
    }
    return `[seen] ${text}`;
  }

  // unseen: default state, no ledger row, always a first look.
  return `  ${text}`;
}
