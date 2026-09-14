# SIM-RESULTS — governor manual override toggles (node #194, tree-72a37228)

Tests the manual per-provider governor override (`auto` / `on` / `off`) end to
end through the **real HTTP API**, not just the module-level governor
functions — proving the settings route, the `/hopper-engine/governor` verdict
shape, and the override precedence in `hopper-governor.ts` all agree.

## Method

`darwin-assistant/scripts/gov-overrides-sim.mjs` (new, committed alongside
this file):

1. Builds via `tsc` (clean, 0 errors) then imports the compiled
   `dist/ui-server.js` / `dist/api-keys.js` / `dist/conversation-db.js`.
2. Starts the **real** `startUiServer()` (mounts the real
   `createApiV1Router()`, i.e. the actual `GET/PATCH /api/v1/hopper-engine/*`
   routes) on a **scratch port** (`39217`), against a **scratch copy** of
   `jarvis.db` (`JARVIS_DB_PATH=/tmp/gov-overrides-sim.db`, guarded — the
   script refuses to run if pointed at the live DB path).
3. Points `CLAUDE_USAGE_FILE` / `CODEX_USAGE_FILE` / `AUGGIE_USAGE_FILE` at
   scratch JSON files it controls directly.
4. Sets `DATABASE_URL` to an unreachable loopback address as a defensive
   belt-and-suspenders measure — `pg.Pool` connects lazily and none of the
   routes under test touch Postgres, but this guarantees a stray `query()`
   call would fail loudly instead of silently reaching real infra.
5. Deletes `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` from the env and never calls
   `slackApp.start()` — only `startUiServer()` is invoked, so no live Slack
   connection is possible regardless of what's in the real `.env`.
6. Mints a real admin-scope API key against the scratch DB via `mintApiKey()`
   and drives the server with `fetch()` + `Authorization: Bearer <key>`,
   exactly as a real cockpit caller would.
7. Cleans up its own scratch temp dir on exit; the scratch DB file is left
   for post-run inspection and removed by hand afterward (never the live
   `jarvis.db`, never the live port `3201`).

Run:

```
cd darwin-assistant
npx tsc                                                   # 0 errors
JARVIS_DB_PATH=/tmp/gov-overrides-sim.db node scripts/gov-overrides-sim.mjs
```

## Real output (final run)

```
[gov-overrides-sim] scratch DB: /tmp/gov-overrides-sim.db
[gov-overrides-sim] scratch root: /tmp/gov-overrides-sim-qwEcIH
[gov-overrides-sim] scratch port: 39217
JARVIS Observability UI: http://localhost:39217
PASS 1 - default state: all four providers report override 'auto' and allow under normal usage
PASS 2a - PATCH gov_override_claude=off succeeds and echoes raw state
PASS 2b - claude reports allow=false reason=override_off while codex is unaffected
PASS 2c - adapter-scoped query (?adapter=claude) also reflects the override at top level
PASS 3a-setup - reset gov_override_claude=auto to observe the true gate before re-applying on
PASS 3a - sanity: with override=auto, kevin-active + 5h=95% genuinely holds (five_hour_ceiling, before kevin_active check)
PASS 3b - PATCH gov_override_claude=on succeeds
PASS 3c - claude reports allow=true reason=override_on despite kevin-active + 95% 5h usage (bypasses both gates)
PASS 4 - PATCH with an invalid override value (not auto/on/off) is rejected with 400
PASS 4b - rejected value was not persisted — gov_override_codex remains unset/auto
PASS 5a - PATCH gov_override_claude=auto succeeds
PASS 5b - claude returns to normal allow=true reason=ok under low usage once override is auto again
[gov-overrides-sim] 12/12 checks passed
```

(Full log also saved at `/tmp/gov-overrides-final-run.log` on the box.)

## Coverage vs. the task spec

1. **Default state** (check 1) — `GET /hopper-engine/governor` reports
   `override:'auto'` for all four providers (claude/codex/auggie/devin), and
   under normal low-usage conditions each is `allow:true, reason:'ok'` —
   matching today's pre-override behavior exactly.
2. **`gov_override_claude=off`** (checks 2a–2c) — `PATCH
   /hopper-engine/settings` accepts it and echoes it back in `raw`; the
   subsequent `GET /hopper-engine/governor` shows claude
   `allow:false, reason:'override_off'`, while codex stays
   `override:'auto', allow:true, reason:'ok'` — proves per-provider
   isolation, not a global kill switch. Also checked the `?adapter=claude`
   scoped query form (the shape `dispatchTick` actually consults) reflects
   the same verdict at the top level.
3. **`gov_override_claude=on` bypasses BOTH gates** (checks 3a–3c) — first
   proved the *un-overridden* gate genuinely holds under kevin-active +
   5h=95% (with override reset to `auto`, verdict is
   `allow:false, reason:'five_hour_ceiling'` — confirms the test scenario is
   real, not vacuous). Then set `gov_override_claude=on` and re-checked:
   `allow:true, reason:'override_on'` despite the simulated Kevin-active
   turn AND 95% five-hour utilization — proves the override short-circuits
   `evaluate()` before either the ceiling check or the kevin-active check
   runs (matches `hopper-governor.ts` line ~296: override branch is first).
4. **Invalid value rejected** (checks 4, 4b) — `PATCH
   {gov_override_codex:'maybe'}` returns `400 invalid_setting` with the
   correct `error.code`/`error.message` shape, and a follow-up `GET
   /hopper-engine/settings` confirms the bad value was never persisted
   (`gov_override_codex` stays unset, not `'maybe'`).
5. **Back to `auto` restores original behavior** (checks 5a, 5b) — `PATCH
   gov_override_claude=auto` succeeds, and a subsequent low-usage,
   non-active check returns to `allow:true, reason:'ok'`, `override:'auto'`
   — full round trip proven.

## Result

**12/12 checks passed.** No live system, live DB, live port, or live Slack
connection was touched. No lingering processes after the run (script exits
via `process.exit()`, which tears down its own `http.Server`).
