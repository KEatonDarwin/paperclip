# Foundry GO v2 Run Slots Design

Recon node: tree-b3ccebd3 / node 186  
Backend worktree: `/home/kevin/paperclip-worktrees/foundry-runslots`  
Cockpit checkout inspected read-only: `/home/kevin/paperclip/jarvis-command-center`

## Current State

Current GO lives in `darwin-assistant/src/foundry.ts` as `goProject(id)`.

What it does today:

- Requires the project status to be `ready`.
- Reads `project.run_command` or `blueprint.run.command`.
- Spawns the command with `shell: true`, `detached: true`, `stdio` appended to `<repo>/.foundry/run.log`.
- Deletes `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from the child environment.
- Does not capture or store the child pid.
- Does not assign a port.
- Does not health check the process.
- Does not expose a stop operation.
- Sets `foundry_projects.status = 'launched'`.
- Sets `foundry_projects.preview_url` to `blueprint.run.preview_url` if present.
- Emits the existing `foundry_project` SSE event.
- Sets the origin thread preview link if a preview URL exists.

Current API wiring in `src/handlers/api-v1.ts`:

- `POST /foundry/projects/:id/go` calls `goFoundryProject(id)` with body ignored.
- Existing Foundry SSE events forwarded by `/events`: `foundry_project`, `foundry_module`.

Current cockpit wiring:

- `goFoundryProject(id)` in `src/lib/cockpit-api.ts` posts `{}` and expects `{ project, launched, preview_url }`.
- `/foundry` renders GO only for `project.status === "ready"`.
- It renders `project.previewUrl` as the Preview link after launch.
- There is no run-slot board, slot type, stop call, or slot SSE listener today.

Blueprint run contract currently used by both backend and cockpit:

```json
{
  "run": {
    "command": "npm start",
    "preview_url": "http://localhost:4310"
  }
}
```

`run.command` is mandatory in planner validation. `run.preview_url` is optional and should remain a secondary hint after GO v2 assigns the real slot URL.

## Port Check

Checked with:

```sh
ss -tlnp | awk 'NR==1 || /:(4310|4311|4312)\b/'
```

Result: no listeners on 4310, 4311, or 4312. Keep defaults:

- Slot 1: 4310
- Slot 2: 4311
- Slot 3: 4312

Override env:

```sh
FOUNDRY_RUN_PORTS=4310,4311,4312
```

Parsing rule: exactly three distinct valid TCP port numbers. If malformed, log a warning and fall back to `4310,4311,4312`. On boot, update ports for non-running slots. If a recorded pid is still alive and its configured port changed, keep that row's existing port until it is stopped or dies so the server does not lie about a live process.

## Data Model

Add this table in `src/foundry.ts` next to the existing module-local table setup:

```sql
CREATE TABLE IF NOT EXISTS foundry_run_slots (
  slot_no        INTEGER PRIMARY KEY CHECK (slot_no BETWEEN 1 AND 3),
  port           INTEGER NOT NULL,
  project_id     TEXT REFERENCES foundry_projects(id) ON DELETE SET NULL,
  pid            INTEGER,
  run_command    TEXT,
  log_path       TEXT,
  started_at     TEXT,
  status         TEXT NOT NULL DEFAULT 'free'
                 CHECK (status IN ('free','running','dead','stopped')),
  last_health_at TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_foundry_run_slots_project
  ON foundry_run_slots(project_id);
```

Slot meaning:

- `free`: no occupant, available immediately.
- `running`: pid is recorded and alive. Counts as busy.
- `dead`: process exited or pid vanished. Reclaimable without `replace`.
- `stopped`: server intentionally stopped it. Reclaimable without `replace`.

Keep `project_id`, `run_command`, `log_path`, and `started_at` on `dead` and `stopped` rows until reused. That lets the cockpit explain what was last in the slot. On allocation, overwrite the occupant fields.

Seed rows at startup for slot numbers 1, 2, and 3. Do not create arbitrary slot numbers.

## API Contract

### `GET /foundry/run-slots`

Returns the three slot rows, always sorted by `slot_no`.

Response:

```json
{
  "slots": [
    {
      "slot_no": 1,
      "port": 4310,
      "project_id": "hello-foundry",
      "project_name": "Hello Foundry",
      "pid": 12345,
      "run_command": "PORT=4310 npm start",
      "log_path": "/home/kevin/foundry/hello-foundry/.foundry/run-slot-1.log",
      "started_at": "2026-09-14 10:12:00",
      "status": "running",
      "last_health_at": "2026-09-14 10:12:10",
      "preview_url": "http://localhost:4310"
    }
  ]
}
```

`project_name` and `preview_url` are response conveniences, not required table columns. `preview_url` is `http://<host>:<port>` using the same host resolution as GO below.

### `POST /foundry/projects/:id/go`

Body:

```json
{
  "slot_no": 2,
  "replace": false
}
```

Fields:

- `slot_no` optional. If omitted, allocate the lowest reclaimable slot (`free`, `dead`, or `stopped`).
- `replace` optional boolean. If true and the target slot is `running`, stop and evict it first.

Responses:

```json
{
  "project": { "...": "serialized FoundryProject" },
  "launched": true,
  "preview_url": "http://localhost:4310",
  "slot": { "...": "serialized FoundryRunSlot" },
  "blueprint_preview_url": "http://localhost:8090"
}
```

Compatibility: keep `project`, `launched`, and `preview_url` at top level exactly as today. The UI node can start by ignoring `slot` and still work.

Errors:

- `404 foundry_project_not_found`
- `409 foundry_project_not_ready`
- `400 foundry_missing_run_command`
- `400 foundry_invalid_slot` if `slot_no` is not 1, 2, or 3.
- `409 foundry_slot_occupied` if a targeted slot is `running` and `replace` is false.
- `409 foundry_slots_full` if all three slots are `running` and no target+replace was supplied.
- `500 foundry_go_failed` for spawn or filesystem errors.

Slot-full error body should include occupants:

```json
{
  "error": "foundry_slots_full",
  "message": "all Foundry run slots are busy",
  "slots": [
    { "slot_no": 1, "project_id": "a", "project_name": "A", "port": 4310, "pid": 111 },
    { "slot_no": 2, "project_id": "b", "project_name": "B", "port": 4311, "pid": 222 },
    { "slot_no": 3, "project_id": "c", "project_name": "C", "port": 4312, "pid": 333 }
  ]
}
```

### `POST /foundry/run-slots/:slot_no/stop`

Body can be `{}`. Stops the recorded process group for the slot if it is running.

Response:

```json
{
  "slot": { "...": "serialized FoundryRunSlot" }
}
```

Stop behavior:

1. If pid exists and is alive, send `SIGTERM` to the negative pid (`process.kill(-pid, "SIGTERM")`) to stop the detached process group.
2. Wait briefly in-process using small retries, not a long blocking wait.
3. If it is still alive, send `SIGKILL` to `-pid`.
4. Set `pid = NULL`, `status = 'stopped'`, `last_health_at = NULL`, keep occupant metadata.
5. Emit `foundry_run_slot`.

If the slot is already `free`, `dead`, or `stopped`, return the current slot row successfully.

## Host and Preview URL Rules

GO v2 should make the assigned slot URL the canonical project preview:

```text
http://<host>:<port>
```

Host resolution in the route:

1. `FOUNDRY_PREVIEW_HOST`, if set.
2. `X-Forwarded-Host` hostname, if present.
3. `Host` header hostname, with any port stripped.
4. `localhost` fallback.

Pass this host into `goProject(id, opts)` from the API handler. Avoid burying Express `req` inside `foundry.ts`.

On GO:

- Set `foundry_projects.preview_url` to the slot URL.
- Preserve `blueprint.run.preview_url` as `blueprint_preview_url` in the GO response and in the project blueprint.
- Set the origin thread link bar to the slot URL.
- Keep status semantics unchanged: project becomes `launched`.

If the host header comes through as `localhost` from a server-side/proxy call, the UI still has the slot board with port/project/log data. `FOUNDRY_PREVIEW_HOST` is the clean override if Kevin wants LAN-visible links.

## Process Launch Rules

Build the effective command like this:

1. Start from `project.run_command` or `blueprint.run.command`.
2. Replace every literal `{{port}}` with the allocated port.
3. Spawn with env:
   - `PORT=<port>`
   - `FOUNDRY_SLOT=<slot_no>`
   - existing process env
   - `ANTHROPIC_API_KEY` deleted
   - `OPENAI_API_KEY` deleted
4. Spawn with:

```ts
const child = spawn(effectiveCommand, {
  cwd: project.repo_path,
  shell: true,
  detached: true,
  stdio: ["ignore", out, out],
  env: childEnv,
});
child.unref();
```

Detached process group is required so `POST /foundry/run-slots/:n/stop` can kill the whole command tree with `process.kill(-pid, signal)`. With `shell: true`, the child pid is the shell process group leader under Node's detached mode.

Logs:

```text
<repo>/.foundry/run-slot-<slot_no>.log
```

Open in append mode, same as current `run.log`. The UI can expose the path first; a log streaming endpoint can be a later rung.

After spawn succeeds, record:

- `project_id`
- `pid = child.pid`
- `run_command = effectiveCommand`
- `log_path`
- `started_at = datetime('now')`
- `status = 'running'`
- `last_health_at = NULL` until first successful probe

If `child.pid` is missing, treat as `foundry_go_failed`.

## Allocation Rules

Before allocation, run a cheap reconciliation pass on the slots so stale pid state does not block GO.

Definitions:

- Busy: `status = 'running'` and pid is alive.
- Reclaimable: `status IN ('free','dead','stopped')`, or `status = 'running'` with missing/dead pid after reconciliation.

No `slot_no` supplied:

1. Pick the lowest reclaimable slot.
2. If none exists, return `409 foundry_slots_full`.

`slot_no` supplied:

1. If target slot is reclaimable, use it.
2. If target slot is running and `replace !== true`, return `409 foundry_slot_occupied`.
3. If target slot is running and `replace === true`, stop it, mark `stopped`, then use it.

Dead and stopped slots do not require `replace`; they are already reclaimable.

## Health Loop

Start from `startFoundry()`:

- Existing behavior: attach `handleFoundrySse`.
- New behavior:
  - `ensureRunSlots()`
  - `reconcileRunSlotsAtBoot()`
  - `setInterval(runSlotHealthTick, 10_000).unref?.()`

Every tick:

1. Load all slots.
2. For each `running` slot:
   - If pid missing or `process.kill(pid, 0)` fails:
     - Set `pid = NULL`
     - Set `status = 'dead'`
     - Set `last_health_at = NULL`
     - Emit `foundry_run_slot`
     - Emit `foundry_project` for the occupant project if it still exists, but do not change project status. `launched` continues to mean "GO was pressed"; the slot status says whether it is alive.
   - If pid alive, best-effort probe the port.
3. Probe:
   - Try `http://127.0.0.1:<port>/health` with a short timeout.
   - If connection fails or returns 404, try `http://127.0.0.1:<port>/`.
   - Any HTTP response or successful socket connection means the app is reachable enough for v0; set `last_health_at = datetime('now')`.
   - Do not mark the slot dead for HTTP failure while the pid is alive. Some apps take time to boot or do not serve `/`.

Do not emit SSE every 10 seconds just because `last_health_at` changed. Emit on status/project/pid transitions. The cockpit can poll `GET /foundry/run-slots` every few seconds for freshness.

## Boot Reconcile

At service start:

1. Ensure exactly three slot rows exist.
2. For each recorded `running` slot:
   - If pid is alive, keep it running.
   - If pid is gone, set `pid = NULL`, `status = 'dead'`, `last_health_at = NULL`.
3. For rows with `status = 'running'` and `pid IS NULL`, mark `dead`.
4. For `free` rows, make sure occupant fields are null.

Do not attempt to adopt arbitrary processes by port. The DB is the source of truth for slots; boot reconcile only validates recorded pids.

## SSE

Add a new event in `src/sse-bus.ts`:

```ts
export interface FoundryRunSlotEvent {
  type: "foundry_run_slot";
  action: "updated";
  slot: FoundryRunSlotResponse;
}
```

Add `foundry_run_slot` to the `/events` FORWARD set in `src/handlers/api-v1.ts` and to cockpit `sse-worker.ts` event types.

Emit:

- After GO allocates a slot.
- After stop changes a slot.
- After health tick marks a slot dead.
- After boot reconcile changes any slot.

Also keep emitting `foundry_project` on GO so existing `/foundry` behavior updates without the new board.

## Backend Shape

Recommended backend additions in `src/foundry.ts`:

- Types:
  - `FoundryRunSlotStatus`
  - `FoundryRunSlotRow`
  - `FoundryRunSlotResponse`
  - `GoProjectOptions`
- Statements:
  - `getRunSlotStmt`
  - `listRunSlotsStmt`
  - `upsertRunSlotStmt`
  - `setRunSlotRunningStmt`
  - `setRunSlotStoppedStmt`
  - `setRunSlotDeadStmt`
  - `setRunSlotHealthStmt`
- Functions:
  - `configuredRunPorts(): [number, number, number]`
  - `ensureRunSlots(): void`
  - `listRunSlots(host?: string): FoundryRunSlotResponse[]`
  - `stopRunSlot(slotNo: number): FoundryRunSlotResponse`
  - `goProject(id: string, opts?: { slot_no?: number; replace?: boolean; host?: string })`
  - `runSlotHealthTick(): Promise<void>`
  - `reconcileRunSlotsAtBoot(): void`
  - `emitRunSlot(slot)`

Keep all implementation in `foundry.ts` for v0. It already owns GO, Foundry tables, status serialization, SSE, and `startFoundry()`. If it grows too large later, extract to `foundry-run-slots.ts`.

`src/handlers/api-v1.ts` additions:

- Import `listFoundryRunSlots` and `stopFoundryRunSlot`.
- Add `GET /foundry/run-slots`.
- Add `POST /foundry/run-slots/:slot_no/stop`.
- Parse GO body and pass `{ slot_no, replace, host }` into `goFoundryProject`.
- Compute `host` in the route via `FOUNDRY_PREVIEW_HOST` or headers.

## Cockpit Awareness

The UI node has its own worktree, but this is the expected contract.

`src/lib/cockpit-api.ts`:

- Add `FoundryRunSlot` type.
- Add `listFoundryRunSlots()`.
- Add `stopFoundryRunSlot(slotNo)`.
- Extend `goFoundryProject(id, body?)` to accept `{ slotNo?: number; replace?: boolean }`.
- Parse optional `slot` and `blueprint_preview_url`.
- Add `onFoundryRunSlot` handler for SSE.

`src/routes/foundry.tsx`:

- Add a run slots board to `/foundry` (top-level or right rail):
  - Three cards, one per slot.
  - Show port, status, project name/id, pid, uptime from `started_at`, health freshness from `last_health_at`, log path.
  - Actions: Open Preview, Stop.
- When a project is ready and all three slots are busy, GO should open a slot picker instead of blind failing:
  - Pick free/dead/stopped if available.
  - If all running, show occupants and require explicit Replace.
- Keep the existing project Preview link. It should point at the assigned slot URL after GO.

Poll fallback: list slots every 5 seconds while `/foundry` is open, matching existing Foundry page behavior. SSE updates make it feel live.

## Compatibility and Non-Goals

Compatibility:

- Project status `launched` semantics stay unchanged.
- Existing `preview_url` field remains the canonical preview link in the project response.
- Existing GO response remains compatible with current cockpit code.
- Blueprint `run.preview_url` remains accepted but becomes secondary.

Non-goals for this node:

- No public deploy target.
- No log streaming endpoint.
- No dynamic slot count.
- No process adoption by port scan.
- No live service restart by workers.
- No API keys.

## Suggested Verification

Backend node:

1. Unit/smoke test `configuredRunPorts()` with default, valid env, invalid env, duplicate ports.
2. Smoke `GET /foundry/run-slots` returns exactly three slots.
3. Create a ready fixture project with `run.command = "node -e \"require('http').createServer((_,res)=>res.end('ok')).listen(process.env.PORT)\""` and GO it.
4. Assert slot has pid, `status = running`, log path set, project `preview_url` is `http://<host>:<port>`.
5. Assert all three occupied returns `409 foundry_slots_full`.
6. Assert `POST /foundry/run-slots/:n/stop` kills the process group and marks `stopped`.
7. Simulate stale pid in DB and run boot reconcile/health tick; assert `dead`.

UI node:

1. Typecheck.
2. Mock/real API smoke: `/foundry` renders three slot cards.
3. GO from ready project opens assigned preview link.
4. Busy slots show picker and replace affordance.
5. Stop button updates card state.
