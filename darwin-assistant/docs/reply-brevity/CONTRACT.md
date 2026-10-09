# Reply Brevity — CONTRACT

tree-c8e32ef9. Kevin's ask (2026-10-09, verbatim): "Basically when you reply,
sometimes I Don't need the massive amount of info that you provide. But I
Never want to lose that. So I'm thinking of a global or individual chat
feature that allows me to dial up/down the abbreviated content in a reply,
but still have the full reply collapsed underneath it. ... separate the two
by a delimiter or something. That way when I have it turned on, it'll show
me the simpler version, and I can click and extend it downwards to see the
full thing (or toggle which one to view on a per chat or global basis)."

This doc is the single source of truth for the design. Later nodes and future
JARVIS turns read this instead of re-deriving it. The implementation lives in
`src/reply-brevity.ts` (backend) — do not redesign without updating this file.

## Two independent axes

Do not conflate these.

**A. The GENERATION dial — `reply_brevity_level` (0-3).** How terse the short
version is. Controls what the MODEL WRITES.

- `0` = OFF. No brief, no marker — byte-for-byte today's behaviour.
- `1` = LIGHT. Brief is ~6-10 lines: the outcome, what it means, the asks.
- `2` = TIGHT (Kevin's stated default shape). Brief is 2-4 plain sentences +
  a `## Need from you` list.
- `3` = HEADLINE. Brief is 1-2 sentences + the asks, nothing else.

**B. The VIEW preference — `reply_brevity_view` (`brief` | `full`).** Which
half is shown expanded by default in the cockpit. Pure UI. Never changes what
the model writes, and is meaningless when the dial is 0 (there is no brief to
show/hide).

Both axes are GLOBAL settings-KV values with an optional PER-THREAD override
(`conversations.brevity_level` / `conversations.brevity_view`, both nullable
— NULL = inherit global). A per-thread value, when set, always wins over the
global value, independently per axis (a thread can override just the level,
just the view, both, or neither).

## The wire format

When the resolved dial is > 0, JARVIS writes ONE reply containing both
halves, brief first, separated by a single marker line:

```
<short version here>

<!--JARVIS-FULL-->

<full reply here>
```

The exact marker constant is `FULL_MARKER = '<!--JARVIS-FULL-->'`
(`src/reply-brevity.ts`).

This is an HTML comment, chosen deliberately: it renders invisibly in
markdown, so if any consumer forgets to strip it the failure is cosmetic (a
stray comment nobody sees), never a leak of scaffolding text into a Slack DM
or similar. There is one opening marker and no closing tag — a streaming
renderer needs no lookahead: everything before the first top-level marker
line is the brief, everything from that line onward (marker included, unless
stripped) is the full reply.

"Top-level" matters: a marker line that appears inside a fenced code block
(between a pair of ``` or ~~~ fence lines) is not treated as the split point.
The fence-tracking is a simple toggle on fence-delimiter lines, so a nested or
unbalanced fence can fool it — a known, documented limitation, not a silent
correctness claim.

If the marker appears more than once in a reply, the split happens on the
FIRST top-level occurrence; everything from there on (including any further
marker text) is left untouched inside `full`.

A brief that would be empty (e.g. the marker is the very first line of the
reply) is normalized to `null`, not an empty string — consumers should treat
`brief === null` as "nothing to render as a short version", never render an
empty bubble.

## What is stored

The turn's `content` column in the DB keeps BOTH halves verbatim, marker
included, exactly as the model wrote them. Nothing is ever truncated or
discarded — that is the core of Kevin's ask ("I never want to lose that").
Splitting into brief/full is a RENDER-TIME concern only, applied by whatever
reads the turn back out (cockpit UI, Slack relay, markdown export, etc.) via
`splitBrevityReply` / `stripBrevityMarker` / `briefOnly`.

## Resolution precedence

For a given thread, `resolveBrevity(externalId)` resolves to:

1. Worker-thread hard exclusion (see below) — always wins, level forced to 0.
2. Per-thread override (`conversations.brevity_level` / `brevity_view`), when
   non-NULL, per axis independently.
3. Global setting (`reply_brevity_level` / `reply_brevity_view` in the
   settings KV), defaulting to `0` / `'brief'` if unset or unparseable.

Settings are seeded OFF (`reply_brevity_level = '0'`) — Kevin turns this on
himself; the deploy must not silently reshape every reply in the system.

## The injection

`src/agent.ts`'s `perTurnContextPrefix` assembly gets one more block, built by
`brevityPromptBlock(resolveBrevity(conv.external_id).level)`, right alongside
the `<jarvis_autonomy_dial>` block. `brevityPromptBlock(0)` returns exactly
`''`, so at level 0 the prefix is byte-for-byte what it was before this
feature existed. This lands on a dial change on the very next turn (same
per-turn, not per-session, mechanism as the autonomy dial) — `buildSystemPrompt`
would NOT work for this, because it only rides the initial/continuation
prompt, so a mid-session dial change would never take effect there.

The injected instructions tell the model: write the full reply as you
normally would; ALSO write a short version; put the short version FIRST;
separate the two with a line containing exactly the marker and nothing else;
never put anything after the full reply; the short version must stand alone
(a reader who never expands it must still know what happened and what, if
anything, is needed from them); never drop a "Need from you" item from the
brief even if it also appears in the full reply; the full half is NOT a
rewrite or summary — it is the reply the model would have sent anyway.

## Hard exclusion — worker threads never get the dial

A thread whose `external_id` starts with `cockpit:hopper-node-` or
`cockpit:unblocker-` always resolves to level 0, regardless of the global
setting or any per-thread override. This is enforced inside `resolveBrevity`
itself (not just at the agent.ts call site) by reusing
`memoryProfileForThread` from `src/prompt.ts` — the same narrow prefix test
that already gates the worker memory diet — so there is exactly one place in
the codebase that knows which threads are "worker" threads, and no risk of
the two checks drifting apart.

This matters because a worker's output is parsed by the hopper finish
contract, which requires a `VERDICT:` line to be the FIRST line of the reply.
Prepending a brief would break that contract.

## API

- `GET /reply-brevity` — the global settings (`level`, `view`).
- `PATCH /reply-brevity` — set the global `level` and/or `view`.
- `PATCH /threads/:external_id/reply-brevity` — set/clear this thread's
  override. Accepts the literal string `"inherit"` for either field to clear
  that field's override back to NULL (go back to following global).

## Consumers (node #1572 — the leak-proofing sweep)

Every reader of a persisted assistant turn's `content` MUST make an explicit
brief/full decision — nothing gets to silently inherit the raw two-half text
by accident. The rule of thumb: anything a human glances at **with no
expand/collapse affordance** gets the **full** reply (never the brief, which
would hide information with no way to see what's hidden); anything that
**feeds another model or another summary** gets the **full** reply (summarizing
a summary loses detail silently); anything sent to a surface Kevin treats as
**glanceable** (Slack) gets the **brief**; the **one** exception — the cockpit
chat bubble itself — gets the **raw, unsplit** text (brief + marker + full)
because its renderer (`BrevityReply.tsx` in jarvis-command-center) does its
own client-side split and needs the marker to do it.

There are **two** classes of consumer, and the original sweep for this node
only knew about one of them. That mistake is worth recording, because it is
the reason three real leaks shipped past a green test suite.

**Class 1 — reads a persisted turn** via `conversation-db.ts`'s `getTurns` /
`getTurnsLean`. Guarded by part **D** of `scripts/reply-brevity-test.mjs`,
which scans `src/**/*.ts` for call sites of those two functions (tokenized —
comments and string literals stripped first, so prose mentioning them can't
trip it) and fails if a file calls them without appearing in this table and
the guard's `ALLOWLIST`.

**Class 2 — consumes `processMessage()`'s RETURN VALUE.** `processMessage`
hands the reply text straight back to its caller and never passes through the
turns table, so *no* amount of `getTurns` scanning can see these. This
document previously asserted "all turn content, with no exception found in
this codebase, flows through `getTurns`/`getTurnsLean`" — that was **false**,
and the review of this branch (tree-c8e32ef9 node #1573) found three live
leaks hiding behind it: `checkin-worker.ts` posting the raw brief+marker+full
to Kevin's Slack DM (where Slack renders no HTML, so the marker was *visible
text* — precisely the failure the HTML-comment marker was chosen to prevent)
and into the notification bell, plus both `handlers/webhook.ts` JSON
responses. Guarded by part **D2**, which allowlists **every** file calling
`processMessage` — including the fire-and-forget callers that discard the
return value. It deliberately does *not* try to detect "is the return value
used?" statically: a shape heuristic is the same species of guess that
produced the blind spot in the first place.

**The lesson, stated plainly:** a guard is only as good as its premise about
where the data flows. When adding a guard, write down the premise — then go
looking for a path that violates it.

| File / route | What it is | Decision | How |
|---|---|---|---|
| `handlers/api-v1.ts` — `GET /threads/:external_id` (`serializeTurn`) | **The cockpit chat bubble.** The React thread view's live data source. | **RAW, unsplit** (brief + marker + full) | None — this is the one exception. `jarvis-command-center/src/components/BrevityReply.tsx` reads the marker and splits client-side. |
| `handlers/api-v1.ts` — `GET /threads/:external_id/markdown` | "Download chat log" markdown export, for human reference outside the cockpit. | Full only | `fullOnly(t.content)` |
| `handlers/api-v1.ts` — `GET /threads/:external_id/context-markdown` | Condensed digest for pasting a thread's gist into a fresh chat (model-context consumer). | Full only | `fullOnly(t.content)` |
| `handlers/api-v1.ts` — `GET /threads/:external_id/messages/:message_id` | Generic async-polling API for external callers (not the cockpit — it has no brief/full expand UI). | Full only | `fullOnly(assistantTurn.content)`, applied to both the top-level `text` and the embedded `turn.content` |
| `handlers/api-v1.ts` — `GET /control-panel/run-history/:id/turns` | Control Panel admin drill-down — raw turn rows, no expand UI. | Full only | per-turn `{ ...t, content: fullOnly(t.content) }` |
| `handlers/api-v1.ts` — `POST /threads/:external_id/auto-title` | Reads the FIRST **user** turn only. | N/A | User turns never carry the marker (only assistant replies get the brevity treatment). |
| `handlers/api-v1.ts` — `POST /threads/:external_id/resume` | Checks the last **user** turn. | N/A | Same — user turn. |
| `handlers/api-v1.ts` — images route | Reads `turn.images`, not `.content`. | N/A | Different field entirely. |
| `handlers/slack.ts` — outbound DM / `/darwin-clear` flow (`processMessage`/`buildMorningBriefing` response) | Live Slack reply to Kevin. | **Brief** (when there is one) | `response = briefOnly(response)` before `say`/`chat.update` |
| `handlers/slack.ts` — `sendDailyBriefing` | Scheduled morning briefing post + its persisted turn. | Post: brief. Stored turn: full/raw. | `chat.postMessage({ text: briefOnly(briefing) })`; `addTurn(conv.id, 'assistant', briefing)` keeps the original text verbatim — "never want to lose that" applies to storage even though the Slack post is brief-only. |
| `thread-summarize.ts` — `renderTranscript` (DAR-740 point-in-time summary) | Feeds a `runClaude` summarization prompt. | Full only | `fullOnly(t.content)` for assistant turns |
| `thread-condense.ts` — `renderTurn`/`chunkTranscript` (long-thread condenser) | Feeds a `runClaude` condensing prompt. | Full only | `fullOnly(t.content)` for assistant turns |
| `thread-search.ts` — `threadSnippet` (AI-mediated natural-language search corpus) | Fallback snippet (no summary yet) fed into the search-matching prompt. | **Both halves**, marker stripped | `stripBrevityMarker(t.content)` — Kevin may search using wording that only appears in the brief, so the match corpus must contain both. |
| `agent.ts` — `summarizeTurnForReplay` (used by `buildContinuationPrompt`, the provider-switch / context-overflow transcript replay) | Feeds the transcript **back to the model itself** as its own prior context. | Full only | `fullOnly(turn.content)` for assistant turns |
| `tools/group-chat-tool.ts` — `get_member_thread` tool, `mode:'full'` | Another JARVIS instance (in a group chat) reading a member thread's real transcript. | Full only | `fullOnly(t.content)` for assistant turns |
| `ephemeral-chat.ts` — ephemeral chat widget snapshot | A second, throwaway chat surface in the cockpit with no expand/collapse UI of its own. | Full only | `fullOnly(t.content)` for assistant turns |
| `ui-server.ts` — legacy pre-React debug server (`/conversations/:id` HTML view, `/api/conversations/:id` JSON dump, `/api/conversations/:id/markdown`, `/api/conversations/:id/session-clone`, `/api/conversations/:id/continue` primer generation, and the page's live SSE tail) | Admin/debug surface, still live on the same port (3201) as the real API, superseded by the React cockpit but not deleted. Five server-side `getTurns` call sites plus one client-side SSE render path — all found only by the regression guard's static scan, not the original file list for this node. | Full only, everywhere | `groupTurnsIntoExchanges` (shared by `renderExchange` the HTML view, and `buildSessionClone`) stores `{ ...t, content: fullOnly(t.content) }`; `buildTranscriptMarkdown` and `buildPrimerSourceTranscript` (feeds the `/continue` primer **model prompt**) apply `fullOnly` inline; the raw `GET /api/conversations/:id` JSON dump maps assistant turns through `fullOnly`; the inline client-side SSE live-tail script has its own minimal `fullOnlyClient` (line-split only, no fenced-code awareness — an accepted limitation on this debug-only page). |
| `checkin-worker.ts` — the fired check-in nudge (**class 2**) | `processMessage`'s return value, posted to Kevin's Slack DM, put in the notification bell body, *and* persisted as an assistant turn. | Slack post: **brief**. Bell body: **brief**. Persisted turn: **RAW**. | `const nudgeText = briefOnly(response)` feeds both `chat.postMessage` and `createNotification({ body })`; `addTurn(…, 'assistant', response)` keeps the original both-halves text so the cockpit's Notifications thread still renders the expander, and the notification links straight to it. Deviates from the review's suggestion of `fullOnly` for the bell body on purpose: the bell is the definition of a glance surface, and its `link` is the expand affordance. |
| `handlers/webhook.ts` — `POST /intake`, `POST /intake/reply` (**class 2**) | `processMessage`'s return value returned as `{response}` JSON to a programmatic caller. | Full only | `fullOnly(await processMessage(…))` on both routes — an API client has no expander, so it must never get the abbreviated half. |
| `notifications.ts` — notification `body` | Carries turn/reply content when a caller passes it. | Per-caller (see `checkin-worker.ts` above) | `checkin-worker.ts` is the one caller that passes reply text, and it passes the brief. Every other caller (`agent.ts`'s chat-importance ping, `tech-tasks.ts`, `mike-radar-report.ts`, `hopper-engine.ts`, …) uses static/templated strings or hopper-node `result` text (see below). An earlier draft of this table claimed *no* caller did — the class-2 guard is what makes that claim checkable instead of assumed. |
| `tree-cue.ts`, `hopper-engine.ts` (finish-contract parsing), `goals.ts` / `goals-autopilot*.ts` (verdict parsing), `night-shift.ts`, `shift-narrator.ts`, `result-summary.ts`, `layman-summary.ts`, `mike-radar-report.ts`, `tech-tasks.ts` | All read a hopper-node worker's `result` text, supplied directly in the finish-contract POST body (`parsed.result`) — never read back out of `turns.content`. | N/A | Doubly safe: (1) this text never round-trips through the DB turn-content column at all; (2) even if it did, every hopper-node/unblocker worker thread hard-excludes to level 0 (see above), so a worker's own reply never gets a brief or a marker in the first place. `mike-radar-report.ts`'s `row.text` is scraped Teams/Slack content from `mike_activity`, not a JARVIS turn at all. |
| `notepad-dossier-sources.ts`, `group-chat-context.ts`, `big-board.ts`, `workbench.ts` (`read_up`), `briefing.ts`, `jarvis-brief.ts` | Read `thread_summaries.content` (a pre-generated summary) or `thread_todos.content` (a todo's own text). | N/A | Neither table ever stores raw turn content with a marker — summaries are freshly generated text, todos are authored separately. |

## The level gate — "level 0 is byte-for-byte" has to include detection

Marker detection was originally unconditioned on the dial. That left one real
hole, found by the review of this branch (tree-c8e32ef9 node #1573): with the
dial **off**, a reply that merely *mentions* the marker on its own line — e.g.
me explaining this very feature to Kevin — was still split. In the cockpit that
sprouted a toggle that hid half the reply; in Slack `briefOnly` silently
**dropped everything after it**. The proven case was a level-0 reply whose
final line was an ask ("Kevin, I need you to merge the branch.") — the ask
vanished from the Slack text. Dropping an ask is the single worst thing this
feature can do.

Gated in the two places where loss was possible:

- **The cockpit renderer** takes the thread's effective `level` as a prop and
  skips the split entirely at level 0 (`BrevityReply.tsx`). `undefined` (the
  first-paint window before the thread descriptor lands) still splits — the
  descriptor arrives on the same fetch as the timeline, so this is a frame,
  not a steady state.
- **`briefOnlyForThread(externalId, text)`** resolves the level first and is
  the identity function at level 0. Both brief-only consumers
  (`handlers/slack.ts` live reply, `checkin-worker.ts` nudge) use it.

### Known gaps

- **`fullOnly` is deliberately NOT level-gated.** Its consumers are exports,
  digests, polling APIs, the admin drill-down, cross-thread reads and the
  model's own transcript replay — all of which hold the conversation but would
  each need a level resolved and threaded through per call site, which is a
  wider change than the defect justifies. The residual behaviour: at level 0, a
  reply containing a bare marker line would have its pre-marker text trimmed in
  an export or digest. Nothing is *lost* — the authoritative turn in the DB and
  the cockpit bubble both still hold the complete text — but that export would
  be incomplete. If this ever bites, the exact fix is a `brevity_level` column
  on `turns`, written at persist time, so the split decision is per-turn rather
  than per-thread.
- **Fence tracking is a toggle, not a parser.** A nested or unbalanced code
  fence can defeat the "marker inside a fence doesn't count" rule. Documented
  in `splitBrevityReply`, covered by a fixture for the balanced case only.
- **Slack has no expand affordance.** By design: Kevin gets the brief there and
  the cockpit holds the full reply. The check-in notification works around this
  by linking to the thread that holds both halves.
- **The manual-expand memory is keyed on a hash of the brief**, not on a turn
  id, because the event id is not stable across the stream-end key swap. Two
  byte-identical briefs in one thread therefore share one expand state. It is
  per-session UI state and dies with the page.
