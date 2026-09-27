import { spawn } from 'node:child_process';
import { refuseModelTurnInScratch } from './sim-guard.js';

// Readable node results (tree-bf5f54d9): turns a hopper node's raw `result`
// text into a short layman summary. Kevin's ask (2026-09-27): the detailed
// result is important and stays intact, but the default view should be a
// plain-English sentence or two, with the long form behind a "details" click.
//
// Same one-shot claude CLI pattern as thread-autogroup.ts's runClaudeClassifier
// — subscription binary only, NEVER an API key.
//
// This fires from finishHopperNode on every done/blocked node, which means
// every hermetic hopper-engine sim (scratch DB, JARVIS_SIM=1) would otherwise
// spawn a real billed claude process on every finish. sim-guard.ts exists
// exactly for this (see its 2026-09-24 incident note) — check it before
// spawning, the same chokepoint agent.processMessage uses.

const SUMMARY_MODEL = 'claude-haiku-4-5-20251001';
const SUMMARY_TIMEOUT_MS = 45_000;
const MAX_RESULT_CHARS = 8_000;
const MAX_SUMMARY_CHARS = 2_000;

export interface SummarizeNodeResultInput {
  title: string;
  outcome: string;
  resultText: string;
}

function buildPrompt(input: SummarizeNodeResultInput): string {
  return `A background worker just finished a task. Write a short summary in plain English for someone non-technical.

Task: "${input.title}"
Outcome: ${input.outcome}

Full result text:
"""
${input.resultText.slice(0, MAX_RESULT_CHARS)}
"""

Write 2-4 plain-English sentences covering: what the worker was trying to do, what actually happened, and — if it's blocked or needs a decision — what is needed next, or — if it succeeded — what changed.
Rules:
- No file paths, function/variable names, branch names, or code.
- No jargon unless it is truly unavoidable.
- Plain text only — no markdown, no headers, no bullet points, no quotes around the output.`;
}

async function runClaudeSummarizer(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;

    const child = spawn(
      process.env.CLAUDE_CLI_PATH || 'claude',
      // --verbose is required alongside --print + stream-json (see thread-autogroup.ts).
      ['--print', '-', '--output-format', 'stream-json', '--verbose', '--model', SUMMARY_MODEL],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`result-summary claude call timed out after ${SUMMARY_TIMEOUT_MS}ms`));
    }, SUMMARY_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`result-summary claude call exited ${code}: ${stderr.trim()}`));
        return;
      }

      let text = '';
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          const message = event.message as Record<string, unknown> | undefined;
          const content = message?.content;
          if (event.type === 'assistant' && Array.isArray(content)) {
            for (const block of content as Array<Record<string, unknown>>) {
              if (block.type === 'text' && typeof block.text === 'string') text += block.text;
            }
          }
          if (event.type === 'result' && typeof event.result === 'string') {
            text = event.result;
          }
        } catch {
          text += trimmed;
        }
      }
      resolve(text.trim());
    });

    child.stdin.end(prompt);
  });
}

/** Generates a layman summary via the subscription claude CLI. Never throws —
 *  any failure (timeout, missing CLI, bad output) resolves to null so callers
 *  can just leave result_summary unset. */
export async function summarizeNodeResult(input: SummarizeNodeResultInput): Promise<string | null> {
  if (!input.resultText.trim()) return null;
  if (refuseModelTurnInScratch('summarizeNodeResult')) return null;
  try {
    const raw = await runClaudeSummarizer(buildPrompt(input));
    const cleaned = raw.trim();
    return cleaned ? cleaned.slice(0, MAX_SUMMARY_CHARS) : null;
  } catch (err) {
    console.error('[result-summary] summarization failed:', err);
    return null;
  }
}
