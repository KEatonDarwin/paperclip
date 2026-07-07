// Reduces a turn's raw `claude --output-format stream-json` NDJSON (already
// persisted per-turn as `claude_output`) into an ordered list of steps for the
// cockpit's Details-view timeline: thinking / narration text / the embedded
// tool-call block, in the order the model actually produced them.
//
// This is exposure-only — no new data is captured, no schema change. The raw
// stream was already being persisted (see agent.ts claudeMeta.claudeOutput);
// nothing derived it into a structured shape until now, so a page refresh had
// no way to reconstruct "thinking" beyond the single flattened turn.content.
//
// JARVIS doesn't hand the CLI native tool definitions, so there are no native
// `tool_use`/`tool_result` blocks in the stream (unlike a stock Claude Code
// session) — tool calls are a plain-text `<tool_call>{...}</tool_call>` convention
// embedded inside a `text` block, parsed by agent.ts's parseToolCall. We split
// that back out here so the timeline can render it as its own step.

export type TurnStep =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; name: string; arguments: unknown };

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
}

interface ClaudeStreamLine {
  type?: string;
  message?: { content?: ClaudeContentBlock[] };
}

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/;

function splitEmbeddedToolCall(text: string): TurnStep[] {
  const match = text.match(TOOL_CALL_RE);
  if (!match) return text ? [{ kind: 'text', text }] : [];

  const before = text.slice(0, match.index ?? 0).trim();
  const after = text.slice((match.index ?? 0) + match[0].length).trim();
  const steps: TurnStep[] = [];
  if (before) steps.push({ kind: 'text', text: before });
  try {
    const parsed = JSON.parse(match[1]) as { name: string; arguments: unknown };
    if (typeof parsed.name === 'string') {
      steps.push({ kind: 'tool_call', name: parsed.name, arguments: parsed.arguments });
    }
  } catch {
    // Malformed tool-call JSON: fall back to showing it as plain text rather
    // than silently dropping it.
    steps.push({ kind: 'text', text: match[0] });
  }
  if (after) steps.push({ kind: 'text', text: after });
  return steps;
}

/**
 * Parse a turn's raw NDJSON stream into an ordered list of steps. Returns
 * `null` when there's nothing to parse (older turns predating claude_output
 * capture, or non-assistant turns) so callers can omit the field entirely.
 */
export function parseTurnSteps(rawOutput: string | null | undefined): TurnStep[] | null {
  if (!rawOutput) return null;

  const merged: TurnStep[] = [];
  const pushText = (kind: 'thinking' | 'text', text: string) => {
    const tail = merged[merged.length - 1];
    if (tail && tail.kind === kind) tail.text += text;
    else merged.push({ kind, text } as TurnStep);
  };

  for (const line of rawOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: ClaudeStreamLine;
    try {
      event = JSON.parse(trimmed) as ClaudeStreamLine;
    } catch {
      continue;
    }
    if (event.type !== 'assistant') continue;
    const blocks = event.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block.type === 'thinking' && typeof block.thinking === 'string') {
        pushText('thinking', block.thinking);
      } else if (block.type === 'text' && typeof block.text === 'string') {
        pushText('text', block.text);
      }
    }
  }

  if (!merged.length) return null;

  // The tool-call convention is plain text embedded in a `text` block, so it
  // only ever needs splitting out of `text` steps, never `thinking` steps.
  const steps: TurnStep[] = [];
  for (const step of merged) {
    if (step.kind === 'text') steps.push(...splitEmbeddedToolCall(step.text));
    else steps.push(step);
  }
  return steps.length ? steps : null;
}
