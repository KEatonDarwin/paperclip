# Companion persona + tool-set scoping — recon (node #1381)

Repo `/home/kevin/paperclip`, worktree `companion-thread`, branch
`jarvis/companion-thread` (synced to `28282ff8f`, which already carries #275's
thread-kind recon + #1375/#1376's `companion-chat.ts` module — see
`outbox/companion/COMPANION-THREAD-RECON.md`). Read-only recon only, no code
changes.

`companion-chat.ts` already gives this work a ready-made recognizer:
`companionIdFromThread(externalId)` (`companion-chat.ts:89-93`) returns the
companion id or `null` for every other thread, exactly the shape both
insertion points below need. Nothing wires it into `agent.ts` or the tool
handlers yet — confirmed with `grep -n companion agent.ts prompt.ts
handlers/api-v1.ts tools/index.ts` → no hits.

## (a) Persona / system-prompt assembly

Two layers, both per-turn, both already parameterized by a single
`MemoryProfile` argument — the existing seam to extend.

- **The system prompt text itself**: `buildSystemPrompt(profile, opts)`,
  `darwin-assistant/src/prompt.ts:71-?` (the literal "You are JARVIS..." /
  "Who Kevin Is" / tools-intro text Kevin's top-level system prompt is built
  from). It takes a `MemoryProfile` (`'full' | 'worker'`, `prompt.ts:11`) and
  calls `loadMemoryBlock(undefined, profile)` (`prompt.ts:28-69`) to decide
  which memory block to splice in — `'worker'` gets `worker-core.md` instead
  of the full `memory.md`. **The whole persona body between the time block
  and `${memoryBlock}` (`prompt.ts:86-95`+) is currently a single hard-coded
  string, not profile-conditional** — only the memory block varies by
  profile today.
- **The profile decision, keyed on thread**: `memoryProfileForThread(externalId)`,
  `prompt.ts:16-21`:
  ```ts
  export function memoryProfileForThread(externalId: string | null | undefined): MemoryProfile {
    if (!externalId) return 'full';
    return externalId.startsWith('cockpit:hopper-node-') || externalId.startsWith('cockpit:unblocker-')
      ? 'worker'
      : 'full';
  }
  ```
  This is the ONE place that maps thread prefix → persona variant. It is
  called once per turn at `agent.ts:1583` (`const memoryProfile =
  memoryProfileForThread(conv.external_id);`) and the result flows into both
  prompt builders:
  - `buildInitialPrompt(userMessage, memoryProfile)` — `agent.ts:611-613`,
    calls `buildSystemPrompt(memoryProfile)` at `agent.ts:612`. Used on a
    thread's very first turn (no session yet).
  - `buildContinuationPrompt(...)` — `agent.ts:776-` (system prompt line at
    `agent.ts:790`: `buildSystemPrompt(memoryProfile, { omitMemory: true })`).
    Used whenever the transcript is replayed (session drop, adapter/account
    switch, context-overflow retry — see the four call sites in
    `runConversationTurn`, `agent.ts:1639,1658,1722,1742`-ish).
  - The resumed-session path (live `claude --resume`) does NOT re-send a
    system prompt at all — it relies on the one sent at session start plus
    the per-turn `<memory_refresh>` block (`agent.ts:1584-1586`). **Important
    for a hard persona swap**: if a companion thread's session is ever
    resumed rather than replayed, the original (e.g. default JARVIS) system
    prompt from session creation is what's still "live" in the CLI process,
    not whatever `buildSystemPrompt` would return today. This only matters if
    Kevin ever flips a thread's kind after creation — a freshly-created
    companion thread's first turn always goes through `buildInitialPrompt`.

### Cleanest insertion for a trimmed companion persona + goal-12 orientation

1. Widen `MemoryProfile` to `'full' | 'worker' | 'companion'` (`prompt.ts:11`).
2. In `memoryProfileForThread` (`prompt.ts:16-21`), add a branch using the
   existing recognizer:
   ```ts
   if (companionIdFromThread(externalId)) return 'companion';
   ```
   (import `companionIdFromThread` from `./companion-chat.js`) — ahead of or
   alongside the worker-prefix check, same shape.
3. In `buildSystemPrompt` (`prompt.ts:71`), branch near the top on
   `profile === 'companion'`: return a distinct, trimmed persona string
   (her own voice/scope + a goal-12 orientation block) instead of falling
   through to the "You are JARVIS... Who Kevin Is..." body. Keep
   `loadMemoryBlock` out of the companion path entirely (new `profile ===
   'companion'` branch in `loadMemoryBlock`, `prompt.ts:28`, mirroring the
   existing `'worker'` branch at `prompt.ts:29-50`) rather than loading
   Kevin's `memory.md` or `worker-core.md` — neither is appropriate content
   for her. Compose the goal-12 orientation however that node wants (static
   string, or a `buildCompanionThreadContext()`-style per-turn fetch wired in
   alongside the other `*ContextBlock`s at `agent.ts:1570`, same pattern as
   `buildMikeThreadContext` — see COMPANION-THREAD-RECON.md (a) for that
   precedent). Either way, the branch point is `prompt.ts:71`, not `agent.ts`.
4. No change needed to the two call sites (`agent.ts:612`, `agent.ts:790`) —
   they already just forward whatever `memoryProfileForThread` returns.

## (b) Tool-set / allow-list assembly

Two parallel paths (native MCP + text-block fallback), each with its own
**list** point and **dispatch** point. None of the four are gated by thread
kind today — all four are unconditional / global.

- **Native listing** — `GET /internal/tools`, `handlers/api-v1.ts:6624-6632`.
  Called by `persona-tools-server.ts` (`server.setRequestHandler(ListToolsRequestSchema, ...)`,
  lines 52-68) with **no context at all** — the loopback call
  (`persona-tools-server.ts:54`) sends no conversation/externalId, and the
  handler just returns `ALL_TOOLS.map(...)` unconditionally. This manifest is
  identical for every thread/conversation.
- **Native dispatch** — `POST /internal/tool-exec`, `handlers/api-v1.ts:6643-6682`.
  This one DOES carry context: `body.context` is a full
  `ToolExecutionContext` (`{conversationId, externalId, sourceMessageId,
  sourceTimestamp, originalText}`, built at `agent.ts:1404-1410` and shipped
  through the MCP child's `JARVIS_TOOL_CONTEXT` env var,
  `agent.ts:1121-1125`). The handler validates `conversationId` exists
  (`api-v1.ts:6656-6659`) and admin-scope (`6645-6648`), then unconditionally
  does `TOOL_MAP.get(name)` and executes — `context.externalId` is sitting
  right there unused for any kind-based gating.
- **Text-protocol listing** — `buildToolsBlock()`, `agent.ts:593-608`. Also
  unconditional: `ALL_TOOLS.map(...)` with no parameters, called from
  `buildInitialPrompt` (`agent.ts:612`) with nothing thread-specific passed
  in. (`buildContinuationPrompt` does NOT re-send the tools block — the tool
  list is only sent once, same as the system prompt, and relies on
  `--resume`/transcript memory afterward.)
- **Text-protocol dispatch** — the `<tool_call>` parse-and-execute loop inside
  `runConversationTurn`, `agent.ts:1834-1851`:
  ```ts
  const tool = TOOL_MAP.get(toolCall.name);
  ...
  toolResult = tool
    ? await withToolExecutionContext(toolContext, () => tool.execute(toolCall.arguments, toolContext))
    : { error: `Unknown tool: ${toolCall.name}` };
  ```
  `toolContext` (same shape, same construction site `agent.ts:1404-1410`) and
  `conv` (full `ConversationRow`, so `conv.external_id` too) are both already
  in scope at this exact line — this is the direct text-protocol sibling of
  `/internal/tool-exec`.

### Cleanest insertion to restrict kind=companion to conversation + the bridge-tool seam only

The four points pair up into two chokepoints per path (list + dispatch), and
both paths need the same allow-list, so the cleanest shape is **one shared
predicate**, consulted at all four:

1. Add one function, e.g. `allowedToolsForThread(externalId): Set<string> |
   null` (new file or alongside `companionIdFromThread` in
   `companion-chat.ts`) — returns `null` for "no restriction" (every
   non-companion thread, byte-identical behavior to today) or, for a
   companion thread, the fixed allow-list (today: empty, or just the bridge
   tool's name once it exists — e.g. `new Set(['send_to_kevin'])`).
2. **Native list** (`api-v1.ts:6624`): have `persona-tools-server.ts`'s list
   handler forward `toolContext` (it already has it in scope at module load,
   `persona-tools-server.ts:29-35`) as a query param or header on the
   `/internal/tools` call (`persona-tools-server.ts:54`), then filter
   `ALL_TOOLS` through `allowedToolsForThread(externalId)` server-side before
   returning the manifest. Without this, a companion session would still see
   every tool NAME in its native tool list even if dispatch later refuses
   them — worth closing both ends, not just dispatch, so the model isn't
   advertised tools it can't use.
3. **Native dispatch** (`api-v1.ts:6643`, right after the existing
   `conversationId` validation at line 6659): if `allowedToolsForThread(context.externalId)`
   is non-null and doesn't contain `name`, return the same
   `{ result: { error: \`Unknown tool: ${name}\` } }` shape the "tool not
   found" branch already uses (line 6665) — i.e. a restricted tool simply
   doesn't exist from the companion thread's point of view, no special error
   shape to design.
4. **Text-protocol list** (`agent.ts:593` `buildToolsBlock()`): add an
   optional `externalId` param, filter `ALL_TOOLS` the same way, and pass
   `conv.external_id` in from `buildInitialPrompt`'s caller
   (`agent.ts:612`, which already receives `memoryProfile` — add
   `externalId` alongside it, threaded from `runConversationTurn`'s
   `stdinContent` build at `agent.ts:1586`).
5. **Text-protocol dispatch** (`agent.ts:1834`): same one-line guard as step
   3, using `conv.external_id` (already in scope) against the same
   `allowedToolsForThread` predicate, before the existing `TOOL_MAP.get(...)`
   result is used — fall through to the existing `Unknown tool:` error
   object (line 1848) when disallowed.

This keeps the allow-list logic in exactly one function consulted at both
layer's list+dispatch pairs, matches the existing "no restriction = `null`/
no-op, byte-identical for every other thread" pattern already used elsewhere
in this codebase (e.g. `memoryProfileForThread`, `nightShiftContextBlock`,
`buildMikeThreadContext` all return a neutral default for non-matching
threads), and needs no new table or schema — `companion_thread_kind`
(`companion-chat.ts:50-58`) could hold the allow-list as a JSON column later
if it ever needs to be more than a hard-coded constant, but a hard-coded
`Set` is the right size for "conversation + one bridge tool" today.

## Open items for whoever builds this next (not this node's job)

- The bridge tool itself (`send_to_kevin` or similar) doesn't exist yet in
  `darwin-assistant/src/tools/index.ts` — the allow-list above is written
  against its *future* name; confirm the actual tool name once it's built
  before wiring the `Set`.
- Companion's `buildSystemPrompt` branch (persona text + goal-12 orientation
  content) is unwritten — this recon only locates where it plugs in, not
  what it says.
- If a companion thread's session is ever resumed after a kind/persona
  change, the live `claude --resume` process still has the OLD system prompt
  in its own context — see the note under (a). Not relevant to a
  freshly-created companion thread, but worth knowing if this ever needs to
  retrofit an existing non-companion thread into the companion kind.
