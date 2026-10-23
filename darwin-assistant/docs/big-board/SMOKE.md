# Big Board — smoke verification (node #519)

Verified on scratch resources only. No live production system, database, or service was
touched or restarted.

## Backend — `hopper/big-board` (darwin-assistant)

- `npm run build` (`tsc`) — **clean, 0 errors.**
- `npm run big-board:check` (`scripts/big-board-check.mjs`) — read-only aggregation smoke
  against the **live** `jarvis.db` (the script performs zero writes of its own; see its header
  comment for why this is the deliberate exception to the scratch-DB convention). **27/27
  assertions PASSED**, including the ephemeral/checkin/hopper-node-worker exclusion check
  across 35 real threads (0 leaks). Live snapshot at run time: `monitors=2 commitments_open=27
  running_hopper_nodes=2 running_threads=0 radar=35 goal_spotlight="Monitoring on every part of
  Hub 1.0 so we never waste money on leads again" landed=8`.
- HTTP end-to-end smoke — booted the real `createApiV1Router()` (same code the live server
  mounts) on a real Express app + an **ephemeral port**, against a **scratch sqlite DB**
  (`/tmp/big-board-smoke.db`, guarded to refuse the live DB path, same pattern as
  `scripts/persona-mcp-sim.ts`/`scripts/goals-sim.ts`). Minted an admin bearer key via the real
  `mintApiKey()` and seeded `big_board_kiosk_token` via the real `setSetting()`. All 20
  assertions **PASSED**:
  - Bearer auth → `GET /big-board` → 200, all 10 CONTRACT Part 1 top-level sections present.
  - Kiosk token → `GET /big-board?kiosk=<token>` → 200 with no `Authorization` header.
  - Kiosk token → `GET /events?kiosk=<token>` → 200 (SSE stream accepted).
  - Kiosk token on a **non-eligible** route (`GET /threads?kiosk=<token>`) → 401 — confirms
    kiosk auth is scoped to exactly `{/big-board, /events}` per CONTRACT Part 3, not a generic
    bearer replacement.
  - Kiosk token on a **mutating** route (`POST /big-board/kiosk-token?kiosk=<token>`) → 401 —
    confirms kiosk auth is GET-only.
  - Wrong/unknown kiosk token → 401 (fails closed).
  - No auth at all → 401.
  - Admin bearer → `POST /big-board/kiosk-token` → 201, returns a token prefixed `bb_`.

  The throwaway script was written to `scripts/big-board-smoke.mjs`, run, then **deleted**
  along with its scratch DB files — it was a verification tool, not a permanent addition to the
  repo (mirrors the ad-hoc nature of a one-off HTTP smoke pass; the durable, repo-committed
  check is `big-board:check` above, which already covers the pure-aggregator contract shape).

## UI — `hopper/big-board-ui` (cockpit / jarvis-command-center)

- `npx tsc --noEmit` — **zero new errors** from this build's two touched files
  (`src/routes/big-board.tsx`, `src/lib/cockpit-api.ts`). The repo-wide `tsc --noEmit` run
  surfaces ~10 pre-existing errors (TanStack `Link to="/threads"` missing `search`, a
  `notifications.tsx` type mismatch, a `dash.momentum-lab.tsx` array-type issue) — verified
  these predate this work by diffing against parent commit `b91733e` (same errors present) and
  tracing `notifications.tsx`'s error to commit `d53e9c9`, long before this branch. Vite's
  production build does not type-check via `tsc` (esbuild-based transpile), so these
  pre-existing errors do not block the build; not introduced or touched by this work.
- `NODE_ENV=production SERVER_PRESET=node-server NITRO_PRESET=node-server npx vite build` —
  **succeeded** (mirrors `jarvis-cockpit-deploy.sh do_build`, since `bun` was on PATH the repo's
  own `bun run build` script resolves identically; ran via `npx vite build` directly to pin the
  exact command). `.output/nitro.json` confirms **`"preset": "node-server"`** (the exact signal
  `jarvis-cockpit-verify-build.sh` checks before ever promoting a build). Produced
  `.output/server/_ssr/big-board-2fxi7xSu.mjs`.
- Confirmed the `/big-board` route only ever performs **read-only** calls: `big-board.tsx`
  imports exactly one function from `cockpit-api.ts` — `getBigBoard()` — which calls the
  shared `req()` helper with no `init.method` override, so `fetch` defaults to `GET`; the
  live-ticker uses a plain `EventSource` (`GET`-only by spec). No other `cockpit-api.ts` export
  is imported by the route, so none of the module's `POST`/`PATCH`/`PUT`/`DELETE` helpers
  (visible in the built bundle only because `cockpit-api.ts` is a single shared chunk used by
  every route) are reachable from this page.

## Verdict

**PASS.** Both branches build clean against their real toolchains, the backend's
read-only aggregator is verified against live data with zero leakage of ephemeral/worker
threads, the full auth surface (bearer / kiosk / wrong-token / no-token / GET-only /
route-scoped) behaves exactly per `CONTRACT.md` Part 3, and the UI is confirmed read-only with
the correct deployable (`node-server`) preset. No live service, database, or checkout was
touched at any point in this verification pass.
