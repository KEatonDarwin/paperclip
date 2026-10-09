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
