import { spawn } from 'node:child_process';
import {
  isTopicEligible,
  listTopics,
  listConversationsForTopicDetailed,
  type TopicRow,
} from './chat-topics-store.js';

// tree-c9800208 node #1580 — the duplicate-open nudge's overlap matcher.
// Cheap-first: a plain substring match against existing topic labels, so the
// common case never spawns a process. Only on a miss do we ask the
// subscription haiku CLI (same one-shot spawn shape as chat-topics-derive.ts
// / thread-autogroup.ts — no API key), under a hard timeout. This backs a
// live "about to open a new chat" check, so it must never hang the caller:
// any bad input, timeout, or parse failure resolves to [], never a throw.

const OVERLAP_MODEL = 'claude-haiku-4-5-20251001';
const OVERLAP_TIMEOUT_MS = 8_000;
const RECENT_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CANDIDATES = 3;
const MAX_EXISTING_LABELS = 50;

export interface OverlapCandidate {
  external_id: string;
  title: string | null;
  updated_at: string;
  matched_label: string;
}

function cheapLabelMatch(text: string, labels: TopicRow[]): TopicRow | null {
  const haystack = text.toLowerCase();
  for (const topic of labels) {
    const label = topic.label.trim().toLowerCase();
    if (label && haystack.includes(label)) return topic;
  }
  return null;
}

function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

function parseLabelChoice(raw: string): string | null {
  const json = extractJsonObject(raw);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const label = parsed.label;
    return typeof label === 'string' && label.trim() ? label.trim() : null;
  } catch {
    return null;
  }
}

function buildOverlapPrompt(text: string, labels: TopicRow[]): string {
  const labelLines = labels.map((l) => `- ${l.label}`).join('\n');
  return `A new chat window is about to be opened with this message:
"""
${text.trim().slice(0, 2000)}
"""

Existing topic labels:
${labelLines || '(none)'}

Does this message CLEARLY concern the same subject as one of the existing labels? If yes, respond with that EXACT label text. If there's no clear match, respond with null.

Respond with ONLY compact JSON, no markdown, no prose.

Schema: {"label": string|null}`;
}

function runOverlapClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;

    const child = spawn(
      process.env.CLAUDE_CLI_PATH || 'claude',
      // --verbose is required alongside --print + stream-json (see thread-autogroup.ts).
      ['--print', '-', '--output-format', 'stream-json', '--verbose', '--model', OVERLAP_MODEL],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`chat-topics-overlap claude call timed out after ${OVERLAP_TIMEOUT_MS}ms`));
    }, OVERLAP_TIMEOUT_MS);
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
        reject(new Error(`chat-topics-overlap claude call exited ${code}: ${stderr.trim()}`));
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

    // The child may exit before reading stdin — without a listener that
    // write's EPIPE is an unhandled 'error' event (see chat-topics-derive.ts).
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

async function modelLabelMatch(text: string, labels: TopicRow[]): Promise<TopicRow | null> {
  if (labels.length === 0) return null;
  let raw: string;
  try {
    raw = await runOverlapClaude(buildOverlapPrompt(text, labels));
  } catch (err) {
    console.error('[chat-topics-overlap] claude call failed, treating as no match:', err);
    return null;
  }
  const chosen = parseLabelChoice(raw);
  if (!chosen) return null;
  return labels.find((l) => l.label.toLowerCase() === chosen.toLowerCase()) ?? null;
}

/**
 * The duplicate-open nudge's matcher: given the text about to seed a new
 * chat, finds up to 3 recent eligible cockpit chats that share a topic with
 * it (excluding `excludeExternalId`), newest first. Cheap substring match
 * against existing topic labels first; only on a miss does it ask the haiku
 * CLI, under a hard timeout. Never throws — any failure (empty input, model
 * timeout, malformed output) resolves to [].
 */
export async function findOverlapCandidates(
  text: string,
  excludeExternalId: string | null,
): Promise<OverlapCandidate[]> {
  try {
    if (!text || !text.trim()) return [];
    const labels = listTopics({ limit: MAX_EXISTING_LABELS });
    if (labels.length === 0) return [];

    const matched = cheapLabelMatch(text, labels) ?? (await modelLabelMatch(text, labels));
    if (!matched) return [];

    const cutoff = Date.now() - RECENT_MS;
    const rows = listConversationsForTopicDetailed(matched.id)
      .filter((c) => c.external_id !== excludeExternalId)
      .filter((c) => isTopicEligible(c.external_id))
      .filter((c) => {
        // sqlite datetime('now') is space-separated UTC with no zone suffix.
        const ms = Date.parse(`${c.updated_at.replace(' ', 'T')}Z`);
        return Number.isFinite(ms) && ms >= cutoff;
      })
      .slice(0, MAX_CANDIDATES);

    return rows.map((c) => ({
      external_id: c.external_id,
      title: c.title,
      updated_at: c.updated_at,
      matched_label: matched.label,
    }));
  } catch (err) {
    console.error('[chat-topics-overlap] unexpected failure, returning no candidates:', err);
    return [];
  }
}
