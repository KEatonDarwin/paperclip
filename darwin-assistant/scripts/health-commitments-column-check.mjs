// HEALTH COMMITMENTS COLUMN CHECK (overnight 2026-10-12).
//
// The /health "Watchdog" card read `promise` from watch_commitments, but the
// column is `subject`. safeQuery swallowed the error and returned [], so the card
// always said "0 open" — 42 breached commitments were invisible. This seeds a
// scratch DB with the watchdog's own schema and asserts the card now sees them.
//
//   npm run build && node scripts/health-commitments-column-check.mjs
import path from 'node:path';
import fs from 'node:fs';

const DB = '/tmp/health-commitments-column-check.db';
for (const p of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(p, { force: true });
process.env.JARVIS_DB_PATH = DB;
process.env.JARVIS_SIM = '1';
process.env.HEALTH_MONITOR = '0';

const dist = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist');
const { sqliteDb } = await import(path.join(dist, 'conversation-db.js'));
const H = await import(path.join(dist, 'health-monitor.js'));

// Schema copied verbatim from scripts/jarvis-watchdog.py ensure_schema().
sqliteDb.exec(`CREATE TABLE IF NOT EXISTS watch_commitments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, thread_ext TEXT,
  check_type TEXT NOT NULL DEFAULT 'manual', check_ref TEXT, due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', recovery_attempts INTEGER NOT NULL DEFAULT 0,
  last_checked TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), resolved_at TEXT, notes TEXT)`);
const ins = sqliteDb.prepare(`INSERT INTO watch_commitments(subject, due_at, status) VALUES (?, ?, ?)`);
ins.run('Report sprint result to Kevin', '2026-10-13 12:00:00', 'open');
ins.run('Deploy Mike Radar + report', '2026-10-05 19:52:52', 'breached');
ins.run('Already satisfied thing', '2026-10-01 00:00:00', 'satisfied');

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails += 1; };

const { rows } = H.workloadRows(undefined, null);
const card = rows.find((r) => r.key === 'watchdog');
ok(!!card, 'watchdog card present');
ok(card && card.value.startsWith('2 open, 1 breached'), `card value counts open+breached rows (got "${card?.value}")`);
ok(card && card.status === 'warn', `a breached commitment makes the card warn (got "${card?.status}")`);
ok(card && card.items.length === 2, `card lists the 2 unresolved commitments (got ${card?.items.length})`);
ok(card && card.items.some((i) => i.label.includes('Deploy Mike Radar')), 'items carry the commitment subject text');
ok(card && !card.items.some((i) => i.label.includes('undefined')), 'no "undefined" labels');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
