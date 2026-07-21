import { runClaude } from './agent.js';
import { getTurns, type ConversationRow, type TurnRow } from './conversation-db.js';
import { createThreadSummary, type ThreadSummaryRow } from './thread-summaries.js';

// DAR-740 — generate a point-in-time "what's done / in progress / next"
// summary of a thread, anchored to the last turn that existed when
// generation started. One-off runClaude call, sessionId null, same pattern
// as thread-autoname.ts's title generation — doesn't join/pollute the real
// conversation session.

const ASSISTANT_CAP = 4000;

function renderTranscript(turns: TurnRow[]): string {
  const convo = turns.filter((t) => t.role === 'user' || t.role === 'assistant');
  return convo
    .map((t) => {
      const who = t.role === 'user' ? 'User' : 'JARVIS';
      let body = t.content ?? '';
      if (t.role === 'assistant' && body.length > ASSISTANT_CAP) {
        body = body.slice(0, ASSISTANT_CAP) + ' …[truncated]';
      }
      return `**${who}:** ${body}`;
    })
    .join('\n\n');
}

const SUMMARY_PROMPT = (transcript: string) => `Summarize the following conversation/work thread as of right now, for someone picking it back up later. Cover exactly three things, each as a short bulleted list:

## Done
## In Progress
## Planned Next

Be concise and concrete — reference specific things discussed or built, not generic statements. Markdown only, no preamble, no closing remarks.

Thread transcript so far:
"""
${transcript}
"""`;

export async function generateThreadSummary(conv: ConversationRow): Promise<ThreadSummaryRow> {
  const turns = getTurns(conv.id);
  const lastTurn = turns[turns.length - 1] ?? null;
  const transcript = renderTranscript(turns);
  const result = await runClaude(SUMMARY_PROMPT(transcript || '(no messages yet)'), null);
  const content = result.text.trim() || '_Nothing to summarize yet._';
  return createThreadSummary(conv.id, content, lastTurn?.id ?? null, lastTurn?.turn_index ?? 0);
}
