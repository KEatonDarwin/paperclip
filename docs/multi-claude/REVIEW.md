# Multi-Claude — Adversarial Review (node #296)

**Verdict: PASS (with fixes applied).** Branch `hopper/multi-claude`, reviewed at `21af8b493` + this node's fix commit. Deploy-ready after node #297 pushes.

Scope reviewed: every file in `git diff 5475798d5..HEAD` (7 src/script changes, 2 systemd units, 6 test scripts, docs). All findings verified by running code, not by reading docs.

## Checklist (from the node spec)

| Requirement | Result | Evidence |
|---|---|---|
| NO API KEYS preserved; `delete env['ANTHROPIC_API_KEY']` intact | ✅ PASS | `src/agent.ts:274` (claude) + `:404` (codex) unchanged. Account routing runs *after* `adapter.envOverrides(env)` and only ever **adds** `CLAUDE_CONFIG_DIR`. `claude-adapter-account:test` + `claude-session-account:test` spawn with `ANTHROPIC_API_KEY=sk-should-be-deleted` in the parent and assert the child never sees it. No SDK import anywhere on the branch. |
| Single-account behavior byte-identical | ✅ PASS | **Governor:** `evaluateClaudeLegacy()` body is a byte-for-byte lift of the old `-- Claude lane --` block (`diff` of the two = empty); the default registry (`[a]`, `config_dir=null`) is routed to it, verdict only gains additive `active_account`/`claude_accounts` fields. **Adapter:** implicit account `a` has `config_dir=null` → env untouched, no log line. **Session:** `updateSessionState` 3-arg callers unchanged (separate prepared stmt); `session_account` column is additive/nullable. **Rescue:** gated on `>1 enabled accounts` — single-account error path is the pre-existing one. Proven by `claude-session-account:test` #4 (turn 2 passes `--resume`, `CLAUDE_CONFIG_DIR` never set), `claude-ratelimit-rescue:test` #3, `governor-multiclaude:sim` legacy cases, e2e-sim scenario 1 (legacy detail string identical). |
| No secrets / cookie / credential files committed; no config dirs in repo | ✅ PASS | `git diff --name-only` has no `.credentials.json`, `claude-ai-session-cookie`, `.env`, or `.claude*` paths. Secret-pattern scan over the whole diff hits only the three `sk-should-be-deleted` test placeholders. Registry stores only the cookie **path**; poller reads the value at runtime from outside the repo (`~/.claude-<key>/`). `GET /claude-accounts` returns `config_dir`/`org_id` (paths + a public org UUID), never cookie contents; `POST` is admin-scoped. Setup script writes its per-account env file `0600` and never echoes the cookie. |
| Selector edge cases (all stale / all full / disabled) sane | ✅ PASS | `claude-accounts:test` (7): malformed/empty JSON → default `a`; all-disabled → `account=null`; dupes dropped; exclude never re-picked. Governor: all-stale → `usage_stale` + one-shot 🛑 bell; all ≥ ceiling → `claude_all_accounts_full` + one-shot ⛽ bell; hard-weekly parks → `weekly_ceiling`; zero enabled → holds. Selector's "so we still try" fallback is by design and the governor gates on `eligible`, not on the fallback pick. |
| No dispatch deadlock; no regression to codex/auggie/devin | ✅ PASS | `hopper_nodes` for `tree-44d2ff4a`: all 9 nodes `parent_id=NULL` (flat; deps via `depends_on`). Governor diff touches **only** the Claude lane — codex/auggie/devin `provider_ceiling` code untouched; `governor-multiclaude:sim` "non-claude adapter unaffected" passes. Adapter/session/rescue logic is all behind `adapter.id === 'claude'`. |
| Session-fresh-on-account-change actually implemented | ✅ PASS (now also **tested**) | Implemented in `runConversationTurn` (drops `sessionId` → `buildContinuationPrompt` path) + `session_account` stamped via `result.accountKey` on every fresh session. Previously **untested through the real turn path** — added `scripts/claude-session-account-test.mjs` (`npm run claude-session-account:test`) which drives `processMessage()` across three turns with a fake `claude` and asserts `--resume` presence + `session_account` per turn. |

## Findings + fixes applied in this node

1. **[FIXED — correctness/cost] Account ping-pong dropped the native session every turn.** `runConversationTurn` re-ran the least-used selector on *every* message. With two accounts close in usage (A 40% / B 41%), an interactive thread flipped accounts each turn, and the account-change rule then dropped the `--resume` session each time → full transcript replay on every message, which is exactly what native resume exists to avoid. Fix (`src/agent.ts`): a live session **sticks to its stored account while that account is still eligible** (enabled, metered, under the 5h ceiling); it only moves — with a fresh session — when the stored account genuinely can't serve. New threads (no session) still spread by least-used, so the parallel-throughput goal from DESIGN-ADDENDUM is unchanged. Covered by `claude-session-account:test` #2 (stick + resume) and #3 (real swap → fresh session, `session_account` re-stamped).
2. **[FIXED — ops] Per-account poller crash-looped on an empty `ORG_ID`.** Setup script + unit comments promise "degrades gracefully / no-op until logged in", but `claude-usage-poll-account.sh` used `${ORG_ID:?}` → exit 1 every 60s (timer instance sits `failed`) until the org id lands. Now: empty `ORG_ID` → one `logger` line + `exit 0`, same posture as a missing cookie.
3. **[FIXED — ops] `--env-dir` silently mismatched the template unit.** `claude-usage-poll@.service` hardcodes `EnvironmentFile=/home/kevin/.claude-accounts/%i.env` (systemd can't expand `$HOME`); a custom `--env-dir` produced an env file the unit never reads. Setup script now warns loudly when the two differ.

## Noted, not changed (non-blocking)

- `RATE_LIMIT_RE` is broad (`rate limit`, `too many requests`, `\b429\b`) but is only ever tested against a **failed run's error message**, never assistant text, and the rescue is capped at one swap per message; a false positive costs one retry on the other account, not a loop. The live headless usage-limit string is still unconfirmed (RECON §7) — the constant is the single tuning point.
- Selector + governor each re-read the registry (settings-KV) and the usage files per turn/tick. Cheap (one `stat` + small JSON per account), matches the existing governor's uncached-knob convention.
- `claudeFiveHourCeiling()` duplicates the governor's private `fiveHourCeiling()` (same KV/env/default) to avoid a cross-module import. Keep them in lockstep if the governor's changes.
- Pre-existing, unrelated: `tsc` reports one `TS2742` in `src/handlers/webhook.ts` on **both** the merge-base and this branch (worktree `node_modules` is a symlink to the live checkout → non-portable inferred type). Not introduced here; `dist/` still emits.

## Verification run (this node, fresh build of the worktree)

```
claude-accounts:test            7/7   ✅
claude-adapter-account:test     4/4   ✅
governor-multiclaude:sim       10/10  ✅
claude-ratelimit-rescue:test    3/3   ✅
claude-accounts-route:test      6/6   ✅
multi-claude:e2e-sim            5/5   ✅
claude-session-account:test     4/4   ✅  (new)
                               39/39
```

No live login, no jarvis.service restart, live checkout `/home/kevin/paperclip` untouched, all runs on scratch DBs + throwaway `CLAUDE_USAGE_DIR`.

## Deploy notes for JARVIS

- Merge `hopper/multi-claude` → live checkout, `tsc`, detached restart. Zero behavior change until `claude_accounts` is populated.
- To bring account B online: `claude auth login` under `CLAUDE_CONFIG_DIR=~/.claude-b`, drop its `sessionKey` cookie at `~/.claude-b/claude-ai-session-cookie` (0600), then `scripts/multi-claude-setup.sh --key b` (registers + installs `claude-usage-poll@b.timer`). Watch `GET /api/v1/claude-accounts` for `eligible:true` on `b`.
- Rollback = revert the merge; the `session_account` column is nullable and harmless if left behind.
