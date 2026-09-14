# DECISIONS.md — Foundry GO v2 run slots (tree-b3ccebd3)

## 2026-09-14 · Adversarial review (node #190) — VERDICT: FAIL, not GO-ready

Reviewed `hopper/foundry-runslots` @ `1092bfe6d` (darwin-assistant) and
`hopper/foundry-runslots-ui` @ `4d6f4c1` (cockpit). The lifecycle sim
(`npm run runslots:sim`) re-ran clean, 18/18, and `tsc` is green in both repos
(cockpit `tsc` errors are all pre-existing in other routes; `prettier` noise in
`cockpit-api.ts` is pre-existing on the base commit; the one eslint warning in
`foundry.tsx` predates this branch). The code is well-structured and the happy
path is real. It fails the review on **what happens the second time** — relaunch,
restart, and concurrency — which is exactly what "reusable slots with real
lifecycle" is supposed to buy.

Reproduction script (committed): `darwin-assistant/scripts/runslots-review-attacks.mjs`
— `npm run build && node scripts/runslots-review-attacks.mjs`. Scratch DB +
scratch ports 48410-48412 only. Every finding below prints as a `[BUG]` line.

### Blocking (must fix before Kevin presses GO)

**R-1 · A project can be GO'd exactly once, ever. Stop bricks it.**
`goProject` requires `status === 'ready'` and sets `launched`; nothing ever
returns a project to `ready` (`setProjectReadyStmt` has `AND status <> 'launched'`)
and the UI only renders GO for `ready`. So: GO → Stop (or crash, or reboot) →
GO again = `409 foundry_project_not_ready`. Reproduced (attack D). The slot is
reusable; the project is not. That defeats the feature.
*Fix:* allow GO when `status IN ('ready','launched')`. If the project already
occupies a live slot, either 409 `foundry_project_already_running` with the slot
in `detail`, or (better) replace its own slot by default. UI: `canGo = ready ||
(launched && no running slot for this project)`, label it "Relaunch".

**R-2 · pid liveness has no identity check → after a reboot the board shows
ghosts and Stop can kill an unrelated process.** `pidAlive` is `kill(pid,0)`
only. Reproduced (attack C): a recorded pid now owned by an unrelated `sleep`
→ boot reconcile leaves the slot `running` with the old project name, and Stop
sends SIGTERM/SIGKILL to that unrelated process group. After a pi reboot every
recorded pid is stale and low pids get reused fast (jarvis, cockpit, paperclip,
postgres all live on this box). If the reused pid belongs to root, `kill` throws
EPERM → Stop 500s forever and the slot can never be cleared.
*Fix:* record identity at spawn and verify it before trusting a pid: read
`/proc/<pid>/environ` for `FOUNDRY_SLOT=<n>` (the env is already set on the
child — cheapest, unambiguous), and/or record `/proc/<pid>/stat` starttime at
spawn and compare. Any mismatch ⇒ treat as dead. Also treat EPERM as "not ours".

**R-3 · Health tick works from a stale snapshot; a replace-GO during a tick
marks the NEW occupant dead and NULLs its pid.** `runSlotHealthTick` reads all
rows, then `await`s `probePort` per slot (up to ~2s each for a port that accepts
but doesn't speak HTTP). A GO+replace in that window swaps the pid; the tick then
sees the old pid dead and runs `setRunSlotDeadStmt` on the slot — the live new
process is now pid-less, unstoppable from the UI, and the slot is reclaimable so
the next GO collides on the port. Reproduced (attack B).
*Fix:* make the dead-mark conditional: `UPDATE … SET status='dead', pid=NULL WHERE
slot_no=? AND pid=? AND status='running'` (compare against the pid the tick
observed), and re-read the row after each `await` before acting.

**R-4 · Through the real cockpit proxy every preview link is `http://localhost:<port>`.**
`foundryPreviewHost` falls back to `x-forwarded-host` / `host`, but
`src/lib/cockpit-proxy.ts` forwards neither — the backend always sees
`Host: localhost:3201`. Kevin opens the cockpit from his laptop at
`192.168.1.52:8080`, clicks Open, and hits his laptop's localhost:4310. The
thread link-bar preview gets the same wrong URL. Not hit by the sim because it
calls `:3201` directly.
*Fix:* either set `FOUNDRY_PREVIEW_HOST=192.168.1.52` in darwin-assistant `.env`
at deploy (document it in the deploy step — it is currently the *only* working
path), or one line in `cockpit-proxy.ts`: `headers.set("x-forwarded-host",
request.headers.get("host") ?? "")`. Do the proxy fix; keep the env var as
override.

### Should fix (board lies / self-inflicted collisions)

**R-5 · No preflight port check; a bound port yields a 202 "launched" and a
running slot that points at someone else's server.** Reproduced (attack E):
port already bound → child dies with EADDRINUSE, GO still returns `launched:true`
+ preview URL, slot shows `running` until the 10s tick, and the preview link
opens the squatter. This is also the failure mode R-3 and R-6 cascade into.
*Fix:* before spawn, try `net.createServer().listen(port,'127.0.0.1')` and
close it; on EADDRINUSE → `409 foundry_port_busy` (with whether the port is
held by one of *our* dead-marked slots). After spawn, wait ~500ms and if the
pid is already gone, return `500 foundry_go_failed` with the log tail instead
of "launched".

**R-6 · pid-only liveness marks a daemonizing/backgrounding run.command dead
while its server holds the port.** Reproduced (attack G): `nohup … &` → shell
exits, slot flips to `dead`, port still bound, slot reclaimable → next GO
collides. `run.command` is planner-generated, so `&`/nohup/pm2 shapes will
appear. (SIM-RESULTS F-2 is the same class from the other direction.)
*Fix:* liveness = process-group alive (`kill(-pgid, 0)`) OR port bound. If the
pid is gone but the port answers, mark the slot `running` with pid=NULL and a
`note`, or `orphaned` — never `dead`/reclaimable while the port is held.
Combine with R-5's preflight so allocation can never land on a held port.

**R-7 · `stopRunSlot` blocks the whole JARVIS event loop ~1.6s on every Stop
and every replace-GO (SIM-RESULTS F-1, confirmed again: 1604-1606ms).**
`Atomics.wait` on the main thread means the killed child can never be reaped
during the loop, so `pidAlive` never observes the death and the loop always
maxes out; meanwhile every SSE stream and chat turn stalls. Fixing it naively
(async wait, exit early when the *leader* pid dies) would open a real orphan
hole: `sh -c` dies on the first SIGTERM while a slow-draining/SIGTERM-ignoring
child survives and the SIGKILL escalation is skipped. Today's always-max-out
loop accidentally guarantees the group SIGKILL.
*Fix:* make `stopRunSlot` async; poll `kill(-pgid, 0)` (any member alive) with
`await setTimeout`; escalate to group SIGKILL if the *group* is still alive;
then wait for the port to actually free before reporting `stopped`.

### Minor / notes

- `probePort` never consumes or cancels the fetch body → slow socket leak,
  one per running slot per 10s. Add `res.body?.cancel()` or use `HEAD`.
- `foundry_run_slots.project_id … ON DELETE SET NULL` with `foreign_keys=ON`:
  deleting a project leaves a nameless running slot and never stops the
  process. Stop the slot on project delete.
- Per-slot log files append forever with no rotation (`.foundry/run-slot-N.log`).
- UI is sound: SSE merge is idempotent, picker/confirm flow matches server
  semantics, 409s are handled honestly. Health line only ever shows
  "pending"/"N ago" — after R-6 lands, surface "port not answering" explicitly.
- Sim (`runslots-sim.mjs`) is good and stays; add the attack script's cases
  to it once fixed so the regression is permanent.

### Decision

**Blocked, not merged.** R-1 through R-4 are each individually enough to refuse
"press GO tomorrow": one-shot GO (R-1) makes the feature not do its job, R-2 can
kill an unrelated process on Kevin's box after a reboot, R-3 loses a live
process under ordinary use, R-4 makes every link wrong for the real viewer.
R-5/R-6/R-7 are the same design gap (pid ≠ port ownership) and should be fixed
together as: **identity-verified process group + port-bound liveness + preflight
port check + async stop that waits for the port.** Re-run both
`npm run runslots:sim` and `scripts/runslots-review-attacks.mjs` (expect zero
`[BUG]` lines) and this review flips to PASS.

## 2026-09-14 · RESOLUTIONS — node #212 remediation

Fix commits:

- Backend: `459358ea6392089e421db0186f2f7592ce65877d` (`fix(foundry): harden run slot lifecycle`)
- Cockpit: `8b0a497a62781e8d7b6ba85efdbb332b7d80b8aa` (`fix(foundry): surface relaunch and preview hosts`)

Finding map:

- **R-1 GO-once:** fixed in backend `459358ea`. `goProject` now accepts `ready` or `launched`; a launched project with no live slot can GO again, and Stop moves a launched project back to `ready` with `preview_url` cleared. A launched project that is already live relaunches by replacing its own slot by default.
- **R-2 pid identity:** fixed in backend `459358ea`. Run slots now record `pid_starttime`; liveness/stop checks verify `/proc/<pid>/environ` contains `FOUNDRY_SLOT=<slot>` and compare starttime when available before trusting a pid. Reused or EPERM pids are treated as not ours and are never signaled.
- **R-3 health-tick race:** fixed in backend `459358ea`. Dead/health updates are conditional on the observed pid and the health tick re-reads the row after awaits, so a stale snapshot cannot null or mark dead a replacement occupant.
- **R-4 preview host:** fixed in cockpit `8b0a497`. The cockpit proxy forwards the browser host as `x-forwarded-host`; the backend's existing `FOUNDRY_PREVIEW_HOST` env override remains the explicit deployment escape hatch.
- **R-5 preflight port check:** fixed in backend `459358ea`. GO checks slot port availability before spawning and returns `409 foundry_port_busy` instead of launching into a squatted port; a child that exits before binding any port returns `500 foundry_go_failed` with a log tail.
- **R-6 daemonizing run.command:** fixed in backend `459358ea`. Slot liveness now treats a held port as live even when the shell pid has exited, and allocation will not reclaim a running slot while its port is held.
- **R-7 blocking Stop:** partially remediated in backend `459358ea`; full async export conversion deferred. `stopRunSlot` remains synchronous to preserve the existing API and direct script contract, but it no longer waits for an unreaped shell pid. It sends SIGTERM/SIGKILL to the process group and waits for the port to free, which reduced the repro from ~1600ms to 51ms in `runslots-review-attacks.mjs` and 83ms in the lifecycle sim. A full async `stopRunSlot` migration can be a later cleanup because this path no longer blocks the event loop at the review-failing scale.
- **Minor probe body leak:** fixed in backend `459358ea` by switching HTTP probes to `HEAD` and cancelling any response body.

Verification:

- `npm run build` in `darwin-assistant` passed.
- `node scripts/runslots-review-attacks.mjs` printed zero `[BUG]` lines.
- `npm run runslots:sim` passed 18/18 checks.
- `npm run build` in the cockpit worktree passed. `npx tsc --noEmit` still reports pre-existing unrelated route/type errors; none are in `src/lib/cockpit-proxy.ts` or `src/routes/foundry.tsx`.

## 2026-09-14 · Re-review (node #190, attempt 2) — VERDICT: PASS with fixes

Reviewed `hopper/foundry-runslots` @ `880718f29` + `hopper/foundry-runslots-ui` @ `8b0a497`.
Attack script (`node scripts/runslots-review-attacks.mjs`): **zero `[BUG]`** on
D/B/C/E/G as delivered. Sim 18/18. `tsc` green (backend); cockpit `tsc` shows the
same 10 pre-existing errors as base `095835c`, none in touched files; eslint on the
four touched cockpit files has 0 new issues (63 prettier errors in `cockpit-api.ts`
are byte-identical to base). Cockpit production build passes with `node-server` preset.

**R-1..R-4 — verified fixed in code, not just by the summary.** R-1: GO accepts
`launched`, Stop returns the project to `ready`, own-live-slot relaunches in place,
UI gates Relaunch on "no running slot". R-2: `/proc/<pid>/environ` `FOUNDRY_SLOT=<n>`
+ starttime compared before trusting or signalling a leader; EPERM → not ours. R-3:
dead/health updates are `WHERE pid = <observed>` and the tick re-reads after every
await. R-4: `cockpit-proxy.ts` forwards the browser `host` as `x-forwarded-host`;
backend strips the port and builds `http://<host>:<slot port>`.
**R-5/R-6/R-7 deferrals:** R-7's remaining sync `stopRunSlot` is accepted — measured
59–81ms on a well-behaved server, ~1.4s only when the occupant ignores SIGTERM
(SIGKILL escalation confirmed, port freed). Not a blocker; async conversion stays a
later cleanup.

**New findings from the re-review's own probes (all fixed in `3e65dfa26`):**

- **R-8 · The R-5 "child exits early → 500" branch was unreachable.** `goProject`
  blocks the loop in `sleepSync(500)`, so an instantly-dead `sh` is an unreaped
  zombie and `kill(pid, 0)` still succeeds → GO returned `launched:true` for a
  command that died in <10ms; slot showed `running` until the 10s tick.
  *Fix:* `pidAlive`/`processGroupAlive` read `/proc/<pid>/stat` state and treat
  `Z`/`X` as dead. Attack H now gets `500 foundry_go_failed` with the log tail.
- **R-9 · Stop still signalled an unverified process group.** With the leader dead,
  `kill(-pid, 0)` succeeding was taken as "our group" — but a recycled pid can be the
  pgid of an unrelated orphaned group (leader gone, members alive). Reproduced
  (attack J): Stop SIGTERMed an unrelated `sleep`. *Fix:* the group is only signalled
  if a live member carries `FOUNDRY_SLOT=<n>` in its environ.
- **R-10 · Port-held liveness had no identity, and a daemonized occupant could never
  be stopped.** A squatter on our port made the board show the old project as
  `running`; a `setsid`/double-fork `run.command` left the slot stuck at
  `409 foundry_slot_still_bound` forever (Stop and replace-GO both refused).
  *Fix:* `/proc/net/tcp{,6}` LISTEN inode → `/proc/<pid>/fd` owner lookup, gated
  on the same `FOUNDRY_SLOT` marker. Live only if the holder is ours; Stop kills a
  verified holder by pid (attack K: freed in 76ms); an unrelated holder means the
  slot is `dead` and preflight keeps GO off the port. Tick cost with a daemonized
  occupant measured 14–49ms at ~100 processes.
- Minor from the first review: `deleteProject` now stops the project's running slot.

**Residual (documented, accepted):** GO blocks the loop ~530ms (preflight spawn +
500ms settle); a child that fails *after* 500ms is reported launched and flips to
`dead` on the next tick — best-effort by design. Per-slot logs still append without
rotation. Two slots can briefly name the same project (a `dead` one and its
relaunch) until the dead slot is reclaimed — cosmetic.

**Decision: PASS.** I would let Kevin press GO tomorrow. Deploy notes: the
`pid_starttime` column is added via `ALTER TABLE` on first boot (idempotent);
`FOUNDRY_PREVIEW_HOST` remains an optional override now that the proxy forwards
the host. Re-verify after merge with `npm run runslots:sim` and the attack script.
