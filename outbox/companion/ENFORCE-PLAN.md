# Guest Scope Enforcement Plan

Node #1359, tree-0aa4feb4. Planning only — no code changes in this commit.

Builds on `outbox/companion/GUEST-AUTH-NOTE.md` (node #1357, as-built) and
`outbox/companion/AUTH-RECON.md` (node #1353, pre-build recon). The guest
identity/login layer is live: `gst_` bearer tokens resolve via
`resolveGuestSession()` to `req.guestPrincipal = { type: 'guest', guest_id,
scope_claim }`. Nothing reads that claim to gate anything yet — enforcement
is 0% built, not partially built (confirmed by grep: the only two references
to `req.guestPrincipal` in `api-v1.ts` are `/guest/login` itself and
`GET /session/whoami`).

## The accessor

```typescript
req.guestPrincipal?.scope_claim
```

Shape (from `GUEST-AUTH-NOTE.md`):

```typescript
{
  allowed_thread_prefixes: string[];
  allowed_threads: string[];
  allowed_projects: string[];
  allowed_routes: string[];
  deny_all_else: true;   // always true — inverts the default-allow logic
}
```

`req.guestPrincipal` and `req.apiKey` are **mutually exclusive** on a given
request — a guest request never has `req.apiKey` set, and vice versa. Every
existing handler assumes `req.apiKey!` is present; a guest request hitting
any of those unmodified is a crash (500), not a clean deny. That gap is one
of the reasons enforcement has to be a gate in front of the handlers, not a
per-handler patch.

## The single chokepoint

**Darwin-assistant (`darwin-assistant/src/handlers/api-v1.ts`), immediately
after the existing `bearerAuth` gate:**

```typescript
router.use(bearerAuth);        // existing — line ~1524, resolves req.apiKey / req.guestPrincipal
router.use(guestScopeGate);    // NEW — mount here, before any route handler runs
```

`guestScopeGate` is a new middleware, not a modification of `bearerAuth`.
Rationale for this exact insertion point over the alternatives:

- **Not per-handler** — 284 route handlers are registered in this one file;
  only ~60 touch caller identity at all, and ~220+ have zero ownership check
  today. Patching each is both enormous and guaranteed to miss ones added
  later. A single middleware is the only design that covers every route,
  including future ones, by construction.
- **Not in the frontend proxy** (`jarvis-command-center/src/lib/cockpit-proxy.ts`) —
  that layer currently discards the caller's own credential and always
  stamps the admin `JARVIS_COCKPIT_KEY` (lines 25-27, 59-69), so it has no
  way to know who's asking in the first place. It must be changed to forward
  the guest's own `gst_` token upstream instead of always substituting the
  admin key (a separate, required code change — see "Frontend dependency"
  below) but the actual allow/deny *decision* should still live server-side
  in darwin-assistant, which is the one source of truth both for her browser
  session and for any direct API caller.
- **Not inside `callerOwnsExternalId()`** (`api-keys.ts:113-116`) — that
  helper is only called from the *write* routes that already do ownership
  checks (`findConversationForCaller`, §3 below); it is never called from
  the ~220 read/list/goal routes that do no check at all, so extending it
  alone would leave most of the surface open.
- Mounting right after `bearerAuth` (not wrapping it) means non-guest
  requests (`req.apiKey` set, `req.guestPrincipal` undefined) fall through
  untouched — zero behavior change for Kevin/admin/programmatic callers.

### `guestScopeGate` logic (shape, not final code)

```typescript
function guestScopeGate(req: AuthedRequest, res: Response, next: NextFunction) {
  const scope = req.guestPrincipal?.scope_claim;
  if (!scope) return next();              // non-guest caller — untouched

  const externalId = req.params.external_id;      // thread-keyed routes
  const goalId = req.params.id ?? req.params.goalId; // goal-keyed routes
  const path = req.path;

  let allowed = false;
  if (externalId) {
    allowed = scope.allowed_thread_prefixes.some(p => externalId.startsWith(p))
      || scope.allowed_threads.includes(externalId);
  } else if (goalId != null) {
    allowed = scope.allowed_projects.includes(`goal-${goalId}`);
  } else {
    allowed = scope.allowed_routes.includes(path);
  }

  if (!allowed && scope.deny_all_else) {
    return sendError(res, 403, 'forbidden', 'Guest scope does not include this resource');
  }
  next();
}
```

This is the single fail-closed branch point; the route table below just says
which of the three claim arrays each family matches against.

## Route family → scope_claim matching table

| Family | Example routes | Key | Match against | Notes |
|---|---|---|---|---|
| **SSR pages** (jarvis-command-center) | `thread.$externalId.tsx`, `goals_.$goalId.tsx`, `settings.*.tsx`, all 36 files under `src/routes/` | `external_id` or goal id, in the URL | `allowed_thread_prefixes`/`allowed_threads` or `allowed_projects` | No SSR-level auth exists today (`__root.tsx` has none). Pages render regardless of scope; **real data gating happens API-side** when the page's client code calls `/cockpit-api/*`. A guest hitting `settings.*` or `/flight-deck` etc. would see an empty/erroring shell, not her data — acceptable for v1, but a nicer UX (redirect to her thread) is a follow-up, not a security requirement. |
| **Thread read APIs** | `GET /threads`, `GET /threads/:external_id`, `.../markdown`, `.../todos`, `.../links`, `.../decisions`, `.../summaries`, `GET /threads/:external_id/events` (legacy) | `external_id` | `allowed_thread_prefixes` / `allowed_threads` | None of these currently call any ownership check (confirmed — they read directly). `guestScopeGate` is the *first* gate they will ever have for a guest caller. `GET /threads` (list) and `POST /threads/search` need an additional filter (not just allow/deny) so a guest sees only her own threads in a list — `guestScopeGate` denies list-wide requests with no single `external_id`, so list endpoints need a small guest-aware filter inside the handler itself, in addition to the gate. Flag as a follow-up code task, not solved by the gate alone. |
| **Thread write/post APIs** | `POST /threads/:external_id/messages`, `/todos`, `/links`, `/decisions`, `PATCH/DELETE /threads/:external_id`, `/resume`, `/fork`, `/lock` | `external_id` | `allowed_thread_prefixes` / `allowed_threads` | These already call `findConversationForCaller`/`callerOwnsExternalId`, but every call site does `const caller = req.apiKey!` first — for a guest that line throws before the ownership check runs. `guestScopeGate` running *before* the handler means the crash never happens: a denied guest request never reaches that line. |
| **Goal-tree routes (read + mutate)** | `GET /goals`, `GET /goals/board`, `POST /goals/:id/nodes*`, `/accept`, `/push_back`, `/discard`, `/move`, `/verify`, `/propose_plan`, `/approve_plan` | goal `id` path param | `allowed_projects` (as `goal-<id>`) | Zero existing gate of any kind today (not even admin-scoped) — relies entirely on the proxy always using the admin key. `GET /goals` (no id) and `GET /goals/board` (all goals) need the same list-filter treatment as thread lists: deny outright for a guest, since there is no "list only mine" variant and a goal-scoped guest has no business seeing the whole board. `GET/POST /goals/:id/thread` and `/goals/:id/nodes/:nodeId/thread` are dual-keyed (goal id **and** a derived `cockpit:goal-<g>[-node-<n>]` external_id) — match on `allowed_projects` first since that's the param actually present; the thread-prefix convention confirms the same boundary, not an additional one. |
| **SSE / event-stream** | `GET /events` (global), `GET /events/types`, legacy `GET /threads/:external_id/events` | none (global) or `external_id` | `allowed_routes` for the global stream; `allowed_thread_prefixes` for the legacy per-thread one | The global `/events` stream has no resource id — it is not "deny by default" material in the same way, because the existing non-admin branch (`callerExternalIdPrefix`, line 6914-6917) already *filters* events by the caller's own prefix rather than denying the whole connection. A guest should get the equivalent: `guestScopeGate` lets `/events` through to a **guest-aware filter inside the handler** that only forwards events whose thread id matches `allowed_thread_prefixes`/`allowed_threads`. This is the one family where the gate's binary allow/deny isn't enough by itself — needs a companion filter, same pattern as list endpoints above. The kiosk `?kiosk=` bypass (`KIOSK_ELIGIBLE_PATHS`) is unrelated and must not be extended to guests — it grants a synthetic *admin*-scoped key, the opposite of what a guest needs. |
| **Privileged/admin APIs** | `/throttle*`, `/work-switch`, `/hopper-engine/settings`, `/settings*`, `/claude-accounts`, `/presets*`, `/agents/:key/run`, `/internal/tool-exec`, `/control-panel/*`, `/vault/*`, `/hopper*`, `/workstreams*`, `/night/*`, `/foundry/*`, `/monitors*`, `/intel/*`, `/mcp/servers*`, `/smart-todos*`, `/decisions`, `/checkins` | n/a | none — always deny | None of these have `external_id`/goal-id path params, so the gate's default branch (`allowed_routes.includes(path)`) applies. Since `allowed_routes` is seeded empty for the companion guest (`GUEST-AUTH-NOTE.md`: `allowed_routes: []`) every one of these denies by construction — no per-route special-casing needed, which is the point of putting `deny_all_else` ahead of an explicit allow-list rather than an explicit deny-list. `allowed_routes` exists as the mechanism for the rare future case of a guest needing one specific utility route (e.g. `/session/whoami`, which already works today since it doesn't branch on scope at all). |

## Fail-closed default

`guestScopeGate` denies (`403 forbidden`) whenever:
- the request is a guest request (`req.guestPrincipal` present), **and**
- none of the three claim arrays matched the request's resource key, **and**
- `scope.deny_all_else` is true (always true per schema — there is no
  code path where a guest claim can be minted without it).

Equivalently: a guest is allowed only on the **union** of
`allowed_thread_prefixes` ∪ `allowed_threads` ∪ `allowed_projects` ∪
`allowed_routes`; everything else — including every route added to this
file in the future, with zero additional code — is denied by default. This
is the opposite of today's model (implicit allow via the proxy's shared
admin key) and is why the gate has to be unconditional middleware, not an
opt-in check individual handlers remember to call.

## Frontend dependency (not in this commit's scope, flagged for Kevin)

`jarvis-command-center/src/lib/cockpit-proxy.ts` unconditionally stamps the
admin `JARVIS_COCKPIT_KEY` on every proxied request (lines 25-27, 59-69) and
never reads the incoming request's own `Authorization` header. Until that
changes, her `gst_` token has no path into darwin-assistant through the
cockpit UI at all — every browser request would still arrive at
`guestScopeGate` looking like an admin caller. This needs its own follow-up
node: thread her session token (from wherever hop-1 login ends up minting
one — out of scope here, per `AUTH-RECON.md` "the real missing piece is hop
1") through to the proxy's forwarded `Authorization` header instead of
always substituting the hardcoded key.

## Acceptance

- Accessor named: `req.guestPrincipal?.scope_claim`.
- Chokepoint named: new `guestScopeGate` middleware, mounted via
  `router.use(guestScopeGate)` immediately after the existing
  `router.use(bearerAuth)` in `darwin-assistant/src/handlers/api-v1.ts`.
- Every route family enumerated above with its match rule.
- Fail-closed default stated.
- No code changes made in this commit.
