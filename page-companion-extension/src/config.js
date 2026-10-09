// Page Companion — settings + endpoint resolution.
//
// Pure functions only (no chrome.* at module scope) so test/config.test.mjs can
// import this file directly under plain node. The service worker and the options
// page both import it as an ES module; the CONTENT SCRIPT does not (MV3 content
// scripts can't do ES imports) — it only ever messages the background worker.

export const DEFAULTS = Object.freeze({
  cockpitBase: 'http://192.168.1.25:8080',
  apiBase: '', // blank = derive from cockpitBase (see resolveApiBase)
  apiKey: '',
  enabled: true,
});

export const STORAGE_KEYS = Object.freeze(Object.keys(DEFAULTS));

/**
 * Normalize a base URL the way a human types it: bare host, missing scheme,
 * stray trailing slashes. Returns '' for anything that isn't an http(s) origin
 * — blank is the "not configured" signal everywhere downstream, never a throw.
 */
export function normalizeBase(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  if (!u.hostname) return '';
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

/**
 * Where the /page-companion/* routes actually live.
 *
 *   base on :8080  → <base>/cockpit-api   (the cockpit's server-side proxy; it
 *                                          injects the bearer key itself, so the
 *                                          key is optional on this path)
 *   base with a path → taken as-is        (you typed the API root, we believe you)
 *   anything else    → <base>/api/v1      (e.g. a bare http://host:3201 — JARVIS direct)
 *
 * An explicit apiBase override always wins. Returns '' when nothing is usable.
 */
export function resolveApiBase(cockpitBase, apiBaseOverride) {
  const override = normalizeBase(apiBaseOverride);
  if (override) return override;

  const base = normalizeBase(cockpitBase);
  if (!base) return '';
  if (/\/cockpit-api$/.test(base)) return base;

  const u = new URL(base);
  if (u.port === '8080') return `${base}/cockpit-api`;
  if (u.pathname.replace(/\/+$/, '')) return base; // caller gave an explicit path
  return `${base}/api/v1`;
}

/** Full URL for one of the page-companion routes. '' when unconfigured. */
export function endpointFor(settings, route) {
  const apiBase = resolveApiBase(settings?.cockpitBase, settings?.apiBase);
  if (!apiBase) return '';
  return `${apiBase}/page-companion/${String(route).replace(/^\/+/, '')}`;
}

/**
 * The cockpit proxy holds the key server-side; a direct JARVIS base does not.
 * Used by the options page to say "key required" only when it really is.
 */
export function apiKeyRequired(settings) {
  const apiBase = resolveApiBase(settings?.cockpitBase, settings?.apiBase);
  if (!apiBase) return false;
  return !/\/cockpit-api$/.test(apiBase);
}

/** Merge whatever came out of storage over the defaults, coercing types. */
export function withDefaults(stored) {
  const s = stored && typeof stored === 'object' ? stored : {};
  return {
    cockpitBase: typeof s.cockpitBase === 'string' ? s.cockpitBase : DEFAULTS.cockpitBase,
    apiBase: typeof s.apiBase === 'string' ? s.apiBase : DEFAULTS.apiBase,
    apiKey: typeof s.apiKey === 'string' ? s.apiKey : DEFAULTS.apiKey,
    enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULTS.enabled,
  };
}

// ─── THE DENY LIST — the safety gate (tree-b0198a82, node #1584) ─────────────
//
// MIRROR of darwin-assistant/src/page-companion.ts. Same hosts, same path
// prefixes, same query rule — proven identical (lists AND behaviour) by
// darwin-assistant/scripts/page-companion-check.mjs, which imports both files.
// content.js carries a third inline copy between `deny-mirror:begin/end`
// sentinels because MV3 content scripts cannot import; test/deny.test.mjs
// proves that copy matches this one. Do not edit one without the others.
//
// This is what makes a denied page never even generate a request.

/**
 * Hub 1.0 — permanently out of scope (Kevin, 2026-10-09).
 *
 * 🔴 EXACT HOSTNAME MATCHES, NOT A DOMAIN SUFFIX. `intake.thedarwinhub.com`,
 * `staging.intake.thedarwinhub.com` and `accounting.thedarwinhub.com` are
 * subdomains of `thedarwinhub.com` and are IN SCOPE — an
 * `endsWith('thedarwinhub.com')` check here kills the feature.
 */
export const DENIED_HOSTS = Object.freeze(['thedarwinhub.com', 'www.thedarwinhub.com']);

/** Denied on EVERY host, on a path-segment boundary: the live lead/click
 *  machinery and the internal APIs. `/tracking-dashboard` is NOT denied. */
export const DENIED_PATH_PREFIXES = Object.freeze(['/track', '/api']);

/** Any query string denies the URL, on every host — Hub-family admin pages
 *  write on a bare `?param=` GET and the page key drops the query anyway. */
export const DENY_ANY_QUERY_STRING = true;

/** Exact-host deny check (see the DENIED_HOSTS warning). Case-insensitive. */
export function isDeniedHost(hostname) {
  if (typeof hostname !== 'string') return false;
  const h = hostname.trim().toLowerCase().replace(/\.$/, '');
  return DENIED_HOSTS.includes(h);
}

/** Path-prefix deny check, on a segment boundary. */
export function isDeniedPath(pathname) {
  if (typeof pathname !== 'string') return false;
  const p = pathname.toLowerCase();
  return DENIED_PATH_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

/**
 * Is this URL denied? True for anything the companion must not touch, including
 * anything that isn't a parseable http(s) page URL — so one call is a complete
 * gate. Mirrors the server's isDeniedPageUrl exactly, including the bare
 * `host:8100/path` convenience form.
 */
export function isDeniedUrl(raw) {
  if (typeof raw !== 'string') return true;
  const trimmed = raw.trim();
  if (!trimmed) return true;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) return true;
  if (!hasScheme && trimmed.startsWith('/')) return true;
  let u;
  try {
    u = new URL(hasScheme ? trimmed : `http://${trimmed}`);
  } catch {
    return true;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  if (!u.hostname) return true;
  if (isDeniedHost(u.hostname)) return true;
  if (isDeniedPath(u.pathname)) return true;
  if (DENY_ANY_QUERY_STRING && u.search) return true;
  return false;
}

/**
 * The one question the worker and the content script ask: do we touch this page
 * at all? An http(s) page that the deny list allows — nothing else.
 */
export function shouldAskAboutUrl(raw) {
  return isAskableUrl(raw) && !isDeniedUrl(raw);
}

/**
 * Should we even ask about this URL? The extension asks about every page Kevin
 * opens, but there is no point burning a round trip on a scheme the registry
 * can never match (the server answers `ours:false` for these anyway).
 */
export function isAskableUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return Boolean(u.hostname);
  } catch {
    return false;
  }
}

/**
 * The same canonical page key the server computes (`host[:port]/path`, scheme
 * and query dropped, host lowercased, path case preserved, default ports and a
 * trailing slash stripped) — see darwin-assistant/docs/page-companion/CONTRACT.md.
 *
 * The extension does NOT send this; the server normalizes the raw URL itself.
 * We compute it only to dedupe "have I already asked about this page?" across
 * SPA navigations that change nothing but the query string. Returns null for a
 * non-page URL, same as the server.
 */
export function pageKey(raw) {
  if (!isAskableUrl(raw)) return null;
  const u = new URL(String(raw).trim());
  const defaultPort = (u.protocol === 'http:' && u.port === '80') ||
    (u.protocol === 'https:' && u.port === '443');
  const host = defaultPort ? u.hostname.toLowerCase() : u.host.toLowerCase();
  const path = u.pathname.replace(/\/+$/, '');
  return `${host}${path}`;
}

/** Threads count for the button badge. Caps the label at 9+ like a chat app. */
export function badgeLabel(threads) {
  const n = Array.isArray(threads) ? threads.length : 0;
  if (n <= 0) return '';
  return n > 9 ? '9+' : String(n);
}

/** Coerce a /page-companion/lookup response into the shape the UI expects. */
export function normalizeLookup(data) {
  const d = data && typeof data === 'object' ? data : {};
  const threads = Array.isArray(d.threads)
    ? d.threads
        .filter((t) => t && typeof t.external_id === 'string' && t.external_id)
        .map((t) => ({
          external_id: t.external_id,
          title: typeof t.title === 'string' && t.title ? t.title : null,
          last_active: typeof t.last_active === 'string' ? t.last_active : null,
        }))
    : [];
  return {
    ours: d.ours === true,
    project: typeof d.project === 'string' && d.project ? d.project : null,
    registry_id: typeof d.registry_id === 'number' ? d.registry_id : null,
    normalized_url: typeof d.normalized_url === 'string' ? d.normalized_url : null,
    threads,
  };
}

// ─── Branch awareness (tree-b0198a82, node #1586) ────────────────────────────
//
// `GET /page-companion/deployment?registry_id=N` answers "which branch is
// actually checked out on the host serving this page". It is a SEPARATE,
// LAZY call made after the panel is already open — never part of the lookup —
// so a slow or dead deploy source cannot delay the panel or change the
// ours/not-ours answer. Anything other than a clean `known:true` answer means
// the panel renders NO branch line at all (not the word "unknown", which would
// be noise on every page that simply has no deploy target).

/** Coerce a /page-companion/deployment response. Returns null for anything
 *  we would not render — including `known:false`. */
export function normalizeDeployment(data) {
  const d = data && typeof data === 'object' ? data : {};
  if (d.known !== true) return null;
  const branch = typeof d.branch === 'string' && d.branch ? d.branch : null;
  const commit = typeof d.commit === 'string' && d.commit ? d.commit : null;
  const detached = d.detached === true;
  // Nothing identifying the checkout = nothing worth a line.
  if (!branch && !commit) return null;
  return {
    branch,
    commit,
    detached,
    as_of: typeof d.as_of === 'string' && d.as_of ? d.as_of : null,
    behind: typeof d.behind === 'number' ? d.behind : null,
    stale: typeof d.stale === 'boolean' ? d.stale : null,
    dirty: typeof d.dirty === 'boolean' ? d.dirty : null,
    source: typeof d.source === 'string' && d.source ? d.source : null,
  };
}

/**
 * The one muted line the panel header shows. Built here (not in content.js) so
 * it is unit-testable under plain node.
 *
 *   "main · ac3510d9d3 · 1d ago"
 *   "detached @ 53739f343b"
 *   "deploy/atomic-releases-hub2 · 53739f343b · 3 behind · 4h ago"
 *
 * `nowMs` is injectable so the relative-time cases are deterministic in tests.
 */
export function deploymentLine(dep, nowMs = Date.now()) {
  if (!dep) return '';
  const bits = [];
  if (dep.detached) bits.push(dep.commit ? `detached @ ${dep.commit}` : 'detached');
  else {
    if (dep.branch) bits.push(dep.branch);
    if (dep.commit) bits.push(dep.commit);
  }
  if (typeof dep.behind === 'number' && dep.behind > 0) bits.push(`${dep.behind} behind`);
  if (dep.dirty === true) bits.push('dirty');
  const rel = relativeAge(dep.as_of, nowMs);
  if (rel) bits.push(rel);
  return bits.join(' · ');
}

/** "4h ago" / "3d ago" / a date past a week. '' for anything unparseable. */
export function relativeAge(raw, nowMs = Date.now()) {
  if (typeof raw !== 'string' || !raw) return '';
  const d = new Date(/[Tt]/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return '';
  const mins = Math.round((nowMs - d.getTime()) / 60_000);
  if (mins < 0) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d ago` : d.toISOString().slice(0, 10);
}
