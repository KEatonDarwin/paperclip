# Hopper handoff contract

This contract defines the Kevin-facing handoff card attached to a completed Hopper tree.

## v2 required shape

Every finished Hopper tree with an `original_ask` must persist a handoff card before the finish-line audit may return a `FULL` verdict.

The card is markdown in `hopper_trees.handoff` and must use this section order:

```md
# <Tree topic> handoff

Tree: `<tree-id>`
Status: final
Backfilled: no

## What was built

## Branches & how to install

## How to use it

## Human runthrough

## Next steps / deferred

## Full report
```

`## Branches & how to install` must include a table with columns `Order`, `Repo`, `Branch`, `Head`, and `Notes`.

The card must not contain absolute local filesystem paths. Use wiki-relative paths such as `outbox/example.md`.

## Human runthrough

Every handoff card must contain a `## Human runthrough` section.

The section is a markdown task list:

```md
## Human runthrough

- [ ] Do X, expect Y.
- [ ] Trigger edge case Z, expect the safe/error state.
```

Checklist items are written by the handoff author, usually the finish-line audit or docs worker. The server enforces presence and shape only; it does not invent checklist items.

The checklist must cover:

- Every new user-visible behavior the tree built.
- At least one failure or edge case per major feature.
- Any pre-flight the human needs before testing, such as deploy state, branch order, env vars, seeded data, or known disabled paths.

Write items as concrete operator steps in `do X, expect Y` form. Avoid vague items such as "test everything" or "review changes."

## Server-owned check state

Checklist state is server-owned, not browser `localStorage`.

Storage:

- Additive column: `hopper_trees.handoff_checklist TEXT`.
- JSON shape: `{ "items": [{ "idx": 0, "text": "...", "checked": false, "note": null, "checked_at": null }] }`.
- The implementation may persist an internal `text_hash` per item so state survives handoff edits when the item text is unchanged.

Parsing:

- On first checklist read, parse `hopper_trees.handoff`.
- Extract the `## Human runthrough` section.
- Extract markdown task-list lines matching `- [ ] ...` or `- [x] ...`.
- Persist the parsed checklist to `hopper_trees.handoff_checklist`.
- On later reads after a handoff edit, re-parse from markdown and keep `checked`, `note`, and `checked_at` for items whose text hash still matches.

API:

- `GET /api/v1/hopper-trees/:id/checklist`
  - Returns `{ checklist: { items: [...] } }`.
  - Parses and persists the checklist on demand.
  - Returns `404 hopper_checklist_not_found` when the tree has no valid handoff checklist.
- `POST /api/v1/hopper-trees/:id/checklist/:idx`
  - Body: `{ "checked": true|false, "note": "optional note" }`.
  - Idempotent for repeated writes.
  - `checked=true` stamps `checked_at` if not already set.
  - `checked=false` clears `checked_at`.
  - Re-parses the current handoff before applying the update so an edited handoff cannot desync the stored checklist.

## Finish-line gate

A `FULL` finish-line verdict is rejected with the existing `409 finishline_full_missing_handoff` family when:

- No handoff is persisted.
- The handoff lacks `## Human runthrough`.
- The section contains zero markdown task-list items.

This is a server-owned gate. A worker cannot bypass it by claiming `FULL` in its result JSON.

The finish-line audit prompt must instruct audit workers to compose the `## Human runthrough` section before posting the handoff.

## Foundry

Foundry projects use the same human-runthrough contract, but full Foundry wiring is deferred from this node.

Required Foundry follow-up:

- The Foundry integration `DOCS` stage emits the same `## Human runthrough` section in the project handoff.
- The generated repo includes `HUMAN-CHECKLIST.md` at the root with the same checklist items.
- Foundry `ready` surfaces the checklist alongside the project handoff.
- Check state still lives in the Hopper server column/API above; the repo file is an operator artifact, not the state store.

Until that follow-up lands, Foundry handoffs that flow through the Hopper finish-line audit must still satisfy this Hopper contract.
