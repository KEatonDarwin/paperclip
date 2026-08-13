import { runClaude } from './agent.js';
import { getTurns, type ConversationRow } from './conversation-db.js';
import type { TurnRow } from './conversation-db.js';

const CHUNK_CHARS = 40_000;
const ASSISTANT_CAP = 6_000;

function renderTurn(t: TurnRow): string {
  const who = t.role === 'user' ? 'Kevin' : 'JARVIS';
  let body = t.content ?? '';
  if (t.role === 'assistant' && body.length > ASSISTANT_CAP) {
    body = body.slice(0, ASSISTANT_CAP) + ' …[truncated]';
  }
  return `**${who}:** ${body}`;
}

function chunkTranscript(turns: TurnRow[]): string[] {
  const convo = turns.filter((t) => t.role === 'user' || t.role === 'assistant');
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const t of convo) {
    const rendered = renderTurn(t);
    if (size + rendered.length > CHUNK_CHARS && current.length) {
      chunks.push(current.join('\n\n'));
      current = [];
      size = 0;
    }
    current.push(rendered);
    size += rendered.length + 2;
  }
  if (current.length) chunks.push(current.join('\n\n'));
  return chunks;
}

const CHUNK_PROMPT = (part: number, total: number, transcript: string) =>
  `You are condensing part ${part} of ${total} of a long working conversation so it can be handed to a different AI model that has never seen it.

Extract everything that still matters and drop everything that doesn't. Keep: decisions made, requirements and constraints, file paths, function/table/endpoint names, commands, IDs, ticket numbers, code snippets that are still relevant, open questions, and anything explicitly pinned as a rule. Drop: pleasantries, retries, abandoned approaches, tool-call noise, and anything superseded later.

Output dense markdown bullets only — no preamble, no closing remarks, no headings.

Transcript part ${part}/${total}:
"""
${transcript}
"""`;

const MERGE_PROMPT = (digests: string) =>
  `Below are ordered notes condensed from consecutive parts of one long working conversation. Merge them into a SINGLE handoff context block for a different AI model that has never seen the conversation.

Deduplicate, resolve contradictions in favour of the LATER notes, and preserve every concrete detail (file paths, names, commands, IDs, decisions, constraints, pinned rules). Use exactly these headings, omitting any that would be empty:

## Objective
## Key Decisions & Constraints
## Technical Context
## Work Completed
## In Progress
## Open Questions
## Next Steps

Markdown only, no preamble, no closing remarks.

Notes:
"""
${digests}
"""`;

const SINGLE_PROMPT = (transcript: string) =>
  `Condense the following working conversation into a SINGLE handoff context block for a different AI model that has never seen it.

Preserve every concrete detail that still matters (file paths, function/table/endpoint names, commands, IDs, ticket numbers, decisions, constraints, pinned rules, relevant code). Drop pleasantries, retries, abandoned approaches and tool-call noise. Use exactly these headings, omitting any that would be empty:

## Objective
## Key Decisions & Constraints
## Technical Context
## Work Completed
## In Progress
## Open Questions
## Next Steps

Markdown only, no preamble, no closing remarks.

Transcript:
"""
${transcript}
"""`;

/** Condense a whole thread (any size) into one markdown context block. */
export async function condenseThread(conv: ConversationRow): Promise<string> {
  const chunks = chunkTranscript(getTurns(conv.id));
  if (chunks.length === 0) return '_The source thread had no messages._';
  if (chunks.length === 1) {
    const result = await runClaude(SINGLE_PROMPT(chunks[0]), null);
    return result.text.trim() || '_Nothing substantive to carry over._';
  }
  const digests: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const result = await runClaude(CHUNK_PROMPT(i + 1, chunks.length, chunks[i]), null);
    const text = result.text.trim();
    if (text) digests.push(`### Part ${i + 1} of ${chunks.length}\n\n${text}`);
  }
  if (!digests.length) return '_Nothing substantive to carry over._';
  const merged = await runClaude(MERGE_PROMPT(digests.join('\n\n')), null);
  return merged.text.trim() || digests.join('\n\n');
}

export function buildSmartForkMessage(
  conv: ConversationRow,
  condensed: string,
  modelLabel: string,
): string {
  const sourceTitle = conv.title ?? conv.external_id;
  return [
    `This is a **Smart Fork** of an existing conversation — a fresh thread running on **${modelLabel}**, picking up work that was happening elsewhere.`,
    '',
    `You have no session history here. Everything that happened in the original thread ("${sourceTitle}", \`${conv.external_id}\`) has been condensed into the context block below. Treat it as your memory of that conversation: the decisions, constraints and pinned rules in it are already agreed and still binding.`,
    '',
    'Read it, confirm briefly that you have the picture, and be ready to continue from the "Next Steps" section. Do not redo work listed as completed.',
    '',
    '---',
    '',
    condensed,
    '',
    '---',
    '',
    '_End of carried-over context. Awaiting next instruction._',
  ].join('\n');
}
