import type { ToolDef } from './index.js';
import { insertJarvisDecision, serializeDecision, type DecidedBy } from '../jarvis-decisions.js';

// DAR-676 Decision Ledger. JARVIS calls this whenever it makes (or would have
// escalated) a choice it would previously have surfaced to Kevin as a question
// or multiple-choice — including the ones it now decides itself under the
// autonomy directive. This is the paper trail that makes higher autonomy safe.
export const logDecision: ToolDef = {
  name: 'log_decision',
  description:
    'Record a decision in the JARVIS Decision Ledger. Call this every time you make a choice — or would have asked Kevin a question / offered a multiple-choice — including choices you now decide yourself under the autonomy directive. Captures the question, the options considered, who decided (kevin or jarvis), the decision made, and the rationale. This is the audit trail Kevin uses to see which decisions needed making and why.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'The question or choice that came up, phrased the way you would have asked Kevin.',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'The options that were considered.',
      },
      decided_by: {
        type: 'string',
        enum: ['kevin', 'jarvis'],
        description: 'Who ultimately decided. Use "jarvis" when you decided it yourself, "kevin" when he did.',
        default: 'jarvis',
      },
      decision: {
        type: 'string',
        description: 'The decision that was ultimately made.',
      },
      rationale: {
        type: 'string',
        description: 'Why this decision was made (the reasoning).',
      },
      related_issue: {
        type: 'string',
        description: 'Optional Paperclip issue identifier this decision relates to (e.g. DAR-676).',
      },
    },
    required: ['question', 'decision'],
  },
  execute: async (args, context) => {
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    const decision = typeof args.decision === 'string' ? args.decision.trim() : '';
    if (!question || !decision) {
      return { error: 'question and decision are both required' };
    }
    const decidedByRaw = typeof args.decided_by === 'string' ? args.decided_by.toLowerCase() : 'jarvis';
    const decidedBy: DecidedBy = decidedByRaw === 'kevin' ? 'kevin' : 'jarvis';
    const options = Array.isArray(args.options)
      ? args.options.map((o) => String(o)).filter((o) => o.trim())
      : null;
    const row = insertJarvisDecision(
      {
        question,
        options,
        decidedBy,
        decision,
        rationale: typeof args.rationale === 'string' ? args.rationale.trim() || null : null,
        relatedIssue: typeof args.related_issue === 'string' ? args.related_issue.trim() || null : null,
      },
      context,
    );
    return { ok: true, decision: serializeDecision(row) };
  },
};
