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
 * The ONE canonical form every comparison happens in: `host[:port]/path`, with
 *   - the scheme dropped (http vs https is never a different page here),
 *   - the host lowercased (hosts are case-insensitive; PATHS ARE NOT, and are
 *     deliberately left as-is so `/Goals` and `/goals` stay distinct),
 *   - default ports dropped (`:80`/`:443`),
 *   - query string and hash dropped,
 *   - any trailing slash stripped (`host/` → `host`, `host/a/` → `host/a`).
 *
 * Returns null for anything that isn't an http(s) URL with a host — relative
 * links (`/settings/vault?file=…`), `chrome://`, `file://`, junk. A relative
 * link can't be resolved to a page without guessing a host, and guessing is
 * exactly how a lookup would start claiming pages that aren't ours.
 */
export function normalizePageUrl(raw: unknown): string | null {
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

  const host = u.host.toLowerCase(); // URL already drops :80/:443
  let path = u.pathname;
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '/') path = '';
  return `${host}${path}`;
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
  const normalized = normalizePageUrl(rawUrl);
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
