import { spawn } from 'node:child_process';
import { refuseModelTurnInScratch } from './sim-guard.js';
import { sqliteDb } from './conversation-db.js';

// Layman layer, everywhere (tree-9e15d8a7): generalizes the readable-node-results
// pattern (result-summary.ts, tree-bf5f54d9) to every surface that reports,
// lists, or verdicts something — goal verify verdicts, shift items/reports,
// foundry errors, health suggestions, etc. Same one-shot claude CLI pattern as
// result-summary.ts's runClaudeSummarizer — subscription binary only, NEVER an
// API key. Kept as ONE mechanism so every caller gets the same shape, the same
// sim guard, and the same failure behavior (never throws, resolves null).

const SUMMARY_MODEL = 'claude-haiku-4-5-20251001';
const SUMMARY_TIMEOUT_MS = 45_000;
const MAX_INPUT_CHARS = 8_000;
const MAX_SUMMARY_CHARS = 2_000;

export type LaymanSummaryKind =
  | 'node_result'
  | 'verify_verdict'
  | 'shift_item'
  | 'shift_report'
  | 'foundry_error'
  | 'generic';

export interface SummarizeForLaymanInput {
  kind: LaymanSummaryKind;
  title: string;
  outcome?: string;
  text: string;
}

// Per-kind framing line injected into the prompt so the model knows what kind
// of event it's glossing without leaking implementation detail into the ask.
const KIND_FRAMING: Record<LaymanSummaryKind, string> = {
  node_result: 'A background worker just finished a task. Write a short summary in plain English for someone non-technical.',
  verify_verdict:
    'A checker just verified whether a piece of work is really finished — say what was checked, what passed or failed, and what is needed next.',
  shift_item: 'One item of an overnight work session finished.',
  shift_report:
    "Summarize how a whole work session went in 3 sentences: what got done, what didn't, what needs Kevin.",
  foundry_error: 'A build pipeline hit an error — say what broke in plain words and what would fix it.',
  generic: 'Something happened that needs a plain-English summary.',
};

function buildPrompt(input: SummarizeForLaymanInput): string {
  const framing = KIND_FRAMING[input.kind];
  const outcomeLine = input.outcome ? `\nOutcome: ${input.outcome}` : '';
  return `${framing}

Task: "${input.title}"${outcomeLine}

Full text:
"""
${input.text.slice(0, MAX_INPUT_CHARS)}
"""

Write 2-4 plain-English sentences covering: what was being tried, what actually happened, and — if it's blocked, failed, or needs a decision — what is needed next, or — if it succeeded — what changed.
Rules:
- No file paths, function/variable names, branch names, or code.
- No jargon unless it is truly unavoidable.
- Plain text only — no markdown, no headers, no bullet points, no quotes around the output.`;
}

async function runClaudeSummarizer(prompt: string, model: string = SUMMARY_MODEL, timeoutMs: number = SUMMARY_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;

    const child = spawn(
      process.env.CLAUDE_CLI_PATH || 'claude',
      // --verbose is required alongside --print + stream-json (see thread-autogroup.ts).
      ['--print', '-', '--output-format', 'stream-json', '--verbose', '--model', model],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`layman-summary claude call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
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
        reject(new Error(`layman-summary claude call exited ${code}: ${stderr.trim()}`));
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

    // The child may exit before reading stdin (auth failure, spent subscription,
    // rejected flag) — without a listener that write's EPIPE is an unhandled
    // 'error' event and kills the whole engine process.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

/** Generates a layman summary via the subscription claude CLI. Never throws —
 *  any failure (timeout, missing CLI, bad output, scratch env) resolves to
 *  null so callers can just leave the summary column unset. */
export async function summarizeForLayman(input: SummarizeForLaymanInput): Promise<string | null> {
  if (!input.text.trim()) return null;
  if (refuseModelTurnInScratch('summarizeForLayman')) return null;
  try {
    const raw = await runClaudeSummarizer(buildPrompt(input));
    const cleaned = raw.trim();
    return cleaned ? cleaned.slice(0, MAX_SUMMARY_CHARS) : null;
  } catch (err) {
    console.error('[layman-summary] summarization failed:', err);
    return null;
  }
}

/** Same subscription-CLI one-shot as `summarizeForLayman`, but the caller owns
 *  the whole prompt (shift-narrator.ts's play-by-play voice needs a different
 *  framing than the per-kind summaries above). Same guarantees: sim-guarded,
 *  never throws, resolves null on any failure. Model defaults to the haiku
 *  summarizer; callers that need better prose pass a heavier claude id. */
export async function laymanFreeform(opts: { prompt: string; model?: string; timeoutMs?: number; maxChars?: number; where?: string }): Promise<string | null> {
  if (!opts.prompt.trim()) return null;
  if (refuseModelTurnInScratch(opts.where ?? 'laymanFreeform')) return null;
  try {
    const raw = await runClaudeSummarizer(opts.prompt, opts.model ?? SUMMARY_MODEL, opts.timeoutMs ?? SUMMARY_TIMEOUT_MS);
    const cleaned = raw.trim();
    return cleaned ? cleaned.slice(0, opts.maxChars ?? MAX_SUMMARY_CHARS) : null;
  } catch (err) {
    console.error(`[layman-summary] freeform (${opts.where ?? 'laymanFreeform'}) failed:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fire-and-forget store: summarize, then UPDATE one column on one row.
// ---------------------------------------------------------------------------

// Whitelist of table/column pairs this may write to — generateAndStoreSummary
// never interpolates a caller-supplied table/column into SQL unchecked, since
// that string ultimately traces back to call sites scattered across the
// codebase and a typo or future caller could otherwise open a SQL-injection
// shaped hole.
const WRITABLE_COLUMNS: Record<string, { idColumn: string; columns: Set<string> }> = {
  hopper_nodes: { idColumn: 'id', columns: new Set(['result_summary']) },
  goal_nodes: { idColumn: 'id', columns: new Set(['verdict_summary']) },
  night_items: { idColumn: 'id', columns: new Set(['result_gloss']) },
  foundry_projects: { idColumn: 'id', columns: new Set(['last_error_summary']) },
};

export interface GenerateAndStoreSummaryOpts {
  table: string;
  idColumn?: string;
  id: number | string;
  column: string;
  input: SummarizeForLaymanInput;
  afterStore?: () => void;
}

/** Fire-and-forget: summarize `input`, then persist it to `table.column` for
 *  the row identified by `id`. Fully wrapped — a failure anywhere (bad
 *  table/column, summarization failure, DB error) is logged and swallowed,
 *  never thrown into the caller's path. `afterStore` runs only after a
 *  successful write, so callers can emit their own live-update event. */
export function generateAndStoreSummary(opts: GenerateAndStoreSummaryOpts): void {
  void (async () => {
    try {
      const allowed = WRITABLE_COLUMNS[opts.table];
      if (!allowed || !allowed.columns.has(opts.column)) {
        console.error(`[layman-summary] refused write to unlisted ${opts.table}.${opts.column}`);
        return;
      }
      // The id column is interpolated into SQL, so it must match the whitelist
      // entry too — never a caller-supplied string (review 1078 advisory B).
      const idColumn = allowed.idColumn;
      if (opts.idColumn !== undefined && opts.idColumn !== allowed.idColumn) {
        console.error(`[layman-summary] refused unlisted id column ${opts.table}.${opts.idColumn}`);
        return;
      }
      const summary = await summarizeForLayman(opts.input);
      if (!summary) return;
      sqliteDb
        .prepare(`UPDATE ${opts.table} SET ${opts.column} = ?, updated_at = datetime('now') WHERE ${idColumn} = ?`)
        .run(summary, opts.id);
      opts.afterStore?.();
    } catch (err) {
      console.error(`[layman-summary] generateAndStoreSummary failed for ${opts.table}.${opts.column}#${opts.id}:`, err);
    }
  })();
}
