// Node #941 — the BLOCK judgment layer over Kevin's notepad.
//
// Kevin's own words: "I put topics on their own line with no indention, and
// everything underneath it is indented (almost always with spaces, but hardly
// ever exact) ... denoted with a dash ... never look at the line on its own,
// look at the entire block." This module turns his real formatting habit into
// a precise, deterministic rule.
//
// THE BLOCK RULE:
//   - A non-blank line with ZERO leading whitespace is a topic HEADLINE and
//     starts a new block.
//   - Every following line that is indented (any amount of leading
//     whitespace — spaces or tabs, any count, never assumed uniform)
//     belongs to that block, at every nesting depth.
//   - A blank (or whitespace-only) line does not end a block by itself —
//     it stays IN the current block. Only the next non-blank, zero-indent
//     line ends it.
//   - A day that starts with indented (or blank) lines, before any headline
//     has appeared, forms a block with headline=null.
//   - Consecutive zero-indent lines are each their own single-line block.
//
// PURE FUNCTION: no DB, no model call, no imports beyond types. Storage,
// line identity, the state ledger, and carry-forward stay PER-LINE — see
// docs/notepad/BLOCKS.md for the binding design decision. This module is
// read-only judgment scaffolding: it groups line ids into blocks for the
// gate/review/moves/dossier/routing/dispatch layers to consume; it never
// creates, renames, or renumbers a line.

export interface NotepadBlockLineInput {
  id: number;
  idx: number;
  text: string;
}

export interface NotepadBlock {
  headline_line_id: number | null;
  headline: string | null;
  member_line_ids: number[];
  text: string;
}

const BLANK_RE = /^\s*$/;
const ZERO_INDENT_RE = /^\S/;

function isBlank(text: string): boolean {
  return BLANK_RE.test(text);
}

function isHeadline(text: string): boolean {
  return !isBlank(text) && ZERO_INDENT_RE.test(text);
}

function renderBlock(lines: NotepadBlockLineInput[]): string {
  return lines.map((l) => `[line_id ${l.id}] ${l.text}`).join('\n');
}

export function parseNotepadBlocks(lines: NotepadBlockLineInput[]): NotepadBlock[] {
  const ordered = [...lines].sort((a, b) => a.idx - b.idx);

  const blocks: NotepadBlock[] = [];
  let current: { headlineLine: NotepadBlockLineInput | null; members: NotepadBlockLineInput[] } | null = null;

  const closeCurrent = () => {
    if (!current) return;
    blocks.push({
      headline_line_id: current.headlineLine ? current.headlineLine.id : null,
      headline: current.headlineLine ? current.headlineLine.text : null,
      member_line_ids: current.members.map((l) => l.id),
      text: renderBlock(current.members),
    });
    current = null;
  };

  for (const line of ordered) {
    if (isHeadline(line.text)) {
      closeCurrent();
      current = { headlineLine: line, members: [line] };
    } else if (current) {
      current.members.push(line);
    } else {
      current = { headlineLine: null, members: [line] };
    }
  }
  closeCurrent();

  return blocks;
}
