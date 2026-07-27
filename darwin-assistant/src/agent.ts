import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildSystemPrompt, loadMemoryBlock } from './prompt.js';
import { ALL_TOOLS, TOOL_MAP } from './tools/index.js';
import { withToolExecutionContext, type ToolExecutionContext } from './autonomy-ledger.js';
import {
  getOrCreateConversation,
  updateSessionState,
  addTurn,
  closeConversation as dbCloseConversation,
  touchConversation,
  getTurns,
  countTurns,
  getSetting,
  INTERRUPTED_MARKER,
  type ConversationRow,
  type TurnRow,
  type TurnMetadata,
} from './conversation-db.js';
import { sseBus, type StatusEvent, type StreamStartEvent, type StreamDeltaEvent, type StreamEndEvent, type ToolCallEvent } from './sse-bus.js';
import { buildGroupChatContext } from './group-chat-context.js';
import { buildQuickChatContext } from './quick-chat-profiles.js';
import { dirname } from 'node:path';
import type { SavedImage } from './image-store.js';

const MAX_TOOL_TURNS = 50;

// The jarvis systemd service's own WorkingDirectory is the darwin-assistant repo
// (so `pnpm build`/relative requires resolve normally) — but every `claude`/`codex`
// CLI child we spawn used to inherit that same cwd by default. Claude Code buckets
// sessions by cwd on disk (~/.claude/projects/<encoded-cwd>/), so every JARVIS chat
// session and every real interactive coding session in this repo landed in the same
// bucket. A stale/unresolvable --resume id then had a real, currently-active coding
// session to fall back into instead of erroring cleanly — a watch/Slack message could
// surface mid-transcript inside someone's live `claude` session instead of getting a
// clean JARVIS reply. Giving JARVIS's spawned CLI its own cwd — outside any repo Kevin
// or an agent actually codes in — keeps its session bucket permanently isolated.
const JARVIS_CLI_CWD = process.env.JARVIS_CLI_CWD ?? join(homedir(), '.jarvis-cli-workspace');
try {
  mkdirSync(JARVIS_CLI_CWD, { recursive: true });
} catch (err) {
  console.error(`[agent] Failed to create JARVIS_CLI_CWD (${JARVIS_CLI_CWD}):`, err);
}

// DAR-716: cockpit plan/build mode toggle. The frontend prepends this marker
// to the raw outgoing message when the operator has plan mode on; we persist
// the turn's `content` completely unchanged (marker included) so the cockpit
// can detect it later purely from turn history (refresh-safe, no schema
// change) and color the bubble accordingly. Only the copy of the text that
// actually reaches the model gets rewritten into an explicit instruction.
export const PLAN_MODE_MARKER = '-- mode: planning --';

export function isPlanModeMessage(rawContent: string | null | undefined): boolean {
  return !!rawContent && rawContent.trimStart().startsWith(PLAN_MODE_MARKER);
}

/** Strip the marker and rewrite it into an explicit no-action instruction the
 *  model actually has to follow. Baked into the human turn itself (not the
 *  system prompt) so it works whether this is a fresh turn or a --resume'd
 *  one, since resumed turns never resend the system prompt. */
function applyPlanMode(rawInput: string): string {
  const trimmed = rawInput.trimStart();
  if (!trimmed.startsWith(PLAN_MODE_MARKER)) return rawInput;
  const message = trimmed.slice(PLAN_MODE_MARKER.length).trimStart();
  return [
    '<planning_mode>',
    'PLANNING MODE is active for this message only. Do not take any action: no file edits, no tool calls,',
    'no task/build execution, nothing that changes state. Only discuss and plan. If asked to do something,',
    'describe what you would do instead of doing it.',
    '</planning_mode>',
    '',
    message,
  ].join('\n');
}

// Fix C (DAR-676): appended to whatever streamed when a run is torn down mid-reply,
// so the user sees the partial answer plus a clear "retry" cue. The fully-empty
// case reuses INTERRUPTED_MARKER (shared with Fix B) instead.
const INTERRUPTED_SUFFIX =
  '_⚠️ This reply was interrupted before it finished. Send another message to continue._';

// Fix C (DAR-676): durable run lifecycle. A model subprocess that never returns
// (hung network, wedged CLI) used to block a thread forever — the cockpit marks
// the conversation in-flight and only a service restart clears it. We now cap each
// model call and kill the child on timeout so the run errors out (and the caller
// persists whatever streamed). Configurable for long tool chains.
const RUN_TIMEOUT_MS = (() => {
  const raw = Number(process.env.JARVIS_RUN_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000; // 10 min per model call
})();
// Grace period between SIGTERM and SIGKILL when force-killing a subprocess.
const CHILD_KILL_GRACE_MS = 5_000;

// Live model subprocesses, tracked so a service shutdown (SIGTERM/SIGINT) can tear
// them down deterministically instead of orphaning them mid-run.
const activeChildren = new Set<ChildProcess>();

/** Kill a subprocess: SIGTERM, then SIGKILL after a grace period if still alive. */
function killChild(child: ChildProcess): void {
  try {
    child.kill('SIGTERM');
  } catch {}
  const grace = setTimeout(() => {
    try {
      if (!child.killed) child.kill('SIGKILL');
    } catch {}
  }, CHILD_KILL_GRACE_MS);
  grace.unref?.();
}

/**
 * Fix C (DAR-676): tear down every live model subprocess. Called from the process
 * SIGTERM/SIGINT handler so a restart doesn't orphan a running `claude`/`codex`
 * child. Any empty assistant turns left behind are healed on next boot by
 * reconcileInterruptedRuns() (Fix B).
 */
export function shutdownActiveRuns(): number {
  const n = activeChildren.size;
  for (const child of activeChildren) killChild(child);
  activeChildren.clear();
  return n;
}

/** Error thrown when a model call exceeds RUN_TIMEOUT_MS and is killed. */
export class RunTimeoutError extends Error {
  constructor(ms: number) {
    super(`model call produced no output for ${Math.round(ms / 1000)}s and was terminated as hung`);
    this.name = 'RunTimeoutError';
  }
}

// --- Runtime descriptor contract (mirrors Paperclip's AdapterRuntimeDescriptor,
// packages/adapter-utils/src/types.ts) so JARVIS and Paperclip describe provider
// switching with the same vocabulary. DAR-680 Slice 3. ---
export type AdapterRuntimeTransport = 'local_cli' | 'gateway' | 'http_api' | 'child_process';
export type AdapterResumeStrategy =
  | 'native'
  | 'workspace_bound'
  | 'provider_bound'
  | 'stateless'
  | 'transcript_replay';
export type AdapterSessionScope = 'none' | 'provider' | 'workspace' | 'thread';

export interface AdapterRuntimeAuthDescriptor {
  envKeys: string[];
  supportsLocalLogin: boolean;
  detectedFromConfig: boolean;
}

export interface AdapterRuntimeSessionDescriptor {
  resumeStrategy: AdapterResumeStrategy;
  sessionScope: AdapterSessionScope;
  canResumeAcrossModelChange: boolean;
  canResumeAcrossProviderChange: boolean;
  requiresFreshSessionOnAssignment: boolean;
}

export interface AdapterRuntimeCapabilities {
  tools: boolean;
  mcp: boolean;
  streamingText: boolean;
  structuredOutput: boolean;
  webSearch: boolean;
}

export interface AdapterRuntimeDescriptor {
  adapterType: string;
  provider: string;
  providerLabel: string;
  transport: AdapterRuntimeTransport;
  model: string | null;
  modelLabel: string | null;
  auth: AdapterRuntimeAuthDescriptor;
  session: AdapterRuntimeSessionDescriptor;
  capabilities: AdapterRuntimeCapabilities;
}

export interface AdapterOptionSchema {
  key: string;
  label: string;
  type: 'enum';
  values: string[];
  default?: string;
}

export interface AdapterConfig {
  id: string;
  name: string;
  bin: string;
  models: { id: string; label: string }[];
  // Declarative options schema so the UI renders the right controls per provider.
  optionsSchema?: AdapterOptionSchema[];
  // Static runtime metadata (provider/auth/session/capability) for this adapter.
  // The `model`/`modelLabel` fields are placeholders here and filled in per-request
  // by getAdapterRuntimeDescriptor(); leave them null in the static config.
  runtime: Omit<AdapterRuntimeDescriptor, 'adapterType' | 'model' | 'modelLabel'>;
  buildArgs: (opts: { sessionId?: string | null; model?: string | null; options?: Record<string, unknown>; imageDirs?: string[]; imagePaths?: string[] }) => string[];
  envOverrides?: (env: Record<string, string>) => void;
  // Optional adapter-specific stdout parser. Defaults to the claude JSONL parser.
  parseOutput?: (stdout: string) => ClaudeResult;
  // Optional per-line event mapper to translate adapter-native JSONL into claude-shaped
  // events for the SSE stream. Return null to drop an event from the stream.
  mapStreamEvent?: (event: Record<string, unknown>) => Record<string, unknown> | null;
  // Optional adapter-specific pattern used to detect "unknown/expired session" stderr,
  // so runConversationTurn can retry without --resume.
  unknownSessionPattern?: RegExp;
}

const ADAPTERS: Record<string, AdapterConfig> = {
  claude: {
    id: 'claude',
    name: 'Claude (Anthropic)',
    bin: process.env.CLAUDE_BIN ?? 'claude',
    models: [
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-opus-4-7', label: 'Opus 4.7' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'claude-fable-5', label: 'Fable 5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    ],
    optionsSchema: [
      { key: 'thinking', label: 'Thinking level', type: 'enum', values: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
    ],
    runtime: {
      provider: 'anthropic',
      providerLabel: 'Anthropic',
      transport: 'local_cli',
      // The claude adapter deletes ANTHROPIC_API_KEY (envOverrides) and relies on
      // the local `claude` CLI subscription login, so there is no required env key.
      auth: { envKeys: [], supportsLocalLogin: true, detectedFromConfig: false },
      session: {
        resumeStrategy: 'native',
        sessionScope: 'provider',
        canResumeAcrossModelChange: true,
        canResumeAcrossProviderChange: false,
        requiresFreshSessionOnAssignment: false,
      },
      capabilities: { tools: true, mcp: true, streamingText: true, structuredOutput: false, webSearch: true },
    },
    buildArgs({ sessionId, model, options, imageDirs }) {
      const args = ['--print', '-', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
      if (model) args.push('--model', model);
      if (sessionId) args.push('--resume', sessionId);
      if (options?.thinking && typeof options.thinking === 'string') args.push('--effort', options.thinking);
      // DAR-744: give the local claude CLI read access to attached-image temp
      // dirs so it can open the absolute paths referenced in the prompt (see
      // vision-critique.ts for the same working pattern).
      for (const dir of imageDirs ?? []) args.push('--add-dir', dir);
      return args;
    },
    envOverrides(env) { delete env['ANTHROPIC_API_KEY']; },
  },
  codex: {
    id: 'codex',
    name: 'Codex (OpenAI)',
    bin: process.env.CODEX_BIN ?? 'codex',
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
    ],
    runtime: {
      provider: 'openai',
      providerLabel: 'OpenAI',
      transport: 'local_cli',
      auth: { envKeys: ['OPENAI_API_KEY'], supportsLocalLogin: true, detectedFromConfig: false },
      session: {
        resumeStrategy: 'native',
        sessionScope: 'provider',
        canResumeAcrossModelChange: true,
        canResumeAcrossProviderChange: false,
        requiresFreshSessionOnAssignment: false,
      },
      // Codex's --json stream emits one item.completed at end of turn rather than
      // incremental deltas (see codexMapStreamEvent), so streamingText is false.
      capabilities: { tools: true, mcp: true, streamingText: false, structuredOutput: false, webSearch: false },
    },
    buildArgs({ sessionId, model, imagePaths }) {
      const args: string[] = ['exec'];
      if (sessionId) args.push('resume', sessionId);
      args.push(
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
      );
      if (model) args.push('-m', model);
      // DAR-745: codex's own image flag, one per attached file (unlike claude's
      // --add-dir, codex wants the file paths themselves, not a containing dir).
      for (const p of imagePaths ?? []) args.push('-i', p);
      // Prompt argument `-` explicitly tells codex to read the prompt from stdin.
      args.push('-');
      return args;
    },
    parseOutput: parseCodexOutput,
    mapStreamEvent: codexMapStreamEvent,
    unknownSessionPattern: /(session|thread)[^\n]*not found|no such (session|thread)|unknown (session|thread)/i,
  },
  auggie: {
    id: 'auggie',
    name: 'Auggie (Augment)',
    bin: process.env.AUGGIE_BIN ?? 'auggie',
    models: [
      { id: 'default', label: 'Default' },
    ],
    runtime: {
      provider: 'augment',
      providerLabel: 'Augment',
      transport: 'local_cli',
      auth: { envKeys: [], supportsLocalLogin: true, detectedFromConfig: false },
      session: {
        resumeStrategy: 'native',
        sessionScope: 'provider',
        canResumeAcrossModelChange: true,
        canResumeAcrossProviderChange: false,
        requiresFreshSessionOnAssignment: false,
      },
      capabilities: { tools: true, mcp: false, streamingText: false, structuredOutput: false, webSearch: false },
    },
    buildArgs({ sessionId, model, imagePaths }) {
      const args = ['--print', '--output-format', 'json'];
      if (sessionId) args.push('--resume', sessionId);
      if (model && model !== 'default') args.push('--model', model);
      // DAR-745: auggie's own image flag, one per attached file.
      for (const p of imagePaths ?? []) args.push('--image', p);
      return args;
    },
  },
};

export function getAdapters(): Record<string, AdapterConfig> {
  return ADAPTERS;
}

function getActiveAdapter(): AdapterConfig {
  const adapterId = getSetting('adapter') ?? 'claude';
  return ADAPTERS[adapterId] ?? ADAPTERS.claude;
}

export function getActiveAdapterInfo(): { adapter: string; model: string | null } {
  const adapter = getActiveAdapter();
  const model = getSetting('model');
  return { adapter: adapter.id, model };
}

function getActiveOptions(): Record<string, unknown> {
  const raw = getSetting('adapter_options');
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
}

// Resolve the effective adapter+model+options for a specific conversation (DAR-680 AC#4).
// A per-thread override (conv.thread_adapter/thread_model) wins over the global
// setting. If the thread pins an adapter but no valid model for it, the adapter's
// default (null) is used rather than leaking a model from another provider.
// Options always come from the active global preset for now (per-thread options are a future slice).
export function resolveConversationRuntime(
  conv: ConversationRow,
): { adapter: AdapterConfig; model: string | null; options: Record<string, unknown> } {
  if (conv.thread_adapter && ADAPTERS[conv.thread_adapter]) {
    const adapter = ADAPTERS[conv.thread_adapter];
    const model =
      conv.thread_model && adapter.models.some((m) => m.id === conv.thread_model)
        ? conv.thread_model
        : null;
    return { adapter, model, options: getActiveOptions() };
  }
  return { adapter: getActiveAdapter(), model: getSetting('model'), options: getActiveOptions() };
}

// Resolve the full runtime descriptor for an adapter, filling in the concrete
// model/modelLabel for this request. Mirrors Paperclip's
// getAdapterRuntimeDescriptor(type, { model }).
export function getAdapterRuntimeDescriptor(
  adapterId: string,
  model?: string | null,
): AdapterRuntimeDescriptor | null {
  const adapter = ADAPTERS[adapterId];
  if (!adapter) return null;
  const resolvedModel = model ?? null;
  const modelLabel = resolvedModel
    ? adapter.models.find((m) => m.id === resolvedModel)?.label ?? resolvedModel
    : null;
  return {
    adapterType: adapter.id,
    model: resolvedModel,
    modelLabel,
    ...adapter.runtime,
  };
}

// Runtime descriptor for whatever adapter/model is currently selected.
export function getActiveRuntimeDescriptor(): AdapterRuntimeDescriptor | null {
  const info = getActiveAdapterInfo();
  return getAdapterRuntimeDescriptor(info.adapter, info.model);
}

// Per-conversation in-flight registry — the single concurrency + observability
// source of truth shared by EVERY ingress path (cockpit /api/v1, Slack, webhook,
// check-in worker). They all funnel through processMessage(), so tracking runs
// here (a) prevents two turns racing on one conversation regardless of source and
// (b) lets the UI report each concurrent thread's status independently instead of
// a single global scalar that cross-talks between simultaneous runs.
interface ActiveRun {
  messageId: string;
  startedAt: number;
  abort: AbortController;
}
const activeRuns = new Map<number, ActiveRun>();

// Stop button (cockpit POST /threads/:id/stop): abort the in-flight run for a
// conversation. Kills the model subprocess; the run then persists whatever
// streamed and stops the thread. Returns false if nothing was running.
export function abortConversationRun(conversationId: number): boolean {
  const run = activeRuns.get(conversationId);
  if (!run) return false;
  run.abort.abort();
  return true;
}

// Thrown by processMessage() when a turn is already running on the conversation.
export class ConversationBusyError extends Error {
  constructor(public readonly pendingMessageId: string) {
    super('Another message is still processing on this thread');
    this.name = 'ConversationBusyError';
  }
}

// Message id of the turn currently running on a conversation, if any.
export function getInFlightMessageId(conversationId: number): string | null {
  return activeRuns.get(conversationId)?.messageId ?? null;
}

// Live in-progress streamed text per conversation, so a SECOND browser that
// opens a thread mid-run sees what JARVIS has "thought" so far — the streamed
// text isn't a committed turn yet, so getThread alone can't show it. Non-empty
// only while a text block is actively streaming; cleared per tool-turn + on end.
const liveStreams = new Map<number, string>();
export function getLiveStream(conversationId: number): string | null {
  const s = liveStreams.get(conversationId);
  return s && s.length ? s : null;
}

// Whether a turn is currently running on a specific conversation.
export function isConversationActive(conversationId: number): boolean {
  return activeRuns.has(conversationId);
}

// Oldest still-running conversation — used for the single-slot status-bar label.
export function getActiveConversation(): { conversationId: number; startedAt: number } | null {
  let oldest: { conversationId: number; startedAt: number } | null = null;
  for (const [conversationId, run] of activeRuns) {
    if (oldest == null || run.startedAt < oldest.startedAt) {
      oldest = { conversationId, startedAt: run.startedAt };
    }
  }
  return oldest;
}

// Number of conversations with a turn currently in flight (DAR-729 control
// panel "live run count" — concurrent processMessage() calls, not systemd
// instances; darwin-assistant is a single service).
export function getActiveRunCount(): number {
  return activeRuns.size;
}

// Every currently-running conversation, oldest first — same shape as
// getActiveConversation() but for all of them, not just the oldest.
export function getActiveRuns(): { conversationId: number; startedAt: number }[] {
  return [...activeRuns.entries()]
    .map(([conversationId, run]) => ({ conversationId, startedAt: run.startedAt }))
    .sort((a, b) => a.startedAt - b.startedAt);
}

export function buildToolsBlock(): string {
  const defs = ALL_TOOLS.map(
    (t) =>
      `### ${t.name}\n${t.description}\nParameters: ${JSON.stringify(t.parameters, null, 2)}`,
  ).join('\n\n');

  return [
    '## Tools',
    'When you need to call a tool, output EXACTLY this format then STOP — do not write anything after the closing tag:',
    '<tool_call>',
    '{"name": "tool_name", "arguments": {"param": "value"}}',
    '</tool_call>',
    '',
    'Available tools:',
    defs,
  ].join('\n');
}

function buildInitialPrompt(userMessage: string): string {
  return [buildSystemPrompt(), buildToolsBlock(), '---', `Human: ${userMessage}`, 'Assistant:'].join('\n\n');
}

export function adapterFromModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const normalized = model.toLowerCase();
  if (normalized.includes('claude')) return 'claude';
  if (normalized.includes('gpt') || normalized.includes('codex') || normalized.includes('o4')) return 'codex';
  if (normalized.includes('augment') || normalized.includes('auggie')) return 'auggie';
  return null;
}

// DAR-759: `session_adapter` is the ONLY authoritative signal for which provider
// owns this conversation's session. Model-name inference is a fragile legacy
// fallback ONLY — Augment is a harness whose model shelf contains ids literally
// named `gpt-5.5`, `claude-opus-...`, etc., so adapterFromModel() would mis-infer
// an auggie turn as codex/claude and fire a false provider-switch replay. To
// prevent that, when the CURRENT runtime adapter is auggie we resolve the session
// adapter to auggie directly rather than trusting an ambiguous shelf model name.
// This is what makes switching models WITHIN augment a no-op for the session.
export function resolveSessionAdapter(
  conv: ConversationRow,
  turns: TurnRow[],
  currentAdapterId?: string,
): string | null {
  if (conv.session_adapter) return conv.session_adapter;
  // No stored adapter (legacy row). If we're currently running through auggie,
  // this session is auggie's — never let a shelf model name impersonate another
  // provider and trigger a false replay.
  if (currentAdapterId === 'auggie') return 'auggie';
  for (let i = turns.length - 1; i >= 0; i--) {
    const inferred = adapterFromModel(turns[i]?.model);
    // Guard the reverse collision too: a legacy turn's model name that happens to
    // match auggie's shelf must not resolve this session to a different provider
    // while we're mid-auggie. (currentAdapterId==='auggie' already returned above.)
    if (inferred) return inferred;
  }
  return null;
}

// DAR-756: a mid-thread adapter switch rebuilds a fresh session by replaying
// the transcript through buildContinuationPrompt(). That prompt used to be
// sized against nothing — full system prompt + tools block + the entire
// ~44.5k-token memory block + a fixed HEAD(6)+TAIL(18) turn window + verbatim
// assistant content — so switching a heavy thread to a smaller-window model
// (e.g. Codex/GPT-5.5) could overflow on the very first turn. Everything below
// sizes that prompt against a conservative per-adapter/per-model budget instead.

// No tokenizer dependency — ~4 chars/token is a standard conservative
// approximation for English+code mixed text. Good enough for budgeting
// (we're trying to avoid overflow, not hit an exact count).
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Deliberately conservative: better to trim a bit more transcript than to
// overflow and hand Kevin a raw provider error. Reserves room for the model's
// own reply on top of the input budget.
const OUTPUT_HEADROOM_TOKENS = 16_000;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000; // unknown model — assume the smallest common window

// Per-model overrides where known; otherwise falls back to the per-adapter
// estimate, then the global default. Codex/GPT-5.5's *effective* window in
// practice (with the CLI's own overhead) is meaningfully smaller than Claude's,
// which is the root cause this ticket is fixing — kept conservative on purpose.
const MODEL_CONTEXT_WINDOW_TOKENS: Record<string, number> = {
  'claude-opus-4-8': 200_000,
  'claude-opus-4-7': 200_000,
  'claude-sonnet-5': 200_000,
  'claude-sonnet-4-6': 200_000,
  'claude-fable-5': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
  'gpt-5.5': 128_000,
  'gpt-5.4': 128_000,
  'gpt-5.4-mini': 128_000,
};
const ADAPTER_CONTEXT_WINDOW_TOKENS: Record<string, number> = {
  claude: 200_000,
  codex: 128_000,
  auggie: DEFAULT_CONTEXT_WINDOW_TOKENS,
};

function contextWindowTokensFor(adapterId: string, model: string | null): number {
  if (model && MODEL_CONTEXT_WINDOW_TOKENS[model] !== undefined) return MODEL_CONTEXT_WINDOW_TOKENS[model];
  return ADAPTER_CONTEXT_WINDOW_TOKENS[adapterId] ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}

// Same truncation idea already applied to tool_args (1200 chars)/tool_result
// (2000 chars) below, extended to assistant `content` — previously the one
// field that replayed verbatim no matter how large a single agentic turn was.
const ASSISTANT_REPLAY_TRUNCATE_CHARS = 4000;

function summarizeTurnForReplay(turn: TurnRow, maxAssistantChars = ASSISTANT_REPLAY_TRUNCATE_CHARS): string | null {
  const content = turn.content?.trim() ?? '';
  if (turn.role === 'user') return `Human (${turn.created_at} UTC): ${content}`;
  if (turn.role === 'assistant') {
    const body = content.length > maxAssistantChars
      ? `${content.slice(0, maxAssistantChars)}\n[... truncated ${content.length - maxAssistantChars} chars for replay ...]`
      : content;
    return `Assistant (${turn.created_at} UTC): ${body}`;
  }
  if (turn.role === 'tool_call') {
    const args = turn.tool_args ? turn.tool_args.slice(0, 1200) : '{}';
    return `Assistant tool call (${turn.created_at} UTC): ${turn.tool_name ?? 'unknown'} ${args}`;
  }
  if (turn.role === 'tool_result') {
    const result = turn.tool_result ? turn.tool_result.slice(0, 2000) : '';
    return `Tool result (${turn.created_at} UTC): ${turn.tool_name ?? 'unknown'} ${result}`;
  }
  return null;
}

// Picks how many turns to replay given a char budget for the transcript
// section. Always keeps a minimum head/tail for continuity even if that
// minimum runs slightly over budget (turns are already per-turn truncated
// above, so the overrun is bounded, not unbounded like the old verbatim replay
// was) — the budget mainly controls how much *extra* history beyond that
// minimum gets pulled in.
function selectTurnsForBudget(
  priorTurns: TurnRow[],
  transcriptBudgetChars: number,
): { selectedTurns: TurnRow[]; elidedCount: number; headCount: number; tailCount: number } {
  if (priorTurns.length === 0) return { selectedTurns: [], elidedCount: 0, headCount: 0, tailCount: 0 };

  const MIN_TAIL_KEEP = 4;
  const MAX_TAIL_KEEP = 18;
  const MIN_HEAD_KEEP = 2;
  const MAX_HEAD_KEEP = 6;

  let used = 0;
  let tailCount = 0;
  for (let i = priorTurns.length - 1; i >= 0 && tailCount < MAX_TAIL_KEEP; i--) {
    const cost = (summarizeTurnForReplay(priorTurns[i])?.length ?? 0) + 2;
    if (tailCount >= MIN_TAIL_KEEP && used + cost > transcriptBudgetChars) break;
    used += cost;
    tailCount++;
  }

  const remaining = priorTurns.length - tailCount;
  let headCount = 0;
  const headLimit = Math.min(remaining, MAX_HEAD_KEEP);
  for (let i = 0; i < headLimit; i++) {
    const cost = (summarizeTurnForReplay(priorTurns[i])?.length ?? 0) + 2;
    if (headCount >= MIN_HEAD_KEEP && used + cost > transcriptBudgetChars) break;
    used += cost;
    headCount++;
  }

  const elidedCount = priorTurns.length - headCount - tailCount;
  const selectedTurns = elidedCount > 0
    ? [...priorTurns.slice(0, headCount), ...priorTurns.slice(priorTurns.length - tailCount)]
    : priorTurns;

  return { selectedTurns, elidedCount, headCount, tailCount };
}

// `aggressive` is used for the one-shot retry after a real context-overflow
// error from the destination adapter (see the overflow-retry handling around
// runClaude() below): shrinks the budget further and drops to a truncated
// memory block, on top of whatever the normal per-model budget already trimmed.
function buildContinuationPrompt(
  turns: TurnRow[],
  userMessage: string,
  adapterId: string = 'claude',
  model: string | null = null,
  opts?: { aggressive?: boolean },
): string {
  const priorTurns = turns.length && turns[turns.length - 1]?.role === 'user'
    ? turns.slice(0, -1)
    : turns;

  const systemPrompt = buildSystemPrompt();
  const toolsBlock = buildToolsBlock();

  const windowTokens = contextWindowTokensFor(adapterId, model);
  const aggressive = opts?.aggressive ?? false;
  const headroomTokens = aggressive ? OUTPUT_HEADROOM_TOKENS * 2 : OUTPUT_HEADROOM_TOKENS;

  // The memory block is the single biggest fixed cost (~44.5k tokens full-size)
  // and the ticket's biggest single lever for small-window adapters — compact
  // it whenever the window is meaningfully smaller than Claude's, not just on
  // the aggressive retry path.
  const memoryMaxChars = aggressive
    ? 4_000
    : windowTokens <= 128_000
      ? 12_000
      : undefined;
  const memoryBlock = loadMemoryBlock(memoryMaxChars);

  const staticTokens =
    estimateTokens(systemPrompt) +
    estimateTokens(toolsBlock) +
    estimateTokens(memoryBlock) +
    estimateTokens(userMessage) +
    500; // scaffolding text (headers, labels, etc.)

  const transcriptBudgetTokens = Math.max(0, windowTokens - headroomTokens - staticTokens);
  const transcriptBudgetChars = transcriptBudgetTokens * 4;

  const { selectedTurns, elidedCount, headCount } = selectTurnsForBudget(priorTurns, transcriptBudgetChars);
  const transcriptLines = selectedTurns
    .map((t) => summarizeTurnForReplay(t))
    .filter((line): line is string => Boolean(line));

  if (elidedCount > 0) {
    transcriptLines.splice(headCount, 0, `[... ${elidedCount} earlier turns omitted for brevity ...]`);
  }

  return [
    systemPrompt,
    toolsBlock,
    '---',
    'You are continuing an existing JARVIS conversation after the backing adapter session changed or was reset.',
    'Treat the transcript below as prior context from the same thread and continue naturally from the final human message.',
    '',
    '## Current Memory',
    `<memory_refresh>\n${memoryBlock}\n</memory_refresh>`,
    '',
    '## Prior Transcript',
    transcriptLines.length ? transcriptLines.join('\n\n') : '(no prior turns)',
    '',
    `Human: ${userMessage}`,
    'Assistant:',
  ].join('\n\n');
}

interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ClaudeResult {
  text: string;
  sessionId: string | null;
  usage?: ClaudeUsage;
  model?: string;
  rawOutput?: string;
}

function parseClaudeOutput(stdout: string): ClaudeResult {
  const texts: string[] = [];
  let sessionId: string | null = null;
  let usage: ClaudeUsage | undefined;
  let model: string | undefined;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    if (typeof event.session_id === 'string' && event.session_id) {
      sessionId = event.session_id;
    }

    if (typeof event.model === 'string' && event.model) {
      model = event.model;
    }

    if (event.type === 'system' && event.subtype === 'init') {
      if (typeof event.session_id === 'string' && event.session_id) {
        sessionId = event.session_id;
      }
    }

    if (event.type === 'assistant') {
      if (typeof (event as Record<string, unknown>).session_id === 'string') {
        sessionId = (event as Record<string, unknown>).session_id as string;
      }
      const content = (event.message as Record<string, unknown> | null)?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
        }
      }
    }

    if (event.type === 'result') {
      if (typeof event.session_id === 'string' && event.session_id) {
        sessionId = event.session_id;
      }
      const u = event.usage as Record<string, unknown> | undefined;
      if (u) {
        usage = {
          inputTokens: (typeof u.input_tokens === 'number' ? u.input_tokens : 0),
          outputTokens: (typeof u.output_tokens === 'number' ? u.output_tokens : 0),
          cacheReadTokens: typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : undefined,
          cacheWriteTokens: typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : undefined,
        };
      }
      const r = typeof event.result === 'string' ? event.result.trim() : '';
      return { text: r || texts.join('').trim(), sessionId, usage, model, rawOutput: stdout };
    }
  }

  return { text: texts.join('').trim() || stdout.trim(), sessionId, usage, model, rawOutput: stdout };
}

function parseCodexOutput(stdout: string): ClaudeResult {
  const messages: string[] = [];
  let sessionId: string | null = null;
  let usage: ClaudeUsage | undefined;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    if (event.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id) {
      sessionId = event.thread_id;
    }

    if (event.type === 'item.completed') {
      const item = event.item as Record<string, unknown> | undefined;
      if (item && item.type === 'agent_message' && typeof item.text === 'string') {
        messages.push(item.text);
      }
    }

    if (event.type === 'turn.completed') {
      const u = event.usage as Record<string, unknown> | undefined;
      if (u) {
        usage = {
          inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
          outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
          cacheReadTokens: typeof u.cached_input_tokens === 'number' ? u.cached_input_tokens : undefined,
        };
      }
    }
  }

  const finalText = messages[messages.length - 1]?.trim();
  return { text: finalText || stdout.trim(), sessionId, usage, rawOutput: stdout };
}

// Codex's `--json` stream emits one `agent_message` per progress/final update.
// We cannot know which one is final until the process exits, so persistence is
// fixed in parseCodexOutput() and parseTurnSteps(). Live SSE still surfaces
// these as plain progress deltas while a run is active.
function codexMapStreamEvent(event: Record<string, unknown>): Record<string, unknown> | null {
  if (event.type === 'item.completed') {
    const item = event.item as Record<string, unknown> | undefined;
    if (item && item.type === 'agent_message' && typeof item.text === 'string') {
      return {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: item.text },
      };
    }
  }
  return null;
}

export function parseToolCall(
  text: string,
): { name: string; arguments: Record<string, unknown>; precedingText: string } | null {
  const match = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as { name: string; arguments: Record<string, unknown> };
    if (typeof parsed.name === 'string' && parsed.arguments && typeof parsed.arguments === 'object')
      return { ...parsed, precedingText: text.slice(0, match.index ?? 0).trim() };
  } catch {}
  return null;
}

const UNKNOWN_SESSION_RE = /no conversation found with session id|unknown session|session .* not found/i;

// DAR-756: matches the raw provider errors seen when a continuation prompt (or
// a resumed native session) overflows the destination model's context window —
// e.g. Codex's "ran out of room in the model's context window" on a mid-thread
// adapter switch. Kept adapter-agnostic since Claude/Auggie can in principle
// hit the same class of error with their own wording.
const CONTEXT_OVERFLOW_RE = /ran out of room|context window|context.length.exceeded|maximum context length|prompt is too long|too many tokens/i;

export async function runClaude(
  input: string,
  sessionId?: string | null,
  onEvent?: (event: Record<string, unknown>) => void,
  runtime?: { adapter: AdapterConfig; model: string | null; options?: Record<string, unknown> },
  signal?: AbortSignal,
  imageDirs?: string[],
  imagePaths?: string[],
): Promise<ClaudeResult> {
  // A resolved per-thread runtime (DAR-680 AC#4) wins; otherwise fall back to the
  // global adapter/model settings for callers that don't pass one.
  const adapter = runtime?.adapter ?? getActiveAdapter();
  const model = runtime ? runtime.model : getSetting('model');
  const options = runtime?.options ?? getActiveOptions();
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  adapter.envOverrides?.(env);

  const args = adapter.buildArgs({ sessionId, model, options, imageDirs, imagePaths });

  return new Promise((resolve, reject) => {
    const child = spawn(adapter.bin, args, { env, cwd: JARVIS_CLI_CWD });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let lineBuffer = '';

    // Fix C (DAR-676): track this child for shutdown teardown and cap its lifetime.
    activeChildren.add(child);
    let timedOut = false;
    let aborted = false;
    // Stop button: aborting the run kills the child; the close handler then
    // surfaces a distinct "stopped" error and the caller persists what streamed.
    const onAbort = () => { aborted = true; killChild(child); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    // IDLE timeout, not a total-runtime cap: the timer is re-armed on every chunk
    // of output, so a long-but-actively-working run (streaming text, tool calls)
    // never trips it — only a run that goes SILENT for RUN_TIMEOUT_MS is treated
    // as hung and killed. This lets multi-minute agentic turns complete while
    // still catching genuinely stuck subprocesses.
    let killTimer: ReturnType<typeof setTimeout>;
    const armIdleTimer = () => {
      clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        timedOut = true;
        killChild(child);
      }, RUN_TIMEOUT_MS);
      killTimer.unref?.();
    };
    armIdleTimer();
    const cleanup = () => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      activeChildren.delete(child);
    };

    const forwardEvent = (event: Record<string, unknown>) => {
      if (!onEvent) return;
      const mapped = adapter.mapStreamEvent ? adapter.mapStreamEvent(event) : event;
      if (mapped) onEvent(mapped);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      outChunks.push(chunk);
      armIdleTimer(); // progress → not hung; reset the idle clock

      if (onEvent) {
        lineBuffer += chunk.toString('utf8');
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            forwardEvent(JSON.parse(trimmed) as Record<string, unknown>);
          } catch {}
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => { errChunks.push(chunk); armIdleTimer(); });
    child.on('error', (err) => { cleanup(); reject(err); });
    child.on('close', (code) => {
      cleanup();

      // Fix C (DAR-676): killed by the run-timeout watchdog. Surface a distinct
      // error so the caller can persist whatever streamed and stop the thread.
      if (timedOut) {
        reject(new RunTimeoutError(RUN_TIMEOUT_MS));
        return;
      }

      // Stopped via the cockpit Stop button.
      if (aborted) {
        reject(new Error('Run stopped by user'));
        return;
      }

      if (onEvent && lineBuffer.trim()) {
        try { forwardEvent(JSON.parse(lineBuffer.trim()) as Record<string, unknown>); } catch {}
      }

      const stdout = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');

      if ((code ?? 0) !== 0 && !stdout.trim()) {
        const combined = stderr + '\n' + stdout;
        const unknownSessionRe = adapter.unknownSessionPattern ?? UNKNOWN_SESSION_RE;
        if (sessionId && unknownSessionRe.test(combined)) {
          resolve({ text: '', sessionId: null });
          return;
        }
        const firstErr = stderr.split('\n').find((l) => l.trim()) ?? `exit code ${code}`;
        reject(new Error(`${adapter.id}: ${firstErr}`));
        return;
      }
      const parse = adapter.parseOutput ?? parseClaudeOutput;
      resolve(parse(stdout));
    });

    child.stdin.write(input, 'utf8');
    child.stdin.end();
  });
}

export function clearConversation(externalId: string): void {
  dbCloseConversation(externalId);
}

export async function processMessage(
  input: string,
  conversationId: string,
  messageId?: string,
  images?: SavedImage[],
): Promise<string> {
  const conv = getOrCreateConversation(conversationId);

  // Per-conversation mutex. The get/set pair is synchronous (no await between the
  // check and the set), so this is a true gate across every ingress path — a
  // Slack turn and a cockpit turn can no longer double-run one conversation.
  const existing = activeRuns.get(conv.id);
  if (existing) {
    throw new ConversationBusyError(existing.messageId);
  }
  const runMessageId = messageId ?? `turn:${conv.id}:${countTurns(conv.id)}`;
  const abort = new AbortController();
  activeRuns.set(conv.id, { messageId: runMessageId, startedAt: Date.now(), abort });

  sseBus.emit('sse', {
    type: 'status',
    running: true,
    conversationId: conv.id,
    activeConversationId: conv.id,
  } satisfies StatusEvent);

  try {
    return await runConversationTurn(conv, input, abort.signal, images);
  } finally {
    activeRuns.delete(conv.id);
    liveStreams.delete(conv.id);
    sseBus.emit('sse', {
      type: 'status',
      running: false,
      conversationId: conv.id,
      activeConversationId: null,
    } satisfies StatusEvent);
  }
}

async function runConversationTurn(
  conv: ConversationRow,
  input: string,
  signal?: AbortSignal,
  images?: SavedImage[],
): Promise<string> {
  const userTurnIndex = addTurn(
    conv.id,
    'user',
    input,
    undefined,
    undefined,
    undefined,
    images && images.length
      ? { images: JSON.stringify(images.map(({ filename, mime, conversationId }) => ({ filename, mime, conversationId }))) }
      : undefined,
  );
  const runtime = resolveConversationRuntime(conv);
  const adapter = runtime.adapter;
  const turns = getTurns(conv.id);
  const toolContext: ToolExecutionContext = {
    conversationId: conv.id,
    externalId: conv.external_id,
    sourceMessageId: `turn:${conv.id}:${userTurnIndex}`,
    sourceTimestamp: new Date().toISOString(),
    originalText: input,
  };

  let sessionId = conv.claude_session_id;
  const storedSessionAdapter = resolveSessionAdapter(conv, turns, adapter.id);

  // DAR-759: the resume-vs-replay decision is keyed on the ADAPTER (provider:
  // claude/codex/auggie), never the model. Augment's entire model shelf lives
  // under the single `auggie` adapter, so switching model WITHIN augment
  // (e.g. Opus 4.8 -> GPT-5.5, both via auggie) keeps adapter.id==='auggie' and
  // is a deliberate NO-OP here — the session id is preserved and NO transcript
  // replay is built. Augment's own harness handles model switching inside one
  // session. Only a real PROVIDER change (storedSessionAdapter !== adapter.id)
  // nulls the session and rebuilds context via transcript replay. Do not
  // reintroduce the model into this key.
  if (sessionId && storedSessionAdapter && storedSessionAdapter !== adapter.id) {
    console.log(
      `[agent] Conversation ${conv.id} switching adapters (${storedSessionAdapter} -> ${adapter.id}); starting a fresh session from transcript`,
    );
    sessionId = null;
  }

  // DAR-716: rewrite the plan-mode marker (if present) into an explicit
  // instruction for the model. `input` itself stays untouched — it's already
  // been persisted as-is above, and stdinContent is the only thing that needs
  // the rewritten copy. `planModeActive` is a hard gate below, not just a
  // prompt nudge — the ticket asks for a guarantee, not a suggestion the
  // model can ignore.
  const planModeActive = isPlanModeMessage(input);
  const modelInput = applyPlanMode(input);

  // Tell the model which thread it's running in, so it never has to guess
  // (this is what the cockpit todo-panel self-drive + thread routing rely on).
  const threadContextLine = `<jarvis_thread external_id="${conv.external_id}" conversation_id="${conv.id}"/>\n`;

  // DAR-742 — group chats get their member threads' summaries prepended every
  // turn (bounded, lazily-refreshed context — see group-chat-context.ts).
  // Ungrouped/normal threads are untouched (empty string).
  const groupContextBlock = conv.is_group_chat && conv.group_id
    ? await buildGroupChatContext(conv.group_id)
    : '';
  const quickChatContextBlock = buildQuickChatContext(conv.external_id);

  // DAR-744: hand the model an absolute file path per attached image, mirroring
  // the working vision-critique.ts pattern (local claude CLI reads an image when
  // its absolute path is in the prompt + the containing dir is on --add-dir).
  // DAR-745: also keep the flat path list so non-claude adapters (codex -i,
  // auggie --image) can attach the files directly — they don't use --add-dir.
  const imageDirs = images && images.length
    ? Array.from(new Set(images.map((img) => dirname(img.absPath))))
    : undefined;
  const imagePaths = images && images.length ? images.map((img) => img.absPath) : undefined;
  const imageBlock = images && images.length
    ? `<attached_images>\nThe user attached ${images.length} image(s) to this message. Open and look at each one now before responding — absolute paths:\n${images.map((img) => `- ${img.absPath}`).join('\n')}\n</attached_images>\n\n`
    : '';

  const perTurnContextPrefix = threadContextLine + groupContextBlock + quickChatContextBlock + imageBlock;

  let stdinContent = perTurnContextPrefix + (sessionId
    ? `<memory_refresh>\n${loadMemoryBlock()}\n</memory_refresh>\n\n${modelInput}`
    : (turns.length > 1 ? buildContinuationPrompt(turns, modelInput, adapter.id, runtime.model) : buildInitialPrompt(modelInput)));

  // DAR-756: only one aggressive-compaction retry per turn — if the destination
  // model still overflows after that, stop retrying and degrade to a friendly
  // message instead of looping.
  let contextOverflowRetried = false;

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    let accumulatedText = '';
    liveStreams.delete(conv.id); // reset the cross-browser buffer each tool-turn
    const onStreamEvent = (event: Record<string, unknown>) => {
      if (event.type === 'content_block_delta') {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          sseBus.emit('sse', { type: 'stream_delta', conversationId: conv.id, delta: delta.text } satisfies StreamDeltaEvent);
          accumulatedText += delta.text;
          liveStreams.set(conv.id, accumulatedText);
          return;
        }
      }
      if (event.type === 'assistant') {
        const content = (event.message as Record<string, unknown> | null)?.content;
        if (Array.isArray(content)) {
          let fullText = '';
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b.type === 'text' && typeof b.text === 'string') fullText += b.text;
          }
          if (fullText.length > accumulatedText.length) {
            sseBus.emit('sse', { type: 'stream_delta', conversationId: conv.id, delta: fullText.slice(accumulatedText.length) } satisfies StreamDeltaEvent);
            accumulatedText = fullText;
            liveStreams.set(conv.id, accumulatedText);
          }
        }
      }
    };

    sseBus.emit('sse', { type: 'stream_start', conversationId: conv.id } satisfies StreamStartEvent);
    const claudeT0 = Date.now();
    let result: ClaudeResult;
    try {
      result = await runClaude(stdinContent, sessionId, onStreamEvent, runtime, signal, imageDirs, imagePaths);
      sseBus.emit('sse', { type: 'stream_end', conversationId: conv.id } satisfies StreamEndEvent);

      // Session expired or unknown — retry without resume
      if (sessionId && !result.text && !result.sessionId) {
        console.log(`[agent] Session ${sessionId} expired, starting fresh`);
        sessionId = null;
        stdinContent = perTurnContextPrefix + buildContinuationPrompt(turns, modelInput, adapter.id, runtime.model);
        accumulatedText = '';
        sseBus.emit('sse', { type: 'stream_start', conversationId: conv.id } satisfies StreamStartEvent);
        result = await runClaude(stdinContent, null, onStreamEvent, runtime, signal, imageDirs, imagePaths);
        sseBus.emit('sse', { type: 'stream_end', conversationId: conv.id } satisfies StreamEndEvent);
      }
    } catch (err) {
      sseBus.emit('sse', { type: 'stream_end', conversationId: conv.id } satisfies StreamEndEvent);
      const message = err instanceof Error ? err.message : String(err);

      // DAR-756: a real context-window overflow from the destination adapter
      // (typically a mid-thread switch to a smaller-window model like
      // Codex/GPT-5.5). Retry once with an aggressively compacted continuation
      // prompt (smaller transcript window, truncated memory block) instead of
      // immediately surfacing the raw provider error to Kevin.
      if (CONTEXT_OVERFLOW_RE.test(message) && !contextOverflowRetried && turns.length > 0) {
        contextOverflowRetried = true;
        console.log(`[agent] Conversation ${conv.id} overflowed ${adapter.id}'s context window; retrying with an aggressively compacted continuation prompt`);
        sessionId = null;
        stdinContent = perTurnContextPrefix + buildContinuationPrompt(turns, modelInput, adapter.id, runtime.model, { aggressive: true });
        accumulatedText = '';
        try {
          sseBus.emit('sse', { type: 'stream_start', conversationId: conv.id } satisfies StreamStartEvent);
          result = await runClaude(stdinContent, null, onStreamEvent, runtime, signal, imageDirs, imagePaths);
          sseBus.emit('sse', { type: 'stream_end', conversationId: conv.id } satisfies StreamEndEvent);
        } catch (retryErr) {
          sseBus.emit('sse', { type: 'stream_end', conversationId: conv.id } satisfies StreamEndEvent);
          const modelLabel = runtime.model
            ? (adapter.models.find((m) => m.id === runtime.model)?.label ?? runtime.model)
            : adapter.name;
          const friendly = `This thread is too large for ${modelLabel}'s context window, even after compacting the conversation history. Start a fresh thread, or switch back to a larger-window model (e.g. Claude Opus) to keep working in this one.`;
          const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
          addTurn(conv.id, 'assistant', friendly, undefined, undefined, undefined, {
            timingMs: Date.now() - claudeT0,
            claudeInput: stdinContent,
            errorDetail: `${message}\n\n(retry after compaction also failed: ${retryMessage})`,
          });
          touchConversation(conv.id);
          return friendly;
        }
      } else {
        // Fix C (DAR-676): a timed-out or crashed model call must not vanish. Persist
        // whatever streamed so far as the assistant reply (marked interrupted when
        // empty) and stop the stream, then rethrow so the ingress layer records the
        // error state instead of leaving the thread stuck "thinking".
        const partial = accumulatedText.trim()
          ? `${accumulatedText}\n\n${INTERRUPTED_SUFFIX}`
          : INTERRUPTED_MARKER;
        // Capture the raw error so the cockpit can expose it behind "Details"
        // instead of hiding it behind the clean interrupted sentence.
        const errorDetail = (err instanceof Error
          ? `${err.message}\n\n${err.stack ?? ''}`
          : String(err)).slice(0, 8000);
        addTurn(conv.id, 'assistant', partial, undefined, undefined, undefined, {
          timingMs: Date.now() - claudeT0,
          claudeInput: stdinContent,
          errorDetail,
        });
        touchConversation(conv.id);
        throw err;
      }
    }
    const claudeMs = Date.now() - claudeT0;

    if (result.sessionId && result.sessionId !== sessionId) {
      sessionId = result.sessionId;
      updateSessionState(conv.id, sessionId, adapter.id);
    }

    const claudeMeta: TurnMetadata = {
      timingMs: claudeMs,
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
      cacheReadTokens: result.usage?.cacheReadTokens,
      cacheWriteTokens: result.usage?.cacheWriteTokens,
      model: result.model,
      claudeInput: stdinContent,
      claudeOutput: result.rawOutput,
    };

    // Fix A (DAR-676): a torn-down run leaves result.text empty even though we
    // already streamed a real reply to the UI. Fall back to the accumulated
    // streamed text so the reply is persisted instead of a blank turn.
    const persistedText = (result.text && result.text.trim())
      ? result.text
      : accumulatedText;

    const toolCall = parseToolCall(persistedText);

    if (!toolCall) {
      addTurn(conv.id, 'assistant', persistedText, undefined, undefined, undefined, claudeMeta);
      touchConversation(conv.id);
      return persistedText;
    }

    addTurn(
      conv.id,
      'tool_call',
      toolCall.precedingText || null,
      toolCall.name,
      JSON.stringify(toolCall.arguments),
      undefined,
      claudeMeta,
    );
    sseBus.emit('sse', { type: 'tool_call', conversationId: conv.id, toolName: toolCall.name } satisfies ToolCallEvent);

    const tool = TOOL_MAP.get(toolCall.name);
    const toolT0 = Date.now();
    let toolResult: unknown;
    if (planModeActive) {
      // Hard gate, not a prompt-level nudge: even if the model ignores the
      // planning-mode instruction and emits a tool call anyway, it never
      // actually runs. Fed back so the model can recover and just answer.
      toolResult = {
        error: 'Tool execution is disabled — this message is in planning mode. Describe the plan instead of executing it.',
      };
    } else {
      try {
        toolResult = tool
          ? await withToolExecutionContext(toolContext, () => tool.execute(toolCall.arguments, toolContext))
          : { error: `Unknown tool: ${toolCall.name}` };
      } catch (err) {
        toolResult = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    const toolMs = Date.now() - toolT0;

    const toolResultStr = JSON.stringify(toolResult, null, 2);
    addTurn(conv.id, 'tool_result', null, toolCall.name, undefined, toolResultStr, { timingMs: toolMs });

    // Feed tool result back — always use --resume now since we have a session
    stdinContent = `<tool_result name="${toolCall.name}">\n${toolResultStr}\n</tool_result>`;
  }

  addTurn(conv.id, 'assistant', 'Tool call limit reached. Please try a more specific request.');
  return 'Tool call limit reached. Please try a more specific request.';
}
