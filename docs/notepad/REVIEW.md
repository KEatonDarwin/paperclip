# Notepad — adversarial review (tree-f84d2f5e node #713)

**Verdict: PASS (with 5 defects found and fixed on the branches).**

done_means reviewed against: *"Kevin opens one cockpit view, types freely all day
with autosave and zero lag, and it's all still there tomorrow — no formatting
rules, no structure imposed on him."*

Branches: `hopper/notepad` (backend, fix `af1e2338e`) · `hopper/notepad-ui`
(UI, fix `00762a0`).

## Defects found and fixed

| # | Where | Defect | Fix |
|---|-------|--------|-----|
| 1 | `src/notepad.ts` | **Line identity broken by any save that changed two things.** The leftover "positional reword" phase paired old→new lines by *ordinal* position. Delete a line above + reword a line below in one save → the reworded line inherited the *deleted* line's id and its own id was destroyed. Insert a line at the top + reword the last line → the brand-new line **stole** the last line's id. | Pair leftovers by **nearest index**, closest pairs claimed first, ties broken in original order (deterministic). |
| 2 | `src/notepad.ts` | Both diff phases were uncapped O(n²) over same-text buckets — a note of thousands of blank/identical lines cost tens of ms per autosave on the shared better-sqlite3 handle (event-loop stall class). | `PAIR_WORK_CAP` / `GROUP_SCAN_CAP` = 20k; past that, degrade to in-order pairing (semantically identical for indistinguishable lines). 3k identical lines: 27ms → 3ms. 5k half-blank: 35ms → 6ms. |
| 3 | `routes/notepad.tsx` | **Data loss:** `flushSession` set `savedText = session.latestText` *after* awaiting the PUT, so text typed during that in-flight save was marked saved but never sent — and flushSession runs exactly when the session is abandoned (day switch). | Snapshot the text actually sent; re-flush once if more arrived; keepalive-flush the remainder. |
| 4 | `routes/notepad.tsx` | **Data loss:** the textarea stayed editable while its buffer was being replaced — during the initial load (`sessionRef` null → `handleChange` returned early, keystrokes went nowhere) and during a day switch (`loadDay`'s `setText` overwrites). | `goToDay` sets `loading` for the whole switch; textarea is `readOnly` whenever there is no live session. |
| 5 | `routes/notepad.tsx` | `bestEffortFlush` hard-coded `/cockpit-api/notepad` instead of the client's `BASE` — the unload flush silently 404s the day that prefix moves. | New exported `cockpitApiUrl()`; one source of truth. |

Plus two robustness gaps closed in the same pass: `todayStr` went stale across
midnight on a page designed to stay open all day (the `→` / Today controls
stayed wrong), and a background tab held a stale buffer that a later save would
write back over newer text. `refreshFromServer` (focus + visibilitychange→
visible) re-derives the server's US/Central today and re-reads the current day —
**only when the local buffer is clean and no save is in flight**, so local
typing is never discarded.

## What was checked and found correct

- **Keystroke path (zero lag).** `handleChange` = `setText` + a ref write + a
  debounce timer. No network, no JSON work, no per-line React nodes (one plain
  `<textarea>`), so there is no re-render storm at 5k lines. Server-side saves at
  5,000 lines measured 7–11ms (no-op, single-char edit, mid-document insert).
- **Timezone.** `todayNotepadDate()` is `Intl.DateTimeFormat('en-CA', {timeZone:
  'America/Chicago'})` — server-side only. The client **never** computes "today";
  it takes the server's answer from the no-date `GET /notepad`, so client and
  server agree by construction. `shiftDay`/`formatDayLabel` are pure UTC calendar
  arithmetic over that server string, so browser TZ is irrelevant. Verified at
  both DST offsets (04:59/05:00Z in Sept, 05:59/06:00Z in Jan).
- **No structure imposed.** Round-trip is byte-faithful including leading
  indentation, tabs, consecutive blank lines, trailing spaces and a trailing
  newline. `.trim()` appears *only* as a diff matching key — never written.
  `text.split('\n')` / `join('\n')`, empty string → zero lines. UI: no markdown,
  no toolbar, no auto-indent, no list continuation, `spellCheck`/`autoCorrect`/
  `autoCapitalize` all off, Tab inserts a literal tab.
- **SSE.** This work adds **no** SSE events, so there is nothing to register in
  `GLOBAL_STREAM_EVENT_TYPES` (verified against the diff, not assumed).
- **Save durability.** `req` throws on non-2xx → the retry ladder (2s→20s
  exponential) engages; a failed save also fires a `keepalive` flush; blur and
  day-switch force a save; `beforeunload`/`visibilitychange` flush.
- **Body size.** `express.json({ limit: '30mb' })` — a 5k-line note (~200KB) is
  nowhere near the limit.

## Residual risks (documented, not fixed — call Kevin's shot)

1. **No optimistic-concurrency token.** Two windows *both* holding unsaved edits
   on the same day still last-write-wins the whole document. The focus-refresh
   above removes the realistic version of this (you can only type in the focused
   window), but the clean fix is a `rev` on `notepad_days` returned by GET/PUT,
   with PUT sending `base_rev` and a 409 on mismatch. That needs a conflict-UX
   decision (whose text wins) so it was not invented here.
2. **The buffer does not follow midnight.** Past midnight the `→`/Today controls
   now become correct, but the open buffer deliberately stays on the day it was
   loaded — moving it out from under someone mid-sentence would be worse. Late-
   night typing files under the previous day until Kevin clicks Today.
3. **Controlled `<textarea>` at 5k lines** re-assigns the whole value string on
   each keystroke. Measured fine, and it is inherent to a controlled textarea;
   an uncontrolled textarea + ref is the escape hatch if it ever bites.
