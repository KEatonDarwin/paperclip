# DECISIONS — hopper/jarvis-nudge (+ hopper/jarvis-nudge-ui)

## 2026-09-15 · Adversarial review (tree-4f8bb8b7 node #228, opus) — BLOCKED, 4 must-fix + 3 should-fix

Reviewed `hopper/jarvis-nudge` @ `687e480ef` (darwin-assistant) and
`hopper/jarvis-nudge-ui` @ `aae3a06` (jarvis-command-center) against
`darwin-assistant/docs/hopper/NUDGE.md` and the original ask (bubble must be
noticeable; message must be JARVIS speaking with enough real info to answer
inline; the reply-turn applies Kevin's answer and resolves the nudge).

Method: scratch sqlite (`/tmp/nudge-review.db`) + throwaway backend on :3299
(`env -i`, bogus `DATABASE_URL`, no Slack, so no live system was touched), the
UI worktree built with the node-server preset and served on :8099 against that
backend, Playwright (chromium-1243 from the live cockpit's node_modules) for the
bubble/bell probes, a recording fake `claude` on `CLAUDE_BIN` to capture exactly
what the reply-turn model receives, `/bin/false` and fake/slow composer binaries
for the failure paths, and two real `claude-sonnet-5` composer calls (quality +
prompt-injection probe). Live jarvis.db / jarvis.service / cockpit :8080 never
opened. Scratch processes torn down at the end.

### What holds (verified)

- Composer failure → deterministic fallback: `NUDGE_CLAUDE_BIN=/bin/false` →
  `POST /nudges` 201 in 22 ms, fallback text + footer persisted as an
  assistant turn, `nudge` SSE + bell emitted.
- NO API KEYS: fake composer dumped its env — `ANTHROPIC_API_KEY` (seeded as a
  canary) absent, everything else inherited; argv is
  `-p <prompt> --model <m> --output-format json`, stdin closed. No SDK imports.
- XSS: composed/context text containing `<img onerror>`, `<script>`,
  `javascript:` links renders escaped through `MarkdownText` (react-markdown
  10, no rehype-raw); `defaultUrlTransform` empties `javascript:` hrefs.
  Playwright: `document.title` untouched, zero injected nodes.
- Prompt-injection probe (context ordering the composer to run Bash + read
  `.env`): the model refused; nothing executed. (Hardening still recommended,
  see S-3.)
- Message quality (real sonnet call, 7 s): first-person, restates the actual
  fork, offers the answer choices inline — meets the "JARVIS speaking with
  enough real info" bar.
- Bubble: hidden at 0 open; pulses (nudge-pulse class) with ≥1 pending; opening
  it POSTs `/nudges/delivered` (server pending→0), docks the ThreadPane
  mini-chat on `cockpit:jarvis-nudges`; close → quiet-visible, no pulse; a new
  nudge arriving over SSE re-pulses without reload; resolving every open nudge
  via PATCH removes the bubble live. Count badge correct.
- Bell wrap fix: titles/bodies wrap inside the `max-h-96 overflow-y-auto`
  dropdown; layout intact (screenshot `/tmp/nudge-4-bell.png`).
- Duplicate `(source, subject_ref)` while open → 200 + existing row, no new
  row, no second bell (serial case).
- `deliver` is idempotent; `PATCH` refuses anything but `resolved`; UNIQUE
  partial index enforces one open nudge per subject.

### Must-fix (each has a repro)

**M-1 — The reply loop is structurally broken after the first reply (HIGH).**
Nudge turns are inserted straight into `turns` via `addTurn()`. The harness
feeds the model either (a) a transcript replay when the conversation has no
native session, or (b) `--resume <session>` + `<memory_refresh>` + the new
user text once a session exists. Nothing re-injects out-of-band assistant
turns into a resumed session. Repro (recording fake `claude` on
`CLAUDE_BIN`): reply #1 "keep fallback" → continuation prompt contains the
three nudge footers (OK, no session yet). Create nudge #4 (node-77). Reply #2
"remove fallback" → args `--resume fake-session-1`, stdin = memory_refresh +
"remove fallback"; grep for `node-77|node #77|hopper-nodes/77` = **0**. The
model literally cannot know which nudge Kevin is answering, so it cannot hit
`answer_route` or PATCH resolved. Additionally the NUDGE.md "first-turn
injection" instruction (inspect latest unresolved footer → call answer_route →
PATCH resolved → confirm) is not implemented on either branch, so even reply
#1 relies on the model improvising from memory.md prose.
Fix: in `agent.ts` `runConversationTurn`, when `conv.external_id ===
NUDGE_THREAD_EXTERNAL_ID`, build a per-turn `<jarvis_nudges>` block (same
slot as `quickChatContextBlock`) from `listNudges('open')` — id, source,
subject_ref, summary, why, answer_route, created_at, newest first — plus the
reply-loop instruction from NUDGE.md §Reply Loop. Server-owned, so it works
identically on replay and resume. Keep the footer for audit.

**M-2 — Answering the source never resolves the nudge; bubble count only grows
(HIGH).** `POST /hopper-nodes/:id/answer` / `answerHopperNode()` (the existing
/spawn-tree answer box and "answer hopper node N" chat path) do not touch
`nudges`. Repro: create a `blocked_question` nudge for node N, answer node N
via the existing route → nudge still `pending/delivered`, `open` count
unchanged, bubble stays. There is also no resolve/dismiss affordance in the
bubble or mini-chat, so with M-1 the count can never reach zero from the UI.
Second-order: an answered node that later re-blocks with a NEW question hits
the still-open `(blocked_question, tree/node-N)` row → duplicate suppression
returns the OLD nudge, no new turn — Kevin is never nudged about the second
question. Fix: `answerHopperNode()` (and `retryHopperNode`) resolve the open
`blocked_question` nudge for `${tree_id}/node-${id}` (export a
`resolveNudgeBySubject(source, subject_ref)` helper); do the same in the
finish-line / unblocker / commitment producers' terminal paths; add a small
"Resolve" control per open nudge in the bubble (or accept a
`resolved`-on-reply contract once M-1 lands).

**M-3 — The 14-day auto-hide sweep archives `cockpit:jarvis-nudges`, after
which every nudge creation 500s and leaves ghost pending rows (HIGH).**
`autoHideStaleThreads()` (index.ts, boot + every 6 h, default 14 d — the live
`thread_auto_hide_days` setting is unset) archives any `active` thread with
`group_id IS NULL` and no open todos. `PROTECTED_THREAD_IDS` only guards the
PATCH/DELETE routes, not the sweep — and it also forbids `group_id` changes,
so Kevin cannot even group the thread to protect it. Once archived,
`getOrCreateConversation()` falls through to INSERT →
`UNIQUE constraint failed: conversations.external_id`. Repro on scratch: set
`updated_at` to −15 d, restart → log `[auto-hide] archived 1 thread(s)`;
`POST /nudges` → 500 `nudge_create_failed`, yet the `nudges` row was already
inserted with `turn_id NULL`, so `GET /nudges?status=open` counts it, the
bubble pulses, and the mini-chat has no message for it. The hopper producer
path (`createNudgeAsync`) just logs the error. Fix: exclude
`PROTECTED_THREAD_IDS` from the sweep's SELECT (export the set or move it to
conversation-db), AND make `ensureNudgeThread()` re-activate an archived row
(`UPDATE conversations SET status='active'`), AND insert the nudge row inside
the same try as materialization (delete/skip the row on failure) so a failed
compose never yields a ghost open nudge.

**M-4 — Concurrent creates for one subject produce duplicate assistant turns
(MEDIUM).** Dedup is a row check before an `await` of up to 60 s
(`runComposer` timeout). Repro: slow composer (4 s), 3 concurrent
`POST /nudges` for `commitment-99` → 1 row, **3 assistant turns** (9, 10,
11); the first response reports `turn_id: 9`, the row ends with
`turn_id: 11`. Realistic trigger: the watchdog's 60 s tick re-POSTs while a
60 s composer is still running; finish-line/unblocker retries. Fix: an
in-process `Map<subjectKey, Promise<NudgeRow>>` of in-flight materializations
(return the same promise), plus `UPDATE nudges SET turn_id=? WHERE id=? AND
turn_id IS NULL` as the DB-level guard.

### Should-fix

**S-1 — Machine footer renders as visible text in every nudge message.**
NUDGE.md assumed the cockpit hides HTML comments; react-markdown without
rehype-raw escapes them, so Kevin sees
`<!-- jarvis-nudge {"nudge_id":9,…"$KEVIN_REPLY"}}} →` under every nudge in
the mini-chat and the thread view (Playwright DOM text check = true;
screenshot `/tmp/nudge-2-open.png`). Directly undercuts "message is JARVIS
speaking, not a bare link/system dump". Fix: strip `<!--\s*jarvis-nudge[\s\S]*?-->`
in `MarkdownText` (or in ThreadPane's assistant-turn render) before passing
to react-markdown; keep it in the DB.

**S-2 — `parseClaudeJson` falls through to raw stdout on malformed JSON.**
Spec: malformed JSON → deterministic fallback. Code: `JSON.parse` fails →
`cleanString(trimmed)` → the raw stdout becomes the visible message. Repro:
a composer emitting stream-json lines produced a nudge whose body was three
JSONL lines. Any CLI diagnostic printed to stdout would do the same. Fix:
return `null` on parse failure (and on non-string `result`).

**S-3 — Composer runs with the full default tool + MCP surface.** The prompt
embeds untrusted worker text (hopper `question`, watchdog `detail`); the
composition needs no tools. The probe was refused, but the guard is
prompt-level only. Add `--tools ""` (and `--strict-mcp-config --mcp-config
'{"mcpServers":{}}'` or `--restricted`) to the composer argv; also validate
`nudge_model` doesn't start with `-` before splicing it into argv.

### Low / noted

- Watchdog commitment producer: 8 s client timeout vs a composer that can
  take up to 60 s → logs "nudge skipped/failed" while the server still
  creates the nudge; it also fires its own `notify('error', …)` AND lets
  `createNudge` create a second bell (no `notification_id` passed) → two
  bells per breached commitment. Pass the notification id, or drop the
  watchdog-side bell for breached commitments.
- `POST /nudges/delivered` with `{"ids":[]}` marks EVERY pending nudge
  delivered (`ids?.length` falsy → "all"). The UI never sends an empty
  array, but the route should treat `[]` as a no-op.
- The nudge turn's `model` metadata is stamped `claude-sonnet-5` even when the
  deterministic fallback authored it.
- Sonner toasts are also `bottom-right`; a persistent error toast can sit on
  top of the bubble. Consider `position="bottom-left"` for the Toaster or
  lifting the bubble above the toast stack.
- `context` from `POST /nudges` is stored/echoed unbounded (SSE + GET); an
  oversized context makes the argv exceed `MAX_ARG_STRLEN` → composer
  `E2BIG` → fallback (graceful, but cap `context_json` at ~16 KB).
- UI worktree `node_modules` is a symlink to the live checkout's; builds there
  write `node_modules/.nitro|.cache` shared with the live cockpit (same
  gremlin class as the root-owned cache notes). Harmless for the served
  `.output/`, just don't build both at once.

### Verdict

BLOCKED on M-1..M-4. M-1 + M-2 together mean the headline promise of the tree
("Kevin reads why, answers inline, JARVIS applies it and the bubble clears")
does not happen today; M-3 is a time bomb that silently kills nudge creation
after the first quiet fortnight. The UI branch is otherwise sound and needs
only S-1 (footer strip) and optionally a per-nudge Resolve control. Scratch
artifacts: `/tmp/nudge-review.db`, `/tmp/nudge-review-server.log`,
`/tmp/nudge-{1,2,3,4}-*.png`, `/tmp/fake-turn-*.stdin`.

## 2026-09-17 · JARVIS nudge review remediation (Claude B, backend) — M-1..M-4 + S-2/S-3 resolved

Backend fixes for review #228, done in worktree `hopper/jarvis-nudge`
(`darwin-assistant`). UI-only items (S-1 footer strip, manual Resolve control)
belong to the UI worker and were not touched here. Build: `npm run build` (tsc)
clean, 0 errors. Verification: `scripts/nudge-remediate-verify.mjs` (scratch
`/tmp` DB, fake `claude` bins, canary `ANTHROPIC_API_KEY`) — 18/18 assertions
pass; plus a separate argv-dump probe for S-3.

- **M-1 (reply loop blind on resume) — DONE.** New server-owned per-turn block.
  `buildNudgeReplyContext(externalId)` in `src/nudges.ts` renders a
  `<jarvis_nudges>` block from `listNudges('open')` (id, source, subject_ref,
  status, created_at, summary, why, answer_route; newest first) plus the
  NUDGE.md §Reply Loop steps (match latest → call answer_route with `$KEVIN_REPLY`
  → PATCH `/api/v1/nudges/<id>` resolved → confirm; ambiguous → one clarifying
  Q). Spliced in `src/agent.ts` `runConversationTurn` into `perTurnContextPrefix`
  (same slot as `quickChatContextBlock`), gated on
  `conv.external_id === NUDGE_THREAD_EXTERNAL_ID`. Because it is rebuilt from the
  DB every turn and lives in the prompt prefix, it is identical on
  transcript-replay and on `--resume`. Footer left in the DB for audit. Verified:
  block names `tree-abc/node-77`, its answer_route path, and the resolve step;
  empty string for non-nudge threads.
- **M-2 (answering source never resolves nudge) — DONE.** Exported
  `resolveNudgeBySubject(source, subject_ref)` from `src/nudges.ts` (resolves the
  open row for that subject via `markNudgeResolved`, emits `updated`). Called from
  `answerHopperNode()` and `retryHopperNode()` in `src/hopper-engine.ts` with
  `blocked_question` + `${node.tree_id}/node-${id}` — the exact subject_ref the
  producer (`createBlockedQuestionNudge`) writes. Verified: resolve drops open
  count and a re-block for the same subject now creates a FRESH nudge instead of
  deduping to the stale row. NOTE: the finish-line SHORTFALL, smart-unblocker,
  and watchdog commitment producers have no wired call sites or answer routes in
  this codebase yet (only the `createXNudge` helpers exist, unused) — there is no
  terminal/answered path to hook, so nothing to change there; `resolveNudgeBySubject`
  is ready for them when they land.
- **M-3 (auto-hide archives nudge thread → 500 + ghost rows) — DONE.** (a) Added
  exported `PROTECTED_THREAD_EXTERNAL_IDS` set in `src/conversation-db.ts`;
  `autoHideStaleThreads()` SELECT now excludes it
  (`external_id IS NULL OR external_id NOT IN (...)`), and `api-v1.ts`
  `PROTECTED_THREAD_IDS` now aliases that shared set so routes and sweep can't
  drift. (b) `ensureNudgeThread()` reactivates an archived nudge thread
  (`setConversationStatus(id,'active')`) before `getOrCreateConversation`, killing
  the `UNIQUE constraint failed` 500. (c) `createNudge()` materializes inside the
  same try as the insert and deletes the just-inserted row on failure, so a failed
  compose never leaves a ghost open nudge with `turn_id NULL`. Verified: nudge
  thread stays active through a 14d sweep while an unrelated 15d-idle thread is
  archived; POST /nudges succeeds and reactivates even after the thread is forced
  archived.
- **M-4 (concurrent creates → duplicate turns) — DONE.** In-process
  `Map<subjectKey, Promise<NudgeRow>>` (`materializeOnce`) coalesces concurrent
  materializations for one subject, PLUS DB guard
  `UPDATE nudges SET turn_id=? WHERE id=? AND turn_id IS NULL` — a late writer
  gets `changes===0` and deletes its orphan turn. Verified: 3 concurrent POSTs vs
  a 900ms fake composer → exactly 1 new assistant turn, all 3 callers report the
  same turn_id, 1 open row.
- **S-2 (parseClaudeJson leaked raw stdout) — DONE.** `parseClaudeJson` now
  returns `null` on `JSON.parse` failure and on non-string/`is_error` result, so
  the caller uses the deterministic fallback. Verified: garbage stdout → nudge
  body is the fallback text, raw junk absent from the message.
- **S-3 (composer tool/MCP surface) — DONE.** Composer argv now appends
  `--tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}'` (all three
  flags confirmed present in this CLI version via `claude --help`), and a
  `nudge_model` starting with `-` is sanitized to `claude-sonnet-5` before
  splicing. Verified via argv dump; also re-confirmed `ANTHROPIC_API_KEY` is
  absent from the child env (canary test).
- **Low/noted:** added the one-line no-op guard for `POST /nudges/delivered` with
  an explicitly-empty `ids:[]` (previously fell through to "mark all pending").
  Other low/noted items (double-bell watchdog, fallback model stamp, context cap,
  toast position) left as-is.

Verification script kept at `darwin-assistant/scripts/nudge-remediate-verify.mjs`
(scratch DB only; never opens the live DB). No API keys, no SDK, no service
restart, no deploy.
