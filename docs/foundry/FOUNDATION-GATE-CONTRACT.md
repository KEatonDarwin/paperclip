# Foundry Foundation Gate Contract

Recon node: `tree-53a87489` / node `145`.

## Why This Exists

The `suppression-manager` dogfood asked for a Laravel application, but no module owned the application skeleton. The integration MERGE worker filled the gap by inventing a fake `artisan` script and pseudo-Blade views instead of creating a real Laravel app. The adversarial review correctly blocked the project in `DECISIONS.md` commit `cfd8cac`.

The fix is a server-owned Foundation Gate:

- The planner declares the framework foundation in the blueprint.
- The Foundry server scaffolds that foundation deterministically before any worker tree is planted.
- The server runs foundation checks before accepting `done` from module BUILD nodes and the integration MERGE node.
- Workers never create fake framework bones to get tests green.

## Runtime Template Authority

Runtime template source is `darwin-assistant/src/foundry-templates.ts`.

- `getFoundrySkillDir()` returns `FOUNDRY_SKILL_DIR` or `/home/kevin/obsidian/paperclip-wiki/skills/foundry` (`foundry-templates.ts:151-153`).
- `loadTemplate()` reads `<skill-dir>/templates/<name>.md` first (`foundry-templates.ts:166-170`).
- Embedded `FALLBACK_TEMPLATES` are used only when the wiki template file cannot be read (`foundry-templates.ts:171-174`).

Therefore the authoritative runtime templates are the wiki files in `/home/kevin/obsidian/paperclip-wiki/skills/foundry/templates/*.md` when present. The embedded fallbacks must still be updated with the same anti-shim language so a missing wiki file cannot resurrect the old behavior.

## Blueprint Contract

Add a top-level `foundation` object to the Foundry blueprint:

```ts
interface FoundryFoundation {
  stack: string;
  scaffold_cmd: string;
  checks: Array<{
    cmd: string;
    expect_regex?: string;
  }>;
}
```

JSON example:

```json
{
  "name": "suppression-manager",
  "prompt": "Build a Laravel suppression manager...",
  "foundation": {
    "stack": "Laravel 12",
    "scaffold_cmd": "composer create-project laravel/laravel .",
    "checks": [
      {
        "cmd": "php artisan --version",
        "expect_regex": "^Laravel Framework"
      },
      {
        "cmd": "test -f artisan && test -d app && test -d bootstrap && test -d routes && test -d tests"
      }
    ]
  },
  "modules": [],
  "wiring": [],
  "integration": { "test": "php artisan test", "docs": "README.md" },
  "run": { "command": "php artisan serve", "preview_url": "" }
}
```

Persistence rules:

- The DB-owned copy lives inside `foundry_projects.blueprint` (`foundry.ts:274-300`). Do not add a separate SQL column for v0.1 unless later workers find a hard need; the existing JSON blueprint is the source of truth.
- The in-memory `Blueprint` type gains `foundation?: FoundryFoundation` next to `integration` and `run` (`foundry.ts:232-240`).
- Planner output must include `foundation` for any framework or root application prompt. In practice, prompts naming Laravel, Rails, Django, Next, Nuxt, SvelteKit, Phoenix, Express app shells, or similar app frameworks require it.
- The planner prompt shape in `/skills/foundry/templates/planner-prompt.md` must show `foundation` in the output contract (`planner-prompt.md:14-34`) and add a hard rule: framework apps need a deterministic scaffold, not a model-generated skeleton.
- `foundry.schema.json` must add top-level `foundation` with `additionalProperties: false`, required `stack`, `scaffold_cmd`, `checks`, and each check requiring `cmd` (`foundry.schema.json:1-71` currently has no foundation property).
- `validateBlueprint()` must validate `foundation` shape and reject framework-app blueprints that omit it (`foundry.ts:740-855`).

Planner behavior:

- For a framework app, emit an `app-shell` module of kind `service` or `library` that owns framework wiring at the root. Every module that needs the application shell depends on `app-shell`.
- `app-shell` does not run `scaffold_cmd`. The server already did that. The module wires providers, routes, service providers, config, views, and test harness into the real scaffold.
- Missing stack knowledge is a planning failure, not something BUILD or MERGE workers improvise.

## Launch-Time Scaffold Gate

The lifecycle insertion point is `launchProject()`:

- Route entry: `POST /foundry/projects/:id/launch` calls `launchFoundryProject()` (`handlers/api-v1.ts:1489-1495`).
- Current lifecycle: `launchProject()` validates the blueprint, marks project `building`, then calls `maybePlantReadyModules()` and `maybePlantIntegrationTree()` (`foundry.ts:1460-1471`).
- New lifecycle: after blueprint validation and before any call to `maybePlantReadyModules()`, run the foundation scaffold.

Required sequence:

```ts
export function launchProject(id: string) {
  const project = getProjectStmt.get(id) ?? null;
  const blueprint = loadBlueprint(project);
  const validation = validateBlueprint(blueprint);
  if (!validation.ok) throw ...

  runFoundationScaffold(project, blueprint.foundation);
  persistFoundryJson(project, blueprint);
  runFoundationChecksOrBlock(project, "launch", project.repo_path);

  setProjectStatusStmt.run("building", id);
  maybePlantReadyModules(id);
  maybePlantIntegrationTree(id);
}
```

Implementation details:

- Create a helper in `foundry.ts` or a new `foundry-foundation.ts` module. Keep it plain code: `child_process.execFile` or `spawn`, no model calls.
- Run `foundation.scaffold_cmd` in an EMPTY staging directory beside `project.repo_path`, then overlay the result onto the repo (see As-Built Hardening §1) — never inside the repo (`.git/` makes it non-empty and real scaffolders refuse), never in a worker worktree.
- Run under `/bin/bash -lc <scaffold_cmd>` so normal shell commands work, but still sanitize env by deleting model API keys if inherited.
- Ensure the repo is clean before scaffold except for server-written `foundry.json`. If unrelated dirty files exist, block the project before running the command.
- Commit all scaffold changes, including `foundry.json`, BEFORE asserting the checks (a wrong check must not strand real bones uncommitted — As-Built §4), with:

```txt
FOUNDATION scaffold: <foundation.stack>
```

- If the command succeeds but produces no diff, do not create an empty commit. Still run checks.
- On failure, set project status `blocked`, set `last_error` to the command, exit code, and stderr/stdout tail, emit `foundry_project`, create a Foundry notification, and plant no module trees.

Idempotency on retry:

- Before running `scaffold_cmd`, check for an existing git commit whose subject exactly matches `FOUNDATION scaffold: <foundation.stack>`.
- If it exists, skip `scaffold_cmd` and run checks only.
- If a launch retry finds a different existing foundation stack or a changed `scaffold_cmd` for an already-scaffolded repo, block with a replan-level error. Do not run a second non-idempotent scaffold over an existing app.

This catches the real incident: a Laravel project must have a commit produced by `composer create-project` (or equivalent deterministic scaffold) before BUILD workers exist.

## Foundation Checks

Checks are persisted in two places:

- Authoritative execution source: `foundry_projects.blueprint.foundation.checks` in SQLite. Workers cannot edit this.
- Transparent repo copy: root `foundry.json.foundation.checks`, written by the server at launch. Workers may read it, but the finish gate must not trust it.

Check runner contract:

```ts
interface FoundationCheckResult {
  cmd: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  expect_regex?: string;
}
```

- Execute each check with cwd set to the branch checkout being verified.
- Default timeout: 120 seconds per check.
- Suggested env knob: `FOUNDRY_FOUNDATION_CHECK_TIMEOUT_MS`, default `120000`.
- Capture combined stdout and stderr, truncated to a safe size in the blocked result.
- If `expect_regex` is present, compile it as JavaScript `RegExp` and test it against combined output. Exit 0 alone is not enough when `expect_regex` is set.
- If `expect_regex` is absent, exit 0 is the pass condition.
- First failing check blocks; include all completed check results in the blocked payload.

PATH under systemd:

- Do not assume an interactive shell PATH.
- Before spawn, set a deterministic PATH if `process.env.PATH` is empty or too small:

```txt
/home/kevin/.local/bin:/home/kevin/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
```

- This mirrors the non-interactive CLI lessons from the Claude/Codex/Auggie pollers and deploy scripts.

Missing toolchain:

- `composer: command not found`, `php: command not found`, `node: command not found`, or any exit 127 blocks the project or node.
- Workers must not shim around missing toolchains. No fake `artisan`, fake framework files, local test-runner substitutes, or generated stubs pretending to be a framework.
- The blocked message should say exactly which command is missing and which stack check failed.

## Finish-Time Server Gate

The choke point is the Hopper finish route:

- `POST /hopper-nodes/:id/finish` validates the payload in `handlers/api-v1.ts:1690-1719`.
- It calls `finishHopperNode()` in `hopper-engine.ts:504-555`.
- `finishHopperNode()` currently accepts `done` at `hopper-engine.ts:514-516` with no Foundry-specific structural gate.

Add the foundation gate before `done` is accepted for Foundry nodes. The least-circular implementation is in the API route:

```ts
if (outcome === "done") {
  const gate = runFoundryFoundationFinishGate(id);
  if (!gate.ok) {
    const updated = finishHopperNode(id, "blocked", { result: gate.result });
    res.json({ node: updated });
    return;
  }
}
const updated = finishHopperNode(id, outcome, ...);
```

The helper can live in `foundry.ts` or `foundry-foundation.ts` and use Foundry tables to decide whether a node is gated.

Gated node kinds:

1. Module BUILD nodes.
   - Identify by matching the Hopper node id against `foundry_modules.stage_nodes.build`.
   - Current module node ids are written in `plantModuleTree()` (`foundry.ts:1236-1304`).
   - Run checks in the module branch checkout: `worktreePath(project, module.key)`, derived by `worktreePath()` (`foundry.ts:1165-1170`) and rendered into BUILD specs (`foundry.ts:1206-1226`, template `build.md:18-22`).
   - Purpose: after the first BUILD, no worker can claim framework bones exist unless the real scaffold still passes.

2. Integration MERGE node.
   - Identify by `project.integration_tree_id` plus the first integration node titled `MERGE <project>` created in `maybePlantIntegrationTree()` (`foundry.ts:1411-1455`).
   - Run checks in the integration checkout: `worktreePath(project, "integration")`, rendered as `integration_worktree` in `composeIntegrationSpec()` (`foundry.ts:1380-1408`) and used by `integrate-merge.md:14-18`.
   - Purpose: after all module branches are merged and root wiring is applied, the integrated app must still be a real framework app.

Not gated:

- TEST, DOC, REVIEW, and DOCS nodes. They can add tests/docs/review findings, but they do not get to make a fake framework skeleton acceptable.

Failure behavior:

- If a gated node posts `outcome: "done"` and a check fails, the server converts that finish to `blocked`.
- The node result must include:
  - `FOUNDATION CHECK FAILED`
  - stack
  - checkout path
  - failing command
  - timeout or exit code
  - regex mismatch if applicable
  - output tail
- Dependents do not dispatch because the node is not `done`.
- In addition to the checks, the checkout must be a git checkout whose HEAD descends from the FOUNDATION commit (`FOUNDATION DERIVATION FAILED` otherwise) — see As-Built Hardening §2.

## Template Changes Required

Because wiki templates are authoritative at runtime, update:

- `/home/kevin/obsidian/paperclip-wiki/skills/foundry/templates/planner-prompt.md`
- `/home/kevin/obsidian/paperclip-wiki/skills/foundry/templates/build.md`
- `/home/kevin/obsidian/paperclip-wiki/skills/foundry/templates/integrate-merge.md`
- `/home/kevin/obsidian/paperclip-wiki/skills/foundry/templates/test.md` if verifier instructions should explicitly flag fake foundations.

Minimum worker-facing language:

```md
## Foundation Gate
- If the blueprint has `foundation`, the root framework skeleton is server-created before this node runs.
- Do not create or fake framework entrypoints to satisfy checks. Missing `artisan`, missing `vendor/`, missing framework directories, or missing toolchain => finish `blocked`.
- Do not edit `foundry.json.foundation.checks` to bypass the gate. The server runs the DB-owned checks before accepting `done`.
```

Also update the embedded fallbacks in `foundry-templates.ts:6-149`.

## Edge Cases

### Existing repos

If `repo_path` already exists, do not run scaffold blindly into a non-empty app. The allowed cases are:

- No prior app skeleton and clean repo: run scaffold.
- Prior `FOUNDATION scaffold: <stack>` commit exists: skip scaffold, run checks.
- App skeleton already exists but no foundation commit exists: run checks. If checks pass, commit only `foundry.json` with `FOUNDATION scaffold: <stack>` or a follow-up convention `FOUNDATION adopt: <stack>` if the implementer wants a clearer audit trail. If checks fail, block.

### Non-idempotent scaffold command

Most framework scaffolds are not safe to rerun. Never rerun once the foundation commit exists. Changed `scaffold_cmd` after scaffold is a replan/block, not an automatic rerun.

### Check timeout

Default 120 seconds. Timeout blocks with `timedOut: true`; do not retry inside the same finish request.

### Systemd PATH

Use the deterministic PATH above. Do not rely on `.bashrc`, `nvm`, interactive Composer paths, or a user shell. The command may still use `/bin/bash -lc`, but the environment must be explicit.

### No checks

For framework app blueprints, `checks` must contain at least one command. A framework app with `checks: []` is invalid. Non-framework/library blueprints may omit `foundation`.

### Worker-edited foundry.json

Persist `foundation.checks` to `foundry.json` for transparency, but always execute the DB-owned blueprint copy. If the integration REVIEW worker sees drift between root `foundry.json.foundation` and the DB-owned prompt/spec, it should block the project.

## As-Built Hardening (adversarial review, tree-53a87489 node #149, 2026-09-12)

The review attacked the built gate with a real `composer create-project laravel/laravel` run on a scratch DB and found four holes, all fixed on `hopper/foundry-foundation` and proven by sim checks #16a/#18/#19/#20:

1. **Scaffold ran in the repo → real scaffolders refuse it.** `composer create-project laravel/laravel .` (the planner-prompt example), `create-next-app`, and `rails new` all die on a non-empty target, and `.git/` alone makes the Foundry repo non-empty ("Project directory is not empty", verified). Fix: `runStagedFoundationScaffold()` runs `scaffold_cmd` in an EMPTY sibling staging dir (`<parent>/.foundry-scaffold-<slug>-XXXX`, same filesystem), then overlays the output onto the repo, skipping any `.git` the scaffolder itself created (create-next-app / rails init one). The repo is untouched until the scaffold has exited 0. Scaffold has its own timeout knob, `FOUNDRY_FOUNDATION_SCAFFOLD_TIMEOUT_MS` (default 600 000), separate from the 120 s check timeout. Measured: Laravel 12 scaffold 6–8 s on the current box, warm or cold cache.

2. **Checks alone cannot tell real bones from a hand-built skeleton.** A bare directory containing `<?php echo "Laravel Framework 12.0.0";` as `artisan` PASSES `php artisan --version =~ /^Laravel Framework/` — the literal suppression-manager shape. Fix: the finish gate now ALSO requires the checkout to be a git checkout whose HEAD descends from the `FOUNDATION scaffold|adopt: <stack>` commit (`git merge-base --is-ancestor`). Result carries `FOUNDATION DERIVATION FAILED` under the `FOUNDATION CHECK FAILED` header. A worker branching from the project base ref satisfies this for free; a re-initialised or bare tree never can. Planner checks are still run first (they are the planner-visible assertion); derivation is the planner-independent floor.

3. **Vacuous checks silently "adopted" nothing.** If every check passed on the bare bootstrap repo (e.g. `{cmd: "php --version"}`), the old flow took the adopt path and committed `FOUNDATION adopt` with no skeleton. Fix: when the repo is a bare Foundry bootstrap (only `foundry.json`/`README.md`/`modules`/`contracts`, no app markers) and the pre-scaffold checks all pass, launch blocks with `foundry_foundation_checks_vacuous`. Adopt only fires on a repo that already has real app content.

4. **A wrong check after a good scaffold killed the project permanently.** Old order: scaffold → checks → commit. A bad `expect_regex` after a successful `composer create-project` left the scaffold uncommitted and the working tree dirty, and the blueprint was locked (status `blocked`), so relaunch 409'd forever on `foundry_foundation_dirty_repo`. Fix: (a) the scaffold (exit 0) is committed as `FOUNDATION scaffold: <stack>` BEFORE the checks are asserted — bones are real, only the assertion was wrong; (b) `setBlueprint` accepts edits while the project is `blocked` **and nothing has been planted** (no module `tree_id`, no `integration_tree_id`) — the SQL guard enforces the same condition atomically; (c) relaunch takes the idempotent path (commit exists → re-assert checks, never re-scaffold). A changed `scaffold_cmd` or stack still blocks as before.

Also shipped in the same pass:

- Every planner-authored command the server executes is logged verbatim: `[foundry-foundation] cwd=… exit=… ms=… cmd="…"` (plus `TIMED_OUT`/`error=` when relevant). Output tails stay on the node/project result.
- A gate-rejected `done` that gets auto-retried (`foundry_auto_decide`) now receives a foundation-specific retry block instead of the Contract Resolution Rule text — the failure is not a contract conflict, and the worker is told the checks are DB-owned and the worktree must derive from the base ref.
- Worker templates (wiki kit + embedded fallbacks) say that dependencies are NOT committed: `vendor/`, `node_modules/` are git-ignored by every real scaffold, so a fresh worktree fails `php artisan --version` until the worker runs `composer install` / `npm ci`. That is intended — a worker that never installed deps never ran its tests either — but it must be stated, or the first real Laravel BUILD blocks on "vendor/autoload.php: No such file".
- The integration REVIEW template gets an explicit foundation-reality step (confirm the FOUNDATION commit is an ancestor, no hand-rolled framework binstubs anywhere, `foundry.json.foundation` matches the DB-owned spec).

### Known limitations left open (deliberately, with the numbers)

- **The server runs scaffold and checks synchronously (`spawnSync`) inside Express handlers.** `POST /launch` blocks the whole `jarvis.service` event loop for the scaffold duration (6–8 s for Laravel here; minutes on a Raspberry-Pi-class box or a cold `create-next-app`), and every gated finish blocks it for the checks' duration (~100 ms for `php artisan --version`; up to 120 s × N on a hung check). While blocked, no SSE, chat, dispatcher tick, or cockpit call is served. The synchronous form is also what currently makes "two finishes on one node" and "lease expiry during checks" impossible to interleave. Converting to async `spawn` is the right follow-up but requires `launchProject`/the finish gate/the sim to go async AND a claim-token guard in `finishHopperNode` (compare `attempts`/`worker_thread_ext` captured before the checks) so a re-dispatched node cannot be finished by the previous worker's late gate. Not done in this pass; sized as its own node.
- **Timeout kills the `bash -lc` process, not its process group.** A compound scaffold command (`a && b | c`) that times out can leave a child running; a simple command is exec'd by bash and receives the signal directly. `composer`/`npx` invocations are simple commands, so this is theoretical today.
- **The gate proves derivation and the planner's assertions, not that a worker's COMMITTED state matches its working tree.** A worker that has real bones on disk but commits garbage is caught one stage later by the MERGE gate (which runs in the integration worktree after the merge), not at BUILD.
- **`expect_regex` is matched against `stdout + "\n" + stderr`, un-flagged.** `^` anchors the whole string; a PHP deprecation printed to stdout before the version line would fail `^Laravel Framework`. Prefer un-anchored or `(?m)`-style patterns, or `test -f` style checks, when authoring.
- **`FORBIDDEN_FOUNDATION_CHECK_RE` over-blocks** read-only `artisan migrate:status`. Safe direction; noted.



- `darwin-assistant/src/foundry.ts:132-149` - `FoundryProjectRow`, DB-backed project shape.
- `darwin-assistant/src/foundry.ts:232-240` - current `Blueprint` interface; add `foundation`.
- `darwin-assistant/src/foundry.ts:274-300` - `foundry_projects.blueprint` JSON persistence.
- `darwin-assistant/src/foundry.ts:636-665` - initial repo scaffold; keep separate from framework foundation scaffold.
- `darwin-assistant/src/foundry.ts:740-855` - blueprint validation; add foundation validation.
- `darwin-assistant/src/foundry.ts:1135-1137` - blueprint load point from DB.
- `darwin-assistant/src/foundry.ts:1165-1170` - Foundry worktree path convention.
- `darwin-assistant/src/foundry.ts:1206-1233` - BUILD/TEST/DOC spec rendering vars.
- `darwin-assistant/src/foundry.ts:1236-1304` - module tree planting and module BUILD node ids.
- `darwin-assistant/src/foundry.ts:1380-1408` - integration spec vars, including integration checkout path.
- `darwin-assistant/src/foundry.ts:1411-1455` - integration MERGE/REVIEW/DOCS tree planting.
- `darwin-assistant/src/foundry.ts:1460-1471` - Launch lifecycle insertion point.
- `darwin-assistant/src/foundry.ts:1630-1668` - Foundry event loop after Hopper node events.
- `darwin-assistant/src/foundry-planner.ts:50-56` - planner prompt read from wiki with fallback.
- `darwin-assistant/src/foundry-planner.ts:183-249` - one-shot local Claude planner, no API key.
- `darwin-assistant/src/foundry-planner.ts:279-295` - planner validation and `setBlueprint`.
- `darwin-assistant/src/foundry-templates.ts:151-190` - runtime template loading and rendering.
- `darwin-assistant/src/foundry-settings.ts:14-22` - settings-KV helper pattern for timeout/env knobs if needed.
- `darwin-assistant/src/handlers/api-v1.ts:1489-1495` - launch route.
- `darwin-assistant/src/handlers/api-v1.ts:1690-1719` - finish route, best place to transform gated `done` into `blocked`.
- `darwin-assistant/src/hopper-engine.ts:504-555` - current finish state transition.
- `/home/kevin/obsidian/paperclip-wiki/skills/foundry/templates/planner-prompt.md:14-34` - planner JSON shape.
- `/home/kevin/obsidian/paperclip-wiki/skills/foundry/templates/build.md:12-58` - BUILD worker procedure and finish contract.
- `/home/kevin/obsidian/paperclip-wiki/skills/foundry/templates/integrate-merge.md:9-45` - MERGE worker procedure and finish contract.
- `/home/kevin/obsidian/paperclip-wiki/skills/foundry/templates/foundry.schema.json:1-130` - JSON schema to extend.

