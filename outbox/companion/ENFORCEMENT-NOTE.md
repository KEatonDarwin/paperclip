# Companion Guest Access Enforcement Model

## Deny-All-Else Scope

Guest principals (`type: 'guest'` from `guest-identities.ts`) are allowed only on the **union** of four scope lists. Everything else is forbidden by construction — `deny_all_else` is hardcoded `true` on every guest claim, with no code path to override it.

### What Guest Can Reach

- **Threads**: `allowed_threads` (exact match) + `allowed_thread_prefixes` (startsWith match)
- **Goals**: `allowed_projects` (e.g., `"goal-12"` for goal ID 12)
- **Custom Routes**: `allowed_routes` (path match + boundary-aware prefix)
- **Identity Bootstrap**: `/session/whoami` always passes (not gated by scope)
- **SSE Bootstrap**: `/events` and `/events/types` connections are opened but self-filtered per-event (downstream enforcement)

### What Guest Cannot Reach

- Foreign thread reads/writes (any thread not in the scope lists)
- Admin/privileged APIs (e.g., POST `/work-switch`, the stop-all switch)
- Shared page routes outside her scope — API-side (e.g., Flight Deck's `/workstreams` data feed) AND now SSR-side in jarvis-command-center (e.g., `GET /flight-deck` itself, via the new page gate)
- Unmatched custom routes
- Global SSE events with no thread context (`type: 'notification'`, etc.)

## Enforcement Chokepoint

**File**: `darwin-assistant/src/handlers/api-v1.ts`  
**Function**: `guestScopeGate()` (lines 1569–1600)

Mounted immediately after `bearerAuth` middleware, so it runs **for every request**. Non-guest callers (api_key, admin tokens) skip it entirely — their behavior is byte-identical to pre-enforcement. Fails closed: runs `next()` only if allowed, else sends a 403 JSON or 302 redirect.

### Scope-Match Helper

**Function**: `guestScopeAllowsThread()` (lines 1508–1513) — the single union rule for thread checking, used by both the route gate AND the per-event SSE filter (not duplicated elsewhere).

## Scope Claim to Allow Decision Mapping

Gate checks `req.guestPrincipal.scope_claim` (a `GuestScopeClaim` object) against the extracted resource:

| Resource Kind | Scope Check | Field(s) |
|---|---|---|
| **thread** | Thread ID in `allowed_threads` OR ID matches a prefix in `allowed_thread_prefixes` | `allowed_threads` + `allowed_thread_prefixes` |
| **goal** | `"goal-{goalId}"` in `allowed_projects` | `allowed_projects` |
| **route** | `req.path` matches a route via exact-match or prefix-with-boundary (see `guestRouteMatches()`) | `allowed_routes` |

**Path Extraction**: Done before Express route matching (at `router.use()` level), so it uses regex on `req.path`:
- Thread: `/threads/([^/]+)(?:\/.*)?` → `threadExternalId`
- Goal: `/goals/([^/]+)(?:\/.*)?` → `goalId`
- Anything else → falls through to route list

## SSE Filtering

### Global Stream (`GET /events`)

Guest connection is **allowed to open** but receives **per-event enforcement**:
- `GET /events` handler calls `guestScopeAllowsThread(scope, event.conversationId)` before writing each event
- Foreign-thread events are dropped on the wire
- Global events (no `conversationId`, e.g., `type: 'notification'`) are always dropped for guests

### Per-Thread Legacy Stream (`GET /threads/:external_id/events`)

Passes the scope gate (same as other thread routes), then the handler serves only that thread's events — no per-event filtering needed since the stream is already scoped to one thread.

## Fail-Closed Guarantee

1. **Default-deny**: Any route **not** explicitly listed in the four scope fields returns 403
2. **No fallback escapes**: Addition of new routes to this file auto-denies to guests (no changes to `guestScopeGate` needed)
3. **Disabled identities fail silently**: `resolveGuestSession()` returns `null` if the identity is `disabled = 1`
4. **Token revocation**: Session marked `revoked_at` is rejected on next use
5. **No privilege escalation**: Guest principals are a distinct `type` from `api_key`; handlers branch on presence of `req.guestPrincipal`

## Redirect Target (SCOPED_HOME)

**Constant**: `SCOPED_HOME_PATH = '/companion'` (line 1476)

When a guest request with `Accept: text/html` (browser navigation) hits a forbidden resource, they receive a **302 redirect** to `/companion` instead of a JSON 403. This allows graceful page-level denial without a client-side error.

**Note**: `/companion` is currently a placeholder (node #272 owns building the real route; until then it redirects but has no working page).

## #271 Fixes (this patch)

The verifier for node #1360/#1362's work found two gaps that made the gate above decorative rather than real, plus a batch of handlers that crashed instead of denying. All three are now fixed:

1. **Proxy admin-key bypass (the crux)** — `jarvis-command-center/src/lib/cockpit-proxy.ts` used to unconditionally stamp the admin `JARVIS_COCKPIT_KEY` on every upstream call, so a guest's own `gst_` token never reached darwin-assistant at all and `guestScopeGate` always saw an admin principal. It now forwards a guest's own token (from her `Authorization` header or her `jarvis_guest_session` cookie, see `guest-session.ts`) upstream instead; every other caller gets byte-identical behavior (the admin key, same as before).
2. **In-scope 500s** — `guestScopeGate` only proves a resource is IN a guest's scope; it never proved the handler behind it could actually serve a guest. Every ownership-checking handler that did `const caller = req.apiKey!` crashed (`TypeError` → 500) the moment an in-scope guest request reached it — a real guest bug, not a gate bug. Fixed two ways: `GET /threads/:external_id/markdown` is now properly guest-aware (a real 200, matching the pattern already used by `GET /threads/:external_id` and `POST /threads/:external_id/messages`, node #1362). Every other thread-keyed handler that still assumes an api_key caller (model pin, lock/unlock, rename/delete, fork/smart-fork, session-clone, auto-title/summarize, todos/links/decisions/dispatches management, stop/resume, …) now goes through a `requireApiKeyCaller()` guard that sends a clean 403 instead of crashing. **None of those ~30 handlers are guest-use-case routes** — a guest can read her thread and post messages; she cannot rename, delete, fork, or manage todos/links/decisions on it. If that policy changes (she should be able to, say, add her own todos), those specific handlers need the same guest-aware treatment markdown got, not just the 403 guard.
3. **No SSR page gate** — `jarvis-command-center` had zero guest-aware code at all (confirmed by grep before this patch: 0 hits for `guestPrincipal`/`scope_claim`/`gst_`). Added `src/lib/guest-gate.ts`, mounted in `server.ts` ahead of the SSR router, covering all ~44 files under `src/routes/` by construction. A guest whose scope doesn't cover the requested page (matched the same way as the API gate: thread/goal/route) is redirected to `SCOPED_HOME_PATH` before any page renders.

## Honest Residual Gaps — do not read this as airtight

- **No login page/flow exists yet.** The guest-gate and proxy fixes both assume a `jarvis_guest_session` cookie (or an `Authorization: Bearer gst_...` header) is already present. Nothing in either repo sets that cookie after `POST /guest/login` — a guest has no way to actually get a session into her browser today. That's a separate, not-yet-built piece (likely #272's scope, alongside the real `/companion` page).
- **#272**: Build the real scoped home page at `/companion` (currently a redirect target only, in both the API 302 and the new SSR gate's redirect).
- **#274**: Walk-the-app verification (manually test iPhone guest flow end-to-end) — still blocked on the login-page gap above.
- The ~30 handlers guarded with a 403 stub (gap 2 above) are deliberately NOT guest-functional — don't tell Kevin she can fork/delete/manage todos on her thread. If that's ever wanted, each one needs its own guest branch, not just the stub.
- Static asset paths (anything with a file extension) are exempt from the SSR gate by design — that's correct (assets aren't pages, the real enforcement is API-side), but it means the SSR gate is defense-in-depth/UX, not the security boundary. The API-side fixes (1 and 2 above) are what actually protects data.

## Test Command

```sh
# darwin-assistant — the API-side gate + in-scope ALLOW/403 fixes
npm run build && npm run guest-enforce-route:test

# jarvis-command-center — the proxy forwarding fix + the new SSR page gate,
# against a real darwin-assistant backend (needs darwin-assistant built first)
npm run build
JARVIS_DB_PATH=/tmp/guest-page-gate-test.db npm run guest-page-gate:test
```

darwin-assistant's suite exercises the real Express router over 15 test cases covering denied threads, allowed threads (now asserting real 200s, not just "not 403"), goal scope, privileged API denial, SSE filtering, and HTML vs. JSON error responses. jarvis-command-center's suite (7 cases) proves the SSR gate's redirect/allow decisions and the proxy's token-forwarding, both against the real darwin-assistant router — not a stub. All tests run against scratch databases with no model calls (sim-guard enforced).
