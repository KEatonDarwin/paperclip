# JARVIS Nudge Contract

This contract defines the "global JARVIS nudge" layer Kevin asked for on
2026-09-14: a noticeable bottom-right speech bubble that opens into one JARVIS
thread where JARVIS explains, in plain first person, what needs Kevin and why it
could not clear the item itself.

The notification bell remains the low-friction FYI surface. Nudges are the
"Kevin, I genuinely need you" surface.

## Goals

- Make needs-Kevin items noticeable without dumping Kevin into the source thread.
- Keep one canonical nudge conversation: `cockpit:jarvis-nudges`.
- Let Kevin answer directly in that nudge thread.
- Preserve a machine-readable route so the replying JARVIS can apply Kevin's
  answer to the original surface and resolve the nudge.
- Never lose a nudge because a model call failed.

## Non-Goals

- Do not replace existing `notifications`.
- Do not create one thread per blocked node.
- Do not send Slack/email/external messages.
- Do not call model provider APIs or SDKs. Composition uses the local `claude`
  CLI only, on subscription auth.

## Existing Patterns To Reuse

- Store + SSE shape: `src/notifications.ts` and `src/thread-todos.ts`.
- Global SSE event registration: `src/sse-bus.ts` and the `/events` `FORWARD`
  set in `src/handlers/api-v1.ts`.
- HTTP route style: notification routes in `src/handlers/api-v1.ts`.
- Conversation insertion: `getOrCreateConversation()` + `addTurn()` from
  `src/conversation-db.ts`.
- Local Claude one-shot family: `src/briefing.ts` `runDebrief()` pattern:
  spawn the local `claude` binary, scrub `ANTHROPIC_API_KEY`, set a timeout,
  parse a bounded result, and fall back deterministically on failure.

## Tiers

The notification layer gets one additional semantic tier:

- `info`: unchanged bell/toast behavior. Use for FYI status, completions, and
  low-friction "you may want to know" events.
- `needs_kevin`: create the normal bell notification AND create a nudge.

`needs_kevin` is for cases where JARVIS cannot safely proceed without Kevin's
input, for example:

- `blocked_question` hopper nodes.
- Smart-unblocker escalation after its one autonomous recovery pass.
- Finish-line audit shortfalls that require Kevin to scope or accept a
  continuation.
- Watchdog overdue commitments that need Kevin's answer or attention.

Implementation note: `needs_kevin` does not have to become a new
`notifications.severity` value. It may be represented as `severity: "warning"`
or `"error"` plus `meta.kind: "needs_kevin"` so the existing severity CHECK
constraint stays stable. The important contract is: every `needs_kevin` event
also writes a row to `nudges`.

## Data Model

Add a SQLite table in `jarvis.db`:

```sql
CREATE TABLE IF NOT EXISTS nudges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL CHECK (
    source IN (
      'blocked_question',
      'unblocker',
      'finishline_shortfall',
      'commitment',
      'manual'
    )
  ),
  subject_ref  TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'delivered', 'resolved')
  ),
  turn_id      INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_nudges_open_subject
  ON nudges(source, subject_ref)
  WHERE status != 'resolved';

CREATE INDEX IF NOT EXISTS idx_nudges_status_created
  ON nudges(status, created_at DESC, id DESC);
```

Column meanings:

- `source`: the producer class.
- `subject_ref`: stable producer-owned id, such as `tree-4f8bb8b7/node-225`
  or `commitment-38`.
- `context_json`: compact machine context for composing/applying the nudge.
  Include the human summary, source URL/route, and exact answer route.
- `status`:
  - `pending`: created and not yet opened in the bubble.
  - `delivered`: Kevin opened the bubble; it still needs resolution.
  - `resolved`: Kevin's answer was applied or the source no longer needs him.
- `turn_id`: the assistant turn inserted into `cockpit:jarvis-nudges`.
- `resolved_at`: set only once, when status becomes `resolved`.

Do not delete resolved rows by default. They are an audit trail for why JARVIS
interrupted Kevin.

## The One Nudge Thread

The backend owns one idempotently-created conversation:

- `external_id`: `cockpit:jarvis-nudges`
- label/title: `JARVIS Nudges`
- visual label may include the bell icon in the cockpit, but do not rely on the
  emoji as data.

Creation rules:

- Use `getOrCreateConversation('cockpit:jarvis-nudges')`.
- If a title/label field exists for cockpit threads, set it once if empty.
- Put the thread in a protected group or mark it protected so retention/archive
  jobs never hide it. At minimum, add it to the same protected-thread mechanism
  that already protects notification/check-in system threads.
- All nudge assistant turns go into this one thread.

## HTTP API

All routes are bearer-authenticated under `/api/v1`.

### `GET /nudges`

Query params:

- `status`: optional `pending|delivered|resolved|open`; `open` means
  `pending OR delivered`.
- `limit`: optional, default `100`, max `500`.

Response:

```json
{
  "nudges": [],
  "open": 0,
  "pending": 0
}
```

### `POST /nudges`

Creates or returns the open nudge for a `(source, subject_ref)` pair.

Request:

```json
{
  "source": "blocked_question",
  "subject_ref": "tree-4f8bb8b7/node-225",
  "context": {
    "summary": "Node #225 needs Kevin to choose ...",
    "why_jarvis_could_not_clear": "The worker needs a product decision.",
    "answer_route": {
      "method": "POST",
      "path": "/api/v1/hopper-nodes/225/answer",
      "body_template": { "answer": "$KEVIN_REPLY" }
    },
    "source_link": "/spawn-tree/tree-4f8bb8b7"
  }
}
```

Behavior:

1. Validate `source`, `subject_ref`, and `context`.
2. If an open nudge already exists for the same `(source, subject_ref)`, return
   it. Do not create duplicate turns.
3. Ensure the nudge thread exists.
4. Compose a first-person JARVIS message.
5. Append a compact machine-readable footer.
6. Insert the message as an `assistant` turn in `cockpit:jarvis-nudges` with
   `addTurn()`.
7. Save the created turn id in `nudges.turn_id`.
8. Emit `sseBus.emit('sse', { type: 'nudge', action: 'created', nudge })`.
9. Also create the normal bell notification for compatibility, unless the
   caller already supplied a notification id in `context`.

Response:

```json
{
  "nudge": {
    "id": 123,
    "source": "blocked_question",
    "subject_ref": "tree-4f8bb8b7/node-225",
    "status": "pending",
    "turn_id": 9876,
    "created_at": "2026-09-15 08:30:00",
    "resolved_at": null
  },
  "thread_external_id": "cockpit:jarvis-nudges"
}
```

### `POST /nudges/:id/deliver`

Called by the cockpit when Kevin opens the bubble or docked mini-chat.

Behavior:

- If status is `pending`, set it to `delivered`.
- Emit `type: 'nudge', action: 'updated'`.
- If status is already `delivered` or `resolved`, return the row unchanged.

"Delivered" means Kevin has seen the nudge surface. It does not mean JARVIS has
the answer.

### `PATCH /nudges/:id`

Allowed fields:

```json
{ "status": "resolved" }
```

Behavior:

- `resolved` sets `resolved_at = datetime('now')`.
- Emit `type: 'nudge', action: 'updated'`.
- Do not allow callers to move `resolved` back to open states via this route.
  If a producer still needs Kevin later, it creates a new nudge with a fresh
  `subject_ref` or after explicitly reopening in code.

### `DELETE /nudges/:id`

Optional admin cleanup route. Prefer `resolved` for normal use.

## Message Composition

The composed message must read like JARVIS, not like a system alert. It should
be short and first person:

- What needs Kevin.
- Why JARVIS could not clear it itself.
- What Kevin can answer right here.
- The source context in plain English.

Example visible text:

```md
Kevin, I need your call on the Foundry run-slot tree.

The finish-line audit found that GO still starts apps without a visible slot
owner, and I cannot safely decide whether to keep the old fire-and-forget path
as a fallback or remove it entirely.

Reply here with one of these: "keep fallback" or "remove fallback". I'll apply
it back to the tree and resolve this nudge.
```

### Local Claude CLI Composer

Use the local CLI on subscription auth. Do not import provider SDKs. Do not use
API keys.

Required behavior:

- Binary: `process.env.NUDGE_CLAUDE_BIN || process.env.CLAUDE_BIN || 'claude'`.
- Model: `process.env.NUDGE_MODEL || settingsKV('nudge_model') ||
  'claude-sonnet-5'`.
- Invocation: local `claude` CLI one-shot, following the repository's
  `briefing.ts` pattern. `claude -p <prompt> --output-format json` is acceptable
  if that is the current helper style; `claude --print - --output-format
  stream-json` is also acceptable if implemented as a stdin-fed helper. Either
  way, it must be a spawned CLI process.
- Environment: copy `process.env`, then `delete env.ANTHROPIC_API_KEY` before
  spawning.
- Timeout: `60_000` ms.
- Max output buffer: at least `1 MiB`; cap stored text to a sane limit.
- Failure handling: if the process exits non-zero, times out, emits malformed
  JSON, or returns empty text, use the deterministic fallback below.

The composer prompt may use the context JSON, but it must not be the only copy
of the routing metadata. The routing metadata belongs in the footer.

### Deterministic Fallback

Fallback must be implemented in plain code and must never throw. It should
produce the same semantic shape:

```md
Kevin, I need your input on {summary_or_subject}.

I could not clear this myself because {why_jarvis_could_not_clear_or_default}.

Reply here with the answer you want me to apply. I'll send it back to the
original workflow and mark this nudge resolved.
```

Default `why` if missing:

```txt
the source workflow marked this as needing your decision, and guessing would
change the requested scope or behavior.
```

## Machine-Readable Footer

Every nudge assistant turn must end with a compact footer that the reply-loop
JARVIS can recover from raw turn content.

Use an HTML comment so the cockpit can hide it visually while the raw DB turn
still contains it:

```md
<!-- jarvis-nudge
{"nudge_id":123,"source":"blocked_question","subject_ref":"tree-4f8bb8b7/node-225","answer_route":{"method":"POST","path":"/api/v1/hopper-nodes/225/answer","body_template":{"answer":"$KEVIN_REPLY"}}}
-->
```

Footer rules:

- Keep it valid single-object JSON after the marker line.
- Include `nudge_id`, `source`, `subject_ref`, and `answer_route`.
- `answer_route.method` is an internal JARVIS API route, usually `POST`.
- `answer_route.path` is the exact path the replying JARVIS should call.
- `answer_route.body_template` tells the replying JARVIS where Kevin's natural
  reply should be placed.
- Never put secrets or bearer tokens in the footer.

## Reply Loop

Kevin replying in `cockpit:jarvis-nudges` is a normal JARVIS turn. No special
chat runtime is required for v0.

The first-turn injection for that thread should include an instruction like:

```txt
You are in the global JARVIS Nudges thread. When Kevin replies to an unresolved
nudge, inspect the latest unresolved nudge footer, apply Kevin's answer to the
footer's answer_route, then PATCH /nudges/:id status=resolved. If the reply is
ambiguous, ask one short clarifying question in this same thread.
```

Resolution flow:

1. Read the latest unresolved nudge(s), newest first.
2. Match Kevin's reply to the most recent one unless he references another
   nudge by subject.
3. Call the footer's answer route with Kevin's reply inserted into the template.
4. If the answer route succeeds, `PATCH /nudges/:id {"status":"resolved"}`.
5. Add a short assistant confirmation in the nudge thread.
6. If applying fails, create or update a normal error notification and leave the
   nudge `delivered` so the bubble remains visible but does not duplicate.

Examples of answer routes:

- Hopper blocked question:
  - `POST /api/v1/hopper-nodes/:id/answer`
  - body `{ "answer": "$KEVIN_REPLY" }`
- Finish-line shortfall:
  - `POST /api/v1/hopper-trees/:id/finishline/answer`
  - body `{ "answer": "$KEVIN_REPLY" }`
- Commitment watchdog:
  - `POST /api/v1/watch-commitments/:id/answer`
  - body `{ "answer": "$KEVIN_REPLY" }`

If a producer does not yet have an answer route, it may still create a manual
nudge, but the footer must say:

```json
{"answer_route":{"method":"manual","path":"","body_template":{"answer":"$KEVIN_REPLY"}}}
```

In that case JARVIS confirms receipt, leaves the source untouched, and either
resolves the nudge manually or creates a follow-up implementation task.

## SSE

Add a new global event type:

```ts
export interface NudgeEvent {
  type: 'nudge';
  action: 'created' | 'updated' | 'deleted';
  nudge: NudgeRow;
}
```

Add it to:

- `SSEEvent` union in `src/sse-bus.ts`.
- `/events` `FORWARD` set in `src/handlers/api-v1.ts`.
- Cockpit SSE worker event allowlist.

The event is global, not conversation-scoped, like `notification` and
`hopper_item`.

## Bubble Semantics

The cockpit renders a bottom-right speech bubble on every page.

States:

- Hidden: no open nudges (`pending + delivered == 0`).
- Pulsing: at least one `pending` nudge exists.
- Quiet-visible: no pending nudges, but at least one `delivered` nudge exists.
- Resolved: when open count reaches zero, hide the bubble.

Opening the bubble:

1. Opens a docked mini-chat for `cockpit:jarvis-nudges`.
2. Calls `POST /nudges/:id/deliver` for every currently `pending` nudge.
3. Stops the pulse for those rows.
4. Leaves unresolved delivered nudges visible in the mini-chat until resolved.

The bubble should show a count of open nudges. The count is not the old bell
notification unread count.

The mini-chat should be the nudge thread itself, not a summary or link list.
Kevin's reply there posts a normal user turn to `cockpit:jarvis-nudges`.

## Producers

Initial producers:

- Hopper `blocked_question`: create `needs_kevin` notification and nudge.
- Smart unblocker escalation: nudge after the one allowed autonomous unblocker
  pass fails or cannot act.
- Finish-line audit shortfall: nudge only when the audit cannot plant a
  continuation tree under the depth cap or needs Kevin's product/scope call.
- Watchdog overdue commitment: nudge instead of only bell when Kevin's answer is
  the next required action.
- Manual route/tool: allow JARVIS to create a nudge for exceptional cases.

Producer rule: if JARVIS can safely decide and act under the autonomy bar, do
that instead of nudging Kevin. Nudge only when the source genuinely needs him.

## Acceptance Checks

Backend:

- `POST /nudges` creates one row, one assistant turn in
  `cockpit:jarvis-nudges`, one `nudge` SSE event, and a normal bell
  notification.
- Repeating the same `(source, subject_ref)` while open returns the existing row
  and does not create a duplicate assistant turn.
- If the local Claude CLI fails, `POST /nudges` still succeeds with the
  deterministic fallback text.
- `POST /nudges/:id/deliver` changes `pending -> delivered`.
- `PATCH /nudges/:id {"status":"resolved"}` sets `resolved_at`.
- No code imports `@anthropic-ai/sdk` or reads `ANTHROPIC_API_KEY` for nudge
  composition.

Frontend:

- Pending nudges make the bottom-right bubble pulse.
- Opening the bubble marks pending rows delivered and stops the pulse.
- Delivered unresolved nudges keep the bubble quietly visible.
- Replying in the mini-chat appends to `cockpit:jarvis-nudges`.
- The old bell dropdown still works for ordinary info/success/warning/error
  notifications.

Integration:

- A hopper `blocked_question` can be answered from the nudge thread, routed back
  to the blocked node's answer endpoint, and resolved without Kevin opening the
  original tree page.
