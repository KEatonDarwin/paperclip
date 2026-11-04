import Database, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';
import { sqliteDb } from './conversation-db.js';

// Find Any Chat (overnight 2026-10-12) — a full-text index over every chat,
// kept in a SIDECAR database next to jarvis.db (jarvis-search.db) so nothing
// in jarvis.db changes: no triggers, no new tables, no schema edits. Turns are
// append-only, so the index catches up from a watermark (the highest turn id
// already indexed) each time a search runs. Deleting jarvis-search.db is a
// complete rollback; the next search rebuilds it from scratch.
//
// Row ids in turns_fts:
//   > 0            the turn with that id (user/assistant text)
//   -(2*conv)      that conversation's title
//   -(2*conv + 1)  that conversation's latest thread summary
// so a re-titled thread or a newer summary replaces its row by rowid.

const BATCH = 2000;

let searchDb: DatabaseType | null = null;

export function searchDbPath(): string {
  return path.join(path.dirname(sqliteDb.name), 'jarvis-search.db');
}

function openSearchDb(): DatabaseType {
  if (searchDb) return searchDb;
  const db = new Database(searchDbPath());
  try {
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(
        conversation_id UNINDEXED,
        turn_id UNINDEXED,
        role UNINDEXED,
        content
      );
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);
  } catch (err) {
    db.close();
    throw err;
  }
  searchDb = db;
  return db;
}

/** Close the sidecar handle (tests; also lets a deleted file be recreated). */
export function closeSearchDb(): void {
  searchDb?.close();
  searchDb = null;
}

function getMeta(db: DatabaseType, key: string): string | null {
  const row = db.prepare<[string], { value: string | null }>(`SELECT value FROM meta WHERE key = ?`).get(key);
  return row?.value ?? null;
}

function setMeta(db: DatabaseType, key: string, value: string | number): void {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, String(value));
}

const NOT_THROWAWAY = `c.external_id NOT LIKE 'ephemeral:%' AND c.external_id NOT LIKE 'checkin:%'`;

export interface CatchUpStats {
  turns: number;
  titles: number;
  summaries: number;
  lastTurnId: number;
  lastSummaryId?: number;
}

/**
 * Bring the sidecar index up to date with jarvis.db. Indexes user/assistant
 * turns past the watermark, conversations whose updated_at moved (title
 * changes), and summaries past their own watermark — each in batches of 2000.
 * Throws if the sidecar can't be opened/written; callers fall back.
 */
export function catchUp(): CatchUpStats {
  const db = openSearchDb();
  const stats: CatchUpStats = { turns: 0, titles: 0, summaries: 0, lastTurnId: 0 };

  const del = db.prepare<[number]>(`DELETE FROM turns_fts WHERE rowid = ?`);
  const ins = db.prepare<[number, number, number | null, string, string]>(
    `INSERT INTO turns_fts (rowid, conversation_id, turn_id, role, content) VALUES (?, ?, ?, ?, ?)`,
  );

  // 1. Turns past the watermark.
  let last = Number(getMeta(db, 'last_turn_id') ?? 0);
  // Page over RAW turn ids and advance the watermark past every row scanned —
  // kept or not. Filtering in the WHERE would leave the watermark stuck behind a
  // tail of tool/ephemeral/checkin turns, so every search would rescan it.
  // Skipped rows carry no content (it's never read for them).
  const turnBatch = sqliteDb.prepare<[number, number], { id: number; conversation_id: number; role: string; content: string | null; keep: number }>(
    `SELECT t.id, t.conversation_id, t.role,
            CASE WHEN t.role IN ('user', 'assistant') AND c.id IS NOT NULL AND ${NOT_THROWAWAY}
                 THEN t.content END AS content,
            CASE WHEN t.role IN ('user', 'assistant') AND c.id IS NOT NULL AND ${NOT_THROWAWAY}
                 THEN 1 ELSE 0 END AS keep
       FROM turns t LEFT JOIN conversations c ON c.id = t.conversation_id
      WHERE t.id > ?
      ORDER BY t.id LIMIT ?`,
  );
  for (;;) {
    const rows = turnBatch.all(last, BATCH);
    if (!rows.length) break;
    db.transaction(() => {
      for (const r of rows) {
        if (r.keep && r.content && r.content.trim()) {
          del.run(r.id);
          ins.run(r.id, r.conversation_id, r.id, r.role, r.content);
          stats.turns += 1;
        }
      }
      last = rows[rows.length - 1].id;
      setMeta(db, 'last_turn_id', last);
    })();
    if (rows.length < BATCH) break;
  }
  stats.lastTurnId = last;

  // 2. Titles — any conversation touched since the last pass (a rename bumps
  //    updated_at). The cursor is (updated_at, id) so equal timestamps page.
  //    Each pass starts 2s BEFORE the stored watermark (id cursor reset):
  //    updated_at has 1-second resolution, so a chat renamed in the same
  //    second as the watermark row but with a lower id would otherwise be
  //    skipped forever. Re-indexing a title is an idempotent replace.
  const storedAt = getMeta(db, 'conv_updated_at') ?? '';
  let convAt = storedAt
    ? sqliteDb.prepare<[string], { at: string | null }>(`SELECT datetime(?, '-2 seconds') AS at`).get(storedAt)?.at ?? storedAt
    : '';
  let convId = 0;
  const convBatch = sqliteDb.prepare<[string, string, number, number], { id: number; title: string | null; updated_at: string }>(
    `SELECT c.id, c.title, c.updated_at FROM conversations c
      WHERE (c.updated_at > ? OR (c.updated_at = ? AND c.id > ?)) AND ${NOT_THROWAWAY}
      ORDER BY c.updated_at, c.id LIMIT ?`,
  );
  for (;;) {
    const rows = convBatch.all(convAt, convAt, convId, BATCH);
    if (!rows.length) break;
    db.transaction(() => {
      for (const r of rows) {
        del.run(-2 * r.id);
        if (r.title && r.title.trim()) {
          ins.run(-2 * r.id, r.id, null, 'title', r.title);
          stats.titles += 1;
        }
      }
      convAt = rows[rows.length - 1].updated_at;
      convId = rows[rows.length - 1].id;
      setMeta(db, 'conv_updated_at', convAt);
      setMeta(db, 'conv_id', convId);
    })();
    if (rows.length < BATCH) break;
  }

  // 3. Latest summary per conversation — summaries are append-only, so a new
  //    one replaces the conversation's summary row.
  let lastSummary = Number(getMeta(db, 'last_summary_id') ?? 0);
  let summaryBatch;
  try {
    // Raw summary ids, like turns: the watermark must move past skipped rows too.
    summaryBatch = sqliteDb.prepare<[number, number], { id: number; conversation_id: number; content: string | null; keep: number }>(
      `SELECT s.id, s.conversation_id,
              CASE WHEN c.id IS NOT NULL AND ${NOT_THROWAWAY} THEN s.content END AS content,
              CASE WHEN c.id IS NOT NULL AND ${NOT_THROWAWAY} THEN 1 ELSE 0 END AS keep
         FROM thread_summaries s LEFT JOIN conversations c ON c.id = s.conversation_id
        WHERE s.id > ?
        ORDER BY s.id LIMIT ?`,
    );
  } catch {
    summaryBatch = null; // thread_summaries not created yet (fresh scratch DB)
  }
  while (summaryBatch) {
    const rows = summaryBatch.all(lastSummary, BATCH);
    if (!rows.length) break;
    db.transaction(() => {
      for (const r of rows) {
        if (!r.keep || !r.content) continue;
        del.run(-2 * r.conversation_id - 1);
        ins.run(-2 * r.conversation_id - 1, r.conversation_id, null, 'summary', r.content);
        stats.summaries += 1;
      }
      lastSummary = rows[rows.length - 1].id;
      setMeta(db, 'last_summary_id', lastSummary);
    })();
    if (rows.length < BATCH) break;
  }

  stats.lastSummaryId = lastSummary;
  return stats;
}

/** Turn Kevin's free-form words into a safe FTS5 query: every word quoted
 *  (so punctuation can't be a syntax error), prefix-matched, OR'd and ranked
 *  by bm25 — a paragraph-style query still ranks the chat that has the most
 *  of its rarer words first. Returns null when there's nothing to match. */
export function toFtsQuery(q: string): string | null {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 2);
  const unique = [...new Set(words)].slice(0, 32);
  if (!unique.length) return null;
  return unique.map((w) => (w.length >= 3 ? `"${w}"*` : `"${w}"`)).join(' OR ');
}

export interface SearchCandidate {
  conversationId: number;
  snippet: string;
  /** created_at of the newest role='user' turn in the chat (null = none). */
  lastUserAt: string | null;
}

/**
 * Best-matching chats for `q`, best first, one entry per chat. `before` /
 * `after` (ISO or 'YYYY-MM-DD HH:MM:SS') filter on the chat's newest USER
 * turn — "when did I last touch it", not updated_at (which JARVIS's own
 * replies and background jobs bump). `prefix` keeps only chats whose
 * external_id starts with it — applied before `limit`, so a non-admin caller
 * gets up to `limit` of ITS OWN chats, not 40 hits it then can't see.
 */
export function searchCandidates(
  q: string,
  opts: { limit?: number; before?: string | null; after?: string | null; prefix?: string | null } = {},
): SearchCandidate[] {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 40));
  const match = toFtsQuery(q);
  if (!match) return [];
  const db = openSearchDb();
  const before = normalizeTs(opts.before);
  const after = normalizeTs(opts.after);

  // Date filters can discard many top hits, so scan deeper when one is set.
  const scan = before || after ? 20000 : 4000;
  const hits = db.prepare<[string, number], { conversation_id: number; snip: string }>(
    `SELECT conversation_id, snippet(turns_fts, 3, '', '', '…', 16) AS snip
       FROM turns_fts WHERE turns_fts MATCH ? ORDER BY rank LIMIT ?`,
  ).iterate(match, scan);

  const out: SearchCandidate[] = [];
  const seen = new Set<number>();
  for (const h of hits) {
    const id = Number(h.conversation_id);
    if (seen.has(id)) continue;
    seen.add(id);
    // A chat deleted from jarvis.db still has rows in the sidecar; skip it here so it
    // can't take one of the `limit` slots from a live chat.
    const ext = externalIdOf(id);
    if (!ext) continue;
    if (opts.prefix && !ext.startsWith(opts.prefix)) continue;
    const lastUserAt = lastUserTurnAt(id);
    if (!inDateWindow(lastUserAt, before, after)) continue;
    out.push({ conversationId: id, snippet: h.snip.replace(/\s+/g, ' ').trim(), lastUserAt });
    if (out.length >= limit) break;
  }
  return out;
}

function externalIdOf(conversationId: number): string | null {
  return sqliteDb
    .prepare<[number], { external_id: string }>(`SELECT external_id FROM conversations WHERE id = ?`)
    .get(conversationId)?.external_id ?? null;
}

/** created_at of the newest role='user' turn in a chat, read from jarvis.db
 *  (works without the sidecar, so the fallback path can show it too). */
export function lastUserTurnAt(conversationId: number): string | null {
  return sqliteDb
    .prepare<[number], { at: string | null }>(
      `SELECT MAX(created_at) AS at FROM turns WHERE conversation_id = ? AND role = 'user'`,
    )
    .get(conversationId)?.at ?? null;
}

function inDateWindow(lastUserAt: string | null, before: string | null, after: string | null): boolean {
  if (before && !(lastUserAt && lastUserAt < before)) return false;
  if (after && !(lastUserAt && lastUserAt > after)) return false;
  return true;
}

/** The subset of `ids` whose newest user turn falls inside before/after —
 *  jarvis.db only, so the no-sidecar fallback can honour a date window too. */
export function filterByLastUserTurn(
  ids: number[],
  opts: { before?: string | null; after?: string | null },
): Set<number> {
  const before = normalizeTs(opts.before);
  const after = normalizeTs(opts.after);
  return new Set(ids.filter((id) => inDateWindow(lastUserTurnAt(id), before, after)));
}

/** turns.created_at is SQLite datetime('now') — 'YYYY-MM-DD HH:MM:SS' UTC.
 *  Accept that, a bare date, or any Date-parseable ISO string. */
function normalizeTs(v: string | null | undefined): string | null {
  if (!v || !String(v).trim()) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(s)) return s.length === 10 ? `${s} 00:00:00` : s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
