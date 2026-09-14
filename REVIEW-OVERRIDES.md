# Adversarial review — governor manual per-provider overrides (node #195, 2026-09-14)

**Verdict: PASS with two fixes applied (both committed on this branch + the UI branch).**
I would let this govern Kevin's real budget tomorrow.

Scope reviewed: `hopper/gov-overrides` (commits `c2358e5e7` build, `c0464f2d4` sim)
and `hopper/gov-overrides-ui` (commit `ca34802`).

## What was attacked, and what I found

| # | Attack | Result |
|---|--------|--------|
| 1 | **`auto` path drift vs. pre-change `governorCheck`.** Loaded the live checkout's `dist/hopper-governor.js` (source byte-identical to base `6b94550f0`) and this worktree's build against the *same* scratch DB + usage files; compared verdicts across a 48-state matrix (5h ∈ {10,55,95} × weekly ∈ {5,35} × kevin-active ∈ {0,1} × codex ∈ {5,95} × auggie ∈ {5,90}) for all 4 providers + `governorStatus()`. | **Identical** minus the new `override:'auto'` field — 0 drift. Sanity holds confirmed (five_hour_ceiling / kevin_active / provider_ceiling all still fire). |
| 2 | **`on` reachable accidentally?** Committed `overrideSetting()` used `getGovernorSetting()` (env fallback `GOV_OVERRIDE_<P>`) + `.toLowerCase()`. | **REAL HOLE — FIXED.** On the committed build, a stray env var `GOV_OVERRIDE_CLAUDE=on`, or KV `"ON"`/`"On"`/`"on "`/`" on"`/`"Off"`/`"off\n"`, all produced `override_on`/`override_off` while the panel (which reads KV-only, exact) showed **Auto** — 13/22 harness checks failed. Fix: `overrideSetting()` now reads `getSetting('gov_override_<p>')` directly — no env fallback, no trim, no case-folding; only the exact literals `on`/`off` count, everything else is `auto`. Route validation was already strict (`typeof === 'string' && values.includes(value)`, admin-scoped) and no other write path into settings-KV exists (grepped every `setSetting(` call). |
| 3 | **`off` silently freezing a tree?** `scripts/jarvis-watchdog.py` `sentinel_hopper_stall` reads `GET /hopper-engine/governor` top-level `reason` and only suppresses on `kevin_active`. | A tree held by `gov_override_claude=off` bells red after `HOPPER_STALL_MIN` with `Governor: reason=override_off — gov_override_claude=off — manual override holds…`. Not silent. *Pre-existing limitation, not a regression:* the sentinel only reads the claude (top-level) verdict, so a codex-only tree held by `gov_override_codex=off` still bells but with the generic "Governor: allowing — suspect the engine itself" wording. Worth a follow-up: have the sentinel consult `providers[]` for the tree's actual adapters. |
| 4 | **Route validation + auth.** | `PATCH /hopper-engine/settings` is behind the same bearer middleware as the rest of the panel and additionally `isAdminScope`-gated; enum keys validated exactly; invalid → 400 and nothing persisted (sim check 4/4b). `GET` is read-only, bearer-gated like every other panel read. On success it calls `dispatchTick('governor_settings_changed')`, so `off→auto` resumes dispatch immediately. |
| 5 | **UI desync / stale cache.** | The three-state control has **no local optimistic state**: `OverrideRow.value` is derived from `settings.raw[key]`, and `commit()` only calls `setSettings()` from the *server's response*; on failure it toasts + rethrows and leaves `settings` untouched → the control cannot drift from server state after a failed save. Small fix applied: the panel now normalizes exactly like the governor (`raw === 'on' \|\| raw === 'off' ? raw : 'auto'`) so a hand-edited KV variant shows **Auto** instead of no-button-selected. Usage-widget pills read `providers[].override` from the real `/hopper-engine/governor` on the existing 5-min usage poll (+ the manual refresh button); a failed governor fetch leaves the last-known pills (same posture as the usage bars). That's poll latency, not a stale cache. |
| 6 | **Re-run sims, tsc/lint both repos.** | `scripts/gov-overrides-sim.mjs` 12/12 on the fixed build. New `scripts/gov-overrides-review.mjs` 22/22 (base-vs-new drift + footguns). Backend `tsc -p .` clean (no eslint config in this repo). UI: `tsc --noEmit` 10 errors at base and 10 at HEAD, **none in the changed files** (pre-existing TanStack `Link search` typing + `Notification.actions`); `eslint` **0 findings on any changed line** (the ~430 reported are pre-existing prettier noise in `threads.tsx`/`cockpit-api.ts`); `vite build` (node-server preset) exit 0. |

## Fixes committed by this review
- `darwin-assistant/src/hopper-governor.ts` — `overrideSetting()` KV-only, exact-match (see #2).
- `darwin-assistant/scripts/gov-overrides-review.mjs` — re-runnable drift/footgun harness.
- UI `src/routes/settings.governor.tsx` — exact-match normalization of the rendered override state (see #5).

## Notes for node #196 (DOCS + PUSH)
- `docs/hopper/GOVERNOR-V2-CONTRACT.md` has **zero** mention of `gov_override_*` — add the four keys to the Settings-KV schema table (enum `auto|on|off`, default `auto`, KV-only/no env fallback, exact-match semantics, evaluated *before* `HOPPER_GOV_ENABLED` and every gate) and the two new reasons `override_on` / `override_off`.
- Semantics to document: `on` bypasses kevin_active **and** all ceilings **and** usage-staleness (it is a true manual "go" — Kevin is accepting the meter risk); `off` holds new claims only, running workers are untouched; both are per-provider isolated.
