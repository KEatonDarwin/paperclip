import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { statSync, readFileSync } from 'node:fs';
import { parseTurnSteps } from '../turn-steps.js';
import { isPlanModeMessage } from '../agent.js';
import {
  getOrCreateConversation,
  getConversation,
  getConversationById,
  getTurns,
  countTurns,
  countMessages,
  getLastMessageRole,
  linkContinuedThreads,
  updateSessionState,
  setThreadModelOverride,
  listAllConversations,
  deriveSource,
  renameConversation,
  setConversationStatus,
  setThreadPinned,
  setThreadGroup,
  deleteConversation,
  copyTurns,
  type ConversationRow,
  type TurnRow,
} from '../conversation-db.js';
import {
  listGroups,
  getGroupById,
  createGroup,
  renameGroup,
  setGroupColor,
  deleteGroup,
} from '../conversation-groups.js';
import { listAutonomyLedger } from '../autonomy-ledger.js';
import { listMcpServers, refreshMcpServers } from '../mcp-registry.js';
import { resolveNativeServer, nativeListTools } from '../tools/mcp-native.js';
import { listNotes, createNote } from '../notes-db.js';
import { triageNote } from '../notes.js';
import {
  listActiveQuickCaptureItems,
  createQuickCaptureItem,
  reorderQuickCaptureItems,
  renameQuickCaptureItem,
  setQuickCaptureItemCompleted,
  deleteQuickCaptureItem,
  getQuickCaptureItem,
} from '../quick-capture-db.js';
import { autoNameThreadFromFirstMessage } from '../thread-autoname.js';
import { generateThreadSummary } from '../thread-summarize.js';
import { listThreadSummaries, getLatestThreadSummary } from '../thread-summaries.js';
import { searchThreadsByQuery } from '../thread-search.js';
import { getBrief } from '../jarvis-brief.js';
import {
  listJarvisDecisions,
  insertJarvisDecision,
  serializeDecision,
  type DecidedBy,
} from '../jarvis-decisions.js';
import {
  listThreadTodos,
  createThreadTodo,
  getThreadTodo,
  updateThreadTodoStatus,
  updateThreadTodoContent,
  updateThreadTodoOwner,
  setThreadTodoShimTask,
  deleteThreadTodo,
  openTodoCount,
  type ThreadTodoStatus,
  type ThreadTodoOwner,
} from '../thread-todos.js';
import {
  activeReminderForConversation,
  setThreadReminder,
  acknowledgeThreadReminder,
  cancelRemindersForConversation,
  serializeReminder,
} from '../thread-reminders.js';
import {
  listQueuedMessages,
  enqueueMessage,
  deleteQueuedMessage,
  shiftQueuedMessage,
} from '../thread-message-queue.js';
import { createShimTask } from '../tools/shim.js';
import {
  processMessage,
  getAdapters,
  getAdapterRuntimeDescriptor,
  getActiveAdapterInfo,
  getActiveRuntimeDescriptor,
  resolveConversationRuntime,
  getInFlightMessageId,
  getLiveStream,
  abortConversationRun,
  ConversationBusyError,
  getActiveRunCount,
  getActiveRuns,
} from '../agent.js';
import {
  getAllSettings,
  getSetting,
  setSetting,
  deleteSetting,
  getPersonalityStats,
  updatePersonalityStats,
  getPersonalityStatsHistory,
  listRunHistory,
  classifyRunOutcome,
  PERSONALITY_STAT_KEYS,
} from '../conversation-db.js';
import { query } from '../db.js';
import { listVaultTree, readVaultFile, searchVault } from '../vault-page.js';
import { sseBus, type SSEEvent } from '../sse-bus.js';
import {
  authenticateBearer,
  callerExternalIdPrefix,
  callerOwnsExternalId,
  isAdminScope,
  type ApiKeyRow,
} from '../api-keys.js';

const MAX_TEXT_LENGTH = 50_000;
const UI_PORT = parseInt(process.env.JARVIS_UI_PORT ?? '3201', 10);

interface AuthedRequest extends Request {
  apiKey?: ApiKeyRow;
}

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
  // Effective provider/model for this thread (per-thread override, else global).
  const { adapter, model } = resolveConversationRuntime(conv);
  // Open (not-done) todos for the sidebar indicator + "todos for me" filter.
  const openTodos = openTodoCount(conv.id);
  // Auto-bump reminder: drives the sidebar bell + the "alerting" highlight.
  const reminder = activeReminderForConversation(conv.id);
  return {
    thread_id: conv.external_id,
    reminder: reminder ? serializeReminder(reminder) : null,
    // Open todo signal — total, and the subset tagged "for Kevin".
    open_todo_count: openTodos.total,
    open_todo_for_me_count: openTodos.forKevin,
    conversation_id: conv.id,
    status: conv.status,
    // User-set display name (rename); null → client derives one. Kept distinct
    // from status so an archived thread keeps its title.
    title: conv.title ?? null,
    // Pin-to-top (DAR-735). pinned_at drives ordering among multiple pinned threads.
    pinned: !!conv.pinned,
    pinned_at: conv.pinned_at ?? null,
    // Thread groups / folders (DAR-742). group_id null = ungrouped. is_group_chat
    // marks the one thread per group that IS that group's own cover chat.
    group_id: conv.group_id ?? null,
    is_group_chat: !!conv.is_group_chat,
    // Where this thread's messages come in from (slack / cockpit / watch / …).
    source: deriveSource(conv.external_id),
    // True while a turn is actively processing — the authoritative signal for the
    // cockpit's status pill (fixes the "Idle while still thinking" desync).
    running: getInFlightMessageId(conv.id) != null,
    // In-progress streamed text (null unless a text block is streaming right now)
    // so a second browser opening this thread mid-run sees the live "thinking".
    live_stream: getLiveStream(conv.id),
    // Server-owned submit queue (survives refresh, mirrored across browsers).
    queued: listQueuedMessages(conv.id),
    created_at: conv.created_at,
    updated_at: conv.updated_at,
    turn_count: countTurns(conv.id),
    // Human-visible message count (user + assistant) for the sidebar badge, and
    // who spoke last for the "needs attention" color coding.
    message_count: countMessages(conv.id),
    last_message_role: getLastMessageRole(conv.id),
    continued_from_id: conv.continued_from_id,
    continued_to_id: conv.continued_to_id,
    // DAR-740 — latest point-in-time summary, for the "a summary exists" indicator.
    latest_summary: getLatestThreadSummary(conv.id),
    dashboard_url: `${proto}://${host}/conversations/${conv.id}`,
    // DAR-680 AC#4 — per-thread provider/model selection.
    // model_override reflects the explicit per-thread choice (null when inheriting
    // the global default); runtime is the resolved descriptor actually in effect.
    model_override: { adapter: conv.thread_adapter, model: conv.thread_model },
    runtime: getAdapterRuntimeDescriptor(adapter.id, model),
  };
}

// Catalog of selectable providers/models for the per-thread selector, with a
// credentials check so the UI can show which providers are usable vs. disabled.
function providerCatalog(): Array<Record<string, unknown>> {
  const adapters = getAdapters();
  return Object.values(adapters).map((a) => {
    const requiredEnv = a.runtime.auth.envKeys;
    const envSatisfied = requiredEnv.every((k) => !!process.env[k]);
    const credentialsReady = envSatisfied || a.runtime.auth.supportsLocalLogin;
    return {
      adapter: a.id,
      name: a.name,
      provider: a.runtime.provider,
      provider_label: a.runtime.providerLabel,
      transport: a.runtime.transport,
      models: a.models,
      options_schema: a.optionsSchema ?? [],
      capabilities: a.runtime.capabilities,
      credentials: {
        required_env: requiredEnv,
        env_satisfied: envSatisfied,
        supports_local_login: a.runtime.auth.supportsLocalLogin,
        ready: credentialsReady,
      },
    };
  });
}

const WATCH_PREFIX = 'From Kevin’s Watch:';
const WATCH_PREFIX_ASCII = "From Kevin's Watch:";

function serializeTurn(turn: TurnRow, convSource?: string): Record<string, unknown> {
  // Per-message source: user turns inherit the thread's ingress source (with a
  // watch override when the dictation prefix is present); everything JARVIS
  // emits is tagged 'jarvis'.
  let source: string | undefined;
  if (convSource) {
    if (turn.role === 'user') {
      const c = turn.content ?? '';
      source = (c.startsWith(WATCH_PREFIX) || c.startsWith(WATCH_PREFIX_ASCII)) ? 'watch' : convSource;
    } else {
      source = 'jarvis';
    }
  }
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
    source,
    // Raw server error/stack captured when this turn was interrupted/errored.
    // The cockpit shows it behind an expandable "Details" (Kevin's own tool → he
    // gets the real error, not just the friendly sentence).
    error_detail: turn.error_detail,
    // Structured thinking/text/tool-call timeline derived from the raw stream
    // that was already being persisted (claude_output) — lets the Details view
    // render a full trace after refresh instead of just the flattened content.
    // Null when there's nothing to derive (older turns, non-model turns).
    steps: parseTurnSteps(turn.claude_output),
    // DAR-716: user turns sent with the plan-mode marker, so the cockpit can
    // color the bubble without re-deriving it from raw content client-side.
    plan_mode: turn.role === 'user' ? isPlanModeMessage(turn.content) : false,
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

// Auto-drain the server-owned submit queue. Registered once: whenever any turn
// ends (status → not-running), the oldest queued message for that conversation
// is dispatched. Each dispatched turn's own completion drains the next, so the
// queue empties in order. This is ingress-agnostic — it works whether the turn
// that just finished came from the cockpit, Slack, or a webhook.
let queueDrainInstalled = false;
function installQueueDrain(): void {
  if (queueDrainInstalled) return;
  queueDrainInstalled = true;
  sseBus.on('sse', (ev: SSEEvent) => {
    if (ev.type !== 'status' || ev.running) return;
    const convId = ev.conversationId;
    // Defer to the next tick so this status:false event fully propagates to all
    // SSE clients BEFORE the drained turn emits its own status:true. Kicking the
    // next turn synchronously here would nest a status:true inside the status:false
    // emit and reach clients out of order (pill stuck on "idle" mid-run).
    setImmediate(() => {
      // Re-check the lock — another ingress may have grabbed the thread already.
      if (getInFlightMessageId(convId)) return;
      const next = shiftQueuedMessage(convId);
      if (!next) return;
      const conv = getConversationById(convId);
      if (!conv) return;

      const nextIndex = countTurns(convId);
      const messageId = `turn:${convId}:${nextIndex}`;
      errorByMessageId.delete(messageId);
      processMessage(next.content, conv.external_id, messageId).catch((err: unknown) => {
        // Lost the per-conversation mutex to another ingress mid-drain — re-queue
        // so the message isn't dropped; the winning turn's completion drains it.
        if (err instanceof ConversationBusyError) {
          enqueueMessage(convId, next.content);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        errorByMessageId.set(messageId, { code: 'jarvis_error', message });
      });
    });
  });
}

export function createApiV1Router(): Router {
  const router: Router = Router();

  router.use(bearerAuth as (req: Request, res: Response, next: NextFunction) => void);
  installQueueDrain();

  // -- GET /brief: JARVIS-authored cockpit landing view -----------------------
  // Not a fixed dashboard — JARVIS decides the content and shape fresh each
  // time it goes stale (see jarvis-brief.ts). ?refresh=1 forces regeneration.

  router.get('/brief', async (req: AuthedRequest, res) => {
    try {
      const brief = await getBrief(req.query.refresh === '1');
      res.json(brief);
    } catch (err) {
      sendError(res, 500, 'brief_failed', (err as Error).message);
    }
  });

  // -- GET /providers: selectable provider/model catalog ---------------------
  // Populates the per-thread provider/model selector (DAR-680 AC#4).

  router.get('/providers', (_req: AuthedRequest, res) => {
    res.json({ providers: providerCatalog() });
  });

  // -- GET /provider-usage: Claude quota meter (DAR-696) ---------------------
  // Primary source: /tmp/claude-usage-live.json, refreshed every 60s by a
  // systemd timer (claude-usage-poll.timer) hitting the authenticated
  // claude.ai usage endpoint directly — live regardless of whether a Claude
  // Code session is active. Falls back to the passive statusline dump
  // (~/.claude/statusline-dump.sh, only updates while Claude Code is in use)
  // if the live file is missing or stale.

  router.get('/provider-usage', (_req: AuthedRequest, res) => {
    const LIVE_PATH = '/tmp/claude-usage-live.json';
    const LIVE_STALE_MS = 3 * 60 * 1000;
    try {
      const st = statSync(LIVE_PATH);
      const ageMs = Date.now() - st.mtimeMs;
      if (ageMs <= LIVE_STALE_MS) {
        const raw = JSON.parse(readFileSync(LIVE_PATH, 'utf8')) as {
          five_hour?: { utilization?: number; resets_at?: string };
          seven_day?: { utilization?: number; resets_at?: string };
        };
        const toWindow = (w?: { utilization?: number; resets_at?: string }) =>
          w?.utilization != null && w?.resets_at
            ? { used_percentage: w.utilization, resets_at: Math.floor(new Date(w.resets_at).getTime() / 1000) }
            : null;
        const five_hour = toWindow(raw.five_hour);
        const seven_day = toWindow(raw.seven_day);
        if (five_hour || seven_day) {
          res.json({
            claude: {
              five_hour,
              seven_day,
              model: null,
              updated_at: Math.floor(st.mtimeMs / 1000),
            },
          });
          return;
        }
      }
    } catch {
      // fall through to statusline source
    }

    const STATUSLINE_PATH = '/tmp/claude-status.json';
    const STATUSLINE_STALE_MS = 5 * 60 * 1000;
    try {
      const st = statSync(STATUSLINE_PATH);
      const ageMs = Date.now() - st.mtimeMs;
      if (ageMs > STATUSLINE_STALE_MS) {
        res.json({ claude: null });
        return;
      }
      const raw = JSON.parse(readFileSync(STATUSLINE_PATH, 'utf8')) as {
        rate_limits?: {
          five_hour?: { used_percentage?: number; resets_at?: number };
          seven_day?: { used_percentage?: number; resets_at?: number };
        };
        model?: { display_name?: string };
      };
      const rl = raw.rate_limits;
      if (!rl?.five_hour && !rl?.seven_day) {
        res.json({ claude: null });
        return;
      }
      res.json({
        claude: {
          five_hour: rl.five_hour ?? null,
          seven_day: rl.seven_day ?? null,
          model: raw.model?.display_name ?? null,
          updated_at: Math.floor(st.mtimeMs / 1000),
        },
      });
    } catch {
      res.json({ claude: null });
    }
  });

  // -- GET /mcp/servers: live MCP Connection Manager list --------------------
  // DAR-676 MCP manager pane / DAR-677 Phase 3. Sources the live server list +
  // connection status from the same `claude` CLI config the MCP bridge uses.

  router.get('/mcp/servers', (_req: AuthedRequest, res) => {
    listMcpServers()
      .then((result) => res.json(result))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        sendError(res, 502, 'mcp_list_failed', message);
      });
  });

  // -- POST /mcp/servers/refresh: force a fresh probe (reconnect action) ------

  router.post('/mcp/servers/refresh', (_req: AuthedRequest, res) => {
    refreshMcpServers()
      .then((result) => res.json(result))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        sendError(res, 502, 'mcp_refresh_failed', message);
      });
  });

  // -- POST /mcp/servers/:id/health-check: per-server fresh probe (DAR-677 P3) -
  // `claude mcp list` probes every server in one shot, so a per-id check forces
  // that fresh probe and returns just the requested server's current status.
  // 404 if the id is not in the live list.

  router.post('/mcp/servers/:id/health-check', (req: AuthedRequest, res) => {
    const id = paramString(req.params.id);
    refreshMcpServers()
      .then((result) => {
        const server = result.servers.find((s) => s.id === id);
        if (!server) {
          sendError(res, 404, 'mcp_server_not_found', `no MCP server with id '${id}'`);
          return;
        }
        res.json({ server, checked_at: result.checked_at, stale: result.stale });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        sendError(res, 502, 'mcp_health_check_failed', message);
      });
  });

  // -- GET /mcp/servers/:id/tools: enumerate a server's published tools (P3) ---
  // Native-reachable servers (smarty-pants) are introspected live via the
  // Streamable-HTTP `tools/list`. The claude.ai OAuth connectors have no local
  // tokens — their tools are only enumerable through a full model turn on the
  // CLI bridge, which is too costly for a UI drawer — so we honestly report
  // them as not introspectable rather than spinning a model to guess.

  router.get('/mcp/servers/:id/tools', (req: AuthedRequest, res) => {
    const id = paramString(req.params.id);
    listMcpServers()
      .then(async (result) => {
        const server = result.servers.find((s) => s.id === id);
        if (!server) {
          sendError(res, 404, 'mcp_server_not_found', `no MCP server with id '${id}'`);
          return;
        }
        if (!resolveNativeServer(server.name)) {
          res.json({
            server_id: server.id,
            name: server.name,
            source: 'bridge',
            introspectable: false,
            reason: 'oauth_connector_no_local_tokens',
            tool_count: null,
            tools: [],
          });
          return;
        }
        const listed = await nativeListTools(server.name);
        if (!listed.ok) {
          sendError(res, 502, 'mcp_tools_failed', listed.error ?? 'tools/list failed');
          return;
        }
        res.json({
          server_id: server.id,
          name: server.name,
          source: 'native',
          introspectable: true,
          tool_count: listed.tools.length,
          tools: listed.tools,
          duration_ms: listed.duration_ms,
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        sendError(res, 502, 'mcp_tools_failed', message);
      });
  });

  // -- GET /decisions: global Decision Ledger (DAR-676 added scope) -----------
  // Low-key audit view. Admin callers see all decisions; others see only their
  // own threads' decisions.

  router.get('/decisions', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit ?? '100'), 10) || 100));
    const decidedBy = typeof req.query.decided_by === 'string' ? req.query.decided_by : undefined;
    const all = listJarvisDecisions({
      decidedBy: decidedBy === 'kevin' || decidedBy === 'jarvis' ? decidedBy : undefined,
      limit,
    });
    const seesAll = isAdminScope(caller.scope);
    const prefix = callerExternalIdPrefix(caller.id);
    const visible = all.filter((d) =>
      seesAll || (d.conversation_external_id != null && d.conversation_external_id.startsWith(prefix)),
    );
    res.json({ decisions: visible.map(serializeDecision) });
  });

  // == Quick-capture notes (DAR-701) ============================================
  // Hotkey in the cockpit pops a modal -> POST here -> triaged async in the
  // background (filed as an issue if buildable, or given a short researched take
  // if it's just an idea). Not thread-scoped; every caller sees the same list.

  router.get('/notes', (_req: AuthedRequest, res) => {
    const limit = Math.max(1, Math.min(500, parseInt(String(_req.query.limit ?? '100'), 10) || 100));
    res.json({ notes: listNotes(limit) });
  });

  router.post('/notes', (req: AuthedRequest, res) => {
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) {
      sendError(res, 400, 'content_required', 'content is required');
      return;
    }
    const note = createNote(content);
    triageNote(note).catch((err) => {
      console.error('[notes] triage failed unexpectedly', err);
    });
    res.status(201).json({ note });
  });

  // == Quick-capture todo widget (DAR-737) =====================================
  // Standalone scratchpad list, not tied to any thread/task/project.

  router.get('/quick-capture', (_req: AuthedRequest, res) => {
    res.json({ items: listActiveQuickCaptureItems() });
  });

  router.post('/quick-capture', (req: AuthedRequest, res) => {
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) {
      sendError(res, 400, 'content_required', 'content is required');
      return;
    }
    const item = createQuickCaptureItem(content);
    res.status(201).json({ item });
  });

  router.patch('/quick-capture/reorder', (req: AuthedRequest, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'number')) {
      sendError(res, 400, 'ids_required', 'ids must be an array of item ids in the desired order');
      return;
    }
    const items = reorderQuickCaptureItems(ids as number[]);
    res.json({ items });
  });

  router.patch('/quick-capture/:id', (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!getQuickCaptureItem(id)) {
      sendError(res, 404, 'item_not_found', 'quick-capture item not found');
      return;
    }
    let item = getQuickCaptureItem(id);
    if (typeof req.body?.content === 'string') {
      const content = req.body.content.trim();
      if (!content) {
        sendError(res, 400, 'content_required', 'content cannot be empty');
        return;
      }
      item = renameQuickCaptureItem(id, content);
    }
    if (typeof req.body?.completed === 'boolean') {
      item = setQuickCaptureItemCompleted(id, req.body.completed);
    }
    res.json({ item });
  });

  router.delete('/quick-capture/:id', (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!getQuickCaptureItem(id)) {
      sendError(res, 404, 'item_not_found', 'quick-capture item not found');
      return;
    }
    deleteQuickCaptureItem(id);
    res.status(204).end();
  });

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
    const seesAllThreads = isAdminScope(caller.scope);
    const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const statusFilter = typeof req.query.status === 'string' ? req.query.status : null;

    const all = listAllConversations();
    const filtered = all.filter((c) => {
      if (!seesAllThreads && !c.external_id.startsWith(prefix)) return false;
      if (statusFilter && c.status !== statusFilter) return false;
      return true;
    }).slice(0, limit);

    res.json({ threads: filtered.map((c) => threadDescriptor(c, req)) });
  });

  // -- POST /threads/search: AI-mediated natural-language search (DAR-741) ---
  // Synchronous (unlike auto-title/summarize's fire-and-forget 202s) — the
  // cockpit's search modal is waiting on this response to render results.

  router.post('/threads/search', async (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const prefix = callerExternalIdPrefix(caller.id);
    const seesAllThreads = isAdminScope(caller.scope);
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) {
      sendError(res, 400, 'missing_query', 'query is required');
      return;
    }

    const candidates = listAllConversations().filter(
      (c) => seesAllThreads || c.external_id.startsWith(prefix),
    );

    try {
      const matches = await searchThreadsByQuery(query, candidates);
      const byId = new Map(candidates.map((c) => [c.external_id, c]));
      const results: Record<string, unknown>[] = [];
      for (const m of matches) {
        const conv = byId.get(m.thread_id);
        if (conv) results.push({ ...threadDescriptor(conv, req), search_reason: m.reason });
      }
      res.json({ results });
    } catch (err) {
      console.error('[thread-search] search failed:', err);
      sendError(res, 502, 'search_failed', 'Search failed — try again');
    }
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
    const convSource = deriveSource(conv.external_id);
    res.json({
      ...threadDescriptor(conv, req),
      turns: turns.map((t) => serializeTurn(t, convSource)),
    });
  });

  // -- PATCH /threads/:external_id/model: set/clear per-thread provider+model -
  // DAR-680 AC#4. Body: { adapter: string|null, model?: string|null }.
  // Pass adapter:null to clear the override (thread inherits the global default).

  router.patch('/threads/:external_id/model', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const conv = result;

    const body = (req.body ?? {}) as { adapter?: unknown; model?: unknown };
    const adapters = getAdapters();

    // Clear the override → inherit the global default.
    if (body.adapter === null) {
      setThreadModelOverride(conv.id, null, null);
      const refreshed = getConversationById(conv.id) ?? conv;
      res.json(threadDescriptor(refreshed, req));
      return;
    }

    if (typeof body.adapter !== 'string' || !adapters[body.adapter]) {
      sendError(res, 400, 'invalid_request', `adapter must be one of ${Object.keys(adapters).join(', ')} (or null to clear)`);
      return;
    }
    const adapter = adapters[body.adapter];

    let model: string | null = null;
    if (body.model !== undefined && body.model !== null) {
      if (typeof body.model !== 'string' || !adapter.models.some((m) => m.id === body.model)) {
        sendError(res, 400, 'invalid_request', `model must be one of ${adapter.models.map((m) => m.id).join(', ')} for adapter ${adapter.id} (or null for adapter default)`);
        return;
      }
      model = body.model;
    }

    setThreadModelOverride(conv.id, adapter.id, model);
    const refreshed = getConversationById(conv.id) ?? conv;
    res.json(threadDescriptor(refreshed, req));
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
      updateSessionState(cloneConv.id, parent.claude_session_id, parent.session_adapter);
    }
    linkContinuedThreads(parent.id, cloneConv.id);

    // Refresh conv row so continued_from_id shows up in the response
    const refreshed = getConversationById(cloneConv.id) ?? cloneConv;
    res.status(201).json({
      ...threadDescriptor(refreshed, req),
      predecessor_thread_id: parent.external_id,
    });
  });

  // -- PATCH /threads/:external_id: rename, archive ---------------------------
  // Body: { title?: string|null, status?: 'active'|'archived' }. Distinct from
  // the /model sub-route (Express matches that more specific path first).

  router.patch('/threads/:external_id', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const conv = result;
    const body = (req.body ?? {}) as {
      title?: unknown;
      status?: unknown;
      pinned?: unknown;
      group_id?: unknown;
    };

    if (body.title !== undefined) {
      if (body.title !== null && typeof body.title !== 'string') {
        sendError(res, 400, 'invalid_request', 'title must be a string or null');
        return;
      }
      const t = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : null;
      renameConversation(conv.id, t && t.length ? t : null);
    }
    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'archived') {
        sendError(res, 400, 'invalid_request', "status must be 'active' or 'archived'");
        return;
      }
      setConversationStatus(conv.id, body.status);
    }
    if (body.pinned !== undefined) {
      if (typeof body.pinned !== 'boolean') {
        sendError(res, 400, 'invalid_request', 'pinned must be a boolean');
        return;
      }
      setThreadPinned(conv.id, body.pinned);
    }
    if (body.group_id !== undefined) {
      if (body.group_id !== null && typeof body.group_id !== 'number') {
        sendError(res, 400, 'invalid_request', 'group_id must be a number or null');
        return;
      }
      if (conv.is_group_chat) {
        sendError(res, 400, 'invalid_request', 'A group\'s own cover chat cannot be re-filed into a group');
        return;
      }
      if (body.group_id !== null && !getGroupById(body.group_id)) {
        sendError(res, 404, 'group_not_found', `Group ${body.group_id} not found`);
        return;
      }
      setThreadGroup(conv.id, body.group_id);
    }
    const refreshed = getConversationById(conv.id) ?? conv;
    res.json(threadDescriptor(refreshed, req));
  });

  // -- Thread groups / folders (DAR-742) --------------------------------------

  // GET /groups: list all groups with their member threads + cover chat.
  router.get('/groups', (req: AuthedRequest, res) => {
    const groups = listGroups();
    res.json({
      groups: groups.map((g) => {
        const groupChatConv = getConversation(`cockpit:group:${g.id}`);
        const members = listAllConversations().filter((c) => c.group_id === g.id && !c.is_group_chat);
        return {
          ...g,
          group_chat: groupChatConv ? threadDescriptor(groupChatConv, req) : null,
          members: members.map((c) => threadDescriptor(c, req)),
        };
      }),
    });
  });

  // POST /groups: create a group + its cover chat. Body: { name, color? }.
  router.post('/groups', (req: AuthedRequest, res) => {
    const body = (req.body ?? {}) as { name?: unknown; color?: unknown };
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
    if (!name) {
      sendError(res, 400, 'invalid_request', 'name is required');
      return;
    }
    const color = typeof body.color === 'string' ? body.color : null;
    const { group, groupChat } = createGroup(name, color);
    res.status(201).json({ ...group, group_chat: threadDescriptor(groupChat, req), members: [] });
  });

  // PATCH /groups/:id: rename / recolor. Body: { name?, color? }.
  router.patch('/groups/:id', (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || !getGroupById(id)) {
      sendError(res, 404, 'group_not_found', `Group ${req.params.id} not found`);
      return;
    }
    const body = (req.body ?? {}) as { name?: unknown; color?: unknown };
    let group = getGroupById(id);
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
      if (!name) {
        sendError(res, 400, 'invalid_request', 'name must be a non-empty string');
        return;
      }
      group = renameGroup(id, name);
    }
    if (body.color !== undefined) {
      if (body.color !== null && typeof body.color !== 'string') {
        sendError(res, 400, 'invalid_request', 'color must be a string or null');
        return;
      }
      group = setGroupColor(id, body.color);
    }
    res.json(group);
  });

  // DELETE /groups/:id: ungroups members (never deletes threads), archives the
  // group's cover chat, drops the group row.
  router.delete('/groups/:id', (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || !getGroupById(id)) {
      sendError(res, 404, 'group_not_found', `Group ${req.params.id} not found`);
      return;
    }
    deleteGroup(id);
    res.status(204).end();
  });

  // -- POST /threads/:external_id/auto-title: manually (re)trigger the -------
  // DAR-726 auto-title logic (DAR-728), bypassing the "already titled" guard.
  // Fire-and-forget, like the send-time trigger — the title lands via the
  // existing `conversation_renamed` SSE event.
  router.post('/threads/:external_id/auto-title', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const conv = result;

    const firstMessage = getTurns(conv.id).find((t) => t.role === 'user')?.content;
    if (!firstMessage) {
      sendError(res, 400, 'no_messages', 'Thread has no messages yet to title from');
      return;
    }

    void autoNameThreadFromFirstMessage(conv, firstMessage, { force: true });
    res.status(202).json({ status: 'generating' });
  });

  // -- POST /threads/:external_id/summarize: point-in-time summary (DAR-740) --
  // Generates a "done / in progress / next" summary anchored to the last turn
  // that exists right now; async like auto-title — the client hears back over
  // the `thread_summary` SSE event once it lands.

  router.post('/threads/:external_id/summarize', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const conv = result;
    void generateThreadSummary(conv).catch((err) => {
      console.error(`[thread-summarize] failed for conversation ${conv.id}:`, err);
    });
    res.status(202).json({ status: 'generating' });
  });

  // -- GET /threads/:external_id/summaries: list persisted summaries ----------

  router.get('/threads/:external_id/summaries', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    res.json({ summaries: listThreadSummaries(result.id) });
  });

  // -- DELETE /threads/:external_id: delete thread + its turns/todos ----------

  router.delete('/threads/:external_id', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    deleteConversation(result.id);
    res.json({ deleted: true, thread_id: externalId });
  });

  // -- POST /threads/:external_id/fork: branch with full context -------------
  // Copies all turns + carries the parent's live session so the fork keeps the
  // model's context. NOTE: the fork shares the parent's claude_session_id — fine
  // for branching, but concurrent runs on both could collide. Acceptable v1.

  router.post('/threads/:external_id/fork', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const parent = result;
    const newExternalId = `${callerExternalIdPrefix(caller.id)}${randomUUID()}`;
    const fork = getOrCreateConversation(newExternalId);
    copyTurns(parent.id, fork.id);
    if (parent.claude_session_id) {
      updateSessionState(fork.id, parent.claude_session_id, parent.session_adapter);
    }
    if (parent.thread_adapter || parent.thread_model) {
      setThreadModelOverride(fork.id, parent.thread_adapter, parent.thread_model);
    }
    const baseTitle = parent.title ?? 'Thread';
    renameConversation(fork.id, `${baseTitle} (fork)`.slice(0, 200));
    linkContinuedThreads(parent.id, fork.id);
    const refreshed = getConversationById(fork.id) ?? fork;
    res.status(201).json({
      ...threadDescriptor(refreshed, req),
      forked_from: parent.external_id,
    });
  });

  // -- GET /threads/:external_id/context-markdown ----------------------------
  // Condensed context digest (deterministic, no LLM): head + tail of the
  // user/assistant exchange, for pasting into a fresh chat.

  router.get('/threads/:external_id/context-markdown', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const conv = result;
    const turns = getTurns(conv.id);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(renderContextDigest(conv, turns));
  });

  // -- POST /threads/:external_id/stop: abort the in-flight run --------------

  router.post('/threads/:external_id/stop', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const stopped = abortConversationRun(result.id);
    res.json({ stopped });
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

    // If a turn is already running, park this message on the server-owned queue
    // instead of bouncing. It's drained oldest-first when the current turn ends
    // (see the status listener below). The queue is exposed over API + SSE, so it
    // survives a refresh and stays in sync across every browser on this thread.
    const pending = getInFlightMessageId(conv.id);
    if (pending) {
      const queued = enqueueMessage(conv.id, text);
      res.status(202).json({
        status: 'queued',
        queued_id: queued.id,
        pending_message_id: pending,
      });
      return;
    }

    const nextIndex = countTurns(conv.id);
    const messageId = `turn:${conv.id}:${nextIndex}`;
    errorByMessageId.delete(messageId);

    // DAR-726: the thread's very first message, and nobody's named it yet —
    // kick off auto-naming in the background. Doesn't block the send response
    // or the actual turn; the title lands later via a `conversation_renamed` SSE.
    if (nextIndex === 0 && conv.title === null && !conv.title_is_user_set) {
      void autoNameThreadFromFirstMessage(conv, text);
    }

    processMessage(text, externalId, messageId)
      .catch((err: unknown) => {
        // A busy error here means another ingress won the mutex between the
        // pre-flight check and processMessage's synchronous registration.
        const code = err instanceof ConversationBusyError ? 'message_in_flight' : 'jarvis_error';
        const message = err instanceof Error ? err.message : String(err);
        errorByMessageId.set(messageId, { code, message });
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

  // -- DELETE /threads/:external_id/queue/:queue_id: cancel a queued message -

  router.delete('/threads/:external_id/queue/:queue_id', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const conv = result;
    const queueId = Number(paramString(req.params.queue_id));
    const owned = listQueuedMessages(conv.id).some((q) => q.id === queueId);
    if (!owned) {
      sendError(res, 404, 'queued_message_not_found', 'No such queued message on this thread');
      return;
    }
    deleteQueuedMessage(queueId);
    res.json({ status: 'cancelled', queue_id: queueId });
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
      tool_calls: toolCalls.map((t) => serializeTurn(t)),
    });
  });

  // -- GET /threads/:external_id/autonomy-ledger ----------------------------

  router.get('/threads/:external_id/autonomy-ledger', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const conv = result;

    const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const needsReview = String(req.query.needs_review ?? '').toLowerCase();
    const entries = listAutonomyLedger({
      conversationId: conv.id,
      actionType: typeof req.query.action_type === 'string' ? req.query.action_type : undefined,
      targetQuery: typeof req.query.target === 'string' ? req.query.target : undefined,
      needsReview: needsReview === '1' || needsReview === 'true',
      limit,
    });

    res.json({
      thread: threadDescriptor(conv, req),
      entries,
    });
  });

  // -- Thread reminders (auto-bump) -----------------------------------------
  //
  // A thread holds at most one active reminder. Arming replaces whatever was
  // there, so the UI's "remind me in X" is idempotent rather than stacking
  // competing alarms. Firing is handled by the reminder worker, not here.

  /** Convert an ISO instant to the UTC 'YYYY-MM-DD HH:MM:SS' SQLite stores. */
  const toSqliteUtc = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ');

  router.put('/threads/:external_id/reminder', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }

    const body = (req.body ?? {}) as {
      in_minutes?: unknown;
      fire_at?: unknown;
      note?: unknown;
      repeat_minutes?: unknown;
    };

    // Accept either a relative offset ("remind me in 30 minutes" — what the
    // preset buttons send) or an absolute instant (the date/time picker).
    let fireAt: Date;
    if (typeof body.in_minutes === 'number' && Number.isFinite(body.in_minutes)) {
      if (body.in_minutes < 1 || body.in_minutes > 60 * 24 * 365) {
        sendError(res, 400, 'invalid_request', 'in_minutes must be between 1 and 525600');
        return;
      }
      fireAt = new Date(Date.now() + body.in_minutes * 60_000);
    } else if (typeof body.fire_at === 'string') {
      const parsed = new Date(body.fire_at);
      if (Number.isNaN(parsed.getTime())) {
        sendError(res, 400, 'invalid_request', 'fire_at must be a valid ISO 8601 timestamp');
        return;
      }
      fireAt = parsed;
    } else {
      sendError(res, 400, 'invalid_request', 'one of in_minutes (number) or fire_at (ISO string) is required');
      return;
    }

    let repeatMinutes: number | null = null;
    if (body.repeat_minutes != null) {
      const n = Number(body.repeat_minutes);
      if (!Number.isFinite(n) || n < 1 || n > 60 * 24 * 7) {
        sendError(res, 400, 'invalid_request', 'repeat_minutes must be between 1 and 10080');
        return;
      }
      repeatMinutes = Math.round(n);
    }

    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null;

    const reminder = setThreadReminder(result.id, toSqliteUtc(fireAt), note, repeatMinutes);
    res.status(201).json({ reminder: serializeReminder(reminder), thread: threadDescriptor(result, req) });
  });

  /** Dismiss the current alert. A repeating reminder stays armed. */
  router.post('/threads/:external_id/reminder/ack', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const active = activeReminderForConversation(result.id);
    if (!active) {
      res.json({ reminder: null });
      return;
    }
    const acked = acknowledgeThreadReminder(active.id);
    res.json({ reminder: acked ? serializeReminder(acked) : null });
  });

  /** Turn the reminder off entirely. */
  router.delete('/threads/:external_id/reminder', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    cancelRemindersForConversation(result.id);
    res.json({ reminder: null });
  });

  // -- GET /threads/:external_id/todos: list per-thread todos ---------------

  router.get('/threads/:external_id/todos', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    res.json({ thread: threadDescriptor(result, req), todos: listThreadTodos(result.id) });
  });

  // -- POST /threads/:external_id/todos: create a todo ----------------------

  router.post('/threads/:external_id/todos', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const body = (req.body ?? {}) as { content?: unknown; owner?: unknown };
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) {
      sendError(res, 400, 'invalid_request', 'content is required and must be a non-empty string');
      return;
    }
    if (content.length > 2000) {
      sendError(res, 413, 'content_too_long', 'content exceeds max length of 2000 chars');
      return;
    }
    const owner: ThreadTodoOwner | null =
      body.owner === 'kevin' || body.owner === 'jarvis' ? body.owner : null;
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const todo = createThreadTodo(result.id, content, owner);
    res.status(201).json({ todo });
  });

  // -- PATCH /threads/:external_id/todos/:todoId: flip status / edit --------

  router.patch('/threads/:external_id/todos/:todoId', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const todoId = Number(paramString(req.params.todoId));
    const existing = getThreadTodo(todoId);
    if (!existing || existing.conversation_id !== result.id) {
      sendError(res, 404, 'todo_not_found', 'Todo not found on this thread');
      return;
    }
    const body = (req.body ?? {}) as { status?: unknown; content?: unknown; owner?: unknown };
    const validStatuses: ThreadTodoStatus[] = ['todo', 'doing', 'done'];
    let updated = existing;
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !validStatuses.includes(body.status as ThreadTodoStatus)) {
        sendError(res, 400, 'invalid_request', `status must be one of ${validStatuses.join(', ')}`);
        return;
      }
      updated = updateThreadTodoStatus(todoId, body.status as ThreadTodoStatus) ?? updated;
    }
    if (typeof body.content === 'string' && body.content.trim()) {
      updated = updateThreadTodoContent(todoId, body.content.trim()) ?? updated;
    }
    if (body.owner !== undefined) {
      const owner: ThreadTodoOwner | null =
        body.owner === 'kevin' || body.owner === 'jarvis' ? body.owner : null;
      updated = updateThreadTodoOwner(todoId, owner) ?? updated;
    }
    res.json({ todo: updated });
  });

  // -- DELETE /threads/:external_id/todos/:todoId: remove a todo -------------

  router.delete('/threads/:external_id/todos/:todoId', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const todoId = Number(paramString(req.params.todoId));
    const existing = getThreadTodo(todoId);
    if (!existing || existing.conversation_id !== result.id) {
      sendError(res, 404, 'todo_not_found', 'Todo not found on this thread');
      return;
    }
    deleteThreadTodo(todoId);
    res.json({ status: 'deleted', todo_id: todoId });
  });

  // -- POST /threads/:external_id/todos/:todoId/promote-to-shim -------------

  router.post('/threads/:external_id/todos/:todoId/promote-to-shim', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const todoId = Number(paramString(req.params.todoId));
    const existing = getThreadTodo(todoId);
    if (!existing || existing.conversation_id !== result.id) {
      sendError(res, 404, 'todo_not_found', 'Todo not found on this thread');
      return;
    }
    if (existing.shim_task_id) {
      sendError(res, 409, 'already_promoted', 'This todo has already been promoted to a SHIM task', {
        shim_task_id: existing.shim_task_id,
      });
      return;
    }
    createShimTask
      .execute({ title: existing.content })
      .then((shimResult: unknown) => {
        const record = shimResult && typeof shimResult === 'object' ? (shimResult as Record<string, unknown>) : null;
        const taskRecord = record && record.task && typeof record.task === 'object'
          ? (record.task as Record<string, unknown>)
          : null;
        const rawId = taskRecord?.id ?? record?.id;
        const shimId = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : null;
        if (!shimId) {
          sendError(res, 502, 'shim_promote_failed', 'SHIM did not return a task id', { shim_result: shimResult });
          return;
        }
        const updated = setThreadTodoShimTask(todoId, shimId);
        res.status(201).json({ todo: updated, shim_task: shimResult });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        sendError(res, 502, 'shim_promote_failed', message);
      });
  });

  // -- GET /threads/:external_id/decisions: per-thread Decision Ledger -------

  router.get('/threads/:external_id/decisions', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit ?? '100'), 10) || 100));
    const decisions = listJarvisDecisions({ conversationId: result.id, limit });
    res.json({ thread: threadDescriptor(result, req), decisions: decisions.map(serializeDecision) });
  });

  // -- POST /threads/:external_id/decisions: record a decision ---------------

  router.post('/threads/:external_id/decisions', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const body = (req.body ?? {}) as {
      question?: unknown;
      options?: unknown;
      decided_by?: unknown;
      decision?: unknown;
      rationale?: unknown;
      related_issue?: unknown;
    };
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    const decision = typeof body.decision === 'string' ? body.decision.trim() : '';
    if (!question || !decision) {
      sendError(res, 400, 'invalid_request', 'question and decision are required non-empty strings');
      return;
    }
    const decidedByRaw = typeof body.decided_by === 'string' ? body.decided_by.toLowerCase() : 'jarvis';
    const decidedBy: DecidedBy = decidedByRaw === 'kevin' ? 'kevin' : 'jarvis';
    const options = Array.isArray(body.options) ? body.options.map((o) => String(o)).filter((o) => o.trim()) : null;
    const row = insertJarvisDecision(
      {
        question,
        options,
        decidedBy,
        decision,
        rationale: typeof body.rationale === 'string' ? body.rationale.trim() || null : null,
        relatedIssue: typeof body.related_issue === 'string' ? body.related_issue.trim() || null : null,
      },
      { conversationId: result.id, externalId: result.external_id, sourceMessageId: '', sourceTimestamp: '', originalText: '' },
    );
    res.status(201).json({ decision: serializeDecision(row) });
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
      // Status events now carry conversationId, so they flow through the same
      // per-conversation filter as everything else — a thread client only sees
      // its own thread's running/idle transitions, never another thread's.
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

  // -- GET /events: GLOBAL stream across all of the caller's threads ----------
  // Powers the sidebar's live view — a Slack message landing on any thread, or
  // JARVIS replying to it, bumps + re-statuses the row in real time without the
  // thread being open. Forwards the list-relevant events, plus (DAR-717)
  // per-token stream_* events annotated with external_id so a client CAN fold
  // its per-thread live connection into this one instead of opening a second
  // long-lived SSE connection per open tab — see DAR-717 for why that matters
  // (plain HTTP/1.1 caps a browser at ~6 connections per origin; today's two
  // SSE connections per tab means as few as 3 open tabs exhausts it). Nothing
  // consumes these here yet — the cockpit still opens its own per-thread
  // stream — this is prep for that consolidation, additive and unused until
  // the frontend is updated to rely on it.
  router.get('/events', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const seesAll = isAdminScope(caller.scope);
    const prefix = callerExternalIdPrefix(caller.id);
    const FORWARD = new Set([
      'turn', 'conversation_updated', 'conversation_created',
      'conversation_renamed', 'conversation_deleted', 'status', 'thread_todo',
      'thread_reminder',
      'queued_message', 'note', 'stream_start', 'stream_delta', 'stream_end',
      'quick_capture', 'thread_summary',
    ]);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':\n\n');
    const heartbeat = setInterval(() => res.write(':\n\n'), 15000);

    const handler = (ev: SSEEvent) => {
      if (!FORWARD.has(ev.type)) return;
      // Scope non-admin callers to their own threads.
      if (!seesAll && 'conversationId' in ev) {
        const c = getConversationById(ev.conversationId);
        if (!c || !c.external_id.startsWith(prefix)) return;
      }
      // Annotate with external_id so the client can key the sidebar without a
      // separate id→thread lookup.
      let extId: string | undefined;
      if ('conversationId' in ev) extId = getConversationById(ev.conversationId)?.external_id;
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify({ ...ev, external_id: extId })}\n\n`);
    };

    sseBus.on('sse', handler);
    res.on('close', () => {
      clearInterval(heartbeat);
      sseBus.off('sse', handler);
    });
  });

  // == Model Presets (DAR-692) =================================================
  // A preset bundles { adapter, model, options } under a named id. Activating one
  // sets the global default adapter + model + adapter_options in the settings KV
  // and persists the active_preset id. Per-thread overrides (DAR-680) still win.

  interface ModelPreset {
    id: string;
    name: string;
    adapter: string;
    model: string | null;
    options: Record<string, unknown>;
  }

  const DEFAULT_PRESETS: ModelPreset[] = [
    { id: 'anthropic-opus', name: 'Anthropic / Opus', adapter: 'claude', model: 'claude-opus-4-8', options: { thinking: 'high' } },
    { id: 'codex', name: 'Codex', adapter: 'codex', model: 'gpt-5.1-codex', options: {} },
  ];

  function loadPresets(): ModelPreset[] {
    const raw = getSetting('model_presets');
    if (raw) {
      try { return JSON.parse(raw) as ModelPreset[]; } catch {}
    }
    // Seed defaults on first use
    setSetting('model_presets', JSON.stringify(DEFAULT_PRESETS));
    return DEFAULT_PRESETS;
  }

  function savePresets(presets: ModelPreset[]): void {
    setSetting('model_presets', JSON.stringify(presets));
  }

  router.get('/presets', (_req: AuthedRequest, res) => {
    const presets = loadPresets();
    const activeId = getSetting('active_preset');
    const adapters = getAdapters();
    res.json({
      presets: presets.map((p) => ({
        ...p,
        options_schema: adapters[p.adapter]?.optionsSchema ?? [],
      })),
      active_preset_id: activeId,
    });
  });

  router.post('/presets', (req: AuthedRequest, res) => {
    if (!isAdminScope(req.apiKey!.scope)) {
      sendError(res, 403, 'admin_scope_required', 'Managing presets requires an admin-scoped key');
      return;
    }
    const body = (req.body ?? {}) as { id?: unknown; name?: unknown; adapter?: unknown; model?: unknown; options?: unknown };
    if (typeof body.name !== 'string' || !body.name.trim()) {
      sendError(res, 400, 'invalid_request', 'name is required');
      return;
    }
    const adapters = getAdapters();
    if (typeof body.adapter !== 'string' || !adapters[body.adapter]) {
      sendError(res, 400, 'invalid_request', `adapter must be one of ${Object.keys(adapters).join(', ')}`);
      return;
    }
    const presets = loadPresets();
    const id = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : randomUUID();
    const existing = presets.findIndex((p) => p.id === id);
    const preset: ModelPreset = {
      id,
      name: body.name.trim(),
      adapter: body.adapter,
      model: typeof body.model === 'string' ? body.model : null,
      options: (body.options && typeof body.options === 'object' && !Array.isArray(body.options))
        ? body.options as Record<string, unknown>
        : {},
    };
    if (existing >= 0) {
      presets[existing] = preset;
    } else {
      presets.push(preset);
    }
    savePresets(presets);
    res.json({ ok: true, preset });
  });

  router.delete('/presets/:id', (req: AuthedRequest, res) => {
    if (!isAdminScope(req.apiKey!.scope)) {
      sendError(res, 403, 'admin_scope_required', 'Managing presets requires an admin-scoped key');
      return;
    }
    const id = paramString(req.params.id);
    const presets = loadPresets();
    const idx = presets.findIndex((p) => p.id === id);
    if (idx < 0) {
      sendError(res, 404, 'not_found', `Preset ${id} not found`);
      return;
    }
    presets.splice(idx, 1);
    savePresets(presets);
    // Clear active_preset if it was the deleted one
    if (getSetting('active_preset') === id) deleteSetting('active_preset');
    res.json({ ok: true });
  });

  router.post('/presets/:id/activate', (req: AuthedRequest, res) => {
    if (!isAdminScope(req.apiKey!.scope)) {
      sendError(res, 403, 'admin_scope_required', 'Managing presets requires an admin-scoped key');
      return;
    }
    const id = paramString(req.params.id);
    const presets = loadPresets();
    const preset = presets.find((p) => p.id === id);
    if (!preset) {
      sendError(res, 404, 'not_found', `Preset ${id} not found`);
      return;
    }
    setSetting('adapter', preset.adapter);
    if (preset.model) {
      setSetting('model', preset.model);
    } else {
      deleteSetting('model');
    }
    setSetting('adapter_options', JSON.stringify(preset.options));
    setSetting('active_preset', preset.id);
    const info = getActiveAdapterInfo();
    res.json({ ok: true, preset, active_adapter: info.adapter, active_model: info.model });
  });

  // == Settings (DAR-676 — port of the 3201 /settings page) ===================
  // GET returns the active adapter/model, the provider-neutral runtime
  // descriptor (DAR-680), and the full adapter catalog. POST sets the GLOBAL
  // default adapter/model (applies to new turns). Mutation is admin-scoped.

  router.get('/settings', (_req: AuthedRequest, res) => {
    const info = getActiveAdapterInfo();
    res.json({
      settings: getAllSettings(),
      active_adapter: info.adapter,
      active_model: info.model,
      active_runtime: getActiveRuntimeDescriptor(),
      active_preset_id: getSetting('active_preset'),
      adapter_options: (() => { try { return JSON.parse(getSetting('adapter_options') ?? '{}'); } catch { return {}; } })(),
      adapters: providerCatalog(),
    });
  });

  router.post('/settings', (req: AuthedRequest, res) => {
    if (!isAdminScope(req.apiKey!.scope)) {
      sendError(res, 403, 'admin_scope_required', 'Changing global settings requires an admin-scoped key');
      return;
    }
    const { adapter, model } = (req.body ?? {}) as { adapter?: string; model?: string };
    const adapters = getAdapters();
    if (adapter != null) {
      if (!adapters[adapter]) {
        sendError(res, 400, 'unknown_adapter', `Unknown adapter: ${adapter}`);
        return;
      }
      setSetting('adapter', adapter);
    }
    if (model != null) {
      setSetting('model', model);
    }
    const info = getActiveAdapterInfo();
    res.json({ ok: true, active_adapter: info.adapter, active_model: info.model });
  });

  // == Control panel (DAR-729) =================================================
  // Live run count + historical run log + personality stats w/ change history,
  // for the JARVIS Cockpit's new Control Panel tab. Read endpoints are open to
  // any authed key (same as /settings GET); writes require admin scope.

  router.get('/control-panel/active-runs', (_req: AuthedRequest, res) => {
    res.json({ count: getActiveRunCount(), runs: getActiveRuns() });
  });

  router.get('/control-panel/run-history', (req: AuthedRequest, res) => {
    const limitRaw = parseInt(String(req.query.limit ?? '50'), 10);
    const offsetRaw = parseInt(String(req.query.offset ?? '0'), 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 50;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;
    const { rows, total } = listRunHistory(limit, offset);
    res.json({
      total,
      limit,
      offset,
      runs: rows.map((r) => {
        const running = getInFlightMessageId(r.id) != null;
        return {
          conversation_id: r.id,
          external_id: r.external_id,
          title: r.title,
          source: deriveSource(r.external_id),
          status: r.status,
          started_at: r.created_at,
          updated_at: r.updated_at,
          duration_seconds: r.duration_seconds,
          turn_count: r.turn_count,
          tool_call_count: r.tool_call_count,
          outcome: classifyRunOutcome(running, r.status, r.error_count, r.last_error_detail),
          running,
        };
      }),
    });
  });

  // Turn-by-turn detail for a single run (DAR-732) — powers the Control Panel's
  // click-into-a-run-history-row drill-down. `getTurns` already returns the raw
  // rows in turn_index order (user/assistant/tool_call/tool_result), so this is
  // a thin wrapper that adds the conversation summary + outcome around them.
  router.get('/control-panel/run-history/:id/turns', (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(id)) {
      sendError(res, 400, 'invalid_request', 'id must be a number');
      return;
    }
    const conversation = getConversationById(id);
    if (!conversation) {
      sendError(res, 404, 'not_found', `No conversation with id ${id}`);
      return;
    }
    const turns = getTurns(id);
    const errorCount = turns.filter((t) => t.error_detail != null).length;
    const lastErrorDetail = [...turns].reverse().find((t) => t.error_detail != null)?.error_detail ?? null;
    const running = getInFlightMessageId(id) != null;
    res.json({
      conversation: {
        conversation_id: conversation.id,
        external_id: conversation.external_id,
        title: conversation.title,
        source: deriveSource(conversation.external_id),
        status: conversation.status,
        started_at: conversation.created_at,
        updated_at: conversation.updated_at,
        outcome: classifyRunOutcome(running, conversation.status, errorCount, lastErrorDetail),
        running,
      },
      turns,
    });
  });

  router.get('/control-panel/personality-stats', (_req: AuthedRequest, res) => {
    res.json({ stats: getPersonalityStats(), keys: PERSONALITY_STAT_KEYS });
  });

  router.patch('/control-panel/personality-stats', (req: AuthedRequest, res) => {
    if (!isAdminScope(req.apiKey!.scope)) {
      sendError(res, 403, 'admin_scope_required', 'Changing personality stats requires an admin-scoped key');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<Record<(typeof PERSONALITY_STAT_KEYS)[number], number>> = {};
    for (const key of PERSONALITY_STAT_KEYS) {
      const value = body[key];
      if (value === undefined) continue;
      const num = Number(value);
      if (!Number.isFinite(num)) {
        sendError(res, 400, 'invalid_request', `${key} must be a number`);
        return;
      }
      patch[key] = num;
    }
    if (Object.keys(patch).length === 0) {
      sendError(res, 400, 'invalid_request', `Provide at least one of: ${PERSONALITY_STAT_KEYS.join(', ')}`);
      return;
    }
    const stats = updatePersonalityStats(patch, req.apiKey!.caller_label ?? null);
    res.json({ ok: true, stats });
  });

  router.get('/control-panel/personality-stats/history', (req: AuthedRequest, res) => {
    const limitRaw = parseInt(String(req.query.limit ?? '100'), 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 100;
    res.json({ history: getPersonalityStatsHistory(limit) });
  });

  // == Check-ins (DAR-676 — port of the 3201 /checkins page) ==================
  // Read-only view of JARVIS's scheduled check-in queue (Paperclip Postgres).

  router.get('/checkins', (_req: AuthedRequest, res) => {
    Promise.all([
      query(
        `SELECT id, fire_at, reason, source_type, source_id, status FROM jarvis_checkins WHERE status = 'pending' ORDER BY fire_at ASC LIMIT 100`,
      ),
      query(
        `SELECT id, fire_at, reason, source_type, source_id, status FROM jarvis_checkins WHERE status != 'pending' ORDER BY fire_at DESC LIMIT 30`,
      ),
    ])
      .then(([pending, recent]) => res.json({ pending, recent }))
      .catch((err: unknown) => {
        sendError(res, 502, 'checkins_query_failed', err instanceof Error ? err.message : String(err));
      });
  });

  // == Memory Vault (DAR-676 — port of the 3201 /vault page) ==================
  // Auth'd wrappers over the Obsidian vault reader. Read-only in the cockpit;
  // path-safety is enforced in vault-page.ts (throws on escape → 400).

  router.get('/vault/tree', (req: AuthedRequest, res) => {
    listVaultTree(paramString(req.query.path as string | undefined))
      .then((result) => res.json(result))
      .catch((err: unknown) => sendError(res, 400, 'vault_tree_failed', err instanceof Error ? err.message : String(err)));
  });

  router.get('/vault/file', (req: AuthedRequest, res) => {
    const path = paramString(req.query.path as string | undefined);
    if (!path) {
      sendError(res, 400, 'path_required', 'A file path is required');
      return;
    }
    readVaultFile(path)
      .then((result) => res.json(result))
      .catch((err: unknown) => sendError(res, 400, 'vault_file_failed', err instanceof Error ? err.message : String(err)));
  });

  router.get('/vault/search', (req: AuthedRequest, res) => {
    const q = paramString(req.query.q as string | undefined);
    if (!q) {
      res.json({ query: '', results: [] });
      return;
    }
    searchVault(q)
      .then((result) => res.json(result))
      .catch((err: unknown) => sendError(res, 400, 'vault_search_failed', err instanceof Error ? err.message : String(err)));
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

// Condensed context digest: keep the first HEAD and last TAIL user/assistant
// exchanges (tool turns dropped), assistant replies truncated. Deterministic and
// instant — no model call. For "carry the gist into a fresh thread".
function renderContextDigest(conv: ConversationRow, turns: TurnRow[]): string {
  const HEAD = 5;
  const TAIL = 20;
  const ASSISTANT_CAP = 1500;
  const convo = turns.filter((t) => t.role === 'user' || t.role === 'assistant');
  const render = (t: TurnRow): string => {
    const who = t.role === 'user' ? 'User' : 'JARVIS';
    let body = t.content ?? '';
    if (t.role === 'assistant' && body.length > ASSISTANT_CAP) {
      body = body.slice(0, ASSISTANT_CAP) + ' …[truncated]';
    }
    return `**${who}:** ${body}`;
  };
  const lines: string[] = [];
  lines.push(`# Context digest — ${conv.title ?? conv.external_id}`);
  lines.push('');
  lines.push(`- Source thread: ${conv.external_id}`);
  lines.push(`- Created: ${conv.created_at} UTC · Exchanges: ${convo.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  if (convo.length <= HEAD + TAIL) {
    for (const t of convo) { lines.push(render(t)); lines.push(''); }
  } else {
    for (const t of convo.slice(0, HEAD)) { lines.push(render(t)); lines.push(''); }
    lines.push(`_… ${convo.length - HEAD - TAIL} earlier exchanges elided …_`);
    lines.push('');
    for (const t of convo.slice(-TAIL)) { lines.push(render(t)); lines.push(''); }
  }
  return lines.join('\n');
}
