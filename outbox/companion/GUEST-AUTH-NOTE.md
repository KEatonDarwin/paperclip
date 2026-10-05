# Companion Guest Authentication

## Overview

The companion guest-auth system lets Kevin's wife (the "guest") log into the cockpit from her iPhone with a scoped login credential. Her account has no admin access — only access to her thread and goal #12. Session tokens carry her scope claim through every request.

## Schema: `guest_identities`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PRIMARY KEY | Stable row identifier |
| `username` | TEXT UNIQUE | Login username (e.g. "companion") |
| `password_hash` | TEXT | SHA256 hash of the plaintext password (same scheme as api_keys) |
| `scope_claim` | TEXT | JSON-encoded GuestScopeClaim |
| `created_at` | TEXT | Timestamp |
| `last_login_at` | TEXT | NULL until first login |
| `disabled` | INTEGER | 1 = account is revoked, login fails |

A companion `guest_sessions` table stores session hashes (same bearer-token pattern as api_keys): only the hash is persisted, the plaintext token shown once at login.

## Scope Claim: Structure & Fields

Stored as JSON in `guest_identities.scope_claim`. Parsed into `GuestScopeClaim`:

```typescript
{
  allowed_thread_prefixes: string[];    // e.g., ["cockpit:companion-"]
  allowed_threads: string[];             // e.g., []
  allowed_projects: string[];            // e.g., ["goal-12"]
  allowed_routes: string[];              // e.g., []
  deny_all_else: true                    // Fail-closed: block unlisted resources
}
```

**Field meanings:**
- **allowed_thread_prefixes**: Thread external_ids matching these prefixes pass. Empty = no prefix-based access.
- **allowed_threads**: Exact thread external_ids that pass. Empty = no exact-match access.
- **allowed_projects**: Project ids the guest can view (e.g., goals). Empty = no project access.
- **allowed_routes**: API routes the guest can call (reserved for future use).
- **deny_all_else**: Always `true`. Without it in a route check, all unmatched resources would pass — this flag inverts the logic to fail-closed.

## Credential Issuance

### Helper: `createGuestIdentity(username, password, scopeClaim)`

Called from seed scripts. Creates a row in `guest_identities` with a SHA256 password hash and the scope claim as JSON.

```typescript
import { createGuestIdentity } from './guest-identities';

const { id } = createGuestIdentity('companion', 'my-password', {
  allowed_thread_prefixes: ['cockpit:companion-'],
  allowed_threads: [],
  allowed_projects: ['goal-12'],
  allowed_routes: [],
  deny_all_else: true,
});
```

### Seed Script: `companion-guest-seed.mjs`

Idempotent script that creates or refreshes the one companion guest row:

```bash
npm run seed-companion-guest
```

**Behavior:**
- Refuses to run against the live `jarvis.db` (safety guard).
- First run: creates the row, prints a random placeholder password once.
- Second run: upserts the existing row by username, rotates the password, refreshes the scope_claim (no duplicate).
- Password is never hardcoded — always randomly generated and printed to stdout.

**Output example:**
```
[seed-companion-guest] created guest identity (id=1, username=companion)
[seed-companion-guest] PLACEHOLDER PASSWORD (shown once): 8kA3zL9mBpQ2wXvY4nH5qR6sT
```

## Login & Session Resolution

### POST `/guest/login`

Resolves `username` + `password` into a fresh bearer session token:

```bash
curl -X POST http://localhost:3201/api/v1/guest/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"companion", "password":"the-real-password"}'
```

**Success (200):**
```json
{
  "session_token": "gst_a1b2c3d4e5f6...",
  "principal": {
    "type": "guest",
    "guest_id": 1,
    "scope_claim": { ... }
  },
  "guest_id": 1,
  "scope_claim": { ... }
}
```

**Failure (401):** Unknown username, wrong password, or disabled identity.

### Function: `loginGuest(username, password)`

Called from the POST /guest/login route. Mints a bearer token (`gst_` prefix + 24 random hex bytes), hashes it, and persists only the hash.

### Function: `resolveGuestSession(token)`

Called from the `bearerAuth` middleware for any bearer token starting with `gst_`. Returns a `GuestPrincipal` (type, guest_id, scope_claim) or null if the session is unknown, revoked, or the guest is disabled.

## Request-Level Scope Enforcement

Once logged in, every request carries the session token in the `Authorization: Bearer gst_...` header. The `bearerAuth` middleware (api-v1.ts, line 1423) routes `gst_` tokens to `resolveGuestSession()`, which populates:

```typescript
req.guestPrincipal: { type: 'guest', guest_id: number, scope_claim: GuestScopeClaim }
```

### Server-Side Accessor

**Route handlers read the scope claim via:**
```typescript
req.guestPrincipal?.scope_claim
```

This is the exact accessor node #271 (enforcement) should call to gate access to a resource. Example:

```typescript
router.get('/threads/:external_id', (req: AuthedRequest, res) => {
  // Read the guest's scope claim
  const scope = req.guestPrincipal?.scope_claim;
  if (scope) {
    // Enforce: check the thread external_id against allowed_thread_prefixes/allowed_threads
    const allowed = scope.allowed_thread_prefixes.some(p => external_id.startsWith(p))
      || scope.allowed_threads.includes(external_id);
    if (!allowed && scope.deny_all_else) {
      sendError(res, 403, 'forbidden', 'Guest scope does not include this thread');
      return;
    }
  }
  // ... proceed to fetch thread ...
});
```

## Kevin's Steps

### 1. Seed the Companion Guest Row

Run the seed script **once** against the live cockpit database:

```bash
cd /home/kevin/paperclip/darwin-assistant
JARVIS_DB_PATH=/home/kevin/paperclip/darwin-assistant/jarvis.db npm run seed-companion-guest
```

**Output:**
```
[seed-companion-guest] created guest identity (id=X, username=companion)
[seed-companion-guest] PLACEHOLDER PASSWORD (shown once): <random-password>
```

Copy that random password somewhere safe.

### 2. Set Her Real Password

Once the cockpit is deployed, Kevin logs in and changes her password via the settings UI (the companion account is now a regular identity row that can be edited like any other).

Alternatively, use a direct database update (Kevin only):

```bash
sqlite3 /home/kevin/paperclip/darwin-assistant/jarvis.db \
  "UPDATE guest_identities SET password_hash = (SELECT hash FROM api_keys WHERE name = 'temp-hash') WHERE username = 'companion';"
```

(Or simpler: Kevin sets a temporary password by re-running the seed script to rotate the password, then changes it in the UI.)

### The One Command

To deploy her companion guest account to the live cockpit:

```bash
JARVIS_DB_PATH=/home/kevin/paperclip/darwin-assistant/jarvis.db npm run seed-companion-guest
```

That's it. The script is idempotent and safe — it upserts the row by username and never creates duplicates.
