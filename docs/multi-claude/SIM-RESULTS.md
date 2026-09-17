# Multi-Claude — Node #295: full-stack dry run (SIM)

Dry-runs the account swap end-to-end — selector (`claude-accounts.ts`) +
governor (`hopper-governor.ts`) + adapter (`agent.ts` `runClaude`) — against a
throwaway sqlite DB and stub `/tmp/claude-usage-<key>-live.json`-shaped files.
**No real login, no jarvis.service restart, no live model call anywhere in
this node.** The adapter checks drive the real `runClaude()` code path against
a fake `claude` binary that only echoes back the env it was spawned with
(`CLAUDE_CONFIG_DIR`, whether `ANTHROPIC_API_KEY` survived) — same technique
node #291 used, reused here so the "adapter would set `CLAUDE_CONFIG_DIR`"
claim is proven against real code, not asserted from reading it.

Branch `hopper/multi-claude`, worktree `/home/kevin/paperclip-worktrees/multi-claude`,
commit at sim time `1909d65b3`. Ran against the compiled `dist/` from a full
`npm run build` in this worktree (pre-existing, unrelated `tsc` error on
`src/handlers/webhook.ts` — see **Build note** below; it does not touch any
multi-claude file and `dist/` still emits).

## New artifact

`scripts/multi-claude-e2e-sim.mjs` (+ `npm run multi-claude:e2e-sim`) — a new,
dedicated integration script written for this node. It exists because nodes
#290–294 each shipped thorough scoped unit tests for their own module
(selector, adapter, governor, poller, rate-limit rescue), but nothing
previously drove all three of **selector → governor → adapter** together in
one flow per scenario, on the exact 4 scenarios this node was asked to prove.
Scratch-DB guarded (refuses to run against `/home/kevin/paperclip/darwin-assistant/jarvis.db`),
self-cleans its temp dir + DB files on exit.

## The 4 required scenarios — all pass

```
$ npm run multi-claude:e2e-sim

  ✓ 1. Default single account → adapter CLAUDE_CONFIG_DIR unset, governor byte-identical to legacy gate
  ✓ 2. Two accounts A=95% B=10% → selector picks B, governor allows active_account=b, adapter injects CLAUDE_CONFIG_DIR=B
  ✓ 3. Both accounts ≥ ceiling → governor holds claude_all_accounts_full (no worker dispatched)
  ✓ 4. One account stale (usage file >10min old) → skipped, other account with headroom wins
  ✓ 4b. All accounts stale → governor holds usage_stale (selector finds nothing eligible)

[multi-claude-e2e-sim] 5/5 scenarios passed
```

### 1 — Default single account (no `claude_accounts` setting)

- `selectActiveClaudeAccount()` → `{ key: 'a', config_dir: null }` (the CLI
  default, `~/.claude`).
- `governorStatus('claude')` → `allow:true`, `reason:'ok'`, `active_account:'a'`,
  and the **legacy detail string is preserved verbatim** (`/clear to
  dispatch/`) — proves the multi-account gate didn't rewrite the single-account
  message.
- Real `runClaude('ping')` through the fake binary → `CFG=NONE|KEY=UNSET`. The
  adapter never touches `CLAUDE_CONFIG_DIR` for the default account, and
  `ANTHROPIC_API_KEY` (deliberately seeded as `sk-should-be-deleted` in the
  test env) is still stripped from the child env. **Byte-identical to the
  pre-multi-account single-subscription path**, exactly as designed.

### 2 — Two accounts, A 5h=95%, B 5h=10%

- Selector picks `b` (`config_dir` = B's scratch dir).
- Governor: `allow:true`, `active_account:'b'`, `five_hour:10`.
- Adapter: `runClaude('ping')` → `CFG=<B's config_dir>|KEY=UNSET`,
  `accountKey:'b'`. All three layers agree on B, which is the whole point of
  the swap.

### 3 — Both accounts ≥ ceiling (A=95%, B=92%, ceiling=90)

- `selectActiveClaudeAccount()` does **not** return `account: null` here — by
  design (see its docstring in `claude-accounts.ts`) it always hands back a
  best-effort fallback pick so a caller "still tries." What actually gates
  dispatch is the `eligible` flag per account and the **governor** — confirmed
  both accounts' `perAccount[].eligible === false`, and:
- `governorStatus('claude')` → `allow:false`, `reason:'claude_all_accounts_full'`,
  `active_account:null`.
- `governorCheck('claude')` (the entry point an actual dispatch loop consults
  before ever calling `runClaude`) returns the same `allow:false` — this is
  the check that stops a worker from being spawned at all in this scenario;
  the sim intentionally never calls `runClaude` here since a real dispatch
  loop wouldn't either.

### 4 — One account's usage file is stale

- A is stale (usage file backdated 30 min, past the 10-min staleness ceiling)
  even though its recorded 5h% (20%) is nominally lower than B's (55%). B is
  fresh and readable.
- Selector correctly **skips the stale account**: `perAccount` shows A
  `stale:true, eligible:false`; the pick is `b`.
- Governor: `allow:true`, `active_account:'b'`.
- Adapter: `runClaude('ping')` → `CFG=<B's config_dir>`, `accountKey:'b'`.
- **4b (bonus, same theme):** when *every* account's file is stale, the
  governor correctly reports `reason:'usage_stale'` — a distinct hold reason
  from scenario 3's `claude_all_accounts_full`, so an operator can tell "no
  data" apart from "all spent" at a glance (this distinction was already built
  by node #292; re-verified here through the same integration harness).

## Bug found / fixed

**None in the shipped code.** The only failure hit while building this sim was
in the sim script itself: an incorrect assumption that
`selectActiveClaudeAccount()` returns `account: null` when no account is
truly eligible. Reading the function's own docstring + `claude-accounts-test.mjs`
("all full → least-used (b) fallback") confirmed the real, intentional
contract — it always returns a best-effort fallback pick, and eligibility /
whether to actually dispatch is decided via `perAccount[].eligible` and the
governor, not by the selector returning nothing. Fixed the sim's assertions to
match the real (correct) contract; no production code was touched by this
node.

## Full regression pass (all multi-claude test suites, run fresh, same worktree/commit)

Ran every existing multi-claude script from nodes #290–294 for real (not
trusted from their prior reports) to confirm nothing on this branch regressed:

| Script | Result |
|---|---|
| `npm run claude-accounts:test` (node #290 selector unit tests) | 7/7 ✅ |
| `npm run claude-adapter-account:test` (node #291 adapter⇄account wiring) | 4/4 ✅ |
| `npm run governor-multiclaude:sim` (node #292 governor gate) | 10/10 ✅ |
| `npm run claude-ratelimit-rescue:test` (node #294 mid-flight rescue) | 3/3 ✅ |
| `npm run claude-accounts-route:test` (node #293 `/api/v1/claude-accounts` route) | 6/6 ✅ |
| `npm run multi-claude:e2e-sim` (this node, #295) | 5/5 ✅ |

**35/35 checks passing across 6 scripts.** Nothing needed fixing.

## Build note (not a multi-claude bug, flagging for visibility)

`npm run build` (`tsc`) reports one pre-existing, unrelated error:

```
src/handlers/webhook.ts(5,17): error TS2742: The inferred type of
'createWebhookRouter' cannot be named without a reference to
'.../node_modules/.pnpm/@types+express-serve-static-core@5.1.3/...'
```

This is on `src/handlers/webhook.ts` (git blame: commit `7cb5d0892`,
unrelated DAR-699 fix), not touched by any multi-claude node. `tsconfig.json`
does not set `noEmitOnError`, so `dist/` still emits correctly despite the
error (confirmed all multi-claude `dist/*.js` files were freshly regenerated
at build time and every sim/test above ran against them). Not fixed here —
out of scope for this node and pre-dates the `hopper/multi-claude` branch.

## What this proves for the tree as a whole

Nodes #290–294 wired the registry, adapter, governor, poller/provisioning, and
rate-limit rescue independently, each with its own solid unit coverage. This
node is the missing "does it actually work as ONE system" check, run without
needing Kevin's second real login or a service restart — and it confirms yes:
a fresh worker with no accounts configured behaves exactly as it does today, a
second configured account gets picked and threaded through the adapter
correctly, the governor refuses to dispatch when every account is genuinely
spent, and a stale usage file is treated as "unknown," never "known and
low." The feature is ready for the real second-login step (still gated on
Kevin minting the second subscription/logging in, per the tree's guardrails)
and for JARVIS's own review/deploy pass.
