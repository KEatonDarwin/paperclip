// Betterment lane — shared bits for ledger.mjs / collect.mjs / report.mjs.
//
// Everything here writes ONLY to the betterment db (default
// /home/kevin/jarvis-betterment/betterment.db, override with BETTERMENT_DIR).
// The live jarvis.db is only ever opened read-only, by collect.mjs.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const BETTERMENT_DIR = process.env.BETTERMENT_DIR || '/home/kevin/jarvis-betterment';
export const BETTERMENT_DB = path.join(BETTERMENT_DIR, 'betterment.db');
export const LIVE_JARVIS_DB = '/home/kevin/paperclip/darwin-assistant/jarvis.db';

// The collector's metric keys. A ledger change must name one of these.
// `better` is the direction a healthy change usually pushes the metric — the
// ledger still records its own direction per change.
export const METRICS = {
  tokens_per_turn:             { label: 'Tokens per model call (all threads)', better: 'down' },
  tokens_per_turn_worker:      { label: 'Tokens per model call (worker threads)', better: 'down' },
  tokens_per_turn_interactive: { label: 'Tokens per model call (Kevin\'s chats)', better: 'down' },
  cache_ratio:                 { label: 'Share of input served from cache (all threads)', better: 'up' },
  cache_ratio_worker:          { label: 'Share of input served from cache (worker threads)', better: 'up' },
  cache_ratio_interactive:     { label: 'Share of input served from cache (Kevin\'s chats)', better: 'up' },
  turns_per_day:               { label: 'Replies per day', better: 'up' },
  repair_nodes_per_day:        { label: 'Merge-repair nodes created per day', better: 'down' },
  dead_turns_per_day:          { label: 'Hung / failed replies per day', better: 'down' },
};

export function openBettermentDb() {
  fs.mkdirSync(BETTERMENT_DIR, { recursive: true });
  const db = new Database(BETTERMENT_DB);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('flag','code')),
      flag_name TEXT,
      branch_or_commit TEXT,
      metric TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('down','up')),
      promised_delta_pct REAL,
      applied_at TEXT NOT NULL,
      reverted_at TEXT,
      notes TEXT
    );
    CREATE TABLE IF NOT EXISTS metrics_daily (
      day TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL,
      collected_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (day, metric)
    );
  `);
  return db;
}

/** 'YYYY-MM-DD' (UTC) for a Date. jarvis.db stores created_at as UTC text. */
export const utcDay = (d) => d.toISOString().slice(0, 10);

export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return utcDay(d);
}

/** Minimal `--key value` / `--flag` parser. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}
