# Hopper Tree Handoff Contract

Branch: `hopper/finish-line-gate`

Source ask, Kevin, 2026-09-14:

> I see that it's done, but how do I know where to go from there? It would be really good if when the documentation layer is done it becomes available to me. Something like a finished one has a button that gives me a quick overview of what was done and what the next steps are (how to install if it's a branch, what steps to take to use it, etc)

## Goal

A finished Hopper tree should have a short operator-facing handoff card stored
on the tree itself. The card is what the cockpit can show behind a "Handoff" or
"What changed?" button after a tree completes.

The card is not a replacement for the full outbox report. It is the skim layer:
what was built, which branches matter, how to install or try it, how to use it,
what remains, and where the full report lives.

## Data Model

Add one nullable column to `hopper_trees`:

```sql
ALTER TABLE hopper_trees ADD COLUMN handoff TEXT;
```

Update the tree row type:

```ts
export interface HopperTreeRow {
  id: string;
  topic: string;
  origin_thread_ext: string | null;
  original_ask: string | null;
  deferred_scope: string | null;
  continuation_of: string | null;
  handoff: string | null;
  status: 'draft' | 'active' | 'done' | 'archived';
  created_at: string;
  updated_at: string;
}
```

Migration should follow the current additive pattern in
`darwin-assistant/src/hopper-engine.ts`:

```ts
for (const col of ['original_ask TEXT', 'deferred_scope TEXT', 'continuation_of TEXT', 'handoff TEXT']) {
  try {
    sqliteDb.exec(`ALTER TABLE hopper_trees ADD COLUMN ${col}`);
  } catch {
    /* column already exists */
  }
}
```

Storage rules:

- Store markdown text, not JSON.
- Trim input and cap it at the existing text-field limit used by Hopper
  (`20_000` chars is enough for an operator card).
- Null or empty handoff means "no handoff written yet".
- Existing trees keep `handoff = NULL` until a finish-line audit or backfill
  worker writes one.

## Handoff Markdown Shape

Every handoff card must be valid markdown and must include these sections in
this order:

```md
# <Tree topic> handoff

Tree: `tree-...`
Status: final
Backfilled: no

## What was built

- ...

## Branches & how to install

| Order | Repo | Branch | Head | Notes |
| --- | --- | --- | --- | --- |
| 1 | `owner/repo` | `branch/name` | `abc1234` | Pull/build/deploy note. |

## How to use it

1. ...

## Next steps / deferred

- ...

## Full report

- Full report: `outbox/<file>.md`
```

Required section semantics:

- `What was built`: concise summary of completed deliverables, not a transcript
  of worker activity.
- `Branches & how to install`: table of every branch or manual artifact Kevin
  needs to pull, review, deploy, or intentionally ignore. The table shape copies
  the clearinghouse handoff convention: `Order`, `Repo`, `Branch`, `Head`,
  `Notes`. Use `Order` as the pull/deploy order. Use `manual SQL`, `docs-only`,
  or `none` in `Head` only when there is no git head.
- `How to use it`: the practical operator path after install. For UI work, name
  the route or cockpit page. For a backend feature, name the endpoint, command,
  setting, or workflow Kevin should run.
- `Next steps / deferred`: list explicitly deferred work, rollout gates, review
  caveats, known non-blockers, or "None" if nothing remains.
- `Full report`: a wiki-relative outbox link such as `outbox/foundry-v0.md`.
  Never store absolute filesystem paths like `/home/kevin/...` in this section.

For trees that produced no code branch, still include the branch table:

```md
| Order | Repo | Branch | Head | Notes |
| --- | --- | --- | --- | --- |
| 1 | `KEatonDarwin/paperclip` | none | docs-only | No install step; read the linked outbox report. |
```

## API Contract

`GET /api/v1/hopper-trees/:treeId`

The existing response should include `handoff` on `tree` because the row is
selected with `SELECT *`:

```json
{
  "tree": {
    "id": "tree-6097474e",
    "topic": "Finish-line gate",
    "status": "done",
    "original_ask": "...",
    "deferred_scope": null,
    "continuation_of": null,
    "handoff": "# Finish-line gate handoff\n\n..."
  },
  "nodes": []
}
```

`POST /api/v1/hopper-trees/:treeId/handoff`

Bearer-authenticated, same local API/auth posture as the worker finish
contract. This endpoint persists the markdown card onto the tree.

Request:

```json
{
  "handoff": "# Finish-line gate handoff\n\n...",
  "force": false
}
```

Fields:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `handoff` | string | yes | Markdown card with all required sections. |
| `force` | boolean | no | If false or omitted, reject overwriting an existing handoff. If true, replace it. |

Response:

```json
{
  "tree": {
    "id": "tree-6097474e",
    "topic": "Finish-line gate",
    "status": "done",
    "handoff": "# Finish-line gate handoff\n\n..."
  }
}
```

Validation:

- `404 hopper_tree_not_found` when the tree id does not exist.
- `400 invalid_handoff` when `handoff` is empty or missing any required
  section heading. Heading checks are line-anchored; a heading mentioned inside
  prose or a code fence does not satisfy the contract.
- `400 invalid_handoff` when the card contains local-only filesystem paths such
  as `/home/kevin/`, `/tmp/`, or `~/` anywhere in the markdown. Use
  wiki-relative `outbox/<file>.md` links and repository-relative paths instead.
- `409 handoff_exists` when the tree already has a handoff and `force` is not
  true.

Status rules:

- Accept writes for `draft`, `active`, `done`, and `archived` trees. Backfills
  need to write old `done` or `archived` trees, and an active finish-line audit
  needs to write before it finishes its own node.
- The endpoint only writes `hopper_trees.handoff` and updates `updated_at`. It
  must not change tree status, node status, worker leases, branch state, or
  notifications.
- The worker finish route also enforces the handoff gate for finish-line audit
  nodes: a `finishline_verdict: "FULL"` result is rejected with
  `409 finishline_full_missing_handoff` unless the tree already has a persisted
  handoff card. The tree stays active and the audit node is blocked/retryable;
  Kevin never gets a green finished-tree bell without a card.

Suggested engine helper:

```ts
export function setHopperTreeHandoff(
  treeId: string,
  handoff: string,
  opts: { force?: boolean } = {},
): HopperTreeRow | null
```

## Who Writes It

### Finish-line audit node

The finish-line audit node owns the final handoff for trees with
`original_ask`.

Update `composeFinishLineAuditSpec()` so the audit worker has this extra final
step before it reports `finishline_verdict: "FULL"`:

1. Read the completed node inventory from the audit prompt.
2. Identify the docs/push node's outbox report path from node result text. It
   must be a wiki-relative path like `outbox/<file>.md`.
3. Synthesize the handoff markdown using the required section order.
4. POST it to `/api/v1/hopper-trees/<actual-tree-id>/handoff` with bearer auth.
5. If the handoff POST fails, retry up to three times.
6. If the endpoint returns `409 handoff_exists`, a previous attempt already
   wrote a card. Confirm the stored card with `GET
   /api/v1/hopper-trees/<actual-tree-id>`; if it is stale or incomplete, repeat
   the POST with `force: true`, then continue.
7. If the handoff still cannot be persisted, do not return a `FULL` verdict.
   Finish the audit node as `blocked` with a precise result, because Kevin would
   still have no finished-tree handoff.
8. After the handoff POST succeeds, finish the audit node with the existing
   JSON result contract:

```json
{
  "finishline_verdict": "FULL",
  "summary": "<one or two sentences>",
  "gaps": [],
  "continuation_tree_id": null,
  "continuation_nodes": []
}
```

For `SHORTFALL`, keep the existing continuation behavior. The parent tree can
complete with a warning and no final handoff; the continuation tree's eventual
`FULL` audit should write a handoff that covers the cumulative chain.

### Docs/push nodes

Docs/push worker templates should write their full outbox report in the same
operator-handoff shape, so the finish-line audit can extract the skim card
without re-hunting branch details.

Minimum docs/push result text:

```md
Full report: `outbox/<file>.md`

Branches:
| Order | Repo | Branch | Head | Notes |
| --- | --- | --- | --- | --- |
| 1 | `owner/repo` | `branch/name` | `abc1234` | Pull/build/deploy note. |

Deferred:
- ...
```

The wiki outbox report itself should include:

- What shipped.
- Branch table and pull/deploy order.
- How to try or use it.
- Review/verification verdict.
- Deploy gates, config/cache notes, and rollback notes when relevant.
- Deferred or not-built items.

This keeps a clean chain: docs/push writes the full report; finish-line audit
compresses it into `hopper_trees.handoff`; cockpit shows the handoff button.

## Backfill Semantics

Pre-gate trees that are already `done` can be backfilled by a one-shot worker or
script. Backfill is best-effort and never changes execution state.

Backfill process:

1. Select done or archived trees where `handoff IS NULL`.
2. Find the docs/push node. Prefer nodes whose title includes `DOC`, `docs`,
   `push`, `report`, or whose result mentions `outbox/`.
3. Derive the card from the docs node's result text and any linked outbox path.
4. Preserve the required section headings.
5. Set `Backfilled: yes` near the top of the markdown card.
6. In `Full report`, use the discovered wiki-relative `outbox/<file>.md` link.
   If no report path exists, write `Full report: not found in historical node
   results` and keep `Backfilled: yes`.
7. POST the card through `/api/v1/hopper-trees/:treeId/handoff` with
   `force: false`.

Backfill must not:

- Re-open nodes or trees.
- Re-run workers.
- Invent branches or deploy steps that are not present in node results.
- Store local filesystem paths in the card. Backfill must sanitize wiki,
  worktree, `/tmp`, and `~/` paths before POSTing through the API.
- Overwrite a handoff already written by a finish-line audit unless an operator
  deliberately re-runs it with `force: true`.

Branch extraction rules:

- Scan all node results, not only the docs/push node, because historical branch
  and commit text often appears in build or review nodes.
- Prefer branch-looking tokens introduced by words like `branch`, `on`, or
  well-known branch prefixes such as `hopper/`, `foundry/`, `mcp/`,
  `clearinghouse/`, `feature/`, and `autogroup/`.
- If the branch or repo cannot be recovered honestly, write `unknown` and point
  Kevin to the full report or tree detail. Do not use `docs-only` unless the
  tree truly produced no branch/manual artifact.
- Only attach a `Head` value when it is recoverable for that row. Otherwise use
  `unknown`.

## Cockpit Consumer Notes

The UI can treat `tree.handoff` as the source of truth:

- If `tree.status === "done"` and `tree.handoff` is non-empty, show a handoff
  button on the finished tree card.
- If `tree.status === "done"` and `tree.handoff` is empty, show no button or a
  muted "No handoff yet" affordance until backfill lands.
- Render markdown. The branch table is intentionally markdown-native so it can
  be reused in chat, docs, and cockpit with one stored value.

## Review Checklist

- `hopper_trees.handoff` exists and is returned by `GET /hopper-trees/:id`.
- `POST /hopper-trees/:id/handoff` validates required headings and rejects
  local filesystem paths anywhere in the markdown.
- Finish-line audit `FULL` verdicts cannot complete the tree unless the handoff
  has already been persisted.
- Docs/push templates include outbox reports and branch tables in the expected
  shape.
- A scratch done tree can be backfilled from a docs node result without
  changing tree/node status.

## Review Drift Notes

Re-review for tree `tree-b422a2b3` passed after these contract refinements were
implemented:

- The handoff gate is now enforced in server code, not just in the audit prompt.
  A `FULL` finish-line verdict without `hopper_trees.handoff` is rejected with
  `409 finishline_full_missing_handoff`.
- The cockpit renders one page-level handoff drawer outside the finished-tree
  card links. Clicking close, copying text, pressing Escape, or opening the
  outbox link no longer navigates away from `/spawn-tree`.
- Backfill cards scan all node results for branches and commits, sanitize local
  paths, and use honest `unknown` rows when old node text does not carry enough
  information.
- Required markdown headings are line-anchored, so a code-fenced or inline
  mention of a heading does not pass validation.

Known non-blocking follow-ups:

- Let a worker recover in-attempt from `finishline_full_missing_handoff` after
  it posts the missing card, instead of requiring a node retry.
- Tighten historical backfill branch extraction further so slash tokens like
  framework names never appear as branch rows.
