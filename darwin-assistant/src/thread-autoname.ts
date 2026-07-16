import { runClaude } from './agent.js';
import { autoNameConversation, type ConversationRow } from './conversation-db.js';

// DAR-726 — generate a short, ChatGPT/Claude.ai-style thread title from the
// first message a thread ever receives. One-off call — sessionId null so it
// doesn't join/pollute any real conversation.

const AUTO_NAME_PROMPT = (message: string) => `Generate a short title for a chat thread, based on its first message. The title should read like a conversation topic, not a command (e.g. "Debugging Postgres connection pool" not "Debug the Postgres connection pool").

Rules:
- 3-6 words.
- No trailing punctuation, no quotes, no markdown.
- Plain title case, no prefixes like "Title:".

First message:
"""
${message}
"""

Respond with ONLY the title, nothing else.`;

function cleanTitle(raw: string): string | null {
  const t = raw
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/^title:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length ? t.slice(0, 200) : null;
}

/** Fire-and-forget: generate and store a title for `conv` from its first message. */
export async function autoNameThreadFromFirstMessage(conv: ConversationRow, firstMessage: string): Promise<void> {
  try {
    const result = await runClaude(AUTO_NAME_PROMPT(firstMessage), null);
    const title = cleanTitle(result.text);
    if (title) autoNameConversation(conv.id, title);
  } catch (err) {
    console.error(`[thread-autoname] failed for conversation ${conv.id}:`, err);
  }
}
