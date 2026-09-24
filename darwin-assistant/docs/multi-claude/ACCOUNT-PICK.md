# Per-thread Claude account pin (tree-b32ef869)

**Kevin's ask, verbatim (2026-09-24 13:23 CT):** "I'd really like the ability to say
'which claude' that I want to select if I go up to the model dropdown at the top
of the chat screen and select a model. It's going to come in handy big time
right now because Claude B is about to have it's 5 hour reset, and then all of
it reset in 2 hours so I can burn ALOT of tokens right now basically for free.
And I want to make sure I'm focusing on that one specifically."

This builds directly on multi-claude (tree-44d2ff4a — two registered
subscriptions, `a` and `b`, least-used auto-selection by default). Read that
first if you haven't: `src/claude-accounts.ts`, the `claude_accounts`
settings-KV registry, and the per-account usage pollers
(`/tmp/claude-usage-live.json` / `/tmp/claude-usage-b-live.json`).

## What's new

1. **A per-thread pin.** `conversations.pinned_claude_account` — a
   `claude_accounts` registry key (`'a'`, `'b'`, …), or `null` for Auto. Set via
   the model dropdown's new "Acct:" picker, or directly via
   `PATCH /threads/:ext/model { "claude_account": "b" }`.
2. **A long-standing selector bug fixed.** `selectActiveClaudeAccount` used to
   look ONLY at the 5-hour window. An account whose WEEKLY window was spent
   (100%), or one Claude itself reports locked (`locked_reason` in the usage
   payload), still read as "eligible" and could win the least-used pick — routing
   turns at a subscription that could not actually serve them. Both now make an
   account ineligible for **auto** selection. An explicit pin still overrides
   this (see precedence below) — that's Kevin's call, not the selector's.

## Precedence, one function

`decideClaudeAccountForTurn` in `src/claude-accounts.ts` is the single pure
function that resolves "which account does this turn run on, and do we have to
drop the native session to get there." `src/agent.ts`'s `runConversationTurn`
is the only caller. With `pinnedKey: null` it is byte-identical to the
pre-pin behavior (this was verified in the sim, scenario e-regression).

**Pin > session stickiness > least-used.**

- **Pin wins even over the 5h ceiling.** The ceiling paces *unattended*
  workers; a pin is a human instruction on a human's own turn. The hopper
  governor is untouched by this — worker dispatch still gates on the ceiling
  exactly as before. This is precisely the case Kevin's ask describes: Claude B
  reset and he wants to deliberately burn it down even while it's climbing back
  toward the ceiling.
- **Pin wins over session stickiness.** A live `claude --resume` session
  normally stays on the account it was created under (avoids re-playing the
  whole transcript). A pin can force a move anyway — because otherwise a
  thread with a live session could never be redirected to the other
  subscription. Moving accounts always means dropping the session (`--resume`
  ids only resolve inside their own `CLAUDE_CONFIG_DIR`); a fresh native
  session is started and JARVIS's own conversation context rebuilds it, per the
  existing multi-claude account-swap contract.
- **An unknown or disabled pin is IGNORED, never a hard failure.** If the
  pinned key isn't in the registry, or the account has been disabled, the
  normal auto-selection applies and it's logged
  (`pinIgnoredReason: 'unknown_account' | 'disabled'`). A stale pin must never
  break a turn.
- **The mid-turn rate-limit RESCUE still overrides a pin, for that turn only.**
  If a pinned account hits a live 429/usage wall mid-turn, the existing rescue
  logic (node #296-era) swaps to the other account to finish the turn rather
  than failing it. The pin itself is **not cleared** — the next turn goes back
  to the pinned account. This is logged loudly (`... this OVERRIDES the
  thread's pin ... for this turn only`) rather than silently, since it's the
  one case where the pin doesn't get the last word.

## API contract

`PATCH /threads/:external_id/model`

```jsonc
// Pin only — leaves any existing model override untouched.
{ "claude_account": "b" }

// Pin + change model in the same call.
{ "adapter": "claude", "model": "claude-opus-5", "claude_account": "b" }

// Clear the pin, keep Auto.
{ "claude_account": null }

// Clearing the adapter override clears the pin too (the pin only means
// anything under the claude adapter — leaving it behind on a thread that
// went back to a non-claude/inherited adapter would silently re-apply the
// moment that thread resolved back to claude).
{ "adapter": null }
```

- `claude_account` must be a key `findClaudeAccount()` recognizes, or `null`.
  An unrecognized key (or a non-string) is a `400` and **nothing is applied** —
  validated before any write, so a bad key never half-applies alongside a
  model change.
- Sending `claude_account` with **no** `adapter` field touches *only* the pin.
  This matters: before this fix, the account picker had to resend the
  thread's current model to change the pin, which silently converted a thread
  that was inheriting the global default model into one carrying an explicit
  per-thread override — a side effect of picking a subscription nobody asked
  for. Now the two are independent, and a pin survives a later model change
  within the claude adapter.

`threadDescriptor` gained `claude_account: string | null` (the raw pin, or
`null` for Auto) — independent of `model_override`.

`GET /claude-accounts` (pre-existing from node #293) gained `locked_reason` per
account, so the picker can show *why* an account is greyed out rather than
just that it is.

## Schema

```sql
ALTER TABLE conversations ADD COLUMN pinned_claude_account TEXT;
```

Additive, nullable, same migration style as every other `conversations`
column (`session_account`, `thread_adapter`, …) — safe on a live DB, no
backfill needed (`NULL` = Auto = the pre-existing behavior).

## Adding a third account

Nothing here is 2-account-specific. Register a new key in the
`claude_accounts` settings-KV (see the multi-claude docs for the registration
shape — `key`, `label`, `config_dir`, `enabled`), point its usage poller at a
new `/tmp/claude-usage-<key>-live.json`, and it appears automatically in
`GET /claude-accounts`, the dropdown, and the pin's set of valid values
(`findClaudeAccount` reads the live registry, nothing is hardcoded to `a`/`b`).

## Verification

- `npm run claude-account-pin:test` — 23/23 (unit: `decideClaudeAccountForTurn`
  precedence table + real-HTTP PATCH/`threadDescriptor`/`GET /claude-accounts`
  round trips).
- `npm run claude-account-pin:sim` — 14/14 (end-to-end: real `runClaude` spawns,
  session-drop/keep behavior, weekly-ineligibility, pin-overrides-weekly-spent,
  the account-only-PATCH-doesn't-create-a-model-override fix).
- Regression, unaffected: `npm run multi-claude:e2e-sim` (5/5),
  `npm run claude-accounts-route:test` (6/6, the account-registry route this
  reuses rather than duplicates).
- `npm run build` — clean.

## Review notes (node #701)

Adversarial review found and fixed two things on-branch before this landed:

1. **(real, user-visible)** The picker resending the current model as a side
   effect of pinning → fixed with the account-only PATCH path above (backend
   `d16b2607d`, UI `bb58df2`). Covered by new sim scenarios g5/g6.
2. **(clarity)** The mid-turn rescue silently overriding a pin was judged
   correct behavior but was undocumented — now called out explicitly in both
   the code comment and the log line (see "Precedence" above).

Full verdict: **PASS**. Both branches pushed and deploy-ready.

## Deploy list (for JARVIS)

1. Merge `hopper/claude-account-pick` (darwin-assistant) — adds the
   `pinned_claude_account` column, `decideClaudeAccountForTurn`,
   `findClaudeAccount`, the weekly/`locked_reason` selector gate, and the
   `PATCH /threads/:ext/model` + `GET /claude-accounts` changes.
2. Merge `hopper/claude-account-pick-ui` (jarvis-command-center) — the "Acct:"
   dropdown (`ClaudeAccountPicker.tsx`) wired into the model picker in
   `threads.tsx`, plus the `cockpit-api.ts` client additions
   (`ClaudeAccountInfo`, `getClaudeAccounts`, `setThreadModel`'s
   `claude_account` param).
3. `tsc` (both repos) — clean on this branch tip.
4. Run the checks above (`claude-account-pin:test`,
   `claude-account-pin:sim`, plus the two regression suites) against the
   merged tree.
5. Cockpit deploy via `jarvis-cockpit-deploy.sh` (never a bare `bun run
   build`).
6. Idle-gated backend restart (`scripts/jarvis-idle-restart.sh` as a
   **transient systemd unit**, never `nohup`/`&` from inside a live turn — see
   the 2026-09-20 restart-that-never-fired lesson in JARVIS memory).
7. Verify: a fresh thread's `GET /threads/:ext` shows `claude_account: null`;
   `PATCH { "claude_account": "b" }` pins it and the dropdown shows "Acct: B";
   `GET /claude-accounts` returns `locked_reason` per account.

No data migration, no backfill, no config change required — this is
additive-only and defaults to exactly today's behavior for every thread that
never sets a pin.
