# Hopper self-upgrade #1 — Morning Debrief + decision memory + adversarial review

Tree `tree-e921ab3a`. The Hopper Engine's first self-tree: recon → build → adversarial
review → docs+push, run against its own harness (`darwin-assistant`) in an isolated
worktree. Branch: `hopper/self-upgrade-1`.

## What changed

### 1. Morning Debrief replaces the Build Standup

Kevin retired the old Build Standup 2026-09-07 ("dump it entirely") — it narrated
threads *he* drove and was blind to work the Hopper Engine did autonomously
overnight. `buildMorningBriefing()` in `src/briefing.ts` now composes a five-section
**MORNING DEBRIEF** instead:

1. **Overnight autonomous work** — `hopper_trees`/`hopper_nodes` that moved in the
   last 16h, joined to `spawn_tasks`, one line per node (outcome, model, attempts).
   "No overnight runs." when nothing ran.
2. **Decisions I made** — node results + hopper-engine bells (governor holds,
   completions, blocks) from the same window.
3. **Follow-on candidates** — 2-3 next trees the model proposes, filed into the
   Task Hopper (`createHopperItem`, source `morning-debrief`) so each is one click
   in `/hopper`. Deduped against the last 20h so an on-demand re-fire doesn't
   double-file.
4. **Needs your call** — open `owner:kevin` thread-todos + `blocked`/
   `blocked_question` nodes, not window-limited (a node blocked three days ago
   still needs Kevin today).
5. **I'd start with** — the single highest-leverage next move.

Composition still goes through the local `claude` CLI with `ANTHROPIC_API_KEY`
stripped from the child env (NO API KEYS, unchanged). The model emits follow-ons
after a `---FOLLOWONS---` marker; a missing/garbled block is non-fatal and falls
back to candidates derived from raw data. Timeout raised 90s → 180s (the debrief
prompt carries a whole night of node results). `getShimSnapshot`/
`getTopPriorities`/`getPaperclipSnapshot` (used by the separate `jarvis-brief.ts`
cockpit-landing brief) are untouched.

### 2. `GET /hopper-engine/history` — decision memory

New read-only endpoint (`src/hopper-engine.ts` `getHopperHistory()`, wired in
`src/handlers/api-v1.ts`). Aggregates **settled** node outcomes (`done`/`blocked`/
`split` — running/pending/draft/blocked_question excluded so they don't skew
averages) by model: counts + avg attempts, plus the last 30 settled nodes. Lets a
planner route a new tree's nodes to models based on real history instead of
guesswork. No schema change — reuses the existing `model`/`status`/`attempts`
columns on `hopper_nodes`.

### 3. Adversarial review fixes (commit `4381388cc`)

A review pass on the two builds above found three defects, all breaking the same
promise — that the debrief degrades honestly instead of lying or dying:

1. **Silent lie on CLI failure.** `runDebrief` only rejected when `err && !stdout`.
   A *failed* run (non-zero exit / timeout kill) that still printed something to
   stdout — e.g. a "Claude usage limit reached." banner, very plausible given the
   governor exists precisely because Kevin hits 5h ceilings — fell through to a
   lenient parse and resolved successfully. That banner would have shipped as
   Kevin's entire 8am debrief. Fixed: an errored run now only resolves if stdout is
   a well-formed `{result: string}` envelope; anything else rejects so the
   deterministic five-section fallback renders instead.
2. **Silent permanent death on hang.** `sendDailyBriefing`'s try/catch contains
   throws, but the two awaited signal lookups (`gog` calendar subprocess,
   Paperclip Postgres query) were unbounded — a promise that never settles skips
   both the catch and index.ts's re-arm of tomorrow's timer, killing the morning
   message forever with no error logged. Same failure class that killed Project
   Shepherd for 17 days (see JARVIS memory). Fixed: `settleWithin()` puts a 30s
   ceiling on each signal, degrading to a placeholder line on timeout.
3. **False green on missing DDL.** `briefing.ts` queried `hopper_nodes`/
   `hopper_trees` without importing the module that owns their `CREATE TABLE`
   statements — it only worked by module-graph accident (index.ts happens to
   import the engine first). From any other entrypoint the query threw
   `no such table`, the catch swallowed it, and the debrief confidently reported
   "nothing ran overnight." Fixed: added the side-effect `import
   './hopper-engine.js'`, matching the engine's own `import './spawn-tasks.js'`
   pattern. Also bounded the previously-unbounded overnight-nodes query with
   `LIMIT 120`.

Verified: `tsc --noEmit` clean; 5 CLI outcomes (ENOENT / banner+exit1 /
truncated-JSON+exit1 / good-envelope+exit1 / empty+exit1) each take the correct
branch; `/hopper-engine/history` correct on an empty table and all-null models; a
full `buildMorningBriefing` run against the live DB with a failing CLI rendered all
five fallback sections with real overnight tree data and no banner leak.

## Deploying this

Workers never deploy. This branch sits in the isolated worktree
(`/home/kevin/paperclip-worktrees/hopper-self`) and is never merged into or run
from the live checkout (`/home/kevin/paperclip`) by a worker, and no worker
restarts `jarvis.service`. To ship it:

1. Kevin (or JARVIS, orchestrator-side, after his review) merges
   `hopper/self-upgrade-1` into the live checkout's working branch.
2. Rebuild `darwin-assistant` (`npm run build` / the repo's normal build step)
   from the live checkout.
3. Restart `jarvis.service` via a **detached** `systemd-run` (the standard
   pattern documented in JARVIS memory) — never a synchronous restart from inside
   a turn that's running in the jarvis.service cgroup, since that kills the
   restarting process mid-command.
4. Confirm the next 8am fire (or an on-demand "good morning") renders the new
   five-section Morning Debrief, and `GET /hopper-engine/history` returns data.

## Dependency results (one line each)

- **Recon** (node, upstream): mapped `src/hopper-engine.ts`/`hopper-governor.ts`
  and the existing morning-brief path in `src/briefing.ts`, identifying the Build
  Standup as the target for replacement and the two integration points
  (`sendDailyBriefing` cron + on-demand "good morning" trigger both call
  `buildMorningBriefing()`).
- **Morning Debrief rewrite** (commit `6bf1a4789`): replaced the Build Standup with
  the five-section self-report described above; local-`claude`-CLI composition
  preserved, deterministic fallback added, timeout 90s→180s, stdin closed.
- **Decision-memory endpoint** (commit `483aebac6`): added
  `GET /hopper-engine/history` aggregating settled hopper-node outcomes by model —
  read-only, zero schema change.
- **Adversarial review** (this branch, reviewed both builds above): found 3 real
  defects (silent-lie-on-failure, hang-kills-tomorrow's-cron, false-green-on-
  missing-DDL), all fixed in commit `4381388cc`, verified with `tsc --noEmit`
  clean plus the CLI-outcome/history/full-run checks listed above.
- **Docs + push** (this node, `#11`): wrote this document; committed and pushed
  the branch.
