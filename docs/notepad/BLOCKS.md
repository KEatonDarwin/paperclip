# Notepad — judging by BLOCK, not by line (goal 6, node #941)

Kevin, 2026-09-26 morning, verbatim: "The more I look at this, the more I
think that one line at a time isn't exactly a 'thing to do' every time. It's
my notes... one thing that is consistent across all of it is my formatting
(for the most part). I put topics on their own line with no indention, and
everything underneath it is indented (almost always with spaces, but hardly
ever exact...) and it's almost always denoted with a dash... maybe we change
it from a per line thing to a 'block' thing... Just never look at the line on
its own, look at the entire block."

This document is the precise rule that follows from that, and the binding
decision about what changes and what doesn't.

## 1. THE BLOCK RULE

A **block** is one topic and everything Kevin wrote under it:

- A non-blank line with **zero leading whitespace** is a topic **headline**
  and starts a new block.
- Every following line that is **indented** — any amount of leading
  whitespace, spaces or tabs, any count — belongs to that block, at every
  nesting depth. Kevin's indents are eyeballed, never uniform (1 space here,
  4 there, a dash nested under a dash going deeper); the rule doesn't care
  how much whitespace, only that there is some.
- A **blank** (or whitespace-only) line does **not** end a block by itself —
  it stays inside the current block as a member. Only the next **non-blank,
  zero-indent** line ends it.
- A day that starts with indented (or blank) lines, before any headline has
  appeared, forms a block with `headline: null`.
- **Consecutive zero-indent lines** are each their own single-line block —
  Kevin sometimes writes a run of short standalone topics with nothing
  underneath them.

Implemented in `src/notepad-blocks.ts`, `parseNotepadBlocks()`. Pure
function: no DB, no model call, no imports beyond its own types.

```ts
export interface NotepadBlock {
  headline_line_id: number | null;
  headline: string | null;
  member_line_ids: number[]; // headline included when present, document order
  text: string;              // the block rendered verbatim, one line per member,
                              // each prefixed "[line_id N] "
}
```

`text` preserves Kevin's raw indentation exactly as typed — the judgment
models need to see his real formatting, not a normalized version of it.

## 2. Worked edge cases

**A day that opens mid-thought.** If Kevin starts typing before ever writing
a headline (or the day opens on a stray indented carry-forward line), that
run of indented/blank lines becomes one block with `headline: null` and
`headline_line_id: null`. It ends the moment a zero-indent line appears.

**Two headlines back to back.** If Kevin writes `Topic A` then immediately
`Topic B` with nothing indented between them, that's two separate one-line
blocks, not one block with two headlines. A block never has more than one
headline.

**A blank line in the middle of a list.** Kevin often leaves a blank line
between two dash groups under the same topic before moving to genuinely new
content. That blank line is **not** a section break — it's absorbed into the
current block as a member. The block only closes when the *next* zero-indent
line shows up. (If Kevin wants a hard break without starting a new headline,
this rule doesn't give him one — that's consistent with "never look at the
line on its own," a blank line carries no topic signal by itself.)

**Nesting depth.** `- top` / `  - deeper` / `     - deeper still` are all
just "indented" to this rule — depth beyond zero is not tracked or
distinguished. The judgment layer sees the whole block's text (with its real
indentation) and can read structure out of it if it needs to; the parser's
job is only to say which lines belong together, not to model a tree of
sub-bullets.

**Tabs.** A line indented with a tab (`\t- ...`) is indented exactly the same
as a line indented with spaces — the rule tests only "is there any leading
whitespace," not what kind.

**Whitespace-only lines.** A line that's all spaces/tabs and nothing else is
treated as blank (same as an empty string), never as a zero-indent headline.

**Every line lands somewhere, once.** Every input line ends up as a member
of exactly one block, and blocks are returned in document order — the
concatenation of every block's `member_line_ids`, in block order, is exactly
the original line-id sequence.

## 3. Binding design decision — per-line storage, block-level judgment

**Storage, line identity, the state ledger, and carry-forward stay
PER-LINE.** Nothing about this change touches `notepad.ts`'s line-diff
identity contract (see `LINE-IDENTITY.md`) or `notepad-rollover.ts`'s
lineage/carry-forward machinery. `notepad_lines`, the per-line state ledger
(`notepad_line_state`), and the ledger keys stay exactly as they are —
`notepad-ledger-key-check` (all 24 existing `notepad:*` checks) is not this
node's to touch and stays green.

**Blocks are the JUDGMENT layer only.** `parseNotepadBlocks()` groups line
ids into blocks for the pieces of the pipeline that decide *what a piece of
the note means* — the gate (does a complete thought live here?), the
whole-note review, the move decision, the topic dossier, the deterministic
routing rule, and dispatch. Those layers can now hand a model (or a rule) an
entire topic block, rendered with its real indentation, instead of one line
stripped of the context that made it a "thing to do" in the first place. The
*output* of that judgment (a move, a route, a dispatch) still resolves back
down to specific line ids, because a block is nothing more than a named
group of line ids — it carries no state of its own.

In short: **the ledger remembers by line. The models judge by block.**

## 3b. What the judgment layer actually consumes (node #942)

The first two consumers are wired:

**`notepad-review.ts` — `buildNotepadReviewContext(day)`**

* returns `blocks: NotepadBlock[]` alongside the existing per-line `lines[]`,
  parsed with `parseNotepadBlocks()` over the same raw day lines (a pure
  read — it adds no second source of truth);
* `rendered` stays whole-day and in document order, but **every** row is now
  prefixed `"[line_id N] "` *ahead of* its state tag
  (`[line_id 41] [ACTED -> cockpit:…] …`). This is the root-cause fix for
  yesterday's dry run: the moves model was handed bare text and a separate
  list of ids to judge, so 4 of its 5 reasons landed on the wrong lines.
  Raw indentation is preserved after the prefix, so the block shape is still
  visible to a reader.

**`notepad-gate.ts` — the gate judges BLOCKS**

* `prefilterGateCandidates(day)` returns `GateBlockCandidate[]`. A block
  *enters consideration* only if at least one member line surfaces via
  `unscannedLines(day)` — that per-line ledger call is untouched and is
  still the only source of "what's a candidate at all". Once a block
  qualifies, **every** member line is classified with `classifyGateSkip`,
  and the block is disposed only when *every* member is blank/marker-only/
  url-only/too-short. One member with real content sends the whole block to
  the model, junk members included, because Kevin's rule is never judge a
  line alone.
* Block identity is `block_id` = `headline_line_id`, falling back to the
  first member line's id for a `headline: null` lead-in block. `GateVerdict`
  carries `block_id`, `headline_line_id` and `member_line_ids`, so a caller
  can always resolve a verdict back down to lines (`notepad-pass.ts` and
  `scripts/notepad-dry-run.mjs` do exactly that).
* The model is asked the same single question as before — is there a
  complete topic here, or a fragment still being typed — once per block,
  in one batched call. Every failure mode (spawn error, timeout, non-JSON,
  wrong shape, an omitted or phantom `block_id`) still resolves that block
  to `complete_thought: false, reason: 'fallback'`; `notepad-dry-run.mjs`
  refuses to publish a report containing any `fallback` verdict, which is
  what keeps a failed model call loud instead of a confident-looking zero.

Still per-line by design, and out of node #942's scope: `notepad-moves.ts`
(it judges surfaced lines, now against an id-prefixed render), the marker/
route/dispatch layers, and everything in `notepad.ts` / `notepad-rollover.ts`.

## 4. Verification

`scripts/notepad-blocks-check.mjs` (`npm run notepad:blocks-check`) is a pure
function test — no DB, no `JARVIS_DB_PATH`, no model call:

1. A realistic 70+-line fixture in the shape of Kevin's real 2026-09-25 day
   (`Universal KPI Goal`, `IPInfo`, `Smart notepad`, and seven more real
   headlines from that day, with irregular dash-indented children, nested
   deeper indents, and blank separators inside blocks).
2. A day starting with indented lines → a `headline: null` block.
3. Consecutive headlines → each its own single-line block.
4. A blank line inside a block's children → stays in that block.
5. Tabs as indent → joins the block exactly like spaces would.
6. Whitespace-only lines → treated as blank, never as a headline.
7. Every input line lands in exactly one block, and document order is
   preserved (the concatenation of every block's member ids equals the
   full input id sequence).

`scripts/notepad-gate-check.mjs` (`npm run notepad:gate-check`) and
`scripts/notepad-review-check.mjs` (`npm run notepad:review-check`) cover the
consumer wiring above at block granularity against a scratch DB with a
stubbed model and zero claude spawns: wholesale disposal of an all-junk
block, a mixed block reaching the model whole, block-keyed model/fallback/
phantom-id verdicts, the `headline: null` block_id fallback, and the
`[line_id N]` prefix on every rendered row (indented and blank rows
included).
