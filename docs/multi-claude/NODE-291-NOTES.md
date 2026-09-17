# Multi-Claude — Node #291: claude adapter ⇄ active account (auto-swap)

Wires the `claude` adapter (`src/agent.ts`) to the account registry + selector
from node #290 (`src/claude-accounts.ts`), so JARVIS's Claude workers auto-route
across more than one Claude subscription. Built on branch `hopper/multi-claude`.

## What changed

1. **`src/agent.ts` — `runClaude()` env injection.** After `envOverrides` (which
   still `delete env['ANTHROPIC_API_KEY']` — NO API KEYS), for the `claude`
   adapter only we resolve the active account and, **when its `config_dir` is
   non-null**, set `env['CLAUDE_CONFIG_DIR']` to it before spawn. The default
   account `'a'` has `config_dir: null`, so a single-subscription setup leaves the
   env **completely untouched → byte-identical** to before this feature.
   - The caller (`runConversationTurn`) resolves the account **once per turn** and
     passes it via the runtime (`runtime.claudeAccount`) so the resume-vs-fresh
     decision and the actual spawn agree on the same account. One-shot callers
     (briefings, etc.) that don't pass an account get a fresh least-used pick
     inside `runClaude` via `selectActiveClaudeAccount(claudeFiveHourCeiling())`.
   - The chosen account is exposed on the result (`ClaudeResult.accountKey`) and
     logged (`[agent] claude run routed to account '<key>' (CLAUDE_CONFIG_DIR=…)`)
     **only when a non-default account is used**, so the governor/monitor can see
     which subscription burned the work and the single-account path stays quiet.

2. **`src/claude-accounts.ts` — `claudeFiveHourCeiling()`.** New exported helper
   mirroring the governor's private `fiveHourCeiling()` (settings-KV
   `gov_5h_ceiling` → env `HOPPER_GOV_5H_CEILING` → default 90), read uncached so
   a cockpit PATCH applies on the next spawn. Kept here (not imported from
   `hopper-governor`) to avoid a cross-module dependency.

3. **`src/conversation-db.ts` — `session_account` column** on `conversations` (+
   `ConversationRow.session_account`), plus `updateSessionState()` gains an
   optional 4th arg `accountKey`. Omitting it (the existing clone/fork/checkin
   callers) leaves `session_account` untouched → byte-identical; passing it (the
   agent turn loop) records which account the live session lives under.

## SESSION CAVEAT — per-account session isolation (the v0 rule)

Claude sessions are **provider- and account-scoped**: a `--resume <id>` only
resolves inside the `CLAUDE_CONFIG_DIR` the session was created under (verified in
RECON §6 — a fresh config dir has no knowledge of another dir's sessions). So a
resume id from account **A** cannot be resumed under account **B**.

**v0 rule (implemented):** when a thread's active account **changes between
turns**, we **drop the stale resume id and start a FRESH claude session** for that
thread rather than erroring. Concretely, in `runConversationTurn`:

```
if (adapter.id === 'claude') {
  activeClaudeAccount = selectActiveClaudeAccount(claudeFiveHourCeiling()).account;
  if (sessionId && conv.session_account
        && activeClaudeAccount
        && conv.session_account !== activeClaudeAccount.key) {
    sessionId = null;   // fresh session; context is rebuilt from transcript
  }
}
```

This mirrors the existing provider-change drop (`session_adapter !==
adapter.id`). Notes:

- **`session_account` null (legacy/unknown/non-Claude) is treated as "no forced
  drop"** — same shape as the adapter check — so old rows and clone/fork threads
  behave exactly as today. If such a thread's stored session happens to belong to
  a different account, the resume simply returns empty and the **existing**
  expired-session retry (`if (sessionId && !result.text && !result.sessionId)`)
  starts fresh — self-healing, never an error.
- The account is stamped into `session_account` only when a **new** session id is
  produced (`result.accountKey`), which is exactly when we start fresh — including
  right after an account change — so the record is always correct going forward.
- Context is not lost on a drop: `buildContinuationPrompt()` replays the
  transcript into the fresh session (same mechanism as a provider switch).

## Non-regression

- `codex` / `auggie` / `devin` adapters are untouched: the account block is gated
  on `adapter.id === 'claude'`; for them `accountKey` stays null, no env change,
  and `session_account` is written null (harmless — nothing reads it for them).
- Single-account default: `CLAUDE_CONFIG_DIR` never set, `ANTHROPIC_API_KEY` still
  deleted — proven byte-identical by test case 1.

## Verification

`npm run build` (clean; the one pre-existing `webhook.ts` TS2742 express-types
error is unrelated and on an unmodified file) +

- `npm run claude-accounts:test` — node #290 selector suite still green (6/6).
- `npm run claude-adapter-account:test` — **new** wiring suite (4/4), drives the
  REAL `runClaude()` with a fake `CLAUDE_BIN` that echoes its spawned env:
  1. single-account default → `CLAUDE_CONFIG_DIR` NOT injected, `ANTHROPIC_API_KEY`
     deleted, `accountKey='a'`;
  2. two accounts → least-used account's `config_dir` injected, `accountKey` matches;
  3. swap → once B crosses the 5h ceiling, A is selected + A's `config_dir` injected;
  4. `claudeFiveHourCeiling()` honors settings-KV > env > default(90).
