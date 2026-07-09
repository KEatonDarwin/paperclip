import { runClaude } from './agent.js';
import { createIssueDirect } from './tools/paperclip.js';
import { type NoteRow, markNoteTriaged, markNoteError } from './notes-db.js';

// DAR-701 — triage a quick-capture note in the background: ask the model
// whether it's a concrete feature request (file a Paperclip issue) or a
// passing idea (leave a short researched take instead). One-off call —
// sessionId null so it doesn't join/pollute any real conversation.

const TRIAGE_PROMPT = (content: string) => `You are triaging a quick-capture note Kevin dictated into the JARVIS cockpit. Decide whether it is:

- "feature": a concrete, buildable feature/task request (e.g. "I need dark/light mode support", "server-side thread search by content"). These get filed as a Paperclip issue and built like a normal directive.
- "idea": a passing thought/musing (e.g. "it'd be cool if..."). These get a short researched take instead of being built immediately.

Note content:
"""
${content}
"""

Respond with ONLY a JSON object, no prose, no markdown fences:
- If "feature": {"kind": "feature", "title": "<short clear task title>", "description": "<fuller description with context for a builder>"}
- If "idea": {"kind": "idea", "feedback": "<2-4 sentence researched take: is this worth pursuing, what's the tradeoff, any prior art>"}`;

function extractJson(text: string): Record<string, unknown> {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) throw new Error('No JSON object found in triage response');
  return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
}

export async function triageNote(note: NoteRow): Promise<void> {
  try {
    const result = await runClaude(TRIAGE_PROMPT(note.content), null);
    const parsed = extractJson(result.text);

    if (parsed.kind === 'feature') {
      const title = String(parsed.title ?? note.content.slice(0, 80));
      const description = String(parsed.description ?? note.content);
      const issue = await createIssueDirect({
        title,
        description,
        originalAsk: `Captured via cockpit quick-capture: "${note.content}"`,
      });
      markNoteTriaged(note.id, {
        kind: 'feature',
        outcomeSummary: `Filed as ${issue.identifier}: ${title}`,
        issueIdentifier: issue.identifier,
        issueId: issue.id,
      });
    } else if (parsed.kind === 'idea') {
      const feedback = String(parsed.feedback ?? 'No feedback generated.');
      markNoteTriaged(note.id, { kind: 'idea', outcomeSummary: feedback });
    } else {
      throw new Error(`Unrecognized triage kind: ${JSON.stringify(parsed.kind)}`);
    }
  } catch (err) {
    markNoteError(note.id, err instanceof Error ? err.message : String(err));
  }
}
