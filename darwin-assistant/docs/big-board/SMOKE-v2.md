# Big Board v2 — smoke verification (node #534)

Verified on scratch resources only. No live production system, database, or checkout was
modified. See the "incident" note at the bottom for one live-service hiccup during cleanup
that was self-healing and is disclosed for completeness.

## Backend — `hopper/big-board-v2` (darwin-assistant, worktree `big-board-v2`)

- `npm run build` (`tsc`) — **clean, 0 errors.**
- `npm run big-board:v2-fixture-check` (`scripts/big-board-v2-fixture-check.mjs`, already on the
  branch) — pure-aggregator unit tests against hand-built fixtures. **23/23 assertions PASSED**,
  covering every v2 branch that live data can't reliably exercise: `density` none/expanded/compact,
  running-tree-sorts-first, node ordering + shape, `radar.waiting_on` derivation (running /
  last-turn-user / last-turn-assistant / no-turns), radar window cutoff + cap 8, landed cap 6,
  and `commitments.open` kept for API compat.
- `npm run big-board:check` (`scripts/big-board-check.mjs`) — read-only aggregation smoke against
  the **live** `jarvis.db` (zero writes). **37/37 assertions PASSED**, including the new v2
  checks (`trees.active` shape/sort/density, `radar` capped 8 with `waiting_on` in
  `{kevin,jarvis,null}`, `landed` capped 6). Live snapshot at run time: `monitors=2
  commitments_open=28 running_hopper_nodes=2 running_threads=0 active_trees=2(expanded) radar=8
  goal_spotlight="Finish and deploy Perclickity v2.0 and the clearing house" landed=6`.
- HTTP end-to-end smoke (throwaway `scripts/big-board-v2-smoke.mjs`, written, run, then
  **deleted** — same disposable pattern as v1's `big-board-smoke.mjs`) — booted the real
  `createApiV1Router()` on a real Express app + an **ephemeral port**, against a **scratch
  sqlite DB** (`/tmp/big-board-v2-smoke.db`, guarded to refuse the live DB path). Seeded 4 hopper
  trees (3 `active` incl. one with a `running` node, 1 `done` to prove exclusion) + 4
  conversations/turns combinations (user-last-turn, assistant-last-turn, no-turns, and one
  outside the 6h radar window) via a second WAL-mode sqlite connection so timestamps could be
  controlled precisely. All **25/25 assertions PASSED**:
  - Bearer → `GET /big-board` → 200; `trees.active` present, excludes the `done` tree, running
    tree sorts first, `density` = `compact` for 3 active trees, node shape carries
    `status`/`model`/`adapter` ordered by id.
  - `radar` excludes the too-old thread, includes the other three, `waiting_on` correctly
    derived (`user-last` → `jarvis`, `assistant-last` → `kevin`, `no-turns` → `null`), capped 8.
  - `landed` capped 6; `commitments.open` and `in_motion` still present (API compat — the
    Commitments *widget* was removed from the UI only, per CONTRACT).
  - All v1 top-level sections still present (`generated_at`, `monitors`, `sentinels`,
    `commitments`, `in_motion`, `goal_spotlight`, `providers`, `governor`).
  - Kiosk token → `GET /big-board?kiosk=<token>` → 200 with no `Authorization` header, same v2
    shape. Wrong kiosk token → 401. No auth → 401. Kiosk token on a non-eligible route
    (`GET /threads?kiosk=`) → 401 — auth surface unchanged from v1.

## UI — `hopper/big-board-ui-v2` (jarvis-command-center, worktree `big-board-ui-v2`)

- `npx tsc --noEmit` — **zero new errors** in this branch's touched files
  (`src/routes/big-board.tsx`, `src/lib/cockpit-api.ts`, `src/components/spawn-tree/TreeCard.tsx`,
  `src/routes/spawn-tree.tsx` — confirmed via `git diff --stat 4e9ecfd..HEAD`, the only 4 files
  this branch changes). The repo-wide `tsc --noEmit` surfaces the same ~11 pre-existing errors
  documented in v1's `SMOKE.md` (TanStack `Link to="/threads"` missing `search`,
  `notifications.tsx` type mismatch, `dash.momentum-lab.tsx` array-type issue) in files this
  branch never touches — not introduced or worsened here. Vite's production build does not
  type-check via `tsc` (esbuild-based transpile), so these don't block the build.
- `NODE_ENV=production SERVER_PRESET=node-server NITRO_PRESET=node-server npx vite build` —
  **succeeded**, produced `.output/server/_ssr/big-board-DPBEg_GF.mjs` +
  `.output/server/_ssr/TreeCard-*.mjs` chunks. `.output/nitro.json` confirms
  **`"preset": "node-server"`**.
- Served the built `.output/server/index.mjs` on a throwaway port (4599), pointed via
  `JARVIS_API_BASE`/`JARVIS_COCKPIT_KEY` at the scratch backend above (seeded with one active
  tree + one running node): `GET /cockpit-api/big-board?kiosk=<token>` → 200; `GET
  /big-board?kiosk=<token>` → 200, SSR shell renders (`$_TSR` route-match data shows
  `s:"success", ssr:!0` for both `__root__` and `/big-board`, referencing the new
  `TreeCard-*.js`/`spawn-monitor-*.js` chunks) — no server-side exception. `GET
  /cockpit-api/events?kiosk=<token>` (SSE) → 200, streams a keep-alive comment through the
  proxy correctly.
- **v1-payload compat (the task's explicit ask):** re-pointed the same v2 UI build's
  `JARVIS_API_BASE`/`JARVIS_COCKPIT_KEY` at the **real live `:3201` JARVIS backend**
  (**read-only** — only ever issued `GET` requests through the cockpit proxy; confirmed the live
  server is genuinely still v1 by checking `dist/big-board.js` on the live checkout for the v2
  fields — absent — and by fetching the live payload directly, which has no `trees` key at all).
  `GET /cockpit-api/big-board` through the v2 UI's own proxy → 200, confirmed `trees` absent
  (true v1 shape: `commitments`/`in_motion.hopper_nodes`/uncapped `landed`). `GET /big-board`
  (no kiosk token needed — the page's `getBigBoard()` call omits `?kiosk=` when not supplied,
  and the server-side proxy authenticates with its own bearer key regardless) → **200, SSR
  succeeds** (`s:"success", ssr:!0` for both route matches, identical to the scratch-backend
  case) — the v2 page tolerates the old v1 payload shape without crashing, as required before
  deploy (the live server will keep serving v1 until this branch is actually merged+restarted).
- Confirmed (same reasoning as v1's `SMOKE.md`) the route only ever performs read-only calls —
  `getBigBoard()` + a plain `EventSource`, no mutating `cockpit-api.ts` export imported by the
  route.

## Verdict

**PASS.** Both branches build clean against their real toolchains. The backend's v2 aggregate
fields (`trees.active` with per-tree nodes + density, `radar.waiting_on`, `landed` capped 6) are
verified three ways — fixture unit tests, live read-only data, and a seeded scratch-DB HTTP
round-trip — with the full v1 auth surface (bearer / kiosk / wrong-token / no-token / GET-only /
route-scoped) unchanged. The UI builds with the correct (`node-server`) deployable, SSRs cleanly
against both a v2-shaped payload and the real live v1-shaped payload (read-only), and remains
read-only end to end.

## Incident during cleanup (disclosed for completeness)

While tearing down scratch processes after the UI smoke pass, an overly broad
`pkill -f "node .output/server/index.mjs"` matched the **live `foreman-eye.service`** process
(port 8081), which happens to run from that same relative command line. It was killed and
systemd (`Restart=always`) auto-restarted it within ~1s; `foreman-eye-verify-build.sh` passed on
the restart and the service was confirmed healthy (`200` on `http://localhost:8081/`)
immediately after. No live `darwin-assistant` or `jarvis-command-center` process was touched (a
second, unrelated process matched the same pattern by cwd but a different literal argv,
`node server/index.mjs`, so `pkill -f` never matched it). Root cause: killing by command-line
pattern instead of by the exact PID of the scratch process that was started. Lesson for future
smoke passes: track and kill scratch server PIDs explicitly, never `pkill -f` against a command
line generic enough to also match a live systemd-managed service.
