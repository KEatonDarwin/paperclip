# GUARDS v0.2 — adversarial review (node #479, 2026-09-19)

**Verdict: PASS with fixes (applied in place).** Backend `hopper/goals-guards` + UI `hopper/goals-guards-ui`
reviewed against CONTRACT §12 + GUARDS.md + GUARDS-RECON.md. Sim `npm run goals:sim` = **107/107** (104 shipped
+ 3 review checks R-1..R-3); `npm run goals:guards-check` = 23/23; backend `tsc` clean; cockpit `eslint` clean on
every touched file + production build (node-server preset) green. Not merged, not deployed.

## Hunt list (from the review spec) → finding

| Hunt | Result |
|---|---|
| Guard written to Overwatch before Kevin's ✓ | **PASS.** `proposeGuard` never touches Overwatch (sim G-1b asserts `createBodies` unchanged); only `acceptGuard` (route 34, Kevin's click) calls `createRule`. The `goals` tool has no accept op. |
| Cue storms — poller cues on state CHANGE only | **PASS.** `setHealth` compares `prev !== newHealth`; unchanged → `last_*` stored silently, no event/SSE/cue (G-4c). `unknown→passing` is SSE-only, no cue (G-4a). Genuine flapping (fail↔ok every tick) cues each flip — that is the contract (§12.7 "on change"); accepted, noted as a v1 debounce candidate. |
| Error flapping must not spam | **PASS.** Transient GET failures leave `health` untouched (§12.7); staleness flips to `error` once (`markGuardStaleIfNeeded` skips when already `error`); a later stale-but-ok reading is still `error` (no flip). |
| Poller / webhook throwing into request handlers | **PASS.** `goals-overwatch.ts` never throws (returns `{ok:false,status,error}` incl. timeout/DNS → status 0); the poller tick is `.catch`-wrapped and self-reschedules in `.finally`; webhook handler is synchronous + wrapped by `applyGuardHealthByKey` which returns boolean. |
| Guard SQL executed locally | **PASS.** `grep` for any `prepare(`/`exec(` over `row.sql`/`guard.sql` → none. SQL only ever leaves via `createRule`/`patchRule` payloads; Overwatch's `ReadOnlyQuery::normalise` validates it. |
| Webhook secret compare not constant-time | **PASS.** `checkWebhookSecret` = sha256 both sides → `timingSafeEqual` (fixed-length, no length leak). Unset → 503, wrong/missing → 401, exempt from bearer only for `POST /goals/guards/webhook` (exact path, registered before the `:id` routes so it can't be shadowed). |
| Import cycles at module load | **PASS.** `goals-guards → goals`, `goals-tool/api-v1 → goals-guards`, `sse-bus → goals-guards` is `import type` only (erased). `goals.ts` reads `goal_guards` directly, never imports the guards module. `agent.js`/`thread-message-queue.js` are dynamic imports at cue time. |
| Guarded ALTERs safe on the live DB | **PASS.** §12.1 is `CREATE TABLE IF NOT EXISTS` + `CREATE (UNIQUE) INDEX IF NOT EXISTS` only; no ALTER; `goal_events.kind` has no CHECK so the `guard_*` kinds insert fine. Ran twice against the same scratch DB (guards-check + sim both boot on an existing file) with no error. |
| UI losing an in-progress edit on SSE refetch | **PASS after fix.** Inputs are uncontrolled (`defaultValue`) so a refetched `guard` object doesn't clobber typing; **fixed**: the card is now `key={guard.id}` so a NEW guard on the same node (discard → re-propose, G-6b) remounts with fresh values instead of showing the dead guard's SQL. |
| 'Not configured' path leaving a guard the UI can't explain | **PASS after fix.** accept → `503 overwatch_not_connected`, guard stays ghost, toast + sticky banner. **Fixed**: (a) `GET /goals/:id/guards` now returns `overwatch_connected` (additive) so the banner shows on load, not only after a click; (b) discarding a SET guard while unconfigured now stamps `last_summary='overwatch delete skipped: Overwatch not configured (rule may still exist)'` instead of silently orphaning the live rule (R-3). |

## Defects found + fixed

1. **Accept race (backend).** Two concurrent accepts (double-click / two tabs) both passed the `state==='ghost'` check before the awaited create → two live Overwatch rules, one orphaned with no local row. Fix: re-read the row after the await; if it is no longer `ghost`, fire a compensating `DELETE` on the rule we just created and return `409 invalid_transition`. Sim **R-2** (fake Overwatch with a 150 ms create delay): exactly one 200 + one 409, two creates, one delete, winner's key intact.
2. **Node guard description borrowed the GOAL's done_means** when the node had none (`node?.done_means ?? goal?.done_means`). Fix: node guard → node's done_means or title; root guard → goal's. Asserted in R-2.
3. **Discard of a set guard while unconfigured silently skipped the Overwatch DELETE** (rule left behind, nothing recorded). Fix above (R-3).
4. **Tool `propose_guard` defaulted `node_id` to the ROOT** when omitted — inside a goal thread that always 409s (`node_not_verifiable`) until the whole goal is done, and JARVIS naturally omits it for "the node we're on". Fix: omitted → current focus (mirrors `propose`'s `parent_id`); explicit `null` → root.
5. **UI: set guards were read-only** (`disabled={!isGhost}`), contradicting §12.4 route 33 / GUARDS.md ("Kevin can edit the SQL/threshold inline … a set guard's knobs may still be PATCHed → pushed to Overwatch"). Fix: editable; blur PATCH; a `422 overwatch_rejected` surfaces as a clear toast and the row is unchanged (backend already guaranteed that, G-3b).
6. **UI: a done node's `opacity-60` dimmed the red failing ring.** Fix: no dim while its guard is failing/error.
7. **UI: card not keyed by guard id** (defect 8 in the table above).
8. **UI: banner only after a click** (defect 9 above) + wording now names the two env vars.

## Checked and left as-is (with reasons)

- `PATCH` merge on Overwatch drops `null` values (`array_filter`), so clearing `value_column`/`sample_columns` to null on a set guard won't clear it there. v0: Kevin re-sets a value instead; noted, not worth a PATCH-then-verify round trip now.
- `401`/`503`/status-0 from Overwatch all map to `overwatch_not_connected` on accept/patch. A wrong key reads as "not connected" but the message carries Overwatch's own error text; the UI banner names the env vars. Fine for v0.
- Poller reads `goal_guard_poll_min` each tick via uncached `getSetting` — a live change applies on the next tick, as specified.
- `overwatch_rule_id` stays NULL (recon: the API keys by string). `dashboard_url` is the base `/overwatch` link (no per-rule deep link exists on that branch).
- The `goals` tool exposes `list_guards/propose_guard/discard_guard` only — accept is Kevin's click, by design (§12.5).
- `cockpit-api.ts` has ~84 pre-existing prettier findings (present at `d63d468`, before this tree) — not reformatted here to keep the diff reviewable.

## §12 row-by-row

| §12 row | PASS/FAIL | evidence |
|---|---|---|
| 12.1 DDL + column rules (one active guard/node, node state ∈ check/done, root only when goal done, mode-required fields at accept) | PASS | G-1a/1b/1c, G-2c (`guard_incomplete` path read; not exercised by sim — covered in guards-check) |
| 12.2 state machine + health mapping (ok/warn/fail/error/stale, ghost/discarded always unknown) | PASS | `computeHealth`, G-4a..4e, G-2d, `applyGuardHealth` early-return on non-set |
| 12.3 loop verify→propose→accept→watch→cue | PASS | tool description + G-2c + G-4b/4d/4e cue shapes match §12.6 verbatim |
| 12.4 routes 31–35 (+GET one, discard) incl. error codes | PASS (+ `overwatch_connected` additive on 31) | sim G-*, R-1; webhook G-5a..5d |
| 12.5 tool ops | PASS after fix 4 | goals-tool.ts |
| 12.6 cue text + correlation key `goal-guard:<goal>:<guard>:<event>` | PASS | `fireGuardCue`, enqueue-when-busy via the same seam as §11.3 |
| 12.7 poller (interval KV, sequential, degrade, staleness, one `applyGuardHealth` path) | PASS | `pollGuardsOnce` / `markGuardStaleIfNeeded`; webhook uses the same applier (G-5c) |
| 12.8 optional webhook | PASS | dormant until `GOALS_GUARD_WEBHOOK_SECRET`; 503 when unset |
| 12.9 SSE `goal_guard` + `goal` on count changes | PASS | FORWARD set, sse-bus union, sse-worker EVENT_TYPES; `touchGoal` → `goal` event on accept/discard/health flip (G-8a) |
| 12.10 event kinds | PASS | one event per write/flip; actor jarvis/kevin/system as specified |
| 12.11 counts + `<goal_tree guards_failing>` + 🛡/🛡✗ suffix, need_you unchanged | PASS | G-4b, G-7a, G-9a |
| 12.12 env contract / degrade | PASS after fix 3 | G-2a, R-1, R-3 |
| 12.13 acceptance 1–8 | PASS | all covered by sim [16] + guards-check |

## Deploy notes for JARVIS (not done here)
- Merge `hopper/goals-guards` (backend) + `hopper/goals-guards-ui` (cockpit); both are additive on v0.1 (`2f0760315` / `d63d468`). Cockpit build via the deploy script only.
- Until Kevin adds `OVERWATCH_API_URL` + `OVERWATCH_API_KEY` to darwin-assistant `.env`, everything works except the Overwatch write/read: proposals stay ghosts, the /goals banner says so. `GOALS_GUARD_WEBHOOK_SECRET` is optional (poller covers health).
- Settings-KV `goal_guard_poll_min` (default 10) tunes the poller live.
