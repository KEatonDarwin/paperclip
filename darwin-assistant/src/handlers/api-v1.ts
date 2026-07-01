import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import {
  getOrCreateConversation,
  getConversation,
  getConversationById,
  getTurns,
  countTurns,
  linkContinuedThreads,
  updateSessionId,
  listAllConversations,
  type ConversationRow,
  type TurnRow,
} from '../conversation-db.js';
import { processMessage } from '../agent.js';
import { sseBus, type SSEEvent } from '../sse-bus.js';
import {
  authenticateBearer,
  callerExternalIdPrefix,
  callerOwnsExternalId,
  type ApiKeyRow,
} from '../api-keys.js';

const MAX_TEXT_LENGTH = 50_000;
const UI_PORT = parseInt(process.env.JARVIS_UI_PORT ?? '3201', 10);

interface AuthedRequest extends Request {
  apiKey?: ApiKeyRow;
}

const inFlight = new Map<number, string>();
const errorByMessageId = new Map<string, { code: string; message: string }>();

function paramString(value: string | string[] | undefined): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0] ?? '';
  return '';
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[0];
  return undefined;
}

function sendError(res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void {
  res.status(status).json({ error: { code, message, ...(extra ?? {}) } });
}

function threadDescriptor(conv: ConversationRow, req: Request): Record<string, unknown> {
  const host = headerString(req.headers.host) ?? `localhost:${UI_PORT}`;
  const proto = req.protocol ?? 'http';
  return {
    thread_id: conv.external_id,
    conversation_id: conv.id,
    status: conv.status,
    created_at: conv.created_at,
    updated_at: conv.updated_at,
    turn_count: countTurns(conv.id),
    continued_from_id: conv.continued_from_id,
    continued_to_id: conv.continued_to_id,
    dashboard_url: `${proto}://${host}/conversations/${conv.id}`,
  };
}

function serializeTurn(turn: TurnRow): Record<string, unknown> {
  return {
    turn_index: turn.turn_index,
    role: turn.role,
    content: turn.content,
    tool_name: turn.tool_name,
    tool_args: turn.tool_args,
    tool_result: turn.tool_result,
    created_at: turn.created_at,
    input_tokens: turn.input_tokens,
    output_tokens: turn.output_tokens,
    cache_read_tokens: turn.cache_read_tokens,
    cache_write_tokens: turn.cache_write_tokens,
    timing_ms: turn.timing_ms,
    model: turn.model,
  };
}

function findConversationForCaller(caller: ApiKeyRow, externalId: string): ConversationRow | { error: { status: number; code: string; message: string } } {
  if (!callerOwnsExternalId(caller.id, externalId)) {
    return { error: { status: 403, code: 'thread_not_owned_by_caller', message: 'This thread is not owned by the authenticated caller' } };
  }
  const conv = getConversation(externalId);
  if (!conv) {
    return { error: { status: 404, code: 'thread_not_found', message: `Thread ${externalId} not found` } };
  }
  return conv;
}

function bearerAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    sendError(res, 401, 'invalid_or_missing_bearer_token', 'Authorization: Bearer <key> header required');
    return;
  }
  const key = authenticateBearer(match[1].trim());
  if (!key) {
    sendError(res, 401, 'invalid_or_missing_bearer_token', 'Unknown or revoked API key');
    return;
  }
  req.apiKey = key;
  next();
}

function parseMessageId(messageId: string): { conversationId: number; turnIndex: number } | null {
  const parts = messageId.split(':');
  if (parts.length !== 3 || parts[0] !== 'turn') return null;
  const conversationId = Number(parts[1]);
  const turnIndex = Number(parts[2]);
  if (!Number.isFinite(conversationId) || !Number.isFinite(turnIndex)) return null;
  return { conversationId, turnIndex };
}

export function createApiV1Router(): Router {
  const router: Router = Router();

  router.use(bearerAuth as (req: Request, res: Response, next: NextFunction) => void);

  // -- POST /threads: create a new thread ------------------------------------

  router.post('/threads', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const body = (req.body ?? {}) as { external_id?: unknown; label?: unknown };
    const providedId = typeof body.external_id === 'string' ? body.external_id.trim() : '';

    let externalId: string;
    if (providedId) {
      if (!callerOwnsExternalId(caller.id, providedId)) {
        sendError(res, 403, 'thread_not_owned_by_caller', `external_id must start with '${callerExternalIdPrefix(caller.id)}'`);
        return;
      }
      externalId = providedId;
    } else {
      externalId = `${callerExternalIdPrefix(caller.id)}${randomUUID()}`;
    }

    const existing = getConversation(externalId);
    if (existing) {
      res.status(200).json({ ...threadDescriptor(existing, req), idempotent: true });
      return;
    }

    const conv = getOrCreateConversation(externalId);
    res.status(201).json(threadDescriptor(conv, req));
  });

  // -- GET /threads: list caller's threads -----------------------------------

  router.get('/threads', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const prefix = callerExternalIdPrefix(caller.id);
    const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const statusFilter = typeof req.query.status === 'string' ? req.query.status : null;

    const all = listAllConversations();
    const filtered = all.filter((c) => {
      if (!c.external_id.startsWith(prefix)) return false;
      if (statusFilter && c.status !== statusFilter) return false;
      return true;
    }).slice(0, limit);

    res.json({ threads: filtered.map((c) => threadDescriptor(c, req)) });
  });

  // -- GET /threads/:external_id ---------------------------------------------

  router.get('/threads/:external_id', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const conv = result;
    const turns = getTurns(conv.id);
    res.json({
      ...threadDescriptor(conv, req),
      turns: turns.map(serializeTurn),
    });
  });

  // -- GET /threads/:external_id/markdown -----------------------------------

  router.get('/threads/:external_id/markdown', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const conv = result;
    const turns = getTurns(conv.id);
    const md = renderMarkdown(conv, turns);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(md);
  });

  // -- POST /threads/:external_id/session-clone ------------------------------

  router.post('/threads/:external_id/session-clone', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const parent = result;

    const newExternalId = `${callerExternalIdPrefix(caller.id)}${randomUUID()}`;
    const cloneConv = getOrCreateConversation(newExternalId);
    if (parent.claude_session_id) {
      updateSessionId(cloneConv.id, parent.claude_session_id);
    }
    linkContinuedThreads(parent.id, cloneConv.id);

    // Refresh conv row so continued_from_id shows up in the response
    const refreshed = getConversationById(cloneConv.id) ?? cloneConv;
    res.status(201).json({
      ...threadDescriptor(refreshed, req),
      predecessor_thread_id: parent.external_id,
    });
  });

  // -- POST /threads/:external_id/messages: send a message (async) -----------

  router.post('/threads/:external_id/messages', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const body = (req.body ?? {}) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text : '';

    if (!text.trim()) {
      sendError(res, 400, 'invalid_request', 'text is required and must be a non-empty string');
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      sendError(res, 413, 'text_too_long', `text exceeds max length of ${MAX_TEXT_LENGTH} chars`);
      return;
    }

    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const conv = result;

    const pending = inFlight.get(conv.id);
    if (pending) {
      sendError(res, 409, 'message_in_flight', 'Another message is still processing on this thread', {
        pending_message_id: pending,
      });
      return;
    }

    const nextIndex = countTurns(conv.id);
    const messageId = `turn:${conv.id}:${nextIndex}`;
    inFlight.set(conv.id, messageId);
    errorByMessageId.delete(messageId);

    processMessage(text, externalId)
      .then(() => {
        inFlight.delete(conv.id);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        errorByMessageId.set(messageId, { code: 'jarvis_error', message });
        inFlight.delete(conv.id);
      });

    const host = headerString(req.headers.host) ?? `localhost:${UI_PORT}`;
    const proto = req.protocol ?? 'http';
    const base = `${proto}://${host}/api/v1/threads/${encodeURIComponent(externalId)}`;
    res.status(202).json({
      message_id: messageId,
      status: 'processing',
      poll_url: `${base}/messages/${messageId}`,
      events_url: `${base}/events`,
    });
  });

  // -- GET /threads/:external_id/messages/:message_id: poll status ----------

  router.get('/threads/:external_id/messages/:message_id', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const messageId = paramString(req.params.message_id);

    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const conv = result;

    const parsed = parseMessageId(messageId);
    if (!parsed || parsed.conversationId !== conv.id) {
      sendError(res, 404, 'message_not_found', 'message_id does not belong to this thread');
      return;
    }

    const errorEntry = errorByMessageId.get(messageId);
    if (errorEntry) {
      res.json({ message_id: messageId, status: 'error', error: errorEntry });
      return;
    }

    const turns = getTurns(conv.id);
    const userTurn = turns.find((t) => t.turn_index === parsed.turnIndex);
    if (!userTurn) {
      // The user turn hasn't been inserted yet (extreme race with async processMessage kickoff).
      res.json({ message_id: messageId, status: 'processing' });
      return;
    }

    const laterTurns = turns.filter((t) => t.turn_index > parsed.turnIndex);
    const assistantTurn = laterTurns.find((t) => t.role === 'assistant');
    const toolCalls = laterTurns.filter((t) => t.role === 'tool_call' || t.role === 'tool_result');

    if (!assistantTurn) {
      res.json({ message_id: messageId, status: 'processing' });
      return;
    }

    res.json({
      message_id: messageId,
      status: 'done',
      text: assistantTurn.content,
      turn: serializeTurn(assistantTurn),
      user_turn: serializeTurn(userTurn),
      tool_calls: toolCalls.map(serializeTurn),
    });
  });

  // -- GET /threads/:external_id/events: SSE stream --------------------------

  router.get('/threads/:external_id/events', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const conv = result;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':\n\n');

    const heartbeat = setInterval(() => res.write(':\n\n'), 15000);

    const handler = (ev: SSEEvent) => {
      if (ev.type === 'status') {
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
        return;
      }
      if ('conversationId' in ev && ev.conversationId === conv.id) {
        res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      }
    };

    sseBus.on('sse', handler);
    res.on('close', () => {
      clearInterval(heartbeat);
      sseBus.off('sse', handler);
    });
  });

  return router;
}

function renderMarkdown(conv: ConversationRow, turns: TurnRow[]): string {
  const lines: string[] = [];
  lines.push(`# JARVIS Thread — ${conv.external_id}`);
  lines.push('');
  lines.push(`- Created: ${conv.created_at} UTC`);
  lines.push(`- Updated: ${conv.updated_at} UTC`);
  lines.push(`- Turns: ${turns.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const t of turns) {
    const ts = t.created_at;
    if (t.role === 'user') {
      lines.push(`## User — ${ts}`);
      lines.push('');
      lines.push(t.content ?? '');
      lines.push('');
    } else if (t.role === 'assistant') {
      lines.push(`## JARVIS — ${ts}`);
      lines.push('');
      lines.push(t.content ?? '');
      lines.push('');
    } else if (t.role === 'tool_call') {
      lines.push(`### tool call: ${t.tool_name} — ${ts}`);
      lines.push('');
      lines.push('```json');
      lines.push(t.tool_args ?? '{}');
      lines.push('```');
      lines.push('');
    } else if (t.role === 'tool_result') {
      lines.push(`### tool result: ${t.tool_name} — ${ts}`);
      lines.push('');
      lines.push('```');
      lines.push((t.tool_result ?? '').slice(0, 6000));
      lines.push('```');
      lines.push('');
    }
  }
  return lines.join('\n');
}
