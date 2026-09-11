# Foundry v0 Design Contract

Worker node: #65, tree `tree-7fa5514e`

This document is the build contract for the Foundry v0 backend, UI, verification,
review, and docs workers. It is intentionally specific so the UI worker can build
against the API without reading the backend implementation first.

Source of truth read first: `/home/kevin/obsidian/paperclip-wiki/skills/foundry/SKILL.md`.

## Baseline

- Backend worktree: `/home/kevin/paperclip-worktrees/foundry`
- Backend package: `/home/kevin/paperclip-worktrees/foundry/darwin-assistant`
- UI worktree: `/home/kevin/paperclip-worktrees/foundry-ui`
- UI package: `/home/kevin/paperclip-worktrees/foundry-ui`
- Both worktrees were created from the requested live heads:
  - backend branch `hopper/foundry` from `autogroup/auto-thread-grouping`
  - UI branch `hopper/foundry-ui` from `jarvis/plugins-panel`
- Dependency setup matched the monitors worktrees: real `node_modules` installs, not symlinks.
- Backend baseline passed: `JARVIS_DB_PATH=/tmp/foundry-node65-baseline.db ./node_modules/.bin/tsc --noEmit`
- UI baseline passed the package build script:
  `NODE_ENV=production SERVER_PRESET=node-server NITRO_PRESET=node-server bun run build`
- UI raw standalone `bunx tsc --noEmit` has pre-existing route/type errors unrelated to Foundry
  (`/threads` required `search`, momentum-lab model nullability, notification fixture missing
  `actions`). Do not treat those as Foundry regressions unless this branch changes those files.

## Backend DDL

Create tables in `darwin-assistant/src/foundry.ts` at module load using the existing
module-local `CREATE TABLE IF NOT EXISTS` pattern from `src/hopper.ts` and `src/monitors.ts`.
Do not use a migration tool. Tests must set `JARVIS_DB_PATH=/tmp/<name>.db`.

```sql
CREATE TABLE IF NOT EXISTS foundry_projects (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  prompt              TEXT NOT NULL,
  repo_path           TEXT NOT NULL,
  base_branch         TEXT NOT NULL DEFAULT 'main',
  status              TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN (
                        'draft',
                        'planning',
                        'planned',
                        'building',
                        'integrating',
                        'ready',
                        'launched',
                        'blocked'
                      )),
  blueprint           TEXT,
  integration_tree_id TEXT,
  integration_branch  TEXT,
  preview_url         TEXT,
  run_command         TEXT,
  planner_model       TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_foundry_projects_status_created
  ON foundry_projects(status, created_at DESC);

CREATE TABLE IF NOT EXISTS foundry_modules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     TEXT NOT NULL REFERENCES foundry_projects(id) ON DELETE CASCADE,
  key            TEXT NOT NULL,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL
                 CHECK (kind IN ('service','library','ui','job','data','contracts')),
  purpose        TEXT NOT NULL,
  contract       TEXT NOT NULL DEFAULT '{"provides":[],"requires":[]}',
  acceptance     TEXT NOT NULL DEFAULT '[]',
  depends_on     TEXT NOT NULL DEFAULT '[]',
  tree_id        TEXT,
  stage_nodes    TEXT NOT NULL DEFAULT '{}',
  stage          TEXT NOT NULL DEFAULT 'planned'
                 CHECK (stage IN (
                   'planned',
                   'building',
                   'built',
                   'testing',
                   'tested',
                   'documenting',
                   'documented',
                   'integrated',
                   'blocked',
                   'needs_answer'
                 )),
  branch         TEXT NOT NULL,
  last_result    TEXT,
  blocked_reason TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, key)
);

CREATE INDEX IF NOT EXISTS idx_foundry_modules_project
  ON foundry_modules(project_id, id);

CREATE INDEX IF NOT EXISTS idx_foundry_modules_tree
  ON foundry_modules(tree_id);

CREATE INDEX IF NOT EXISTS idx_foundry_modules_project_stage
  ON foundry_modules(project_id, stage);
```

Notes:

- JSON columns remain `TEXT` because this app uses `better-sqlite3` directly.
- `blueprint`, `contract`, `acceptance`, `depends_on`, and `stage_nodes` must be parsed for API
  responses and validated before writes.
- `stage_nodes` stores node ids only, for example `{"build":101,"test":102,"doc":103}`.
  API responses enrich those ids with Hopper node state.
- `stage` is a cache of `deriveStage()` for fast list rendering. Workers never set it directly.

## Stage Derivation

Inputs:

- build node status: `stage_nodes.build`
- test node status: `stage_nodes.test`
- doc node status: `stage_nodes.doc`
- project integration state: `project.integration_tree_id` and its Hopper nodes

Only Hopper status `done` is stage-complete. **`split` is in-progress**, not complete: the
engine marks the parent `split` the instant the worker decomposes it, while the children still
have to run; `settleAncestors` bubbles the parent to `done` only once every child is `done`.
(Corrected by the adversarial review, node 72 — the original "split is complete" premise
produced a green box with the work still running, and let TEST dispatch before BUILD finished.
`depsSatisfied`/`settleAncestors` in `hopper-engine.ts` were tightened to `done`-only to match.)

Priority order for `deriveStage(project, module)`:

| Condition | Stage |
| --- | --- |
| Any build/test/doc node status is `blocked` | `blocked` |
| Any build/test/doc node status is `blocked_question` | `needs_answer` |
| Project integration tree is done and build/test/doc are complete | `integrated` |
| Doc node status is `running` or `split` | `documenting` |
| Doc node status is `done` | `documented` |
| Test node status is `running` or `split` | `testing` |
| Test node status is `done` | `tested` |
| Build node status is `running` or `split` | `building` |
| Build node status is `done` | `built` |
| Build node missing, `draft`, or `pending` | `planned` |
| No stage nodes exist yet | `planned` |

Project status derivation:

| Condition | Project status |
| --- | --- |
| No blueprint has been written | `draft` |
| Planner is currently running | `planning` |
| Blueprint exists and no module trees are planted | `planned` |
| Any module is `blocked` or `needs_answer` | `blocked` |
| Any module is before `documented` and at least one tree is planted | `building` |
| All modules are `documented` and integration tree is not done | `integrating` |
| Integration tree done and project not launched | `ready` |
| GO has run successfully | `launched` |

Do not downgrade `launched` from ordinary Hopper noise after GO. A blocked integration tree may
move `ready`/`building` to `blocked`, but never after `launched` unless a GO process fails.

Stage ordering for dependency checks:

```ts
const STAGE_RANK = {
  planned: 0,
  building: 1,
  built: 2,
  testing: 3,
  tested: 4,
  documenting: 5,
  documented: 6,
  integrated: 7,
  needs_answer: -1,
  blocked: -1,
} as const;
```

A module may be planted when every key in `depends_on` has `STAGE_RANK[dep.stage] >= 4`
(`tested` or better). This lets modules that only need a tested contract/code dependency begin
while docs are still being polished.

## Hopper Listener Wiring

Add an idempotent starter in `src/foundry.ts`:

```ts
let foundryStarted = false;

export function startFoundry(): void {
  if (foundryStarted) return;
  foundryStarted = true;
  sseBus.on('sse', handleFoundrySse);
}
```

Call `startFoundry()` from `src/index.ts` after `startHopperEngine(processMessage)` and before
or after `startMonitorScheduler(...)`. The listener makes no model calls.

Listener algorithm:

1. Ignore every event except `ev.type === 'hopper_node'`.
2. Let `node = ev.node`.
3. If `node.tree_id` matches `foundry_modules.tree_id`, recompute that module:
   - Load project and module.
   - Enrich `stage_nodes` by calling `getHopperNode(id)` for build/test/doc ids.
   - Run `deriveStage(project, module)`.
   - Update `foundry_modules.stage`, `last_result`, `blocked_reason`, `updated_at`.
   - Emit `foundry_module`.
   - Recompute and emit `foundry_project`.
   - Run `maybePlantReadyModules(project_id)`.
   - Run `maybePlantIntegrationTree(project_id)`.
4. If `node.tree_id` matches `foundry_projects.integration_tree_id`, recompute project integration:
   - If every node in that tree is `done` (a `split` parent flips to `done` once its children
     settle) AND no module is `blocked`/`needs_answer`, set all project modules with
     `stage='documented'` to `integrated`, set project `ready`, emit module/project events,
     and create a success notification.
   - If any integration node is `blocked_question`, set project `blocked`, create a warning
     notification naming the project.
   - If any integration node is `blocked`, set project `blocked`, create an error notification.
5. Otherwise ignore the Hopper event.

Recommended prepared lookups:

```sql
SELECT * FROM foundry_modules WHERE tree_id = ? LIMIT 1;
SELECT * FROM foundry_projects WHERE integration_tree_id = ? LIMIT 1;
SELECT * FROM foundry_modules WHERE project_id = ? ORDER BY id;
```

Planting a module:

- Use `createHopperTree(topic, originThreadExt, nodes)` and immediately `agreeHopperTree(tree.id)`.
- Topic: `foundry:<project_id>/<module_key>`.
- `originThreadExt` is `null` in v0 unless a later node intentionally adds a project-thread column.
- Nodes:
  - BUILD: Standard tier, explicit adapter/model.
  - TEST: Standard tier, explicit adapter/model, depends on BUILD.
  - DOC: Light tier, explicit adapter/model, depends on TEST.
- Record `tree_id` and `stage_nodes` from the returned node ids.
- Branch: `foundry/<project_id>/<module_key>`.

Integration tree:

- Only plant once, when every module stage is `documented`.
- Branch: `foundry/<project_id>/integration`.
- Topic: `foundry:<project_id>/integration`.
- Nodes:
  - Merge module branches and wire project.
  - Adversarial review.
  - Project docs.
- Store `integration_tree_id` and `integration_branch`, set project `integrating`.

## Route Contracts

All routes live under the existing authenticated API router in
`darwin-assistant/src/handlers/api-v1.ts`. They use the same `sendError(res, status, code, message)`
shape as monitors and Hopper.

### Common Types

`FoundryProject` response object:

```json
{
  "id": "hello-foundry",
  "name": "Hello Foundry",
  "prompt": "Build a tiny intake app...",
  "repo_path": "/home/kevin/foundry/hello-foundry",
  "base_branch": "main",
  "status": "planned",
  "blueprint": {
    "name": "hello-foundry",
    "prompt": "Build a tiny intake app...",
    "modules": ["contracts", "store", "ingest-api", "dashboard"],
    "wiring": [],
    "integration": { "test": "npm run test:integration", "docs": "README.md" },
    "run": { "command": "npm run dev", "preview_url": "http://localhost:8090" },
    "assumptions": []
  },
  "integration_tree_id": null,
  "integration_branch": null,
  "preview_url": null,
  "run_command": "npm run dev",
  "planner_model": "claude-opus-5",
  "created_at": "2026-09-11 01:20:00",
  "updated_at": "2026-09-11 01:22:00",
  "progress": {
    "modules_total": 4,
    "modules_documented": 0,
    "modules_integrated": 0,
    "modules_blocked": 0,
    "modules_needing_answer": 0,
    "percent": 0
  }
}
```

`FoundryModule` response object:

```json
{
  "id": 12,
  "project_id": "hello-foundry",
  "key": "ingest-api",
  "name": "Ingest API",
  "kind": "service",
  "purpose": "Accepts inbound records over HTTP and hands them to the store.",
  "contract": {
    "provides": [
      {
        "type": "http",
        "name": "POST /ingest",
        "summary": "Accept one record",
        "schema": "contracts/ingest.openapi.json#/paths/~1ingest"
      }
    ],
    "requires": [
      { "module": "store", "interface": "fn:saveRecord" }
    ]
  },
  "acceptance": [
    "POST /ingest validates a required external_id.",
    "A valid record is passed to store.saveRecord exactly once."
  ],
  "depends_on": ["contracts", "store"],
  "tree_id": "tree-a1b2c3d4",
  "stage_nodes": {
    "build": {
      "node_id": 101,
      "status": "done",
      "model": "gpt-5.5",
      "attempts": 1,
      "worker_thread_ext": "cockpit:hopper-node-101-8abc1234",
      "result": "Built ingest-api on branch foundry/hello-foundry/ingest-api..."
    },
    "test": {
      "node_id": 102,
      "status": "running",
      "model": "claude-sonnet-5",
      "attempts": 1,
      "worker_thread_ext": "cockpit:hopper-node-102-1abc1234",
      "result": null
    },
    "doc": {
      "node_id": 103,
      "status": "pending",
      "model": "claude-haiku-4-5-20251001",
      "attempts": 0,
      "worker_thread_ext": null,
      "result": null
    }
  },
  "stage": "testing",
  "branch": "foundry/hello-foundry/ingest-api",
  "last_result": "Built ingest-api on branch foundry/hello-foundry/ingest-api...",
  "blocked_reason": null,
  "created_at": "2026-09-11 01:22:00",
  "updated_at": "2026-09-11 01:31:00"
}
```

`StageNode` fields are always present for a planted stage. For an unplanted stage, return:

```json
{ "node_id": null, "status": "missing", "model": null, "attempts": 0, "worker_thread_ext": null, "result": null }
```

### `GET /foundry/projects`

Lists projects for the `/foundry` index. Default order: newest first.

Query:

- `status` optional: one Foundry project status or `all`; default `all`.

Response `200`:

```json
{
  "projects": [
    {
      "id": "hello-foundry",
      "name": "Hello Foundry",
      "prompt": "Build a tiny intake app...",
      "repo_path": "/home/kevin/foundry/hello-foundry",
      "base_branch": "main",
      "status": "building",
      "blueprint": null,
      "integration_tree_id": null,
      "integration_branch": null,
      "preview_url": null,
      "run_command": "npm run dev",
      "planner_model": "claude-opus-5",
      "created_at": "2026-09-11 01:20:00",
      "updated_at": "2026-09-11 01:31:00",
      "progress": {
        "modules_total": 4,
        "modules_documented": 1,
        "modules_integrated": 0,
        "modules_blocked": 0,
        "modules_needing_answer": 0,
        "percent": 25
      }
    }
  ]
}
```

For list responses, `blueprint` may be `null` or the parsed object. The UI must not require
blueprint on list cards.

Errors:

- `400 invalid_request` if `status` is present and not a valid project status or `all`.

### `POST /foundry/projects`

Creates a draft project and scaffolds a repo if no repo path is supplied.

Request:

```json
{
  "name": "Hello Foundry",
  "prompt": "Build a tiny intake app with an ingest endpoint and dashboard.",
  "repo_path": "/home/kevin/foundry/hello-foundry",
  "base_branch": "main"
}
```

Rules:

- `name` and `prompt` are required non-empty strings.
- `id` is derived from `name` as a lowercase slug. If it already exists, append `-2`, `-3`, etc.
- `repo_path` is optional. Default: `${FOUNDRY_ROOT:-/home/kevin/foundry}/<id>`.
- If `repo_path` does not exist, create it, run `git init`, and scaffold:
  - `foundry.json`
  - `modules/`
  - `contracts/`
- If `repo_path` exists, use it as-is and do not reinitialize it.
- `base_branch` defaults to `main`.

Response `201`:

```json
{
  "project": { "...": "FoundryProject" },
  "modules": []
}
```

Errors:

- `400 invalid_request` for missing/invalid fields.
- `409 foundry_project_exists` only if slug collision resolution somehow cannot produce a free id.
- `500 foundry_repo_error` if filesystem scaffolding fails.

### `GET /foundry/projects/:id`

Returns one project plus enriched modules.

Response `200` full example:

```json
{
  "project": {
    "id": "hello-foundry",
    "name": "Hello Foundry",
    "prompt": "Build a tiny intake app with an ingest endpoint and dashboard.",
    "repo_path": "/home/kevin/foundry/hello-foundry",
    "base_branch": "main",
    "status": "building",
    "blueprint": {
      "name": "hello-foundry",
      "prompt": "Build a tiny intake app with an ingest endpoint and dashboard.",
      "modules": ["contracts", "store", "ingest-api", "dashboard"],
      "wiring": [
        { "from": "ingest-api", "requires": "fn:saveRecord", "to": "store" }
      ],
      "integration": { "test": "npm run test:integration", "docs": "README.md" },
      "run": { "command": "npm run dev", "preview_url": "http://localhost:8090" },
      "assumptions": [
        "Use a local sqlite store for v0 unless Kevin supplies a target database."
      ]
    },
    "integration_tree_id": null,
    "integration_branch": "foundry/hello-foundry/integration",
    "preview_url": null,
    "run_command": "npm run dev",
    "planner_model": "claude-opus-5",
    "created_at": "2026-09-11 01:20:00",
    "updated_at": "2026-09-11 01:31:00",
    "progress": {
      "modules_total": 4,
      "modules_documented": 1,
      "modules_integrated": 0,
      "modules_blocked": 0,
      "modules_needing_answer": 0,
      "percent": 25
    }
  },
  "modules": [
    {
      "id": 9,
      "project_id": "hello-foundry",
      "key": "contracts",
      "name": "Contracts",
      "kind": "contracts",
      "purpose": "Owns shared schemas and interface contracts for the app.",
      "contract": {
        "provides": [
          { "type": "schema", "name": "Record", "summary": "Inbound record shape", "schema": "contracts/record.schema.json" }
        ],
        "requires": []
      },
      "acceptance": [
        "contracts/record.schema.json validates required external_id and payload fields."
      ],
      "depends_on": [],
      "tree_id": "tree-c0ffee12",
      "stage_nodes": {
        "build": {
          "node_id": 91,
          "status": "done",
          "model": "gpt-5.5",
          "attempts": 1,
          "worker_thread_ext": "cockpit:hopper-node-91-5cc53b45",
          "result": "Committed contracts module at abc1234."
        },
        "test": {
          "node_id": 92,
          "status": "done",
          "model": "claude-sonnet-5",
          "attempts": 1,
          "worker_thread_ext": "cockpit:hopper-node-92-bb7b29a1",
          "result": "Contract tests pass."
        },
        "doc": {
          "node_id": 93,
          "status": "done",
          "model": "claude-haiku-4-5-20251001",
          "attempts": 1,
          "worker_thread_ext": "cockpit:hopper-node-93-a17fdb92",
          "result": "README.md written."
        }
      },
      "stage": "documented",
      "branch": "foundry/hello-foundry/contracts",
      "last_result": "README.md written.",
      "blocked_reason": null,
      "created_at": "2026-09-11 01:22:00",
      "updated_at": "2026-09-11 01:44:00"
    },
    {
      "id": 12,
      "project_id": "hello-foundry",
      "key": "ingest-api",
      "name": "Ingest API",
      "kind": "service",
      "purpose": "Accepts inbound records over HTTP and hands them to the store.",
      "contract": {
        "provides": [
          {
            "type": "http",
            "name": "POST /ingest",
            "summary": "Accept one record",
            "schema": "contracts/ingest.openapi.json#/paths/~1ingest"
          }
        ],
        "requires": [
          { "module": "contracts", "interface": "schema:Record" },
          { "module": "store", "interface": "fn:saveRecord" }
        ]
      },
      "acceptance": [
        "POST /ingest rejects a request without external_id.",
        "POST /ingest returns 202 for a valid record.",
        "A valid record is handed to store.saveRecord exactly once."
      ],
      "depends_on": ["contracts", "store"],
      "tree_id": "tree-a1b2c3d4",
      "stage_nodes": {
        "build": {
          "node_id": 101,
          "status": "done",
          "model": "gpt-5.5",
          "attempts": 1,
          "worker_thread_ext": "cockpit:hopper-node-101-8abc1234",
          "result": "Built ingest-api on branch foundry/hello-foundry/ingest-api."
        },
        "test": {
          "node_id": 102,
          "status": "running",
          "model": "claude-sonnet-5",
          "attempts": 1,
          "worker_thread_ext": "cockpit:hopper-node-102-1abc1234",
          "result": null
        },
        "doc": {
          "node_id": 103,
          "status": "pending",
          "model": "claude-haiku-4-5-20251001",
          "attempts": 0,
          "worker_thread_ext": null,
          "result": null
        }
      },
      "stage": "testing",
      "branch": "foundry/hello-foundry/ingest-api",
      "last_result": "Built ingest-api on branch foundry/hello-foundry/ingest-api.",
      "blocked_reason": null,
      "created_at": "2026-09-11 01:22:00",
      "updated_at": "2026-09-11 01:31:00"
    }
  ]
}
```

Errors:

- `404 foundry_project_not_found`

### `POST /foundry/projects/:id/plan`

Runs the one-shot planner asynchronously. The route returns after the status flips to
`planning`; completion arrives through `foundry_project` and `foundry_module` SSE events.

Request:

```json
{
  "planner_model": "claude-opus-5"
}
```

Rules:

- Request body is optional.
- `planner_model` is optional. If absent, use `getSetting('foundry_planner_model')`, then
  `process.env.FOUNDRY_PLANNER_MODEL`, then `claude-opus-5`.
- If the project already has module trees planted, reject re-planning in v0.
- Planner failure sets project back to `draft`, stores a small error in `blueprint` as
  `{"error":"..."}` or leaves blueprint unchanged, and emits `foundry_project`.

Response `202`:

```json
{
  "project": { "...": "FoundryProject with status planning" }
}
```

Errors:

- `404 foundry_project_not_found`
- `409 foundry_project_already_launched`
- `409 foundry_project_already_building`

### `PATCH /foundry/projects/:id/blueprint`

Edits the draft/planned blueprint before launch and rewrites module rows.

Request:

```json
{
  "blueprint": {
    "name": "hello-foundry",
    "prompt": "Build a tiny intake app...",
    "modules": [
      {
        "key": "contracts",
        "name": "Contracts",
        "kind": "contracts",
        "purpose": "Owns shared schemas and interface contracts.",
        "contract": { "provides": [], "requires": [] },
        "acceptance": ["Schema files validate with npm test."],
        "depends_on": []
      }
    ],
    "wiring": [],
    "integration": { "test": "npm run test:integration", "docs": "README.md" },
    "run": { "command": "npm run dev", "preview_url": "http://localhost:8090" },
    "assumptions": []
  }
}
```

Rules:

- Status must be `draft` or `planned`.
- Validate module count 3 to 9 unless Kevin/JARVIS explicitly edited a smaller/larger plan.
- Validate module keys are kebab-case and unique.
- Validate `kind` is one of the allowed enum values.
- Validate every `depends_on` key exists and the graph has no cycles.
- Validate every `requires` is bound by `wiring[]` to one `provides`, except requires of
  project-external systems explicitly named with `external: true`.
- Replace `foundry_modules` rows for the project inside one SQLite transaction.
- Set project `status='planned'`, `blueprint=<json>`, `run_command=blueprint.run.command`.

Response `200`:

```json
{
  "project": { "...": "FoundryProject with status planned" },
  "modules": [{ "...": "FoundryModule" }]
}
```

Errors:

- `400 invalid_blueprint`
- `404 foundry_project_not_found`
- `409 foundry_project_locked`

### `POST /foundry/projects/:id/launch`

Starts autonomous module work by planting initial module trees.

Request:

```json
{}
```

Rules:

- Status must be `planned` or `blocked` with only retryable/question-resolved modules.
- Blueprint must exist and validate.
- Plant every unplanted module whose dependencies are all `tested` or better. On first launch,
  this means modules with no deps plus modules depending only on an already-planted and tested
  `contracts` module if such a prior run exists.
- Set status `building`.
- Return the updated project and modules immediately. Hopper workers continue asynchronously.

Response `202`:

```json
{
  "project": { "...": "FoundryProject with status building" },
  "modules": [{ "...": "FoundryModule" }]
}
```

Errors:

- `400 invalid_blueprint`
- `404 foundry_project_not_found`
- `409 foundry_project_not_planned`

### `POST /foundry/projects/:id/go`

Runs the green-button launcher. v0 is a detached local launcher plus link setter; it is not a
production deploy.

Request:

```json
{}
```

Rules:

- Project status must be `ready`.
- Use `run_command` from the project, else `blueprint.run.command`.
- Run detached from `project.repo_path`.
- If `blueprint.run.preview_url` exists, set `preview_url` to it.
- If a future implementation adds a project thread link, call `setPreviewLink(conversationId, preview_url, project.name)`.
- Set status `launched` only after the command starts successfully.

Response `202`:

```json
{
  "project": { "...": "FoundryProject with status launched" },
  "launched": true,
  "preview_url": "http://localhost:8090"
}
```

Errors:

- `404 foundry_project_not_found`
- `409 foundry_project_not_ready`
- `400 foundry_missing_run_command`
- `500 foundry_go_failed`

### `POST /foundry/projects/:id/modules/:key/retry`

Re-plants a blocked or missing module stage. v0 should keep this narrow: one replacement Hopper
node/tree for the requested stage, not a full replan.

Request:

```json
{
  "stage": "test"
}
```

Rules:

- `stage` optional. If absent, pick the first stage whose node is `blocked` or
  `blocked_question`; otherwise pick the first missing stage after the latest completed stage.
- Valid stages: `build`, `test`, `doc`.
- If retrying `build`, clear build/test/doc node ids because downstream evidence is stale.
- If retrying `test`, keep build id, clear test/doc ids.
- If retrying `doc`, keep build/test ids, clear doc id.
- Plant a new Hopper tree or a one-node tree with dependency result context from prior stages.
- Set module stage from `deriveStage()` and emit `foundry_module`.

Response `202`:

```json
{
  "module": { "...": "FoundryModule" },
  "tree": {
    "id": "tree-88dd9911",
    "topic": "foundry:hello-foundry/ingest-api:retry-test",
    "status": "active"
  },
  "node": {
    "node_id": 155,
    "status": "pending",
    "model": "claude-sonnet-5",
    "attempts": 0,
    "worker_thread_ext": null,
    "result": null
  }
}
```

Errors:

- `400 invalid_request`
- `404 foundry_project_not_found`
- `404 foundry_module_not_found`
- `409 foundry_module_not_retryable`

## SSE Contracts

Add these interfaces to `src/sse-bus.ts` and include them in `SSEEvent`:

```ts
export interface FoundryProjectEvent {
  type: 'foundry_project';
  action: 'created' | 'updated' | 'deleted';
  project: FoundryProjectResponse;
}

export interface FoundryModuleEvent {
  type: 'foundry_module';
  action: 'created' | 'updated' | 'deleted';
  project_id: string;
  module: FoundryModuleResponse;
}
```

Payload examples:

```json
{
  "type": "foundry_project",
  "action": "updated",
  "project": {
    "id": "hello-foundry",
    "name": "Hello Foundry",
    "status": "building",
    "progress": {
      "modules_total": 4,
      "modules_documented": 1,
      "modules_integrated": 0,
      "modules_blocked": 0,
      "modules_needing_answer": 0,
      "percent": 25
    }
  }
}
```

```json
{
  "type": "foundry_module",
  "action": "updated",
  "project_id": "hello-foundry",
  "module": {
    "id": 12,
    "project_id": "hello-foundry",
    "key": "ingest-api",
    "name": "Ingest API",
    "stage": "testing",
    "stage_nodes": {
      "build": {
        "node_id": 101,
        "status": "done",
        "model": "gpt-5.5",
        "attempts": 1,
        "worker_thread_ext": "cockpit:hopper-node-101-8abc1234",
        "result": "Built ingest-api..."
      },
      "test": {
        "node_id": 102,
        "status": "running",
        "model": "claude-sonnet-5",
        "attempts": 1,
        "worker_thread_ext": "cockpit:hopper-node-102-1abc1234",
        "result": null
      },
      "doc": {
        "node_id": 103,
        "status": "pending",
        "model": "claude-haiku-4-5-20251001",
        "attempts": 0,
        "worker_thread_ext": null,
        "result": null
      }
    }
  }
}
```

Add both event names to the `/events` `FORWARD` set in `api-v1.ts`:

```ts
'foundry_project', 'foundry_module'
```

Add both to `jarvis-command-center/src/lib/sse-worker.ts` `EVENT_TYPES`:

```ts
"foundry_project",
"foundry_module",
```

Add handlers to `openGlobalEvents` in `cockpit-api.ts`:

```ts
onFoundryProject?: (action: 'created' | 'updated' | 'deleted', project: FoundryProject) => void;
onFoundryModule?: (action: 'created' | 'updated' | 'deleted', projectId: string, module: FoundryModule) => void;
```

These events are global, not conversation-scoped. The server will not annotate `external_id`.

## Planner One-Shot

Create `darwin-assistant/src/foundry-planner.ts`.

Copy the `runDebrief()` pattern from `src/briefing.ts`, with these Foundry-specific details:

- Use `execFile`, not a provider SDK.
- Default binary: `process.env.CLAUDE_BIN ?? process.env.CLAUDE_CLI_PATH ?? 'claude'`.
- Model: passed from `planProject`, resolved by `getSetting('foundry_planner_model')`,
  `process.env.FOUNDRY_PLANNER_MODEL`, fallback `claude-opus-5`.
- Args:

```ts
['-p', prompt, '--output-format', 'json', '--model', model]
```

- Env:

```ts
const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;
```

- Timeout: `FOUNDRY_PLANNER_TIMEOUT_MS`, default `180_000`.
- `maxBuffer`: `16 * 1024 * 1024`.
- Parse the CLI envelope first:

```ts
const envelope = JSON.parse(stdout.trim()) as { result?: string };
const text = typeof envelope.result === 'string' ? envelope.result : stdout;
const blueprint = JSON.parse(stripMarkdownFence(text));
```

- Reject on non-zero exit unless a valid blueprint was parsed from `stdout`.
- Prompt must demand a single JSON object matching:

```json
{
  "name": "hello-foundry",
  "prompt": "original prompt",
  "modules": [
    {
      "key": "contracts",
      "name": "Contracts",
      "kind": "contracts",
      "purpose": "Own shared schemas.",
      "contract": { "provides": [], "requires": [] },
      "acceptance": ["A checkable criterion."],
      "depends_on": []
    }
  ],
  "wiring": [],
  "integration": { "test": "npm run test:integration", "docs": "README.md" },
  "run": { "command": "npm run dev", "preview_url": "http://localhost:8090" },
  "assumptions": []
}
```

Validation requirements:

- 3 to 9 modules unless explicitly overridden later by a human edit.
- Module keys kebab-case and unique.
- Valid kinds only.
- No dependency cycles.
- Every dependency names a module key.
- Every `requires` entry is satisfied by `wiring[]`, unless marked external.
- Every module has at least one acceptance criterion.
- `integration.test` and `run.command` are non-empty strings.

## File Map By Node

Node #65, recon/design:

- Created worktrees:
  - `/home/kevin/paperclip-worktrees/foundry`
  - `/home/kevin/paperclip-worktrees/foundry-ui`
- Writes this design file:
  - `/home/kevin/paperclip-worktrees/foundry/docs/foundry/DESIGN.md`
- The UI build also refreshed existing generated route metadata in
  `/home/kevin/paperclip-worktrees/foundry-ui/src/routeTree.gen.ts` for already-present
  `/hopper`, `/spawn-tree`, and `/tree` route files. That is a baseline cleanliness commit,
  not Foundry UI implementation.

Backend core worker:

- `darwin-assistant/src/foundry.ts`
  - DDL
  - project/module CRUD
  - serializers
  - blueprint validation
  - `deriveStage`
  - Hopper listener
  - launch/retry/go orchestration
- `darwin-assistant/src/foundry-planner.ts`
  - one-shot local Claude planner seam
  - JSON envelope parsing
  - blueprint validation helpers if not kept in `foundry.ts`
- `darwin-assistant/src/sse-bus.ts`
  - `FoundryProjectEvent`
  - `FoundryModuleEvent`
  - `SSEEvent` union additions
- `darwin-assistant/src/handlers/api-v1.ts`
  - imports
  - route handlers listed above
  - `/events` `FORWARD` additions
- `darwin-assistant/src/index.ts`
  - import and call `startFoundry()`

UI worker:

- `jarvis-command-center/src/lib/cockpit-api.ts`
  - raw Foundry types
  - UI Foundry types
  - mappers
  - API functions
  - global SSE handlers
- `jarvis-command-center/src/lib/sse-worker.ts`
  - `EVENT_TYPES` additions
- `jarvis-command-center/src/routes/foundry.tsx`
  - project list
  - project board
  - module drawer
  - Plan/Launch/GO/Retry actions

Lifecycle simulation / verification worker:

- Prefer backend tests or a scratch script that imports `foundry.ts` with
  `JARVIS_DB_PATH=/tmp/foundry-lifecycle.db`.
- It must simulate Hopper node creation/finish in-process. Do not point tests at live `jarvis.db`.
- Verify:
  - DDL creates on a blank DB.
  - Project create -> plan write -> module rows.
  - Launch plants build/test/doc node ids.
  - Hopper `finishHopperNode` transitions drive `deriveStage`.
  - Dependencies plant only after dependency stage is at least `tested`.
  - All modules documented plants integration.
  - Integration done sets project `ready`.
  - GO rejects before `ready`.

Adversarial review worker:

- Read this design, the skill doc, and the resulting diffs only.
- Check the hard rules:
  - no live checkout edits
  - no service restart/deploy
  - no provider SDK/API key model calls
  - no migration tool
  - no live `jarvis.db` test writes
  - no model inheritance for Hopper nodes
- Check the UI can run against the documented route shapes.

Docs/push worker:

- Update `skills/foundry/SKILL.md` only if the implementation intentionally diverges from the
  locked design and the divergence is worth preserving.
- Add a short operational note under `docs/foundry/` if needed.
- Commit and push both branches. Do not merge or deploy.

## Implementation Details To Keep Exact

- Every Hopper node planted by Foundry must set both `adapter` and `model`.
- Default model settings:
  - `foundry_planner_model`: `claude-opus-5`
  - `foundry_build_model`: `gpt-5.5`
  - `foundry_test_model`: `claude-sonnet-5`
  - `foundry_doc_model`: `claude-haiku-4-5-20251001`
- Suggested adapters:
  - build: `codex` for `gpt-5.5`, unless the selected model is a Claude model
  - test: `claude`
  - doc: `claude`
- If a setting is blank, fall back to the defaults above. Do not fall back to a null model.
- `createHopperTree` dependencies should be expressed with `depends_on_indexes`:
  - test depends on build
  - doc depends on test
- For integration, adversarial review depends on merge, project docs depends on adversarial review.
- Use `getSetting` from `conversation-db.ts`; it is uncached and live.
- Use `createNotification` only on state changes that Kevin should see globally:
  - project ready
  - module blocked/question with project/module names
  - GO failed
- Route errors must be structured as `{ "error": { "code": "...", "message": "..." } }`.

## Changes I Would Make To The Skill

One gap in the skill: it says GO sets the preview link "on the origin thread's links bar", but the
Project object in section 2 has no `origin_thread_ext` or `conversation_id`. I did not add that to
the DDL above because the task asked for the SKILL section 2 schema exactly. For v0, GO should set
`foundry_projects.preview_url`; adding a project-thread column is the smallest v1 improvement if
Kevin wants each Foundry project tied back to a cockpit thread.

A second small clarification: dependency planting should run after any module stage recompute, not
only after `documented`, because the stated readiness bar is "dependencies are at least tested".
That avoids an idle gap where a dependency is tested but the dependent waits for unrelated docs.

## Route Summary

- `GET /foundry/projects` -> `{projects:[FoundryProject]}`
- `POST /foundry/projects {name,prompt,repo_path?,base_branch?}` -> `201 {project,modules:[]}`
- `GET /foundry/projects/:id` -> `{project,modules:[FoundryModule]}`
- `POST /foundry/projects/:id/plan {planner_model?}` -> `202 {project: planning}`
- `PATCH /foundry/projects/:id/blueprint {blueprint}` -> `200 {project: planned,modules}`
- `POST /foundry/projects/:id/launch {}` -> `202 {project: building,modules}`
- `POST /foundry/projects/:id/go {}` -> `202 {project: launched,launched:true,preview_url}`
- `POST /foundry/projects/:id/modules/:key/retry {stage?}` -> `202 {module,tree,node}`

## Adversarial review — node 72 (2026-09-10)

Changes made to the contract after trying to refute it against the built code:

1. **`split` ≠ complete** (above). `COMPLETE_NODE_STATUSES` is `done` only; `running`/`split`
   read as in-progress. Engine-side, `depsSatisfied` and `settleAncestors` only accept `done`
   (a split parent with a still-running or blocked child no longer releases dependents or
   settles its own parent).
2. **Plan is single-flight.** `markProjectPlanning` only succeeds from `draft`/`planned` and
   returns `null` otherwise; `POST /plan` answers 409 `foundry_project_planning` when a run is
   in flight. `markProjectPlannerFailed` only drops a project that is still `planning` — a late
   failure can never pull a `building` project back to `draft`. The planner's own blueprint
   write is `setBlueprint(id, bp, { onlyWhilePlanning: true })` so it cannot clobber a
   blueprint Kevin edited (and possibly launched) while the CLI was still thinking.
   `planProject(id, model?)` no longer re-marks the row; the route passes `planner_model` through.
3. **Project status honours integration blockage.** `recomputeProjectStatus` returns `blocked`
   when any integration-tree node is `blocked`/`blocked_question` (a duplicate module event
   used to flip a blocked project back to `integrating`). Ready is refused while any module is
   `blocked`/`needs_answer`.
4. **Planting is edge-independent.** The listener runs `maybePlantReadyModules` +
   `maybePlantIntegrationTree` on every module event once the module is ≥ `tested` (both are
   idempotent via `tree_id` / `integration_tree_id` guards), instead of only on a stage-change
   edge that another module's refresh could have consumed.
5. **Blueprint validation rejects stray wiring** rows whose `from` module declares no such
   `requires` (server `validateBlueprint` and kit `foundry-validate.mjs`), and the kit now also
   checks `requires.module` agrees with the wiring target (two false-greens found).
6. **UI:** `last_error` surfaced on the board; SKILL §4's editable blueprint draft (JSON, PATCH
   `/blueprint`, only while draft/planned) added; `planning` state shown.

Regression coverage: `scripts/foundry-sim.mjs` scenarios 9a–9d (split), 10 (settings-KV
loadout overrides reach planted nodes), 11a–11c (planner guards).
