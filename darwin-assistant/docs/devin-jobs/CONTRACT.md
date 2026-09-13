# Devin Jobs Contract

Status: recon and implementation contract for tree `tree-654dde7b`, node `167`.

Branch: `hopper/devin-jobs`

Scope: ACU meter, Devin cloud job dispatch, cockpit job board, and an engine-native contract for returning Devin cloud work into Hopper trees.

This document is intentionally a contract, not an implementation. The next workers should build to this shape unless Kevin changes the product decision.

## 1. Source Of Truth

The Devin API contract below is based on the public v3 API docs and OpenAPI spec, not guessed from memory.

- Docs overview: `https://docs.devin.ai/api-reference/overview`
- OpenAPI index: `https://docs.devin.ai/llms.txt`
- OpenAPI spec: `https://docs.devin.ai/v3-openapi.yaml`
- Pagination docs: `https://docs.devin.ai/api-reference/concepts/pagination`

OpenAPI anchors from the fetched spec:

- Bearer auth is global: `components.securitySchemes.bearerAuth` at OpenAPI lines 7474-7478, and global `security: bearerAuth` at lines 24700-24701.
- `GET /v3/self` returns the authenticated principal plus `org_id`: OpenAPI lines 21675-21728. It can return `ServiceUserSelf`, `PatUserSelf`, `DevinBrainUserSelf`, or `WindsurfSessionUserSelf`.
- `ServiceUserSelf` includes `org_id`, `service_user_id`, and `service_user_name`: OpenAPI lines 5987-6010.
- `PatUserSelf` includes `org_id`, `user_id`, `api_key_id`, and `api_key_name`: OpenAPI lines 4940-4971.
- `SessionCreateRequest` defines `prompt`, `devin_mode`, `max_acu_limit`, `structured_output_required`, `structured_output_schema`, `tags`, and `title`: OpenAPI lines 6127-6265.
- Session status fields and response fields include `session_id`, `status`, `status_detail`, `structured_output`, `acus_consumed`, `tags`, and `url`: OpenAPI lines 6454-6678, with the same fields on `SessionResponse` around lines 6816-7014.
- `SessionMessageCreateRequest` requires `message` and optionally accepts `attachment_urls` and `message_as_user_id`: OpenAPI lines 6746-6769.
- `GET/POST /v3/organizations/{org_id}/sessions`: OpenAPI lines 20543-20690.
- `GET /v3/organizations/{org_id}/sessions/{devin_id}`: OpenAPI lines 20847-20917.
- `GET/POST /v3/organizations/{org_id}/sessions/{devin_id}/messages`: OpenAPI lines 21215-21380.
- Session tags endpoints live at `/v3/organizations/{org_id}/sessions/{devin_id}/tags`: OpenAPI lines 21381-21490 and following.
- Org daily consumption endpoint: `GET /v3/organizations/{org_id}/consumption/daily`: OpenAPI lines 18022-18101.
- Consumption response fields are `total_acus` and `consumption_by_date`: OpenAPI lines 3191-3205.

Generated-spec wrinkle: the OpenAPI listing for `GET /v3/organizations/{org_id}/sessions` shows a required query parameter named `qs` that references `SessionsQueryParams` at lines 20558-20562. The pagination docs and API style describe ordinary cursor params such as `first` and `after`. Implement normal query params first (`first`, `after`, `tags`, `origins`, etc.); if the first live call with Kevin's key returns a validation error that specifically names `qs`, add a compatibility retry. Do not bake in a nested `qs` shape before seeing that failure live.

## 2. Local House Patterns To Reuse

Backend worktree:

- `src/handlers/api-v1.ts:582` through `src/handlers/api-v1.ts:605` define the generic provider-usage window shape already used by Claude, Codex, and Augment.
- `src/handlers/api-v1.ts:669` through `src/handlers/api-v1.ts:756` show the file-backed `readCodexUsage` and `readAugmentUsage` pattern. Devin should follow this rather than adding a second usage endpoint shape.
- `src/handlers/api-v1.ts:994` through `src/handlers/api-v1.ts:999` is the current `/provider-usage` response assembly. Add `devin` beside `claude`, `openai_codex`, and `augment`.
- `src/handlers/api-v1.ts:296` through `src/handlers/api-v1.ts:309` is the governor settings catalog. Add Devin settings there so the cockpit settings page can save them.
- `src/handlers/api-v1.ts:1952` through `src/handlers/api-v1.ts:1994` is the `GET/PATCH /hopper-engine/settings` settings-KV route. Reuse it for `devin_max_concurrent`, `devin_acu_pool`, `devin_billing_cycle_start`, `devin_billing_cycle_end`, and `gov_devin_acu_ceiling`.
- `src/handlers/api-v1.ts:3920` through `src/handlers/api-v1.ts:3922` is the SSE forward set. Add `devin_job`.
- `src/conversation-db.ts:819` through `src/conversation-db.ts:854` defines the `settings` table plus uncached `getSetting` and `setSetting`. Use `getSetting`, not an in-memory cache, for the concurrency and ACU gates.
- `src/hopper.ts:20` through `src/hopper.ts:33` shows the row/interface shape for a small SQLite-backed operational store.
- `src/hopper.ts:35` through `src/hopper.ts:53` shows local table creation with `sqliteDb.exec`.
- `src/hopper.ts:84` through `src/hopper.ts:147` shows emit-on-write CRUD helpers. Devin jobs should emit SSE on create, update, message, and settle.
- `src/hopper.ts:152` through `src/hopper.ts:177` is the correct posture for untrusted inbound data. Devin structured output must be treated the same way when folded back into Hopper.
- `src/sse-bus.ts:103` through `src/sse-bus.ts:111` and `src/sse-bus.ts:219` and following show global event definitions for small stores such as thread links and hopper items. Add a `DevinJobEvent`.
- `src/hopper-engine.ts:33` through `src/hopper-engine.ts:64` define Hopper node statuses and rows. `node_id` on `devin_jobs` must reference this ID when Devin is executing for a tree.
- `src/hopper-engine.ts:471` through `src/hopper-engine.ts:506` is the worker finish contract. The Devin structured output contract must map onto this, but the returned text is untrusted data.
- `src/hopper-engine.ts:590` through `src/hopper-engine.ts:641` is the authoritative finish state transition. The reconciler should call this in-process when possible.
- `src/hopper-engine.ts:672` through `src/hopper-engine.ts:761` is dispatch plus governor integration. A future engine-native Devin adapter can use the same gates.
- `src/hopper-governor.ts:52` through `src/hopper-governor.ts:71` is the settings helper for governor values.
- `src/hopper-governor.ts:102` through `src/hopper-governor.ts:110` already classifies `devin` as a provider.
- `src/hopper-governor.ts:204` through `src/hopper-governor.ts:222` reads generic file-backed usage meters. Devin's poller should write the same shape.
- `src/hopper-governor.ts:229` through `src/hopper-governor.ts:234` currently has a placeholder Devin meter with `file: null`. Replace it with `DEVIN_USAGE_FILE` when the poller ships.

Frontend worktree:

- `src/lib/cockpit-api.ts:1585` through `src/lib/cockpit-api.ts:1615` defines `ProviderUsageResponse` and reusable provider window types. Add `devin?: CodexProviderUsage | null`.
- `src/lib/cockpit-api.ts:1628` through `src/lib/cockpit-api.ts:1665` defines governor settings and provider state types. Add the Devin settings and meter fields.
- `src/routes/threads.tsx:5625` through `src/routes/threads.tsx:5792` is the provider usage widget. Add a Devin provider block using the existing `UsageBar`.
- `src/routes/threads.tsx:5794` through `src/routes/threads.tsx:5825` supports a null percentage plus `value_label`. That is the exact UI needed when ACU pool is unknown.
- `src/routes/settings.governor.tsx:34` through `src/routes/settings.governor.tsx:39` already labels Devin as a provider state. Expand the settings form in the same file around lines 151-229.

## 3. Environment And Key Handling

All Devin cloud-job features key off:

```env
DEVIN_API_KEY=...
```

Optional settings or environment values:

```env
DEVIN_ORG_ID=...
DEVIN_USAGE_FILE=/tmp/devin-usage-live.json
```

`DEVIN_ORG_ID` is optional. The client should discover the org with:

```http
GET https://api.devin.ai/v3/self
Authorization: Bearer <DEVIN_API_KEY>
```

The response type includes `org_id` for service users, PAT users, Devin brain users, and Windsurf session users. Cache the discovered org ID in memory for the current process only. If Kevin later sets `DEVIN_ORG_ID`, prefer the explicit value.

Never log `DEVIN_API_KEY`, never echo request headers, and never include the key in error messages. Sanitized errors may include HTTP status, Devin error code/message, and endpoint path.

When `DEVIN_API_KEY` is absent:

- The server must not crash on startup.
- `GET /provider-usage` must include a Devin status tile payload with no percentage and a value label of `key needed for usage`.
- `GET /devin/jobs` must still return local stored jobs.
- `POST /devin/jobs` and `POST /devin/jobs/:id/message` must return HTTP 409 with a clear `devin_key_missing` error.
- The reconciler must skip remote polling and leave existing local rows untouched.

Typed client error:

```ts
export class DevinKeyMissing extends Error {
  code = 'devin_key_missing' as const;
  status = 409 as const;
}
```

The REST client should live in `src/devin-api.ts`. Store and route logic should live in `src/devin-jobs.ts`, mirroring `src/hopper.ts`.

## 4. Devin REST API Contract

Base URL:

```text
https://api.devin.ai/v3
```

Auth:

```http
Authorization: Bearer <DEVIN_API_KEY>
```

### 4.1 Discover Self

```http
GET /self
```

Purpose: discover `org_id` and identity fields without requiring Kevin to set a second env var.

Expected useful response fields:

```json
{
  "org_id": "org_...",
  "principal_type": "service_user",
  "service_user_id": "..."
}
```

or:

```json
{
  "org_id": "org_...",
  "principal_type": "pat_user",
  "user_id": "...",
  "api_key_id": "..."
}
```

### 4.2 Create Session

```http
POST /organizations/{org_id}/sessions
Content-Type: application/json
```

Request body for normal JARVIS jobs:

```json
{
  "title": "Short user-facing title",
  "prompt": "Full work prompt",
  "devin_mode": "lite",
  "structured_output_required": true,
  "structured_output_schema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["outcome", "summary"],
    "properties": {
      "outcome": { "type": "string", "enum": ["done", "blocked"] },
      "summary": { "type": "string" },
      "branch": { "type": ["string", "null"] },
      "commits": {
        "type": ["array", "null"],
        "items": { "type": "string" }
      },
      "notes": {
        "type": ["array", "null"],
        "items": { "type": "string" }
      }
    }
  },
  "tags": ["jarvis", "devin-jobs"],
  "resumable": true
}
```

Accepted `devin_mode` values from OpenAPI:

- `normal`
- `fast`
- `lite`
- `ultra`
- `fusion`

Default for JARVIS-created jobs: `lite`, unless the caller passes `devin_mode`.

If `node_id` is present, add tags:

```json
["jarvis", "devin-jobs", "hopper", "hopper-node-167"]
```

If an ACU ceiling is configured, optionally pass `max_acu_limit` as the smaller of:

- Remaining ACUs before `gov_devin_acu_ceiling`
- A future per-job setting such as `devin_job_max_acu`

Do not invent `max_acu_limit` in v0 if no setting exists.

Expected response fields to persist:

```json
{
  "session_id": "ae66f8d44fdc48af86c7ee69a9180530",
  "title": "Short user-facing title",
  "status": "running",
  "status_detail": "working",
  "acus_consumed": 0,
  "url": "https://app.devin.ai/sessions/ae66f8d44fdc48af86c7ee69a9180530",
  "structured_output": null,
  "tags": ["jarvis", "devin-jobs"],
  "devin_mode": "lite",
  "created_at": "2026-09-13T..."
}
```

### 4.3 List Sessions

```http
GET /organizations/{org_id}/sessions?first=100&after=<cursor>
```

Use cursor pagination:

- Request: `first`, optional `after`
- Response: `items`, `has_next_page`, `end_cursor`

Useful filters from `SessionsQueryParams`:

- `tags`
- `origins`
- `session_ids`
- `service_user_ids`
- `user_ids`
- `repo_names`

For the usage poller, prefer org consumption endpoints. If session summing is needed as fallback, page sessions with `first=200`, filter by cycle window and by tags where possible.

### 4.4 Get Session

```http
GET /organizations/{org_id}/sessions/{devin_id}
```

`devin_id` is the session ID returned by create/list.

Persist these fields on every reconcile tick:

```json
{
  "session_id": "...",
  "status": "running",
  "status_detail": "working",
  "acus_consumed": 1.25,
  "url": "https://app.devin.ai/sessions/...",
  "structured_output": {
    "outcome": "done",
    "summary": "..."
  },
  "tags": ["jarvis", "devin-jobs"]
}
```

Known `status` enum:

- `new`
- `claimed`
- `running`
- `exit`
- `error`
- `suspended`
- `resuming`

Known `status_detail` enum:

- `working`
- `waiting_for_user`
- `waiting_for_approval`
- `finished`
- `inactivity`
- `user_request`
- `usage_limit_exceeded`
- `out_of_credits`
- `out_of_quota`
- `no_quota_allocation`
- `payment_declined`
- `org_usage_limit_exceeded`
- `user_usage_limit_exceeded`
- `total_session_limit_exceeded`
- `error`

### 4.5 Send Message

```http
POST /organizations/{org_id}/sessions/{devin_id}/messages
Content-Type: application/json
```

Request:

```json
{
  "message": "Additional instruction or answer"
}
```

Optional fields:

```json
{
  "attachment_urls": ["https://..."],
  "message_as_user_id": "..."
}
```

Response: `SessionResponse`. Update the local job row from the response immediately.

### 4.6 List Messages

```http
GET /organizations/{org_id}/sessions/{devin_id}/messages?first=100&after=<cursor>
```

Response items are `SessionMessage`:

```json
{
  "event_id": "...",
  "source": "devin",
  "message": "...",
  "created_at": "2026-09-13T..."
}
```

V0 does not need to store messages separately. The dispatch board can link to `session_url` and show `status_detail`.

### 4.7 Consumption

Preferred meter endpoint:

```http
GET /organizations/{org_id}/consumption/daily?time_after=<iso>&time_before=<iso>
```

Response:

```json
{
  "total_acus": 12.5,
  "consumption_by_date": {
    "2026-09-13": 12.5
  }
}
```

Use this for the Provider Usage widget when it works with Kevin's key.

If the org daily consumption endpoint returns 403 for Kevin's key, fall back to summing `acus_consumed` from sessions in the current cycle. Record the fallback in `source: "devin-sessions"` so the UI and logs show the lower-confidence source.

There is no org-scoped billing-cycle discovery endpoint in the inspected v3 OpenAPI. Enterprise APIs expose additional consumption cycle shapes, but the v0 JARVIS implementation should not depend on an enterprise key. Use settings for the cycle window:

- `devin_billing_cycle_start`: ISO timestamp or `YYYY-MM-DD`
- `devin_billing_cycle_end`: ISO timestamp or `YYYY-MM-DD`

If no cycle window is configured, the poller may show all available API-tagged sessions or the last 30 days, but it must set `resets_at: null` and explain the source in `value_label` or `detail`.

## 5. Local Database Contract

Create a new SQLite table in `jarvis.db` from `src/devin-jobs.ts`.

```sql
CREATE TABLE IF NOT EXISTS devin_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE,
  title TEXT NOT NULL,
  prompt_summary TEXT NOT NULL,
  devin_mode TEXT NOT NULL DEFAULT 'lite',
  status TEXT NOT NULL DEFAULT 'local_pending',
  status_detail TEXT,
  acus_consumed REAL NOT NULL DEFAULT 0,
  session_url TEXT,
  structured_output TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  node_id INTEGER,
  thread_ext TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_devin_jobs_status ON devin_jobs(status, settled_at);
CREATE INDEX IF NOT EXISTS idx_devin_jobs_node_id ON devin_jobs(node_id);
CREATE INDEX IF NOT EXISTS idx_devin_jobs_thread_ext ON devin_jobs(thread_ext);
```

Column meanings:

- `id`: local integer ID for cockpit routes and UI.
- `session_id`: Devin's cloud session ID. Nullable only before create returns or when a create attempt failed before remote creation.
- `title`: short display title.
- `prompt_summary`: a short local summary of the prompt, not the full prompt. Do not store sensitive prompt bodies unnecessarily.
- `devin_mode`: Devin mode used for creation.
- `status`: latest Devin status, or local status such as `local_pending` or `create_failed`.
- `status_detail`: latest Devin status detail.
- `acus_consumed`: latest observed session ACUs.
- `session_url`: Devin app URL for user inspection.
- `structured_output`: JSON string from Devin. Treat as untrusted.
- `tags`: JSON string array.
- `node_id`: optional Hopper node ID. When set and the job settles, the reconciler folds the result into that node.
- `thread_ext`: optional cockpit thread external ID for user-initiated jobs.
- `created_at`: local row creation time.
- `settled_at`: set once when JARVIS considers the job final.

## 6. Backend Routes

Add routes in `src/handlers/api-v1.ts`, grouped near other global operational stores such as `/hopper` and `/intel-desk`.

### 6.1 List Jobs

```http
GET /api/v1/devin/jobs?status=active|settled|all&limit=100
```

No Devin key required. This reads local rows only.

Response:

```json
{
  "items": [
    {
      "id": 1,
      "session_id": "...",
      "title": "Research pricing API",
      "prompt_summary": "Inspect docs and summarize pricing endpoint.",
      "devin_mode": "lite",
      "status": "running",
      "status_detail": "working",
      "acus_consumed": 0.4,
      "session_url": "https://app.devin.ai/sessions/...",
      "structured_output": null,
      "tags": ["jarvis", "devin-jobs"],
      "node_id": 167,
      "thread_ext": "cockpit:...",
      "created_at": "2026-09-13T...",
      "settled_at": null
    }
  ],
  "config": {
    "key_ready": true,
    "max_concurrent": 2,
    "active_jobs": 1,
    "cycle_acus_used": 3.2,
    "acu_ceiling": 20
  }
}
```

### 6.2 Create Job

```http
POST /api/v1/devin/jobs
Content-Type: application/json
```

Body:

```json
{
  "title": "Build importer smoke test",
  "prompt": "Full Devin prompt...",
  "devin_mode": "lite",
  "schema": {
    "type": "object"
  },
  "tags": ["optional-extra-tag"],
  "node_id": 167,
  "thread_ext": "cockpit:hopper-node-167-..."
}
```

Validation:

- `title` required, non-empty, max 160 chars.
- `prompt` required, non-empty.
- `devin_mode` optional, one of `normal`, `fast`, `lite`, `ultra`, `fusion`; default `lite`.
- `schema` optional JSON object. Default is the Hopper finish schema in section 8.
- `tags` optional string array, max 50 total after system tags.
- `node_id` optional integer.
- `thread_ext` optional string.

Before remote create:

1. If `DEVIN_API_KEY` missing, return HTTP 409:

```json
{
  "error": "devin_key_missing",
  "message": "DEVIN_API_KEY is not configured. Mint one in app.devin.ai -> Settings -> API Keys and add it to darwin-assistant/.env."
}
```

2. Count active local jobs:

```sql
SELECT COUNT(*)
FROM devin_jobs
WHERE settled_at IS NULL
  AND status NOT IN ('exit', 'error', 'suspended', 'create_failed');
```

If count is greater than or equal to settings-KV `devin_max_concurrent` (default `2`), return HTTP 409:

```json
{
  "error": "devin_concurrency_limit",
  "message": "Devin already has 2 active jobs. Wait for one to settle or raise devin_max_concurrent."
}
```

3. Read current-cycle usage from `/tmp/devin-usage-live.json` if present. Refuse when `used_acus >= acu_ceiling`.

ACU ceiling resolution:

- `gov_devin_acu_ceiling` if set.
- Else `devin_acu_pool` if set.
- Else no ACU ceiling gate, only display usage.

If the ceiling is reached, return HTTP 409:

```json
{
  "error": "devin_acu_ceiling",
  "message": "Devin ACU ceiling reached for the current cycle."
}
```

On success:

1. Insert local row with `status: local_pending`.
2. Call Devin create session.
3. Update the row with returned `session_id`, `status`, `status_detail`, `acus_consumed`, `session_url`, `structured_output`, and `tags`.
4. Emit `devin_job` SSE.
5. Return HTTP 201 with the serialized row.

### 6.3 Send Job Message

```http
POST /api/v1/devin/jobs/:id/message
Content-Type: application/json
```

Body:

```json
{
  "message": "Use the stricter schema from the contract and try again."
}
```

Behavior:

- Missing `DEVIN_API_KEY` returns the same HTTP 409 `devin_key_missing`.
- Unknown local job returns 404.
- Job without `session_id` returns 409 `devin_session_missing`.
- Calls Devin `POST /organizations/{org_id}/sessions/{session_id}/messages`.
- Updates local row from returned `SessionResponse`.
- Emits `devin_job` SSE.

## 7. Reconciler Contract

Add an in-server 60-second reconciler tick, not just a systemd poller.

Suggested module: `src/devin-jobs-reconciler.ts`.

Startup hook: call `startDevinJobsReconciler()` from the same server startup path that installs Hopper and monitor loops. It must be safe to call once, and it must skip cleanly when `DEVIN_API_KEY` is absent.

Tick behavior:

1. Read unsettled jobs:

```sql
SELECT *
FROM devin_jobs
WHERE session_id IS NOT NULL
  AND settled_at IS NULL
ORDER BY created_at ASC;
```

2. For each job, call:

```http
GET /v3/organizations/{org_id}/sessions/{session_id}
```

3. Update local fields from the response:

- `status`
- `status_detail`
- `acus_consumed`
- `session_url`
- `structured_output`
- `tags`

4. Emit `devin_job` SSE after any changed row.

5. Determine settled state:

- Settled done when `structured_output.outcome === "done"` and either `status === "exit"`, `status_detail === "finished"`, or Devin has otherwise stopped producing work.
- Settled blocked when `structured_output.outcome === "blocked"`.
- Settled blocked when `status === "error"`.
- Settled blocked when `status_detail` is one of `usage_limit_exceeded`, `out_of_credits`, `out_of_quota`, `no_quota_allocation`, `payment_declined`, `org_usage_limit_exceeded`, `user_usage_limit_exceeded`, `total_session_limit_exceeded`, or `error`.
- Not settled when `status_detail` is `waiting_for_user` or `waiting_for_approval`; notify or surface this on the board, but do not auto-finish the Hopper node.

6. On settle:

- Set `settled_at`.
- Create a cockpit notification with severity `success` for `done`, `warning` for `blocked`, and a link to `session_url`.
- If `node_id` is set, finish the Hopper node with the mapped payload.

Preferred Hopper finish integration:

- Call `finishHopperNode(node_id, payload)` in-process if the module can import it cleanly. This reuses the authoritative transition in `src/hopper-engine.ts:590`.
- If an import cycle makes that awkward, call the local `POST /api/v1/hopper-nodes/:id/finish` route with a server-side bearer only. Never expose this bearer to Devin or include it in prompts.

Retry and safety:

- One failed poll should log a sanitized warning and try again next tick.
- Do not mark a job blocked because one poll fails.
- Do not let one bad job stop the loop.
- Never pass Devin output back into a model or shell command as instructions.

## 8. Structured Output As Hopper Finish Contract

Default schema to send to Devin:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["outcome", "summary"],
  "properties": {
    "outcome": {
      "type": "string",
      "enum": ["done", "blocked"]
    },
    "summary": {
      "type": "string",
      "minLength": 1
    },
    "branch": {
      "type": ["string", "null"]
    },
    "commits": {
      "type": ["array", "null"],
      "items": { "type": "string" }
    },
    "notes": {
      "type": ["array", "null"],
      "items": { "type": "string" }
    }
  }
}
```

Map to Hopper:

Devin `done`:

```json
{
  "outcome": "done",
  "result": "Devin session <session_id> settled: <session_url>\n\nStructured output returned by Devin, quoted as untrusted data:\n> outcome: done\n> summary: <summary>\n> branch: <branch or none>\n> commits: <comma-separated commits or none>\n> notes: <notes or none>"
}
```

Devin `blocked`:

```json
{
  "outcome": "blocked",
  "result": "Devin session <session_id> blocked: <session_url>\n\nStructured output returned by Devin, quoted as untrusted data:\n> outcome: blocked\n> summary: <summary>\n> branch: <branch or none>\n> commits: <comma-separated commits or none>\n> notes: <notes or none>"
}
```

Important: Devin structured output is not a trusted worker finish POST. It is data produced by an external cloud agent. The reconciler must frame it as quoted untrusted data before writing it into Hopper. Do not allow Devin to create `blocked_question` directly; if it needs Kevin, mark the node `blocked` with the quoted reason and let the tree owner decide the follow-up.

## 9. Provider Usage Meter

Add:

```text
src/scripts/poll-devin-usage.ts
```

Output file:

```text
/tmp/devin-usage-live.json
```

Follow the generic provider snapshot shape used by `readCodexUsage` and `readAugmentUsage` in `src/handlers/api-v1.ts:669` through `src/handlers/api-v1.ts:756`.

No-key payload:

```json
{
  "provider": "devin",
  "plan": "connected",
  "email": null,
  "updated_at": 1789300000,
  "source": "key-needed",
  "windows": [
    {
      "label": "ACUs",
      "used_percentage": null,
      "resets_at": null,
      "value_label": "key needed for usage",
      "detail": "Add DEVIN_API_KEY to darwin-assistant/.env to enable the ACU meter."
    }
  ],
  "used_acus": null,
  "pool_acus": null,
  "ceiling_acus": null,
  "cycle_start": null,
  "cycle_end": null,
  "error": null
}
```

Key-present preferred flow:

1. Call `GET /v3/self` to discover `org_id`.
2. Resolve cycle window from settings/env:
   - `devin_billing_cycle_start`
   - `devin_billing_cycle_end`
3. If no cycle window is configured, use a conservative fallback window such as the last 30 days, set `resets_at: null`, and make the label honest.
4. Call:

```http
GET /v3/organizations/{org_id}/consumption/daily?time_after=<cycle_start>&time_before=<now_or_cycle_end>
```

5. Use `total_acus` as `used_acus`.
6. If that endpoint is unauthorized for Kevin's key, fall back to paged session listing and sum `acus_consumed` for sessions in the cycle window.

Pool and ceiling:

- `devin_acu_pool`: total ACUs available for the current cycle. Optional.
- `gov_devin_acu_ceiling`: absolute ACU ceiling for automated JARVIS use. Optional; defaults to `devin_acu_pool` when that is set.

If `devin_acu_pool` is set:

```json
{
  "label": "ACUs",
  "used_percentage": 42.5,
  "resets_at": 1790100000,
  "value_label": "8.5 / 20 ACUs used"
}
```

If `devin_acu_pool` is not set:

```json
{
  "label": "ACUs",
  "used_percentage": null,
  "resets_at": null,
  "value_label": "8.5 ACUs used"
}
```

Add backend reader:

```ts
function readDevinUsage(): CodexProviderUsage | null
```

Then extend:

```ts
res.json({
  claude: readClaudeLiveUsage(),
  openai_codex: readCodexUsage(),
  augment: readAugmentUsage(),
  devin: readDevinUsage(),
});
```

Also update `src/hopper-governor.ts`:

- Add `DEVIN_USAGE_FILE`.
- Replace the placeholder `devin: { file: null, ceiling: () => 100 }` at `src/hopper-governor.ts:229`.
- For the existing generic percent gate, use `used_percentage` when `devin_acu_pool` is set. If the percentage is null because no pool is configured, do not hold the provider on percentage alone.
- The Devin job creation route must still enforce the absolute `gov_devin_acu_ceiling` when that setting is present.

## 10. Systemd Units

Add a poller unit and timer beside the existing usage pollers.

Suggested files:

```text
systemd/devin-usage-poll.service
systemd/devin-usage-poll.timer
```

Service:

```ini
[Unit]
Description=Poll Devin ACU usage for JARVIS

[Service]
Type=oneshot
WorkingDirectory=/home/kevin/paperclip/darwin-assistant
EnvironmentFile=/home/kevin/paperclip/darwin-assistant/.env
Environment=DEVIN_USAGE_FILE=/tmp/devin-usage-live.json
ExecStart=/usr/bin/env node dist/scripts/poll-devin-usage.js
```

Timer:

```ini
[Unit]
Description=Poll Devin ACU usage every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s
AccuracySec=10s
Persistent=true

[Install]
WantedBy=timers.target
```

The poller must write the no-key payload even when `DEVIN_API_KEY` is absent so the cockpit can render a clear state.

## 11. Cockpit UI Contract

The UI worker should use the branch `hopper/devin-jobs-ui` in `/home/kevin/worktrees/devin-jobs-ui`.

Provider Usage widget:

- Add `devin?: CodexProviderUsage | null` to `ProviderUsageResponse` in `src/lib/cockpit-api.ts`.
- Add a provider block to `ProviderUsagePanel` in `src/routes/threads.tsx`.
- Reuse `UsageBar`; it already handles `used_percentage: null` plus `value_label`.
- Render the no-key state as: `Devin - key needed for usage`.

Governor settings:

- Add fields to `src/routes/settings.governor.tsx`:
  - `devin_max_concurrent`
  - `devin_acu_pool`
  - `gov_devin_acu_ceiling`
  - `devin_billing_cycle_start`
  - `devin_billing_cycle_end`
- Keep units explicit: concurrency is jobs; pool and ceiling are ACUs.

Dispatch board:

- Add a route such as `/devin-jobs` or a section on the existing governor/machine settings page.
- Data source: `GET /api/v1/devin/jobs`.
- Show active jobs first, then recent settled jobs.
- Columns/cards:
  - title
  - status and status_detail
  - devin_mode
  - ACUs consumed
  - linked Hopper node if present
  - linked thread if present
  - session URL
  - created_at and settled_at
- Include a small message box for `POST /devin/jobs/:id/message`.
- Subscribe to `devin_job` SSE so status changes appear live.

## 12. Safety And Trust Rules

- Devin is an external cloud agent. Its output is useful, but not trusted instructions.
- Do not pass secrets to Devin prompts.
- Do not include `JARVIS_COCKPIT_KEY`, `DEVIN_API_KEY`, or any provider token in a Devin prompt, stored job summary, notification body, or Hopper finish result.
- Do not let a Devin job merge branches, deploy production, send external messages, or spend money. The prompt should repeat Kevin's fixed escalation bar.
- Linked Hopper finishes must quote Devin output as untrusted data.
- A missing API key is a normal configuration state, not an exception path that crashes startup.
- API creation must refuse work when local concurrency or ACU settings say no.

## 13. Verification Plan

No-key smoke:

1. Start server without `DEVIN_API_KEY`.
2. Confirm `GET /api/v1/provider-usage` returns a Devin tile with `value_label: "key needed for usage"`.
3. Confirm `GET /api/v1/devin/jobs` returns local rows and does not throw.
4. Confirm `POST /api/v1/devin/jobs` returns HTTP 409 `devin_key_missing`.
5. Confirm reconciler tick logs nothing noisy and does not crash.

Key-present smoke:

1. Add Kevin's `DEVIN_API_KEY` to `darwin-assistant/.env`.
2. Run `poll-devin-usage.ts` once and inspect `/tmp/devin-usage-live.json`.
3. Create a cheap `lite` session with the default structured-output schema.
4. Confirm local row has `session_id`, `session_url`, `status`, and tags.
5. Wait for the 60-second reconciler to update `acus_consumed` and `structured_output`.
6. Confirm a settled job fires a cockpit notification.
7. Use a disposable test Hopper node only in a local/scratch tree to confirm linked `node_id` maps to `finishHopperNode` and that the result quotes Devin output.

Build checks:

- Backend TypeScript build passes.
- Frontend build passes after adding usage tile and board.
- Existing `/provider-usage` consumers still tolerate absent Devin data.
- Existing Hopper dispatch still works when `DEVIN_USAGE_FILE` is absent.

## 14. Open Decisions For Kevin

No implementation worker should block on these. The defaults above are safe enough for v0.

- The exact Devin ACU pool and billing cycle dates are unknown until Kevin provides them or the API key exposes them. Default to null percent plus `N ACUs used`.
- `devin_max_concurrent` defaults to `2`.
- Default job mode is `lite`.
- Devin cloud sessions can be used conversationally now; an engine-native Hopper adapter is a v2 step after this contract ships.

