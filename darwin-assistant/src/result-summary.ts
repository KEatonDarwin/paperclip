import { summarizeForLayman } from './layman-summary.js';

// Readable node results (tree-bf5f54d9): turns a hopper node's raw `result`
// text into a short layman summary. Kevin's ask (2026-09-27): the detailed
// result is important and stays intact, but the default view should be a
// plain-English sentence or two, with the long form behind a "details" click.
//
// Generalized (tree-9e15d8a7, layman layer everywhere): this now delegates to
// layman-summary.ts's summarizeForLayman with kind 'node_result' — same
// prompt framing, same claude CLI one-shot, same sim guard, same never-throws
// contract. This file stays as the hopper-node-specific entry point so
// hopper-engine.ts's call site and behavior are unchanged.

export interface SummarizeNodeResultInput {
  title: string;
  outcome: string;
  resultText: string;
}

/** Generates a layman summary via the subscription claude CLI. Never throws —
 *  any failure (timeout, missing CLI, bad output) resolves to null so callers
 *  can just leave result_summary unset. */
export async function summarizeNodeResult(input: SummarizeNodeResultInput): Promise<string | null> {
  return summarizeForLayman({
    kind: 'node_result',
    title: input.title,
    outcome: input.outcome,
    text: input.resultText,
  });
}
