// SHARED CONTEXT v0 §3 (docs/shared-context/CONTRACT.md) — pick the threads
// whose thread_summaries row is stale (or missing) so the §1 digest and §2
// recall's thread_summary hits stay fresh without a human clicking
// "Summarize" by hand.
//
// Import discipline: conversation-db.js (sqliteDb) + thread-summaries.js
// (ensures the table exists on a scratch DB) + shared-context.js
// (isSharedNowEligibleThread — worker/quick/ephemeral threads are never
// candidates). No agent.ts import.

import { sqliteDb } from './conversation-db.js';
import './thread-summaries.js';
import { isSharedNowEligibleThread } from './shared-context.js';

export interface StaleThread {
  conversation_id: number;
  external_id: string;
  title: string | null;
  turn_count: number;
  summary_anchor: number | null;
  summary_at: string | null;
  last_turn_at: string;
  stale_turns: number;
}

const DEFAULT_MIN_TURNS = 6;
const DEFAULT_BATCH = 15;

interface CandidateRow {
  conversation_id: number;
  external_id: string;
  title: string | null;
  turn_count: number;
  summary_anchor: number | null;
  summary_at: string | null;
  last_turn_at: string | null;
  stale_turns: number;
}

const CANDIDATES_SQL = `
  SELECT
    c.id AS conversation_id,
    c.external_id AS external_id,
    c.title AS title,
    (SELECT COUNT(*) FROM turns t WHERE t.conversation_id = c.id) AS turn_count,
    s.anchor_turn_index AS summary_anchor,
    s.created_at AS summary_at,
    (SELECT MAX(t2.created_at) FROM turns t2 WHERE t2.conversation_id = c.id) AS last_turn_at,
    (
      SELECT COUNT(*) FROM turns t3
      WHERE t3.conversation_id = c.id
        AND t3.role IN ('user','assistant')
        AND t3.turn_index > COALESCE(s.anchor_turn_index, -1)
    ) AS stale_turns
  FROM conversations c
  LEFT JOIN (
    SELECT ts1.conversation_id, ts1.anchor_turn_index, ts1.created_at
    FROM thread_summaries ts1
    INNER JOIN (
      SELECT conversation_id, MAX(id) AS max_id FROM thread_summaries GROUP BY conversation_id
    ) latest ON latest.conversation_id = ts1.conversation_id AND latest.max_id = ts1.id
  ) s ON s.conversation_id = c.id
  WHERE c.status = 'active'
`;

/**
 * Stale = eligible non-worker thread, ≥ minTurns user/assistant turns since
 * the newest summary's anchor (or since the start when never summarized),
 * AND the newest turn is newer than the newest summary (or there is no
 * summary yet). Ordered oldest-summary-first (never-summarized first), then
 * oldest-last-turn first, capped at `batch`.
 */
export function selectStaleThreads(opts?: { minTurns?: number; batch?: number }): StaleThread[] {
  const minTurns = opts?.minTurns ?? DEFAULT_MIN_TURNS;
  const batch = opts?.batch ?? DEFAULT_BATCH;

  let rows: CandidateRow[];
  try {
    rows = sqliteDb.prepare<[], CandidateRow>(CANDIDATES_SQL).all();
  } catch (err) {
    console.error('[summary-refresh] selectStaleThreads query failed:', err);
    return [];
  }

  const stale: StaleThread[] = [];
  for (const r of rows) {
    if (!r.last_turn_at) continue; // no turns yet — nothing to summarize
    if (!isSharedNowEligibleThread(r.external_id, { workers: false })) continue;
    if (r.stale_turns < minTurns) continue;
    // Newer turn activity than the last summary (or no summary at all).
    if (r.summary_at && r.last_turn_at <= r.summary_at) continue;
    stale.push({
      conversation_id: r.conversation_id,
      external_id: r.external_id,
      title: r.title,
      turn_count: r.turn_count,
      summary_anchor: r.summary_anchor,
      summary_at: r.summary_at,
      last_turn_at: r.last_turn_at,
      stale_turns: r.stale_turns,
    });
  }

  stale.sort((a, b) => {
    // Never-summarized first (NULL summary_at sorts first).
    const aAt = a.summary_at ?? '';
    const bAt = b.summary_at ?? '';
    if (aAt !== bAt) return aAt < bAt ? -1 : 1;
    return a.last_turn_at < b.last_turn_at ? -1 : a.last_turn_at > b.last_turn_at ? 1 : 0;
  });

  return stale.slice(0, batch);
}
