# DECISIONS — hopper/finish-line-gate

## 2026-09-14 · Adversarial review (tree-6097474e node #184, opus) — PASS with fixes

Verdict: the gate holds — a tree with `original_ask` cannot complete without an
audit node, every audit outcome (FULL / SHORTFALL / unreadable / blocked /
blocked_question / lease-exhausted) lands a bell, the depth cap is enforced in
code at plant time, the ALTER bootstrap is idempotent, existing `POST
/hopper-trees` callers (`origin_thread`) still work, and continuity injection
fires exactly once per non-worker conversation. tsc clean, `finishline:sim`
12/12, `continuity:test` green, all on scratch DB/port (live jarvis.db never
opened).

Three defects found by probe and fixed on the branch:

1. **Continuation audits were blind to ancestor deliverables (HIGH).** A
   continuation inherits the full `original_ask` but its audit spec listed
   only the continuation's own nodes. Probe: root delivers "X and Y, Z
   deferred" → continuation delivers "Z" → the continuation's audit prompt
   shows "Build X, Y and Z" vs. only "Built Z". Every real SHORTFALL would
   cascade: spurious depth-2 continuation doing redundant real work, then a
   depth-cap `blocked_question` bell to Kevin for nothing. The sim missed it
   because its fake worker always answers FULL. Fix: `composeFinishLineAuditSpec`
   now walks the `continuation_of` chain (cycle-safe) and includes each
   ancestor's node digest + prior audit verdict, instructs the audit to judge
   cumulative delivery, and reframes a continuation's `deferred_scope` as
   the shortfall it was planted to close, not a new deferral. Sim check E-2.
2. **Duplicate sibling continuations on audit retry (MEDIUM).** An audit
   worker that planted + agreed a continuation and then lost its lease is
   retried; the retry re-plants (depth check is per-parent, so it passes).
   Fix: `POST /hopper-trees` with `continuation_of` now answers `409
   finishline_continuation_exists` + `existing_tree_id` when a draft/active
   continuation of that parent exists; the audit spec tells the worker to
   reuse that id. Sim check E-1.
3. **Verdict parsing was strict `JSON.parse` (LOW).** A worker wrapping the
   verdict in ```json fences produced the "unreadable verdict" bell instead of
   FULL/SHORTFALL. Fix: `parseFinishLineVerdict` tolerates fences / prose
   around the object. (Bell still fires if no object with
   `finishline_verdict` is found.)

Also: the audit node's adapter was hard-coded `claude` regardless of
`finishline_audit_model`; added `finishline_audit_adapter` settings-KV
(default `claude`) alongside it.

Residual risks accepted (not code-fixable, noted for the docs):

- A claude-routed audit node is subject to the governor like any claude leaf —
  a governor hold delays the tree's completion but is not a deadlock (parent_id
  NULL, no depends_on, priority 1000; the hopper_stall sentinel bells on
  non-kevin_active holds).
- The depth cap binds only a worker that sets `continuation_of`; a
  misbehaving audit could plant an unlinked tree. Prompt-level only.
- Audit lease expiry → one escalated retry → `blocked` + "exhausted retries"
  bell; the tree stays `active` until a human retries the node. Same contract
  as every other node.
- Overflow-compaction retries drop the continuity boot block (correct: that
  path exists to shed context).

## 2026-09-14 · Adversarial review — Tree Handoff Cards (tree-b422a2b3 node #216, opus) — BLOCKED, 2 must-fix + 4 should-fix

Scope: backend commit `bd0e32562` on `hopper/finish-line-gate` (+ `74023d6b7`
docs) and cockpit commit `8349f2d` on `hopper/tree-handoff-ui`, judged against
`docs/hopper/HANDOFF.md` and Kevin's ask ("a finished one has a button that
gives me a quick overview of what was done and what the next steps are — how to
install if it's a branch…"). Everything below ran on scratch sqlite DBs
(`/tmp/handoff-*.db`, a `.dump`-copy of the live hopper tables opened
`-readonly`) and throwaway ports 39231/39241/39251/39261. Live jarvis.db, the
live service and the live cockpit were never written or restarted.

What held: `npm run build` (tsc) clean; `finishline:sim` 19/19; UI tsc/eslint
add ZERO new errors (10 tsc + 63 prettier errors in `cockpit-api.ts` are
pre-existing at parent `095835c`); route validation rejects empty / missing
headings / out-of-order headings / `/home/kevin` in Full report / overwrite
without `force`; `GET /hopper-trees/:id`, `GET /spawn-monitor/trees/:id` and
the `/spawn-monitor` cluster summaries all carry `handoff` / `has_handoff`;
handoff write leaves tree/node status untouched; **XSS is safe** — real
Chromium (Playwright) rendered a card containing `<img onerror>` + `<script>`
as escaped text, `document.title` untouched, no page errors (react-markdown,
no rehype-raw); pre-gate `done` trees render the muted "no handoff card" hint,
not a dead button; backfill dry-run on the 40 real done trees → `--apply`
against a scratch server wrote 40/40, re-run wrote 0 (409 idempotent), tree
statuses (1 active / 40 done) and node statuses (215 done / 1 pending / 1
running) identical before and after; the UI branch is a fast-forward of the
live cockpit checkout (`jarvis/plugins-panel` @ `095835c`).

### MUST FIX

1. **The handoff gate is prompt-only: a FULL verdict completes the tree with
   `handoff = NULL` (HIGH — the exact "gates-as-code, not prose" failure
   class).** `finishHopperNode` → `settleAncestors` → `maybeFinishTree` →
   `notifyTreeComplete` never reads `tree.handoff`. Repro (`/tmp/handoff-probe.mjs`,
   probe P1): fake audit worker finishes `outcome=done` with
   `{"finishline_verdict":"FULL"}` and never POSTs a handoff → tree flips
   `done`, audit node `done`, `handoff: null`, and a `🏁 finish-line: FULL`
   success bell fires. Sim check A-4 only passes because the *fake worker*
   posts the card first — it tests the sim, not the server. An audit model
   that skips step 5 (or hits a transient 4xx and gives up) delivers a green
   tree with no card, which is precisely the ask this feature exists to
   close. Fix in `finishHopperNode` (server-owned): when `isFinishLineNode(node)`
   and the parsed verdict is `FULL` and `!getHopperTree(node.tree_id)?.handoff?.trim()`,
   refuse the `done` — set the node `blocked` with result
   `finishline FULL rejected: no handoff on tree` (bell fires via the existing
   blocked path, tree stays `active`, retry re-runs the audit). Add a sim check
   that mirrors P1 and asserts the rejection. Optionally also 409 from the
   finish route so the worker sees it immediately.

2. **Handoff drawer is unusable from list cards — every click inside it
   navigates away (HIGH, UI).** `HandoffButton` (and its `<Sheet>`) is
   rendered *inside* the TanStack `<Link>` that wraps `TreeCard` and each
   `FoundryClusterCard` row. Radix portals the drawer DOM out of the card, but
   React synthetic events still bubble through the portal to the `<Link>`,
   whose `handleClick` navigates on any non-`defaultPrevented` click
   (`@tanstack/react-router/dist/esm/link.js:286-289`). Only the Handoff
   button itself calls `stopPropagation`. Repro (`/tmp/handoff-pw.mjs`,
   Playwright + chromium-1134 against vite dev :39251 → scratch API :39241):
   open `/spawn-tree` → Completed → click **Handoff** → drawer opens at
   `/spawn-tree` ✓ → click the drawer's close ✕ → URL becomes
   `/spawn-tree/tree-272cdf72`; same result clicking plain text inside the
   drawer and clicking the `outbox/probe.md` vault-file link (it opens the
   vault window AND navigates). So Kevin can open the card but cannot close
   it, select text, or follow the report link without being bounced to the
   drill-in (where the button works, because that header is not a Link).
   Fix: wrap `SheetContent`'s children in a `<div onClick={e => e.stopPropagation()}>`
   (and stop `onPointerDown`/`onMouseDown` for good measure), or hoist the
   Sheet to the page level (`/spawn-tree` keeps `openHandoffTreeId` state and
   renders one drawer outside the card grid, `HandoffButton` just sets it).
   The second is cleaner and also stops mounting one Sheet per card.

### SHOULD FIX (not blocking on their own)

3. **Backfill tells Kevin "docs-only / nothing to install" on 38 of 40 real
   trees that DO have branches (MEDIUM).** `branchTable()` only mines
   backtick-wrapped `owner/x` tokens from the ONE highest-scored docs node.
   Real docs results say `branch hopper/provider-daytime. Commit 662ff96dc
   (pushed)` (tree-61ef8c24), `Branch hopper/provider-aware-governor (commit
   aa020df0b)` (tree-526f58f7) — unbackticked → card row is
   `| 1 | KEatonDarwin/paperclip | none | docs-only | No branch details found… |`.
   `docs-only` is a contract-defined meaning ("no git head"); emitting it
   when the node text literally names a branch+sha inverts the ask ("how to
   install if it's a branch"). Fix: scan ALL node results (not just the docs
   node) for `\b(?:branch|on)\s+([A-Za-z0-9._-]+\/[A-Za-z0-9._\/-]+)`,
   `\bhopper\/[\w./-]+`, `\b(?:commit|sha)\s+([0-9a-f]{7,40})`; when nothing
   is found write `unknown` in Head and "not recoverable from node results —
   read the full report" in Notes, never `docs-only`.

4. **Absolute `/home/kevin/...` paths pass validation outside the Full-report
   section and land in 10/40 backfilled cards (LOW-MEDIUM).** The regex is
   scoped to the `## Full report` slice, so probe P2 (`/home/kevin/...` in
   "What was built" / "How to use it") returns 200, and the backfill copies
   node-result prose verbatim (e.g. tree-6097474e "Updated
   /home/kevin/obsidian/paperclip-wiki/skills/…"). HANDOFF.md "Backfill must
   not: store absolute local filesystem paths in the card." Fix: in
   `backfill` rewrite `/home/kevin/obsidian/paperclip-wiki/` → `` and
   `/home/kevin/paperclip-worktrees/<x>/` → `worktree <x>: ` before building;
   optionally have the route reject `/home/kevin/` anywhere (all current
   callers can comply). Also `~/…` and `/tmp/…` in Full report are accepted
   (P3) — cheap to add to the same check.

5. **The audit worker only sees 900-char excerpts and is never told how to
   read the full docs-node result (MEDIUM).** `compactNodeDigest` →
   `resultExcerpt(n.result)` (900 chars) is the only node data in the audit
   prompt, and the new handoff steps say "identify the docs/push node outbox
   report path from the settled node inventory". Real docs results are far
   longer; the branch table / outbox link usually sit past the cut. Nothing
   in the spec mentions `GET /api/v1/hopper-trees/<id>` for full results, so
   the model either hunts or fabricates the branch table. Fix: add to step 2
   "GET /api/v1/hopper-trees/${tree.id} (bearer) and read the docs/push
   node's full `result`", and/or raise the excerpt limit for nodes whose
   result mentions `outbox/`. Related nit: step 5 says
   `/api/v1/hopper-trees/:treeId/handoff` while the continuation block
   interpolates the real `${tree.id}` — interpolate here too (the Foundry
   `{{node_id}}` incident is the precedent).

6. **Heading check is `indexOf`, not line-anchored (LOW).** Probe P4: a card
   whose only content is one code-fenced line containing all five headings
   inline is accepted (200). Anchor with `/^## What was built\s*$/m` etc.
   Also `force` must be boolean `true` — `"true"` → 409 (P6); fine as
   documented, just noting the backfill/audit must send a real boolean.

Unmet HANDOFF.md checklist item, noted not scored: "Docs/push templates include
outbox reports and branch tables in the expected shape" — no worker template /
planner skill was touched on either branch, so the audit still depends on
unstructured docs-node prose (which is why #3 and #5 bite). Worth a follow-up
edit to `skills/jarvis-worker-protocol` / the planting rule in memory.

Operational note for the deployer: the LIVE `hopper_trees` table today has
none of `original_ask / deferred_scope / continuation_of / handoff` (the
finish-line gate branch is not deployed yet); the first jarvis.service restart
on this branch runs the additive ALTERs. Running the backfill script *from the
live checkout* before that restart would run those same ALTERs against live
jarvis.db from a side process even in dry-run mode (it imports
`hopper-engine.js` for the DDL) — deploy first, then backfill; or run the
dry-run with `JARVIS_DB_PATH` pointed at a copy, as done here.

Repro artifacts: `/tmp/handoff-probe.mjs` (route + FULL-without-handoff probes),
`/tmp/handoff-pw.mjs` (Playwright drawer/XSS/nav), `/tmp/handoff-drawer.png`,
`/tmp/handoff-after-close.png`, `/tmp/handoff-backfill-scratch.db` (post-apply).
