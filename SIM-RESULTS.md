# Foundry GO v2 Run Slots — End-to-End Lifecycle Sim Results

Node: tree-b3ccebd3 / node #189 ("TEST: end-to-end slot lifecycle sim")
Backend worktree: `/home/kevin/paperclip-worktrees/foundry-runslots`
Script: `darwin-assistant/scripts/runslots-sim.mjs` (+ `runslots-sim-driver.mjs`)
Run: `npm run runslots:sim` (from `darwin-assistant/`, after `npm run build`)

**18/18 checks passed** against a scratch DB (`/tmp/runslots-sim.db`), a scratch
UI port, scratch run-slot ports (48310-48312, never the live 4310-4312), and
real spawned `python3 -m http.server {{port}}` occupant processes. Never
touched the live service, the live jarvis.db, or ports 4310-4312/3201.

Two real, independent `node` process invocations were used (not a single
process pretending to restart) so the boot-reconcile scenario is genuine:
phase 1 fully exits (`process.exit()`) before phase 2 starts against the same
scratch DB file — exactly like a real `jarvis.service` restart.

## What was proven

1. **GO with no `slot_no` allocates the lowest free slot, spawns a real
   process, and the port actually serves.** `POST /foundry/projects/:id/go`
   on project A returned `slot.slot_no=1`, `slot.port=48310`,
   `slot.status="running"`, a real pid; `curl http://127.0.0.1:48310` (via
   `fetch`) returned 200. `GET /foundry/run-slots` showed the same occupant +
   `preview_url`. (checks 0-1, 1-1, 1-2)
2. **Filling all three slots, then a 4th GO returns `409 foundry_slots_full`
   with the full occupant list** (project id / name / port / pid for all
   three). (checks 2-1, 2-2, 3-1)
3. **GO with `{slot_no, replace:true}` evicts the old occupant and serves the
   new one; the evicted pid is actually dead (not just marked dead in the
   DB).** Confirmed both the DB-recorded status transition AND the OS-level
   pid via `kill(pid, 0)`. Targeting a busy slot without `replace` correctly
   returns `409 foundry_slot_occupied` first. (checks 4-1..4-4)
4. **`POST /foundry/run-slots/:n/stop` frees the slot and kills the whole
   process group — no orphan `python3` process left holding the port** after
   stop. Verified via `pgrep -f "http.server (48310|48311|48312)"` returning
   zero matches at the very end, and via direct `kill(pid, 0)` on the exact
   pid. (checks 5-1, 5-2, 8-1)
5. **Killing a slot's occupant out-of-band, the 10s health tick marks the
   slot `dead` within ~15s** (measured 5.5s in this run — comfortably under
   the ~15s the spec asked to prove). (check 6-1)
6. **Restarting the service (a genuinely fresh process against the same
   scratch DB) reconciles at boot correctly:** a slot that was `running` when
   the old process died (no health tick ever caught it, because the service
   was "down") is corrected to `dead` at boot; a slot that was already
   `stopped` stays `stopped`; a slot that was already `dead` stays `dead`.
   Occupant metadata (`project_id`) is preserved on the reconciled row, as
   the design doc specifies. (checks 7-1..7-4)

## Full output

```
=== phase 1 ===
[runslots-sim] phase 1 — scratch DB: /tmp/runslots-sim.db
[runslots-sim] phase 1 — scratch UI port: 39231
[runslots-sim] scratch run-slot ports: 48310,48311,48312
[foundry] lifecycle listener and run-slot sweeper started
[runslots-sim] phase 1 scratch server is up
  [PASS] 0-1: GET /foundry/run-slots returns exactly three free slots at boot
  [PASS] 1-1: GO (no slot_no) on project A allocates slot 1, spawns a real process, curl 200s
  [PASS] 1-2: GET /foundry/run-slots shows slot 1 occupied by project A with a preview_url
  [PASS] 2-1: GO project B (no slot_no) allocates slot 2
  [PASS] 2-2: GO project C (no slot_no) allocates slot 3
  [PASS] 3-1: a 4th GO with no target and all slots running -> 409 foundry_slots_full with occupant list
  [PASS] 4-1: GO project D targeting slot 2 without replace -> 409 foundry_slot_occupied
         (GO+replace round trip took 1608ms — see finding F-1)
  [PASS] 4-2: GO project D targeting slot 2 with replace=true evicts B and serves D
  [PASS] 4-3: old project B pid is actually dead after replace (kill -0 eventually fails)
  [PASS] 4-4: new project D process on slot 2 is alive and serving http 200
         (stop round trip took 1605ms — see finding F-1)
  [PASS] 5-1: POST /foundry/run-slots/1/stop frees slot 1 and kills the process group (no orphan)
  [PASS] 5-2: GET /foundry/run-slots reflects slot 1 as stopped
         (health tick marked slot 3 dead after 5540ms)
  [PASS] 6-1: manually killing slot 3 occupant pid -> health tick marks the slot dead within ~15s
  [PASS] 7-1: kill project D (slot 2) out-of-band while the service is "down"

[runslots-sim] phase 1: 14/14 checks passed.
[runslots-sim] phase 1 complete — this process is exiting now.

=== phase 2 (fresh process, same scratch DB) ===
[runslots-sim] phase 2 — scratch DB: /tmp/runslots-sim.db
[runslots-sim] phase 2 — scratch UI port: 39232
[foundry] lifecycle listener and run-slot sweeper started
[runslots-sim] phase 2 scratch server is up
  [PASS] 7-2: boot reconcile (fresh process, same DB) marks slot 2 dead from the out-of-band kill
  [PASS] 7-3: boot reconcile leaves already-stopped slot 1 as stopped
  [PASS] 7-4: boot reconcile leaves already-dead slot 3 as dead
  [PASS] 8-1: no orphan http.server processes remain on the scratch ports after cleanup

[runslots-sim] phase 2: 4/4 checks passed.

=== RUN-SLOTS SIM — MERGED RESULTS ===
18/18 checks passed.
```

## Findings worth a follow-up (both real, both reproduced multiple times independently — not fixed here, this node is test-only)

### F-1 — `stopRunSlot` always pays the full ~1.6s escalation, on every stop *and* every replace-GO, and blocks the event loop while doing it

`RUNSLOTS-DESIGN.md`'s stop protocol is: SIGTERM the process group, poll
`kill(pid, 0)` up to 8×150ms, escalate to SIGKILL if still "alive", poll up
to another 4×100ms. Measured **every single stop/replace call in this sim
took ~1605-1613ms — the full worst case, every time**, even though the
target python process actually dies within milliseconds of SIGTERM.

Root cause: `stopRunSlot`'s wait loop uses `sleepSync()` —
`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)` — a
genuinely thread-blocking primitive on Node's single main thread (this code
never touches a Worker). A killed child becomes a zombie (`Z` state,
`<defunct>`) the instant it's signaled, but a zombie's pid still answers
`kill(pid, 0)` as "alive" until its parent's event loop runs a tick and
reaps it via the normal SIGCHLD path. Because `Atomics.wait` blocks that
same event loop, **the zombie can never be reaped during the retry loop**,
so `pidAlive(row.pid)` can never observe success and the loop always runs to
its maximum before giving up and sending SIGKILL — which is likewise a
no-op against an already-dead zombie.

Verified independently three ways, all consistent:
- Direct call to `foundry.stopRunSlot()` from a scratch script (no HTTP):
  1605ms, `pidAlive` still `true` the instant the synchronous call returns,
  `false` after a single `setImmediate` tick (~1ms) once the event loop is
  allowed to run.
- Full HTTP round trip through the real Express route: 1610ms.
- `ps -o stat` on the target pid mid-loop showed `Zs <defunct>` throughout
  the whole blocking window, confirming the process actually died on the
  first SIGTERM and the delay is 100% the reap-can't-happen-while-blocked
  effect, not the process failing to respond to SIGTERM.

This doesn't produce an orphan (the guarantee in check 3 of the spec still
holds — see check 5-1/8-1 above, which passed) and it doesn't corrupt state,
but it does mean:
- Every Stop click or replace-GO in the cockpit takes ~1.6s longer than
  necessary.
- Because `Atomics.wait` blocks Node's single JS thread, it very likely
  blocks **all other concurrent request handling, SSE broadcasts, and the
  10s health tick** on the real service for that same ~1.6s window on every
  stop/replace call — this is architecturally near-certain given
  `Atomics.wait`'s documented semantics (it is a real blocking syscall on
  the calling thread, and this code runs on the main thread, not a worker),
  though this sim did not attempt a fully-isolated cross-process benchmark
  to additionally measure request-queueing impact on other endpoints (a
  same-process client/server test is not a valid way to measure that, since
  blocking the process blocks the test's own client code too — confirmed
  while investigating this finding).

Suggested fix direction (not applied — out of scope for a test node):
replace the `sleepSync`/`Atomics.wait` retry loop with real async polling
(`setTimeout` + `await`) inside an async `stopRunSlot`, or just trust the
group SIGTERM and do a single short async wait before SIGKILL rather than a
tight synchronous poll loop. Either removes the event-loop-blocking behavior
and lets the loop actually observe fast deaths instead of always maxing out.

### F-2 — pid-based liveness tracking only watches the shell wrapper, not the real occupant, for an *asymmetric* death

Not part of the five required scenarios and not exercised by the shipped
code path (both `stopRunSlot`'s SIGTERM/SIGKILL and this sim's own simulated
"out-of-band kill" steps correctly signal the whole **process group**, not
just the recorded pid, and group-kill was verified to work correctly in
every scenario above — check 8-1's zero-orphan result confirms it).

Discovered while debugging test flakiness, not while testing the shipped
feature: `spawn(cmd, {shell:true, detached:true})` records `child.pid` as
the `/bin/sh -c "<cmd>"` wrapper's pid; the shell then **forks** a separate
child pid for `python3` rather than exec'ing into it (verified via `ps -eo
pid,ppid,pgid`: the shell and python3 are two distinct pids, same pgid). If
something signals *only* the recorded pid directly — e.g. a human running
`kill <pid>` from the shell after finding it via `ps`/the DB, rather than
`kill -- -<pid>` or going through the app's own stop/health-tick paths —
the shell dies but python3 (now reparented to init, same port still bound)
survives as a live orphan, and the app's own `pidAlive(slot.pid)` checks
(health tick, boot reconcile) would then incorrectly report the slot as
`dead`/reclaimable while the port is still actually held by a stray process.
A subsequent GO into that slot would very likely fail to bind the port.

This is a real limitation of pid-based (rather than port-based) liveness
tracking for shell-wrapped commands, but it requires an unusual trigger
(signaling the bare recorded pid directly, bypassing every code path this
app itself uses) — flagging for awareness, not blocking this node.
