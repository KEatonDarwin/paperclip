import { spawn } from 'node:child_process';
import { buildSystemPrompt } from './prompt.js';
import { ALL_TOOLS, TOOL_MAP } from './tools/index.js';
import {
  getOrCreateConversation,
  updateSessionId,
  addTurn,
  closeConversation as dbCloseConversation,
  touchConversation,
  type ConversationRow,
} from './conversation-db.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const MAX_TOOL_TURNS = 50;

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

interface ClaudeResult {
  text: string;
  sessionId: string | null;
}

function parseClaudeOutput(stdout: string): ClaudeResult {
  const texts: string[] = [];
  let sessionId: string | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

    if (typeof event.session_id === 'string' && event.session_id) {
      sessionId = event.session_id;
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
      const r = typeof event.result === 'string' ? event.result.trim() : '';
      return { text: r || texts.join('').trim(), sessionId };
    }
  }

  return { text: texts.join('').trim() || stdout.trim(), sessionId };
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
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env['ANTHROPIC_API_KEY'];

  const args = [
    '--print', '-',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];

  if (sessionId) {
    args.push('--resume', sessionId);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { env });
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

  try {
    return await runConversationTurn(conv, input);
  } finally {
    activeConversationId = null;
    activeStartedAt = null;
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
    let result = await runClaude(stdinContent, sessionId);

    // Session expired or unknown — retry without resume
    if (sessionId && !result.text && !result.sessionId) {
      console.log(`[agent] Session ${sessionId} expired, starting fresh`);
      sessionId = null;
      stdinContent = buildInitialPrompt(input);
      result = await runClaude(stdinContent, null);
    }

    if (result.sessionId && result.sessionId !== sessionId) {
      sessionId = result.sessionId;
      updateSessionId(conv.id, sessionId);
    }

    const toolCall = parseToolCall(result.text);

    if (!toolCall) {
      addTurn(conv.id, 'assistant', result.text);
      touchConversation(conv.id);
      return result.text;
    }

    addTurn(conv.id, 'tool_call', null, toolCall.name, JSON.stringify(toolCall.arguments));

    const tool = TOOL_MAP.get(toolCall.name);
    let toolResult: unknown;
    try {
      toolResult = tool
        ? await tool.execute(toolCall.arguments)
        : { error: `Unknown tool: ${toolCall.name}` };
    } catch (err) {
      toolResult = { error: err instanceof Error ? err.message : String(err) };
    }

    const toolResultStr = JSON.stringify(toolResult, null, 2);
    addTurn(conv.id, 'tool_result', null, toolCall.name, undefined, toolResultStr);

    // Feed tool result back — always use --resume now since we have a session
    stdinContent = `<tool_result name="${toolCall.name}">\n${toolResultStr}\n</tool_result>`;
  }

  addTurn(conv.id, 'assistant', 'Tool call limit reached. Please try a more specific request.');
  return 'Tool call limit reached. Please try a more specific request.';
}
