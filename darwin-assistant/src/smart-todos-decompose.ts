// SMART TODO decompose — turn a jotted note into a main idea + nested subitems.
//
// Kevin types one line ("call the roofer") or a whole paragraph explaining a
// build; this breaks it into a titled main idea and an arbitrarily-nested tree
// of subitems, which insertSmartTodoTree() drops into place. The raw note is
// kept verbatim on the root (original_prompt) so it's always recoverable.
//
// Single `claude` CLI call — NO ANTHROPIC_API_KEY (see the NO API KEYS rule in
// JARVIS memory), mirroring jarvis-brief.ts / briefing.ts.

import { execFile } from 'node:child_process';
import { extractJsonObject } from './tools/ux-reviewer/vision-critique.js';

const CLAUDE_BIN = process.env.UX_REVIEWER_CLAUDE_BIN || 'claude';
const CLAUDE_TIMEOUT_MS = 60 * 1000;

export interface DecomposedNode {
  title: string;
  notes?: string | null;
  children?: DecomposedNode[];
}

function runClaudeOneShot(prompt: string): Promise<string> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return new Promise((resolve, reject) => {
    execFile(
      CLAUDE_BIN,
      ['-p', prompt, '--output-format', 'json'],
      { timeout: CLAUDE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error(`claude decompose call failed: ${err.message}${stderr ? ` | ${stderr.slice(0, 300)}` : ''}`));
          return;
        }
        try {
          const envelope = JSON.parse(stdout.trim()) as { result?: string };
          resolve(typeof envelope.result === 'string' ? envelope.result : stdout);
        } catch {
          resolve(stdout);
        }
      },
    );
  });
}

function buildPrompt(note: string): string {
  return [
    'You are helping Kevin organize a jotted note into a smart todo tree.',
    '',
    'He typed the note below. It might be a single simple idea ("call the roofer"),',
    'or a whole paragraph describing something with many parts. Turn it into:',
    '  - a concise MAIN IDEA (the top-level title — what this whole item is about), and',
    '  - a set of nested SUBITEMS that break the idea into concrete pieces, only where',
    '    the note actually contains distinct parts. Nest subitems under each other when',
    "    one is genuinely a part of another. Don't invent scope that isn't in the note.",
    '',
    'Rules:',
    '- If the note is just one simple thing, return the main idea with NO children (or one or two at most).',
    '- Keep every title short and action/outcome shaped (a few words), not a sentence.',
    "- Preserve any real detail the note gives that doesn't fit in a title by putting it",
    "  in that node's optional \"notes\" field. Don't pad; omit notes when there's nothing extra.",
    '- Nest as deep as the note warrants; there is no depth limit.',
    '',
    '=== KEVIN\'S NOTE ===',
    note,
    '=== END NOTE ===',
    '',
    'Return ONLY a JSON object — no markdown fences, no prose before or after — with EXACTLY this shape:',
    '{',
    '  "title": "main idea",',
    '  "notes": "optional extra detail for the main idea, or omit",',
    '  "children": [',
    '    { "title": "subitem", "notes": "optional", "children": [ { "title": "deeper subitem" } ] }',
    '  ]',
    '}',
    'children may be an empty array. Every node MUST have a non-empty "title".',
  ].join('\n');
}

function sanitize(node: unknown, depth = 0): DecomposedNode | null {
  if (depth > 12 || !node || typeof node !== 'object') return null;
  const n = node as Record<string, unknown>;
  const title = typeof n.title === 'string' ? n.title.trim() : '';
  if (!title) return null;
  const notes = typeof n.notes === 'string' && n.notes.trim() ? n.notes.trim() : null;
  const rawChildren = Array.isArray(n.children) ? n.children : [];
  const children = rawChildren
    .map((c) => sanitize(c, depth + 1))
    .filter((c): c is DecomposedNode => c !== null);
  return { title: title.slice(0, 500), notes, children };
}

/** Decompose a raw note into a main idea + nested subitems. Falls back to a
 *  single-node tree (the note as the title) if the model call/parse fails, so a
 *  jot NEVER gets lost just because decomposition hiccuped. */
export async function decomposeNote(note: string): Promise<DecomposedNode> {
  const trimmed = note.trim();
  const fallback: DecomposedNode = {
    title: trimmed.slice(0, 120) || 'Untitled',
    notes: trimmed.length > 120 ? trimmed : null,
    children: [],
  };
  try {
    const raw = await runClaudeOneShot(buildPrompt(trimmed));
    const parsed = extractJsonObject(raw);
    const clean = sanitize(parsed);
    return clean ?? fallback;
  } catch {
    return fallback;
  }
}
