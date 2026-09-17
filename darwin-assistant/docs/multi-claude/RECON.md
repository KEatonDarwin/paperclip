# Multi-Claude Subscriptions — RECON

Node #289 (tree tree-44d2ff4a). Recon only, no product code. All anchors verified
live against this worktree (`hopper/multi-claude`, base commit at branch-cut).

## 1. Claude adapter + env injection seam

- `src/agent.ts:229` — `ADAPTERS.claude` block (the `claude:` adapter config).
  - `buildArgs()` at `src/agent.ts:262-271` composes CLI args (`--print - --output-format
    stream-json --verbose --dangerously-skip-permissions [--model][--resume][--effort][--add-dir]`).
    No account-related flag exists today — model is the only per-call selector.
  - `envOverrides(env)` at `src/agent.ts:273` — currently just
    `delete env['ANTHROPIC_API_KEY']`. **This is the exact place to inject
    `CLAUDE_CONFIG_DIR` for the active account** (e.g.
    `env['CLAUDE_CONFIG_DIR'] = activeAccount.config_dir`), since it already
    receives the full env object for the process about to spawn.
- `src/agent.ts:1001` — `runClaude()`, the single call site that runs any adapter.
  - `src/agent.ts:1015` — `const env: Record<string, string> = { ...(process.env as Record<string, string>) };`
    (fresh copy of the parent env, so mutating it per-call is safe/isolated).
  - `src/agent.ts:1016` — `adapter.envOverrides?.(env);` — **the ONLY place any
    adapter's envOverrides runs.** One seam, not scattered.
  - `src/agent.ts:1042` — `const child = spawn(adapter.bin, args, { env, cwd: JARVIS_CLI_CWD });`
    — confirms `env` (post-envOverrides) is what the child process actually
    receives. This is the full path: adapter config → envOverrides mutates env →
    spawn uses env.
- Selector integration point: `runClaude`'s `runtime` param already carries
  `{ adapter, model, options }` per DAR-680's per-thread override work — an
  account selector would most naturally live as a 4th field here (e.g.
  `runtime.accountKey`) or be resolved fresh inside `envOverrides` at spawn
  time by calling a `selectClaudeAccount()` function. Either shape is additive;
  no existing signature needs to change if the account is resolved lazily
  inside a rewritten `envOverrides`.

## 2. Usage poller (single-account, hardcoded)

- `~/.claude/claude-usage-poll.sh` — polls `claude.ai` usage via a browser
  session cookie (NOT the CLI's own OAuth token). Key details:
  - `ORG_ID="afc417b0-b3d0-4302-b18f-c40cb7394447"` — hardcoded, one org.
  - `COOKIE_FILE="$HOME/.claude/claude-ai-session-cookie"` — single file,
    single account's cookie.
  - `OUT_FILE="/tmp/claude-usage-live.json"` — single output file.
  - GET `https://claude.ai/api/organizations/${ORG_ID}/usage` with
    `Cookie: sessionKey=${COOKIE}`.
- systemd: `claude-usage-poll.service` (oneshot, `ExecStart=/home/kevin/.claude/claude-usage-poll.sh`)
  + `claude-usage-poll.timer` (60s, `OnBootSec=10s`).
- **For 2 accounts this needs duplication, not a parameter tweak**: a second
  cookie file (e.g. `~/.claude-b/claude-ai-session-cookie`), a second org id
  (each Claude login has its own org), a second output file (e.g.
  `/tmp/claude-usage-live-b.json`), and either a second service+timer pair or
  a loop over `claude_accounts` inside one script. The org id can't be
  guessed — Kevin's account-b login will need its own org id captured once
  (same manual step used to get the account-a cookie originally).

## 3. Governor (single-account read path)

- `src/hopper-governor.ts:36` — `const USAGE_FILE = process.env.CLAUDE_USAGE_FILE ?? '/tmp/claude-usage-live.json';`
  — one file, one account, module-level constant (not per-call).
- `src/hopper-governor.ts:187-202` — `readUsage()` reads that one file, returns
  `{fiveHour, weekly, staleMinutes}` from `five_hour.utilization` /
  `seven_day.utilization`.
- `src/hopper-governor.ts:253` — `governorCheck(adapter?: string | null)` —
  entry point `dispatchTick` calls before every new claim. Delegates to
  `evaluate(providerFor(adapter))` (providerFor maps any claude-ish adapter
  string to the single `'claude'` provider bucket — no per-account bucket
  exists).
- Ceilings/knobs (settings-KV via `getGovernorSetting`, env-fallback, UNCACHED
  so cockpit PATCHes take effect immediately — no restart needed):
  - `fiveHourCeiling()` `src/hopper-governor.ts:82` — default 90.
  - `weeklyCeiling()` `src/hopper-governor.ts:85` — default 30 (dropped from 40
    on 2026-09-12).
  - `weeklyModeSetting()` `src/hopper-governor.ts:73` — soft/hard.
  - `kevinActiveClaudeMax5h()` `src/hopper-governor.ts:79` — default 50 (the
    "claude OK while Kevin's active below 50% 5h" rule).
- **For the auto-swap to work, the governor's claude-gate logic needs to become
  "ANY enabled account has headroom" instead of reading one file.** Concretely:
  `readUsage()` (or a new `readUsageForAccount(key)`) would need to loop
  `claude_accounts`, and the 5h/weekly ceiling checks would evaluate per-account
  headroom, holding only when every enabled account is exhausted — exactly the
  behavior requested. This is a real logic change (not just a data-source swap)
  because today's `evaluate()` treats "claude" as one plan with one number.
- No `gov_override_*` (per-provider manual on/off toggle) exists yet in this
  worktree's base — that work lives on `hopper/gov-overrides`, not yet merged
  here. Not required for the account-swap feature, noted for awareness only.

## 4. API surface reading the same single file

- `src/handlers/api-v1.ts:625` — `readClaudeLiveUsage()` — reads
  `/tmp/claude-usage-live.json` (`LIVE_PATH`, hardcoded), falls back to
  `/tmp/claude-status.json` (statusline dump) if stale/missing. Returns
  `{five_hour, seven_day, model, updated_at}`.
- `src/handlers/api-v1.ts:1013` — `GET /provider-usage` — calls
  `readClaudeLiveUsage()` for the `claude` key alongside `readCodexUsage()` /
  `readAugmentUsage()`. Cockpit's Provider Usage widget consumes this shape
  directly. **Multi-account would need this endpoint to either return an
  array/map of per-account usage, or keep the top-level `claude` key as an
  aggregate ("best/active account") plus a new field exposing the full
  per-account breakdown** — a UI decision, not resolved by recon.

## 5. Settings-KV helpers (for the `claude_accounts` config)

- `src/conversation-db.ts:818-859` — flat `settings` table (`key TEXT PRIMARY
  KEY, value TEXT`), `getSetting(key)` / `setSetting(key, value)` /
  `getAllSettings()` / `deleteSetting(key)`. This is the exact mechanism
  already used for `model_presets`, `personality_stats`, and every
  `gov_*` governor knob. A `claude_accounts` setting storing a JSON array of
  `{key,label,config_dir,cookie_file,org_id,enabled}` fits this pattern with
  zero new schema — same as the spec's proposed shape.

## 6. CLI verification — `CLAUDE_CONFIG_DIR` is the real env var, confirmed live

Ran the installed CLI (`claude 2.1.266`, at `/home/kevin/.local/bin/claude`)
with `CLAUDE_CONFIG_DIR` pointed at a freshly-created empty directory:

```
CLAUDE_CONFIG_DIR=/tmp/cc-recon-test-<pid> claude --print - --output-format stream-json --verbose <<< "reply with the word PONG only"
```

Result: the isolated run returned `"Not logged in · Please run /login"`
(`error:"authentication_failed"`) instead of using the real `~/.claude`
credentials — proof the CLI reads `CLAUDE_CONFIG_DIR` and fully isolates auth
state (creds, session, memory paths — the init event even showed
`memory_paths.auto` rooted under the fresh dir) per config dir. A normal
invocation with no override uses `~/.claude/.credentials.json` (508 bytes,
present) and authenticates fine (this very worker is proof of that).

**Conclusion: `CLAUDE_CONFIG_DIR` is confirmed correct — no substitute env var
needed.** Account 'b' = a second directory (e.g. `~/.claude-b`) that Kevin logs
into once (`CLAUDE_CONFIG_DIR=~/.claude-b claude` → `/login`), same shape as
account 'a' (`~/.claude`, the default/back-compat path when the env var is
unset).

## Summary — what the build node(s) actually need to change

1. **New settings-KV `claude_accounts`** (JSON array) + read helper.
2. **A selector function** (e.g. `selectClaudeAccount()`) choosing the first
   enabled account under its 5h ceiling — consulted from both:
   - `src/agent.ts` `claude.envOverrides` (inject `CLAUDE_CONFIG_DIR` for the
     chosen account before spawn), and
   - `src/hopper-governor.ts` `evaluate()`'s claude branch (hold only when
     ALL enabled accounts are exhausted).
3. **Usage poller generalization**: either N copies of
   `claude-usage-poll.sh`/service/timer (one per account, distinct cookie
   file + org id + output file) or one script looping `claude_accounts` and
   writing `/tmp/claude-usage-live-<key>.json` per account.
4. **`/provider-usage` + governor `readUsage()`** both need to move from "one
   hardcoded file" to "look up the active/enabled account(s)' file(s)" —
   the single-account default (`~/.claude`, no `claude_accounts` setting or
   only one enabled) must stay byte-identical to today's behavior per the
   guardrail.
5. Cookie/credential files stay OUTSIDE the repo and are never committed —
   confirmed no code path in this worktree writes them into the repo tree.
