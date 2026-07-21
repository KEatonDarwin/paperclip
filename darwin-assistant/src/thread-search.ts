import { runClaude } from './agent.js';
import { getTurns, type ConversationRow } from './conversation-db.js';
import { getLatestThreadSummary } from './thread-summaries.js';

// DAR-741 — AI-mediated natural-language search over cockpit threads. Kevin
// describes what he's looking for in a free-form paragraph (not keywords);
// the model reads a compact corpus (title + latest summary + a couple of
// recent messages per thread) and picks the threads that actually match.

export interface ThreadSearchResult {
  thread_id: string;
  reason: string;
}

function threadSnippet(conv: ConversationRow): string {
  const summary = getLatestThreadSummary(conv.id)?.content;
  if (summary) return summary.slice(0, 500);
  // No summary yet — fall back to the last couple of real messages so a
  // fresh/short thread is still searchable.
  const turns = getTurns(conv.id).filter((t) => t.role === 'user' || t.role === 'assistant');
  return turns
    .slice(-4)
    .map((t) => `${t.role}: ${(t.content ?? '').slice(0, 300)}`)
    .join('\n')
    .slice(0, 800);
}

const SEARCH_PROMPT = (query: string, corpus: string) => `Kevin is searching his JARVIS cockpit threads by describing what he's looking for in his own words, not exact keywords. Read his query and the list of threads below, then pick the threads that actually match what he's describing.

Query:
"""
${query}
"""

Threads (thread_id, title, then a content snippet):
${corpus}

Respond with ONLY a JSON array, no prose, no markdown fences. Most relevant first, at most 5 entries. Each entry: {"thread_id": "<the exact thread_id from above>", "reason": "<one short sentence on why this matches>"}. If nothing genuinely matches, respond with [].`;

function extractJsonArray(text: string): unknown[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) throw new Error('No JSON array found in search response');
  const parsed = JSON.parse(raw.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error('Search response JSON was not an array');
  return parsed;
}

export async function searchThreadsByQuery(
  query: string,
  candidates: ConversationRow[],
): Promise<ThreadSearchResult[]> {
  if (!candidates.length) return [];

  const corpus = candidates
    .map((c) => `- thread_id: ${c.external_id}\n  title: ${c.title ?? '(untitled)'}\n  snippet: ${threadSnippet(c).replace(/\n/g, ' ') || '(no messages yet)'}`)
    .join('\n');

  const result = await runClaude(SEARCH_PROMPT(query, corpus), null);
  const parsed = extractJsonArray(result.text);
  const validIds = new Set(candidates.map((c) => c.external_id));

  return parsed
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({ thread_id: String(e.thread_id ?? ''), reason: String(e.reason ?? '') }))
    .filter((e) => validIds.has(e.thread_id))
    .slice(0, 5);
}
