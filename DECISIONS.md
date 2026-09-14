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
