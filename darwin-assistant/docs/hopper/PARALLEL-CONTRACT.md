# Hopper Parallel Engine — BINDING contract (v1)

Authored by node **#945** of tree `tree-383bb55b`
("Hopper/Shifts: never lock up — unpark conditions, serial fallback, per-node
branches + merge-back, resource leases").
Branch `hopper/parallel-engine`, worktree `/home/kevin/paperclip-worktrees/parallel-engine`.

**Nodes 2–6 of this tree implement against THIS file and do not re-decide any of
it.** If a section is genuinely wrong, finish `blocked_question` — never silently
deviate.

---

## 0. Why this exists (Kevin, 2026-09-26, verbatim)

> "couldn't we split a branch off of main… for that high level goal, and do
> worktree branches from that, and have a system that handles dependency? … spin
> up 4 worktrees, one for each sub goal/task, and then have something in place
> that would initially do the 1 the other two depend on AND the 1 that doesn't
> depend on anything? And then once the first one is done, then two agents are
> dispatched to do the other two? … that way it feels like there's *never* any
> way some type of clobbering can occur? Like think your way out of the potential
> problem instead of hitting a potential wall and stopping?"

> "couldn't you just have put one worker on the ones that needed finishing first?
> Even if it's much slower, wouldn't that keep us moving?"

Shift #6 died at 22:17 with **9 hours of budget unused**, for two independent
reasons this contract closes:

1. A **parked head-of-chain item never re-queued** — `park` is currently one-way
   (§6), and `runnable()` refuses any node whose ancestor is parked
   (`src/night-shift.ts:2220`), so one park froze the whole branch.
2. **Per-goal parallelism was capped by the shared-worktree rule** — every node
   of a tree works the same checkout, so `runnable()` refuses a second item on
   the same top-ancestor branch (`src/night-shift.ts:2235`) and again at the
   per-goal cap (`src/night-shift.ts:2229-2231`).

The fix is per-node worktrees (§1–§3), leases for the things that genuinely
*are* shared (§5), machine-checkable unparks (§6), and a driver that is forbidden
from idling while serial progress is still possible (§7).

---

## 1. RECON — the seams as they exist today

Every line number below is against this branch's checkout of
`darwin-assistant/` at `hopper/parallel-engine` (cut from
`hopper/legacy-session-account-guard` @ `5f75e4788`).

### 1.1 `src/hopper-engine.ts`

| Seam | Line | What it does today |
|---|---|---|
| `HopperTreeRow` | `:47` | `id, topic, origin_thread_ext, status, created_at, updated_at`. **No repo, no branch, no build gate.** |
| `HopperNodeRow` | `:56` | adds `depends_on`, `attempts`, `worker_thread_ext`, `lease_expires_at`, `adapter`, `model`, `throttle_reroute`. **No worktree, no branch, no resources.** |
| schema DDL | `:165-197` | `CREATE TABLE IF NOT EXISTS hopper_trees / hopper_nodes` + two indexes. |
| additive migration loop | `:207-213` | `for (const col of ['adapter TEXT', …]) try { ALTER TABLE hopper_nodes ADD COLUMN … } catch {}` — **the established pattern; §2 reuses it verbatim and adds a twin loop for `hopper_trees`.** |
| `readyLeavesStmt` (the claim candidate query) | `:261-267` | `status='pending'` leaves of `status='active'` trees, `ORDER BY priority DESC, id ASC`. **No resource filter.** |
| `claimStmt` | `:269-275` | `UPDATE … SET status='running', attempts=attempts+1, worker_thread_ext=?, lease_expires_at=datetime('now',?) WHERE id=? AND status='pending'` — the single atomic claim. **This is the one place §3 hooks worktree materialization.** |
| `expiredLeasesStmt` | `:276-278` | running nodes past `lease_expires_at`. Drives non-destructive recovery in `dispatchTick`. |
| `NewNodeInput` | `:447-455` | `title, spec, parent_index, depends_on_indexes, priority, adapter, model`. **§5 adds `resources?: string[]`.** |
| `depsSatisfied()` | `:527-541` | JSON-parses `depends_on`, requires every dep `status==='done'` (a `split` parent only releases once `settleAncestors` bubbles it to `done`). **Dependency-driven dispatch is already real — §4.** |
| `composeWorkerPrompt()` | `:557-595` | Builds the worker's one prompt: project/task/spec/answer/dep-results/guardrails/finish contract. **CONFIRMED: there is no worktree or branch line anywhere in it. A worker learns its worktree ONLY from prose a planner happened to type into `node.spec`** — which is exactly how a shared checkout gets clobbered. §3.4 fixes this. |
| `spawnWorker()` | `:614-636` | conversation + model override + `spawn_tasks` row + `processMessageRef(prompt, ext, …)`; on throw, releases the claim back to `pending`. |
| `settleAncestors()` / `maybeFinishTree()` | `:638-673` | bubble `done` up; flip the tree `done` when every node is `done`/`split`. |
| `finishHopperNode()` | `:676-730` | the ONE place execution writes tree state. `done` → `setNode(status:'done')` → `settleAncestors`. **§3.5 inserts merge-back here, between the status write and `settleAncestors`.** |
| `dispatchTick()` | `:764-948` | work-switch hold → expired-lease recovery → admission floor → governor / daytime cap / throttle caps → `claimStmt` → `spawnWorker`. |
| worker thread ext | `:934` | `cockpit:hopper-node-<id>-<uuid8>`. |

### 1.2 `src/handlers/api-v1.ts`

| Seam | Line | Notes |
|---|---|---|
| `POST /hopper-nodes/:id/finish` | `:3547-3593` | 404 unknown · 409 `hopper_node_not_running` · optional `worker_thread_ext` attempt pin (409 `hopper_node_attempt_mismatch`) · outcome validation · `runFoundryFoundationFinishGate` · `finishHopperNode(...)` · `res.json({ node })`. **§3.5's merge-back must NOT be added here** — it goes inside `finishHopperNode` so the watchdog, the reconciler and the API all get it. |

### 1.3 `src/night-shift.ts`

| Seam | Line | Notes |
|---|---|---|
| `night_items` DDL | `:337-361` | `run_id, position, locked, goal_id, node_id, parent_item_id, kind, title, why, est_minutes, eta_at, status, lane, attempt, tree_id, …`. **Items map to hopper trees through `night_items.tree_id`** (set when the item's goal node plants a tree; also mirrored on `goal_nodes.tree_id`). **§6 adds `unpark_when TEXT`.** |
| `parkNode()` | `:1858-1862` | thin wrapper: `parkGoalNode(goal_id, node_id, 'system', reason)`. **No condition is ever recorded — park is one-way.** |
| `runnable()` | `:2214-2238` | `:2220` a parked ancestor blocks · `:2224` an unsettled earlier sibling blocks · `:2229-2231` per-goal parallel cap · **`:2235` "is working the same branch" — the shared-worktree rule this contract retires for integration trees (§4).** |
| `fillLanes()` | `:2318-2360` | server-kind items first (no lane), then one model item per free lane; returns `{started, waiting}` where `waiting` is the FIRST refusal reason. |
| stuck path | `:2444-2463` | when `!running.length && !started`: `replanTail()`; if it appends nothing, `driver.idleTicks += 1` and at `STUCK_TICKS` (`:1803`) → `stopNightRun(id,'stuck','system')`. **§7 inserts the unpark re-check and the serial fallback BEFORE `idleTicks` may increment.** |
| drained path | `:2411-2441` | `!open.length` → `replanTail()` → `complete`, or `stuck` when the re-plan ceiling is spent. |

### 1.4 `src/goals.ts`

| Seam | Line | Notes |
|---|---|---|
| `parkGoalNode()` | `:2255-2275` | legal only from `set/planned/check/working`; writes `state='parked'`, `parked_reason`, a `node_parked` event carrying `{from, reason}`. |
| `unparkGoalNode()` | `:2277-2311` | reads the last `node_parked` event's `from` to restore state; already handles "the tree finished while parked" by restoring to `check`. **§6 calls exactly this — no new unpark state machine.** |

### 1.5 Git helpers

`ls src/ | grep -i 'git\|worktree'` → **nothing.** `src/hopper-git.ts` (§9) is the
first and only git surface; no other module may shell out to git.

---

## 2. SCHEMA (additive, nullable, null = today's behavior exactly)

Added with the existing try/catch `ALTER TABLE` loop pattern
(`src/hopper-engine.ts:207-213`). A twin loop is added for `hopper_trees`.

### `hopper_trees`

| column | type | null means |
|---|---|---|
| `repo_path` | `TEXT` | not an integration tree |
| `integration_branch` | `TEXT` | not an integration tree |
| `build_gate_cmd` | `TEXT` | see §3.6 default resolution |

**A tree is an INTEGRATION TREE iff `repo_path` AND `integration_branch` are both
non-null.** Any other combination is a legacy tree and every behavior in §3–§4 is
skipped — byte-for-byte today's dispatch. This is the migration guarantee: every
existing row has both null, so nothing changes until a planner opts in.

### `hopper_nodes`

| column | type | meaning |
|---|---|---|
| `worktree_path` | `TEXT` | absolute path materialized at claim (§3.2); null on legacy trees |
| `node_branch` | `TEXT` | the per-node branch name (§3.1) |
| `integration_state` | `TEXT` | `null` \| `'merged'` \| `'integration_pending'` (§3.5) |
| `resources` | `TEXT` | JSON array of lease names (§5); null = holds nothing |
| `unpark_when` | `TEXT` | JSON `UnparkCondition` (§6); null = manual only |

### `night_items`

| column | type | meaning |
|---|---|---|
| `unpark_when` | `TEXT` | JSON `UnparkCondition` (§6) |

No `CHECK` constraint is added to any of these — sqlite cannot add one by
`ALTER TABLE`, and the engine validates on write instead.

---

## 3. INTEGRATION BRANCHES, PER-NODE BRANCHES, MERGE-BACK

### 3.1 Naming — and the one place the original plan was mechanically impossible

Given `repo_path = /home/kevin/paperclip` and
`integration_branch = hopper/parallel-engine`:

```
integration worktree   <dirname(repo)>/<basename(repo)>-worktrees/<tree_id>/_integration
                       → /home/kevin/paperclip-worktrees/tree-383bb55b/_integration
node worktree          <dirname(repo)>/<basename(repo)>-worktrees/<tree_id>/n<node_id>
                       → /home/kevin/paperclip-worktrees/tree-383bb55b/n946
node branch            <integration_branch>-n<node_id>
                       → hopper/parallel-engine-n946
```

> **Node branches are suffixed with `-n<id>`, NOT `/n<id>`.**
> Git refs are files in a directory tree: `refs/heads/hopper/parallel-engine`
> cannot simultaneously be a file and the directory `refs/heads/hopper/parallel-engine/`.
> Proven on this box:
> ```
> $ git branch hopper/parallel-engine/n945 hopper/parallel-engine
> fatal: cannot lock ref 'refs/heads/hopper/parallel-engine/n945':
>        'refs/heads/hopper/parallel-engine' exists;
>        cannot create 'refs/heads/hopper/parallel-engine/n945'
> $ git branch hopper/parallel-engine-n945 hopper/parallel-engine   # OK
> ```
> The slash form would have failed on **every single node of every integration
> tree**, 100% of the time. The hyphen form is binding.

`repoWorktreeRoot(repoPath)` is `<dirname>/<basename>-worktrees` — for
`/home/kevin/paperclip` that is the existing `/home/kevin/paperclip-worktrees`,
so integration trees nest under the directory the box already uses.

### 3.2 Materialize AT CLAIM, never at plant

Inside `dispatchTick`, **after** `claimStmt` reports `changes === 1` and
**before** `spawnWorker` (`src/hopper-engine.ts:935-941`):

1. If the tree is not an integration tree → nothing happens (legacy path).
2. `ensureIntegrationWorktree(tree)` — idempotent; creates
   `<root>/<tree_id>/_integration` on `integration_branch` if absent.
3. `materializeNodeWorktree(tree, node)`:
   - branch `<integration_branch>-n<node_id>` cut from **the integration
     branch's CURRENT head at this moment** — this is the whole point. Node C
     claimed after node A merged gets A's work; node D claimed at t0 does not.
     Cutting at plant time would hand every node the same stale base and
     re-create the clobbering by another name.
   - `git worktree add -b <branch> <path> <integration_branch>`.
   - If the branch already exists (a retry of the same node), reuse it:
     `git worktree add <path> <branch>`. **Branches are never deleted (§8), so a
     retry always finds its predecessor's work rather than losing it.**
4. Persist `worktree_path` + `node_branch` on the node row.
5. If any step fails: release the claim exactly the way `spawnWorker`'s catch
   already does — `setNode(id, { status:'pending', worker_thread_ext:null,
   lease_expires_at:null })` — and log. A git failure must never burn an attempt
   or strand a lease.

### 3.3 Retry semantics

`retryRouteFor` / lease expiry are untouched. On re-dispatch the node
re-materializes its worktree (step 3 above reuses the branch). The worktree is
pruned only on successful integration (§3.5) — a blocked node keeps its worktree
so Kevin can look at it.

### 3.4 What the worker is TOLD (the fix for the prose-only worktree)

`composeWorkerPrompt()` (`:557`) gains a block, emitted **only** for integration
trees, immediately after the `**Your task**` line and before `**Spec:**`:

```
**Your worktree (authoritative — overrides anything the spec says):**
- Work in: /home/kevin/paperclip-worktrees/tree-383bb55b/n946
- On branch: hopper/parallel-engine-n946 (cut from hopper/parallel-engine)
- Commit here. Do NOT switch branches, do NOT merge, do NOT push to the
  integration branch — the engine merges your branch into
  hopper/parallel-engine after you finish `done`.
- Never touch /home/kevin/paperclip (the live checkout) or any other worktree.
```

For legacy trees the prompt is byte-identical to today.

### 3.5 MERGE-BACK on `finish(done)`

In `finishHopperNode()` (`:676`), for integration trees only, `outcome==='done'`
becomes: write `status='done'` → **integrate** → then `settleAncestors`.
`settleAncestors` is what releases dependents, so it must run *after*
integration; otherwise node C starts from a head that does not yet contain A.

`integrateNode(tree, node)` runs **inside the integration worktree**:

1. `git merge --no-ff <node_branch> -m "hopper: integrate n<id> <title>"`.
2. On conflict → `git merge --abort`, capture the conflict output. **FAIL.**
3. Green merge → run `build_gate_cmd` (§3.6) in the integration worktree, capture
   output, 20-minute timeout.
4. Build fails → `git reset --hard <pre-merge-sha>` (safe: this is the engine's
   own integration worktree, never a shared branch), capture output. **FAIL.**
5. PASS → `integration_state='merged'`, prune the node worktree
   (`git worktree remove --force <path>`; the branch survives), node is
   integrated.

**On FAIL — the tree never silently ships a broken integration branch:**

- `integration_state='integration_pending'` on the original node. It stays
  `status='done'` (the worker did its job; the merge is a separate problem), so
  `settleAncestors` still runs and the tree does not deadlock on it.
- Auto-create a sibling node in the same tree:
  - `title`: `integrate n<node_id>`
  - `depends_on`: **`null` — depends on nothing**, so it is claimable on the very
    next tick.
  - `spec`: the reason (`merge conflict` / `build gate failed`), the node branch,
    the integration branch, the integration worktree path, and the captured
    conflict/build output (capped 8000 chars).
  - `resources`: `["integration:<tree_id>"]` (§5) — so two integration-repair
    nodes of the same tree can never fight over the integration worktree.
  - `adapter`/`model` inherited from the failed node.
- A `warning` notification (`source:'hopper-engine'`), skipped for foundry trees
  the same way `finishHopperNode`'s existing notifications are.

Integration is **serialized per tree** by an engine-held `integration:<tree_id>`
lease: two nodes finishing in the same tick merge one at a time, in finish order.

### 3.6 `build_gate_cmd` resolution

- Non-null on the tree → use it verbatim.
- Null → `'npm run build'` **iff** `<repo_path>/darwin-assistant/package.json`
  exists, run with `cwd = <integration_worktree>/darwin-assistant`.
- Otherwise → empty = **skip the gate**, merge alone decides.
- Empty string explicitly set → skip the gate.

**The gate must install its own dev dependencies first.** A fresh node worktree
has no `node_modules`, and hopper workers run with `NODE_ENV=production`, under
which `npm ci` silently **omits devDependencies** — so `npm run build` fails
`tsc: not found` and a perfectly good merge is reported as a red build. Proven
while writing this contract on `hopper/parallel-engine`:

```
$ npm ci            # 250 packages, no typescript
$ npm run build     # sh: 1: tsc: not found   (exit 127)
$ npm ci --include=dev
$ npm run build     # exit 0
```

`runBuildGate` therefore runs `npm ci --include=dev` in the gate's `cwd` when
`node_modules/.bin` is absent, and **exit 127 is reported as
`reason:'build_toolchain_missing'`, never as a code failure** — the distinction
matters because the first turns into an `integrate nX` node a worker can fix,
and the second would blame a worker for the environment.

### 3.7 Outcomes other than `done`

`split`, `blocked`, `blocked_question` do **not** merge and do **not** prune.
`split` children inherit the tree and get their own worktrees at their own claim.

---

## 4. DEPENDENCY-DRIVEN DISPATCH (already real) + retiring the same-branch rule

`depsSatisfied()` (`:527`) already implements exactly what Kevin described: a
node dispatches when every id in its `depends_on` is `done`. This contract adds
no new dependency machinery — it removes the reasons the existing machinery was
being throttled.

**Binding rule:** for an **integration tree**, the two shared-checkout guards no
longer apply, because there is no longer a shared checkout:

- `src/night-shift.ts:2235` — `"#N is working the same branch"` — **skipped**
  when the item's tree is an integration tree.
- `src/night-shift.ts:2229-2231` — the per-goal parallel cap — **not applied** to
  integration-tree items.

Unchanged and still authoritative for integration trees: `runnable()`'s ancestor
check (`:2220`), the earlier-sibling check (`:2224`), the shift's **lane** count,
and every ⚡ Throttle dial and governor gate in `dispatchTick`. Kevin's dials
still cap the machine; the *implicit* caps are what go away.

### 4.1 THE ACCEPTANCE SCENARIO (nodes 2–6 prove this one, by name)

Four nodes on one integration tree: `B` and `C` depend on `A`; `D` depends on
nothing.

| tick | expected |
|---|---|
| t0 | **A and D claim together.** Worktrees `…/nA` and `…/nD`, branches `…-nA`, `…-nD`, both cut from integration head `H0`. |
| t1 | A finishes `done` → merged into the integration branch → head `H1` → node worktree `nA` pruned, branch `hopper/…-nA` still exists. D still running, untouched. |
| t2 | **B and C both claim** (deps satisfied; no same-branch refusal, no per-goal cap). Worktrees `…/nB`, `…/nC`, branches cut from **`H1` — they contain A's work**. |
| t3 | D finishes → merges into whatever the head is then. B, C finish → merge in finish order, serialized by the `integration:<tree>` lease. |
| any | a conflicting or red merge → `integrate nX` node, tree keeps moving. |

---

## 5. RESOURCE LEASES

For the things that genuinely *are* shared and cannot be worktree'd: a sandbox
domain, a settings row, a port, the integration worktree itself.

- `NewNodeInput` (`:447`) gains `resources?: string[]`; persisted as a JSON array
  in `hopper_nodes.resources`. Names are free-form strings, lower-kebab,
  conventionally namespaced (`perclickity-sandbox-rules`, `integration:<tree_id>`).
- **A node is not claimable while any of its resources is held by a `running`
  node.** Enforced as a `NOT EXISTS` clause against running nodes' `resources` in
  the candidate query (`readyLeavesStmt`, `:261`) **and** re-checked immediately
  before `claimStmt` (`:269`) inside the same tick, because `dispatchTick` claims
  several nodes per tick and the query is evaluated once (the identical hazard
  ⚡ Throttle §3 already handles with its in-loop `caps.record()`).
- **A resource is held exactly as long as the node's lease.** It releases on
  `finishHopperNode` (any outcome) and on `lease_expires_at` passing — the same
  `expiredLeasesStmt` sweep that already re-queues the node. There is no separate
  lease table and no separate expiry clock: **the node row IS the lease**, which
  is what makes a crashed worker incapable of holding a resource forever.
- **Ordering is first-come**, by the existing `ORDER BY priority DESC, id ASC`.
- **Multi-resource nodes acquire all-or-nothing**, in one atomic claim: the
  `NOT EXISTS` clause covers every name, and `claimStmt` is a single
  `UPDATE … WHERE status='pending'`. A node never holds a partial set, therefore
  no hold-and-wait, therefore **no deadlock is possible** — not for single-resource
  nodes and not for multi-resource ones. A blocked node simply is not claimed and
  is retried next tick; that is starvation-free under a fixed id order.
- A resource conflict is a **SKIP, never a park** (⚡ Throttle §3.5 rule): status
  stays `pending`, no attempt consumed, no lease, no notification.

The first two real resources this contract names, both genuinely un-worktree-able
because they are not files in a repo: **`perclickity-sandbox-rules`**, the shared
special-email rule list on the PerClickity sandbox domain (two nodes editing it
concurrently corrupt each other's write, not each other's code, so a worktree
can't fix it) and **`sandbox-intake-deploy`**, the sandbox intake's single
deploy slot (a second deploy started mid-deploy races the first over the same
running process, not over source). Any planner naming either in a node's
`resources` gets automatic, deadlock-free serialization against every other node
naming the same string — nothing else has to know these two are special.

---

## 6. UNPARK CONDITIONS — park stops being one-way

```ts
type UnparkCondition =
  | { kind: 'node_done';      node_id: number }
  | { kind: 'tree_done';      tree_id: string }
  | { kind: 'branch_pushed';  repo: string; branch: string }
  | { kind: 'file_exists';    path: string }
  | { kind: 'manual' };
```

Stored as JSON in `goal_nodes.unpark_when` (goal nodes) and
`night_items.unpark_when` (shift items). **Null or `{kind:'manual'}` = today's
behavior: only Kevin unparks it.**

Evaluation — `evaluateUnpark(cond): boolean`, pure, no model calls, no network:

| kind | true when |
|---|---|
| `node_done` | `getHopperNode(node_id)?.status === 'done'` |
| `tree_done` | `getHopperTree(tree_id)?.status === 'done'` |
| `branch_pushed` | `git -C <repo> rev-parse --verify refs/remotes/origin/<branch>` resolves |
| `file_exists` | `fs.existsSync(path)` |
| `manual` | never |

Re-evaluated **every tick** by both the night driver (`tickNightShift`, before
the stuck test — §7) and goals autopilot. A met condition:

- goal node → `unparkGoalNode(goal_id, node_id, 'system')` (`src/goals.ts:2277`,
  which already restores the pre-park state from the `node_parked` event and
  already handles "the tree finished while parked"), clear `unpark_when`, write a
  `night_events` / `goal_events` line naming the condition that fired.
- night item → `status='queued'`, clear `unpark_when`, event line.

`parkNode()` (`src/night-shift.ts:1858`) gains an optional third argument and
**every existing call site passes the strongest condition it knows**:

| call site | line | condition |
|---|---|---|
| verify-failed park | `:1909`, `:2266` | `{kind:'manual'}` — a red verify is Kevin's call |
| tree-blocked-after-unblock park | `:1846` | `{kind:'tree_done', tree_id}` |
| plant-failed park | `:2255` | `{kind:'manual'}` |
| cue-ignored-twice park | `:2008` | `{kind:'manual'}` |

Conservative on purpose: this section makes park *recoverable*, it does not make
any currently-human decision automatic.

---

## 7. THE NEVER-IDLE RULE (night driver)

Rewrites `src/night-shift.ts:2444-2463`. When `!running.length && !started`, the
driver **may not increment `idleTicks`** until all three of these have been tried,
in order:

1. **`replanTail()`** — unchanged, still first.
2. **Re-check every unpark condition** (§6) on this run's parked goal nodes and
   condition-parked items. Anything that fires re-enters the queue → `fillLanes`
   again → `idleTicks = 0`.
3. **SERIAL FALLBACK** — Kevin's *"couldn't you just have put one worker on the
   ones that needed finishing first? Even if it's much slower, wouldn't that keep
   us moving?"*

   Find the **oldest blocked chain** (lowest `position` among queued items whose
   only `runnable()` refusal is `waits on #X` / `is working the same branch` /
   the per-goal cap — i.e. `:2224`, `:2235`, `:2229-2231`). Take the **head** of
   that chain and run it with **one worker, on the tree's own branch, no
   parallelism**. `idleTicks = 0`.

   Not eligible for the fallback: an item blocked by a parked-or-ghost ancestor
   (`:2220`), a human-gated item, or a condition-parked item whose condition is
   unmet. Those are genuine stops.

**The driver may declare `stuck` only when every remaining open item is
human-gated or condition-parked with an unmet condition.** The stop event and the
morning report must **name them, one line each**:

```
stuck: 3 items remain, none runnable
  #7  Approve the rules change            human-gated (leaf_kind=human)
  #11 Wire the sandbox                    parked, waiting: branch_pushed origin/pcx/rules-v2
  #12 Verify the sandbox                  waits on #11
```

"nothing runnable for N ticks" is no longer an acceptable stop reason on its own.

---

## 8. SAFETY INVARIANTS (non-negotiable — nodes 2–6 must not weaken these)

1. **No force-push, ever.** `hopper-git.ts` never emits `--force`, `--force-with-lease`, or `+refs`.
2. **No branch deletion, ever.** Pruning a node worktree (`git worktree remove`)
   leaves `refs/heads/<integration_branch>-n<id>` intact — the audit trail and
   the retry base.
3. **Merge-back never targets `master`/`main`.** `integrateNode` asserts the
   merge target equals the tree's `integration_branch` and that it is neither
   `master` nor `main`; a violation throws before any git runs.
   **Integration branch → main is Kevin's, always.**
4. **All git operations are confined to worktrees the engine created** — paths
   under `repoWorktreeRoot(repo_path)/<tree_id>/`, plus read-only `rev-parse` /
   `fetch` against `repo_path`. `/home/kevin/paperclip` is **never** written to.
   Every mutating helper asserts its `cwd` is under the tree's worktree root.
5. **No `reset --hard` outside the engine's own integration worktree** (§3.5
   step 4 is the only use, and only to undo a merge the engine itself just made).
6. **No `git push`** from the engine. Workers push their own branches; the engine
   does not.
7. **Every helper is `execFile`, never a shell string** — no interpolation of a
   branch or path into a shell, so a hostile title can never become a command.
8. **Every git call is timeout-bounded** and its failure is a value, not a throw
   that can strand a lease.

---

## 9. `src/hopper-git.ts` — the one shared surface

Shipped by this node as **types + JSDoc + `throw new Error('not implemented')`
bodies**. Nodes 2–6 fill the bodies; nobody else shells out to git.

```ts
repoWorktreeRoot(repoPath)                      // <dirname>/<basename>-worktrees
treeWorktreeRoot(repoPath, treeId)              // …/<tree_id>
integrationWorktreePath(repoPath, treeId)       // …/<tree_id>/_integration
nodeWorktreePath(repoPath, treeId, nodeId)      // …/<tree_id>/n<node_id>
nodeBranchName(integrationBranch, nodeId)       // <branch>-n<id>   ← §3.1, NOT '/'
isIntegrationTree(tree)                         // repo_path && integration_branch
assertMergeTargetSafe(branch)                   // §8.3
assertPathInTreeRoot(repoPath, treeId, path)    // §8.4
ensureIntegrationWorktree(repoPath, treeId, integrationBranch)
materializeNodeWorktree(...)                    // §3.2 — cuts from CURRENT head
pruneNodeWorktree(...)                          // §8.2 — worktree only, branch kept
currentHead(worktreePath)
mergeNodeBranch(...)                            // §3.5 steps 1-2
runBuildGate(...)                               // §3.5 step 3
resolveBuildGateCmd(tree)                       // §3.6
resetHardTo(...)                                // §3.5 step 4, §8.5
branchExists(repoPath, branch)
remoteBranchExists(repoPath, branch)            // §6 branch_pushed
```

Result type for every mutating helper:
`{ ok: true, … } | { ok: false, reason: string, output: string }` — a git failure
is a value the caller handles, never an exception that strands a claim (§8.8).

---

## 10. PROOF OBLIGATIONS (SIM policy — every node of this tree)

Engine work, so **every behavioral claim is proven by a hermetic check/sim**:

- Fresh scratch DB under `/tmp` via `JARVIS_DB_PATH`, `JARVIS_SIM=1`.
- **Model calls stubbed.** `src/sim-guard.ts` fails closed on any non-live
  `JARVIS_DB_PATH` — **that is the guarantee; do not weaken it, do not special-case
  around it.** Register an ESM hooks file next to the sim
  (`scripts/*.hooks.mjs`) the way `scripts/goals-tree-cue-sim.hooks.mjs` does.
- **Git is real but local**: sims operate on a throwaway repo created under
  `/tmp` with `git init`, never on `/home/kevin/paperclip`.
- Named checks nodes 2–6 are expected to land (add to `package.json` as
  `parallel:check` / `parallel:sim`):
  - `PE-1` migration is additive — a pre-migration DB opens, legacy trees dispatch identically.
  - `PE-2` `nodeBranchName` never emits a `/` suffix; a slash-suffixed name is rejected.
  - `PE-3` **the §4.1 acceptance scenario**, tick by tick: A+D together, B+C after A merges, B/C cut from a head containing A's commit.
  - `PE-4` conflict → `integrate nX` node created with `depends_on = null`, original `integration_pending`, integration branch unchanged.
  - `PE-5` red build gate → same, plus the integration branch reset to its pre-merge sha.
  - `PE-6` resource lease: two nodes naming the same resource never run concurrently; lease expiry releases it; multi-resource is all-or-nothing.
  - `PE-7` unpark: a `node_done`-parked item re-queues on the tick after its node finishes.
  - `PE-8` never-idle: a run whose only work is a blocked chain runs the chain head serially instead of stopping; a run whose remainder is all human-gated stops `stuck` and **names every item**.
  - `PE-9` safety: no helper emits `--force`, no branch is deleted, a merge targeting `master`/`main` throws before any git runs.
- **Build gate for every node of this tree: `npm run build` (tsc) in
  `darwin-assistant/` must be green.** A node is not done with a red build.

---

## 11. Open item for Kevin (not blocking nodes 2–6)

Nothing in this contract makes an integration branch reach `main`. §8.3 makes
that structurally impossible for the engine. When a tree finishes, its
integration branch simply sits there, green, with the whole tree's work merged
into it — and Kevin merges it (or doesn't). That is deliberate, and it is the
last human gate in the loop.

---

## 12. IMPLEMENTATION LOG (append-only — one entry per node, facts later nodes need)

### node #948 — §1-§2, §3.1-§3.4, §8 are LIVE

Landed: `src/hopper-git.ts` real bodies for every §3.1 path/name helper, both §8
guards, `ensureIntegrationWorktree` / `materializeNodeWorktree` /
`pruneNodeWorktree` / `currentHead` / `branchExists`; the §2 additive migrations
(`hopper_trees.repo_path|integration_branch|build_gate_cmd`,
`hopper_nodes.worktree_path|node_branch`); §3.2 materialization wired into
`dispatchTick` between `claimStmt` and `spawnWorker` via the exported
`prepareIntegrationWorkspace()`; §3.4's worktree block in `composeWorkerPrompt`.
Proof: `npm run hopper-git:check` (125 checks, HG-1…HG-10).

Still stubbed for later nodes: `mergeNodeBranch`, `runBuildGate`,
`resolveBuildGateCmd`, `resetHardTo` (§3.5-§3.6).

Additions to the §9 surface (all additive, nothing renamed):

- `ensureIntegrationWorktree(...)` also returns `reused` and `created_branch`.
- `registeredWorktree(repo, path)` — read-only `worktree list --porcelain` lookup.
- `pruneStaleWorktreeRegistrations(repo)` — `git worktree prune`; what lets a
  crashed or hand-deleted node worktree be re-materialized instead of wedging.
- `assertGitArgsSafe(args)` — §8.1/§8.2/§8.6 enforced at ONE chokepoint every
  git call in the module passes through, and asserted directly by HG-3.
- `prepareIntegrationWorkspace(node, tree)` / `composeWorkerPrompt(node, tree)`
  exported from `hopper-engine.ts` so the check drives the real seam.

Three facts found while building, that later nodes will otherwise rediscover:

1. **One integration branch = one worktree.** Git allows a branch to be checked
   out in only one worktree, so **two trees can never share an integration
   branch** — the second gets `integration_branch_checked_out_elsewhere` as a
   value. Same for a branch already checked out in the live checkout. Never
   forced; the tree stops, it does not clobber.
2. **A bad `repo_path` is checked before anything is created.** `repoUnavailable()`
   runs ahead of the first `mkdir`, so a misconfigured tree leaves no empty
   `<repo>-worktrees/<tree_id>/` behind and reports `repo_unavailable` instead of
   a bare spawn `ENOENT`.
3. **§3.2 step 5 refunds the attempt.** `claimStmt` increments `attempts`, so
   releasing a claim after a git failure also decrements it — otherwise
   environment trouble would march a healthy node to `MAX_ATTEMPTS` and park it.
   HG-9 drives this through the real `dispatchTick` and asserts `attempts === 0`
   and zero spawns.

`ensureIntegrationWorktree` will CREATE the integration branch when it exists
neither locally nor as `origin/<branch>`, cutting it from the repo's current
`HEAD` (`created_branch: true`). §8 is intact — no force, no deletion, no push,
and the live checkout's working tree is never written.

### node #949 — §3.5-§3.6 MERGE-BACK is LIVE

Landed: `mergeNodeBranch` / `resolveBuildGateCmd` / `runBuildGate` / `resetHardTo`
in `src/hopper-git.ts` (no stub bodies remain in that module), and the merge-back
orchestration in `src/hopper-engine.ts`: `finishHopperNode(done)` on an
integration tree writes `status='done'` **and** `integration_state='integration_pending'`
in one statement, enqueues the merge, and defers `settleAncestors` until the merge
settles. Proof: `npm run hopper-merge:check` (117 checks, MB-1…MB-7, incl. §4.1
end-to-end). `npm run hopper-git:check` still 125/125, `npm run unpark:check`
41/41, `npm run build` green.

Five facts later nodes need:

1. **`integration_state='integration_pending'` is what holds dependents, and it is
   written in the SAME statement as `status='done'`.** `depsSatisfied()` now
   refuses a dep that is `done` but `integration_pending`, so there is no window
   in which a dependent could be cut from a head that lacks its dependency's work.
   `null` on every legacy node means the clause is invisible to existing trees.
   §3.5's "it stays `status='done'` so the tree does not deadlock" is intact —
   `settleAncestors` still runs on both the pass and the fail path.
2. **Merge-back is ASYNC and serialized per tree.** `finishHopperNode` stays
   synchronous (an API handler calls it) and returns immediately; the merge + gate
   run on a per-tree promise chain, so two finishes in one tick merge one at a
   time in finish order. `integrationIdle(treeId)` awaits it (that is how the
   check observes post-merge state) and `isIntegrating(treeId)` reads it.
3. **One additive column beyond §2: `hopper_nodes.integrates_node_id`.** A repair
   node has to know which node's merge it repairs, because landing the repair is
   what lands the original (and releases the original's dependents). The
   alternative was re-parsing the `integrate nX` title — engine state living in a
   display string. `resources` and `integration_state` also ship here (additive,
   nullable), so §5's claimability rule finds repair nodes already correct.
4. **A repair node inherits the failed node's `parent_id`**, i.e. it is a literal
   sibling. On a split subtree that is load-bearing: a root-level repair node
   would let the split parent bubble to `done` while its child's work was still
   unmerged, and the parent's own dependents would unblock early.
5. **`--no-ff` still says "Already up to date." when a worker committed nothing.**
   That is a SUCCESS (`already_up_to_date: true`), not a failure — holding such a
   node `integration_pending` forever would deadlock its dependents. Same for a
   node with a null `node_branch` (a tree opted in mid-flight): nothing to merge,
   so it is marked `merged` with a logged reason.

`build_gate_cmd` runs through `sh -c` because a gate has to be able to be a
pipeline and it is TREE CONFIGURATION (planner/Kevin-authored, like a CI config),
never worker text. §8.7's "never a shell string" governs the git surface, where a
node title or branch would otherwise be interpolated; nothing worker-authored
reaches the gate. Everything git still goes through `runGit`/`assertGitArgsSafe`.

### node #950 — §5 RESOURCE LEASES are LIVE

Landed in `src/hopper-engine.ts` only — no new table, per §5's own binding rule
("the node row IS the lease"). `NewNodeInput.resources?: string[] | null`
persisted into `hopper_nodes.resources` (JSON array) by `createHopperTree`'s
insert (the column itself already existed, added by node #949 for repair
nodes). Claimability is enforced in TWO layers, matching ⚡ Throttle's own
`caps` pattern for the identical same-tick hazard:

1. `readyLeavesStmt` gained a `NOT EXISTS` clause using `json_each` over both
   the candidate's and every running node's `resources` arrays — a candidate
   naming a resource any currently-`running` node holds never even reaches the
   dispatch loop.
2. `dispatchTick` builds a `heldResources` Set once per tick from
   `runningResourcesStmt` (the same running-node snapshot the query above just
   used), then records into it in-loop as nodes are actually claimed — closing
   the gap `readyLeavesStmt`'s own snapshot can't: several nodes are claimed
   off ONE query result per tick, so two ready leaves sharing a resource could
   otherwise both pass the SQL filter before either is claimed. A hold is
   `continue` — status stays `pending`, zero attempt cost, zero lease, zero
   notification (§5's SKIP-never-park rule). If a claimed node's workspace prep
   later fails (`releaseClaimAfterWorkspaceFailure`, integration trees only),
   its names are removed from `heldResources` too — that revert already puts
   the node back to `pending`, so holding the name for the rest of the tick
   would starve a sibling over a resource nobody actually holds.

Release needed no new code at all: every `finishHopperNode` outcome
(`done`/`split`/`blocked`/`blocked_question`) and the existing lease-expiry
sweep already move a node OFF `status='running'` before `dispatchTick`'s next
pass rebuilds `heldResources` from scratch — that rebuild, every tick, from
current `running` rows, is the entire release mechanism.

Proof: `npm run hopper-leases:check` (25 checks, LC-1…LC-5): two nodes sharing
one name run strictly serially while an unrelated third runs alongside them;
release on `done`, release on `blocked` (any outcome, not just success);
release on lease expiry with no finish call at all (proven via a
higher-priority waiter that can only win the freed name if the sweep actually
ran before the claim loop); multi-resource all-or-nothing (a two-name node
blocked by either half never partially holds the other); and the SKIP-not-park
invariant (zero unexpected `blocked` nodes across every fixture). No
regressions: `hopper-git:check` 125/125, `hopper-merge:check` 117/117,
`unpark:check` 41/41, `night:never-idle:check` 19/19, `npm run build` green.

One fact later nodes need: **resources are engine-general, not
integration-tree-specific.** Every check above runs on plain legacy trees (no
`repo_path`/`integration_branch`) — §5's claim gate reads `n.resources`
unconditionally, with no `isIntegrationTree` branch anywhere in it, so a
resource lease works identically whether or not the tree also happens to use
per-node worktrees.
