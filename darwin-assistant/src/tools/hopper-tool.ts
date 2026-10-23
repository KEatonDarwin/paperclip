import type { ToolDef } from './index.js';
import { createHopperItem, listHopperItems } from '../hopper.js';

// The TASK HOPPER — JARVIS drops a CANDIDATE task here when something looks like
// a task Kevin might want done but the ask is ambiguous (an inbound coworker
// message like "Kevin can you handle X?", a note, a half-formed request). It
// does NOT start the work — it queues the candidate for Kevin's one-click review
// in his standalone hopper window (Yes / Yes-but / Dismiss). Use this INSTEAD of
// spawning a thread when you're not certain it's a real task, or which task
// exactly. If Kevin clearly said "handle this" and you have the context, just do
// the work directly — don't hopper it.
export const hopper: ToolDef = {
  name: 'hopper',
  description:
    "Drop a CANDIDATE task into Kevin's Task Hopper for his one-click review (Yes / Yes-but / Dismiss). Use this when an inbound message or note MIGHT be a task Kevin wants done but it's ambiguous — you queue it, you do NOT start it. (If Kevin clearly asked you to handle something and you have the context, just do the work; don't hopper it.) Operations: 'file' (queue a candidate — needs title; optional summary, source, source_ref, raw_message, suggested_model), 'list' (pending candidates).",
  parameters: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['file', 'list'], description: 'What to do.' },
      title: { type: 'string', description: 'Short task title (what Kevin would be agreeing to). Required for file.' },
      summary: { type: 'string', description: 'Optional 1-2 line description of the task / what it entails.' },
      source: { type: 'string', description: "Where it came from: 'teams', 'slack', 'jarvis', 'manual', etc." },
      source_ref: { type: 'string', description: 'Who/where specifically (person name, channel, thread).' },
      raw_message: { type: 'string', description: 'The original message text verbatim, if any.' },
      suggested_model: { type: 'string', description: 'Optional model hint if the task looks hard (e.g. a heavier model).' },
    },
    required: ['operation'],
  },
  execute: async (args) => {
    const op = typeof args.operation === 'string' ? args.operation : '';
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

    if (op === 'list') {
      return { items: listHopperItems('pending') };
    }
    if (op === 'file') {
      const title = str(args.title);
      if (!title) return { error: 'file needs a title' };
      const item = createHopperItem({
        title: title.slice(0, 300),
        summary: str(args.summary),
        source: str(args.source),
        source_ref: str(args.source_ref),
        raw_message: str(args.raw_message),
        suggested_model: str(args.suggested_model),
      });
      return { ok: true, item };
    }
    return { error: `unknown operation: ${op || '(none)'}` };
  },
};
