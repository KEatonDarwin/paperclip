import type { ToolDef } from './index.js';
import { recall, type RecallSource } from '../recall.js';

const VALID_SOURCES: RecallSource[] = [
  'thread_summary',
  'thread_title',
  'turn',
  'tree',
  'goal',
  'workstream',
  'wiki',
  'auto_memory',
];

// SHARED CONTEXT v0 §2 — search what JARVIS/Kevin have already done in OTHER
// threads/trees/goals/workstreams/the wiki/auto-memory, before asking Kevin
// where something lives. See skills/shared-context/SKILL.md.
export const recallTool: ToolDef = {
  name: 'recall',
  description:
    'Search what JARVIS and Kevin have already done or decided in OTHER threads, trees, goals, workstreams, the wiki and JARVIS\'s auto-memory — before asking Kevin where something lives or what happened. Keyword search (all terms must match), ranked, ≤ 12 hits, each with source + ref (thread ext id / tree id / path) + snippet + when. Cite the ref when you use a hit.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search terms, e.g. "MBI ledger" or "governor ceiling".' },
      days: { type: 'number', description: 'Turn-history lookback window in days. Default 30. Only bounds the "turn" source.' },
      limit: { type: 'number', description: 'Max hits to return. Default 12, max 50.' },
      sources: {
        type: 'array',
        items: { type: 'string', enum: VALID_SOURCES },
        description: 'Restrict to a subset of sources. Omit to search all: thread_summary, thread_title, turn, tree, goal, workstream, wiki, auto_memory.',
      },
    },
    required: ['query'],
  },
  execute: async (args) => {
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query.trim()) return { error: 'query is required' };
    const days = typeof args.days === 'number' ? args.days : undefined;
    const limit = typeof args.limit === 'number' ? args.limit : undefined;
    const sourcesRaw = Array.isArray(args.sources) ? (args.sources as unknown[]) : undefined;
    const sources = sourcesRaw
      ? sourcesRaw.filter((s): s is RecallSource => typeof s === 'string' && (VALID_SOURCES as string[]).includes(s))
      : undefined;
    try {
      return recall(query, { days, limit, sources });
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  },
};
