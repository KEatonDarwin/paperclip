# Big Board — adversarial review (tree-fead1551, node #520)

**Verdict: PASS-with-fixes.** Both branches implement `CONTRACT.md` and the approved mockup
faithfully; the security gate holds (with one tightening applied); the fixes below were
small enough to land on-branch and are committed. Two items are Kevin-level decisions at
deploy time, not defects.

Reviewed: `hopper/big-board` (darwin-assistant, `a8bd9f2da` + `c0d6c8ffb`) and
`hopper/big-board-ui` (cockpit, `f11427c`). Fixes committed as `048362535` (backend) and
`5724635` + `3a49499` (UI).

## Hunt results

| Hunt item | Result |
|---|---|
| Kiosk token leaking privileges beyond the read-only surface | **Tightened.** The token could only ever reach `GET /big-board` + `GET /events` (verified: case variant, trailing slash, array param, HEAD, non-eligible route, mutating route all 401). BUT `/events` forwarded the full admin FORWARD set to the kiosk credential — `turn` + `stream_delta` = every assistant reply in real time, including password-locked threads. Fixed: the kiosk credential now receives only the CONTRACT Part 2 ticker types (`BIG_BOARD_KIOSK_EVENT_TYPES`); bearer callers unchanged. Verified on a scratch DB (kiosk sees `notification`/`hopper_node`, never `turn`/`stream_delta`). |
| `JARVIS_COCKPIT_KEY` in a URL or client bundle | **Clean.** The 52-char key value is absent from `.output/public`. The only string match is the pre-existing help text in `threads.tsx`. No route puts a bearer in a URL. |
| Mutating calls from the board | **Clean.** `big-board.tsx` imports exactly `getBigBoard()` (GET) + a native `EventSource` (GET). No POST/PATCH/DELETE reachable from the page. |
| Missing heartbeat / empty store crashes | **Fixed one.** Empty scratch store → `/big-board` 200 with all sections (verified). Missing heartbeat file → previously an empty sentinel grid (read as "nothing to worry about"); now the fixed 5 names, all red. Never throws. |
| SSE reconnect gaps | **Fixed.** `EventSource` only auto-retries a *dropped* connection; a non-200 reply — exactly what the cockpit proxy returns (502 JSON) while `jarvis.service` restarts on any deploy — permanently CLOSES it. On a 24/7 kiosk that meant a dead ticker and a lying "LIVE · SSE" pip until the 4am reload. Now: re-create on CLOSED with 5s→60s backoff, refetch the snapshot on (re)open, pip reads LIVE · SSE / LIVE · POLLING / RECONNECTING truthfully. (The 60s poll backstop was already correct; the ticker + pip were the gap.) |
| Payload drift vs CONTRACT | **None material.** All 10 sections present with the contracted shapes. Two documented gaps: `claude_account` is always `null` (no per-node account stamp is persisted — contract says best-effort; the mockup's "account B" text will not appear until the engine stamps it), and `commitments` carries only `open` (the zone table also mentions "a few most-recent resolved" — those land in the Landed card instead, so nothing is lost). |
| Visual drift vs mockup | **Two fixes.** (1) Live registry has 26 open commitments; the uncapped card starved the Monitors card of height → capped at 6 rows, breached first, soonest-due, "+N more open", `#id` shown as in the mockup. (2) Radar summaries are paragraphs → one-line teaser with ellipsis. Otherwise a faithful port (same CSS vars, grid, sizes, header, ticker). Intentional: date line says "Local" not "CT"; ticker not duplicated for a seamless loop. |
| NO-API-KEYS | **Clean.** No provider SDK, no `*_API_KEY`, no model calls at all — pure aggregation. |
| SSR | **Fixed.** `window.location.search` at render time threw `ReferenceError: window is not defined` on every server render (blank first paint, client recovered after hydration). Guarded like the sibling routes; SSR now paints the shell. Verified on a scratch port. |
| Privacy of what the TV shows | **Tightened.** Radar/in-motion now exclude password-locked threads (an office TV must never display a title/summary Kevin explicitly locked — 1 such thread exists live) and archived threads (7 of the top-35 were archived). |
| Perf | **Trimmed.** `gather` queried nodes for all 88 trees per refetch; now only non-terminal trees (1 live). |

## Kevin-level items (deploy-time decisions, not defects)

1. **The `?kiosk=` gate is only enforced on direct `:3201` access.** The TV will load the
   page from the cockpit (`:8080/big-board?kiosk=…`), and the cockpit's server-side proxy
   attaches the admin `JARVIS_COCKPIT_KEY` to every `/cockpit-api/*` call regardless of the
   kiosk param. So on the actual TV path the board — like every other cockpit page — is
   gated by nothing but LAN reachability of `:8080`. This is the cockpit's pre-existing
   posture, not something this build introduced, and the kiosk token still does its job the
   moment anything hits the API directly. Fine for a TV on Kevin's own LAN; if `:8080` is
   ever exposed off-LAN, the fix is auth on the cockpit itself, not on this board.
2. **Kiosk token plaintext in settings-KV** (`big_board_kiosk_token`) — per contract, admin-
   readable only. Mint via `POST /api/v1/big-board/kiosk-token` with the cockpit key; re-mint
   revokes the old one.

## Verification run for this review

- Backend: `npm run build` clean; `npm run big-board:check` 30/30 (3 new assertions:
  locked/archived exclusion, sentinel grid shape) against the live DB, read-only.
- Throwaway HTTP smoke (scratch DB, ephemeral port, deleted after): kiosk `/events` event-type
  cap, bearer `/events` unchanged, empty-store `/big-board` 200, `/BIG-BOARD` + `/big-board/`
  + array `?kiosk` + HEAD all 401 — 12/12.
- UI: `tsc --noEmit` 0 errors in touched files (11 repo-wide, all pre-existing);
  `vite build` with the node-server preset clean; SSR of `/big-board` on a scratch port
  returns the rendered shell with zero server errors.
- Nothing live touched: no `/home/kevin/paperclip` checkout, no `jarvis.service` /
  cockpit restart, no live DB writes.
