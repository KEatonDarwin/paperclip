# WORKBENCH V2 — adversarial review (hopper node #452)

**Reviewer:** opus-5 worker, 2026-09-19. Last line before deploy.
**Scope reviewed:** full diff on `hopper/workbench-v2` (darwin-assistant, `99b80cb6d..2d6c56e5f`)
and `hopper/workbench-v2-ui` (jarvis-command-center, `9a84a02`), plus SPEC.md "V2 — THE
INTERACTION CORRECTION", RECON-V2.md, SIM-V2.md. Every click handler / `useEffect` in
`workbench.tsx` and `WorkbenchChatBar.tsx` traced by hand, not just by the sim's static scan.

## VERDICT: **PASS with fixes applied.** Deployable.

**Kevin's #1 complaint is fixed for real.** Click/zoom/render fire ZERO model calls and ZERO
thread creation — see §2. The v2 wiring is correct field-for-field (the v1 failure class did not
recur — the node #451 sim's real-client-source diff held up under a manual re-check).

What I found was a different class: the **enforcement gaps** — places where v2's promises
("attached to the node", "never accepts unprompted", "any >1 nodes is a proposal") were true
only as prose in a prompt or a tool description, with no code behind them. Six fixes, all
small, all covered by new sim checks (55 → **68/68 green**). No structural problems; nothing
blocked; nothing that needs a Kevin decision.

---

## 1. Fixes applied in this review

### 🔴 F1 — a dispatch worker had UNRESTRICTED tree-wide write scope
`POST /workbench/nodes/:id/dispatch` spawns a worker on a fresh `cockpit:workbench-worker-…`
thread. `resolveWorkbenchToolScope()` only knew one binding — `linked_thread_ext` — so the
worker resolved to **root scope** and could `set_status`/`write_context`/`move`/`split` any
node on the board. Its prompt says "keep every write scoped to THIS node id" — prose only.
The backend node's own comment even documented this as intended ("an unbound/unscoped thread
gets unrestricted root scope"). That contradicts SPEC.md's "a worker … attached to the node"
and is exactly the "runaway scope" this review was told to hunt.
**Fixed:** `spawn-tasks.ts` gained `getSpawnTaskByThreadExt()`; `resolveWorkbenchToolScope`
falls through to it and binds the thread to `spawn_tasks.workbench_node_id`'s subtree — the
same mechanical guard v1 per-node chats have. A worker whose node was deleted mid-run gets an
**empty** scope (not root). Sim: worker refused outside its node, allowed on its own node,
`list_scope` resolves `focus_id` = dispatched node.

### 🔴 F2 — `split` bulk-wrote real nodes around the ghost layer (the SIM's open finding)
SPEC.md: "any creation of >1 node MUST be a proposal … never add_child/split." `add_child` is
single-node by shape, but `split` wrote N real nodes directly; the rule lived only in the tool
description. A brain turn that ignored the instruction could bypass the entire correction
layer — the half of Kevin's ask that is "have me correct what is done if it's done wrong."
**Fixed:** `split` with >1 total item (counting nested children) is redirected in code to
`proposeBatch()` under the target node and returns `{ok, proposed: true, batch_id, proposals,
note}`; exactly one child still writes directly (the "single node he explicitly asked for"
carve-out). Tool description updated to say so. Sim: 2 children → 2 ghosts, 0 real rows; 1
child → direct.

### 🟠 F3 — the brain could accept its own batch in the same turn it proposed it
"His utterance is the gate; the brain never accepts unprompted" was prompt-only. Nothing
stopped one turn from calling `propose_batch` then `accept_batch` back-to-back — Kevin would
never see a ghost. **Fixed (the mechanical half):** proposals now stamp `created_by_message`
(the turn's `sourceMessageId`, additive column); `accept_batch` refuses when any row in the
batch was proposed by the *current* turn. A later turn (Kevin replied) or Kevin's own click on
the page still accepts. Also: a **scoped** chat (v1 per-node, or a dispatch worker post-F1)
can't `accept_batch` a batch that lands outside its branch, and can't accept a top-level batch.
The other half — "did Kevin actually say yes?" — is inherently prompt-level; documented as such.

### 🟠 F4 — one failed first send left a whole sitting seedless forever
`composeBrainSay` returned `seed_text` only when the *session row* was born. But the seed is
only DELIVERED by the client's follow-up `POST /threads/:ext/messages` (2-step). If that POST
fails (network, 5xx), the session already exists, the next `/say` returns `seed_text: null`,
and the brain runs the entire sitting with no tree digest and no instructions — silently.
**Fixed:** seed is keyed off the *conversation* (`countTurns(conv.id) === 0`), not the row: as
long as nothing has reached the model, `/say` re-issues it. Idempotent once a turn exists.
The sim now performs the real client step 2 (posts through the fake claude) before asserting
"second say reuses, seed null" — it never had before.

### 🟡 F5 — orphaned proposals were invisible and immortal
Delete a node that has a pending ghost batch under it: the UI keys ghosts by
`parentNodeId`, so the batch stops rendering anywhere, but stays in `GET /workbench/proposals`
forever and `accept` 400s on it. `smart-todos.ts` is off-limits (byte-for-byte), so a delete
cascade can't live there. **Fixed:** `listPendingProposalBatches()` prunes any batch whose
real parent no longer exists (deletes rows, emits `workbench_proposal rejected`). Lazy, on
the poll the page already does every 8s.

### 🟡 F6 — the per-node "Open chat" deep-dive was blind (honest-gap item, see §4)
v2 correctly stopped auto-posting the seed on open. But the UI then just *dropped* the
`seed_text` the route returns — the per-node chat's JARVIS had no idea what branch it was
scoped to, what's in it, or that the `workbench` tool exists, until a refusal told it.
That's a regression from v1 for the one per-node surface that survived. **Fixed the durable
way:** `buildWorkbenchThreadContext(ext)` in `workbench.ts` + one line in `agent.ts` next to
the existing `buildQuickChatContext` — a `<workbench_scope>` block (v1 seed content, capped
6k chars) injected **every turn** for threads bound via `linked_thread_ext` with a
`cockpit:workbench-<uuid>` ext. Returns `''` for brain sessions (they carry their own seed),
dispatch workers (prompt carries it), `/tree`'s `cockpit:tree-*` chats, Slack, everything
else — guarded by a string check before any DB hit, wrapped in try/catch. Always-current
beats a one-time seed anyway (the v1 DECISIONS.md D3 gap closes with it too).

---

## 2. Kevin's #1 complaint — traced, not assumed

Every interaction in `workbench.tsx` / `WorkbenchChatBar.tsx`, what it does on the network:

| Interaction | Network | Model call / thread creation? |
|---|---|---|
| Click row title / breadcrumb / Zoom-in / zoom-out / Esc | `navigate({search})` only | **none** |
| Page mount | `GET /smart-todos`, `GET /workbench/proposals`, `GET /workbench/session` (read-only, never touches `last_activity_at`), then `GET /threads/:ext` only if a session is already open | **none** |
| 8s poll + SSE (`smart_todo`, `workbench_proposal`) | same two GETs | **none** |
| NodeRow mount | `GET /workbench/nodes/:id/dispatch` (indexed read) | **none** |
| Status dot, title/notes edit, move/indent/delete, add sub-item | `PATCH`/`POST /smart-todos/*` | **none** |
| Jot bar submit | `POST /workbench/jot` | one local-claude placement one-shot — v1 behaviour, **on submit only**, Kevin's locked fork (b) |
| Ghost ✓ / ✕ / Accept all / Reject all | `POST /workbench/proposals/:batch/{accept,reject}` | **none** |
| ▶ Dispatch (opens a form) | none until **Dispatch** is pressed → `POST …/dispatch` | worker spawned **only on the explicit button** |
| "Open chat (full window)" | `POST /workbench/:id/open-chat` (find-or-create the conversation ROW) + `window.open` | thread row yes, **model call no** — seed is no longer auto-posted; Kevin's first message in that window starts the first turn |
| Brain bar "New session" | none — arms `forceNewRef` for the next send | **none** |
| Brain bar send | `POST /workbench/say` → `POST /threads/:ext/messages` | **the one and only** place a turn starts, from the composer's submit |

The v1 defect (`useEffect` keyed on the focus id calling `openWorkbenchNodeChat` +
`sendMessage(seed)`) is gone — the file has no thread-binding effect at all. Verified by
reading every `useEffect` (there are 6: data load/poll/SSE, Esc key, two draft syncs, dispatch
status check, and none touch threads), on top of the sim's static scan.

**One deviation from the spec's letter, accepted:** spec says "Open chat … creates the thread
ON FIRST SEND." The UI creates the *conversation row* on open (so it has an ext to open a
window on) and posts nothing. No model call, no "starts to think" — the spirit is met; the
alternative needs a "thread that doesn't exist yet" mode in the shared `/thread/$ext` window.

---

## 3. Everything else I hunted, and what I found

**Sessions.** Reuse-vs-idle-vs-`force_new` correct; at most one open session (`endOpenSessions`
before insert). Focus header fires on change only, using the server-stored `last_focus_id` —
so it's correct across tabs and reloads, not just within one page's memory. Two tabs: both
resolve the same session on mount; if tab A forces a new one, tab B's next `/say` lands on the
new session automatically (server-side find-or-create) and the bar re-points
(`if (say.externalId !== externalId) setExternalId`). Fast zooming between sends: `focusId` is
read at send time from the closure — the pointer sent is whatever's zoomed at the moment of
submit, which is the right semantics. **Minor, not fixed:** `last_focus_id` is stamped at
`/say` time, before the client's POST — a failed POST after a focus change loses that one
header (next message at the same focus omits it). Harmless; the brain can `list_scope`.
**Minor, not fixed:** `/workbench/say` always mints a `cockpit:` ext regardless of caller —
a non-admin API key would get a thread it can't post to (403). The whole workbench surface is
cockpit-only today; note it if the prompt API ever grows a workbench client.

**Ghost layer.** Accept is transactional (all-or-nothing), resolves nested parents top-down by
id (guaranteed topological by insert order), pulls ancestor chain in on partial accept, cascades
descendants on partial reject, throws (→ 400) rather than materializing under a missing parent.
Duplicate materialization impossible: rows are deleted inside the same transaction; better-sqlite3
is synchronous so two clicks can't interleave. Accept path is ONE function for both HTTP and
the tool (`acceptProposalBatch`) — no drift. Not carried: proposal `sort_order` on accept
(materialized nodes append in id order, which equals proposal order for a full accept; a
child-first partial accept can reorder siblings). Cosmetic.

**Dispatch.** Model is explicit every time (`getSetting('workbench_dispatch_model') ||
'claude-sonnet-5'`), stamped on both the thread override and the `spawn_tasks.model` column —
never NULL, never inherited (the One Rule holds; the hopper engine's own insert doesn't stamp
`model`, this one does). Reconciler-compatible: `jarvis-spawn-reconcile.py`'s generic sweep
reads only `thread_ext`/`status`/`turn_count`/`created_at`; `hopper_node_id` is null so the
hopper finish-recovery path is skipped; `workbench_node_id` is an additive column the script
never touches. 409 guard checks `status === 'running'` on the latest row per node — correct,
and correctly lets a `stuck`/`failed`/`done` row be re-dispatched. Spawn failure → row flipped
`failed` with the error (no phantom running). Ext is `callerExternalIdPrefix`-correct.

**Contract drift.** Re-verified every client fn against its route by hand (bodies AND response
reads): `say` {text, focus_id, force_new} / {external_id, seed_text, wrapped_text};
`dispatch` {instructions?} / {external_id, dispatch{…}}; `accept`/`reject` {ids?} / {ok, created|removed};
`session` / {external_id, last_activity_at}; `proposals` / {batches[]}. Client `WorkbenchDispatch`
type includes `"queued"|"released"` the server never emits for a fresh row — harmless superset.
SSE: `workbench_proposal` in the server `FORWARD` set, `sse-worker.ts` `EVENT_TYPES`, and
`GlobalEventHandlers` — all three, both worker and fallback paths.

**Regression.** `smart-todos.ts`, `smart-todos-tool.ts`, `/smart-todos/*` route block,
`tree.tsx`: byte-identical to the v1 review baseline (sim §7 git checks, re-run green). v1
`/workbench/{scope,jot,open-chat}` routes untouched and exercised. v1 scope guard on per-node
chats intact (sim §6). Flight Deck / workstreams / turn / next_action: `grep` across both
diffs → zero references. No API keys anywhere (placement + dispatch both via the local CLI).

**Build.** darwin-assistant `tsc` clean. jarvis-command-center `vite build` clean with the
node-server preset (`.output/nitro.json` verified); the only `tsc --noEmit` errors in that repo
are pre-existing in unrelated files (`settings-nav.tsx`, `dash.*`), and the only eslint hits
are prettier formatting — the untouched `tree.tsx` has the same, so that's repo-wide drift, not
this branch.

---

## 4. Honest gap check against Kevin's verbatim ask

> "It needs to wait until I actually submit something, and only if I submit something should it
> spawn an attached agent."

**Met.** Nothing thinks until the composer submits; the attached agent (dispatch) is a separate
explicit button. The "attached" part is now mechanically true (F1), not just a label.

> "have you (knowing me) break it into small pieces, have me correct what is done if it's done
> wrong."

**Met, with two places it's thinner than the sentence sounds — stating them plainly:**

1. **Correcting by clicking = accept/reject only.** A ghost can be ✓'d or ✕'d per node or per
   batch. It cannot be *renamed, re-parented, or reordered* by clicking — that goes through the
   brain (`update_proposal` / `delete_proposal` / talk). That IS what SPEC.md wrote ("talk or
   click ✓/✕"), so it's per-spec, but if Kevin's mental model is "fix the wrong word inline," he
   will reach for a click that isn't there. Cheapest next rung: an inline title edit on a ghost
   row → `PATCH /workbench/proposals/:id` (route doesn't exist yet; the internal
   `updateWorkbenchProposal` does).
2. **"Knowing me" = the tree digest, not the transcript.** By Kevin's own locked fork (a),
   brain sessions are per-sitting and boot from `notes` + `context_notes`. So the brain knows
   exactly as much as has been written back into the tree. The AUTO-NOTES instruction is what
   makes this compound; if a sitting ends without `write_context` calls, the next sitting starts
   from the same digest. Working as designed — but the quality of "knowing me" is now a function
   of how faithfully the brain writes notes, which is a prompt-level behaviour. Worth watching
   in the first real dogfood: if the digest feels thin, the fix is making `write_context`
   server-nudged (e.g. end-of-turn check), not changing the session model.

Everything else in the vision is present at full strength: pointing ≠ talking, one brain with a
silent focus pointer, explicit dispatch with a status badge, multi-node breakdowns as ghosts.

---

## 5. Not fixed, noted for later (none blocking)

- **N per-node `GET /workbench/nodes/:id/dispatch` on every render.** Each `NodeRow` mount
  fires one; a zoom remounts rows, so ~N indexed reads per zoom. Cheap on localhost/sqlite, but
  a single `GET /workbench/dispatches` (latest per node) passed down as a map is the right
  shape once the tree is big. Perf/tidiness, not correctness.
- `sort_order` not carried from proposals to materialized nodes (see §3).
- `last_focus_id` stamped pre-POST (see §3).
- `/workbench/say` mints `cockpit:` ext for any caller (see §3).
- `dispatch_model` setting is read via `getSetting` but not exposed on the governor/settings UI;
  `workbench_session_idle_hours` likewise. Both are settings-KV, so a one-liner `sqlite` sets
  them — fine for v0.

---

## 6. Files touched by this review

darwin-assistant (`hopper/workbench-v2`):
- `src/workbench.ts` — F1 (scope resolution via spawn_tasks), F3 (`created_by_message` column
  + insert), F4 (`countTurns`-keyed seed), F5 (orphan prune), F6 (`buildWorkbenchThreadContext`);
  dispatch-section comment corrected to describe the mechanical scope.
- `src/tools/workbench-tool.ts` — F2 (`split` >1 → proposals), F3 (same-turn + scoped
  `accept_batch` refusals), description updated.
- `src/spawn-tasks.ts` — `getSpawnTaskByThreadExt()`.
- `src/agent.ts` — one import + one line: `workbenchContextBlock` in `perTurnContextPrefix`.
- `scripts/workbench-sim-v2.mjs` — key minted with `cockpit` scope (what the real UI uses; the
  old `jarvis` scope could never have performed client step 2), real step-2 POST in §1, new
  checks for F1–F6, §6 relabelled. **68/68.**
- `darwin-assistant/docs/workbench/SIM-V2.md` — result line + §4 finding marked resolved.
- `docs/workbench/REVIEW-V2.md` — this file.

jarvis-command-center (`hopper/workbench-v2-ui`): **no changes.** Build verified only.

**Deploy note for JARVIS:** the `agent.ts` change means the backend restart is the one that
matters (per-turn prefix); the two lazy `ALTER TABLE`s (`spawn_tasks.workbench_node_id` from
node #449, `workbench_proposals.created_by_message` from this review) run idempotently at
module load. Cockpit deploy via the deploy script as usual.
