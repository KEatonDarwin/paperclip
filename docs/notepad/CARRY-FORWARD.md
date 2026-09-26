# Notepad — Yesterday rolls forward (goal 6, node #881)

This document defines the carry-forward rule: which lines move into a newly-opened
day, how their identity is preserved across day boundaries, why the state ledger
resolves through `origin_line_id` instead of the new line's `id`, the two mechanisms
that make the carry-forward idempotent, the gap-day rule for finding yesterday, and
how to verify the implementation end-to-end. The carry-forward engine lives in
`src/notepad-rollover.ts` and is wired into the day-open path by node **#882**.

---

## 1. The carry-forward rule — what moves, what stays

When a day is opened for the first time (either no `notepad_days` row exists yet,
or one exists with no `rolled_over_at` timestamp), the carry-forward engine runs
exactly once. It looks at the most recent prior day that has any lines in it, finds
every **open** line in that day, copies each to the new day as a fresh `notepad_lines`
row, and stamps the new day's `rolled_over_at` so a second open of the same day
skips this work.

**Open** is defined as: a line with **no ledger row** (`unseen`, per
docs/notepad/LINE-IDENTITY.md §3), **state = `seen`** (examined but judged not
actionable — still an open thought that deserves another look), or **state =
`acted`** (JARVIS took real action because of this line — but node #886's
contract is that acting on a thought is **not** the same as being done with
it; silently dropping a line just because JARVIS did something with it is the
exact failure that would send Kevin back to a plain .txt file). It is **not**:
- `dismissed` — Kevin or JARVIS explicitly ruled it out, and it stays out until the
  text changes (per the decision table in LINE-IDENTITY.md §4)
- `done` (node #886) — Kevin (or JARVIS) explicitly marked the thought finished.
  There is no UI affordance for setting this state yet — see §6.

Additionally, a line is skipped if it is blank (trimmed text is empty) — there is
nothing to carry.

**Closed** lines (state = `dismissed` or `done`) and blank lines **stay behind**.
Every other line — including `acted` lines — **carries forward**.

---

## 2. Lineage columns — the four new columns added to `notepad_lines`

The carry-forward mechanism adds four columns to `notepad_lines`, recorded by the
migration in `src/notepad-rollover.ts:32-42`:

### 2.1 `origin_line_id` and `origin_day` — day-zero identity

- **`origin_line_id` (TEXT, nullable):** The `id` of the very first line row that
  held this thought. If a line is originally typed (not carried), this column is
  **NULL** — the absence of a value means "this is day zero for this thought."
- **`origin_day` (TEXT, nullable):** The calendar day the `origin_line_id` line was
  created on. Also NULL for originally-typed lines.

When a line is carried, both columns are **inherited as-is** from the source line's
own `origin_line_id`/`origin_day` (if the source has them), or set to the source
line's own `id` and the source day's date (if the source is a day-zero line). This
means a line carried day1 → day2 → day3 always has `origin_line_id` pointing at the
day1 row — the chain never re-roots. **A thought's identity is its `origin_line_id`,
not its current line `id`.**

### 2.2 `carried_from_line_id` and `carried_at` — immediate provenance

- **`carried_from_line_id` (TEXT, nullable):** The `id` of the source line on the
  immediately-previous day. NULL for originally-typed lines.
- **`carried_at` (TEXT, nullable):** The ISO 8601 timestamp when this copy was made.
  NULL for originally-typed lines.

These are **one-hop only** — they record *"I was copied from this row"* but not
"and that row was copied from…" Walking the full lineage means following
`origin_line_id` back to day zero, not chasing `carried_from_line_id` links.

### 2.3 Why `origin_line_id` is the authoritative ledger key

The per-line state ledger (`notepad_line_state`, per LINE-IDENTITY.md) is keyed by
`line_id`. A carried line is a **new row with a new `id`**, so a naive lookup on
that `id` would find no ledger row — the line would look brand-new (`unseen`) even
though yesterday's incarnation already has `state = 'seen'` or `'acted'` recorded.

The solution is to **resolve the ledger key before reading the ledger:** given a line's
current `id`, check if it has an `origin_line_id`; if so, use that as the ledger key
instead. This is the `resolveLedgerKey()` function in `src/notepad-rollover.ts:284-291`.
The result is exactly one ledger row per origin thought, regardless of how many days
it has been carried across. A new day's carried lines find their prior state
immediately, and there is no risk of "orphaned" state (a line's current `id` with no
ledger, while a duplicate ledger row exists keyed under a past `id`).

**The write side resolves too (node #106):** `markLine()` in `notepad.ts` —
the one place `notepad_line_state` is ever written — resolves the same key
before its upsert, and `carryForwardInto()`'s own open/closed query joins the
ledger on `CAST(COALESCE(l.origin_line_id, l.id) AS INTEGER)`. Both were
originally keyed on the line's raw `id` while the readers resolved lineage,
which split one thought across two ledger rows: a state set on a carried line
was invisible to every reader (so JARVIS could act on the same thought again
the next day), and a thought marked `done`/`dismissed` on a carried line rolled
forward again every single morning. The guard is
`scripts/notepad-ledger-key-check.mjs` (`npm run notepad:ledger-key-check`),
which fails if either side regresses.

**Wired into the live path (node #886):** `resolveLedgerKey()` is registered
with `src/notepad.ts` at module load, via `registerLedgerKeyResolver()`, so
`notepad.ts`'s own `getNotepadLineState()` and `unscannedLines()` — the
functions every production caller (notepad-markers.ts, notepad-dispatch.ts,
notepad-action-resolver.ts, notepad-review.ts, notepad-gate.ts, and the
`GET /notepad` route) actually reads through — resolve lineage automatically.
This is a **runtime registration**, not `notepad.ts` statically importing
this file: `notepad-rollover.ts`'s own migration (§2 above) depends on
`notepad.ts`'s `CREATE TABLE` statements running before its `ALTER TABLE`
ones, and a static import cycle in the other direction was verified to break
that ordering whenever some other module imports `notepad.js` before
`notepad-rollover.js` (which several production modules do). See node #886's
finish note for the empirical proof.

---

## 3. Idempotence — running carry-forward twice produces the same result

The carry-forward engine is **structurally idempotent**: running it twice for the same
target day produces identical line ids, order, and state. This is enforced in two
independent ways:

### 3.1 The `origin_line_id` uniqueness guard

Before inserting a carried line, the engine checks whether a line with that
`origin_line_id` **already exists** on the target day (code at
`src/notepad-rollover.ts:158-165`). If so, that line is **skipped** — the source
line is not re-copied.

A source day's thought is identified by its **`origin_line_id`** (which is either the
thought's own line `id` on day zero, or its inherited `origin_line_id` on a later day).
Because `origin_line_id` uniquely identifies each thought, and a thought can only be
carried once per target day, a second pass of `carryForwardInto()` will find that all
source lines' origin ids already exist on the target, so it will skip all of them and
insert zero new rows.

### 3.2 The `rolled_over_at` timestamp guard — a fast-path marker

Every time `carryForwardInto()` runs (whether or not it actually carries anything),
it stamps `notepad_days.rolled_over_at` with the current ISO timestamp (code at
`src/notepad-rollover.ts:195`). The day-open wiring (`openNotepadDay()` in
`src/notepad-rollover.ts:250-258`) checks for this stamp **before** calling the
engine: if `rolled_over_at` is set, the day has already been rolled, so the engine
does not run at all.

This second guard serves the day-open path, not the `carryForwardInto()` function
itself. A caller that directly invokes `carryForwardInto()` twice (not through
`openNotepadDay()`) will rely on the `origin_line_id` guard alone. The `rolled_over_at`
stamp is a **cheap early exit**: opening a day ten times only ever does the query
work once, because nine of those opens see the stamp and return immediately. If that
check were removed, the `origin_line_id` guard would still prevent duplication, but
those nine redundant calls would each scan the source day's entire line set.

### Why both exist

The `origin_line_id` guard is **load-bearing** — without it, `carryForwardInto()`
is not idempotent at all, and a second direct call would duplicate rows. The
`rolled_over_at` guard is an **optimization**: it prevents the expensive query work
in the `openNotepadDay()` path, which is the normal day-open code path. Together,
they ensure carry-forward is idempotent both when called directly and when called
through the standard day-open entry point.

---

## 4. The gap-day rule — carrying from the last day with content

When `carryForwardInto()` runs for target day D, it looks for the most recent prior
day that **has any `notepad_lines` rows** (code at `src/notepad-rollover.ts:130-139`):

```sql
SELECT d.day AS day
FROM notepad_days d
WHERE d.day < ? AND EXISTS (SELECT 1 FROM notepad_lines l WHERE l.day = d.day)
ORDER BY d.day DESC
LIMIT 1
```

This means if a day is opened **four days after the last day with any lines** (e.g.,
day1 has content, day2–day4 are empty or never opened, day5 is opened), the engine
carries from day1, not from calendar-yesterday (day4). It follows the **last day that
exists**, not calendar time.

**Why:** a day with no lines has nothing to carry and is a no-op. Skipping empty days
means a person who did not write a notepad entry on days 2, 3, or 4 will still get
their day-1 thoughts back on day 5, not a void.

---

## 5. Verifying the proof — how to run the carry-forward checks

Three scripts validate the carry-forward mechanism, run in this order:

### 5.1 `npm run notepad:rollover-check` (node #881)

Calls `carryForwardInto()` directly with a single source day and asserts:
- Every line marked `unseen`, `seen`, or `acted` is copied (node #886: acting on
  a line does not close it)
- Every line marked `dismissed` or `done` is **not** copied
- Blank lines are skipped
- The `origin_line_id` chain is correctly set up (day-zero lines have NULL
  `origin_line_id`, carried lines inherit theirs)
- Order is preserved (`idx` is consecutive on the target day)
- A second call to the same target day is a no-op (idempotence)
- Carried lines resolve to the correct ledger state via `resolveLedgerKey()`

```bash
npm run build && JARVIS_DB_PATH=/tmp/notepad-rollover-check.db \
  node scripts/notepad-rollover-check.mjs
```

### 5.2 `npm run notepad:rollover-wire-check` (node #882, extended by #886)

Calls `openNotepadDay()` (the day-open entry point) twice for the same day and asserts:
- The first open runs carry-forward and stamps `rolled_over_at`
- The second open sees the stamp and **does not re-run** the engine (fast path works)
- The `carried_count` and `carriedFrom` summary fields are correct
- The same lines are present both times (zero new inserts on the second open)
- **(node #886) The date gate:** opening a day that is NOT today (relative to
  the real clock, or an injected `now`) is a pure read — no carry, no
  `rolled_over_at` stamp
- **(node #886) The live scan path:** `unscannedLines()` — not just
  `getLedgerStateForLine()` in isolation — does not report a carried `acted`
  line as unseen/new

```bash
npm run build && JARVIS_DB_PATH=/tmp/notepad-rollover-wire-check.db \
  node scripts/notepad-rollover-wire-check.mjs
```

### 5.3 `npm run notepad:rollover-replay-check` (node #883)

Replays **three consecutive days** through the real day-open path and asserts:
- Day1 is opened with 5 lines; day2 opens and carries all 5 in order
- On day2, 2 lines are closed (`done` and `dismissed` — node #886: `acted` alone
  does not close a line) and 2 new lines are added
- Day3 opens and carries exactly 3 (the survivors) + 2 (the new ones) = 5 lines
- The 2 closed lines are **gone** (not carried)
- The 3 survivors still have `origin_day = day1` (a two-hop lineage: day3 ← day2 ← day1)
- **No duplicates:** `origin_line_id` is unique per day across all three days
- **No lost lines:** the set of open thoughts on day N-1 is **exactly** the set on day N
  (verified by full set comparison, not just a count)
- **Idempotence:** opening day3 a 2nd and 3rd time produces byte-identical results
  (same line ids, same order, same `carried_from` values)
- **Gap day:** opening a day four days after the last day with content carries from
  the last day (not calendar-yesterday)
- **Edges:** an empty previous day and a previous day where everything is closed both
  produce zero carries and do not throw

```bash
npm run build && JARVIS_DB_PATH=/tmp/notepad-rollover-replay-check.db \
  node scripts/notepad-rollover-replay-check.mjs
```

Each script runs in isolation on a scratch database (guarded by `JARVIS_DB_PATH`)
and cleans itself up on success. All three must pass before the carry-forward
implementation is considered verified.

---

## 6. Out of scope here

This document defines the carry-forward rule, the lineage columns, the ledger
resolution strategy, idempotence, and the gap-day rule. It deliberately does **not**
define:

- **When the cockpit tells Kevin the lines carried** — a UI element saying "7 lines
  carried from Tuesday" is a later node. The carry-forward engine returns
  `carriedCount` and `carriedFrom` for the caller to use, but wiring that into a
  visible marker is out of scope here.
- **How Kevin dismisses or acts on a carried line** — that is part of the line-state
  ledger and settlement pass (node **#61**).
- **Carried-line markers or styling** — whether the cockpit visually distinguishes a
  carried line from an original one is a UI concern, not a ledger concern.
- **Marking a line `done`** — the `done` ledger state (node **#886**) exists and is
  exercised by `notepad:rollover-check`, but there is no UI affordance yet for
  setting it. A button/action in the cockpit is a later node.

Implementing any of those here would be scope creep on a node whose job is the
contract and the engine, not the UI or the downstream routing.
