# Notepad — the line-state contract (goal 6, node #91)

This document defines, precisely enough for a stranger to implement without a
follow-up conversation, what a notepad line's **id** means, when its
**normalized hash** is considered to have changed, the **four states** a line
id can be in, and the **decision table** that says what a re-scan does in
every combination. Node **#92** (the per-line state ledger) implements
exactly this. Node **#61** (the settle-and-reread pass) and node **#62**
("JARVIS speaks only when it has something worth saying") are the consumers
this contract exists to make safe.

---

## 1. Identity — what a line id means

Every line in `notepad_lines` has a stable integer `id` (the primary key).
That id is assigned once, when the line first shows up as a genuine insert,
and is preserved across saves for as long as the algorithm in
`putNotepadDay()` (`src/notepad.ts`) can tell "this is still recognizably the
same line."

**The id is the dedupe key for anything JARVIS does with a line.** A
per-line ledger entry, a "JARVIS already looked at this" mark, an "I already
filed this as a task" action reference — all of it is keyed on the line id,
never on the line's text and never on its position (`idx`). Text changes
under editing; position changes under reordering; the id is the one thing
designed to survive both.

The rules below are exactly what `applyLineDiff()` (`src/notepad.ts:135-250`)
does today — this section describes the implementation, it does not propose
a new one.

### 1.1 Content match (unchanged text, anywhere in the note)

Old lines are grouped by **trimmed text** (`src/notepad.ts:136-142`) and new
lines are grouped the same way (`:144-150`). For each new-side occurrence of
a given trimmed text, the matching loop (`:152-180`) claims an old candidate
with that same trimmed text — so a line that moved anywhere in the note,
including to a completely different position, keeps its id. This is what
makes **re-indent** (leading/trailing whitespace only — the trim absorbs it)
and **move / block reorder** id-stable: the text is unchanged after
trimming, so it is a content match regardless of where it landed.

**Duplicate identical lines** (two or more old lines share the same trimmed
text) are handled by the same group: when more than one new occurrence needs
that text, each occurrence claims the **nearest-index** old candidate
(`:162-176` — `scanNearest` walks the candidate list and picks the smallest
`Math.abs(oldIdx - newIdx)`, ties broken by scan order). Editing or deleting
*one* occurrence of a duplicated line only ever consumes the old candidate
nearest to that occurrence's position — the other duplicates are untouched
and keep their own ids (proved in `notepad-check.mjs` cases 1a/1b).

### 1.2 Positional reword (nearest-index pairing of leftovers)

Whatever is left over after content matching — old lines whose text no
longer exists anywhere in the new note, and new lines whose text didn't
exist anywhere in the old note — goes through a second, independent
nearest-index pairing (`:192-231`). Every `(leftover-old, leftover-new)`
pair is scored by `Math.abs(oldIdx - newIdx)`, sorted so the closest pairs
are claimed first, ties broken by original order for determinism
(`:208-221`). This is what makes a **reword** (the text actually changed)
keep its id: the reworded line's old row is almost always at distance 0 or 1
from the new line's position, so it wins the pairing before a farther-away
leftover (e.g. a line that was deleted elsewhere in the same save) can steal
it. Anything still unclaimed after this phase is a genuine **insert** (new
id) or **delete** (old id retired) — `:233-249`.

### 1.3 Split and merge (no special-casing — same mechanism as 1.2)

**SPLIT** (one line becomes two): the fragment that ends up occupying the
original line's index is distance 0 from that old row and wins the pairing
first, so **the leading fragment keeps the original id**; the trailing
fragment has no old candidate left to claim and becomes a genuine insert.
This is stated directly in the code comment at `src/notepad.ts:199-202` and
proved in `notepad-check.mjs` case (3).

**MERGE** (two lines become one): the merged line lands at the **first**
source line's old index, which is distance 0 away, so **the first (topmost)
line's id survives**; the second source line is left unclaimed and is
deleted. Stated at `src/notepad.ts:203-206`, proved in `notepad-check.mjs`
case (4).

### 1.4 Cost-cap degradation (and what it costs)

Both phases are cost-capped — `GROUP_SCAN_CAP` for the content-match
nearest-index scan within one duplicate-text bucket (`:14`, checked at
`:162`), `PAIR_WORK_CAP` for the leftover-reword pairing (`:15`, checked at
`:192`). Past 20,000 candidate pairs, each phase degrades to **in-order**
pairing instead of nearest-index (`:165` `bestPos = 0` when `scanNearest` is
false; `:222-230` the `else` branch pairs leftover *i* to leftover *i* in
scan order). This keeps a save off an O(n²) path that would stall the shared
event loop on a pathological note.

**Consequence for id stability:** below the cap, the guarantee is "the
nearest old candidate by position wins." Above the cap, the guarantee
weakens to "the *i*-th candidate in scan order wins" — for lines whose text
is genuinely identical this is unobservable (the lines are interchangeable),
but for a wholesale rewrite large enough to trip `PAIR_WORK_CAP` (roughly
141+ leftover lines on both sides simultaneously), a reworded line's new id
assignment is no longer guaranteed to be the *positionally closest* old row,
only *some* old row in scan order. This is an accepted tradeoff, not a bug:
it only engages on edits far larger than a person's single save, and never
changes the *count* of surviving vs. inserted vs. deleted ids — only which
specific reword pairs with which specific old row when the note is being
rewritten wholesale.

---

## 2. Normalized hash

The normalized hash exists to answer one question: **has this line's
meaning-bearing content changed since JARVIS last looked at it?** It is
deliberately blind to whitespace/indentation and bullet-marker style, because
those change constantly as Kevin types and carry no meaning of their own —
if the hash reacted to them, every re-indent would look like a brand-new
line to the ledger.

### 2.1 Normalization — exact steps, in order

Given the raw line text as stored in `notepad_lines.text`:

1. **Trim** leading and trailing whitespace.
2. **Strip a leading bullet marker.** If the trimmed text matches
   `/^[-*•]\s*/`, remove that marker and any whitespace immediately
   following it.
3. **Collapse internal whitespace.** Replace every remaining run of
   whitespace (spaces, tabs) with a single space.
4. **Casefold.** Lowercase the result.

The output of step 4 is the *normalized text*. Order matters: trimming
first means a bullet preceded by stray leading spaces is still recognized
in step 2; stripping the bullet before collapsing whitespace means the
(possibly multi-space) gap after the marker doesn't need special-casing
separately from ordinary internal whitespace.

### 2.2 Hash function

`hash = sha256(normalized_text).hex()` — i.e. Node's
`crypto.createHash('sha256').update(normalizedText, 'utf8').digest('hex')`.
A cryptographic hash is overkill for collision resistance here, but it is
free, deterministic, fixed-width, and already a standard-library import —
no reason to invent a weaker one.

### 2.3 Worked examples

| # | Before | After | Hash changes? | Why |
|---|---|---|---|---|
| 1 | `- Call Mike about the invoice` | `    - Call Mike about the invoice` | **No** | Only leading whitespace changed; trim (step 1) removes it before the rest of normalization runs. |
| 2 | `- Call Mike about the invoice` | `* Call Mike about the invoice` | **No** | Bullet marker style changed (`-` → `*`); step 2 strips either marker, leaving the same remainder. |
| 3 | `Call Mike About The Invoice` | `call  mike about   the invoice` | **No** | Case and extra internal spacing differ, but step 3 collapses whitespace and step 4 casefolds both to `call mike about the invoice`. |
| 4 | `- Call Mike about the invoice` | `- Call Mike about the contract` | **Yes** | The subject word changed (`invoice` → `contract`) — a real content change survives normalization. |
| 5 | `- Call Mike about the invoice` | `- Do NOT call Mike, Ian is handling it` | **Yes** | Meaning reversed. This is the canonical "already acted, now the instruction flipped" case the decision table (§4) exists for. |
| 6 | `- Follow up with Ian` | `- Follow up with Ian tomorrow` | **Yes** | Added content changes the normalized text even though the line is a superset of the old one. |

---

## 3. The four line states

A line id, at any moment, is in exactly one of these states:

- **`unseen`** — no scanner has ever examined this line. This is the
  default: a brand-new line id (whether from a genuine insert, or the
  surviving side of a reword/split/merge per §1) starts here with **no
  ledger row required** — `unseen` is defined as "no `notepad_line_state`
  row exists for this line id yet," not as an explicit row value. Nobody
  sets it; it is the absence of a record. It ends the moment any of the
  three actions below writes a row.
- **`seen`** — a scanner examined the line's current text and judged it
  **not actionable** right now. Set only by JARVIS, via `markLineSeen`,
  which stamps the line's *current* normalized hash (§2) at the moment of
  judgment.
- **`acted`** — JARVIS took a real action because of this line. Set only by
  JARVIS, via `markLineActed(lineId, actionRef)`, which stamps the current
  normalized hash AND records `actionRef` — a pointer into whatever system
  actually received the work (a thread `external_id`, a hopper tree id, a
  goal node id, a Task Hopper item id, a workstream id, a commitment id —
  whichever applies). `actionRef` is what node #92's "reconciliation" return
  shape carries back out when the line changes again (§4).
- **`dismissed`** — the line has been explicitly ruled out as not needing
  further tracking. Set by either JARVIS (it judged the line irrelevant on
  its own, e.g. small talk, a stray character) or Kevin (an explicit
  dismiss on a marker per node #62), via `markLineDismissed(lineId, note)`,
  which stamps the current normalized hash and an optional `note` (why).

All three marking functions stamp the hash of the text *that was actually
examined* — never a hash computed later — so the next comparison is always
against what was truly looked at, per node #92's spec.

---

## 4. The decision table

Rows are the state a line id is currently in (per §3). Columns are whether
the line's *current* normalized hash (§2) matches the hash recorded the last
time that state was set. The cell is what a re-scan pass (`unscannedLines`,
per node #92) does with that line.

| State | Hash unchanged since last recorded | Hash changed since last recorded |
|---|---|---|
| **`unseen`** (no row yet) | *(no recorded hash exists — see below)* | *(same — nothing to compare against)* |
| **`seen`** | **Skip.** Already looked at; the text is exactly what was judged not-actionable, so there is nothing new to judge. | **Surface as new material.** The judgment "not actionable" was made against the *old* text. Different text has never been judged — it is a fresh candidate for a first look, not a reconciliation (there is no prior action to reconcile against). |
| **`acted`** | **Skip.** This is the "a typo fix never re-fires a nag" rule: the text looks exactly as it did when the action was taken, so there is nothing to reconsider. | **Surface for reconciliation, carrying the existing `action_ref`.** Never spawn a second, sibling action. Re-examine whether the action already on file still matches what the line now says, and update that action if it doesn't. |
| **`dismissed`** | **Skip.** The ruling (Kevin's or JARVIS's) was made against this exact text and still stands. | **Surface as new material.** A dismissal is a judgment about *specific prior text* — it does not extend to different text. Treat it as a first look, not as "already dismissed." |

A line with **no ledger row** (`unseen`) has no recorded hash to compare
against at all, so both columns collapse to the same outcome: it always
surfaces for a first look. This is exactly `unscannedLines(day)`'s
contract per node #92 — return every `unseen` line, **plus** every
`seen`/`acted`/`dismissed` line whose current hash no longer matches its
recorded hash.

**The load-bearing reasoning, stated plainly:** the hash can only ever say
*"this line's normalized text changed"* — it cannot distinguish a cosmetic
edit (a typo, a word reordered without changing meaning) from a genuine
meaning change. The contract does not try to make that distinction at the
hash layer. Instead: **`acted` + hash changed always means "re-examine and
reconcile against the existing `action_ref` — never fan out a new,
independent action."** Whether the re-examination decides "nothing really
changed, leave the action as-is" or "the instruction flipped, update the
action" is a judgment call made *after* surfacing, by whatever consumes
`unscannedLines` (node #61's settle-and-reread pass) — but that consumer is
guaranteed to receive the line paired with its prior `action_ref`, never as
a bare unseen line that would cause it to file a second, disconnected
action.

---

## 5. Out of scope here

This document defines identity, the hash, the four states, and the
skip/surface decision. It deliberately does **not** define:

- **The scanner itself** — what a "settle" event is (Enter, blur, a pause in
  typing), what it reads, and how it decides "not actionable" vs. "here's a
  real move." That is node **#61**.
- **The scan cadence** — how often/when a re-scan pass runs at all. Also
  node **#61**.
- **The talking** — how a marker actually renders next to a line, and the
  bar for when JARVIS surfaces something to Kevin at all versus staying
  silent. That is node **#62**.

Implementing any of those three here would be scope creep on a node whose
job is the contract, not the behavior built on top of it.
