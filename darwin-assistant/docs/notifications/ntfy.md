# ntfy desktop push for Cockpit notifications

Every `createNotification()` call (`src/notifications.ts`) now also fires a
best-effort push to [ntfy](https://ntfy.sh) so Kevin gets a phone/desktop
alert without the Cockpit tab open. It is **opt-in and env-only** — with no
env vars set, nothing changes: no topic, no secret, no network call.

## Env vars

| Var | Required | Example | Meaning |
| --- | --- | --- | --- |
| `JARVIS_NTFY_TOPIC_URL` | yes, to enable | `https://ntfy.sh/jarvis-kev-f87c3ce6` | The full ntfy publish URL for Kevin's topic. Must be `http(s)://host/<topic>`. Unset, empty, or malformed = disabled, no-op. |
| `JARVIS_COCKPIT_PUBLIC_URL` | recommended | `https://cockpit.thedarwinhub.com` | Absolute base used to resolve a notification's relative `link` (e.g. `/foundry?project=x`) into a clickable push URL. Without it, relative links can't be resolved and the push ships with no click-through. |
| `JARVIS_NTFY_SEVERITIES` | no | `success,warning,error` | Comma list of severities to push. **Replaces** the default, it does not add to it. Default (unset): `success,warning,error` — `info` notifications never push. Unknown/garbage values fall back to the default. |

Set these in the systemd unit's `Environment=` lines or the service's `.env`
— never hardcode a topic URL or secret in code.

## Behavior notes

- **Severity → priority/tags**: `error` → priority 5, `rotating_light`;
  `warning` → priority 4, `warning`; `success`/`info` → priority 3,
  `white_check_mark` / `information_source`.
- **Click target**: uses the notification's own `link` if set (resolved
  against `JARVIS_COCKPIT_PUBLIC_URL`), otherwise deep-links to
  `/notifications?notification=<id>`. Only `http`/`https` destinations are
  ever sent — anything else (or an unresolvable relative link with no base
  configured) ships with no `click` field rather than a broken/unsafe one.
- **Transport**: JSON POST to the ntfy *server origin* (not the topic path)
  with `{ topic, title, message, priority, tags, click? }` — the standard
  [ntfy JSON publish](https://docs.ntfy.sh/publish/#publish-as-json) shape.
  The topic itself only ever appears in the JSON body, never in the request
  URL or in logs.
- **Isolation**: delivery is fire-and-forget, 5s time-boxed, and every
  failure (bad topic, DNS, timeout, non-2xx) is caught and logged without the
  topic URL/name. It can never make `createNotification` throw, slow down,
  or block the SQLite/SSE path.
- **Burst protection**: at most 2 publishes in flight at a time; a burst
  beyond that queues in-process (capped at 50 pending — anything past that is
  dropped with a log line, not an unbounded queue).

## Kevin setup

1. Install [ntfy's mobile app](https://ntfy.sh/) (or just watch
   `https://ntfy.sh/app` in a browser) and subscribe to a private topic —
   treat the topic name itself as a secret (anyone who knows it can publish
   to or read your topic on the public server).
2. Set `JARVIS_NTFY_TOPIC_URL` to that topic's full URL and
   `JARVIS_COCKPIT_PUBLIC_URL` to the Cockpit's public base URL in the
   service env, then restart the service.
3. Optionally set `JARVIS_NTFY_SEVERITIES` if you want `info` pushes too, or
   want to narrow it further (e.g. `error` only).

## Tests

`npm run ntfy-notifications:check` — builds, then runs
`scripts/ntfy-notifications-check.mjs` against the compiled `dist/` with a
stubbed `fetch` and a scratch SQLite DB. Covers: disabled config, severity
filtering (default + override + garbage fallback), relative/absolute/missing
link resolution, non-http(s) link rejection, payload shape per severity,
timeout/failure isolation, no secret leakage, and the concurrency limiter.
