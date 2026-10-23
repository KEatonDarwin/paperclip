import { getNotepadDay, getNotepadLineState, lineTextHash } from './notepad.js';
import { activeNotepadMarkers } from './notepad-markers.js';
import { parseNotepadBlocks, notepadBlockId } from './notepad-blocks.js';
import type { NotepadBlockLineInput } from './notepad-blocks.js';

// The per-block GUTTER state (node #187, docs/notepad/BLOCKS.md "Gutter
// state" section): today only a block with an active marker shows anything
// in the gutter, so a block JARVIS silently read and a block it never read
// look identical. This derives a fifth signal on top of the existing
// per-line ledger (notepad.ts) and marker store (notepad-markers.ts) --
// neither of which changes. It is a pure read: no new table, no write path.

export type NotepadBlockState = 'unseen' | 'seen' | 'move' | 'acted' | 'changed';

export interface NotepadBlockStateRow {
  headline_line_id: number;
  member_line_ids: number[];
  state: NotepadBlockState;
  state_reason: string;
}

const BLANK_RE = /^\s*$/;

/**
 * Derive the gutter state for every block in `day`, in document order.
 * Judgment is anchored on the block's headline line (or, for a
 * `headline: null` lead-in block, the same surrogate id every other
 * consumer uses -- `notepadBlockId`: the first member line) since that is
 * where markers and the `acted` ledger row live (BLOCKS.md). Rule 3 is the
 * one member-aware exception: a block is `changed` if EITHER the headline
 * OR any member line was edited since it was last examined.
 *
 * Precedence is exactly 1 acted, 2 move, 3 changed, 4 seen, 5 unseen -- the
 * first rule that matches wins, so a block with an open marker on an edited
 * member still reports `move`, never `changed`.
 */
export function notepadBlockStates(day: string): NotepadBlockStateRow[] {
  const { lines } = getNotepadDay(day);
  const lineInputs: NotepadBlockLineInput[] = lines.map((l) => ({ id: l.id, idx: l.idx, text: l.text }));
  const blocks = parseNotepadBlocks(lineInputs);
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const activeMarkerByLineId = new Map(activeNotepadMarkers(day).map((m) => [m.line_id, m]));

  return blocks.map((block): NotepadBlockStateRow => {
    const blockId = notepadBlockId(block);
    const memberLineIds = block.member_line_ids;
    const row = (state: NotepadBlockState, state_reason: string): NotepadBlockStateRow => ({
      headline_line_id: blockId,
      member_line_ids: memberLineIds,
      state,
      state_reason,
    });

    const marker = activeMarkerByLineId.get(blockId);
    const headlineLedger = getNotepadLineState(blockId);

    // 1. acted -- an active marker with a decided action_ref, or the
    // headline's own ledger row already recorded as acted with a ref.
    if (marker && marker.action_ref) {
      return row('acted', `active marker carries action_ref ${marker.action_ref}`);
    }
    if (headlineLedger?.state === 'acted' && headlineLedger.action_ref) {
      return row('acted', `ledger state 'acted' carries action_ref ${headlineLedger.action_ref}`);
    }

    // 2. move -- JARVIS has something to say and Kevin hasn't opened it yet.
    if (marker && !marker.action_ref) {
      return row('move', 'active marker is awaiting a decision (no action_ref yet)');
    }

    // 3. changed -- the headline or any member was edited since it was
    // examined. Read through getNotepadLineState so a carried line resolves
    // to its origin's ledger row instead of always looking unexamined.
    for (const lineId of memberLineIds) {
      const line = lineById.get(lineId);
      if (!line) continue;
      const ledger = getNotepadLineState(lineId);
      if (ledger && ledger.hash !== lineTextHash(line.text)) {
        return row('changed', `line ${lineId} was edited since it was last examined`);
      }
    }

    // 4/5. seen (every text-bearing line has been examined) vs. unseen
    // (at least one hasn't). Blank lines carry no topic signal and are
    // ignored for this determination.
    for (const lineId of memberLineIds) {
      const line = lineById.get(lineId);
      if (!line || BLANK_RE.test(line.text)) continue;
      if (!getNotepadLineState(lineId)) {
        return row('unseen', `line ${lineId} has never been examined`);
      }
    }
    return row('seen', 'every line in the block has been examined; nothing to add');
  });
}
