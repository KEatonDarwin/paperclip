import { spawn } from 'node:child_process';
import { buildSystemPrompt } from './prompt.js';
import { ALL_TOOLS, TOOL_MAP } from './tools/index.js';
import {
  getOrCreateConversation,
  updateSessionId,
  addTurn,
  closeConversation as dbCloseConversation,
  touchConversation,
  getSetting,
  type ConversationRow,
  type TurnMetadata,
} from './conversation-db.js';
import { sseBus, type StatusEvent } from './sse-bus.js';

const MAX_TOOL_TURNS = 50;

export interface AdapterConfig {
  id: string;
  name: string;
  bin: string;
  models: { id: string; label: string }[];
  buildArgs: (opts: { sessionId?: string | null; model?: string | null }) => string[];
  envOverrides?: (env: Record<string, string>) => void;
}

const ADAPTERS: Record<string, AdapterConfig> = {
  claude: {
    id: 'claude',
    name: 'Claude (Anthropic)',
    bin: process.env.CLAUDE_BIN ?? 'claude',
    models: [
      { id: 'claude-opus-4-7', label: 'Opus 4.7' },
      { id: 'claude-opus-4-6', label: 'Opus 4.6' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'claude-sonnet-4-5-20250514', label: 'Sonnet 4.5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    ],
    buildArgs({ sessionId, model }) {
      const args = ['--print', '-', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
      if (model) args.push('--model', model);
      if (sessionId) args.push('--resume', sessionId);
      return args;
    },
    envOverrides(env) { delete env['ANTHROPIC_API_KEY']; },
  },
  codex: {
    id: 'codex',
    name: 'Codex (OpenAI)',
    bin: process.env.CODEX_BIN ?? 'codex',
    models: [
      { id: 'o4-mini', label: 'o4-mini' },
      { id: 'o3', label: 'o3' },
      { id: 'gpt-4.1', label: 'GPT-4.1' },
    ],
    buildArgs({ model }) {
      const args = ['--full-auto'];
      if (model) args.push('--model', model);
      return args;
    },
  },
  auggie: {
    id: 'auggie',
    name: 'Auggie (Augment)',
    bin: process.env.AUGGIE_BIN ?? 'auggie',
    models: [
      { id: 'default', label: 'Default' },
    ],
    buildArgs() {
      return ['--dangerously-skip-permissions'];
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

// Track which conversation is currently being processed (for observability UI)
let activeConversationId: number | null = null;
let activeStartedAt: number | null = null;

export function getActiveConversation(): { conversationId: number; startedAt: number } | null {
  if (activeConversationId == null || activeStartedAt == null) return null;
  return { conversationId: activeConversationId, startedAt: activeStartedAt };
}

function buildToolsBlock(): string {
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

interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface ClaudeResult {
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

function parseToolCall(
  text: string,
): { name: string; arguments: Record<string, unknown> } | null {
  const match = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as { name: string; arguments: Record<string, unknown> };
    if (typeof parsed.name === 'string' && parsed.arguments && typeof parsed.arguments === 'object')
      return parsed;
  } catch {}
  return null;
}

const UNKNOWN_SESSION_RE = /no conversation found with session id|unknown session|session .* not found/i;

async function runClaude(input: string, sessionId?: string | null): Promise<ClaudeResult> {
  const adapter = getActiveAdapter();
  const model = getSetting('model');
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  adapter.envOverrides?.(env);

  const args = adapter.buildArgs({ sessionId, model });

  return new Promise((resolve, reject) => {
    const child = spawn(adapter.bin, args, { env });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => outChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');

      if ((code ?? 0) !== 0 && !stdout.trim()) {
        const combined = stderr + '\n' + stdout;
        if (sessionId && UNKNOWN_SESSION_RE.test(combined)) {
          resolve({ text: '', sessionId: null });
          return;
        }
        const firstErr = stderr.split('\n').find((l) => l.trim()) ?? `exit code ${code}`;
        reject(new Error(`claude: ${firstErr}`));
        return;
      }
      resolve(parseClaudeOutput(stdout));
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
): Promise<string> {
  const conv = getOrCreateConversation(conversationId);
  activeConversationId = conv.id;
  activeStartedAt = Date.now();

  sseBus.emit('sse', { type: 'status', running: true, activeConversationId: conv.id } satisfies StatusEvent);

  try {
    return await runConversationTurn(conv, input);
  } finally {
    activeConversationId = null;
    activeStartedAt = null;
    sseBus.emit('sse', { type: 'status', running: false, activeConversationId: null } satisfies StatusEvent);
  }
}

async function runConversationTurn(conv: ConversationRow, input: string): Promise<string> {
  addTurn(conv.id, 'user', input);

  let sessionId = conv.claude_session_id;
  let stdinContent: string;

  if (sessionId) {
    stdinContent = input;
  } else {
    stdinContent = buildInitialPrompt(input);
  }

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const claudeT0 = Date.now();
    let result = await runClaude(stdinContent, sessionId);

    // Session expired or unknown — retry without resume
    if (sessionId && !result.text && !result.sessionId) {
      console.log(`[agent] Session ${sessionId} expired, starting fresh`);
      sessionId = null;
      stdinContent = buildInitialPrompt(input);
      result = await runClaude(stdinContent, null);
    }
    const claudeMs = Date.now() - claudeT0;

    if (result.sessionId && result.sessionId !== sessionId) {
      sessionId = result.sessionId;
      updateSessionId(conv.id, sessionId);
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

    const toolCall = parseToolCall(result.text);

    if (!toolCall) {
      addTurn(conv.id, 'assistant', result.text, undefined, undefined, undefined, claudeMeta);
      touchConversation(conv.id);
      return result.text;
    }

    addTurn(conv.id, 'tool_call', null, toolCall.name, JSON.stringify(toolCall.arguments), undefined, claudeMeta);

    const tool = TOOL_MAP.get(toolCall.name);
    const toolT0 = Date.now();
    let toolResult: unknown;
    try {
      toolResult = tool
        ? await tool.execute(toolCall.arguments)
        : { error: `Unknown tool: ${toolCall.name}` };
    } catch (err) {
      toolResult = { error: err instanceof Error ? err.message : String(err) };
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
