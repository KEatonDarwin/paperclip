# Devin Jobs

Status: v2 built, key-gated.

Branch: `hopper/devin-jobs` (backend) plus `hopper/devin-jobs-ui` (cockpit).

Devin Jobs turns Devin's cloud session API into a JARVIS/Hopper worker pool. It is not a replacement for the local `devin` CLI adapter. The CLI remains useful for tiny one-shots; cloud jobs are for well-specified repo-scoped work that can settle through a structured output contract.

## What Shipped

- `src/devin-client.ts` wraps Devin REST v3 using `DEVIN_API_KEY`.
- `src/devin-jobs.ts` owns the local `devin_jobs` SQLite ledger, concurrency gate, ACU gate, tags, and SSE.
- `src/devin-jobs-reconciler.ts` polls unsettled sessions every 60 seconds and folds settled jobs into Hopper with `finishHopperNode`.
- `src/scripts/poll-devin-usage.ts` writes `/tmp/devin-usage-live.json` for the provider widget and ACU gate.
- `systemd/devin-usage-poll.service` and `.timer` provide the 60-second meter runtime.
- `/api/v1/devin/jobs` lists and creates jobs.
- `/api/v1/devin/jobs/:id/message` sends a follow-up to an existing session.
- `/api/v1/provider-usage` now includes `devin`.
- `/api/v1/hopper-engine/settings` accepts Devin spend knobs.
- The global cockpit page `/devin` is the Devin dispatch board.
- The cockpit governor settings page exposes Devin spend guards.

## Runtime Model

Dispatch flow:

1. Caller posts a job to `POST /api/v1/devin/jobs`.
2. Server checks `DEVIN_API_KEY`, title/prompt validation, local-secret literal guard, concurrency, and ACU ceiling.
3. Server inserts a `local_pending` row.
4. Server creates a Devin v3 session with `structured_output_required: true`, tags, mode, and optional `max_acu_limit`.
5. Server attaches returned session fields to the local row and emits `devin_job` SSE.

Reconcile flow:

1. The reconciler skips cleanly when `DEVIN_API_KEY` is absent.
2. With a key, it polls every unsettled local job that has a `session_id`.
3. It updates status, status detail, ACUs, URL, structured output, and tags.
4. A finished `done` output settles the job as done.
5. Usage-limit/error/dead sessions settle blocked.
6. A settled job creates a cockpit notification.
7. If the row has `node_id`, the reconciler finishes that Hopper node in-process.

Devin structured output is untrusted data. The reconciler quotes, folds, and caps fields before it places the report into a Hopper result.

## Structured Output

Default schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["outcome", "summary"],
  "properties": {
    "outcome": { "type": "string", "enum": ["done", "blocked"] },
    "summary": { "type": "string", "minLength": 1 },
    "branch": { "type": ["string", "null"] },
    "commits": { "type": ["array", "null"], "items": { "type": "string" } },
    "notes": { "type": ["array", "null"], "items": { "type": "string" } }
  }
}
```

`blocked_question` is intentionally not in the schema. Devin may report that it is blocked; JARVIS decides whether Kevin needs a question.

## API

### `GET /api/v1/devin/jobs`

Query:

- `status=all|active|settled`
- `limit=<n>`

Response:

```json
{
  "items": [],
  "config": {
    "key_ready": false,
    "max_concurrent": 2,
    "active_jobs": 0,
    "cycle_acus_used": null,
    "acu_ceiling": null,
    "session_acu_limit": null,
    "dispatch_block": null
  }
}
```

`dispatch_block` can be `concurrency`, `ceiling_reached`, or `usage_unknown`.

### `POST /api/v1/devin/jobs`

Body:

```json
{
  "title": "Build focused module",
  "prompt": "Full self-contained prompt",
  "devin_mode": "lite",
  "schema": {},
  "tags": ["tree-654dde7b", "node-173"],
  "node_id": 173,
  "thread_ext": "cockpit:hopper-node-173-bdc06141"
}
```

Validation:

- title required, non-empty, max 160 chars
- prompt required
- mode must be `normal`, `fast`, `lite`, `ultra`, or `fusion`
- tags max 50 caller-provided entries
- known local secrets are refused with `400 secret_in_prompt`
- no key returns `409 devin_key_missing`
- concurrency/ACU holds return `409`

### `POST /api/v1/devin/jobs/:id/message`

Body:

```json
{
  "message": "Additional instruction or answer for Devin"
}
```

The route requires an existing local row, a `session_id`, and a configured key.

## Spend And Governor Settings

Settings live in JARVIS settings-KV and are editable via `/api/v1/hopper-engine/settings`.

| Setting | Used by | Meaning |
| --- | --- | --- |
| `devin_max_concurrent` | `src/devin-jobs.ts` | Max active Devin sessions. Default `2`; `0` kills dispatch. |
| `devin_acu_pool` | poller, ACU gate, governor | Current-cycle ACU pool for percentage/fallback ceiling. |
| `gov_devin_acu_ceiling` | poller, ACU gate, governor | Absolute automated ACU ceiling. |
| `devin_job_max_acu` | job create route | Per-session `max_acu_limit`; effective cap is min(this, remaining ceiling). |
| `devin_billing_cycle_start` | usage poller | Optional billing-cycle start. |
| `devin_billing_cycle_end` | usage poller | Optional billing-cycle end/reset. |

When `gov_devin_acu_ceiling` or `devin_acu_pool` creates a ceiling, `/tmp/devin-usage-live.json` must be present and fresh. Missing, stale, or errored usage fails closed with `409 devin_acu_ceiling`.

## Key-Gated Setup

Kevin must mint a Devin key at:

```text
app.devin.ai -> Settings -> API Keys
```

Then add it to:

```text
/home/kevin/paperclip/darwin-assistant/.env
```

Required:

```env
DEVIN_API_KEY=...
DEVIN_USAGE_FILE=/tmp/devin-usage-live.json
```

Optional:

```env
DEVIN_ORG_ID=...
DEVIN_ACU_POOL=...
GOV_DEVIN_ACU_CEILING=...
DEVIN_BILLING_CYCLE_START=YYYY-MM-DD
DEVIN_BILLING_CYCLE_END=YYYY-MM-DD
```

After the key is present:

```bash
sudo systemctl restart jarvis.service
sudo cp systemd/devin-usage-poll.service /etc/systemd/system/
sudo cp systemd/devin-usage-poll.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now devin-usage-poll.timer
sudo systemctl start devin-usage-poll.service
cat /tmp/devin-usage-live.json
```

Do not deploy this branch until review has passed. Do not merge to main from a worker.

## Verification

Smoke:

```bash
cd /home/kevin/paperclip-worktrees/devin-jobs/darwin-assistant
npm run devin-jobs:smoke
```

The adversarial review for tree `tree-654dde7b` reported PASS WITH FIXES after:

- `npm run devin-jobs:smoke` passed, including TypeScript build.
- Cockpit node-server build passed.
- No live Devin calls were made because no key was present.
- Key safety and spend gates were reviewed.

## Related Artifacts

- Wiki operator skill: `/home/kevin/obsidian/paperclip-wiki/skills/devin-jobs/SKILL.md`
- Assessment: `/home/kevin/obsidian/paperclip-wiki/outbox/devin-jobs-assessment.md`
- Detailed engineering contract: `docs/devin-jobs/CONTRACT.md`
