#!/usr/bin/env node
// COMPANION THREAD CHECK — acceptance test for node #1376 (wish-catalog
// pilot, tree-08657e8d). Exercises getOrCreateCompanionThread against a
// scratch jarvis.db. No HTTP, no model calls. Proves:
//
//   (a) a fresh scratch DB + getOrCreateCompanionThread creates exactly one
//       companion thread row: kind=companion (via companion_thread_kind +
//       prefix match), model=claude-opus-5, adapter=claude.
//   (b) that thread carries NO expiry: it's absent from quick_chat_sessions
//       entirely (the table the 48h TTL sweep operates on).
//   (c) a SECOND call with the same id is idempotent — same conversation
//       row, `created: false`, still exactly one conversations row for
//       that external_id (no duplicate).
//   (d) a normal quick-chat thread (existing hub-1-database profile) DOES
//       get a real expires_at ~48h out — proving the companion carve-out is
//       specific to the companion prefix, not a global TTL regression.
//
//   npm run build && JARVIS_DB_PATH=/tmp/companion-thread-check.db node scripts/companion-thread-check.mjs

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

console.log(`[companion-thread-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const {
  getOrCreateCompanionThread,
  getCompanionThreadKind,
  companionIdFromThread,
  COMPANION_THREAD_PREFIX,
} = await import(path.join(distDir, 'companion-chat.js'));
const { getConversation, sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));
const { openQuickChatSession, getQuickChatSessionForConversation } = await import(
  path.join(distDir, 'quick-chat-profiles.js')
);

let failed = false;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

const WIFE_ID = 'kevin-wife';

// -- kind registration ---------------------------------------------------------
const kindRow = getCompanionThreadKind();
check('companion_thread_kind row registered', !!kindRow);
check('kind row: persistent = 1', kindRow?.persistent === 1);
check('kind row: default_adapter = claude', kindRow?.default_adapter === 'claude');
check('kind row: default_model = claude-opus-5', kindRow?.default_model === 'claude-opus-5');

// -- (a) fresh creation ---------------------------------------------------------
const first = getOrCreateCompanionThread(WIFE_ID);
check('(a) first call reports created: true', first.created === true);
check('(a) external_id uses the companion prefix', first.external_id === `${COMPANION_THREAD_PREFIX}${WIFE_ID}`);
check('(a) companionIdFromThread round-trips the id', companionIdFromThread(first.external_id) === WIFE_ID);

const conv = getConversation(first.external_id);
check('(a) conversation row exists', !!conv);
check('(a) model pinned to claude-opus-5', conv?.thread_model === 'claude-opus-5');
check('(a) adapter pinned to claude', conv?.thread_adapter === 'claude');

// -- (b) no expiry: absent from quick_chat_sessions -----------------------------
const companionSession = getQuickChatSessionForConversation(conv.id);
check('(b) companion thread has no quick_chat_sessions row (no TTL)', companionSession === null);
const rawRow = sqliteDb
  .prepare('SELECT COUNT(*) AS n FROM quick_chat_sessions WHERE conversation_id = ?')
  .get(conv.id);
check('(b) zero quick_chat_sessions rows reference this conversation', rawRow.n === 0);

// -- (c) second call is idempotent ----------------------------------------------
const second = getOrCreateCompanionThread(WIFE_ID);
check('(c) second call reports created: false', second.created === false);
check('(c) second call returns the same external_id', second.external_id === first.external_id);
const convCountRow = sqliteDb
  .prepare('SELECT COUNT(*) AS n FROM conversations WHERE external_id = ?')
  .get(first.external_id);
check('(c) exactly one conversations row for this external_id (no duplicate)', convCountRow.n === 1);

// Re-running does not re-apply/clobber the model pin either.
const convAfterSecond = getConversation(first.external_id);
check('(c) model pin unchanged after second call', convAfterSecond?.thread_model === 'claude-opus-5');

// -- (d) a normal quick-chat thread DOES still expire ----------------------------
const quickSession = openQuickChatSession('hub-1-database');
check('(d) quick-chat session has an expires_at', !!quickSession.expires_at);
const expiresAt = new Date(quickSession.expires_at).getTime();
const now = Date.now();
check(
  '(d) quick-chat expiry is roughly 48h out (40h-56h window)',
  expiresAt - now > 40 * 3600 * 1000 && expiresAt - now < 56 * 3600 * 1000,
);
check(
  "(d) quick-chat external_id does NOT use the companion prefix (carve-out is companion-specific)",
  !quickSession.external_id.startsWith(COMPANION_THREAD_PREFIX),
);

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
