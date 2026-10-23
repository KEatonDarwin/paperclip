// Read-only view over the watchdog's promise registry (watch_commitments, written by
// scripts/jarvis-commit.py + scripts/jarvis-watchdog.py). Exposed so the cockpit can
// show Kevin the roster JARVIS works from instead of it living only in a CLI.
import { sqliteDb } from './conversation-db.js';

export type CommitmentRow = {
  id: number;
  subject: string;
  thread_ext: string | null;
  check_type: string | null;
  check_ref: string | null;
  due_at: string | null;
  status: string;
  recovery_attempts: number;
  last_checked: string | null;
  created_at: string;
  resolved_at: string | null;
  notes: string | null;
};

const hasTable = (): boolean =>
  !!sqliteDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='watch_commitments'`).get();

export function listCommitments(opts: { status?: string; limit?: number } = {}): CommitmentRow[] {
  if (!hasTable()) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  if (opts.status && opts.status !== 'all') {
    return sqliteDb
      .prepare(`SELECT * FROM watch_commitments WHERE status = ? ORDER BY due_at ASC, id DESC LIMIT ?`)
      .all(opts.status, limit) as CommitmentRow[];
  }
  // default = the live roster: open first (by due), then breached, then everything recent
  return sqliteDb
    .prepare(
      `SELECT * FROM watch_commitments
       ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'breached' THEN 1 ELSE 2 END, due_at ASC, id DESC
       LIMIT ?`,
    )
    .all(limit) as CommitmentRow[];
}
