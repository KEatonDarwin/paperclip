// COMPANION THIN CLIENT SERVER — node #1438, tree-1bd033c2. A standalone HTTP
// service for her dedicated guest login: her own port, her own thread, no nav.
//
// This is NOT the cockpit on another port. It does not mount the api-v1
// router, bearerAuth, or any cockpit route — it wires exactly five routes by
// hand and 404s everything else. The one server-side posture it holds is
// talking to the existing DB/pipeline directly in-process; there is no admin
// HTTP key exposed to the client, and the thread id is never client-supplied
// (it comes from COMPANION_THREAD_EXT, set here on the server).
//
// The model turn itself is NEVER reimplemented here — POST /api/thread
// inserts the user turn with the same conversation-db primitive every other
// ingress uses, then hands off to agent.ts's processMessage (with
// resumeLastUserTurn so it doesn't insert a second copy) so the thread's
// pinned Opus model (#275/#277) answers exactly as it would from the cockpit.

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
  addTurn,
  getOrCreateConversation,
  getTurnsLean,
  type TurnRow,
} from './conversation-db.js';
import { getInFlightMessageId, processMessage } from './agent.js';
import { companionIdFromThread, companionThreadExt, getOrCreateCompanionThread } from './companion-chat.js';

const PORT = parseInt(process.env.COMPANION_THIN_PORT ?? '8099', 10);

// Server-configured — the client can never choose or override which thread
// this service talks to (see allowlist test: ?ext=<anything> is never read).
const COMPANION_THREAD_EXT = process.env.COMPANION_THREAD_EXT ?? companionThreadExt('kevin-wife');

const REPORTS_DIR = path.resolve(
  process.env.COMPANION_REPORTS_DIR ?? '/home/kevin/obsidian/paperclip-wiki/outbox',
);

const MAX_TEXT_LENGTH = 50_000;
const REPORT_NAME_RE = /^[A-Za-z0-9._-]+\.md$/;

/**
 * Ensure the companion conversation row exists, applying the Opus pin via the
 * existing companion-chat.ts helper when the configured ext matches the
 * companion prefix (so this service never has to know the pinning rule
 * itself). Falls back to a plain lookup/create for an unusual override.
 */
function ensureCompanionConversation() {
  const id = companionIdFromThread(COMPANION_THREAD_EXT);
  if (id) getOrCreateCompanionThread(id);
  return getOrCreateConversation(COMPANION_THREAD_EXT);
}

function serializeTurn(t: TurnRow) {
  return {
    turn_index: t.turn_index,
    role: t.role,
    content: t.content,
    tool_name: t.tool_name,
    tool_args: t.tool_args,
    model: t.model,
    created_at: t.created_at,
  };
}

function listReportFiles(): string[] {
  try {
    return fs
      .readdirSync(REPORTS_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Resolve a report name to a path INSIDE REPORTS_DIR, or null — never a raw
 *  filesystem read from client input. Validated against the live listing, not
 *  just the regex, so a traversal attempt can never reach outside the dir. */
function resolveReportPath(name: string): string | null {
  if (!REPORT_NAME_RE.test(name)) return null;
  if (!listReportFiles().includes(name)) return null;
  const full = path.resolve(REPORTS_DIR, name);
  if (full !== path.join(REPORTS_DIR, name)) return null;
  return full;
}

export function startCompanionThinServer(): void {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // GET / -- placeholder for the iPhone client; node 2 fills in the real HTML.
  app.get('/', (_req, res) => {
    res.type('html').send(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Companion</title></head><body><h1>💬 Companion</h1><p>Client coming soon.</p></body></html>',
    );
  });

  // GET /api/thread -- her thread's history ONLY. A client-supplied thread id
  // is impossible by construction: this handler never reads req.query at all.
  app.get('/api/thread', (_req, res) => {
    const conv = ensureCompanionConversation();
    const turns = getTurnsLean(conv.id);
    res.json({ external_id: COMPANION_THREAD_EXT, turns: turns.map(serializeTurn) });
  });

  // POST /api/thread { text } -- appends a user turn to her thread (the fixed
  // server-side thread, never one the client names) and hands the turn to the
  // existing pipeline so her thread's pinned model answers it. The user turn
  // is written here with the same addTurn() primitive agent.ts itself would
  // use; processMessage is then called with resumeLastUserTurn so it reuses
  // that turn instead of inserting a duplicate. No model call is reimplemented
  // — processMessage/runConversationTurn do exactly what they always do.
  app.post('/api/thread', (req, res) => {
    const body = (req.body ?? {}) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      res.status(400).json({ error: 'invalid_request', message: 'text is required and must be a non-empty string' });
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      res.status(413).json({ error: 'text_too_long', message: `text exceeds max length of ${MAX_TEXT_LENGTH} chars` });
      return;
    }

    const conv = ensureCompanionConversation();
    const pending = getInFlightMessageId(conv.id);
    if (pending) {
      res.status(409).json({ error: 'message_in_flight', pending_message_id: pending });
      return;
    }

    const turnIndex = addTurn(conv.id, 'user', text);
    const messageId = `turn:${conv.id}:${turnIndex}`;
    processMessage(text, COMPANION_THREAD_EXT, messageId, undefined, { resumeLastUserTurn: true }).catch(
      (err: unknown) => console.error('[companion-thin] processMessage failed', err),
    );

    res.status(202).json({ status: 'processing', turn_index: turnIndex });
  });

  // GET /api/reports -- list the wish-catalog report markdown files.
  app.get('/api/reports', (_req, res) => {
    res.json({ reports: listReportFiles() });
  });

  // GET /api/reports/:name -- one report's raw markdown, name validated
  // against the live listing (never an arbitrary filesystem read).
  app.get('/api/reports/:name', (req, res) => {
    const full = resolveReportPath(req.params.name);
    if (!full) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.type('text/markdown').send(fs.readFileSync(full, 'utf8'));
  });

  // Everything else -- 404. No api-v1 router, no bearerAuth, no cockpit route
  // is mounted on this app at all, so this is the only fallback there is.
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Companion thin client listening on 0.0.0.0:${PORT} (thread: ${COMPANION_THREAD_EXT})`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startCompanionThinServer();
}
