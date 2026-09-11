import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { statSync, readFileSync } from 'node:fs';
import { displayContentFromRawOutput, parseTurnSteps } from '../turn-steps.js';
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
  setThreadDisplay,
  setThreadGroup,
  setThreadPassword,
  clearThreadPassword,
  verifyThreadPassword,
  isThreadLocked,
  deleteConversation,
  copyTurns,
  type ConversationRow,
  type TurnRow,
} from '../conversation-db.js';
import {
  listGroups,
  getGroupById,
  createGroup,
  ensureGroupChat,
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
  listNotifications,
  unreadNotificationCount,
  createNotification,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  getNotification,
  type NotificationSeverity,
  type NotificationAction,
  type NotificationMeta,
} from '../notifications.js';
import {
  listHopperItems,
  getHopperItem,
  createHopperItem,
  markHopperPromoted,
  markHopperDismissed,
  deleteHopperItem,
  composeHopperSeed,
  type HopperStatus,
} from '../hopper.js';
import {
  listMonitors,
  getMonitor,
  createMonitor,
  patchMonitor,
  deleteMonitor,
  listMonitorRuns,
  runMonitorNow,
  type MonitorStatus,
} from '../monitors.js';
import {
  createProject as createFoundryProject,
  deleteProject as deleteFoundryProject,
  FoundryError,
  getProjectRow as getFoundryProjectRow,
  getProjectWithModules as getFoundryProjectWithModules,
  goProject as goFoundryProject,
  isProjectStatus,
  launchProject as launchFoundryProject,
  listProjects as listFoundryProjects,
  markProjectPlanning,
  retryModule as retryFoundryModule,
  setBlueprint as setFoundryBlueprint,
} from '../foundry.js';
import { planProject as runFoundryPlanner } from '../foundry-planner.js';
import { getFoundryModelSetting } from '../foundry-settings.js';
import {
  createHopperTree,
  agreeHopperTree,
  getHopperTree,
  listHopperTrees,
  listTreeNodes,
  getHopperNode,
  finishHopperNode,
  answerHopperNode,
  dispatchTick,
  getHopperHistory,
  type NewNodeInput,
} from '../hopper-engine.js';
import { governorStatus } from '../hopper-governor.js';
import {
  listSmartTodoNodes,
  getSmartTodoNode,
  createSmartTodoNode,
  updateSmartTodoNode,
  moveSmartTodoNode,
  deleteSmartTodoNode,
  insertSmartTodoTree,
  setSmartTodoGroup,
  setSmartTodoThread,
  type SmartTodoStatus,
} from '../smart-todos.js';
import { decomposeNote } from '../smart-todos-decompose.js';
import { listSpawnTasks } from '../spawn-tasks.js';
import {
  listActiveQuickCaptureItems,
  createQuickCaptureItem,
  reorderQuickCaptureItems,
  renameQuickCaptureItem,
  setQuickCaptureItemCompleted,
  deleteQuickCaptureItem,
  getQuickCaptureItem,
} from '../quick-capture-db.js';
import {
  archiveExpiredQuickChatSessions,
  archiveQuickChatProfile,
  closeQuickChatSession,
  getQuickChatProfile,
  getQuickChatSessionForConversation,
  listQuickChatProfiles,
  listQuickChatSessions,
  openQuickChatSession,
  saveQuickChatProfile,
  serializeQuickChatProfile,
  serializeQuickChatSession,
} from '../quick-chat-profiles.js';
import {
  createEphemeralChatSession,
  deleteEphemeralChatSession,
  getEphemeralChatSession,
  sendEphemeralChatMessage,
  sweepStaleEphemeralConversations,
} from '../ephemeral-chat.js';
import { autoNameThreadFromFirstMessage } from '../thread-autoname.js';
import { autoGroupThreadFromFirstMessage } from '../thread-autogroup.js';
import { generateThreadSummary } from '../thread-summarize.js';
import { condenseThread, buildSmartForkMessage } from '../thread-condense.js';
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
  listThreadLinks,
  setPreviewLink,
  addThreadLink,
  deleteThreadLink,
  clearThreadLinks,
  getThreadLink,
} from '../thread-links.js';
import {
  createDispatch,
  getDispatch,
  listOutboundDispatches,
  listInboundDispatches,
  acknowledgeDispatch,
  deleteDispatch,
  listDispatchWorkers,
  type WaitMode,
  type WakeMode,
} from '../dispatches.js';
import { installDispatchGate } from '../dispatch-gate.js';
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
import {
  saveMessageImages,
  resolveImagePath,
  parseStoredImages,
  ImageValidationError,
  type IncomingImage,
  type SavedImage,
} from '../image-store.js';
import { createShimTask } from '../tools/shim.js';
import { submitIntake, listIntakeOutcomes } from '../tools/paperclip.js';
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
  refreshAuggieModels,
  refreshDevinModels,
  refreshCodexModels,
  type AdapterConfig,
} from '../agent.js';
import {
  getAllSettings,
  getSetting,
  setSetting,
  deleteSetting,
  getPersonalityStats,
  updatePersonalityStats,
  getPersonalityStatsHistory,
  getAutonomyLevel,
  updateAutonomyLevel,
  getAutonomyLevelHistory,
  AUTONOMY_HARD_LIMITER_SUMMARY,
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
const PROTECTED_THREAD_IDS = new Set(['checkin:notifications']);

interface AuthedRequest extends Request {
  apiKey?: ApiKeyRow;
}

const errorByMessageId = new Map<string, { code: string; message: string }>();
const CHECKIN_SNOOZE_PRESETS_MINUTES = [15, 60, 240] as const;
const MOMENTUM_LAB_SETTINGS_KEY = 'momentum_lab_settings';

interface CheckinRow {
  id: string;
  fire_at: string;
  reason: string;
  source_type: string;
  source_id: string | null;
  status: string;
}

function isProtectedSystemThread(externalId: string): boolean {
  return PROTECTED_THREAD_IDS.has(externalId);
}

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

function sendCaughtFoundryError(res: Response, err: unknown): void {
  if (err instanceof FoundryError) {
    sendError(res, err.status, err.code, err.message, err.details);
    return;
  }
  sendError(res, 500, 'foundry_error', err instanceof Error ? err.message : String(err));
}

function parseJsonSetting<T>(key: string): T | null {
  const raw = getSetting(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function notificationMetaFromBody(value: unknown): NotificationMeta | null {
  if (!value || typeof value !== 'object') return null;
  const meta = value as Record<string, unknown>;
  return {
    kind: meta.kind === 'checkin' ? 'checkin' : undefined,
    checkinId: typeof meta.checkinId === 'string' ? meta.checkinId : undefined,
    sourceType: typeof meta.sourceType === 'string' ? meta.sourceType : null,
    sourceId: typeof meta.sourceId === 'string' ? meta.sourceId : null,
  };
}

function notificationActionsFromBody(value: unknown): NotificationAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const action = entry as Record<string, unknown>;
    const kind = action.kind;
    const label = typeof action.label === 'string' ? action.label.trim() : '';
    if (
      (kind !== 'open_link' && kind !== 'checkin_snooze' && kind !== 'checkin_dismiss' && kind !== 'issue_reopen')
      || !label
    ) return [];
    return [{
      kind,
      label,
      href: typeof action.href === 'string' ? action.href : undefined,
      minutes: Number.isFinite(action.minutes) ? Number(action.minutes) : undefined,
      issueId: typeof action.issueId === 'string' ? action.issueId : undefined,
      issueIdentifier: typeof action.issueIdentifier === 'string' ? action.issueIdentifier : undefined,
      reopenStatus: typeof action.reopenStatus === 'string' ? action.reopenStatus : undefined,
      style:
        action.style === 'default' || action.style === 'secondary' || action.style === 'destructive'
          ? action.style
          : undefined,
    } satisfies NotificationAction];
  });
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
  const quickChatSession = getQuickChatSessionForConversation(conv.id);
  return {
    thread_id: conv.external_id,
    reminder: reminder ? serializeReminder(reminder) : null,
    // Open todo signal — total, and the subset tagged "for Kevin".
    open_todo_count: openTodos.total,
    open_todo_for_me_count: openTodos.forKevin,
    // Per-thread "relevant links" bar (preview/build URL + reference links).
    // Sent inline so the pane paints the bar on first load; the thread_link SSE
    // keeps it live thereafter.
    links: listThreadLinks(conv.id),
    dispatches: {
      outbound: listOutboundDispatches(conv.id),
      inbound: listInboundDispatches(conv.id),
    },
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
    // Standalone-window display metadata: big bold headline + border color so
    // popped-out windows opened side-by-side are easy to tell apart.
    headline: conv.headline ?? null,
    border_color: conv.border_color ?? null,
    // Where this thread's messages come in from (slack / cockpit / watch / …).
    source: deriveSource(conv.external_id),
    quick_chat: quickChatSession ? serializeQuickChatSession(quickChatSession) : null,
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
    locked: !!conv.password_hash,
  };
}

// Catalog of selectable providers/models for the per-thread selector, with a
// credentials check so the UI can show which providers are usable vs. disabled.
async function providerCatalog(): Promise<Array<Record<string, unknown>>> {
  // Augment's real model shelf lives in the auggie CLI, not the static adapter
  // (which only carries {default}). Refresh the auggie adapter's own models
  // array from `auggie model list` so BOTH the selector AND the per-thread
  // model validation (resolveConversationRuntime / set-model) see the full
  // shelf. Best-effort: leaves the static list in place on any failure.
  try {
    await refreshAuggieModels();
  } catch {
    // leave static models in place
  }
  // Devin's real family shelf lives in the `devin` CLI too — refresh it so the
  // selector + per-thread model validation see all ~40 families, not the seed.
  try {
    await refreshDevinModels();
  } catch {
    // leave static models in place
  }
  // Codex's real shelf lives behind the CLI app-server `model/list` RPC —
  // refresh so the selector tracks OpenAI's live models (GPT-6-Astra etc.).
  try {
    await refreshCodexModels();
  } catch {
    // leave static models in place
  }
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

type ProviderUsageWindow = {
  used_percentage: number | null;
  resets_at: number | null;
  label?: string;
  value_label?: string | null;
  detail?: string | null;
};

type ClaudeProviderUsage = {
  five_hour: ProviderUsageWindow | null;
  seven_day: ProviderUsageWindow | null;
  model: string | null;
  updated_at: number;
};

type CodexProviderUsage = {
  windows: ProviderUsageWindow[];
  plan: string | null;
  email: string | null;
  source: string | null;
  updated_at: number;
  error?: string | null;
};

function readClaudeLiveUsage(): ClaudeProviderUsage | null {
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
        return {
          five_hour,
          seven_day,
          model: null,
          updated_at: Math.floor(st.mtimeMs / 1000),
        };
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
    if (ageMs > STATUSLINE_STALE_MS) return null;
    const raw = JSON.parse(readFileSync(STATUSLINE_PATH, 'utf8')) as {
      rate_limits?: {
        five_hour?: { used_percentage?: number; resets_at?: number };
        seven_day?: { used_percentage?: number; resets_at?: number };
      };
      model?: { display_name?: string };
    };
    const rl = raw.rate_limits;
    if (!rl?.five_hour && !rl?.seven_day) return null;
    const toStatuslineWindow = (w?: { used_percentage?: number; resets_at?: number }): ProviderUsageWindow | null =>
      w
        ? {
            used_percentage: typeof w.used_percentage === 'number' ? w.used_percentage : null,
            resets_at: typeof w.resets_at === 'number' ? w.resets_at : null,
          }
        : null;
    return {
      five_hour: toStatuslineWindow(rl.five_hour),
      seven_day: toStatuslineWindow(rl.seven_day),
      model: raw.model?.display_name ?? null,
      updated_at: Math.floor(st.mtimeMs / 1000),
    };
  } catch {
    return null;
  }
}

function readCodexUsage(): CodexProviderUsage | null {
  const LIVE_PATH = '/tmp/codex-usage-live.json';
  try {
    const st = statSync(LIVE_PATH);
    const raw = JSON.parse(readFileSync(LIVE_PATH, 'utf8')) as {
      windows?: Array<Partial<ProviderUsageWindow>>;
      plan?: string | null;
      email?: string | null;
      source?: string | null;
      updated_at?: number;
      error?: string | null;
    };
    const windows = Array.isArray(raw.windows)
      ? raw.windows
          .map((w): ProviderUsageWindow | null => {
            const usedPercentage = typeof w.used_percentage === 'number' ? w.used_percentage : null;
            const resetsAt = typeof w.resets_at === 'number' ? w.resets_at : null;
            const label = typeof w.label === 'string' && w.label.trim() ? w.label.trim() : undefined;
            if (usedPercentage == null && resetsAt == null && !w.value_label) return null;
            return {
              used_percentage: usedPercentage,
              resets_at: resetsAt,
              ...(label ? { label } : {}),
              value_label: typeof w.value_label === 'string' ? w.value_label : null,
              detail: typeof w.detail === 'string' ? w.detail : null,
            };
          })
          .filter((w): w is ProviderUsageWindow => w != null)
      : [];
    if (!windows.length && !raw.error) return null;
    return {
      windows,
      plan: typeof raw.plan === 'string' ? raw.plan : null,
      email: typeof raw.email === 'string' ? raw.email : null,
      source: typeof raw.source === 'string' ? raw.source : null,
      updated_at: typeof raw.updated_at === 'number' ? raw.updated_at : Math.floor(st.mtimeMs / 1000),
      error: typeof raw.error === 'string' ? raw.error : null,
    };
  } catch {
    return null;
  }
}

// Augment (auggie) shares the generic windows[] snapshot shape with Codex, so
// the reader is the same — only the live file differs. Written every 60s by
// augment-usage-poll.timer from `auggie account status --json`.
function readAugmentUsage(): CodexProviderUsage | null {
  const LIVE_PATH = '/tmp/auggie-usage-live.json';
  try {
    const st = statSync(LIVE_PATH);
    const raw = JSON.parse(readFileSync(LIVE_PATH, 'utf8')) as {
      windows?: Array<Partial<ProviderUsageWindow>>;
      plan?: string | null;
      email?: string | null;
      source?: string | null;
      updated_at?: number;
      error?: string | null;
    };
    const windows = Array.isArray(raw.windows)
      ? raw.windows
          .map((w): ProviderUsageWindow | null => {
            const usedPercentage = typeof w.used_percentage === 'number' ? w.used_percentage : null;
            const resetsAt = typeof w.resets_at === 'number' ? w.resets_at : null;
            const label = typeof w.label === 'string' && w.label.trim() ? w.label.trim() : undefined;
            if (usedPercentage == null && resetsAt == null && !w.value_label) return null;
            return {
              used_percentage: usedPercentage,
              resets_at: resetsAt,
              ...(label ? { label } : {}),
              value_label: typeof w.value_label === 'string' ? w.value_label : null,
              detail: typeof w.detail === 'string' ? w.detail : null,
            };
          })
          .filter((w): w is ProviderUsageWindow => w != null)
      : [];
    if (!windows.length && !raw.error) return null;
    return {
      windows,
      plan: typeof raw.plan === 'string' ? raw.plan : null,
      email: typeof raw.email === 'string' ? raw.email : null,
      source: typeof raw.source === 'string' ? raw.source : null,
      updated_at: typeof raw.updated_at === 'number' ? raw.updated_at : Math.floor(st.mtimeMs / 1000),
      error: typeof raw.error === 'string' ? raw.error : null,
    };
  } catch {
    return null;
  }
}

const WATCH_PREFIX = 'From Kevin’s Watch:';
const WATCH_PREFIX_ASCII = "From Kevin's Watch:";

// DAR-744: rebuild SavedImage[] (with absolute disk paths) from the JSON
// persisted on a queue row, so a drained queued message can hand images to
// processMessage exactly like the immediate-dispatch path does.
function reconstructSavedImages(json: string | null): SavedImage[] {
  const stored = parseStoredImages(json);
  const out: SavedImage[] = [];
  for (const rec of stored) {
    const absPath = resolveImagePath(rec.conversationId, rec.filename);
    if (absPath) out.push({ ...rec, absPath });
  }
  return out;
}

function serializeTurnImages(turn: TurnRow, externalId?: string): { url: string; mime: string }[] | undefined {
  if (!turn.images || !externalId) return undefined;
  const stored = parseStoredImages(turn.images);
  if (!stored.length) return undefined;
  return stored.map((img) => ({
    url: `/threads/${encodeURIComponent(externalId)}/images/${turn.turn_index}/${encodeURIComponent(img.filename)}`,
    mime: img.mime,
  }));
}

function serializeTurn(turn: TurnRow, convSource?: string, externalId?: string): Record<string, unknown> {
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
  const displayContent = (turn.role === 'assistant'
    ? displayContentFromRawOutput(turn.content, turn.claude_output)
    : turn.content) ?? null;
  return {
    turn_index: turn.turn_index,
    role: turn.role,
    content: displayContent,
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
    // DAR-744: paste/attach-chip images on this (user) turn — undefined when none.
    images: serializeTurnImages(turn, externalId),
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
      const drainedImages = reconstructSavedImages(next.images);
      processMessage(next.content, conv.external_id, messageId, drainedImages.length ? drainedImages : undefined).catch((err: unknown) => {
        // Lost the per-conversation mutex to another ingress mid-drain — re-queue
        // so the message isn't dropped; the winning turn's completion drains it.
        if (err instanceof ConversationBusyError) {
          enqueueMessage(convId, next.content, next.images);
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
  installDispatchGate();

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

  router.get('/providers', async (_req: AuthedRequest, res) => {
    res.json({ providers: await providerCatalog() });
  });

  // -- Ephemeral chat: in-memory floating quick chat, no thread persistence ---

  router.post('/ephemeral-chat/sessions', (req: AuthedRequest, res) => {
    try {
      const body = (req.body ?? {}) as { adapter?: unknown; model?: unknown };
      const session = createEphemeralChatSession({
        adapter: typeof body.adapter === 'string' ? body.adapter : undefined,
        model: typeof body.model === 'string' ? body.model : body.model === null ? null : undefined,
      });
      res.status(201).json({ session });
    } catch (err) {
      sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : String(err));
    }
  });

  router.get('/ephemeral-chat/sessions/:id', (req: AuthedRequest, res) => {
    const session = getEphemeralChatSession(paramString(req.params.id));
    if (!session) {
      sendError(res, 404, 'session_not_found', 'Ephemeral chat session not found');
      return;
    }
    res.json({ session });
  });

  router.post('/ephemeral-chat/sessions/:id/messages', (req: AuthedRequest, res) => {
    const body = (req.body ?? {}) as { text?: unknown };
    if (typeof body.text !== 'string' || !body.text.trim()) {
      sendError(res, 400, 'invalid_request', 'text is required and must be a non-empty string');
      return;
    }
    try {
      const session = sendEphemeralChatMessage(paramString(req.params.id), body.text);
      res.status(202).json({ session });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message === 'session not found' ? 'session_not_found' : 'invalid_request';
      const status = message === 'session not found' ? 404 : 409;
      sendError(res, status, code, message);
    }
  });

  router.delete('/ephemeral-chat/sessions/:id', (req: AuthedRequest, res) => {
    if (!deleteEphemeralChatSession(paramString(req.params.id))) {
      sendError(res, 404, 'session_not_found', 'Ephemeral chat session not found');
      return;
    }
    res.status(204).end();
  });

  // -- GET /provider-usage: provider quota meters (DAR-696 + Codex) ----------
  // Claude comes from /tmp/claude-usage-live.json, refreshed every 60s by
  // claude-usage-poll.timer, with the older statusline dump as a fallback.
  // Codex comes from /tmp/codex-usage-live.json, refreshed by a sibling timer
  // using the local Codex CLI app-server rate-limit RPC first and WHAM second.
  // Augment comes from /tmp/auggie-usage-live.json (credit burn-down, no time
  // window), refreshed by augment-usage-poll.timer via `auggie account status`.

  router.get('/provider-usage', (_req: AuthedRequest, res) => {
    res.json({
      claude: readClaudeLiveUsage(),
      openai_codex: readCodexUsage(),
      augment: readAugmentUsage(),
    });
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

  // == Notifications (DAR-761) =================================================
  // Cockpit-wide notification layer: bell/center + toasts. Not thread-scoped —
  // every caller sees the same list, same as notes/quick-capture above. JARVIS
  // pushes here via the `notifications` tool; this REST surface mirrors it for
  // direct/external callers and drives read-state from the cockpit UI.

  const VALID_SEVERITIES: NotificationSeverity[] = ['info', 'success', 'warning', 'error'];

  router.get('/notifications', (req: AuthedRequest, res) => {
    const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit ?? '100'), 10) || 100));
    res.json({ notifications: listNotifications(limit), unread: unreadNotificationCount() });
  });

  router.post('/notifications', (req: AuthedRequest, res) => {
    const severity = (typeof req.body?.severity === 'string' ? req.body.severity : 'info') as NotificationSeverity;
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!VALID_SEVERITIES.includes(severity)) {
      sendError(res, 400, 'invalid_severity', `severity must be one of ${VALID_SEVERITIES.join(', ')}`);
      return;
    }
    if (!title) {
      sendError(res, 400, 'title_required', 'title is required');
      return;
    }
    const body = typeof req.body?.body === 'string' ? req.body.body : null;
    const source = typeof req.body?.source === 'string' ? req.body.source : null;
    const link = typeof req.body?.link === 'string' ? req.body.link : null;
    const actions = notificationActionsFromBody(req.body?.actions);
    const meta = notificationMetaFromBody(req.body?.meta);
    const notification = createNotification({ severity, title, body, source, link, actions, meta });
    res.status(201).json({ notification });
  });

  router.patch('/notifications/:id/read', (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!getNotification(id)) {
      sendError(res, 404, 'notification_not_found', 'notification not found');
      return;
    }
    res.json({ notification: markNotificationRead(id) });
  });

  router.post('/notifications/mark-all-read', (_req: AuthedRequest, res) => {
    const updated = markAllNotificationsRead();
    res.json({ notifications: updated });
  });

  router.delete('/notifications/:id', (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!getNotification(id)) {
      sendError(res, 404, 'notification_not_found', 'notification not found');
      return;
    }
    deleteNotification(id);
    res.status(204).end();
  });

  // == Cockpit Monitors =======================================================
  // Cheap scheduled prompt-check agents. The scheduler runs each monitor through
  // the normal JARVIS thread/processMessage path, with an explicit per-thread
  // model override every run, so model calls remain behind local CLI adapters.

  const dateToSqliteUtc = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ');
  const parseDateField = (value: unknown): string | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    if (typeof value !== 'string') return undefined;
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return undefined;
    return dateToSqliteUtc(d);
  };
  const durationExpiresAt = (body: Record<string, unknown>): string | undefined => {
    const minutes =
      typeof body.duration_minutes === 'number' && Number.isFinite(body.duration_minutes)
        ? body.duration_minutes
        : typeof body.duration_hours === 'number' && Number.isFinite(body.duration_hours)
          ? body.duration_hours * 60
          : typeof body.duration_days === 'number' && Number.isFinite(body.duration_days)
            ? body.duration_days * 24 * 60
            : null;
    if (minutes == null || minutes <= 0) return undefined;
    return dateToSqliteUtc(new Date(Date.now() + minutes * 60_000));
  };
  const validateMonitorAdapterModel = (adapterRaw: unknown, modelRaw: unknown): { adapter?: string; model?: string } | { error: string } => {
    const adapters = getAdapters();
    if (adapterRaw === undefined && modelRaw === undefined) return {};
    const adapter = typeof adapterRaw === 'string' && adapterRaw.trim() ? adapterRaw.trim() : 'claude';
    if (!adapters[adapter]) return { error: `adapter must be one of ${Object.keys(adapters).join(', ')}` };
    if (modelRaw === undefined || modelRaw === null || modelRaw === '') {
      const defaultModel = adapter === 'claude'
        ? 'claude-haiku-4-5-20251001'
        : adapters[adapter].models[0]?.id;
      return defaultModel ? { adapter, model: defaultModel } : { adapter };
    }
    if (typeof modelRaw !== 'string') return { error: 'model must be a string' };
    const model = modelRaw.trim();
    if (!adapters[adapter].models.some((m) => m.id === model)) {
      return { error: `model must be one of ${adapters[adapter].models.map((m) => m.id).join(', ')} for adapter ${adapter}` };
    }
    return { adapter, model };
  };

  router.get('/monitors', (req: AuthedRequest, res) => {
    const raw = typeof req.query.status === 'string' ? req.query.status : 'open';
    const status: MonitorStatus | 'open' | 'all' =
      raw === 'active' || raw === 'paused' || raw === 'completed' || raw === 'all' ? raw : 'open';
    res.json({ monitors: listMonitors(status) });
  });

  router.post('/monitors', (req: AuthedRequest, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const nameRaw = typeof body.name === 'string' ? body.name : typeof body.title === 'string' ? body.title : '';
    const name = nameRaw.trim();
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const cadence = Number(body.cadence_minutes);
    if (!name) {
      sendError(res, 400, 'invalid_request', 'name is required and must be a non-empty string');
      return;
    }
    if (!prompt) {
      sendError(res, 400, 'invalid_request', 'prompt is required and must be a non-empty string');
      return;
    }
    if (!Number.isFinite(cadence) || cadence < 1) {
      sendError(res, 400, 'invalid_request', 'cadence_minutes must be a positive number');
      return;
    }
    const modelChoice = validateMonitorAdapterModel(body.adapter, body.model);
    if ('error' in modelChoice) {
      sendError(res, 400, 'invalid_request', modelChoice.error);
      return;
    }
    const parsedExpiresAt = parseDateField(body.expires_at);
    if (body.expires_at !== undefined && parsedExpiresAt === undefined) {
      sendError(res, 400, 'invalid_request', 'expires_at must be an ISO timestamp or null');
      return;
    }
    const expiresAt = parsedExpiresAt !== undefined ? parsedExpiresAt : durationExpiresAt(body) ?? null;
    const monitor = createMonitor({
      name,
      prompt,
      cadence_minutes: cadence,
      adapter: modelChoice.adapter,
      model: modelChoice.model,
      expires_at: expiresAt,
    });
    res.status(201).json({ monitor });
  });

  router.get('/monitors/:id', (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    const monitor = getMonitor(id);
    if (!monitor) {
      sendError(res, 404, 'monitor_not_found', 'monitor not found');
      return;
    }
    res.json({ monitor });
  });

  router.patch('/monitors/:id', (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    const monitor = getMonitor(id);
    if (!monitor) {
      sendError(res, 404, 'monitor_not_found', 'monitor not found');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<typeof patchMonitor>[1] = {};
    if (body.name !== undefined || body.title !== undefined) {
      const nameRaw = typeof body.name === 'string' ? body.name : typeof body.title === 'string' ? body.title : '';
      const name = nameRaw.trim();
      if (!name) {
        sendError(res, 400, 'invalid_request', 'name must be a non-empty string');
        return;
      }
      patch.name = name;
    }
    if (body.prompt !== undefined) {
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
        sendError(res, 400, 'invalid_request', 'prompt must be a non-empty string');
        return;
      }
      patch.prompt = body.prompt.trim();
    }
    if (body.cadence_minutes !== undefined) {
      const cadence = Number(body.cadence_minutes);
      if (!Number.isFinite(cadence) || cadence < 1) {
        sendError(res, 400, 'invalid_request', 'cadence_minutes must be a positive number');
        return;
      }
      patch.cadence_minutes = cadence;
    }
    if (body.adapter !== undefined || body.model !== undefined) {
      const modelChoice = validateMonitorAdapterModel(body.adapter ?? monitor.adapter, body.model);
      if ('error' in modelChoice) {
        sendError(res, 400, 'invalid_request', modelChoice.error);
        return;
      }
      patch.adapter = modelChoice.adapter ?? monitor.adapter;
      if (modelChoice.model !== undefined) patch.model = modelChoice.model;
    }
    if (body.expires_at !== undefined) {
      const expiresAt = parseDateField(body.expires_at);
      if (expiresAt === undefined) {
        sendError(res, 400, 'invalid_request', 'expires_at must be an ISO timestamp or null');
        return;
      }
      patch.expires_at = expiresAt;
    } else {
      const duration = durationExpiresAt(body);
      if (duration) patch.expires_at = duration;
    }
    if (body.extend_minutes !== undefined) {
      const minutes = Number(body.extend_minutes);
      if (!Number.isFinite(minutes) || minutes <= 0) {
        sendError(res, 400, 'invalid_request', 'extend_minutes must be a positive number');
        return;
      }
      const base = monitor.expires_at
        ? new Date(`${monitor.expires_at.replace(' ', 'T')}Z`)
        : new Date();
      const baseMs = Number.isFinite(base.getTime()) ? Math.max(base.getTime(), Date.now()) : Date.now();
      patch.expires_at = dateToSqliteUtc(new Date(baseMs + minutes * 60_000));
    }
    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'paused' && body.status !== 'completed') {
        sendError(res, 400, 'invalid_request', "status must be 'active', 'paused', or 'completed'");
        return;
      }
      patch.status = body.status;
    }
    if (body.action === 'pause') patch.status = 'paused';
    if (body.action === 'resume') patch.status = 'active';

    const updated = patchMonitor(id, patch);
    res.json({ monitor: updated });
  });

  router.delete('/monitors/:id', (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!deleteMonitor(id)) {
      sendError(res, 404, 'monitor_not_found', 'monitor not found');
      return;
    }
    res.status(204).end();
  });

  router.get('/monitors/:id/runs', (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!getMonitor(id)) {
      sendError(res, 404, 'monitor_not_found', 'monitor not found');
      return;
    }
    const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    res.json({ runs: listMonitorRuns(id, limit) });
  });

  router.post('/monitors/:id/run-now', (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    const result = runMonitorNow(id);
    if (result.status === 'not_found') {
      sendError(res, 404, 'monitor_not_found', 'monitor not found');
      return;
    }
    res.status(202).json(result);
  });

  // == Foundry ===============================================================
  // Universal module build system: prompt → blueprint → independently built
  // modules → integrate → GO. Node 66 owns project CRUD, blueprint validation,
  // route skeletons, and SSE contracts. Launch/GO/retry get real lifecycle
  // behavior in the follow-up backend node.

  router.get('/foundry/projects', (req: AuthedRequest, res) => {
    const rawStatus = typeof req.query.status === 'string' ? req.query.status : 'all';
    if (rawStatus !== 'all' && !isProjectStatus(rawStatus)) {
      sendError(res, 400, 'invalid_request', 'status must be a valid Foundry project status or all');
      return;
    }
    res.json({ projects: listFoundryProjects(rawStatus === 'all' ? 'all' : rawStatus) });
  });

  router.post('/foundry/projects', (req: AuthedRequest, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    if (!name) {
      sendError(res, 400, 'invalid_request', 'name is required and must be a non-empty string');
      return;
    }
    if (!prompt) {
      sendError(res, 400, 'invalid_request', 'prompt is required and must be a non-empty string');
      return;
    }
    try {
      const result = createFoundryProject({
        name,
        prompt,
        repo_path: typeof body.repo_path === 'string' ? body.repo_path : null,
        base_branch: typeof body.base_branch === 'string' ? body.base_branch : null,
        origin_thread_ext: typeof body.origin_thread_ext === 'string'
          ? body.origin_thread_ext
          : typeof body.origin_thread === 'string'
            ? body.origin_thread
            : null,
      });
      res.status(201).json(result);
    } catch (err) {
      sendCaughtFoundryError(res, err);
    }
  });

  router.get('/foundry/projects/:id', (req: AuthedRequest, res) => {
    const result = getFoundryProjectWithModules(paramString(req.params.id));
    if (!result) {
      sendError(res, 404, 'foundry_project_not_found', 'foundry project not found');
      return;
    }
    res.json(result);
  });

  router.post('/foundry/projects/:id/plan', (req: AuthedRequest, res) => {
    const id = paramString(req.params.id);
    const project = getFoundryProjectRow(id);
    if (!project) {
      sendError(res, 404, 'foundry_project_not_found', 'foundry project not found');
      return;
    }
    if (project.status === 'launched') {
      sendError(res, 409, 'foundry_project_already_launched', 'project has already launched');
      return;
    }
    if (!['draft', 'planning', 'planned'].includes(project.status)) {
      sendError(res, 409, 'foundry_project_already_building', 'project already has build work in flight');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const plannerModel =
      typeof body.planner_model === 'string' && body.planner_model.trim()
        ? body.planner_model.trim()
        : getFoundryModelSetting('planner', 'claude-opus-5');
    const updated = markProjectPlanning(id, plannerModel);
    if (!updated) {
      sendError(res, 404, 'foundry_project_not_found', 'foundry project not found');
      return;
    }
    setImmediate(() => {
      runFoundryPlanner(id).catch((err: unknown) => {
        console.error('[foundry] planner failed', err);
      });
    });
    res.status(202).json({ project: updated });
  });

  router.patch('/foundry/projects/:id/blueprint', (req: AuthedRequest, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const blueprint = Object.prototype.hasOwnProperty.call(body, 'blueprint') ? body.blueprint : body;
    try {
      res.json(setFoundryBlueprint(paramString(req.params.id), blueprint));
    } catch (err) {
      sendCaughtFoundryError(res, err);
    }
  });

  router.delete('/foundry/projects/:id', (req: AuthedRequest, res) => {
    const deleted = deleteFoundryProject(paramString(req.params.id));
    if (!deleted) {
      sendError(res, 404, 'foundry_project_not_found', 'foundry project not found');
      return;
    }
    res.status(204).end();
  });

  router.post('/foundry/projects/:id/launch', (req: AuthedRequest, res) => {
    try {
      res.status(202).json(launchFoundryProject(paramString(req.params.id)));
    } catch (err) {
      sendCaughtFoundryError(res, err);
    }
  });

  router.post('/foundry/projects/:id/go', (req: AuthedRequest, res) => {
    try {
      res.status(202).json(goFoundryProject(paramString(req.params.id)));
    } catch (err) {
      sendCaughtFoundryError(res, err);
    }
  });

  router.post('/foundry/projects/:id/modules/:key/retry', (req: AuthedRequest, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.status(202).json(retryFoundryModule(
        paramString(req.params.id),
        paramString(req.params.key),
        typeof body.stage === 'string' ? body.stage : null,
      ));
    } catch (err) {
      sendCaughtFoundryError(res, err);
    }
  });

  // == Task Hopper (candidate tasks awaiting Kevin's yes/dismiss) ==============
  // Global list. A candidate lands here when something MIGHT be a task but the
  // ask is ambiguous; Kevin reviews it in the standalone hopper window and
  // promotes it (Yes / Yes-but) into a live cockpit thread, or dismisses it.

  router.get('/hopper', (req: AuthedRequest, res) => {
    const raw = typeof req.query.status === 'string' ? req.query.status : 'pending';
    const status: HopperStatus | 'all' =
      raw === 'promoted' || raw === 'dismissed' || raw === 'all' ? raw : 'pending';
    res.json({ items: listHopperItems(status) });
  });

  // == Sub-agent tree (JARVIS worker protocol) ================================
  // Read-only view over the spawn_tasks ledger — the cockpit tree widget renders
  // orchestrator→worker fan-out + live status from this.
  router.get('/spawn-tasks', (_req: AuthedRequest, res) => {
    res.json({ tasks: listSpawnTasks() });
  });

  router.post('/hopper', (req: AuthedRequest, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      sendError(res, 400, 'invalid_request', 'title is required and must be a non-empty string');
      return;
    }
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const item = createHopperItem({
      title: title.slice(0, 300),
      summary: str(body.summary),
      source: str(body.source),
      source_ref: str(body.source_ref),
      raw_message: str(body.raw_message),
      suggested_adapter: str(body.suggested_adapter),
      suggested_model: str(body.suggested_model),
    });
    res.status(201).json({ item });
  });

  // Promote a candidate → a fresh cockpit thread. Optionally attach extra
  // context ("Yes, but…") and override the model. Returns the new thread + the
  // composed seed text; the client posts that seed (with any images) to
  // /threads/:ext/messages to actually start JARVIS working — reusing the
  // existing image-capable ingest+dispatch path rather than duplicating it.
  router.post('/hopper/:id/promote', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const id = parseInt(String(req.params.id), 10);
    const item = getHopperItem(id);
    if (!item) {
      sendError(res, 404, 'hopper_item_not_found', 'hopper item not found');
      return;
    }
    if (item.status !== 'pending') {
      sendError(res, 409, 'hopper_item_resolved', `hopper item already ${item.status}`);
      return;
    }
    const body = (req.body ?? {}) as { extra_context?: unknown; adapter?: unknown; model?: unknown };
    const extraContext = typeof body.extra_context === 'string' ? body.extra_context : null;

    const externalId = `${callerExternalIdPrefix(caller.id)}hopper-${randomUUID()}`;
    const conv = getOrCreateConversation(externalId);
    renameConversation(conv.id, item.title.slice(0, 120));

    // Optional model override for this thread ("Yes, but… use <model>").
    const adapters = getAdapters();
    if (typeof body.adapter === 'string' && adapters[body.adapter]) {
      const adapter = adapters[body.adapter];
      const model =
        typeof body.model === 'string' && adapter.models.some((m) => m.id === body.model)
          ? body.model
          : null;
      setThreadModelOverride(conv.id, adapter.id, model);
    }

    const seedText = composeHopperSeed(item, extraContext);
    markHopperPromoted(id, externalId);
    const refreshed = getConversationById(conv.id) ?? conv;
    res.status(201).json({
      thread: threadDescriptor(refreshed, req),
      external_id: externalId,
      seed_text: seedText,
    });
  });

  router.post('/hopper/:id/dismiss', (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    const item = getHopperItem(id);
    if (!item) {
      sendError(res, 404, 'hopper_item_not_found', 'hopper item not found');
      return;
    }
    res.json({ item: markHopperDismissed(id) });
  });

  router.delete('/hopper/:id', (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!getHopperItem(id)) {
      sendError(res, 404, 'hopper_item_not_found', 'hopper item not found');
      return;
    }
    deleteHopperItem(id);
    res.status(204).end();
  });

  // == Hopper Engine ==========================================================
  // The autonomous work-tree executor (two-table design: hopper_trees/nodes =
  // durable state, spawn_tasks = attempts). Breakdown chats write draft trees;
  // Kevin's agree flips them live; the in-process dispatcher spawns ephemeral
  // worker threads; workers report back through /hopper-nodes/:id/finish.

  router.get('/hopper-trees', (_req: AuthedRequest, res) => {
    res.json({ trees: listHopperTrees() });
  });

  router.post('/hopper-trees', (req: AuthedRequest, res) => {
    const body = (req.body ?? {}) as { topic?: unknown; origin_thread?: unknown; nodes?: unknown };
    const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
    const nodes = Array.isArray(body.nodes) ? (body.nodes as NewNodeInput[]) : [];
    if (!topic || !nodes.length || nodes.some((n) => typeof n?.title !== 'string' || !n.title.trim())) {
      sendError(res, 400, 'invalid_request', 'topic and a non-empty nodes array (each with a title) are required');
      return;
    }
    const origin = typeof body.origin_thread === 'string' && body.origin_thread.trim() ? body.origin_thread.trim() : null;
    const created = createHopperTree(topic, origin, nodes);
    res.status(201).json(created);
  });

  router.get('/hopper-trees/:treeId', (req: AuthedRequest, res) => {
    const tree = getHopperTree(paramString(req.params.treeId));
    if (!tree) {
      sendError(res, 404, 'hopper_tree_not_found', 'hopper tree not found');
      return;
    }
    res.json({ tree, nodes: listTreeNodes(tree.id) });
  });

  // Kevin's "yep that looks good" — the ONE human gate. Nothing below `agreed`
  // ever dispatches; this flip is what starts autonomous execution.
  router.post('/hopper-trees/:treeId/agree', (req: AuthedRequest, res) => {
    const tree = agreeHopperTree(paramString(req.params.treeId));
    if (!tree) {
      sendError(res, 404, 'hopper_tree_not_found', 'hopper tree not found');
      return;
    }
    res.json({ tree, nodes: listTreeNodes(tree.id) });
  });

  // Worker finish contract — the one place execution writes tree state.
  router.post('/hopper-nodes/:id/finish', (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    const node = getHopperNode(id);
    if (!node) {
      sendError(res, 404, 'hopper_node_not_found', 'hopper node not found');
      return;
    }
    if (node.status !== 'running') {
      sendError(res, 409, 'hopper_node_not_running', `node is ${node.status}, not running (lease may have expired)`);
      return;
    }
    const body = (req.body ?? {}) as {
      outcome?: unknown; result?: unknown; question?: unknown;
      children?: Array<{ title: string; spec?: string; depends_on_prev?: boolean }>;
    };
    const outcome = body.outcome;
    if (outcome !== 'done' && outcome !== 'split' && outcome !== 'blocked_question' && outcome !== 'blocked') {
      sendError(res, 400, 'invalid_request', "outcome must be one of done|split|blocked_question|blocked");
      return;
    }
    if (outcome === 'split' && (!Array.isArray(body.children) || !body.children.length)) {
      sendError(res, 400, 'invalid_request', 'split requires a non-empty children array');
      return;
    }
    const updated = finishHopperNode(id, outcome, {
      result: typeof body.result === 'string' ? body.result : undefined,
      question: typeof body.question === 'string' ? body.question : undefined,
      children: body.children,
    });
    res.json({ node: updated });
  });

  // Kevin answers a worker's blocking question → node re-queues with it injected.
  router.post('/hopper-nodes/:id/answer', (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    const node = getHopperNode(id);
    if (!node) {
      sendError(res, 404, 'hopper_node_not_found', 'hopper node not found');
      return;
    }
    const body = (req.body ?? {}) as { answer?: unknown };
    if (typeof body.answer !== 'string' || !body.answer.trim()) {
      sendError(res, 400, 'invalid_request', 'answer is required');
      return;
    }
    if (node.status !== 'blocked_question') {
      sendError(res, 409, 'hopper_node_not_questioning', `node is ${node.status}, not blocked_question`);
      return;
    }
    res.json({ node: answerHopperNode(id, body.answer.trim()) });
  });

  // Manual kick (mostly for testing) — the engine is otherwise event-driven.
  router.post('/hopper-engine/tick', (_req: AuthedRequest, res) => {
    void dispatchTick('manual');
    res.json({ ok: true });
  });

  // Governor status — is overnight dispatch currently open, and why/why not.
  router.get('/hopper-engine/governor', (_req: AuthedRequest, res) => {
    res.json(governorStatus());
  });

  // Decision memory — real settled-node outcomes by model, for the planner to
  // read before routing a new tree's nodes.
  router.get('/hopper-engine/history', (_req: AuthedRequest, res) => {
    res.json(getHopperHistory());
  });

  // == Smart Todo Tree ========================================================
  // Kevin's standalone, always-open "smart todo list": a file-tree of jotted
  // ideas → main idea + unlimited nested subitems. Global (not thread-scoped).
  // Any node can spawn/re-open a chat that ties back to it and lands in the
  // node's group. See src/smart-todos.ts.

  router.get('/smart-todos', (_req: AuthedRequest, res) => {
    res.json({ nodes: listSmartTodoNodes() });
  });

  // Jot a note → decompose into a main idea + nested subitems → new branch.
  router.post('/smart-todos/jot', async (req: AuthedRequest, res) => {
    const body = (req.body ?? {}) as { note?: unknown; group_id?: unknown };
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (!note) {
      sendError(res, 400, 'invalid_request', 'note is required and must be a non-empty string');
      return;
    }
    const groupId =
      typeof body.group_id === 'number' && getGroupById(body.group_id) ? body.group_id : null;
    const tree = await decomposeNote(note);
    const root = insertSmartTodoTree(note, tree, { group_id: groupId });
    res.status(201).json({ root, nodes: listSmartTodoNodes() });
  });

  // Add a single node (manual add / new empty root branch).
  router.post('/smart-todos', (req: AuthedRequest, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) {
      sendError(res, 400, 'invalid_request', 'title is required');
      return;
    }
    let parentId: number | null = null;
    if (body.parent_id !== undefined && body.parent_id !== null) {
      if (typeof body.parent_id !== 'number' || !getSmartTodoNode(body.parent_id)) {
        sendError(res, 404, 'smart_todo_not_found', `parent node ${String(body.parent_id)} not found`);
        return;
      }
      parentId = body.parent_id;
    }
    const node = createSmartTodoNode({
      title,
      parent_id: parentId,
      notes: typeof body.notes === 'string' ? body.notes : null,
      group_id: typeof body.group_id === 'number' ? body.group_id : undefined,
    });
    res.status(201).json({ node });
  });

  // Patch a node's own fields (title / notes / status / collapsed / prompt).
  router.patch('/smart-todos/:id', (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!getSmartTodoNode(id)) {
      sendError(res, 404, 'smart_todo_not_found', 'node not found');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: {
      title?: string;
      notes?: string | null;
      status?: SmartTodoStatus;
      collapsed?: boolean;
      original_prompt?: string | null;
    } = {};
    if (typeof body.title === 'string') patch.title = body.title;
    if (body.notes !== undefined) patch.notes = body.notes === null ? null : String(body.notes);
    if (body.status === 'open' || body.status === 'doing' || body.status === 'done') patch.status = body.status;
    if (typeof body.collapsed === 'boolean') patch.collapsed = body.collapsed;
    if (body.original_prompt !== undefined)
      patch.original_prompt = body.original_prompt === null ? null : String(body.original_prompt);
    const node = updateSmartTodoNode(id, patch);
    res.json({ node });
  });

  // Move/reorder a node (and its subtree). parent_id null → make it a root.
  router.post('/smart-todos/:id/move', (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!getSmartTodoNode(id)) {
      sendError(res, 404, 'smart_todo_not_found', 'node not found');
      return;
    }
    const body = (req.body ?? {}) as { parent_id?: unknown; sort_order?: unknown };
    let parentId: number | null = null;
    if (body.parent_id !== undefined && body.parent_id !== null) {
      if (typeof body.parent_id !== 'number' || !getSmartTodoNode(body.parent_id)) {
        sendError(res, 404, 'smart_todo_not_found', `target parent ${String(body.parent_id)} not found`);
        return;
      }
      parentId = body.parent_id;
    }
    const sortOrder = typeof body.sort_order === 'number' ? body.sort_order : 0;
    try {
      const node = moveSmartTodoNode(id, parentId, sortOrder);
      res.json({ node, nodes: listSmartTodoNodes() });
    } catch (err) {
      sendError(res, 400, 'invalid_move', (err as Error).message);
    }
  });

  // Set (or clear) the cockpit group a whole branch maps to.
  router.post('/smart-todos/:id/group', (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!getSmartTodoNode(id)) {
      sendError(res, 404, 'smart_todo_not_found', 'node not found');
      return;
    }
    const body = (req.body ?? {}) as { group_id?: unknown };
    let groupId: number | null = null;
    if (body.group_id !== undefined && body.group_id !== null) {
      if (typeof body.group_id !== 'number' || !getGroupById(body.group_id)) {
        sendError(res, 404, 'group_not_found', `Group ${String(body.group_id)} not found`);
        return;
      }
      groupId = body.group_id;
    }
    const node = setSmartTodoGroup(id, groupId);
    res.json({ node, nodes: listSmartTodoNodes() });
  });

  router.delete('/smart-todos/:id', (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    if (!getSmartTodoNode(id)) {
      sendError(res, 404, 'smart_todo_not_found', 'node not found');
      return;
    }
    deleteSmartTodoNode(id);
    res.status(204).end();
  });

  // Open (or re-open) the chat tied to a node. If the node already has a live
  // linked thread, returns it (reused:true) so "Open chat" from the tree focuses
  // the SAME thread. Otherwise ensures the branch has a cockpit group (creating
  // one named after the root branch if needed), creates a thread in that group,
  // links it both ways, and returns a seed_text the client posts to
  // /threads/:ext/messages to orient JARVIS on the item.
  router.post('/smart-todos/:id/open-chat', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const id = parseInt(String(req.params.id), 10);
    const node = getSmartTodoNode(id);
    if (!node) {
      sendError(res, 404, 'smart_todo_not_found', 'node not found');
      return;
    }

    // Reuse an existing linked thread if it's still around.
    if (node.linked_thread_ext) {
      const existing = getConversation(node.linked_thread_ext);
      if (existing) {
        res.status(200).json({
          thread: threadDescriptor(existing, req),
          external_id: existing.external_id,
          group_id: existing.group_id ?? null,
          reused: true,
          seed_text: null,
        });
        return;
      }
    }

    // Ensure the branch has a group (a group per root branch).
    const rootNode = getSmartTodoNode(node.root_id) ?? node;
    let groupId = rootNode.group_id;
    if (groupId === null || !getGroupById(groupId)) {
      const { group } = createGroup(rootNode.title.slice(0, 100), null);
      groupId = group.id;
      setSmartTodoGroup(rootNode.id, groupId);
    }

    const externalId = `${callerExternalIdPrefix(caller.id)}tree-${randomUUID()}`;
    const conv = getOrCreateConversation(externalId);
    renameConversation(conv.id, node.title.slice(0, 120));
    setThreadGroup(conv.id, groupId);
    setSmartTodoThread(node.id, externalId);

    const seedLines: string[] = [];
    seedLines.push(`**Smart-todo item:** ${node.title}`);
    if (node.notes && node.notes.trim()) seedLines.push('', node.notes.trim());
    if (rootNode.id !== node.id) seedLines.push('', `_Part of: ${rootNode.title}_`);
    if (rootNode.original_prompt && rootNode.original_prompt.trim()) {
      seedLines.push('', 'Original note this came from:', '> ' + rootNode.original_prompt.trim().replace(/\n/g, '\n> '));
    }
    seedLines.push(
      '',
      "_(Opened from Kevin's Smart Todo Tree. This chat is tied to that item — progress you make here can be reflected back with the `smart_todos` tool's `sync` op. Orient on where this stands and what the next move is; ask Kevin what he wants if it's ambiguous.)_",
    );

    const refreshed = getConversationById(conv.id) ?? conv;
    res.status(201).json({
      thread: threadDescriptor(refreshed, req),
      external_id: externalId,
      group_id: groupId,
      reused: false,
      seed_text: seedLines.join('\n'),
    });
  });

  router.post('/notifications/:id/checkin-snooze', async (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    const notification = getNotification(id);
    if (!notification) {
      sendError(res, 404, 'notification_not_found', 'notification not found');
      return;
    }
    if (notification.meta?.kind !== 'checkin' || !notification.meta.checkinId) {
      sendError(res, 409, 'notification_not_checkin', 'notification is not a check-in alert');
      return;
    }

    const minutes = Number(req.body?.minutes);
    if (!CHECKIN_SNOOZE_PRESETS_MINUTES.includes(minutes as (typeof CHECKIN_SNOOZE_PRESETS_MINUTES)[number])) {
      sendError(
        res,
        400,
        'invalid_snooze_minutes',
        `minutes must be one of ${CHECKIN_SNOOZE_PRESETS_MINUTES.join(', ')}`,
      );
      return;
    }

    const rows = await query<CheckinRow>(
      `SELECT id, fire_at, reason, source_type, source_id, status
       FROM jarvis_checkins
       WHERE id = $1
       LIMIT 1`,
      [notification.meta.checkinId],
    );
    const original = rows[0];
    if (!original) {
      sendError(res, 404, 'checkin_not_found', 'source check-in not found');
      return;
    }

    const inserted = await query<CheckinRow>(
      `INSERT INTO jarvis_checkins (fire_at, reason, source_type, source_id)
       VALUES (now() + ($1::text || ' minutes')::interval, $2, $3, $4)
       RETURNING id, fire_at, reason, source_type, source_id, status`,
      [minutes, original.reason, original.source_type, original.source_id],
    );

    deleteNotification(id);
    res.json({ ok: true, checkin: inserted[0] ?? null });
  });

  router.post('/notifications/:id/checkin-dismiss', (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    const notification = getNotification(id);
    if (!notification) {
      sendError(res, 404, 'notification_not_found', 'notification not found');
      return;
    }
    if (notification.meta?.kind !== 'checkin') {
      sendError(res, 409, 'notification_not_checkin', 'notification is not a check-in alert');
      return;
    }
    deleteNotification(id);
    res.status(204).end();
  });

  router.post('/notifications/:id/issue-reopen', async (req: AuthedRequest, res) => {
    const id = parseInt(String(req.params.id), 10);
    const notification = getNotification(id);
    if (!notification) {
      sendError(res, 404, 'notification_not_found', 'notification not found');
      return;
    }
    const actionIndex = typeof req.body?.actionIndex === 'number' ? req.body.actionIndex : -1;
    const action = notification.actions[actionIndex];
    if (!action || action.kind !== 'issue_reopen' || !action.issueId) {
      sendError(res, 409, 'invalid_reopen_action', 'notification action is not a valid issue_reopen');
      return;
    }
    const paperclipUrl = (process.env.PAPERCLIP_API_URL ?? 'http://localhost:3100').replace(/\/$/, '');
    const paperclipKey = process.env.PAPERCLIP_BOARD_API_KEY ?? '';
    if (!paperclipKey) {
      sendError(res, 500, 'paperclip_key_missing', 'PAPERCLIP_BOARD_API_KEY is not configured');
      return;
    }
    try {
      const patchRes = await fetch(`${paperclipUrl}/api/issues/${action.issueId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${paperclipKey}`,
        },
        body: JSON.stringify({
          status: action.reopenStatus ?? 'in_review',
          comment: `Reopened via silence-to-complete digest (was auto-closed).`,
        }),
      });
      if (!patchRes.ok) {
        const text = await patchRes.text().catch(() => '');
        sendError(res, 502, 'paperclip_reopen_failed', `Paperclip returned ${patchRes.status}: ${text}`);
        return;
      }
      markNotificationRead(id);
      res.json({ ok: true, issueId: action.issueId, reopenedTo: action.reopenStatus ?? 'in_review' });
    } catch (err) {
      sendError(res, 502, 'paperclip_unreachable', err instanceof Error ? err.message : String(err));
    }
  });

  // == Foreman bug/task intake bridge (DAR-688 / DAR-711) =====================
  // The Ctrl+Shift+B cockpit widget (BugIntakeWidget.tsx) POSTs here via the
  // /cockpit-api proxy. We forward server-to-server into Paperclip's intake API
  // (board key + Foreman worker project + run:true resolved in tools/paperclip.ts),
  // so the widget never needs a Paperclip browser session. GET lists recent outcomes.
  router.get('/intake', async (req: AuthedRequest, res) => {
    try {
      const raw = parseInt(String(req.query.limit ?? '15'), 10);
      const limit = Math.min(50, Math.max(1, Number.isFinite(raw) ? raw : 15));
      const outcomes = await listIntakeOutcomes(limit);
      res.json({ outcomes });
    } catch (err) {
      sendError(res, 502, 'intake_list_failed', err instanceof Error ? err.message : String(err));
    }
  });

  router.post('/intake', async (req: AuthedRequest, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      sendError(res, 400, 'text_required', 'text is required');
      return;
    }
    const repo =
      typeof req.body?.repo === 'string' && req.body.repo.trim() ? req.body.repo.trim() : 'darwin-assistant';
    const jobType = req.body?.job_type === 'build' ? 'build' : 'bug_fix';
    try {
      const result = await submitIntake({ repo, text, jobType });
      res.status(202).json(result);
    } catch (err) {
      sendError(res, 502, 'intake_submit_failed', err instanceof Error ? err.message : String(err));
    }
  });

  // == Quick Chat Profiles ====================================================
  // Saved, pre-oriented disposable chat profiles. Opening one creates a fresh
  // conversation with `quick:<profile>:<uuid>` external_id and profile context
  // injected on every model turn. Sessions auto-archive after their TTL.

  router.get('/quick-chat/profiles', (_req: AuthedRequest, res) => {
    archiveExpiredQuickChatSessions();
    res.json({ profiles: listQuickChatProfiles().map(serializeQuickChatProfile) });
  });

  router.post('/quick-chat/profiles', (req: AuthedRequest, res) => {
    try {
      const profile = saveQuickChatProfile(req.body ?? {});
      res.status(201).json({ profile: serializeQuickChatProfile(profile) });
    } catch (err) {
      sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : String(err));
    }
  });

  router.patch('/quick-chat/profiles/:id', (req: AuthedRequest, res) => {
    const id = paramString(req.params.id);
    const existing = getQuickChatProfile(id);
    if (!existing || existing.archived_at) {
      sendError(res, 404, 'profile_not_found', `Quick chat profile ${id} not found`);
      return;
    }
    try {
      const profile = saveQuickChatProfile({
        id,
        name: req.body?.name ?? existing.name,
        description: req.body?.description ?? existing.description,
        instructions: req.body?.instructions ?? existing.instructions,
        tool_scope: req.body?.tool_scope ?? existing.tool_scope,
        ttl_hours: req.body?.ttl_hours ?? existing.ttl_hours,
        sort_order: req.body?.sort_order ?? existing.sort_order,
      });
      res.json({ profile: serializeQuickChatProfile(profile) });
    } catch (err) {
      sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : String(err));
    }
  });

  router.delete('/quick-chat/profiles/:id', (req: AuthedRequest, res) => {
    const id = paramString(req.params.id);
    if (!archiveQuickChatProfile(id)) {
      sendError(res, 404, 'profile_not_found', `Quick chat profile ${id} not found`);
      return;
    }
    res.status(204).end();
  });

  router.post('/quick-chat/profiles/:id/open', (req: AuthedRequest, res) => {
    const id = paramString(req.params.id);
    try {
      const session = openQuickChatSession(id);
      const conv = getConversationById(session.conversation_id);
      if (!conv) {
        sendError(res, 500, 'thread_missing', 'Quick chat session was created but the thread could not be loaded');
        return;
      }
      res.status(201).json({
        session: serializeQuickChatSession(session),
        thread: threadDescriptor(conv, req),
      });
    } catch (err) {
      sendError(res, 404, 'profile_not_found', err instanceof Error ? err.message : String(err));
    }
  });

  router.get('/quick-chat/sessions', (req: AuthedRequest, res) => {
    archiveExpiredQuickChatSessions();
    const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    res.json({ sessions: listQuickChatSessions(limit).map(serializeQuickChatSession) });
  });

  router.post('/quick-chat/sessions/:external_id/close', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    if (!callerOwnsExternalId(caller.id, externalId)) {
      sendError(res, 403, 'thread_not_owned_by_caller', 'This quick chat session is not owned by the authenticated caller');
      return;
    }
    const closed = closeQuickChatSession(externalId);
    if (!closed) {
      sendError(res, 404, 'session_not_found', `Quick chat session ${externalId} not found`);
      return;
    }
    res.json({ session: serializeQuickChatSession(closed) });
  });

  // -- POST /threads: create a new thread ------------------------------------

  router.post('/threads', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const body = (req.body ?? {}) as { external_id?: unknown; label?: unknown; group_id?: unknown };
    const providedId = typeof body.external_id === 'string' ? body.external_id.trim() : '';

    let groupId: number | null = null;
    if (body.group_id !== undefined && body.group_id !== null) {
      if (typeof body.group_id !== 'number' || !getGroupById(body.group_id)) {
        sendError(res, 404, 'group_not_found', `Group ${body.group_id} not found`);
        return;
      }
      groupId = body.group_id;
    }

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
    if (groupId !== null) {
      setThreadGroup(conv.id, groupId);
    }
    res.status(201).json(threadDescriptor(groupId !== null ? getConversation(externalId)! : conv, req));
  });

  // -- GET /threads: list caller's threads -----------------------------------

  router.get('/threads', (req: AuthedRequest, res) => {
    archiveExpiredQuickChatSessions();
    sweepStaleEphemeralConversations();
    const caller = req.apiKey!;
    const prefix = callerExternalIdPrefix(caller.id);
    const seesAllThreads = isAdminScope(caller.scope);
    const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const statusFilter = typeof req.query.status === 'string' ? req.query.status : null;

    const all = listAllConversations();
    const filtered = all.filter((c) => {
      // Ephemeral chats are full JARVIS on a throwaway conversation — never a
      // saved thread, so they never appear in the sidebar list.
      if (c.external_id.startsWith('ephemeral:')) return false;
      if (c.external_id.startsWith('checkin:')) return false;
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

    const candidates = listAllConversations().filter((c) => {
      if (c.external_id.startsWith('ephemeral:')) return false;
      if (c.external_id.startsWith('checkin:')) return false;
      return seesAllThreads || c.external_id.startsWith(prefix);
    });

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
      turns: turns.map((t) => serializeTurn(t, convSource, conv.external_id)),
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

  // -- PATCH /threads/:external_id: rename, archive, complete -----------------
  // Body: { title?: string|null, status?: 'active'|'archived'|'completed' }.
  // Distinct from the /model sub-route (Express matches that more specific
  // path first).

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
      headline?: unknown;
      border_color?: unknown;
    };
    const protectedThread = isProtectedSystemThread(conv.external_id);

    if (protectedThread && (
      body.title !== undefined
      || body.status !== undefined
      || body.group_id !== undefined
    )) {
      sendError(res, 403, 'protected_thread', 'This system thread cannot be renamed, archived, completed, or moved');
      return;
    }

    if (body.title !== undefined) {
      if (body.title !== null && typeof body.title !== 'string') {
        sendError(res, 400, 'invalid_request', 'title must be a string or null');
        return;
      }
      const t = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : null;
      renameConversation(conv.id, t && t.length ? t : null);
    }
    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'archived' && body.status !== 'completed') {
        sendError(res, 400, 'invalid_request', "status must be 'active', 'archived', or 'completed'");
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
    // Standalone-window display metadata (headline + border color). Each is
    // optional and written independently; null/'' clears it.
    if (body.headline !== undefined) {
      if (body.headline !== null && typeof body.headline !== 'string') {
        sendError(res, 400, 'invalid_request', 'headline must be a string or null');
        return;
      }
      const h = typeof body.headline === 'string' ? body.headline.trim().slice(0, 200) : null;
      setThreadDisplay(conv.id, { headline: h });
    }
    if (body.border_color !== undefined) {
      if (body.border_color !== null && typeof body.border_color !== 'string') {
        sendError(res, 400, 'invalid_request', 'border_color must be a string or null');
        return;
      }
      const c = typeof body.border_color === 'string' ? body.border_color.trim().slice(0, 40) : null;
      setThreadDisplay(conv.id, { borderColor: c });
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

  // -- Thread password lock (DAR-785) -------------------------------------------

  // PUT /threads/:external_id/lock — set or change a password on the thread.
  router.put('/threads/:external_id/lock', (req: AuthedRequest, res) => {
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(req.apiKey!, externalId);
    if ('error' in result) { sendError(res, result.error.status, result.error.code, result.error.message); return; }
    const { password } = (req.body ?? {}) as { password?: unknown };
    if (typeof password !== 'string' || password.length < 1) {
      sendError(res, 400, 'invalid_request', 'password must be a non-empty string');
      return;
    }
    setThreadPassword(result.id, password);
    const refreshed = getConversationById(result.id) ?? result;
    res.json(threadDescriptor(refreshed, req));
  });

  // DELETE /threads/:external_id/lock — remove the password from the thread.
  router.delete('/threads/:external_id/lock', (req: AuthedRequest, res) => {
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(req.apiKey!, externalId);
    if ('error' in result) { sendError(res, result.error.status, result.error.code, result.error.message); return; }
    clearThreadPassword(result.id);
    const refreshed = getConversationById(result.id) ?? result;
    res.json(threadDescriptor(refreshed, req));
  });

  // POST /threads/:external_id/unlock — verify a password to access the thread.
  router.post('/threads/:external_id/unlock', (req: AuthedRequest, res) => {
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(req.apiKey!, externalId);
    if ('error' in result) { sendError(res, result.error.status, result.error.code, result.error.message); return; }
    const { password } = (req.body ?? {}) as { password?: unknown };
    if (typeof password !== 'string') {
      sendError(res, 400, 'invalid_request', 'password must be a string');
      return;
    }
    const ok = verifyThreadPassword(result.id, password);
    if (!ok) {
      sendError(res, 403, 'wrong_password', 'Incorrect password');
      return;
    }
    res.json({ ok: true });
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
    // No cover chat is created up front anymore — a group starts with none, and
    // the group-wide chat is spun up on demand via POST /groups/:id/chat.
    const { group } = createGroup(name, color);
    res.status(201).json({ ...group, group_chat: null, members: [] });
  });

  // POST /groups/:id/chat: create-or-return the group's cover chat (the
  // group-wide message thread) on demand. Idempotent. Returns the thread
  // descriptor so the caller can open it immediately.
  router.post('/groups/:id/chat', (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || !getGroupById(id)) {
      sendError(res, 404, 'group_not_found', `Group ${req.params.id} not found`);
      return;
    }
    const groupChat = ensureGroupChat(id);
    res.status(201).json(threadDescriptor(groupChat, req));
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
    if (isProtectedSystemThread(result.external_id)) {
      sendError(res, 403, 'protected_thread', 'This system thread cannot be deleted');
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

  // -- POST /threads/:external_id/smart-fork ---------------------------------
  // Smart Fork: condense the ENTIRE thread (any size) into one markdown context
  // block and open a fresh thread per selected model with that block as its
  // first and only message. Unlike /fork this copies NO turns and carries NO
  // session — the point is to shed the transcript's weight and start clean on a
  // different model. Body: { targets: [{ adapter, model? }, …] }.
  //
  // The forks are created and returned synchronously so the cockpit can open
  // their windows right away; condensation (one or more local-CLI calls, slow
  // on a big thread) runs in the background and the seed message lands over the
  // normal turn SSE once it's ready.

  router.post('/threads/:external_id/smart-fork', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const parent = result;

    if (countTurns(parent.id) === 0) {
      sendError(res, 400, 'no_messages', 'Thread has no messages to condense');
      return;
    }

    const body = (req.body ?? {}) as { targets?: unknown };
    const rawTargets = Array.isArray(body.targets) ? body.targets : [];
    if (!rawTargets.length) {
      sendError(res, 400, 'invalid_request', 'targets must be a non-empty array of { adapter, model? }');
      return;
    }

    const adapters = getAdapters();
    const targets: Array<{ adapter: AdapterConfig; model: string | null }> = [];
    for (const raw of rawTargets) {
      const t = (raw ?? {}) as { adapter?: unknown; model?: unknown };
      if (typeof t.adapter !== 'string' || !adapters[t.adapter]) {
        sendError(res, 400, 'invalid_request', `each target.adapter must be one of ${Object.keys(adapters).join(', ')}`);
        return;
      }
      const adapter = adapters[t.adapter];
      let model: string | null = null;
      if (t.model !== undefined && t.model !== null) {
        if (typeof t.model !== 'string' || !adapter.models.some((m) => m.id === t.model)) {
          sendError(res, 400, 'invalid_request', `target.model must be one of ${adapter.models.map((m) => m.id).join(', ')} for adapter ${adapter.id}`);
          return;
        }
        model = t.model;
      }
      targets.push({ adapter, model });
    }

    const baseTitle = parent.title ?? 'Thread';
    const created: Array<{ conv: ConversationRow; label: string }> = [];
    for (const target of targets) {
      const forkExternalId = `${callerExternalIdPrefix(caller.id)}${randomUUID()}`;
      const fork = getOrCreateConversation(forkExternalId);
      setThreadModelOverride(fork.id, target.adapter.id, target.model);
      const label = target.model
        ? (target.adapter.models.find((m) => m.id === target.model)?.label ?? target.model)
        : target.adapter.name;
      renameConversation(fork.id, `[Smart Fork - ${label}] ${baseTitle}`.slice(0, 200));
      linkContinuedThreads(parent.id, fork.id);
      created.push({ conv: getConversationById(fork.id) ?? fork, label });
    }

    // Condense once, then seed every fork with the same carried-over context.
    void condenseThread(parent)
      .then((condensed) =>
        Promise.all(
          created.map(({ conv, label }) => {
            const text = buildSmartForkMessage(parent, condensed, label);
            const messageId = `turn:${conv.id}:${countTurns(conv.id)}`;
            return processMessage(text, conv.external_id, messageId).catch((err: unknown) => {
              const code = err instanceof ConversationBusyError ? 'message_in_flight' : 'jarvis_error';
              errorByMessageId.set(messageId, {
                code,
                message: err instanceof Error ? err.message : String(err),
              });
            });
          }),
        ),
      )
      .catch((err: unknown) => {
        console.error(`[smart-fork] condensation failed for conversation ${parent.id}:`, err);
      });

    res.status(201).json({
      status: 'condensing',
      forked_from: parent.external_id,
      threads: created.map(({ conv }) => threadDescriptor(conv, req)),
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
    const body = (req.body ?? {}) as { text?: unknown; images?: unknown };
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

    // DAR-744: decode + persist any attached images up front (before deciding
    // queued vs immediate below) so both dispatch paths see the same saved
    // records. Bytes land on disk under image-store's UPLOADS_DIR either way —
    // a queued message's images just wait alongside the queue row until drained.
    let savedImages: SavedImage[] = [];
    if (Array.isArray(body.images) && body.images.length) {
      try {
        savedImages = saveMessageImages(conv.id, countTurns(conv.id), body.images as IncomingImage[]);
      } catch (err) {
        const message = err instanceof ImageValidationError ? err.message : 'failed to save attached image(s)';
        sendError(res, 400, 'invalid_image', message);
        return;
      }
    }
    const imagesJson = savedImages.length
      ? JSON.stringify(savedImages.map(({ filename, mime, conversationId }) => ({ filename, mime, conversationId })))
      : undefined;

    // If a turn is already running, park this message on the server-owned queue
    // instead of bouncing. It's drained oldest-first when the current turn ends
    // (see the status listener below). The queue is exposed over API + SSE, so it
    // survives a refresh and stays in sync across every browser on this thread.
    const pending = getInFlightMessageId(conv.id);
    if (pending) {
      const queued = enqueueMessage(conv.id, text, imagesJson);
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
      void autoGroupThreadFromFirstMessage(conv, text);
    }

    processMessage(text, externalId, messageId, savedImages.length ? savedImages : undefined)
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

  // -- GET /threads/:external_id/images/:turn_index/:filename: serve an -----
  // -- attached image (DAR-744) ----------------------------------------------
  // The turn_index + filename must both match a real record on a turn the
  // caller is authorized to view — resolveImagePath only ever reads bytes for
  // the conversationId recorded on that turn's own images JSON, not whatever
  // the URL happens to contain, so this can't be used to read another thread's
  // uploads even though the physical path (image-store's UPLOADS_DIR) is keyed
  // by numeric conversation id rather than external_id.
  router.get('/threads/:external_id/images/:turn_index/:filename', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const conv = result;
    const turnIndex = Number(paramString(req.params.turn_index));
    const filename = paramString(req.params.filename);

    const turn = getTurns(conv.id).find((t) => t.turn_index === turnIndex);
    const stored = turn ? parseStoredImages(turn.images) : [];
    const rec = stored.find((s) => s.filename === filename);
    if (!rec) {
      sendError(res, 404, 'image_not_found', 'No such attached image on this turn');
      return;
    }
    const absPath = resolveImagePath(rec.conversationId, rec.filename);
    if (!absPath) {
      sendError(res, 404, 'image_not_found', 'Attached image is no longer on disk');
      return;
    }
    res.type(rec.mime).sendFile(absPath);
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
      turn: serializeTurn(assistantTurn, undefined, conv.external_id),
      user_turn: serializeTurn(userTurn, undefined, conv.external_id),
      tool_calls: toolCalls.map((t) => serializeTurn(t, undefined, conv.external_id)),
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

  // -- GET /threads/:external_id/links: list per-thread relevant links -------

  router.get('/threads/:external_id/links', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    res.json({ thread: threadDescriptor(result, req), links: listThreadLinks(result.id) });
  });

  // -- POST /threads/:external_id/links: set the preview or add a link -------
  // kind:'preview' (default) upserts the single hero link; kind:'link' appends.

  router.post('/threads/:external_id/links', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const body = (req.body ?? {}) as { url?: unknown; label?: unknown; kind?: unknown };
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!url) {
      sendError(res, 400, 'invalid_request', 'url is required and must be a non-empty string');
      return;
    }
    if (url.length > 2048) {
      sendError(res, 413, 'url_too_long', 'url exceeds max length of 2048 chars');
      return;
    }
    const label =
      typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 200) : null;
    const kind = body.kind === 'link' ? 'link' : 'preview';
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const link =
      kind === 'link' ? addThreadLink(result.id, url, label) : setPreviewLink(result.id, url, label);
    res.status(201).json({ link });
  });

  // -- DELETE /threads/:external_id/links/:linkId: remove one link -----------

  router.delete('/threads/:external_id/links/:linkId', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const linkId = Number(paramString(req.params.linkId));
    const existing = getThreadLink(linkId);
    if (!existing || existing.conversation_id !== result.id) {
      sendError(res, 404, 'link_not_found', 'Link not found on this thread');
      return;
    }
    deleteThreadLink(linkId);
    res.json({ status: 'deleted', link_id: linkId });
  });

  // -- DELETE /threads/:external_id/links: clear all links -------------------

  router.delete('/threads/:external_id/links', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const removed = clearThreadLinks(result.id);
    res.json({ status: 'cleared', removed });
  });

  // == Dispatches (DAR-782) ====================================================

  // -- POST /threads/:ext/dispatches: create a dispatch ----------------------
  router.post('/threads/:external_id/dispatches', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const body = (req.body ?? {}) as {
      wait_mode?: unknown; wake_mode?: unknown; label?: unknown;
      workers?: unknown;
    };
    const waitMode = (['all', 'any', 'specific'] as WaitMode[]).includes(body.wait_mode as WaitMode)
      ? (body.wait_mode as WaitMode) : 'all';
    const wakeMode = (['active', 'passive'] as WakeMode[]).includes(body.wake_mode as WakeMode)
      ? (body.wake_mode as WakeMode) : 'active';
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 200) : null;
    if (!Array.isArray(body.workers) || body.workers.length === 0) {
      sendError(res, 400, 'invalid_request', 'workers must be a non-empty array of {external_id, role_label?, is_gate?}');
      return;
    }
    const workerInputs: Array<{ conversationId: number; roleLabel?: string | null; isGate?: boolean }> = [];
    for (const w of body.workers as Array<{ external_id?: unknown; role_label?: unknown; is_gate?: unknown }>) {
      const wExtId = typeof w.external_id === 'string' ? w.external_id : '';
      if (!wExtId) {
        sendError(res, 400, 'invalid_request', 'each worker must have a non-empty external_id');
        return;
      }
      const wConv = getConversation(wExtId);
      if (!wConv) {
        sendError(res, 404, 'worker_thread_not_found', `Worker thread ${wExtId} not found`);
        return;
      }
      workerInputs.push({
        conversationId: wConv.id,
        roleLabel: typeof w.role_label === 'string' ? w.role_label.trim().slice(0, 200) : null,
        isGate: !!w.is_gate,
      });
    }
    const created = createDispatch({
      orchestratorConversationId: result.id,
      waitMode,
      wakeMode,
      label,
      workers: workerInputs,
    });
    res.status(201).json(created);
  });

  // -- GET /threads/:ext/dispatches: list outbound + inbound -----------------
  router.get('/threads/:external_id/dispatches', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    res.json({
      outbound: listOutboundDispatches(result.id),
      inbound: listInboundDispatches(result.id),
    });
  });

  // -- PATCH /threads/:ext/dispatches/:id: acknowledge -----------------------
  router.patch('/threads/:external_id/dispatches/:dispatchId', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const dispatchId = Number(paramString(req.params.dispatchId));
    const dispatch = getDispatch(dispatchId);
    if (!dispatch || dispatch.orchestrator_conversation_id !== result.id) {
      sendError(res, 404, 'dispatch_not_found', 'Dispatch not found on this thread');
      return;
    }
    const body = (req.body ?? {}) as { status?: unknown };
    if (body.status !== 'acknowledged') {
      sendError(res, 400, 'invalid_request', 'Only status:"acknowledged" is supported');
      return;
    }
    const acked = acknowledgeDispatch(dispatchId);
    if (!acked) {
      sendError(res, 409, 'dispatch_not_complete', 'Dispatch is not in "complete" status');
      return;
    }
    res.json({ dispatch: acked, workers: listDispatchWorkers(dispatchId) });
  });

  // -- DELETE /threads/:ext/dispatches/:id: remove ---------------------------
  router.delete('/threads/:external_id/dispatches/:dispatchId', (req: AuthedRequest, res) => {
    const caller = req.apiKey!;
    const externalId = paramString(req.params.external_id);
    const result = findConversationForCaller(caller, externalId);
    if ('error' in result) {
      sendError(res, result.error.status, result.error.code, result.error.message);
      return;
    }
    const dispatchId = Number(paramString(req.params.dispatchId));
    const dispatch = getDispatch(dispatchId);
    if (!dispatch || dispatch.orchestrator_conversation_id !== result.id) {
      sendError(res, 404, 'dispatch_not_found', 'Dispatch not found on this thread');
      return;
    }
    deleteDispatch(dispatchId);
    res.json({ status: 'deleted', dispatch_id: dispatchId });
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
      'thread_link', 'thread_reminder',
      'queued_message', 'note', 'stream_start', 'stream_delta', 'stream_end',
      'quick_capture', 'thread_summary', 'notification',
      'dispatch', 'dispatch_cue', 'hopper_item', 'hopper_node', 'smart_todo',
      'monitor', 'monitor_run', 'foundry_project', 'foundry_module',
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

  router.get('/settings', async (_req: AuthedRequest, res) => {
    const info = getActiveAdapterInfo();
    res.json({
      settings: getAllSettings(),
      active_adapter: info.adapter,
      active_model: info.model,
      active_runtime: getActiveRuntimeDescriptor(),
      active_preset_id: getSetting('active_preset'),
      adapter_options: (() => { try { return JSON.parse(getSetting('adapter_options') ?? '{}'); } catch { return {}; } })(),
      adapters: await providerCatalog(),
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

  router.get('/settings/dashboard', (_req: AuthedRequest, res) => {
    res.json({
      settings: parseJsonSetting<Record<string, unknown>>(MOMENTUM_LAB_SETTINGS_KEY),
    });
  });

  router.post('/settings/dashboard', (req: AuthedRequest, res) => {
    if (!isAdminScope(req.apiKey!.scope)) {
      sendError(res, 403, 'admin_scope_required', 'Changing dashboard settings requires an admin-scoped key');
      return;
    }
    const settings = (req.body as { settings?: unknown } | null | undefined)?.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      sendError(res, 400, 'invalid_dashboard_settings', 'Dashboard settings must be a JSON object');
      return;
    }
    setSetting(MOMENTUM_LAB_SETTINGS_KEY, JSON.stringify(settings));
    res.json({ ok: true, settings });
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

  // Autonomy dial (kevin/jarvis-autonomy-dial.md) — same shape as personality
  // stats above: a 0-10 value + change history. `hard_limiter` is fixed,
  // read-only context for the UI — it never changes with the dial.
  router.get('/control-panel/autonomy-level', (_req: AuthedRequest, res) => {
    res.json({ level: getAutonomyLevel(), hard_limiter: AUTONOMY_HARD_LIMITER_SUMMARY });
  });

  router.patch('/control-panel/autonomy-level', (req: AuthedRequest, res) => {
    if (!isAdminScope(req.apiKey!.scope)) {
      sendError(res, 403, 'admin_scope_required', 'Changing the autonomy level requires an admin-scoped key');
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const num = Number(body.level);
    if (!Number.isFinite(num)) {
      sendError(res, 400, 'invalid_request', 'level must be a number 0-10');
      return;
    }
    const level = updateAutonomyLevel(num, req.apiKey!.caller_label ?? null);
    res.json({ ok: true, level });
  });

  router.get('/control-panel/autonomy-level/history', (req: AuthedRequest, res) => {
    const limitRaw = parseInt(String(req.query.limit ?? '100'), 10);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 100;
    res.json({ history: getAutonomyLevelHistory(limit) });
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
