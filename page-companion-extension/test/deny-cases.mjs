// THE SHARED DENY CASE TABLE — tree-b0198a82, node #1584.
//
// One table, read by all three test suites, because the deny list exists in
// three copies and the only thing that keeps them honest is running the SAME
// cases through each:
//
//   darwin-assistant/scripts/page-companion-check.mjs   → the server (TypeScript)
//   page-companion-extension/test/deny.test.mjs         → src/config.js
//                                                       → src/content.js (inline mirror)
//
// It lives here rather than in darwin-assistant/scripts because these are
// browser URLs; the server check imports it across the two package roots on
// purpose, so there is exactly one place to add a case.
//
// `denied: true` means the companion must never ask about the URL and must
// never be able to register it. `denied: false` means it is in scope.

export const DENY_CASES = Object.freeze([
  // ── IN SCOPE — the whole point of this tree. 🔴 A suffix-match deny
  //    (`endsWith('thedarwinhub.com')`) fails every one of these.
  { url: 'https://intake.thedarwinhub.com/suppression-dashboard', denied: false, why: 'intake dashboard — in scope' },
  { url: 'https://intake.thedarwinhub.com/mediabuy-performance', denied: false, why: 'intake dashboard — in scope' },
  { url: 'https://staging.intake.thedarwinhub.com/suppression-dashboard', denied: false, why: 'staging intake — in scope' },
  { url: 'https://accounting.thedarwinhub.com/dashboard', denied: false, why: 'accounting dashboard — in scope' },
  { url: 'https://perclickity.thedarwinhub.com/health', denied: false, why: 'perclickity health — in scope' },
  { url: 'https://intake.thedarwinhub.com', denied: false, why: 'in-scope host root' },
  { url: 'https://intake.thedarwinhub.com/', denied: false, why: 'in-scope host root, trailing slash' },
  { url: 'https://INTAKE.THEDARWINHUB.COM/Suppression-Dashboard', denied: false, why: 'host case is irrelevant to the deny' },
  { url: 'intake.thedarwinhub.com/suppression-dashboard', denied: false, why: 'bare host/path convenience form' },

  // ── IN SCOPE — segment-boundary proof. A naive startsWith() on the path
  //    prefixes would wrongly deny these.
  { url: 'https://intake.thedarwinhub.com/tracking-dashboard', denied: false, why: '/track is a segment, /tracking-dashboard is not under it' },
  { url: 'https://intake.thedarwinhub.com/apiary', denied: false, why: '/api is a segment, /apiary is not under it' },
  { url: 'https://intake.thedarwinhub.com/track-report', denied: false, why: 'not a /track/ child' },

  // ── IN SCOPE — the LAN dashboards the companion already serves.
  { url: 'http://192.168.1.25:8100/heartbeat', denied: false, why: 'Hub 1.0 Heartbeat dashboard (ours, LAN)' },
  { url: 'http://192.168.1.25:8080/goals/5', denied: false, why: 'the cockpit itself' },
  { url: 'http://192.168.1.25:8090', denied: false, why: 'Engine Docs root' },

  // ── IN SCOPE — exact-host rule means a lookalike host is not covered by it
  //    (it is simply not ours, which the registry already answers).
  { url: 'https://thedarwinhub.com.evil.example/x', denied: false, why: 'exact-host rule: a lookalike is not the denied host' },
  { url: 'https://notthedarwinhub.com/x', denied: false, why: 'exact-host rule, not a suffix rule' },

  // ── NOT denied by this list, refused elsewhere: a bare token parses as a
  //    host under the convenience form, and is filtered by isAskableUrl /
  //    answered `ours:false` by the registry.
  { url: 'nonsense', denied: false, why: 'parses as a bare host; refused by isAskableUrl, not by the deny list' },

  // ── DENIED (a) — Hub 1.0, exactly these two hosts, any port, any case.
  { url: 'https://thedarwinhub.com', denied: true, why: 'Hub 1.0 root' },
  { url: 'https://thedarwinhub.com/', denied: true, why: 'Hub 1.0 root, trailing slash' },
  { url: 'https://thedarwinhub.com/wp-admin/admin.php', denied: true, why: 'Hub 1.0 admin' },
  { url: 'https://www.thedarwinhub.com/anything', denied: true, why: 'Hub 1.0 www' },
  { url: 'http://THEDARWINHUB.COM/x', denied: true, why: 'host match is case-insensitive' },
  { url: 'https://thedarwinhub.com:8443/x', denied: true, why: 'port is irrelevant — same host' },
  { url: 'thedarwinhub.com/x', denied: true, why: 'bare form of the denied host' },
  { url: 'https://thedarwinhub.com./x', denied: true, why: 'trailing-dot FQDN form of the denied host' },

  // ── DENIED (b) — /track* and /api/* on ANY host.
  { url: 'https://intake.thedarwinhub.com/track', denied: true, why: 'live click machinery' },
  { url: 'https://intake.thedarwinhub.com/track/', denied: true, why: 'live click machinery' },
  { url: 'https://intake.thedarwinhub.com/track/test', denied: true, why: 'live click machinery' },
  { url: 'https://intake.thedarwinhub.com/TRACK', denied: true, why: 'path deny is case-insensitive, deliberately conservative' },
  { url: 'https://staging.intake.thedarwinhub.com/track/test', denied: true, why: 'staging is still the live machinery' },
  { url: 'https://intake.thedarwinhub.com/api', denied: true, why: 'internal API' },
  { url: 'https://accounting.thedarwinhub.com/api/accounting-page-todos', denied: true, why: 'internal API' },
  { url: 'http://192.168.1.25:8100/api/v1/anything', denied: true, why: 'the path rules apply on every host, LAN included' },
  { url: 'http://192.168.1.25:3201/api/v1/page-companion/lookup', denied: true, why: 'never ask about our own API' },

  // ── DENIED (c) — any query string, on any host. The known cost: a dashboard
  //    reached with a query loses its button until Kevin lands on the clean URL.
  { url: 'https://intake.thedarwinhub.com/suppression-dashboard?brand=7', denied: true, why: 'query string' },
  { url: 'http://192.168.1.25:8095/leaks?brand=x', denied: true, why: 'query string, LAN page — the accepted cost of rule (c)' },
  { url: 'https://thedarwinhub.com/?page_id=12', denied: true, why: 'the Hub 1.0 write-on-GET case rule (c) exists for' },
  { url: 'https://intake.thedarwinhub.com/x?', denied: false, why: 'a bare ? carries no query — URL.search is empty' },
  { url: 'https://intake.thedarwinhub.com/x#frag', denied: false, why: 'a hash is not a query string' },

  // ── DENIED (d) — not an http(s) page at all. Already refused before this
  //    list existed; the deny check answers true so one call is a full gate.
  { url: 'chrome://extensions', denied: true, why: 'not an http(s) page' },
  { url: 'file:///tmp/x.html', denied: true, why: 'not an http(s) page' },
  { url: 'about:blank', denied: true, why: 'not an http(s) page' },
  { url: 'ftp://host/x', denied: true, why: 'not an http(s) page' },
  { url: '/settings/vault?file=x', denied: true, why: 'relative — no host to resolve' },
  { url: '', denied: true, why: 'empty' },
  { url: '   ', denied: true, why: 'blank' },
  { url: null, denied: true, why: 'not a string' },
  { url: undefined, denied: true, why: 'not a string' },
  { url: 42, denied: true, why: 'not a string' },
]);

/** Registry PATTERNS: may this ever be stored? Same rules, wildcard stripped. */
export const DENY_PATTERN_CASES = Object.freeze([
  { pattern: 'intake.thedarwinhub.com/*', denied: false, why: 'the whole intake host is registerable' },
  { pattern: 'intake.thedarwinhub.com/suppression-dashboard', denied: false, why: 'one intake dashboard' },
  { pattern: 'intake.thedarwinhub.com/suppression*', denied: false, why: 'prefix pattern on an allowed path' },
  { pattern: 'staging.intake.thedarwinhub.com/*', denied: false, why: 'staging intake host' },
  { pattern: 'accounting.thedarwinhub.com/*', denied: false, why: 'accounting host' },
  { pattern: 'http://192.168.1.25:8100/*', denied: false, why: 'an existing seeded LAN dashboard' },
  { pattern: 'intake.thedarwinhub.com/tracking-dashboard*', denied: false, why: 'segment boundary again' },

  { pattern: 'thedarwinhub.com/*', denied: true, why: 'the whole Hub 1.0 site' },
  { pattern: 'thedarwinhub.com', denied: true, why: 'Hub 1.0 host, no wildcard' },
  { pattern: 'www.thedarwinhub.com/wp-admin/*', denied: true, why: 'Hub 1.0 admin' },
  { pattern: 'https://thedarwinhub.com/anything', denied: true, why: 'Hub 1.0 with a scheme' },
  { pattern: 'intake.thedarwinhub.com/track*', denied: true, why: 'the live click machinery' },
  { pattern: 'intake.thedarwinhub.com/track/*', denied: true, why: 'the live click machinery' },
  { pattern: 'intake.thedarwinhub.com/api/*', denied: true, why: 'internal API' },
  { pattern: 'http://192.168.1.25:8100/api/*', denied: true, why: 'the path rules apply on every host' },
  { pattern: 'intake.thedarwinhub.com/dash?x=1', denied: true, why: 'a pattern with a query string is refused, not silently stripped' },
]);
