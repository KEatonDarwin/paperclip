# Finish-Line Gate Design

Tree: `tree-6097474e`  
Branch/worktree: `hopper/finish-line-gate` at `/home/kevin/paperclip-worktrees/finish-line`

## Problem

The Hopper engine can mark a tree complete when every planned node reports `done`, even when the plan intentionally narrowed Kevin's original ask and deferred meaningful scope into a document that nothing consumes. That happened on `tree-ba03b6c0`: Kevin asked for a full standalone MCP server, the tree completed the groundwork package/install/proof/migration-plan scope, and the deferred half was only in an outbox doc. The tree was technically green, but the original ask had not been structurally reconciled.

The finish-line gate makes "green but short of the ask" impossible to miss:

- Store the original ask and any explicit deferred scope on the tree.
- When a tree reaches all-done, append a server-owned audit node before final completion.
- The audit node compares node results against the original ask and deferred scope.
- If the work is complete, it lets the tree finish with a `FULL` notification.
- If there is a shortfall, the audit worker plants and agrees a continuation tree covering the gaps, then lets the original tree finish with a `SHORTFALL` notification that names the continuation.

## Current Path Map

Relevant files:

- `darwin-assistant/src/hopper-engine.ts`
- `darwin-assistant/src/handlers/api-v1.ts`
- `darwin-assistant/src/agent.ts`
- `darwin-assistant/src/prompt.ts`

### Schema and Dispatch Shape

Current DDL lives in `hopper-engine.ts:142-172`.

- `hopper_trees` has `id`, `topic`, `origin_thread_ext`, `status`, timestamps.
- `hopper_nodes` has `tree_id`, `parent_id`, `title`, `spec`, `status`, `depends_on`, result and worker fields.
- Additive node columns (`adapter`, `model`, `foundry_auto_retries`) are migrated with `ALTER TABLE` at `hopper-engine.ts:178-184`.

Dispatchable nodes are only pending leaves in active trees:

```sql
SELECT n.* FROM hopper_nodes n
JOIN hopper_trees t ON t.id = n.tree_id AND t.status = 'active'
WHERE n.status = 'pending'
  AND NOT EXISTS (SELECT 1 FROM hopper_nodes c WHERE c.parent_id = n.id)
ORDER BY n.priority DESC, n.id ASC
```

This is the parent-id deadlock rule: auto-appended finish-line nodes must be flat nodes with `parent_id = NULL`. Use `depends_on` only.

### Plant Path

`POST /api/v1/hopper-trees` is in `api-v1.ts:1828-1838`.

Current request:

```ts
{ topic, origin_thread, nodes }
```

It validates topic and nodes, then calls:

```ts
createHopperTree(topic, origin, nodes)
```

`createHopperTree` is in `hopper-engine.ts:377-410`.

Current behavior:

- Insert `hopper_trees`.
- Insert every node as `parent_id = NULL`.
- Ignore `parent_index` with a warning.
- Convert `depends_on_indexes` to real node ids in a second pass.
- Emit created node SSE events.

### Agree Path

`POST /api/v1/hopper-trees/:treeId/agree` is in `api-v1.ts:1852-1860`.

It calls `agreeHopperTree(treeId)`.

`agreeHopperTree` is in `hopper-engine.ts:428-440`.

Current behavior:

- Load tree.
- Call `sanitizeInitialDagParentIds(treeId)`.
- Set tree `status = 'active'`.
- Set draft nodes to `pending`.
- Emit updates.
- Queue `dispatchTick('tree_agreed')`.

`sanitizeInitialDagParentIds` is the existing hardening for the earlier parent-id deadlock: if an initial DAG tree has stale `parent_id` values before any split node exists, they are nulled before dispatch.

### Finish and Bubble-Up Path

`POST /api/v1/hopper-nodes/:id/finish` is in `api-v1.ts:1862-1910`.

Accepted outcomes:

- `done`
- `split`
- `blocked_question`
- `blocked`

The handler validates the node is currently `running`, optionally validates `worker_thread_ext`, runs the Foundry foundation finish gate, and calls:

```ts
finishHopperNode(id, outcome, { result, question, children })
```

`finishHopperNode` is in `hopper-engine.ts:590-641`.

Current behavior:

- `done`: set node `done`, store `result`, clear lease, call `settleAncestors`.
- `split`: insert child nodes with `parent_id = current node`, optional chain deps, set parent `split`.
- `blocked_question`: store question and notify Kevin unless Foundry.
- `blocked`: store result and error-notify unless Foundry.
- Always queue `dispatchTick('node_finished')`.

`settleAncestors` is in `hopper-engine.ts:552-572`.

- If the node is top-level (`parent_id == null`), call `maybeFinishTree`.
- If it has a parent, mark that parent `done` once all children are `done`.

`maybeFinishTree` is in `hopper-engine.ts:574-587`.

Current all-done decision:

```ts
if (nodes.length && nodes.every((n) => n.status === 'done' || n.status === 'split')) {
  UPDATE hopper_trees SET status = 'done'
  create success notification: "Hopper tree complete"
}
```

This is the finish-line hook point.

### Dispatch Path

`dispatchTick` is in `hopper-engine.ts:672-760`.

Current behavior:

- Requeue expired leases or park exhausted nodes as blocked.
- Calculate free slots.
- Iterate `readyLeavesStmt`.
- Skip nodes with unsatisfied deps.
- Gate by provider-aware governor.
- Claim node by setting `status = 'running'`, `attempts += 1`, `worker_thread_ext`, lease.
- Spawn worker through `spawnWorker`.

`spawnWorker` composes a worker prompt and calls `processMessageRef(prompt, ext, messageId)`.

## Proposed Data Model

Add two nullable tree columns:

```sql
ALTER TABLE hopper_trees ADD COLUMN original_ask TEXT;
ALTER TABLE hopper_trees ADD COLUMN deferred_scope TEXT;
```

Update `HopperTreeRow`:

```ts
export interface HopperTreeRow {
  id: string;
  topic: string;
  origin_thread_ext: string | null;
  original_ask: string | null;
  deferred_scope: string | null;
  status: 'draft' | 'active' | 'done' | 'archived';
  created_at: string;
  updated_at: string;
}
```

Migration pattern should match the existing additive style:

```ts
for (const col of ['original_ask TEXT', 'deferred_scope TEXT']) {
  try { sqliteDb.exec(`ALTER TABLE hopper_trees ADD COLUMN ${col}`); } catch {}
}
```

`POST /hopper-trees` accepts optional request fields:

```ts
{
  topic: string;
  origin_thread?: string;
  original_ask?: string;
  deferred_scope?: string;
  nodes: NewNodeInput[];
}
```

`createHopperTree` signature becomes:

```ts
export function createHopperTree(
  topic: string,
  originThreadExt: string | null,
  nodes: NewNodeInput[],
  opts?: { originalAsk?: string | null; deferredScope?: string | null },
)
```

Persist with bounded values:

- `original_ask`: trim, null if empty, cap around 20k chars.
- `deferred_scope`: trim, null if empty, cap around 20k chars.

Compatibility:

- Existing callers that do not provide `original_ask` behave exactly as today.
- Trees without `original_ask` skip the finish-line gate.
- `deferred_scope` is not required; it is a hint to the audit node, not a second source of truth.

## Finish-Line Completion Hook

Hook in `maybeFinishTree`, before setting the tree to `done`.

Current:

```ts
if (allSettled) {
  mark tree done;
  notify complete;
}
```

New:

```ts
if (!allSettled) return;

if (shouldAppendFinishLineAudit(tree, nodes)) {
  appendFinishLineAuditNode(tree, nodes);
  queueMicrotask(() => void dispatchTick('finishline_audit_appended'));
  return;
}

mark tree done;
notifyCompleteWithFinishLineVerdict(tree, nodes);
```

`shouldAppendFinishLineAudit(tree, nodes)`:

- `tree.status === 'active'`
- `tree.original_ask` is non-empty
- no existing finish-line audit node exists in the tree
- all current nodes are settled

Finish-line node detection should use a stable title prefix:

```ts
const FINISHLINE_TITLE = 'FINISH-LINE AUDIT';
const isFinishLineNode = (n: HopperNodeRow) => n.title.startsWith(FINISHLINE_TITLE);
```

No extra tree column is required for "has finish-line node"; the node is the durable marker.

## Auto-Appended Audit Node

Insert one flat pending node:

```ts
INSERT INTO hopper_nodes
  (tree_id, parent_id, title, spec, status, depends_on, priority, adapter, model)
VALUES
  (?, NULL, ?, ?, 'pending', ?, 1000, 'claude', ?)
```

Dependencies:

- `depends_on` should be the JSON array of all currently settled node ids except any existing finish-line node.
- Do not set `parent_id`.
- Because all deps are already `done` or `split`, the node is immediately ready on the next dispatch tick.

Model:

```ts
const model = getSetting('finishline_audit_model')?.trim() || 'claude-sonnet-5';
```

Adapter:

- `claude` for v0.
- This is an audit/planner brain, not leaf build work. Sonnet is the default balance; the setting can be bumped to Opus later.

SSE:

- Emit `hopper_node` created event for the audit node like `createHopperTree` and `split` do.

Notification:

- Optional info notification on append is not necessary for v0. The important bell is final FULL/SHORTFALL. Avoid noisy intermediate bells.

## Audit Node Spec Template

The generated node spec should be self-contained. The worker only sees:

- tree topic
- node title
- generated spec
- dependency result snippets injected by `depResults`

Template:

```md
You are the FINISH-LINE AUDIT for Hopper tree <tree_id>.

Purpose:
Compare what the tree actually delivered against Kevin's original ask. Do not rubber-stamp green just because every worker node reported done.

Original ask:
<original_ask>

Explicit deferred/narrowed scope, if any:
<deferred_scope or "(none recorded)">

Settled node inventory:
<one bullet per non-finishline node: #id title status adapter/model result excerpt>

Rules:
- Verdict FULL only if the completed tree satisfies the original ask, or every missing piece is explicitly named in deferred_scope and that deferral is visible enough that Kevin would not wake up surprised.
- Verdict SHORTFALL if meaningful requested scope remains undone, hidden, ambiguous, or only mentioned in an outbox/doc that no system will consume.
- If SHORTFALL, you must plant and agree a continuation Hopper tree through the local API before finishing this audit node.
- The continuation tree must be narrow, concrete, and cover the missing scope. Use original_ask as the source of truth and include the shortfall summary in the continuation topic/specs.
- Never touch production, merge to main, send external messages, or use API keys.

Continuation API, only if SHORTFALL:
1. Read JARVIS_COCKPIT_KEY from /home/kevin/paperclip/jarvis-command-center/.env.
2. POST /api/v1/hopper-trees with:
   - topic: "continuation: <original tree topic> - <gap summary>"
   - origin_thread: <same origin_thread_ext if present>
   - original_ask: <original_ask>
   - deferred_scope: "Continuation auto-planted by finish-line audit for tree <tree_id>. Shortfall: <summary>"
   - nodes: concrete follow-up nodes
3. POST /api/v1/hopper-trees/:newTreeId/agree.

Finish result:
Finish this audit node with outcome=done. Put a single JSON object in result:
{
  "finishline_verdict": "FULL" | "SHORTFALL",
  "summary": "<one or two sentences>",
  "gaps": ["..."],
  "continuation_tree_id": "<tree-id or null>",
  "continuation_nodes": ["<titles planted, if any>"]
}
```

Why the verdict is encoded in `result`:

- The current finish contract already persists arbitrary `result` text.
- The API does not need a new metadata envelope.
- `maybeFinishTree` can parse JSON from the finish-line node result when composing the final notification.
- If parsing fails, it still completes with a conservative notification: "finish-line audit complete, result could not be parsed".

## Final Tree Notification

Replace the generic complete notification for trees with `original_ask` and a finish-line node.

If verdict parses as `FULL`:

- severity: `success`
- title: `Finish-line FULL: <tree topic>`
- body: `Tree <id> satisfied the original ask. <summary>`

If verdict parses as `SHORTFALL`:

- severity: `warning`
- title: `Finish-line SHORTFALL: continuation planted`
- body: `Tree <id> completed its scoped work but the audit found gaps. Continuation <continuation_tree_id> was planted and agreed. <summary>`

If there is no `original_ask`, use the existing `Hopper tree complete` notification.

If there is an `original_ask` but the finish-line result is malformed:

- severity: `warning`
- title: `Finish-line audit completed with unreadable verdict`
- body includes tree id and the first result excerpt.

## Continuation Tree Behavior

The audit worker plants the continuation tree itself rather than returning `blocked_question` or leaving a doc for Kevin.

Continuation `POST /hopper-trees` should use the same public plant API as normal planner chats:

```json
{
  "topic": "continuation: <topic> - <gap>",
  "origin_thread": "<original origin_thread_ext>",
  "original_ask": "<same original ask>",
  "deferred_scope": "Auto-planted by finish-line audit for <tree_id>; covers gaps: ...",
  "nodes": [
    {
      "title": "...",
      "spec": "...",
      "depends_on_indexes": [],
      "adapter": "claude",
      "model": "claude-sonnet-5"
    }
  ]
}
```

Then:

```http
POST /api/v1/hopper-trees/<newTreeId>/agree
```

This preserves the existing agree path and dispatch behavior. It does mean the audit node is allowed to auto-agree one server-planted continuation. That is intentional: the finish-line gate is the human-signal substitute for hidden deferrals.

Safety constraints:

- Continuation nodes must be flat initial DAG nodes. `parent_id` remains null.
- Use `depends_on_indexes` only.
- The API and `createHopperTree` already ignore `parent_index`; keep that behavior.
- Continuation tree inherits the same `original_ask`, so it also gets audited when it reaches completion.

Loop control:

- Do not add a loop counter column for v0.
- The continuation's `deferred_scope` records that it was auto-planted by finish-line.
- If a continuation also falls short, the next audit can plant another continuation. That is visible and preferable to silent green.
- If loop prevention becomes necessary later, add `finishline_parent_tree_id` or `finishline_depth` as a follow-up. Not needed for the v0 contract.

## Helper Functions to Add

In `hopper-engine.ts`:

```ts
const FINISHLINE_TITLE = 'FINISH-LINE AUDIT';
const FINISHLINE_DEFAULT_MODEL = 'claude-sonnet-5';

function finishLineAuditModel(): string {
  return getSetting('finishline_audit_model')?.trim() || FINISHLINE_DEFAULT_MODEL;
}

function isFinishLineNode(node: HopperNodeRow): boolean {
  return node.title.startsWith(FINISHLINE_TITLE);
}

function shouldAppendFinishLineAudit(tree: HopperTreeRow, nodes: HopperNodeRow[]): boolean {
  return Boolean(tree.original_ask?.trim())
    && nodes.length > 0
    && nodes.every((n) => n.status === 'done' || n.status === 'split')
    && !nodes.some(isFinishLineNode);
}

function appendFinishLineAuditNode(tree: HopperTreeRow, nodes: HopperNodeRow[]): HopperNodeRow | null {
  const deps = nodes.filter((n) => !isFinishLineNode(n)).map((n) => n.id);
  const spec = composeFinishLineAuditSpec(tree, nodes);
  const info = insertFinishLineNode.run(
    tree.id,
    FINISHLINE_TITLE,
    spec,
    JSON.stringify(deps),
    finishLineAuditModel(),
  );
  const created = getNodeStmt.get(Number(info.lastInsertRowid)) ?? null;
  if (created) emitNode('created', created);
  return created;
}

function finishLineVerdictFor(nodes: HopperNodeRow[]): FinishLineVerdict | null {
  const audit = nodes.find(isFinishLineNode);
  if (!audit?.result) return null;
  try { return JSON.parse(audit.result) as FinishLineVerdict; } catch { return null; }
}
```

`insertFinishLineNode`:

```ts
const insertFinishLineNode = sqliteDb.prepare<[string, string, string, string, string]>(`
  INSERT INTO hopper_nodes (tree_id, parent_id, title, spec, status, depends_on, priority, adapter, model)
  VALUES (?, NULL, ?, ?, 'pending', ?, 1000, 'claude', ?)
`);
```

## First-Turn Continuity Injection

Current memory injection:

- `prompt.ts:10-28`: `loadMemoryBlock()` reads `/home/kevin/obsidian/paperclip-wiki/agent-memory/jarvis/memory.md`.
- `prompt.ts:31+`: `buildSystemPrompt()` includes the full memory block.
- `agent.ts:601-603`: `buildInitialPrompt(userMessage)` builds first-turn prompt as system prompt + tools + user message.
- `agent.ts:777-823`: `buildContinuationPrompt(...)` rebuilds context after adapter/session reset and includes memory.
- `agent.ts:1310-1321`: native resume path reinjects a `<memory_refresh>` block every turn when `sessionId` exists.

Target file:

```txt
/home/kevin/obsidian/paperclip-wiki/skills/jarvis-continuity/SKILL.md
```

Requirement:

- Inject this file once per conversation, on the first model turn only.
- Do not inject it every resumed/native turn.
- Do not put it into `buildSystemPrompt()`, because that would also affect continuation prompts and increase fixed prompt cost.

Recommended seam:

Add a new loader in `prompt.ts`:

```ts
const CONTINUITY_FILE = '/home/kevin/obsidian/paperclip-wiki/skills/jarvis-continuity/SKILL.md';

export function loadContinuityBootBlock(): string {
  let body: string;
  try { body = readFileSync(CONTINUITY_FILE, 'utf-8').trim(); }
  catch { body = '_(jarvis-continuity skill unavailable)_'; }
  return [
    '## JARVIS Continuity Boot File (first turn only)',
    `_Source: ${CONTINUITY_FILE}. Injected once at conversation start so a fresh thread has the operating shape that makes JARVIS portable. It is not repeated on later turns._`,
    '',
    body || '_(jarvis-continuity skill is empty)_',
  ].join('\n');
}
```

Then change only `buildInitialPrompt`:

```ts
export function buildInitialPrompt(userMessage: string): string {
  return [
    buildSystemPrompt(),
    buildToolsBlock(),
    loadContinuityBootBlock(),
    '---',
    `Human: ${userMessage}`,
    'Assistant:',
  ].join('\n\n');
}
```

Why this is the right seam:

- `runConversationTurn` already chooses `buildInitialPrompt` only when there is no native session and `turns.length <= 1`.
- Later turns with a native session use `memory_refresh` only.
- Later turns without a native session use `buildContinuationPrompt`, not `buildInitialPrompt`.
- The boot file does not inflate every turn.

Follow-up hardening:

- If a cleared conversation should receive the boot file again, this naturally happens because its turns are gone.
- If a conversation is created with an initial system seed in the future, pass an explicit `includeContinuityBoot` option rather than moving this into `buildSystemPrompt`.

## Implementation Steps

1. Extend `hopper_trees` DDL and row type with `original_ask` and `deferred_scope`.
2. Update `POST /hopper-trees` body parsing and `createHopperTree` signature.
3. Add finish-line helper functions in `hopper-engine.ts`.
4. Modify `maybeFinishTree` to append the audit node before marking done.
5. Update final completion notification to parse audit result and state FULL or SHORTFALL.
6. Add the first-turn continuity boot block in `prompt.ts` and `buildInitialPrompt`.
7. Add focused smoke coverage.

## Smoke Tests

Use a test DB or scripted smoke against a disposable local service, not the live checkout.

Recommended cases:

1. Tree with no `original_ask`
   - Plant, agree, finish all nodes.
   - Expected: no audit node; existing complete notification behavior.

2. Tree with `original_ask`
   - Plant, agree, finish all original nodes.
   - Expected: tree remains `active`; one `FINISH-LINE AUDIT` node appears with `parent_id NULL`, `status pending`, `depends_on` listing original node ids.

3. Audit node dispatchability
   - Confirm `readyLeavesStmt` can claim the audit node.
   - Expected: no parent-id deadlock.

4. FULL verdict
   - Finish audit node with `result` JSON containing `finishline_verdict: "FULL"`.
   - Expected: tree becomes `done`; notification says FULL.

5. SHORTFALL verdict
   - Have audit worker plant and agree a continuation tree, then finish with `SHORTFALL` JSON.
   - Expected: original tree becomes `done`; notification says SHORTFALL and includes continuation id; continuation tree is `active`.

6. First-turn injection
   - Unit-test `buildInitialPrompt` contains `JARVIS Continuity Boot File`.
   - Unit-test `buildContinuationPrompt` does not contain it.
   - Confirm resumed/native per-turn prompt only contains memory refresh, not the continuity boot file.

## Non-Goals

- Do not restart `jarvis.service` from this worker.
- Do not deploy.
- Do not add a new model API or provider SDK.
- Do not introduce `parent_id` for finish-line/continuation DAG nodes.
- Do not require Kevin to answer a question when a shortfall is mechanically continuable.
