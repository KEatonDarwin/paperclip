# Finish-Line Gate — Scratch-Server Lifecycle Proof

Tree: `tree-6097474e`, node #183 (SIM: scratch-server lifecycle proof).
Worktree: `/home/kevin/paperclip-worktrees/finish-line` (branch `hopper/finish-line-gate`).

Proves the two BUILD deliverables (`05745feec` finish-line engine/API change,
`a0ba94e99` first-turn continuity injection) end-to-end, against a real
scratch HTTP server + a scratch sqlite DB — never the live service or the
live `jarvis.db`.

## What was actually run

```
cd darwin-assistant
npm run build            # tsc, clean
npm run finishline:sim   # Scenarios A, B, D — new script
npm run continuity:test  # Scenario C — pre-existing script from the BUILD task
```

Both scripts guard against a live DB path and refuse to run if
`JARVIS_DB_PATH`/default resolves to `/home/kevin/paperclip/darwin-assistant/jarvis.db`.
`finishline:sim` additionally refuses to bind the live UI port (3201).

## Architecture of the proof

`scripts/finishline-sim.mjs` (new, committed, wired as `npm run finishline:sim`):

- Sets `JARVIS_DB_PATH=/tmp/finishline-sim-<pid>.db` (fresh, deleted first —
  matches the existing `foundry-sim.mjs`/`continuity-injection-test.mjs`
  convention of a **fresh scratch path**, not a copy of the live DB. A fresh
  DB gets the full real schema via `conversation-db.ts`'s own boot
  migrations, so nothing is lost by not copying; copying the live 310MB
  `jarvis.db` would only add I/O time and drag in irrelevant rows/settings
  for a mechanics-only test.
- Sets `JARVIS_UI_PORT=39221` (refuses 3201), `HOPPER_GOV_ENABLED=0` (governor
  gating is out of scope for this proof — already covered by
  `governor-v2-sim.mjs`), `HOPPER_ENGINE_SLOTS=4`.
- Dynamically imports the **compiled** `dist/hopper-engine.js`,
  `dist/ui-server.js`, `dist/api-keys.js`, `dist/conversation-db.js` — so this
  drives the same code a deployed restart would run, not `tsx`.
- Calls `hopperEngine.startHopperEngine(fakeProcessMessage)` with a **fake
  worker** (no model calls — mirrors `foundry-sim.mjs`'s pattern exactly): a
  normal leaf node is auto-finished `done` immediately; a `FINISH-LINE AUDIT`
  node runs the scenario-specific verdict logic a real audit worker would run.
- Calls `uiServer.startUiServer()` with **no Slack app** — `index.ts` is never
  imported, so Slack/checkin-worker/thread-reminders/monitors never start
  regardless. This is a real `express` server bound to the scratch port,
  serving the real `/api/v1/*` router (`createApiV1Router()`), including the
  hopper routes.
- Mints its own scratch bearer key via `apiKeys.mintApiKey(...)` against the
  scratch DB (no dependency on the real `JARVIS_COCKPIT_KEY`).
- Drives every scenario over **real HTTP** (`fetch` against
  `http://127.0.0.1:39221`) — `POST /hopper-trees`, `POST
  /hopper-trees/:id/agree`, `POST /hopper-nodes/:id/finish`, `GET
  /hopper-trees/:id` — the same contract a real planner chat or a real
  spawned worker's `curl` uses.

## Scenario A — FULL verdict

1. `POST /hopper-trees` with `original_ask` set, one trivial node. Tree lands
   `draft`.
2. `POST /hopper-trees/:id/agree`. Dispatch claims the leaf; fake worker
   reports `done` over the real finish endpoint.
3. **Asserted: the server auto-appends a `FINISH-LINE AUDIT` node** once the
   leaf settles, with `parent_id = null` (the leaf-only-dispatcher rule).
4. Fake worker recognizes the audit prompt, finishes it `done` with
   `{"finishline_verdict":"FULL", ...}` over the real finish endpoint.
5. **Asserted: the tree completes** (`status: 'done'`) and a `🏁 finish-line:
   FULL` notification row exists in `notifications` (source
   `hopper-engine`).

All 5 checks (A-1..A-5) passed.

## Scenario B — SHORTFALL verdict, continuation planted + agreed

1. `POST /hopper-trees` with a different `original_ask`, one trivial node
   that (per the sim's own script) intentionally leaves a gap.
2. Agree → leaf finishes → audit node auto-appends (same mechanics as A).
3. Fake worker recognizes the audit prompt for this tree's scenario and, per
   the real contract the audit prompt itself specifies, **plants a real
   continuation tree over HTTP** (`POST /hopper-trees` with
   `continuation_of: <parent id>`, same `original_ask`, a
   `deferred_scope` naming the gap), **agrees it** (`POST
   /hopper-trees/:newId/agree`), then finishes the audit node `done` with
   `{"finishline_verdict":"SHORTFALL", "continuation_tree_id": "<newId>", ...}`.
4. **Asserted: the continuation tree exists**, `continuation_of` links back to
   the parent tree id (the depth marker used by `continuationDepth()`),
   `original_ask` carried over verbatim, and it holds the one planted node
   (`Close the sim gap`).
5. **Asserted: a `⚠️ finish-line: SHORTFALL` notification row exists**,
   naming the continuation tree.

All 4 checks (B-1..B-4) passed.

**Real second-order behavior surfaced by this scenario (not a bug, confirmed
against `FINISHLINE-DESIGN.md`):** the continuation tree inherits the same
`original_ask`, so once its own leaf finishes, the finish-line gate fires on
*it* too — the continuation gets its own `FINISH-LINE AUDIT` node. The sim's
fake worker registers the continuation tree for a clean `FULL` close so this
second audit doesn't hang; production behavior is unchanged, this is just
the sim acknowledging a real recursive property of the design instead of
special-casing it away.

## Scenario D (bonus, cheap to add) — depth cap enforced at plant time

Chains three `continuation_of` links directly through the real `POST
/hopper-trees` endpoint (no audit worker involved — this tests the plant-time
guard in `handlers/api-v1.ts`, not the prompt-level instruction to an audit
worker):

- depth 1 (`continuation_of` → root): plants fine.
- depth 2 (`continuation_of` → depth 1): plants fine.
- depth 3 (`continuation_of` → depth 2): **rejected — `409
  finishline_depth_cap`**, `"finish-line continuations are capped at depth
  2"`.

1 check (D-1) passed.

## Scenario C — first-turn continuity injection

Ran the existing `scripts/continuity-injection-test.mjs` (built by the
dependency BUILD task, not new here) via `npm run continuity:test`, against
its own separate scratch DB. It drives `buildPromptForNewSession` /
`shouldInjectContinuityBoot` directly (function-level, per the task's own
allowance — spinning a full conversational turn for this would only re-prove
plumbing the function-level test already proves):

- A genuinely first turn (`turns.length === 1`, no prior assistant turn) on a
  normal `cockpit:*` thread gets the `## JARVIS Continuity (auto-loaded,
  first turn)` header injected, containing real content pulled from
  `skills/jarvis-continuity/SKILL.md` (asserted via a `Layer 3` sentinel line
  read from the live file, not a hardcoded string).
- A second turn on the same thread does **not** get the header or the
  SKILL.md content re-injected.
- `quick:*` and `cockpit:hopper-node-*` threads (worker threads — this very
  conversation is one) skip injection even on their first turn, matching
  `shouldInjectContinuityBoot`'s explicit exclusion list.

Output: `ALL CHECKS PASSED`.

## Full result summary

| Scenario | Checks | Result |
|---|---|---|
| A — FULL verdict | A-1..A-5 (5) | 5/5 PASS |
| B — SHORTFALL + continuation | B-1..B-4 (4) | 4/4 PASS |
| D — depth cap at plant time | D-1 (1) | 1/1 PASS |
| C — first-turn continuity injection | 4 assertions in `continuity-injection-test.mjs` | ALL CHECKS PASSED |

**10/10** `finishline-sim.mjs` checks passed. **ALL CHECKS PASSED** on the
continuity injection test. `tsc` clean. `git diff --check` clean.

## Cleanup

- Scratch DB files (`/tmp/finishline-sim-*.db`,
  `/tmp/continuity-injection-test-*.db`) deleted after the run.
- Verified no process left listening on the scratch port (39221) after the
  script exited (`process.exit()` at the end of `finishline-sim.mjs`, same
  pattern as `foundry-sim.mjs`).
- Verified the live `jarvis.db` mtime predates this run (untouched) — this
  sim never opens it; `JARVIS_DB_PATH` is guarded and always overridden to a
  `/tmp` path before any `dist/` module (which opens its DB handle at import
  time) is imported.

## Files touched by this task

- `darwin-assistant/scripts/finishline-sim.mjs` (new)
- `darwin-assistant/package.json` (+ `finishline:sim` script entry)
- `SIM-RESULTS.md` (this file)
