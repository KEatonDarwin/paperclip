# Handoff checklist contract addendum

This addendum captures the 2026-09-15 v2 change Kevin asked for: every completed tree or Foundry project should end with a human sanity-check checklist.

Contract:

- `docs/hopper/HANDOFF.md` is the source contract.
- A completed handoff must include `## Human runthrough`.
- The section must contain at least one markdown task item.
- The finish-line audit prompt must tell the audit worker to write concrete `do X, expect Y` operator steps.
- Server state lives in `hopper_trees.handoff_checklist`.
- The checklist API is:
  - `GET /api/v1/hopper-trees/:id/checklist`
  - `POST /api/v1/hopper-trees/:id/checklist/:idx`

Deferred Foundry work:

- Emit the same checklist in the Foundry integration handoff.
- Write `HUMAN-CHECKLIST.md` at the generated repo root.
- Surface the checklist in the Foundry `ready` view.
