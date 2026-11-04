#!/usr/bin/env node
// NOTEPAD SETTLE CHECK — exercises checkNotepadSettle (src/notepad-settle.ts)
// against a scratch jarvis.db. No HTTP, no model calls, no sleeping.
//
// checkNotepadSettle reads notepad_days.updated_at (set by putNotepadDay via
// SQLite's real datetime('now')) and compares it against an injected `now`.
// To make the test fully deterministic without sleeping real seconds, each
// save's updated_at is forced to a controlled tick value immediately after
// the save (bypassing wall-clock time entirely) — the same DB column the
// real code path writes, just with a value the test controls.
//
// Covers:
//   (A) 40 rapid saves, one tick apart, checked shortly after each save
//       (still well inside the quiet period) -> ZERO settles across all 40.
//   (B) advancing `now` one tick past the quiet period after the 40th save
//       -> EXACTLY ONE settle, whose last_write_at is the 40th save's
//       updated_at.
//   (C) repeated calls (6+) with time continuing to advance, no new save ->
//       still ZERO further settles (the load-bearing "never fires twice for
//       the same quiet period" case).
//   (D) one further save re-arms it: inside its own quiet period -> null;
//       past it -> exactly one NEW settle with a NEW last_write_at.
//   (E) the notepad_settle_seconds setting is honoured (boundary moves).
//   (no row) a day with no notepad_days row returns null.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-settle-check.db node scripts/notepad-settle-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── scratch DB guard ─────────────────────────────────────────────────────────
const raw = process.env.JARVIS_DB_PATH;
if (!raw || !raw.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path.');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

console.log(`[notepad-settle-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { putNotepadDay } = await import(path.join(distDir, 'notepad.js'));
const { checkNotepadSettle } = await import(path.join(distDir, 'notepad-settle.js'));
const { sqliteDb, setSetting } = await import(path.join(distDir, 'conversation-db.js'));

let failed = false;
let saveCount = 0;
let settleCount = 0;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

// ── deterministic time injection ────────────────────────────────────────────
// putNotepadDay stamps notepad_days.updated_at with SQLite's real
// datetime('now') — to test quiet-period boundaries without sleeping real
// seconds, force that column to a controlled tick value right after each
// save. This is the exact column checkNotepadSettle reads; only the wall
// clock is being bypassed, not the code path.
const EPOCH_MS = Date.parse('2026-01-01T00:00:00Z');
function tickDate(n) {
  return new Date(EPOCH_MS + n * 1000); // one tick = one second
}
function sqliteDatetimeString(date) {
  return date.toISOString().slice(0, 19).replace('T', ' '); // 'YYYY-MM-DD HH:MM:SS', matches datetime('now')
}
const setUpdatedAtStmt = sqliteDb.prepare(`UPDATE notepad_days SET updated_at = ? WHERE day = ?`);
function saveAtTick(day, text, tick) {
  putNotepadDay(day, text);
  saveCount++;
  setUpdatedAtStmt.run(sqliteDatetimeString(tickDate(tick)), day);
  return sqliteDatetimeString(tickDate(tick));
}

const DAY = '2026-09-25';

// -- (A) 40 rapid saves, one tick apart, checked well inside the quiet period
let fortiethLastWriteAt;
{
  for (let i = 1; i <= 40; i++) {
    fortiethLastWriteAt = saveAtTick(DAY, `line ${i}`, i);
    // Check 3 seconds after this save's own tick — comfortably inside the
    // default 20s quiet period, and also before the NEXT save's tick lands
    // (so this genuinely exercises "checked after every save", not just the
    // trivial elapsed=0 instant).
    const settled = checkNotepadSettle(DAY, tickDate(i + 3));
    if (settled) settleCount++;
    check(`(A) save #${i}: no settle (3s later, still inside quiet period)`, settled === null);
  }
}

// -- (B) advance `now` one tick PAST the default 20s quiet period ----------
let quietSecondsDefault;
{
  const pastBoundary = tickDate(40 + 20 + 1); // 21s after the 40th save's tick
  const settled = checkNotepadSettle(DAY, pastBoundary);
  check('(B) exactly one settle fires once past the quiet period', settled !== null);
  if (settled) {
    settleCount++;
    quietSecondsDefault = settled.quiet_seconds;
    check('(B) quiet_seconds reports the default (20)', settled.quiet_seconds === 20);
    check("(B) last_write_at equals the 40th save's updated_at", settled.last_write_at === fortiethLastWriteAt);
  }
}

// -- (C) repeated calls, time continuing to advance, no new save ------------
{
  for (let i = 1; i <= 6; i++) {
    const later = tickDate(40 + 20 + 1 + i * 30); // keep marching well past the boundary
    const settled = checkNotepadSettle(DAY, later);
    check(`(C) repeat call #${i} after the same write: no further settle`, settled === null);
  }
}

// -- (D) a further save re-arms it -------------------------------------------
{
  const newTick = 40 + 20 + 1 + 6 * 30 + 5; // well after everything in (A)-(C)
  const newLastWriteAt = saveAtTick(DAY, 'line 41 — a genuinely new write', newTick);

  const insideNewQuiet = checkNotepadSettle(DAY, tickDate(newTick + 3)); // 3s later, inside quiet period
  check('(D) new save, inside its own quiet period: no settle', insideNewQuiet === null);

  const pastNewBoundary = checkNotepadSettle(DAY, tickDate(newTick + 21)); // 21s later, past it
  check('(D) new save, past its quiet period: settles exactly once', pastNewBoundary !== null);
  if (pastNewBoundary) {
    settleCount++;
    check('(D) new settle carries the NEW last_write_at', pastNewBoundary.last_write_at === newLastWriteAt);
    check(
      "(D) new settle's last_write_at differs from the first settle's",
      pastNewBoundary.last_write_at !== fortiethLastWriteAt,
    );
  }

  const repeatAfterNew = checkNotepadSettle(DAY, tickDate(newTick + 200));
  check('(D) no double-fire for the re-armed write either', repeatAfterNew === null);
}

// -- (E) notepad_settle_seconds setting is honoured (boundary moves) --------
{
  const DAY2 = '2026-09-26';
  setSetting('notepad_settle_seconds', '5');

  const writeAt = saveAtTick(DAY2, 'a fast-settling day', 5000);

  const tooEarly = checkNotepadSettle(DAY2, tickDate(5000 + 4)); // 4s later, under the 5s setting
  check('(E) with settle seconds=5, 4s later: no settle yet', tooEarly === null);

  const justRight = checkNotepadSettle(DAY2, tickDate(5000 + 6)); // 6s later, past 5s
  check('(E) with settle seconds=5, 6s later: settles', justRight !== null);
  if (justRight) {
    settleCount++;
    check('(E) settled quiet_seconds reflects the setting (5), not the default', justRight.quiet_seconds === 5);
    check('(E) last_write_at matches the forced write time', justRight.last_write_at === writeAt);
  }
}

// -- day with no notepad_days row at all -> null -----------------------------
{
  check('(no row) an unsaved day returns null', checkNotepadSettle('2099-01-01', tickDate(999999)) === null);
}

console.log(`\nsaves: ${saveCount}  settles: ${settleCount}  violations: ${failed ? 'yes' : 0}`);
console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
