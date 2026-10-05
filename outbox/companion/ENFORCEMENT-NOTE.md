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
- Shared page routes outside her scope (e.g., Flight Deck `/workstreams`)
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

## What's Still Open

- **#272**: Build the real scoped home page at `/companion` (currently a redirect target only)
- **#274**: Walk-the-app verification (manually test iPhone guest flow end-to-end)

## Test Command

```sh
npm run build && npm run guest-enforce-route:test
```

Exercises the real Express router over 15 test cases covering denied threads, allowed threads, goal scope, privileged API denial, SSE filtering, and HTML vs. JSON error responses. All tests run against a scratch database with no model calls (sim-guard enforced).
