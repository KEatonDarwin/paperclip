# GUARDS — RECON: the Overwatch rules API, read from source (node #475, 2026-09-19)

**Source of truth:** darwin-dashboard checkout `/home/kevin/projects/darwin-dashboard`, branch `overwatch/claude-cli-and-query-rules` (the query-rule branch — deployed live; the bare API answers **401** unauthenticated, confirming it is up and fails closed). Everything below is cited to file+line on that branch. **Nothing here was probed with a write** (we have no `OVERWATCH_API_KEY`); the request/response shapes are read straight out of the controller + writer + models, which are authoritative.

---

## 0. TL;DR — the two findings that shape the build

1. **`GET /rules/{key}` (and `GET /rules`) DO return the last run result.** `OverwatchRuleController::present()` appends `last_result: { status, value, summary, at } | null` to every rule payload (`app/Http/Controllers/Api/OverwatchRuleController.php`, `present()` ~L138-L172, the `$last = Result::where('check_key', …)->orderByDesc('id')->first()` block). → **Polling is the primary health path. The webhook is NOT required.** (`docs/goals/GUARDS-OVERWATCH-WEBHOOK.md` still specifies an OPTIONAL lower-latency push channel; not on the critical path, Kevin deploys darwin-dashboard.)

2. **The rule key is SERVER-GENERATED, not client-supplied.** `PromptRuleWriter::generateKey()` (`app/Overwatch/PromptRuleWriter.php` ~L295) returns `prompt.<slug-of-name>-<random4>` and there is **no way to POST a chosen key**. → GUARDS.md's assumption of `key = goal-<goalId>-node-<nodeId>` is **wrong** as a *key*. Instead: encode the goal/node identity in the rule **`name`** (so the slug is recognizable, e.g. `Goal 12 · node 87 — first-send-window`), **capture the returned `key`** from the create response, and store it in `goal_guards.overwatch_key`. `goal_guards.overwatch_rule_id` stays NULL — the API keys by string, there is no numeric id in any response.

---

## 1. Endpoint surface, auth, base URL

- **Base:** `https://health.thedarwinhub.com/api/v1/overwatch/rules[/{key}]`. Routes (`routes/api.php` L30-L36):
  ```
  Route::middleware('overwatch.api')->prefix('v1/overwatch')->group(function () {
      Route::get   ('/rules',        [OverwatchRuleController::class, 'index']);
      Route::post  ('/rules',        [OverwatchRuleController::class, 'store']);
      Route::get   ('/rules/{key}',  [OverwatchRuleController::class, 'show']);
      Route::patch ('/rules/{key}',  [OverwatchRuleController::class, 'update']);
      Route::delete('/rules/{key}',  [OverwatchRuleController::class, 'destroy']);
  });
  ```
- **Auth:** `overwatch.api` = `VerifyOverwatchApiKey` (`app/Http/Kernel.php` L67; middleware file `app/Http/Middleware/VerifyOverwatchApiKey.php`). **Bearer** token, constant-time compared to `config('overwatch.api_key')`.
  - `OVERWATCH_API_KEY` unset on the box → **503** `{ "error": "The Overwatch rule API is not configured …" }` (fails closed).
  - Missing/wrong bearer → **401** `{ "error": "Unauthorized" }`.
  - Header: `Authorization: Bearer <OVERWATCH_API_KEY>`.
- **`{key}`** in the path is the full generated key including the `prompt.` prefix (URL-encode the `.`? No — `.` is path-safe; pass verbatim, e.g. `/rules/prompt.first-send-window-a1b2`).

---

## 2. `POST /rules` — create a rule

Handler `store()` → `PromptRuleWriter::create($request->all(), created_by)`. Request is a flat JSON body (no wrapper). Fields consumed by `normaliseMeta()` + `normalisePayload()`:

### Common (both modes)
| field | rules | source |
|---|---|---|
| `name` | **required**, trimmed, ≤120 chars. Drives the key slug. | `normaliseMeta` L152-159 |
| `description` | optional, ≤500 chars. Shown on the dashboard. | L173-176 |
| `group` | optional, default `custom`. **Must be one of the whitelisted groups** or `422`. Live groups (`config/overwatch.php` L85-98): `leads, email, queue, billing, revenue, system, custom, general`. **No `goals` group exists** → use `custom` (or a semantic one like `revenue`/`leads` when the guard obviously belongs there). | L161-167 |
| `severity` | optional, default `medium`. One of `critical, high, medium, low` or `422`. | L169-172 |
| `cadence_minutes` | optional, default `60`, floored at 1. **This is how often OVERWATCH runs the rule** (its scheduler, not ours). | L184 |
| `window_minutes` | optional, default `60`, floored at 1. Fills `{{window_start}}/{{window_end}}` placeholders in the SQL. | L185 |
| `mode` | `query` or `agent` (default `agent`). | `normalisePayload` L191-196 |
| `created_by` | optional; who to credit on the payload row. Defaults to `mcp` if blank (`actor()` L176-181). **Send `"goals"`** so guard-authored rules are attributable. | controller `actor()` |

### `mode: "query"` (the guard mode — zero model calls)
| field | rules | source |
|---|---|---|
| `sql` | **required**, non-empty. Validated by `Prompt\ReadOnlyQuery::normalise($sql, 1)` at create — single read-only SELECT, row-capped, timeout. A bad statement → `422 "sql was rejected: …"`. | L204-219 |
| `comparator` | **required**, one of `gte, lte, gt, lt, eq` (`PromptCheckRecord::COMPARATORS`). Semantics: **`value COMPARATOR threshold = PASS`** (e.g. `comparator=gte, threshold=-5` → passes while value ≥ −5, fails once it drops below). | L221-227 |
| `threshold` | **required**, numeric. | L229-231 |
| `value_column` | optional. Which returned column holds the number. NULL = first column of first row. | L245 |
| `sample_columns` | optional JSON array (or JSON string) of column names to surface on failure. NULL = all columns. | L233-244 |
| `check_prompt` | not required for query; if omitted the writer backfills it from `description`/`name` so the dashboard still shows what the rule is for. | L247-251 |

### `mode: "agent"` (fallback — the win condition needs judgment, can't reduce to one SELECT)
| field | rules | source |
|---|---|---|
| `check_prompt` | **required**, non-empty, ≤8000 chars. | L253, L256-258 |
| `failure_prompt` | optional. | payload L199 |
| `model` | optional model id. | payload L198 |

### Response — `201`
`present()` shape + `"created": true`:
```json
{
  "key": "prompt.first-send-window-a1b2",
  "name": "Goal 12 · node 87 — first-send window",
  "description": "Fails when any paid lead in the last 24h has no first send within 4h",
  "group": "custom",
  "severity": "high",
  "cadence_minutes": 60,
  "window_minutes": 1440,
  "enabled": true,
  "mode": "query",
  "dashboard_url": "https://health.thedarwinhub.com/overwatch",
  "sql": "SELECT COUNT(*) AS breaches FROM …",
  "comparator": "lte",
  "threshold": 0,
  "value_column": "breaches",
  "sample_columns": ["lead_id","created_at"],
  "created_by": "goals",
  "last_result": null,
  "created": true
}
```
- `422 { "error": "<message>" }` on any bad shape (from `InvalidArgumentException`).
- **Capture `key`** → `goal_guards.overwatch_key`. `last_result` is `null` immediately after create (no run yet).

---

## 3. `GET /rules/{key}` — read one rule + its last result  ← the poller's endpoint

Handler `show()` (L52-60). `404 { "error": "No prompt rule found for {key}" }` if unknown. Otherwise the same `present()` shape as create (WITHOUT `created`). The load-bearing field:

```json
"last_result": {
  "status":  "ok",                       // one of: ok | warn | fail | error   (see §5)
  "value":   -3.2,                        // float | null — the compared number
  "summary": "revenue -3.2% vs 7-day avg",// human one-liner (nullable)
  "at":      "2026-09-19T18:40:11+00:00"  // ISO8601 of the run, or null
}
```
`last_result` is the newest `ow_results` row for this `check_key` (`Result::where('check_key',$key)->orderByDesc('id')->first()`, controller L164-172). `null` when the rule has never run.

**This is what the guard poller reads every `goal_guard_poll_min` minutes.** No webhook needed for correctness.

---

## 4. `GET /rules`, `PATCH /rules/{key}`, `DELETE /rules/{key}`

- **`GET /rules?group=<g>`** (`index()` L42-50): `{ "rules": [ <present() …with last_result> , … ] }`, ordered by name, optional `?group=` filter. (Guards don't need list, but it's here.)
- **`PATCH /rules/{key}`** (`update()` L88-101): **merge-patch** — only keys present in the body are touched; the writer merges against current DB state and re-validates the *resulting* shape (so flipping `agent→query` still enforces query fields). Returns the `present()` shape. `422` bad shape, `404` unknown key. Lets a guard edit threshold/sql/severity/cadence in place when Kevin tunes the win condition inline.
- **`DELETE /rules/{key}`** (`destroy()` L103-112): `{ "deleted": true, "key": "…" }`, `404` unknown. `ow_checks` is **soft-deleted** (history survives), the `ow_prompt_checks` payload row is hard-deleted. Called when a guard is discarded.

---

## 5. Status vocabulary → guard health mapping

Overwatch statuses (`app/Overwatch/CheckStatus.php`): `ok`, `warn`, `fail`, `error`, and `stale` (**`stale` is derived at read time and NEVER persisted**, so a raw `last_result.status` is only ever `ok|warn|fail|error`). Map to `goal_guards.health`:

| `last_result` | `goal_guards.health` | note |
|---|---|---|
| `null` (never run) | `unknown` | rule created, Overwatch hasn't run it yet |
| `status = "ok"` | `passing` | win condition holds |
| `status = "fail"` | `failing` | win condition broken |
| `status = "warn"` | `failing` | degraded — treat as a failing guard (a problem is a problem for a win condition) |
| `status = "error"` | `error` | the check itself threw (bad SQL, DB down) — surface, don't cue as "goal broke" |
| **staleness:** `at` older than `max(3 × cadence_minutes, 60m)` | `error` | Overwatch stopped running the rule; distinguish in `last_summary` ("guard stale — last run <ts>") |
| API unreachable / 401 / 503 / no key | `unknown` | degrade cleanly; UI shows "Overwatch not connected" |

Only a **state CHANGE** in `health` emits `guard_failed`/`guard_recovered`/`guard_error`/`guard_recovered` and fires a cue (never every poll) — same discipline as the watchdog's `UNIQUE(sentinel,subject_key)`.

---

## 6. Consequences the CONTRACT §12 must encode (all reflected there)

1. **No client-chosen key.** Store the returned `key`; put identity in `name`. `overwatch_rule_id` column reserved/NULL.
2. **Polling is primary.** `goal_guard_poll_min` (settings-KV, default 10) → `GET /rules/{key}` per set guard → map `last_result.status` (§5) → flip `health` on change → cue.
3. **Overwatch owns execution + its own cadence.** Our `cadence_minutes` on create tells Overwatch how often to run; our poll interval is independent (we just read the latest). A guard can go `unknown → passing` only after Overwatch's first run of it.
4. **Group must be whitelisted.** Default `custom`; there is no `goals` group (adding one is a darwin-dashboard change Kevin would deploy — out of scope for v0).
5. **Degrade with no key.** All Overwatch calls are wrapped; missing `OVERWATCH_API_KEY`/`OVERWATCH_API_URL` → proposals stay ghosts, set guards sit at `health='unknown'`, UI shows "Overwatch not connected". Nothing is lost; guards write to Overwatch the moment the key lands.
6. **query preferred, agent allowed.** A guard whose win condition reduces to one SELECT is `mode=query` (zero model cost). One that genuinely needs judgment is `mode=agent` (`check_prompt`). Guardable-ness is JARVIS's judgment at verify time (GUARDS.md), not a rule.

---

## 7. Files cited

| what | path (branch `overwatch/claude-cli-and-query-rules`) |
|---|---|
| routes + auth middleware name | `routes/api.php` L21-36 |
| controller (store/show/index/update/destroy/present/actor) | `app/Http/Controllers/Api/OverwatchRuleController.php` |
| writer (create/update/delete, key gen, validation) | `app/Overwatch/PromptRuleWriter.php` |
| query-mode columns + comparators + modes | `docs/overwatch/sql/005-add-rule-modes.sql`; `app/Models/Overwatch/PromptCheckRecord.php` (`MODE_QUERY/MODE_AGENT` L24-26, `COMPARATORS` L29) |
| status constants | `app/Overwatch/CheckStatus.php` (`ok/warn/fail/error/stale`) |
| result row read for `last_result` | `app/Models/Overwatch/Result.php` (table `ow_results`, `check_key` scope) |
| key prefix | `app/Overwatch/PromptCheck.php` (`KEY_PREFIX = 'prompt.'` L22) |
| bearer gate | `app/Http/Middleware/VerifyOverwatchApiKey.php` |
| groups whitelist | `config/overwatch.php` L85-98 |
