// SHARED CONTEXT v0 §2 — recall (docs/shared-context/CONTRACT.md). A keyword
// search across everything JARVIS + Kevin have already done: other threads
// (summaries, titles, recent turns), hopper trees, goals, workstreams, the
// wiki, and JARVIS's Claude-Code auto-memory. Zero model calls — deterministic
// SQL/file-scan + a simple weighted term-match score. Used by the `recall`
// tool and the `GET /recall` route so a fresh thread (on ANY provider) can
// answer "where does X live?" before asking Kevin.
//
// Import discipline: only ./conversation-db.js + ./shared-context.js
// (isSharedNowEligibleThread, for excluding worker/ephemeral threads from
// thread-shaped hits) + node built-ins. Never imports agent.ts.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sqliteDb } from './conversation-db.js';
import { isSharedNowEligibleThread } from './shared-context.js';

export type RecallSource =
  | 'thread_summary'
  | 'thread_title'
  | 'turn'
  | 'tree'
  | 'goal'
  | 'workstream'
  | 'wiki'
  | 'auto_memory';

export interface RecallHit {
  source: RecallSource;
  ref: string;
  title: string;
  snippet: string;
  when: string;
  score: number;
}

export interface RecallOptions {
  days?: number;
  limit?: number;
  sources?: RecallSource[];
}

const ALL_SOURCES: RecallSource[] = [
  'thread_summary',
  'thread_title',
  'turn',
  'tree',
  'goal',
  'workstream',
  'wiki',
  'auto_memory',
];

// Weight per source occurrence, per CONTRACT §2.1.
const SOURCE_WEIGHT: Record<RecallSource, number> = {
  thread_summary: 3,
  tree: 3,
  goal: 2,
  workstream: 2,
  thread_title: 2,
  wiki: 2,
  auto_memory: 2,
  turn: 1,
};

const VAULT_ROOT = '/home/kevin/obsidian/paperclip-wiki';
const WIKI_SEARCH_DIRS = ['agent-memory', 'skills', 'outbox', 'kevin'];
const AUTO_MEMORY_DIR_DEFAULT =
  '/home/kevin/.claude/projects/-home-kevin--jarvis-cli-workspace/memory';
const WIKI_FILE_MAX_BYTES = 512 * 1024;

// -- FTS5 detection / turns index ----------------------------------------------

let recallMode: 'fts5' | 'like' | null = null;

function tableExists(name: string): boolean {
  try {
    const row = sqliteDb
      .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table','view') AND name = ?`)
      .get(name) as { n: number } | undefined;
    return !!row && row.n > 0;
  } catch {
    return false;
  }
}

/** Idempotent. Creates turns_fts + sync triggers if FTS5 is supported; falls
 * back to 'like' mode permanently (never retries) if the CREATE VIRTUAL TABLE
 * throws. JARVIS_RECALL_FORCE_LIKE=1 forces 'like' without even trying FTS5
 * (used by the sim to exercise both code paths deterministically). */
export function ensureTurnsFts(): { mode: 'fts5' | 'like' } {
  if (recallMode) return { mode: recallMode };
  if (process.env.JARVIS_RECALL_FORCE_LIKE === '1') {
    recallMode = 'like';
    return { mode: recallMode };
  }
  if (!tableExists('turns')) {
    // Scratch DB that hasn't loaded conversation-db's schema yet — don't
    // permanently wedge into 'like'; let a later call retry once turns exists.
    return { mode: 'like' };
  }
  const existedBefore = tableExists('turns_fts');
  try {
    sqliteDb.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS turns_fts USING fts5(content, content='turns', content_rowid='id')`,
    );
    sqliteDb.exec(`
      CREATE TRIGGER IF NOT EXISTS turns_ai AFTER INSERT ON turns BEGIN
        INSERT INTO turns_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
    sqliteDb.exec(`
      CREATE TRIGGER IF NOT EXISTS turns_ad AFTER DELETE ON turns BEGIN
        INSERT INTO turns_fts(turns_fts, rowid, content) VALUES('delete', old.id, old.content);
      END;
    `);
    sqliteDb.exec(`
      CREATE TRIGGER IF NOT EXISTS turns_au AFTER UPDATE ON turns BEGIN
        INSERT INTO turns_fts(turns_fts, rowid, content) VALUES('delete', old.id, old.content);
        INSERT INTO turns_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
    if (!existedBefore) {
      sqliteDb.exec(`INSERT INTO turns_fts(turns_fts) VALUES('rebuild')`);
    }
    recallMode = 'fts5';
  } catch (err) {
    console.warn('[recall] FTS5 unavailable, falling back to LIKE search:', err instanceof Error ? err.message : err);
    recallMode = 'like';
  }
  return { mode: recallMode };
}

export function getRecallIndexMode(): 'fts5' | 'like' {
  return ensureTurnsFts().mode;
}

// Best-effort at module load so the first real recall() call doesn't pay the
// (one-time, idempotent) CREATE/rebuild cost.
try {
  ensureTurnsFts();
} catch {
  // ignored — recall() retries lazily via ensureTurnsFts() on first call.
}

// -- text helpers ---------------------------------------------------------------

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function matchesAllTerms(haystack: string, terms: string[]): boolean {
  const lower = haystack.toLowerCase();
  return terms.every((t) => lower.includes(t));
}

function countOccurrences(haystack: string, term: string): number {
  if (!term) return 0;
  const lower = haystack.toLowerCase();
  let count = 0;
  let idx = 0;
  while ((idx = lower.indexOf(term, idx)) !== -1) {
    count++;
    idx += term.length;
  }
  return count;
}

function scoreText(haystack: string, terms: string[], weight: number): number {
  let n = 0;
  for (const t of terms) n += countOccurrences(haystack, t);
  return n * weight;
}

// SQLite datetime('now') is UTC without a zone marker — parse as UTC. Mirrors
// shared-context.ts's parseSqliteUtc.
function parseWhenMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)
    ? v.replace(' ', 'T') + 'Z'
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v)
      ? v + 'Z'
      : v;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function recencyBonus(when: string | null | undefined): number {
  const ms = parseWhenMs(when);
  if (ms == null) return 0;
  const days = (Date.now() - ms) / 86_400_000;
  if (days <= 7) return 2;
  if (days <= 30) return 1;
  return 0;
}

function buildSnippet(text: string, terms: string[], max = 280): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  const lower = collapsed.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx === -1) return clip(collapsed, max);
  const half = Math.floor(max / 2);
  let start = Math.max(0, idx - half);
  const end = Math.min(collapsed.length, start + max);
  start = Math.max(0, end - max);
  let snippet = collapsed.slice(start, end);
  if (start > 0) snippet = '…' + snippet;
  if (end < collapsed.length) snippet = snippet + '…';
  return snippet.length > max ? clip(snippet, max) : snippet;
}

function firstMatchingText(parts: string[], terms: string[]): string {
  for (const p of parts) {
    if (!p) continue;
    const lower = p.toLowerCase();
    if (terms.some((t) => lower.includes(t))) return p;
  }
  return parts.find((p) => p) ?? '';
}

// -- source collectors ------------------------------------------------------------

function collectThreadSummaryHits(terms: string[]): RecallHit[] {
  if (!tableExists('thread_summaries') || !tableExists('conversations')) return [];
  try {
    const rows = sqliteDb
      .prepare(
        `SELECT s.content, s.created_at, c.external_id, c.title
           FROM thread_summaries s
           JOIN (SELECT conversation_id, MAX(id) AS max_id FROM thread_summaries GROUP BY conversation_id) latest
             ON latest.max_id = s.id
           JOIN conversations c ON c.id = s.conversation_id`,
      )
      .all() as Array<{ content: string; created_at: string; external_id: string; title: string | null }>;
    const hits: RecallHit[] = [];
    for (const r of rows) {
      if (!r.content) continue;
      if (!isSharedNowEligibleThread(r.external_id, { workers: false })) continue;
      if (!matchesAllTerms(r.content, terms)) continue;
      hits.push({
        source: 'thread_summary',
        ref: r.external_id,
        title: r.title ?? r.external_id,
        snippet: buildSnippet(r.content, terms),
        when: r.created_at,
        score: scoreText(r.content, terms, SOURCE_WEIGHT.thread_summary) + recencyBonus(r.created_at),
      });
    }
    return hits;
  } catch (err) {
    console.warn('[recall] thread_summary section failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

function collectThreadTitleHits(terms: string[]): RecallHit[] {
  if (!tableExists('conversations')) return [];
  try {
    const rows = sqliteDb
      .prepare(`SELECT external_id, title, updated_at FROM conversations`)
      .all() as Array<{ external_id: string; title: string | null; updated_at: string }>;
    const hits: RecallHit[] = [];
    for (const r of rows) {
      if (!isSharedNowEligibleThread(r.external_id, { workers: false })) continue;
      const hay = `${r.title ?? ''} ${r.external_id}`;
      if (!matchesAllTerms(hay, terms)) continue;
      hits.push({
        source: 'thread_title',
        ref: r.external_id,
        title: r.title ?? r.external_id,
        snippet: clip(hay, 280),
        when: r.updated_at,
        score: scoreText(hay, terms, SOURCE_WEIGHT.thread_title) + recencyBonus(r.updated_at),
      });
    }
    return hits;
  } catch (err) {
    console.warn('[recall] thread_title section failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

interface TurnCandidate {
  id: number;
  conversation_id: number;
  content: string | null;
  created_at: string;
  role: string;
}

function collectTurnHits(terms: string[], days: number): RecallHit[] {
  if (!tableExists('turns') || !tableExists('conversations')) return [];
  try {
    const mode = ensureTurnsFts().mode;
    const cutoffMs = Date.now() - days * 86_400_000;
    let candidates: TurnCandidate[];
    if (mode === 'fts5' && tableExists('turns_fts')) {
      const ftsQuery = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
      candidates = sqliteDb
        .prepare(
          `SELECT t.id, t.conversation_id, t.content, t.created_at, t.role
             FROM turns_fts f
             JOIN turns t ON t.id = f.rowid
            WHERE turns_fts MATCH ?
            ORDER BY t.id DESC
            LIMIT 200`,
        )
        .all(ftsQuery) as TurnCandidate[];
    } else {
      const conds = terms.map(() => `content LIKE ?`).join(' AND ');
      const params: unknown[] = terms.map((t) => `%${t.replace(/[%_]/g, (m) => `\\${m}`)}%`);
      candidates = sqliteDb
        .prepare(
          `SELECT id, conversation_id, content, created_at, role
             FROM turns
            WHERE ${conds} ESCAPE '\\' AND created_at >= datetime('now', ?)
            ORDER BY id DESC
            LIMIT 200`,
        )
        .all(...params, `-${days} days`) as TurnCandidate[];
    }
    const convStmt = sqliteDb.prepare(`SELECT external_id, title FROM conversations WHERE id = ?`);
    const hits: RecallHit[] = [];
    for (const c of candidates) {
      if (c.role !== 'user' && c.role !== 'assistant') continue;
      if (!c.content) continue;
      const whenMs = parseWhenMs(c.created_at);
      if (whenMs != null && whenMs < cutoffMs) continue;
      const conv = convStmt.get(c.conversation_id) as { external_id: string; title: string | null } | undefined;
      if (!conv) continue;
      if (!isSharedNowEligibleThread(conv.external_id, { workers: false })) continue;
      hits.push({
        source: 'turn',
        ref: conv.external_id,
        title: conv.title ?? conv.external_id,
        snippet: buildSnippet(c.content, terms),
        when: c.created_at,
        score: scoreText(c.content, terms, SOURCE_WEIGHT.turn) + recencyBonus(c.created_at),
      });
    }
    return hits;
  } catch (err) {
    console.warn('[recall] turn section failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

function collectTreeHits(terms: string[]): RecallHit[] {
  if (!tableExists('hopper_trees')) return [];
  try {
    const trees = sqliteDb
      .prepare(`SELECT id, topic, updated_at FROM hopper_trees`)
      .all() as Array<{ id: string; topic: string; updated_at: string }>;
    const hasNodes = tableExists('hopper_nodes');
    const nodesStmt = hasNodes
      ? sqliteDb.prepare(`SELECT title, spec, result FROM hopper_nodes WHERE tree_id = ?`)
      : null;
    const hits: RecallHit[] = [];
    for (const t of trees) {
      const nodes = nodesStmt
        ? (nodesStmt.all(t.id) as Array<{ title: string; spec: string | null; result: string | null }>)
        : [];
      const parts = [t.topic, ...nodes.flatMap((n) => [n.title, n.spec ?? '', n.result ?? ''])];
      const aggregate = parts.join('\n');
      if (!matchesAllTerms(aggregate, terms)) continue;
      hits.push({
        source: 'tree',
        // hopper_trees.id is already the full "tree-xxxxxxxx" string.
        ref: t.id,
        title: t.topic,
        snippet: buildSnippet(firstMatchingText(parts, terms), terms),
        when: t.updated_at,
        score: scoreText(aggregate, terms, SOURCE_WEIGHT.tree) + recencyBonus(t.updated_at),
      });
    }
    return hits;
  } catch (err) {
    console.warn('[recall] tree section failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

function collectGoalHits(terms: string[]): RecallHit[] {
  if (!tableExists('goals')) return [];
  try {
    const hits: RecallHit[] = [];
    const goals = sqliteDb
      .prepare(`SELECT id, title, done_means, notes, updated_at FROM goals WHERE archived = 0`)
      .all() as Array<{ id: number; title: string; done_means: string | null; notes: string | null; updated_at: string }>;
    for (const g of goals) {
      const parts = [g.title, g.done_means ?? '', g.notes ?? ''];
      const aggregate = parts.join('\n');
      if (!matchesAllTerms(aggregate, terms)) continue;
      hits.push({
        source: 'goal',
        ref: `goal-${g.id}`,
        title: g.title,
        snippet: buildSnippet(firstMatchingText(parts, terms), terms),
        when: g.updated_at,
        score: scoreText(aggregate, terms, SOURCE_WEIGHT.goal) + recencyBonus(g.updated_at),
      });
    }
    if (tableExists('goal_nodes')) {
      const nodes = sqliteDb
        .prepare(
          `SELECT id, goal_id, title, done_means, notes, updated_at FROM goal_nodes WHERE state != 'discarded'`,
        )
        .all() as Array<{
        id: number; goal_id: number; title: string; done_means: string | null; notes: string | null; updated_at: string;
      }>;
      for (const n of nodes) {
        const parts = [n.title, n.done_means ?? '', n.notes ?? ''];
        const aggregate = parts.join('\n');
        if (!matchesAllTerms(aggregate, terms)) continue;
        hits.push({
          source: 'goal',
          ref: `goal-${n.goal_id}/node-${n.id}`,
          title: n.title,
          snippet: buildSnippet(firstMatchingText(parts, terms), terms),
          when: n.updated_at,
          score: scoreText(aggregate, terms, SOURCE_WEIGHT.goal) + recencyBonus(n.updated_at),
        });
      }
    }
    return hits;
  } catch (err) {
    console.warn('[recall] goal section failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

function collectWorkstreamHits(terms: string[]): RecallHit[] {
  if (!tableExists('workstreams')) return [];
  try {
    const rows = sqliteDb
      .prepare(`SELECT id, title, what, next_action, updated_at FROM workstreams WHERE archived = 0`)
      .all() as Array<{ id: number; title: string; what: string | null; next_action: string | null; updated_at: string }>;
    const eventsStmt = tableExists('workstream_events')
      ? sqliteDb.prepare(`SELECT text FROM workstream_events WHERE workstream_id = ?`)
      : null;
    const hits: RecallHit[] = [];
    for (const r of rows) {
      const eventTexts = eventsStmt ? (eventsStmt.all(r.id) as Array<{ text: string }>).map((e) => e.text) : [];
      const parts = [r.title, r.what ?? '', r.next_action ?? '', ...eventTexts];
      const aggregate = parts.join('\n');
      if (!matchesAllTerms(aggregate, terms)) continue;
      hits.push({
        source: 'workstream',
        ref: `workstream-${r.id}`,
        title: r.title,
        snippet: buildSnippet(firstMatchingText(parts, terms), terms),
        when: r.updated_at,
        score: scoreText(aggregate, terms, SOURCE_WEIGHT.workstream) + recencyBonus(r.updated_at),
      });
    }
    return hits;
  } catch (err) {
    console.warn('[recall] workstream section failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

function walkFiles(root: string, dirs: string[], maxBytes: number): Array<{ abs: string; rel: string }> {
  const out: Array<{ abs: string; rel: string }> = [];
  function walk(dir: string) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.md')) {
        try {
          const st = statSync(full);
          if (st.size > maxBytes) continue;
        } catch {
          continue;
        }
        out.push({ abs: full, rel: relative(root, full) });
      }
    }
  }
  for (const d of dirs) walk(join(root, d));
  return out;
}

function collectWikiHits(terms: string[]): RecallHit[] {
  try {
    const files = walkFiles(VAULT_ROOT, WIKI_SEARCH_DIRS, WIKI_FILE_MAX_BYTES);
    const hits: RecallHit[] = [];
    for (const f of files) {
      let content: string;
      let mtimeMs: number;
      try {
        content = readFileSync(f.abs, 'utf-8');
        mtimeMs = statSync(f.abs).mtimeMs;
      } catch {
        continue;
      }
      if (!matchesAllTerms(content, terms)) continue;
      hits.push({
        source: 'wiki',
        ref: f.rel,
        title: f.rel,
        snippet: buildSnippet(content, terms),
        when: new Date(mtimeMs).toISOString(),
        score: scoreText(content, terms, SOURCE_WEIGHT.wiki) + recencyBonus(new Date(mtimeMs).toISOString()),
      });
    }
    return hits;
  } catch (err) {
    console.warn('[recall] wiki section failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

function frontmatterName(content: string): string | null {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  if (!m) return null;
  const nameMatch = /^name:\s*(.+)$/m.exec(m[1]);
  return nameMatch ? nameMatch[1].trim() : null;
}

function collectAutoMemoryHits(terms: string[]): RecallHit[] {
  const dir = process.env.JARVIS_AUTO_MEMORY_DIR ?? AUTO_MEMORY_DIR_DEFAULT;
  try {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const hits: RecallHit[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() || !entry.name.endsWith('.md')) continue;
      const abs = join(dir, entry.name);
      let content: string;
      let mtimeMs: number;
      try {
        content = readFileSync(abs, 'utf-8');
        mtimeMs = statSync(abs).mtimeMs;
      } catch {
        continue;
      }
      if (!matchesAllTerms(content, terms)) continue;
      const title = frontmatterName(content) ?? entry.name;
      hits.push({
        source: 'auto_memory',
        ref: abs,
        title,
        snippet: buildSnippet(content, terms),
        when: new Date(mtimeMs).toISOString(),
        score: scoreText(content, terms, SOURCE_WEIGHT.auto_memory) + recencyBonus(new Date(mtimeMs).toISOString()),
      });
    }
    return hits;
  } catch (err) {
    console.warn('[recall] auto_memory section failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

// -- entry point ------------------------------------------------------------------

const COLLECTORS: Record<Exclude<RecallSource, 'turn'>, (terms: string[]) => RecallHit[]> = {
  thread_summary: collectThreadSummaryHits,
  thread_title: collectThreadTitleHits,
  tree: collectTreeHits,
  goal: collectGoalHits,
  workstream: collectWorkstreamHits,
  wiki: collectWikiHits,
  auto_memory: collectAutoMemoryHits,
};

export function recall(query: string, opts?: RecallOptions): { query: string; mode: 'fts5' | 'like'; hits: RecallHit[] } {
  const mode = ensureTurnsFts().mode;
  const trimmed = (query ?? '').trim();
  const terms = trimmed.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
  if (terms.length === 0 || trimmed.length < 2) {
    return { query: trimmed, mode, hits: [] };
  }

  const days = Math.min(3650, Math.max(1, opts?.days ?? 30));
  const limit = Math.min(50, Math.max(1, opts?.limit ?? 12));
  const wantedSources = opts?.sources && opts.sources.length > 0 ? opts.sources.filter((s) => ALL_SOURCES.includes(s)) : ALL_SOURCES;
  const sourceSet = new Set(wantedSources.length > 0 ? wantedSources : ALL_SOURCES);

  let hits: RecallHit[] = [];
  for (const [source, collector] of Object.entries(COLLECTORS) as Array<[RecallSource, (terms: string[]) => RecallHit[]]>) {
    if (!sourceSet.has(source)) continue;
    hits = hits.concat(collector(terms));
  }
  if (sourceSet.has('turn')) {
    hits = hits.concat(collectTurnHits(terms, days));
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const bWhen = parseWhenMs(b.when) ?? 0;
    const aWhen = parseWhenMs(a.when) ?? 0;
    return bWhen - aWhen;
  });

  return { query: trimmed, mode, hits: hits.slice(0, limit) };
}
