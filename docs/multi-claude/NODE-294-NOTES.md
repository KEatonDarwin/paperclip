# Multi-Claude — Node #294: rate-limit rescue (retry a walled turn on the next account)

The "continue on it" guarantee. When a Claude worker turn FAILS mid-flight with a
window-exhausted / usage-limit / rate-limit signal, the turn is re-run ONCE on the
next Claude account that still has headroom — **before** the node ever fails into
the hopper engine's model-tier escalation ladder. Built on `hopper/multi-claude`,
on top of nodes #290 (registry+selector), #291 (adapter⇄account), #292 (governor).

## Where the rescue lives — the TURN, not a separate node re-dispatch

A hopper worker's turn runs through `processMessage → runConversationTurn →
runClaude`, exactly like any JARVIS turn. Putting the rescue in
`runConversationTurn` means the wall is caught and continued **in-flight** — the
turn doesn't fail, so nothing downstream (node attempt count, escalation ladder)
is consumed. It also covers regular JARVIS turns for free. This is the literal
"turn that hits the wall mid-flight" the spec describes; the node-level account
rotation is already handled by node #291 (each turn re-picks the least-used
account, so a re-dispatched node naturally lands elsewhere once A is over ceiling).

## What changed

1. **`src/agent.ts` — `RATE_LIMIT_RE`** (next to `UNKNOWN_SESSION_RE` /
   `CONTEXT_OVERFLOW_RE`): matches the claude CLI usage-limit / rate-limit failure
   wording (documented + caveated in `docs/multi-claude/RECON.md §7`). It is only
   ever tested against a FAILED run's error message, never assistant text.

2. **`src/agent.ts` — rescue branch in `runConversationTurn`'s catch block**, a
   sibling to the existing DAR-756 context-overflow retry:
   - Gated on `adapter.id === 'claude' && RATE_LIMIT_RE.test(message) &&
     !accountSwapRetried && listClaudeAccounts().filter(enabled).length > 1`. The
     **`> 1` guard keeps the single-account path byte-identical** — a lone account
     never enters the branch, it falls to the unchanged default error handler.
   - `selectActiveClaudeAccount(ceiling, { exclude: <failed key> })` picks the
     next account. Rescue only fires onto an account with **real headroom** (an
     *eligible* entry, not a "so we still try" fallback) — otherwise all accounts
     are exhausted and the turn fails/holds as today.
   - On rescue: drop `sessionId` (per-account session isolation — node #291 rule),
     rebuild context with `buildContinuationPrompt`, point
     `runClaudeRuntime.claudeAccount` at the rescue account, re-run `runClaude`
     once. Success falls through to the normal result path, which stamps the new
     session under the rescue account's key via `updateSessionState`.
   - **Cap: one swap per turn** (`accountSwapRetried`) so a wall following us
     across accounts can't loop. If the rescue account also walls, or none has
     headroom, the partial is persisted and the error rethrown — the node fails
     and the hopper engine's model-tier ladder runs next.

3. **`src/claude-accounts.ts` — `selectActiveClaudeAccount(ceiling, opts?)`** gains
   an optional `{ exclude }` (new `SelectAccountOptions` interface). The excluded
   key is treated as ineligible AND dropped from the fallback pool, so a rescue
   can never return to the account that just failed. **Omitting `opts` is
   byte-identical** to the prior single-arg call (existing callers unchanged).

## Guardrails honored

- **NO API KEYS**: no key/SDK touched; `delete env['ANTHROPIC_API_KEY']` is
  untouched. The rescue only swaps `CLAUDE_CONFIG_DIR` (subscription auth).
- **Single-account byte-identical**: the `> 1 enabled` guard means a
  single-subscription setup never reaches the new code — a usage-limit error
  throws exactly as before (proven by rescue-test case 3).
- **No secrets committed**: no credential/cookie files touched.

## Verification

`npm run build` — clean (the one pre-existing `webhook.ts` TS2742 express-types
error is unrelated, on an unmodified file). Plus:

- `npm run claude-accounts:test` — 7/7 (added TEST 7: `exclude` picks the other
  account with headroom / returns null when none is left).
- `npm run claude-adapter-account:test` — 4/4 (node #291 non-regression, still green).
- `npm run claude-ratelimit-rescue:test` — **new**, 3/3, drives the REAL
  `processMessage`/`runConversationTurn` with a fake `claude` that walls on
  account A's config dir and succeeds on B's:
  1. A walls mid-flight → turn auto-continues on B, reply is B's (no error);
  2. A walls + only other account over ceiling → turn fails/holds as today;
  3. single account → no swap attempted, the usage-limit error just throws.
