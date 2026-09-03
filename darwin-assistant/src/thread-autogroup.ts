import { spawn } from 'node:child_process';
import {
  setThreadGroup,
  type ConversationRow,
} from './conversation-db.js';
import {
  createGroup,
  listGroups,
  type ConversationGroupRow,
} from './conversation-groups.js';

const AUTO_CREATE_GROUPS = false;
const AUTO_GROUP_MODEL = 'claude-haiku-4-5-20251001';
const AUTO_GROUP_TIMEOUT_MS = 45_000;
const MIN_CONFIDENCE = 0.78;

interface AutoGroupChoice {
  group_id: number | null;
  confidence?: number;
  new_group_name?: string | null;
}

function isEligibleConversation(conv: ConversationRow): boolean {
  if (conv.group_id !== null) return false;
  if (conv.is_group_chat) return false;

  const externalId = conv.external_id.toLowerCase();
  if (externalId.startsWith('quick:')) return false;
  if (externalId.startsWith('ephemeral:')) return false;
  if (externalId.startsWith('checkin:')) return false;
  if (externalId.startsWith('cockpit:group:')) return false;

  return true;
}

function buildPrompt(firstMessage: string, groups: ConversationGroupRow[]): string {
  const groupLines = groups
    .map((group) => `- id: ${group.id}; name: ${group.name}; color: ${group.color ?? 'none'}`)
    .join('\n');

  return `Classify a new JARVIS cockpit thread into exactly one existing topic group, if there is a clear match.

Existing groups:
${groupLines || '(none)'}

First message:
"""
${firstMessage}
"""

Rules:
- Prefer leaving the thread ungrouped over a weak guess.
- Match by durable topic/project, not by generic verbs like debug, fix, build, question, or research.
- Return an existing group id only when the first message clearly belongs in that folder.
- Use confidence from 0.0 to 1.0.
- If no existing group matches but the message has a strong nameable topic, include new_group_name. Otherwise set it to null.
- Respond with ONLY compact JSON, no markdown.

Schema:
{"group_id": number|null, "confidence": number, "new_group_name": string|null}`;
}

function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

function parseChoice(raw: string): AutoGroupChoice | null {
  const json = extractJsonObject(raw);
  if (!json) return null;

  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const groupId = parsed.group_id;
    const confidence = parsed.confidence;
    const newGroupName = parsed.new_group_name;

    return {
      group_id: typeof groupId === 'number' && Number.isInteger(groupId) ? groupId : null,
      confidence: typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : undefined,
      new_group_name:
        typeof newGroupName === 'string' && newGroupName.trim()
          ? newGroupName.trim().slice(0, 80)
          : null,
    };
  } catch {
    return null;
  }
}

async function runClaudeClassifier(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const child = spawn(
      process.env.CLAUDE_CLI_PATH || 'claude',
      ['--print', '-', '--output-format', 'stream-json', '--model', AUTO_GROUP_MODEL],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`auto-group claude classifier timed out after ${AUTO_GROUP_TIMEOUT_MS}ms`));
    }, AUTO_GROUP_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`auto-group claude classifier exited ${code}: ${stderr.trim()}`));
        return;
      }

      let text = '';
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          const message = event.message as Record<string, unknown> | undefined;
          const content = message?.content;
          if (event.type === 'assistant' && Array.isArray(content)) {
            for (const block of content as Array<Record<string, unknown>>) {
              if (block.type === 'text' && typeof block.text === 'string') text += block.text;
            }
          }
          if (event.type === 'result' && typeof event.result === 'string') {
            text = event.result;
          }
        } catch {
          text += trimmed;
        }
      }
      resolve(text.trim());
    });

    child.stdin.end(prompt);
  });
}

function groupExists(groups: ConversationGroupRow[], groupId: number | null): boolean {
  return groupId !== null && groups.some((group) => group.id === groupId);
}

function normalizeNewGroupName(name: string | null | undefined): string | null {
  const cleaned = name?.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  if (cleaned.length < 3) return null;
  return cleaned.slice(0, 80);
}

export async function autoGroupThreadFromFirstMessage(
  conv: ConversationRow,
  firstMessage: string,
): Promise<void> {
  try {
    if (!isEligibleConversation(conv)) return;

    const groups = listGroups();
    if (!groups.length && !AUTO_CREATE_GROUPS) return;

    const raw = await runClaudeClassifier(buildPrompt(firstMessage, groups));
    const choice = parseChoice(raw);
    if (!choice) return;

    const confidence = choice.confidence ?? 0;
    if (confidence < MIN_CONFIDENCE) return;

    if (groupExists(groups, choice.group_id)) {
      setThreadGroup(conv.id, choice.group_id);
      return;
    }

    const newGroupName = normalizeNewGroupName(choice.new_group_name);
    if (AUTO_CREATE_GROUPS && newGroupName) {
      const { group } = createGroup(newGroupName);
      setThreadGroup(conv.id, group.id);
    }
  } catch (err) {
    console.error(`[thread-autogroup] failed for conversation ${conv.id}:`, err);
  }
}
