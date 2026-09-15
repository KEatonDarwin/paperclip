# Hopper Smart Unblocker Contract

Branch: `hopper/smart-unblocker`

Source ask, Kevin, 2026-09-14:

> we need a secondary smart jarvis layer. If the subscriptions have enough juice
> behind them, if something gets blocked like that, a high thought jarvis needs
> to be spawned to take a look (Opus 5 or Fable, if possible. Nothing lower than
> Opus 4.8, and nothing big like Fable 5.1 or Astra). Because I basically said
> Hey Jarvis, unstick this and you did. If I trust you to make that call, then
> there needs to be a situation where it is assumed that I am going to tell you
> to make that call more often than not, and then it is done without me. Do it
> only when we have the power to do so (subscription juice).

## Goal

When a Hopper node red-blocks, the engine should try the same move Kevin would
usually ask JARVIS to do manually: spawn one high-thought JARVIS worker, have it
read the block, decide whether the fix is inside the standing autonomy bar, plant
the minimal remediation work back into the same tree, and re-run the blocked
gate.

This is not a retry ladder for flaky attempts. It is a remediation layer for
`outcome="blocked"` reports that need judgment after the normal worker has
already stopped.

## Non-Goals

- Do not touch `blocked_question`. Yellow questions are Kevin-facing by design
  and stay on the `/spawn-tree` answer-box path.
- Do not auto-deploy, restart `jarvis.service`, merge to main, force-push,
  touch live production databases, send external messages, or spend money.
- Do not route ordinary fix/build leaf nodes to frontier models. The unblocker
  may be high-tier; the work it plants is routed down by
  `skills/jarvis-router/SKILL.md`.
- Do not replace existing subsystem auto-retries, especially Foundry's one-pass
  Contract Resolution Rule retry. Smart Unblocker runs only when a red block
  remains blocked after any more specific retry hook has declined or exhausted
  itself.

## Trigger

The trigger is the durable state transition inside `finishHopperNode()`:

- worker POSTs `POST /api/v1/hopper-nodes/:id/finish`
- body has `outcome: "blocked"`
- node status is written as `blocked`
- tree is not complete because at least one node is now red

The trigger must not fire for:

- `outcome: "blocked_question"`
- expired leases
- manual archive/unarchive
- draft trees
- a node that already has a Smart Unblocker marker

The trigger should be implemented as an internal hook after the blocked state is
persisted. A periodic sweep may also look for `blocked` nodes with no marker so
nodes that blocked while the juice gate was closed can be handled later when the
subscription window opens.

## Settings

All settings are read from settings-KV, uncached, with the listed defaults.

| Setting key | Type | Default | Meaning |
| --- | --- | ---: | --- |
| `unblocker_enabled` | enum `on`/`off` | `on` | Master switch. Any value other than exact `off` means enabled. |
| `unblocker_max_5h` | integer percent | `60` | Claude five-hour utilization must be known and strictly below this value before a high-tier unblocker is spawned. |
| `unblocker_model` | enum allowlist | `claude-opus-5` | High-tier model used for the unblocker worker. Invalid values fall back to `claude-opus-5`. |

Hard model allowlist:

```ts
const UNBLOCKER_MODEL_ALLOWLIST = [
  'claude-opus-5',
  'claude-fable-5',
  'opus4.8',
] as const;
```

Anything else is ignored and replaced with `claude-opus-5`. This is deliberate:
Kevin asked for nothing below Opus 4.8, and specifically excluded larger
frontier pools such as Fable 5.1 and GPT-6 Astra.

Provider mapping for v0:

| `unblocker_model` | Adapter | Model |
| --- | --- | --- |
| `claude-opus-5` | `claude` | `claude-opus-5` |
| `claude-fable-5` | `claude` | `claude-fable-5` |
| `opus4.8` | `auggie` if Auggie is open, else fallback to `claude-opus-5` | `opus4.8` |

The additional juice gate below always checks Claude first because this feature
is meant to protect Kevin's high-thought subscription window. If `opus4.8` maps
to Auggie, the implementation must also check Auggie's governor lane before
spawning it.

## Juice Gate

Before spawning an unblocker worker, all of these must be true:

1. `unblocker_enabled` is enabled.
2. `governorCheck('claude')` returns `allow: true`.
3. Claude five-hour usage is readable and `< unblocker_max_5h`.
4. The selected model/provider is currently allowed by its own governor lane.
5. The node has no prior Smart Unblocker marker.

If any gate fails:

- Do not spawn the high-tier worker.
- Do not mark the one-pass fuse as used unless the worker was actually claimed.
- Leave the node red-blocked with the existing notification path intact.
- Record a lightweight skip/waiting reason if a marker row exists for sweeps,
  but do not ask Kevin unless the one-pass fuse has already been used.

Unknown Claude five-hour usage is a hold, not permission.

The strict comparison is intentional: at exactly `60`, with the default setting,
the unblocker does not spawn.

## Persistent Marker

Use a persistent marker so restarts, duplicate SSE events, and replayed worker
finishes cannot spawn multiple high-tier unblockers for the same node.

Suggested table:

```sql
CREATE TABLE IF NOT EXISTS hopper_unblocker_passes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL UNIQUE,
  tree_id TEXT NOT NULL,
  worker_thread_ext TEXT,
  adapter TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('waiting_for_juice','running','done','needs_kevin','failed')),
  blocked_result TEXT,
  result TEXT,
  nudge_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
```

Claim rule:

- Insert the row before spawning the worker.
- `UNIQUE(node_id)` is the one-pass fuse.
- A row in `running`, `done`, `needs_kevin`, or `failed` means the fuse is used.
- A row in `waiting_for_juice` may be updated and claimed later; it is not a
  pass until `worker_thread_ext` is set.

## One Pass Per Node

If a node red-blocks after an unblocker pass has already been claimed for that
same node, the engine must not spawn a second unblocker.

Instead:

1. Mark the pass `needs_kevin`.
2. Fire a `needs_kevin` nudge using the nudge contract below.
3. Leave the node `blocked`.
4. Keep the existing red bell as the fallback visibility path.

This keeps the smart layer from becoming an infinite high-tier loop.

## Nudge Contract

When the unblocker determines Kevin is genuinely required, or when a node blocks
again after its one pass, it should call the nudge layer described by
`docs/hopper/NUDGE.md` once that sibling contract exists.

Expected semantic payload:

```json
{
  "kind": "needs_kevin",
  "source": "hopper-unblocker",
  "source_ref": "hopper_node:<node_id>",
  "title": "Hopper node still needs Kevin: <node title>",
  "body": "<one clear paragraph: what blocked, what the unblocker tried or why it declined, and the single thing Kevin must decide>",
  "link": "/spawn-tree?tree=<tree_id>&node=<node_id>"
}
```

If `POST /nudges` or its final API-v1 route does not exist yet, treat `404`,
`501`, or connection refusal as a graceful no-op and create a plain cockpit bell
notification instead:

- severity: `error`
- source: `hopper-unblocker`
- title: `Hopper node still needs Kevin: <node title>`
- body: same one-paragraph explanation

Do not fail or retry the blocked node just because the richer nudge route is not
available.

## Unblocker Worker Thread

The unblocker worker is an ephemeral cockpit thread:

```txt
cockpit:unblocker-<node_id>-<hex>
```

It should be tracked like other spawned work in `spawn_tasks`, with:

- `parent_thread_ext` = the tree origin thread when present
- `hopper_tree_id` = blocked tree id
- `hopper_node_id` = blocked node id
- label prefix = `unblocker #<node_id>`
- explicit adapter/model from the allowlist; never inherited

The thread is a one-shot. Nobody should reply to it.

## Injected Worker Playbook

The worker's seed prompt must include this playbook, after the standard spawned
worker guardrails:

```md
You are a Smart Unblocker worker for Hopper node <node_id> in tree <tree_id>.
Your job is to unstick ONE red-blocked node, then stop.

Read:

1. The full blocked node row and result.
2. The full tree context (`GET /api/v1/hopper-trees/<tree_id>`).
3. The named branch/worktree in the node spec or result.
4. `DECISIONS.md` in that worktree, if it exists.
5. Relevant local docs or runbooks named by the node.

First, reproduce your understanding in your private reasoning/output:

- What the blocked node was trying to do.
- Why it blocked.
- Whether the fix is inside JARVIS's standing autonomy bar.

If the fix is inside the bar:

1. Insert the smallest useful FIX node or nodes into the SAME tree.
2. FIX nodes must be flat: `parent_id = NULL`; use `depends_on` only.
3. Route each FIX node down per `skills/jarvis-router/SKILL.md`.
   Never use Fable, GPT-6 Astra, or any frontier provider variant for leaf work.
4. Re-pend the original blocked node behind the new FIX node ids.
5. Add a re-review addendum to the blocked node spec containing:
   - the prior blocked result,
   - the inserted FIX node ids,
   - the standard that the rerun must verify,
   - any `DECISIONS.md` entry the rerun must honor.
6. Finish with a concise summary of the remediation plan.

If the fix genuinely requires Kevin:

1. Do not plant speculative work.
2. Fire one `needs_kevin` nudge.
3. Finish with a concise summary explaining the exact decision needed.

Hard rails:

- Never restart `jarvis.service`.
- Never deploy.
- Never force-push.
- Never merge to main.
- Never touch live checkouts or production databases.
- Never send Slack/email/PRs externally under Kevin's identity.
- No new spend.
- No provider API keys. Model calls use subscription CLI binaries only.
```

## Planting FIX Nodes

The implementation needs a small internal helper or authenticated route to append
nodes to an active tree. The contract is:

```ts
type AppendHopperNodeInput = {
  title: string;
  spec: string;
  depends_on?: number[];
  adapter: string;
  model: string;
};
```

Rules:

- `parent_id` is always `NULL`.
- `depends_on` stores node ids, not indexes.
- The first FIX node depends on the blocked node's original dependencies, if
  those dependencies still matter for context.
- Sequential FIX nodes depend on the prior FIX node.
- The original blocked node is re-pended with `depends_on` extended to include
  the final FIX node id.
- Reset the original node's dispatch fields the same way `retryHopperNode()` does
  (`status='pending'`, `attempts=0`, clear question/answer/result/thread/lease).
- Preserve the prior blocked result in the re-review addendum before clearing it.

The FIX node title should start with `FIX:` so `/spawn-tree` makes the remediation
chain obvious.

## Routing FIX Nodes

Smart Unblocker is allowed to spend high-tier thought to choose the plan. The
actual fix nodes are normal workers and must obey the router rubric.

Default routing:

| FIX work type | Adapter | Model |
| --- | --- | --- |
| mechanical one-file correction | `claude` | `claude-haiku-4-5-20251001` |
| normal code/doc/test fix | `claude` | `claude-sonnet-5` |
| adversarial re-review or design-sensitive fix | `claude` | `claude-opus-5` |

Never plant a FIX leaf on `claude-fable-5`, `gpt-6-astra`, or a newly appeared
frontier model. If a leaf seems to need that, plant a heavy Opus review/design
node first and let the tree surface evidence.

## State Flow

```txt
node running
  -> finish outcome=blocked
  -> node blocked
  -> smart-unblocker hook
      -> juice closed: leave blocked / waiting_for_juice
      -> marker exists: needs_kevin nudge, leave blocked
      -> marker claimed: spawn cockpit:unblocker-<node>-<hex>
          -> fixable: append FIX node(s), re-pend original node behind them, pass done
          -> needs Kevin: nudge, pass needs_kevin
```

The unblocker pass finishing `done` does not mean the original work is done. It
means the tree now has a concrete remediation path and the original gate is back
on the queue behind it.

## Coexistence With Existing Recovery

- Lease expiry recovery remains unchanged. Smart Unblocker does not run on lease
  expiry because the worker did not intentionally report a red block.
- Spawn reconciler finish-POST recovery remains unchanged. If a worker completed
  but failed to POST, the reconciler should finish the original node rather than
  sending it through Smart Unblocker.
- Foundry Contract Resolution Rule retry remains the first responder for Foundry
  contract conflicts. Smart Unblocker should observe the node after that path has
  either declined or already used its own retry.
- Finish-line audits can use Smart Unblocker if they red-block for a technical
  remediable reason, but a finish-line `blocked_question` remains Kevin-facing.

## Acceptance Checks

- A worker finishing `blocked_question` never spawns an unblocker.
- A worker finishing `blocked` spawns at most one `cockpit:unblocker-...` thread
  when all juice gates are open.
- With Claude 5h usage equal to `unblocker_max_5h`, no unblocker spawns.
- With unreadable or stale Claude usage, no unblocker spawns.
- Invalid `unblocker_model` values fall back to `claude-opus-5`.
- `claude-fable-5` is allowed for the unblocker worker, but never for planted
  FIX leaf nodes.
- `gpt-6-astra`, `fable-5.1`, and anything not in the allowlist cannot be used
  as the unblocker model.
- A second red block on the same node after a claimed pass fires a
  `needs_kevin` nudge or fallback bell and does not spawn another unblocker.
- FIX nodes are inserted with `parent_id NULL` and dependencies only.
- Re-pending the original node preserves its prior blocked result in the spec
  addendum before clearing runtime fields.
- Missing `POST /nudges` support does not fail the unblocker path; it falls back
  to a plain bell.

## Operator Rule

Red blocks become JARVIS's queue when there is juice. Yellow questions remain
Kevin's queue. If the one smart pass cannot unstick the node, Kevin gets one
clear `needs_kevin` nudge with the context needed to answer cold.
