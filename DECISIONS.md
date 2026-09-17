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

## 2026-09-14 — Smart Unblocker adversarial review (node #223, tree-e8e8750a) — BLOCKED

Branch `hopper/smart-unblocker` @ `c7054d74f`, reviewed against `docs/hopper/UNBLOCKER.md`
and Kevin's ask ("do it only when we have the power to do so"). The shipped
`npm run unblocker:sim` is 6/6 green, but it only exercises the happy shapes.
Adversarial probes (`darwin-assistant/scripts/unblocker-adversarial-sim.mjs`,
run with `JARVIS_DB_PATH=/tmp/unblocker-adv.db node scripts/unblocker-adversarial-sim.mjs`
after `npm run build`) reproduce **5 findings, 5/10 probes fail**. Verdict: BLOCKED —
findings 1–3 must be fixed before deploy; 4–5 should ride along.

1. **UNBOUNDED RECURSION (HIGH — the exact failure the ask forbids).** The
   one-pass fuse is `UNIQUE(node_id)`, but every FIX node planted by
   `appendHopperRemediationNodes` is a *new* node id with no marker. When a
   FIX node finishes `blocked`, `maybeTriggerSmartUnblocker(fixId)` sees no
   pass, the juice gate is open, and it spawns another Opus unblocker — which
   plants FIX-of-FIX nodes, which can block, and so on. Probe R1: original
   blocks → 5 successive FIX-blocks → **6 high-tier unblocker spawns, 6 pass
   rows, tree grows a nested FIX chain**. The only thing that stops it is the
   5h window filling up, i.e. the cascade burns Kevin's high-thought window
   until the juice gate closes — the opposite of "only when we have the
   power". No depth guard exists anywhere.
   **Fix:** persist provenance on planted nodes (add
   `remediation_of INTEGER` to `hopper_nodes`, set it in
   `appendHopperRemediationNodes`; don't rely on the `FIX:` title). In
   `maybeTriggerSmartUnblocker`, if `node.remediation_of` is set, do NOT
   spawn: mark the *root* node's pass `needs_kevin`, fire the needs-Kevin
   bell (body = FIX node result), leave the FIX node blocked. Walk
   `remediation_of` to the root so FIX-of-FIX (if a manual remediation ever
   nests) still resolves to the single original pass. Add R1 as a permanent
   sim check (`spawns === 1` after any number of FIX-blocks).

2. **FIX-LEAF MODEL DENYLIST MISSES THE REAL FABLE 5.1 ID (MEDIUM-HIGH).**
   `FORBIDDEN_FIX_MODELS` / the route's `forbiddenModels` are
   `{'claude-fable-5','fable-5.1','gpt-6-astra'}`. The claude adapter's id
   for Fable 5.1 is **`claude-fable-5-1`** (`src/agent.ts:239`), which is
   accepted. Probe R2: `POST /remediate` with `model:'claude-fable-5-1'` →
   planted (fix node 8, model=claude-fable-5-1). Kevin's ask explicitly
   excluded Fable 5.1 and the router rubric says frontier variants of ANY
   pool are never leaf work; a denylist of three strings cannot honor "a
   newly appeared frontier model" either. **Fix:** invert to an allowlist
   for FIX leaves — per-pool Standard/Heavy tiers from
   `skills/jarvis-router/SKILL.md` (`claude-haiku-4-5-20251001`,
   `claude-sonnet-5`, `claude-opus-5`, codex `gpt-5.5`, auggie `opus4.8`/
   `sonnet4.6`-class), reject everything else with `invalid_fix_model`; at
   minimum add `claude-fable-5-1` and the `UNBLOCKER_MODEL_ALLOWLIST`'s
   own frontier entries. Keep the check in the engine helper (not just the
   route) so internal callers can't bypass it.

3. **NO CONCURRENCY CAP — N BLOCKS = N PARALLEL OPUS WORKERS (MEDIUM).**
   The unblocker is spawned directly from `finishHopperNode`, bypassing
   `dispatchTick`'s slot/governor loop, so it neither consumes a hopper slot
   nor counts against any concurrency limit. Probe R3: five leaves block in
   the same tick (the realistic "missing toolchain" shape under the
   Foundation Gate anti-shim rule, where every module of a project blocks
   on the same thing) → **5 Opus unblockers spawned simultaneously**, each
   planting its own FIX chain for the same root cause. **Fix:** a settings-KV
   `unblocker_max_concurrent` (default 1) checked against
   `hopper_unblock_passes WHERE status='running'`; over the cap → write the
   pass as `waiting_for_juice` (see #5) instead of spawning. Optionally
   dedupe per tree: if a tree already has a running pass, hold siblings
   until it settles.

4. **A TRANSIENT SPAWN FAILURE BURNS THE FUSE PERMANENTLY (MEDIUM).**
   `spawnSmartUnblockerWorker` catches the `processMessage` throw (adapter
   busy / CLI error) and calls `markUnblockPassFailedStmt` — status
   `failed` with `worker_ext` set, which `maybeTriggerSmartUnblocker` treats
   as "pass used". Probe R4: one thrown spawn → pass `failed`, node stays
   `blocked`, nothing ever retries; the next block on that node goes to
   `needs_kevin`. Contract: "Do not mark the one-pass fuse as used unless
   the worker was actually claimed" — a worker that never ran was not a
   pass. **Fix:** on spawn throw, reset the row to `waiting_for_juice` with
   `worker_ext=NULL` (keep `result` = the error for visibility) so the
   sweep (#5) can retry; only burn the fuse once `processMessage` has
   actually started the turn. Compare `spawnWorker`, which releases the
   claim on spawn failure for ordinary nodes.

5. **JUICE-CLOSED BLOCKS ARE NEVER REVISITED — `waiting_for_juice` IS DEAD
   CODE (MEDIUM, functional gap).** When the gate fails,
   `maybeTriggerSmartUnblocker` only logs and returns: no marker row is
   written, and nothing sweeps. `claimWaitingUnblockPassStmt` can never
   match because no code path ever inserts `status='waiting_for_juice'`.
   Probe R5: block at 5h=80% → 0 markers; drop to 10% and run two
   `dispatchTick`s → 0 spawns. The contract makes the sweep a "may", but
   without it the feature silently no-ops for every node that blocks while
   the 5h window is ≥60% — which is most of an active build night. Kevin's
   framing was "when we have the power to do so", not "only if we happened
   to have it at the instant of the block". **Fix:** on gate-fail insert
   (or upsert) the pass as `waiting_for_juice` with the gate reason in
   `result`; add a sweep in `dispatchTick` (it already runs every 60s and on
   every finish) that re-evaluates `waiting_for_juice` rows whose node is
   still `blocked` and claims them via the existing
   `claimWaitingUnblockPassStmt` — that stmt is the right shape, it just
   has no producer.

Passed probes (no change needed): stale usage file holds (R6); `unblocker_model`
= sonnet / gpt-6-astra falls back to `claude-opus-5` (R7a, sim 4); `opus4.8`
with Auggie ≥ ceiling falls back to claude/opus-5 (R7b); re-pended original
blocking again → `needs_kevin` + one bell, no second spawn (R8, sim 2);
`blocked_question` never triggers and the remediate helper refuses
`blocked_question` nodes (R9, sim 5); exact-threshold hold (sim 3).
Foundry coexistence checked by reading: foundry's `handleFoundrySse` is a
synchronous `sseBus` listener, so its Contract-Resolution retry runs inside
`setNode()` *before* `maybeTriggerSmartUnblocker` reads the row — the node
is already `pending` and the unblocker correctly declines; when foundry's
own retry is exhausted (`foundry_auto_retries>0`) the unblocker takes over,
matching the contract's ordering.

Not scored, noted: (a) the worker playbook's "never restart / never deploy"
rails are prompt-only — the unblocker thread is a full JARVIS persona with
`cockpit_deploy`, `intake_deploy`, `shim_deploy_*` mounted; same posture as
every hopper worker today, but a high-tier worker told to "unstick" things is
the one most likely to reach for a restart. Worth a server-side denylist of
those tools for `cockpit:unblocker-*` / `cockpit:hopper-node-*` threads as a
follow-up. (b) The finish-line "FULL without handoff" auto-block also fires the
unblocker; that block is a handoff-card-missing condition, remediable, so
acceptable. (c) `gov_override_*` (branch `hopper/gov-overrides`) is not on
this branch; when merged, `override=on` bypasses ceilings but
`unblockerGate` still reads `five_hour` independently, so the 60% cap holds —
re-run this sim after that merge.

## 2026-09-15 · Smart Unblocker fix pass (tree-7015c6fe node #235) — all 5 findings resolved

Follow-up to the 2026-09-14 adversarial review above. Branch `hopper/smart-unblocker`,
worked in the same worktree. All changes in `darwin-assistant/src/hopper-engine.ts`
+ `src/handlers/api-v1.ts` + `scripts/unblocker-sim.mjs`. Verified with
`npm run build` (clean), `npm run unblocker:sim` (6/6, check 3 updated — see
below), and `JARVIS_DB_PATH=/tmp/unblocker-adv.db node scripts/unblocker-adversarial-sim.mjs`
(10/10, was 5/10). `finishline:sim` re-run for cross-check: 25/25, unaffected.

1. **Unbounded recursion — fixed via `remediation_of`.** Added a
   `remediation_of INTEGER` column to `hopper_nodes`. `appendHopperRemediationNodes`
   now stamps every FIX node it plants with `blocked.remediation_of ?? blocked.id`
   (walked once at insert time, so a FIX-of-FIX still resolves flat to the
   original root). `maybeTriggerSmartUnblocker` checks `node.remediation_of`
   first: if set, it never spawns — it escalates straight to the root pass's
   `needs_kevin` (via `markUnblockPassNeedsKevinStmt`/`notifyUnblockerNeedsKevin`,
   which now takes an explicit `passNodeId` so the nudge lands on the ROOT
   node's pass row, not the FIX node's nonexistent one). Adversarial R1: 5
   successive FIX-blocks now produce exactly 1 unblocker spawn (was 6).

2. **Fable 5.1 / frontier-model bypass — inverted denylist to an allowlist.**
   `FIX_LEAF_MODEL_ALLOWLIST` (exported) replaces `FORBIDDEN_FIX_MODELS` in
   both `appendHopperRemediationNodes` and the `/hopper-nodes/:id/remediate`
   route (which now imports `isAllowedFixLeafModel` from the engine instead
   of keeping its own copy — the two can no longer drift, closing exactly the
   gap that let `claude-fable-5-1` slip through in the first place). Allowlist
   = the Standard/Heavy tiers a FIX leaf is meant to run on:
   `claude-haiku-4-5-20251001`, `claude-sonnet-5`, `claude-opus-5`, `gpt-5.5`,
   `opus4.8`, `sonnet4.6`, `default` (auggie's no-op flag). A new/unknown
   frontier id is rejected by default now, not just the three names on the
   old list. Adversarial R2 passes.

3. **No concurrency cap — added `unblocker_max_concurrent` (default 1).**
   `maybeTriggerSmartUnblocker` now counts `hopper_unblock_passes WHERE
   status='running'` before claiming a new pass; at/over the cap it parks the
   node via `recordWaitingForJuice` (finding 5's mechanism) instead of
   spawning. Adversarial R3: 5 simultaneous blocks → 1 unblocker (was 5).

4. **Spawn failure burning the fuse — reset to `waiting_for_juice` instead of
   `failed`.** `spawnSmartUnblockerWorker`'s catch block now calls
   `resetUnblockPassToWaitingStmt` (worker_ext cleared, status back to
   `waiting_for_juice`) instead of `markUnblockPassFailedStmt`, and kicks a
   `dispatchTick` so the retry isn't stranded until the next periodic tick.
   `markUnblockPassFailedStmt` removed (no longer has a caller). Adversarial
   R4 passes (pass status is `waiting_for_juice`, never `failed`).

5. **`waiting_for_juice` was dead code — added a producer and a sweep.**
   `recordWaitingForJuice(node, tree, reason)` upserts a `waiting_for_juice`
   marker whenever `maybeTriggerSmartUnblocker` can't proceed right now
   (gate closed OR concurrency-capped), without clobbering a row that's
   already `running`/`needs_kevin`/etc. `dispatchTick` gained a step 1.5,
   `sweepWaitingUnblockPasses()`, that re-evaluates every unclaimed
   `waiting_for_juice` row's still-`blocked` node on every tick (the existing
   60s timer / every-finish trigger is therefore the retry cadence — no new
   scheduler). `claimWaitingUnblockPassStmt` (already shipped, previously
   unreachable) is now reachable. Adversarial R5 passes: 1 marker at hold
   time, exactly 1 spawn two ticks after juice reopens.

**Contract-behavior change worth flagging explicitly:** finding 5 means a
node that blocks while the gate is closed (or over the concurrency cap) now
**always** leaves a `hopper_unblock_passes` row (`waiting_for_juice`), where
before it left none. `scripts/unblocker-sim.mjs` check 3 ("claude 5h exactly
equal to unblocker_max_5h") asserted zero rows in that case — updated to
assert exactly one `waiting_for_juice` row with `worker_ext IS NULL`, still
zero dispatches/notifications. This is the intended new contract, not a
regression: it's what makes the sweep in #5 have something to sweep.

Residual notes, not code-fixable / out of scope for this pass:

- `unblocker_max_concurrent` has no settings-UI surface yet (same posture as
  every other `unblocker_*` KV today — set via `PATCH` to the settings table
  directly or a future cockpit panel).
- The concurrency check and the gate check both read `hopper_unblock_passes`
  without a transaction wrapping the read-then-insert; two `dispatchTick`
  sweeps racing on the exact same tick could both see `runningNow=0` and both
  claim. In practice `dispatchTick` has a `ticking` reentrancy guard so this
  can't happen from the tick path itself; `finishHopperNode`'s direct
  synchronous call path is single-threaded Node, so it's serialized too. Not
  reproduced adversarially; noted for completeness.
- `gov_override_*` (branch `hopper/gov-overrides`, not yet merged here) still
  needs the same re-run-after-merge caveat the original review noted — none
  of today's changes touch `unblockerGate`'s governor read.

## 2026-09-15 · Smart Unblocker adversarial re-review (node #223 re-run, tree-e8e8750a, opus) — BLOCKED, 3 must-fix + 1 should-fix

Branch `hopper/smart-unblocker` @ `afeca0e5d` (the fix pass for the 2026-09-14
review, tree-7015c6fe node #235), re-attacked against `docs/hopper/UNBLOCKER.md`
and Kevin's ask ("must NOT cascade unbounded", "only when we have the power to do
so"). All five original findings hold under re-probe (R1–R9 green, `unblocker:sim`
6/6). The fix pass introduced two new defects and left one recursion door open.
Probes R10–R14 appended to `darwin-assistant/scripts/unblocker-adversarial-sim.mjs`
(`JARVIS_DB_PATH=/tmp/unblocker-adv-223b.db node scripts/unblocker-adversarial-sim.mjs`
after `npm run build`); result **12/15 — R10, R11, R12 fail**. Scratch sqlite only;
live jarvis.db and jarvis.service untouched.

### MUST FIX

1. **A pass never leaves `running`, so the new concurrency cap becomes a
   permanent lockout: the feature works exactly once per DB lifetime (HIGH).**
   No statement in the engine transitions `hopper_unblock_passes` to `done`
   (`grep "status = 'done'"` → nothing; nothing runs after
   `await processMessageRef(...)` in `spawnSmartUnblockerWorker`; the spawn
   reconciler never touches the table). `runningUnblockPassCountStmt` therefore
   counts every pass ever spawned, forever. With the default
   `unblocker_max_concurrent=1`, the FIRST unblocker spawn holds the only slot
   for the rest of the service's life. Probe R10: tree A blocks → unblocker
   spawns → FIX planted → FIX done → original done → **tree A = `done`, pass A
   = `running`**; unrelated tree B blocks with the gate wide open → pass B
   parked `waiting_for_juice`; 5 sweeps later still 1 spawn. The success path
   is the lockout path — the better the unblocker works, the sooner it stops
   working. The only exits from `running` today are `needs_kevin` (a FIX or
   re-pended node blocking again) and the spawn-fail reset. Contract state
   flow says `fixable: … pass done`. **Fix:** mark the pass `done`
   (`finished_at`, `result` = the worker's final text) when
   `processMessageRef` resolves — and, belt-and-braces, in `sweepWaiting…`/
   `maybeTrigger…` treat a `running` pass whose node is no longer `blocked`
   (re-pended/done) or whose worker thread is not running as settled. Add R10
   as a permanent check (`spawns === 2`).

2. **Recursion via `split`: FIX-node children carry no `remediation_of`, so
   every split re-arms the unblocker (HIGH — the exact cascade the ask
   forbids).** `finishHopperNode`'s `split` branch inserts children with
   `(tree_id, parent_id, title, spec, status, depends_on, adapter, model)` —
   `remediation_of` is not inherited. A FIX node that finishes `split` (a
   perfectly legal outcome for a worker whose fix is "too big for one worker")
   produces unmarked children; a child that blocks passes the finding-1 guard,
   has no pass row of its own, and spawns a fresh Opus unblocker, which plants
   FIX nodes for the child, which can split again… Probe R11 (cap raised to 10
   so #1 doesn't mask it): root block → 1 spawn; FIX→split→child-blocks ×4 →
   **5 unblocker spawns, `child.remediation_of = null` at every level**. Today
   #1 accidentally caps this at one (the lockout), so fixing #1 alone makes
   this live. **Fix:** in the `split` insert, copy `node.remediation_of` onto
   every child (and do the same anywhere else nodes are derived from an
   existing node — check `retryHopperNode`/foundry planting for the same
   pattern). Optionally refuse `split` on a node with `remediation_of` set
   (a FIX leaf that can't fit one worker is a signal for needs_kevin, not a
   subtree). Keep R11 as a permanent check.

3. **Spawn-failure retry is an unbounded microtask storm, not "one attempt per
   tick" (HIGH — event-loop stall + notification flood).** Finding-4's fix
   resets the pass to `waiting_for_juice` and calls
   `queueMicrotask(() => dispatchTick('unblocker_spawn_failed_retry'))`. The
   next tick's sweep re-claims the same row and re-spawns immediately; if the
   failure is deterministic (model unavailable on the plan, CLI/auth broken,
   prompt over the window — `processMessage` **rethrows** on any adapter
   crash, `agent.ts` "Fix C") the cycle is
   catch → reset → `createNotification` → microtask tick → sweep → claim →
   spawn → throw, with **no timer between iterations and no attempt cap**.
   Probe R12 unbounded: the sim wrote **493,299 `Hopper unblocker failed to
   start` notifications** into the scratch DB and >64 MB of stack traces to
   stderr before I killed it; the bounded re-run (hook fails 200×) shows 201
   attempts / 200 error bells inside 9 ticks. In prod each iteration also
   emits an SSE `notification` event and a `spawn_tasks` row — a broken model
   id in `unblocker_model` (e.g. `claude-fable-5` on a plan without Fable)
   would take the cockpit bell and the event loop down within seconds of the
   first red block. **Fix:** (a) persist an attempt counter on the pass row
   (`spawn_attempts`), cap at 2–3, then mark the pass `failed` + one bell and
   stop; (b) drop the `queueMicrotask(dispatchTick)` from the catch — the 60s
   timer / next finish is the right retry cadence, and add a minimum backoff
   (`retry_after`) the sweep honors; (c) dedupe the error bell per node.
   R12 stays as a permanent check (`attempts <= 2`, bounded hook).

### SHOULD FIX

4. **The playbook's "never restart / never deploy" rails are prompt-only for the
   one worker most likely to reach for them (MEDIUM).** `buildToolsBlock()`
   takes no thread argument and nothing in `agent.ts`/`tools/` keys on
   `cockpit:unblocker-*`, so the unblocker thread is a full JARVIS persona
   with `cockpit_deploy`, `intake_deploy`, `shim_deploy_*` mounted plus a
   shell (`systemctl restart jarvis.service` is one Bash line). Same posture
   as every hopper worker today, so not blocking on its own — but this worker
   is spawned specifically to "unstick" things at Opus tier, and the last two
   reviews both flagged it. **Fix:** a `WORKER_DENIED_TOOLS` set applied in
   the tool dispatcher (refuse + log) and stripped from the tools block for
   `cockpit:unblocker-*` and `cockpit:hopper-node-*` threads; the shell
   side stays a prompt rail (sandboxing the CLI is out of scope here).

### Held under re-probe (no change needed)

- Recursion via FIX-node blocks (R1) and re-pended-original blocks (R8) → one
  spawn, `needs_kevin` on the ROOT pass, one bell. R14 adds the by-hand case:
  FIX planted while the root's pass was only `waiting_for_juice` (gate was
  closed) → FIX blocks → root pass `needs_kevin`, 0 spawns, 1 bell, no crash.
- Juice gate: stale usage file holds (R6); `claude 5h == unblocker_max_5h`
  holds and parks a marker (sim 3); governor hold parks; unknown 5h holds.
  `gov_override_*` is still not on this branch — the earlier caveat stands.
- Model allowlist: `unblocker_model` = sonnet / gpt-6-astra / garbage →
  `claude-opus-5` (R7a, sim 4); `opus4.8` with Auggie frozen → claude/opus-5
  (R7b); FIX leaves on `claude-fable-5-1` / anything outside
  `FIX_LEAF_MODEL_ALLOWLIST` rejected in both the engine and the route (R2).
- `blocked_question` never triggers (sim 5) and `/remediate` refuses it (R9);
  lease-exhausted blocks neither spawn nor park a marker (R13, per contract).
- Double-spawn on concurrent finishes: `finishHopperNode` →
  `maybeTriggerSmartUnblocker` → pass INSERT is synchronous before any yield,
  and `UNIQUE(node_id)` backs it; the cap check + insert can't interleave from
  the tick path (`ticking` guard) or the finish path (same synchronous frame).

Nit: every sweep re-logs `[hopper-unblocker] hold node N: …` and bumps
`updated_at` for each parked row, per tick — with #1 parking everything
forever that's N log lines + N writes every 60s; goes away with #1 but worth
a quiet-after-first-log guard regardless.

Repro: `darwin-assistant/scripts/unblocker-adversarial-sim.mjs` R10–R14 (this
commit). Scratch DBs `/tmp/unblocker-adv-223b.db` (bounded run) — the
unbounded R12 run's DB was discarded after counting.

## 2026-09-17 · Smart Unblocker re-review remediation (Claude B) — 3 must-fix + 1 should-fix resolved

Follow-up to the 2026-09-15 re-review above (node #223 re-run, BLOCKED 12/15).
Branch `hopper/smart-unblocker`, same worktree. All engine changes in
`darwin-assistant/src/hopper-engine.ts`; the tool denylist in
`darwin-assistant/src/agent.ts`; one contract-changed sim check in
`darwin-assistant/scripts/unblocker-adversarial-sim.mjs`. Additive/idempotent
ALTERs mirror the existing `remediation_of` / `hopper_unblock_passes` pattern.
Verified: `npm run build` clean; `npm run unblocker:sim` 6/6; adversarial sim
**15/15 (was 12/15)** with R10/R11/R12 now green; `finishline:sim` 25/25
(unaffected). Scratch DBs only (`/tmp/unblocker-adv-remediated.db`); live
jarvis.db and jarvis.service never touched. R12 run BOUNDED only (failing hook
capped at 200; observed attempts=1 — the unbounded 493k-bell variant was never
run).

1. **MUST-FIX (HIGH) — pass never left `running` → permanent one-shot lockout.**
   `spawnSmartUnblockerWorker` now captures the worker's final text and calls a
   new `markUnblockPassDoneStmt` (status→`done`, `finished_at`, `result`, guarded
   `WHERE status='running'`) the moment `processMessageRef` resolves, releasing
   the concurrency slot. Belt-and-braces: `reconcileStuckUnblockPasses()`
   (backed by `reconcileStuckRunningPassesStmt` — a JOIN that finds `running`
   passes whose node is no longer `blocked`) settles orphaned rows; it runs at
   the top of `sweepWaitingUnblockPasses()` and just before the concurrency
   count in `maybeTriggerSmartUnblocker`. Adversarial R10 now passes (tree A
   done → pass A `done`; unrelated tree B block → 2nd spawn; `spawns===2`).
   Files: `hopper-engine.ts` ~L411 (stmt), ~L438 (reconcile stmt), ~L940
   (resolve→done), ~L1055 (reconcile before count), ~L1103 (reconcile helper +
   sweep).

2. **MUST-FIX (HIGH) — recursion via `split`: FIX children carried no
   `remediation_of`.** `finishHopperNode`'s `split` insert now includes the
   `remediation_of` column and copies `node.remediation_of ?? null` onto every
   child, so a FIX node that splits keeps its whole subtree bound to the ORIGINAL
   node's one-pass fuse (already flat-walked to the root at plant time). Audited
   the other node-derivation sites: `appendHopperRemediationNodes` already
   stamps it; `retryHopperNode` reuses the same node (column preserved by
   `setNode`); `createHopperTree` (L1386) and the finish-line audit insert
   (L376) create fresh top-level nodes where `remediation_of=NULL` is correct —
   neither is derived from a blocked node, so no change. Adversarial R11 now
   passes (root→FIX→split→child-blocks ×4 → `spawns===1`, `child.remediation_of`
   non-null [=20] at every level). File: `hopper-engine.ts` ~L1620.

3. **MUST-FIX (HIGH) — spawn-failure retry was an unbounded microtask storm.**
   (a) Added additive/idempotent columns `spawn_attempts INTEGER NOT NULL
   DEFAULT 0` and `retry_after TEXT` to `hopper_unblock_passes`. (b) The catch in
   `spawnSmartUnblockerWorker` now counts the attempt: under the cap
   (`unblocker_max_spawn_attempts`, default 2) it resets to `waiting_for_juice`
   with `spawn_attempts+1` and a `retry_after` backoff (`datetime('now', '+N
   seconds')`, `unblocker_spawn_backoff_seconds` default 60) and fires NO bell;
   at the cap it calls `markUnblockPassFailedStmt` (status→`failed`) and fires
   exactly ONE terminal bell, then stops (a `failed` row is never re-swept). (c)
   Dropped the `queueMicrotask(dispatchTick)` from the catch — the 60s dispatch
   timer / next finish is the retry cadence. (d) `waitingUnblockPassNodeIdsStmt`
   now honors the backoff (`AND (retry_after IS NULL OR retry_after <=
   datetime('now'))`) so the sweep can't re-claim a failing row within its
   window; error bell deduped to the single terminal `failed` transition.
   Adversarial R12 now passes BOUNDED (deterministic failure → attempts=1 across
   9 ticks, 0 storm bells, pass parked `waiting_for_juice` behind its backoff).
   Files: `hopper-engine.ts` ~L300 (ALTER), ~L162 (row type), ~L411/~L446
   (stmts), ~L434 (sweep selector), ~L768 (config helpers), ~L937 (catch).

4. **SHOULD-FIX (MEDIUM) — deploy/restart tools were prompt-only for the
   unblocker persona. DONE (both halves).** Added `WORKER_DENIED_TOOLS`
   (`cockpit_deploy`, `intake_deploy`, `shim_deploy_switch/approve/reject/status`)
   and `isDeniedToolThread(externalId)` (matches `cockpit:unblocker-*` and
   `cockpit:hopper-node-*`) in `agent.ts`. `buildToolsBlock(externalId?)` strips
   the denied tools from the tools block for those threads (threaded through
   `buildInitialPrompt` / `buildContinuationPrompt` / `buildPromptForNewSession`
   via `conv.external_id`), and the tool dispatcher refuses+logs any denied call
   from such a thread before execution (defence in depth for an internal caller
   or a hallucinated tool name). The shell rail (`systemctl restart`) stays
   prompt-only, per the review (CLI sandboxing out of scope). File: `agent.ts`
   ~L583 (set/helper/buildToolsBlock), ~L654/~L1423/~L1442 (threading),
   ~L1547 (dispatcher refusal).

**Contract-behavior change flagged (mirrors the prior pass's check-3 note):**
adversarial check **R3** legitimately changed. Its old assertion `spawns <= 1`
was only true while finding-1's bug held a finished pass's slot forever; once a
pass gets a `done` transition, a completed (instant, in the sim) fake worker
frees the slot and the next parked sibling runs on a later tick. R3 now asserts
the REAL invariant — at the instant of the simultaneous burst, exactly ONE
spawned and ≥4 siblings parked `waiting_for_juice` (the cap governs *concurrent*
workers, not the lifetime total). The evidence line shows cumulative spawns
climbing after the tick as parked nodes run serially, which is correct.

Residual notes / not closed:
- The read-then-insert on the concurrency count is still un-transactioned; same
  reasoning as the prior pass (single-threaded Node + `ticking` guard serialize
  the two call paths). The new `reconcileStuckUnblockPasses` only ever moves a
  pass `running→done` when its node left `blocked`, so it can't race a fresh
  claim into a bad state.
- `unblocker_max_spawn_attempts` / `unblocker_spawn_backoff_seconds` have no
  settings-UI surface yet (same posture as every other `unblocker_*` KV).
- The re-review's log-spam nit (every sweep re-logs each parked row) is largely
  moot now that finding-1 stops parking everything forever, but the per-tick
  `console.log` on a still-held row remains — left as-is (cosmetic).
