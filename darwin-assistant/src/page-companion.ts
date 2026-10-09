// PAGE COMPANION — the "is this page one of ours, and which chats touched it?"
// registry (design: outbox/page-companion-concept-2026-10-09.md, tree-e753d989).
//
// Kevin loads a page he (or rather, JARVIS) built; a Chrome extension asks this
// server whether the page is ours and which cockpit chats already talk about it,
// so he can request an edit from the page instead of hunting for the old thread.
//
// Two match sources, deliberately in this order:
//   1. `page_registry` — explicit rows (exact URL, or a prefix pattern ending
//      in '*'). This is what makes a whole dashboard ("everything on :8100")
//      ours in one row.
//   2. `thread_links` reverse lookup — every time JARVIS sets a thread's
//      preview/reference link it writes a thread_links row, so reversing that
//      join gives the chats-per-page index retroactively, for free, for every
//      page ever linked. No page markup needed.
//
// Everything matches on ONE canonical form (see normalizePageUrl) so a lookup
// for `https://HOST:8100/goals/?x=1#y` finds a registry row stored as
// `http://host:8100/goals`.

import { randomUUID } from 'node:crypto';
import {
  sqliteDb,
  getConversation,
  getConversationById,
  getOrCreateConversation,
  renameConversation,
  addTurn,
} from './conversation-db.js';
import { setPreviewLink } from './thread-links.js';

export type PageRegistrySource = 'manual' | 'thread_links_auto' | 'signature';

export interface PageRegistryRow {
  id: number;
  url_pattern: string;
  project: string;
  primary_thread_ext: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface PageCompanionThread {
  external_id: string;
  title: string | null;
  last_active: string;
}

export interface PageCompanionLookup {
  ours: boolean;
  project: string | null;
  registry_id: number | null;
  threads: PageCompanionThread[];
  /** The canonical form the URL was matched on — handy when debugging a miss. */
  normalized_url: string | null;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS page_registry (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    url_pattern        TEXT NOT NULL UNIQUE,
    project            TEXT NOT NULL,
    primary_thread_ext TEXT,
    source             TEXT NOT NULL DEFAULT 'manual',
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_page_registry_source ON page_registry(source);
`);

// ─── URL normalization ────────────────────────────────────────────────────────

/**
 * Parse a page URL the lenient way every other function here needs it.
 *
 * Returns null for anything that isn't an http(s) URL with a host — relative
 * links (`/settings/vault?file=…`), `chrome://`, `file://`, junk. A relative
 * link can't be resolved to a page without guessing a host, and guessing is
 * exactly how a lookup would start claiming pages that aren't ours.
 *
 * Kept separate from normalizePageUrl because the deny list has to see the
 * parts normalization throws away (the query string).
 */
export function parsePageUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Bare `host:8100/x` / `host/x` is accepted as a convenience (that's how
  // Kevin writes a pattern by hand); anything with an explicit non-http(s)
  // scheme is rejected rather than coerced.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) return null;
  if (!hasScheme && trimmed.startsWith('/')) return null;

  let u: URL;
  try {
    u = new URL(hasScheme ? trimmed : `http://${trimmed}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return u;
}

/**
 * The ONE canonical form every comparison happens in: `host[:port]/path`, with
 *   - the scheme dropped (http vs https is never a different page here),
 *   - the host lowercased (hosts are case-insensitive; PATHS ARE NOT, and are
 *     deliberately left as-is so `/Goals` and `/goals` stay distinct),
 *   - default ports dropped (`:80`/`:443`),
 *   - query string and hash dropped,
 *   - any trailing slash stripped (`host/` → `host`, `host/a/` → `host/a`).
 *
 * Null for anything parsePageUrl refuses.
 */
export function normalizePageUrl(raw: unknown): string | null {
  const u = parsePageUrl(raw);
  if (!u) return null;

  const host = u.host.toLowerCase(); // URL already drops :80/:443
  let path = u.pathname;
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '/') path = '';
  return `${host}${path}`;
}

// ─── THE DENY LIST — the safety gate (tree-b0198a82, node #1584) ─────────────
//
// Hosts and endpoints the companion must NEVER ask about. This table is the ONE
// source of truth for "may this page ever be looked up or registered", and it is
// mirrored byte-for-byte in page-companion-extension/src/config.js (and, because
// MV3 content scripts can't import, once more inline in content.js between
// `deny-mirror:begin/end` sentinels). All three copies are proven identical by
// scripts/page-companion-check.mjs and page-companion-extension/test/deny.test.mjs
// — do not edit one without the others.
//
// A denied URL answers the ordinary `ours:false` miss. Never an error, never a
// distinct status: the extension asks about every page Kevin opens, so a deny
// that looked different from a miss would itself be a signal about the page.

/**
 * Hub 1.0 — permanently out of scope (Kevin, 2026-10-09). Page-to-chat mapping
 * has no value where the chats are about breakage and running numbers rather
 * than editing the page, AND ~51 Hub 1.0 pages WRITE TO THE LIVE DB on a bare
 * `?param=` GET.
 *
 * 🔴 EXACT HOSTNAME MATCHES, NOT A DOMAIN SUFFIX. `intake.thedarwinhub.com`,
 * `staging.intake.thedarwinhub.com` and `accounting.thedarwinhub.com` are
 * subdomains of `thedarwinhub.com` and are the whole point of this tree — they
 * are IN SCOPE. An `endsWith('thedarwinhub.com')` check here kills the feature.
 * Port is irrelevant to the match (same origin, different listener).
 */
export const DENIED_HOSTS: readonly string[] = ['thedarwinhub.com', 'www.thedarwinhub.com'];

/**
 * Denied on EVERY host: the live lead/click machinery and the internal APIs.
 * Matched on a path-segment boundary — `/track` and `/track/…` are denied,
 * `/tracking-dashboard` is not.
 */
export const DENIED_PATH_PREFIXES: readonly string[] = ['/track', '/api'];

/**
 * Any URL carrying a query string is denied, on every host. Hub-family admin
 * pages write on a bare `?param=` GET, and the canonical page key drops the
 * query anyway — so the registry can never key off one, and refusing to ask is
 * free. Cost worth knowing: a dashboard reached as `…/leaks?brand=x` loses its
 * companion button until Kevin navigates to the query-free URL. Narrowing this
 * to a host list later is a one-line change here plus the two mirrors.
 */
export const DENY_ANY_QUERY_STRING = true;

/** Exact-host deny check (see the DENIED_HOSTS warning). Case-insensitive. */
export function isDeniedHost(hostname: unknown): boolean {
  if (typeof hostname !== 'string') return false;
  const h = hostname.trim().toLowerCase().replace(/\.$/, '');
  return DENIED_HOSTS.includes(h);
}

/** Path-prefix deny check, on a segment boundary. */
export function isDeniedPath(pathname: unknown): boolean {
  if (typeof pathname !== 'string') return false;
  const p = pathname.toLowerCase();
  return DENIED_PATH_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

/**
 * Is this URL denied? True for anything the companion must not touch, INCLUDING
 * anything parsePageUrl refuses (rule (d): non-http(s) and unparseable URLs stay
 * refused), so a single `isDeniedPageUrl` call is a complete gate.
 */
export function isDeniedPageUrl(raw: unknown): boolean {
  const u = parsePageUrl(raw);
  if (!u) return true;
  if (isDeniedHost(u.hostname)) return true;
  if (isDeniedPath(u.pathname)) return true;
  if (DENY_ANY_QUERY_STRING && u.search) return true;
  return false;
}

/**
 * Same rules applied to a registry PATTERN (`host/x`, `host/x*`, `host/*`).
 * The trailing wildcard is stripped before the check, so `…/track*` is denied
 * by the `/track` rule. This is what makes the deny list the one source of
 * truth for "may this ever be registered" — a denied page cannot be registered
 * by hand later either.
 */
export function isDeniedPagePattern(raw: unknown): boolean {
  if (typeof raw !== 'string') return true;
  const trimmed = raw.trim();
  const base = trimmed.endsWith('*') ? trimmed.slice(0, -1) : trimmed;
  // `host/*` strips to `host/` — a bare host root, which is not itself denied.
  const probe = base.length > 1 && base.endsWith('/') ? base.slice(0, -1) : base;
  return isDeniedPageUrl(probe);
}

/** True when a thread_links row is the cockpit's vault-viewer link rather than
 *  a real page (`/settings/vault?file=…`, absolute or relative). Those point at
 *  wiki markdown, never at a built page, so they must never make a page ours. */
export function isVaultViewerLink(raw: string): boolean {
  const s = raw.trim();
  if (/^\/settings\/vault(\/|\?|$)/i.test(s)) return true;
  try {
    const u = new URL(s);
    return /^\/settings\/vault(\/|\?|$)/i.test(u.pathname + (u.search ? '?' : ''));
  } catch {
    return false;
  }
}

/** Normalize a thread_links URL into a page key, or null if it isn't a page. */
export function pageKeyFromThreadLink(raw: string): string | null {
  if (isVaultViewerLink(raw)) return null;
  return normalizePageUrl(raw);
}

/** Canonical stored form of a registry pattern. `…/*` keeps its wildcard; the
 *  rest is normalized like any URL. Returns null if the base isn't a page URL. */
export function normalizePagePattern(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.endsWith('*')) return normalizePageUrl(trimmed);
  const base = trimmed.slice(0, -1);
  const boundary = base.endsWith('/');
  const normBase = normalizePageUrl(base);
  if (!normBase) return null;
  return boundary ? `${normBase}/*` : `${normBase}*`;
}

/**
 * Does `normalizedUrl` fall under `pattern` (a value already in canonical
 * stored form)? Two wildcard shapes, both deliberate:
 *   `host:8100/*`      → the host itself and everything under it (segment
 *                        boundary — will NOT match a different host).
 *   `host/dash*`       → a raw string prefix (`/dashboard` matches), for the
 *                        occasional "every URL starting with this" row.
 */
export function pagePatternMatches(pattern: string, normalizedUrl: string): boolean {
  if (!pattern.endsWith('*')) return pattern === normalizedUrl;
  if (pattern.endsWith('/*')) {
    const base = pattern.slice(0, -2);
    return normalizedUrl === base || normalizedUrl.startsWith(`${base}/`);
  }
  return normalizedUrl.startsWith(pattern.slice(0, -1));
}

// ─── Registry CRUD ────────────────────────────────────────────────────────────

const listRegistryStmt = sqliteDb.prepare<[], PageRegistryRow>(
  `SELECT id, url_pattern, project, primary_thread_ext, source, created_at, updated_at
     FROM page_registry ORDER BY url_pattern ASC`,
);
const getRegistryByPatternStmt = sqliteDb.prepare<[string], PageRegistryRow>(
  `SELECT id, url_pattern, project, primary_thread_ext, source, created_at, updated_at
     FROM page_registry WHERE url_pattern = ?`,
);
const insertRegistryStmt = sqliteDb.prepare<[string, string, string | null, string]>(
  `INSERT INTO page_registry (url_pattern, project, primary_thread_ext, source)
   VALUES (?, ?, ?, ?)`,
);
const updateRegistryStmt = sqliteDb.prepare<[string, string | null, string, number]>(
  `UPDATE page_registry
      SET project = ?, primary_thread_ext = ?, source = ?, updated_at = datetime('now')
    WHERE id = ?`,
);

export function listPageRegistry(): PageRegistryRow[] {
  return listRegistryStmt.all();
}

export class PageCompanionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** Add-or-update one registry row, keyed on the canonical pattern. Idempotent:
 *  re-registering the same pattern updates the project/owner instead of
 *  stacking a duplicate. */
export function upsertPageRegistry(input: {
  url_pattern: string;
  project: string;
  primary_thread_ext?: string | null;
  source?: PageRegistrySource | string;
}): PageRegistryRow {
  const pattern = normalizePagePattern(input.url_pattern);
  if (!pattern) {
    throw new PageCompanionError(400, 'invalid_url_pattern', `not a usable page URL/pattern: ${input.url_pattern}`);
  }
  // The deny list is the one source of truth for "may this ever be registered",
  // so a denied host/path cannot be stored by hand either. Checked on the RAW
  // input, not the canonical pattern, so a pattern typed with a query string is
  // refused rather than silently stripped. A distinct code here (unlike the
  // lookup) because this caller is Kevin or JARVIS registering a page on
  // purpose — a silent no-op would be worse than a plain refusal.
  if (isDeniedPagePattern(input.url_pattern)) {
    throw new PageCompanionError(
      400,
      'denied_url_pattern',
      `refused by the page-companion deny list: ${input.url_pattern}`,
    );
  }
  const project = (input.project ?? '').trim();
  if (!project) throw new PageCompanionError(400, 'invalid_project', 'project is required');
  const source = (input.source ?? 'manual').trim() || 'manual';
  const owner = input.primary_thread_ext?.trim() || null;

  const existing = getRegistryByPatternStmt.get(pattern);
  if (existing) {
    updateRegistryStmt.run(project, owner ?? existing.primary_thread_ext, source, existing.id);
    return getRegistryByPatternStmt.get(pattern)!;
  }
  insertRegistryStmt.run(pattern, project, owner, source);
  return getRegistryByPatternStmt.get(pattern)!;
}

/** Most specific registry row covering this normalized URL: longest pattern
 *  wins, and an exact row always beats a wildcard of the same length. */
export function matchPageRegistry(normalizedUrl: string): PageRegistryRow | null {
  let best: PageRegistryRow | null = null;
  let bestScore = -1;
  for (const row of listRegistryStmt.all()) {
    if (!pagePatternMatches(row.url_pattern, normalizedUrl)) continue;
    const score = row.url_pattern.endsWith('*')
      ? row.url_pattern.length * 2
      : row.url_pattern.length * 2 + 1;
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return best;
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

// Every thread link, newest row first. The table is one row per link set on a
// thread (hundreds, not millions), so normalizing in JS beats trying to express
// the normalization in SQL.
const allThreadLinksStmt = sqliteDb.prepare<[], { conversation_id: number; url: string }>(
  `SELECT conversation_id, url FROM thread_links ORDER BY id DESC`,
);

// Last activity = the newest turn, falling back to the conversation row's own
// updated_at for a thread that has no turns yet (a brand-new page chat).
// MAX() aggregate, never a SELECT * over turns.
const lastTurnAtStmt = sqliteDb.prepare<[number], { t: string | null }>(
  `SELECT MAX(created_at) AS t FROM turns WHERE conversation_id = ?`,
);

/** Conversations we never surface on a page: throwaways and system plumbing. */
function isListableConversationExt(externalId: string): boolean {
  if (externalId.startsWith('ephemeral:')) return false;
  if (externalId.startsWith('checkin:')) return false;
  return true;
}

function describeThread(conversationId: number): PageCompanionThread | null {
  const conv = getConversationById(conversationId);
  if (!conv) return null;
  if (!isListableConversationExt(conv.external_id)) return null;
  // The newest turn IS the activity. Falling back to the conversation row's
  // updated_at (rather than taking the max of the two) keeps a metadata write
  // — a rename, a group move — from floating a silent thread to the top.
  const lastTurn = lastTurnAtStmt.get(conversationId)?.t ?? null;
  return {
    external_id: conv.external_id,
    title: conv.title ?? null,
    last_active: lastTurn ?? conv.updated_at,
  };
}

/** Conversation ids whose thread_links point at this exact page. */
export function threadIdsLinkedToPage(normalizedUrl: string): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const row of allThreadLinksStmt.all()) {
    const key = pageKeyFromThreadLink(row.url);
    if (key !== normalizedUrl) continue;
    if (seen.has(row.conversation_id)) continue;
    seen.add(row.conversation_id);
    ids.push(row.conversation_id);
  }
  return ids;
}

/**
 * The endpoint's whole answer. `ours` is true when the registry claims the URL
 * OR at least one chat has linked it — either way Kevin has something to talk
 * to about this page.
 */
export function lookupPage(rawUrl: unknown): PageCompanionLookup {
  // THE DENY GATE, before the registry or thread_links is consulted. A denied
  // URL gets the same `ours:false` / `normalized_url:null` answer a chrome://
  // page gets — indistinguishable from an ordinary miss, by design, and nothing
  // downstream ever sees a canonical key for a page we refuse.
  if (isDeniedPageUrl(rawUrl)) {
    return { ours: false, project: null, registry_id: null, threads: [], normalized_url: null };
  }
  const normalized = normalizePageUrl(rawUrl);
  if (!normalized) {
    return { ours: false, project: null, registry_id: null, threads: [], normalized_url: null };
  }

  const registry = matchPageRegistry(normalized);
  const ids: number[] = [];
  const seen = new Set<number>();

  // The registry row's owning chat comes first in the union; ordering below is
  // by activity anyway, this just makes sure it's never dropped.
  if (registry?.primary_thread_ext) {
    const owner = getConversation(registry.primary_thread_ext);
    if (owner && !seen.has(owner.id)) {
      seen.add(owner.id);
      ids.push(owner.id);
    }
  }
  const linked = threadIdsLinkedToPage(normalized);
  for (const id of linked) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  const threads = ids
    .map(describeThread)
    .filter((t): t is PageCompanionThread => t !== null)
    .sort((a, b) =>
      a.last_active === b.last_active
        ? a.external_id.localeCompare(b.external_id) // deterministic tie-break
        : a.last_active < b.last_active ? 1 : -1,
    );

  return {
    ours: registry != null || threads.length > 0,
    project: registry?.project ?? null,
    registry_id: registry?.id ?? null,
    threads,
    normalized_url: normalized,
  };
}

// ─── New chat scoped to a page ────────────────────────────────────────────────

function composePageChatContext(pageUrl: string, project: string | null): string {
  return [
    `🧩 This thread is scoped to ONE page: ${pageUrl}`,
    project ? `Project: ${project}` : null,
    '',
    'It was opened from the Page Companion button on that page, so when Kevin asks for a',
    'change here he means that page — find whatever built it before assuming anything.',
    'Links set on this thread keep it listed on the page for next time.',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

export interface NewPageChatResult {
  external_id: string;
  conversation_id: number;
  project: string | null;
  page_url: string;
  created: boolean;
}

/**
 * Start a fresh cockpit chat pinned to a page. The pin is written as an
 * assistant turn (like teams-radar's catch chats) rather than sent as a user
 * message — there is nothing for a model to answer yet, so opening a chat
 * costs zero model calls. The thread_links row is written immediately so the
 * next lookup on that page lists this chat.
 */
export function createPageChat(rawUrl: unknown, project?: unknown): NewPageChatResult {
  // Same deny gate as the lookup, and deliberately the SAME error a bad URL
  // gets — a page chat writes a thread_links row, which is exactly how a page
  // would otherwise auto-register itself on the next seed.
  const normalized = isDeniedPageUrl(rawUrl) ? null : normalizePageUrl(rawUrl);
  if (!normalized) {
    throw new PageCompanionError(400, 'invalid_url', 'url must be an http(s) page URL');
  }
  // Keep the caller's absolute URL for display/linking, but fall back to a
  // canonical http:// form when they handed us a bare host/path.
  const pageUrl =
    typeof rawUrl === 'string' && /^https?:\/\//i.test(rawUrl.trim())
      ? rawUrl.trim()
      : `http://${normalized}`;

  const explicitProject = typeof project === 'string' && project.trim() ? project.trim() : null;
  const resolvedProject = explicitProject ?? matchPageRegistry(normalized)?.project ?? null;

  const externalId = `cockpit:page-${randomUUID()}`;
  const conv = getOrCreateConversation(externalId);
  renameConversation(conv.id, `${resolvedProject ?? normalized} · page chat`.slice(0, 120));
  addTurn(conv.id, 'assistant', composePageChatContext(pageUrl, resolvedProject));
  setPreviewLink(conv.id, pageUrl, resolvedProject ?? 'This page');

  return {
    external_id: externalId,
    conversation_id: conv.id,
    project: resolvedProject,
    page_url: pageUrl,
    created: true,
  };
}

// ─── Seeding ──────────────────────────────────────────────────────────────────

/** The dashboards Kevin named by hand (spec of node #1574). Patterns, so every
 *  page under each host counts as ours. */
export const MANUAL_PAGE_REGISTRY_SEED: ReadonlyArray<{ url_pattern: string; project: string }> = [
  { url_pattern: 'http://192.168.1.25:8100/*', project: 'Hub 1.0 Heartbeat' },
  { url_pattern: 'http://192.168.1.25:8095/*', project: 'Restore Matrix + Leaks' },
  { url_pattern: 'http://192.168.1.25:8094/*', project: 'Circle & Flip' },
  { url_pattern: 'http://192.168.1.25:8090/*', project: 'Engine Docs' },
];

const linkLabelStmt = sqliteDb.prepare<[], { conversation_id: number; url: string; label: string | null }>(
  `SELECT conversation_id, url, label FROM thread_links ORDER BY id ASC`,
);

export interface PageRegistrySeedResult {
  manual_added: number;
  auto_added: number;
  skipped_covered: number;
}

/**
 * Back-fill the registry. Safe to run on every boot:
 *   - the manual rows are upserted by pattern (no duplicates, ever),
 *   - auto rows are added only for thread_links pages NOT already covered by a
 *     row (so `…:8100/*` stops a hundred per-page auto rows appearing under it).
 * Never deletes or rewrites a manual row's project name.
 */
export function seedPageRegistry(): PageRegistrySeedResult {
  let manualAdded = 0;
  for (const row of MANUAL_PAGE_REGISTRY_SEED) {
    if (isDeniedPagePattern(row.url_pattern)) continue; // a denied seed row never boots
    const pattern = normalizePagePattern(row.url_pattern)!;
    if (getRegistryByPatternStmt.get(pattern)) continue;
    upsertPageRegistry({ ...row, source: 'manual' });
    manualAdded += 1;
  }

  let autoAdded = 0;
  let skippedCovered = 0;
  const handled = new Set<string>();
  for (const link of linkLabelStmt.all()) {
    const key = pageKeyFromThreadLink(link.url);
    if (!key || handled.has(key)) continue;
    // A denied page must not auto-register off a stray thread link. Checked on
    // the raw link too, so a `?param=` link is skipped and not just its key.
    if (isDeniedPageUrl(link.url) || isDeniedPageUrl(key)) continue;
    handled.add(key);
    if (matchPageRegistry(key)) {
      skippedCovered += 1;
      continue;
    }
    const conv = getConversationById(link.conversation_id);
    const project = link.label?.trim() || conv?.title?.trim() || key;
    upsertPageRegistry({
      url_pattern: key,
      project,
      primary_thread_ext: conv?.external_id ?? null,
      source: 'thread_links_auto',
    });
    autoAdded += 1;
  }

  return { manual_added: manualAdded, auto_added: autoAdded, skipped_covered: skippedCovered };
}
