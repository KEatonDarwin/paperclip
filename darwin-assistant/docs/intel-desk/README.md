# Intel Desk

Intel Desk is the daily stack-aware intel pull for JARVIS. It scans five lanes
for recent findings that matter to Kevin's actual setup, scores each item as
`act`, `watch`, or `fyi`, and lets Kevin promote useful findings into the Task
Hopper for review. It is not a generic news digest.

Kevin-facing handoff: `outbox/intel-desk.md` in the shared wiki.

Implementation contract: [CONTRACT.md](./CONTRACT.md).

## What Ships

Backend branch: `hopper/intel-desk`.

Cockpit branch: `hopper/intel-desk-ui`.

Main backend files:

- `src/intel-desk.ts` - SQLite tables, typed store helpers, sanitization, SSE,
  and Task Hopper promotion.
- `scripts/intel-pull.ts` - timer/manual runner entrypoint.
- `scripts/intel-pull/lanes.ts` - lane purposes, stack profile, prompt builder,
  and JSON schema builder.
- `scripts/intel-pull/claude-lane.ts` - one local `claude` CLI call per lane.
- `scripts/intel-pull/validate.ts` - defensive validation/sanitization of model
  output.
- `scripts/intel-pull/store.ts` - runner store adapter; prefers
  `src/intel-desk.ts` and falls back to the same schema if the backend module is
  not loaded yet.
- `systemd/intel-pull.service` and `systemd/intel-pull.timer` - committed unit
  templates. They are not installed by this branch.

Main cockpit files:

- `src/routes/intel-desk.tsx` - global `/intel-desk` page.
- `src/lib/cockpit-api.ts` - Intel Desk types, API calls, and SSE handlers.
- `src/lib/sse-worker.ts` - forwards `intel_run` and `intel_item` events.
- `src/routes/threads.tsx` - navigation link into the page.

## Lanes

Intel Desk runs five lanes:

| Lane | Purpose |
| --- | --- |
| `providers` | Anthropic, OpenAI/Codex, Augment/Auggie, Devin, Google model, pricing, quota, and rate-limit news. |
| `harvest` | Free tiers, quota resets, subscription arbitrage, and local models worth running on Kevin's WSL2 laptop or always-on hosts. |
| `tooling` | Claude Code, Codex, MCP, agent harnesses, workflow orchestration, and coding-agent ecosystem moves. |
| `stack` | Supabase, Lovable, Laravel, GitHub, Cloudflare, and dependency changes that affect Paperclip/JARVIS/Hub 2.0 work. |
| `social` | High-signal X, Reddit, and YouTube scanning for discovery and sentiment. |

The `social` lane also tries to read
`/home/kevin/obsidian/paperclip-wiki/wiki/ai-youtube-creators-source-index.md`
and passes the first slice of that file as discovery seed text. If the file is
missing or unreadable, the lane still runs.

Every lane prompt embeds a current stack profile: Hopper Engine, Foundry, Task
Hopper, cockpit pages, Claude/Codex/Auggie/Devin CLI providers, local host
facts, SQLite/Paperclip/MCP/Laravel/Supabase/Lovable/GitHub/Cloudflare, and the
rule that actionable findings become Hopper candidates rather than auto-started
work.

## Schedule And Manual Runs

The committed timer template runs daily at 6:30 AM America/Chicago:

```ini
OnCalendar=*-*-* 06:30:00
Persistent=true
AccuracySec=1m
```

The service runs as `kevin` from `/home/kevin/paperclip/darwin-assistant`:

```ini
ExecStart=/usr/bin/npx tsx /home/kevin/paperclip/darwin-assistant/scripts/intel-pull.ts --lanes all
```

The PATH and `CLAUDE_BIN=/home/kevin/.local/bin/claude` are explicit because
systemd does not source Kevin's interactive shell configuration.

The cockpit "Pull now" button calls:

```http
POST /api/v1/intel/run
```

That route creates an `intel_runs` row, spawns the same runner with
`--run-id <id>`, and returns immediately. If another run is already `queued` or
`running`, it returns `409` with the active run instead of starting a duplicate.

The runner can also be invoked manually from the backend worktree:

```bash
npx tsx scripts/intel-pull.ts --lanes all
npx tsx scripts/intel-pull.ts --lanes providers,stack
```

## Data Model

`src/intel-desk.ts` creates two tables in `jarvis.db` on import.

`intel_runs` tracks one pull:

- `run_date` - America/Chicago date as `YYYY-MM-DD`.
- `status` - `queued`, `running`, `done`, or `failed`.
- `started_at`, `finished_at` - ISO timestamps.
- `summary` - compact digest made from each lane digest.
- `error` - run-level failure if every lane fails or the runner dies.
- `created_at` - used by stale-run expiry.

`intel_items` tracks findings:

- `lane` - one of the five lanes above.
- `title`, `summary`, `why_it_matters` - plain text, length capped.
- `verdict` - `act`, `watch`, or `fyi`.
- `source_url` - accepted only if `http:` or `https:`.
- `source_kind` - `official_docs`, `pricing`, `release_notes`, `blog`,
  `github`, `reddit`, `x`, `youtube`, `paper`, or `other`.
- `tags` - JSON-encoded lowercase slugs.
- `promoted_hopper_id` - set after Hopper promotion.

The store emits global SSE events:

```ts
{ type: 'intel_run', action: 'created' | 'updated' | 'deleted', run }
{ type: 'intel_item', action: 'created' | 'updated' | 'deleted', item }
```

## Lane Output Envelope

Each lane is one local `claude` CLI call through subscription/login auth only.
`scripts/intel-pull/claude-lane.ts` deletes `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY` from the child environment before spawning.

The command shape is:

```bash
claude -p "$PROMPT" \
  --model "${INTEL_PULL_MODEL:-claude-sonnet-5}" \
  --output-format json \
  --tools WebSearch,WebFetch \
  --allowedTools WebSearch WebFetch \
  --strict-mcp-config \
  --permission-prompts none \
  --json-schema "$SCHEMA"
```

Only web search/fetch tools are exposed. No shell, file editing, MCP servers, or
permission prompts are available inside the lane session.

The CLI returns a JSON envelope. The runner reads `structured_output` when
present, or parses `result` as JSON as a fallback. The logical lane object is:

```ts
interface IntelLaneOutput {
  lane: 'providers' | 'harvest' | 'tooling' | 'stack' | 'social';
  digest: string;
  items: Array<{
    title: string;
    summary: string;
    why_it_matters: string;
    verdict: 'act' | 'watch' | 'fyi';
    source_url: string | null;
    source_kind:
      | 'official_docs'
      | 'pricing'
      | 'release_notes'
      | 'blog'
      | 'github'
      | 'reddit'
      | 'x'
      | 'youtube'
      | 'paper'
      | 'other';
    tags: string[];
  }>;
}
```

Validation rules:

- `lane` must match the requested lane when provided.
- `digest` is capped at 240 characters.
- A lane may return zero items; filler is worse than silence.
- Max 8 items per lane.
- `title`, `summary`, and `why_it_matters` are required for an item.
- Malformed individual items are dropped instead of failing the whole lane.
- URL schemes are restricted to `http:` and `https:`.
- Tags are normalized to lowercase slugs, max 8.
- Duplicate items within a lane output are dropped by normalized
  `source_url + title`.

If at least one lane succeeds, the run is marked `done` and successful items are
stored. If every lane fails, the run is marked `failed`.

## Promote To Hopper

`POST /api/v1/intel/items/:id/promote` calls `promoteIntelItem(id)`.

Promotion is idempotent. If the item already has `promoted_hopper_id`, the
existing Hopper item is returned and no duplicate is created.

New Hopper candidate shape:

- `title` - Intel item title.
- `summary` - Intel item `why_it_matters`.
- `source` - `intel-desk`.
- `source_ref` - the source URL if present, otherwise
  `<run_date>/<lane>/<item_id>`.
- `raw_message` - Intel item summary.
- `suggested_model` - `claude-sonnet-5` for `act`, otherwise null.

Promotion never starts a worker. It only creates a candidate card in the Task
Hopper so Kevin can use the normal Yes / Yes-but / Dismiss gate.

Because Intel Desk text is synthesized from public web content, Hopper treats
`source: intel-desk` as untrusted. `composeHopperSeed` uses a fixed task line
and quotes the title, summary, why-it-matters, and source as data. The finding
text never appears in an instruction-shaped slot.

## API

All routes live inside the authenticated `/api/v1` router and are reached by the
cockpit through `/cockpit-api/...`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/intel/runs?limit=20&status=done` | List runs. |
| `GET` | `/intel/runs/:id/items?lane=stack&verdict=act` | List items for a run. |
| `POST` | `/intel/run` | Start a manual pull, optionally with `{ "lanes": ["providers"] }`. |
| `POST` | `/intel/items/:id/promote` | Promote a finding into the Task Hopper. |

`POST /intel/run` expires stale active runs before the single-active-run check.
Any queued/running run older than 30 minutes is marked `failed`, so a crashed
runner cannot lock Intel Desk forever.

## Cockpit Page

The page is `/intel-desk`.

It shows:

- latest run status and summary,
- Pull now button,
- run history selector,
- lane filter,
- verdict filter,
- item cards with source link, tags, why-it-matters, and `-> Hopper` button.

The page polls every 10 seconds and also listens for `intel_run` and
`intel_item` SSE events for immediate updates.

All fetched item fields render as plain React text. The page does not use
`dangerouslySetInnerHTML`.

## Adding A Lane

Adding a lane is intentionally explicit. Do not only add it to the prompt file.

1. Add the lane to `IntelLane` and `INTEL_LANES` in `src/intel-desk.ts`.
2. Add the lane to the SQLite `CHECK` constraints in `src/intel-desk.ts`.
3. Add the lane to `IntelLane` and `INTEL_LANES` in
   `scripts/intel-pull/store.ts`.
4. Add the lane to the fallback SQLite `CHECK` constraints in
   `scripts/intel-pull/store.ts`.
5. Add a purpose in `scripts/intel-pull/lanes.ts`.
6. Update any lane-specific prompt enrichment in `scripts/intel-pull.ts`.
7. Add the lane to the cockpit `IntelLane` type in
   `jarvis-command-center/src/lib/cockpit-api.ts`.
8. Add it to the `LANES` control in
   `jarvis-command-center/src/routes/intel-desk.tsx`.
9. If this runs against an existing live DB, write a real SQLite table rebuild
   migration for the `CHECK` constraint. `ALTER TABLE ADD COLUMN` cannot change
   an existing SQLite `CHECK`.
10. Re-run backend build/smoke and cockpit build.

## Configuration Knobs

Backend runner environment:

- `CLAUDE_BIN` - path to the local Claude CLI. Default is `claude`.
- `INTEL_PULL_MODEL` - lane model. Default is `claude-sonnet-5`.
- `INTEL_DESK_NPX_BIN` - binary used by the HTTP route to spawn the runner.
  Default is `/usr/bin/npx`.
- `INTEL_DESK_RUNNER_SCRIPT` - runner script path for the HTTP route. Default is
  `scripts/intel-pull.ts`.
- `INTEL_DESK_RUNNER_CWD` - runner working directory for the HTTP route. Default
  is `process.cwd()`.

Social lane source seed:

- `/home/kevin/obsidian/paperclip-wiki/wiki/ai-youtube-creators-source-index.md`.

## Safety Notes

- No provider API keys are used for model calls.
- Lane child env strips `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`.
- The HTTP route also strips those env vars before spawning the runner.
- Lane sessions only have WebSearch/WebFetch.
- Web text is untrusted and rendered as plain text.
- `source_url` is normalized to `http:`/`https:` only.
- Intel Desk does not auto-start work, send external messages, open PRs, touch
  production systems, or spend money.
- Promotion only creates a Task Hopper candidate.
