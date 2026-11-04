#!/usr/bin/env node
// backfill-result-summaries — Readable node results (tree-bf5f54d9).
//
// New nodes get result_summary generated live, at finish time (see
// finishHopperNode in src/hopper-engine.ts). This script is the one-time
// catch-up for nodes that already finished before that wiring existed: the
// most recent 40 non-archived-tree nodes that have a result but no summary
// yet, done sequentially so it never floods the claude CLI.
//
// NOT run automatically and NOT run by this worker against the live DB —
// JARVIS runs it at deploy time, pointed at the real jarvis.db via
// JARVIS_DB_PATH, same convention as every other JARVIS_DB_PATH-guarded
// script in this repo (see scripts/token-ledger.mjs).
//
// Usage: JARVIS_DB_PATH=/path/to/jarvis.db node scripts/backfill-result-summaries.mjs [--limit 40] [--dry-run]

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.JARVIS_DB_PATH ?? path.join(HERE, '..', 'jarvis.db');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const LIMIT = Number(flag('limit', '40'));
const DRY_RUN = argv.includes('--dry-run');
const DELAY_MS = 1_500;

// --- claude CLI one-shot summarizer -----------------------------------------
// Mirrors src/result-summary.ts's summarizeNodeResult() — duplicated here
// (rather than importing dist/result-summary.js) so this script has no build
// dependency on `npm run build` having run first. Keep the two in sync if the
// prompt or parsing logic changes.

const SUMMARY_MODEL = 'claude-haiku-4-5-20251001';
const SUMMARY_TIMEOUT_MS = 45_000;
const MAX_RESULT_CHARS = 8_000;
const MAX_SUMMARY_CHARS = 2_000;

function buildPrompt(title, outcome, resultText) {
  return `A background worker just finished a task. Write a short summary in plain English for someone non-technical.

Task: "${title}"
Outcome: ${outcome}

Full result text:
"""
${resultText.slice(0, MAX_RESULT_CHARS)}
"""

Write 2-4 plain-English sentences covering: what the worker was trying to do, what actually happened, and — if it's blocked or needs a decision — what is needed next, or — if it succeeded — what changed.
Rules:
- No file paths, function/variable names, branch names, or code.
- No jargon unless it is truly unavoidable.
- Plain text only — no markdown, no headers, no bullet points, no quotes around the output.`;
}

async function runClaudeSummarizer(prompt) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;

    const child = spawn(
      process.env.CLAUDE_CLI_PATH || 'claude',
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
      reject(new Error(`backfill claude call timed out after ${SUMMARY_TIMEOUT_MS}ms`));
    }, SUMMARY_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
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
        reject(new Error(`backfill claude call exited ${code}: ${stderr.trim()}`));
        return;
      }
      let text = '';
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);
          const content = event.message?.content;
          if (event.type === 'assistant' && Array.isArray(content)) {
            for (const block of content) {
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

    // The child may exit before reading stdin — without a listener the EPIPE
    // is an unhandled 'error' event and kills the backfill mid-batch.
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

async function summarize(title, outcome, resultText) {
  try {
    const raw = await runClaudeSummarizer(buildPrompt(title, outcome, resultText));
    const cleaned = raw.trim();
    return cleaned ? cleaned.slice(0, MAX_SUMMARY_CHARS) : null;
  } catch (err) {
    console.error(`  ! summarization failed: ${err.message}`);
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- main --------------------------------------------------------------------

async function main() {
  const db = new Database(DB_PATH);

  const rows = db.prepare(`
    SELECT n.id, n.title, n.status, n.result
    FROM hopper_nodes n
    JOIN hopper_trees t ON t.id = n.tree_id
    WHERE n.result IS NOT NULL
      AND TRIM(n.result) != ''
      AND n.result_summary IS NULL
      AND t.status != 'archived'
    ORDER BY n.updated_at DESC
    LIMIT ?
  `).all(LIMIT);

  console.log(`[backfill-result-summaries] db=${DB_PATH} candidates=${rows.length} dry_run=${DRY_RUN}`);

  const update = db.prepare(`UPDATE hopper_nodes SET result_summary = ?, updated_at = datetime('now') WHERE id = ?`);

  let done = 0;
  let failed = 0;
  for (const row of rows) {
    console.log(`- node ${row.id} (${row.status}): "${row.title.slice(0, 60)}"`);
    if (DRY_RUN) {
      console.log('  (dry-run, skipping generation)');
      continue;
    }
    const summary = await summarize(row.title, row.status, row.result);
    if (summary) {
      update.run(summary, row.id);
      done++;
      console.log(`  -> ${summary.slice(0, 100)}${summary.length > 100 ? '…' : ''}`);
    } else {
      failed++;
      console.log('  -> no summary generated, left null');
    }
    await sleep(DELAY_MS);
  }

  console.log(`[backfill-result-summaries] done=${done} failed=${failed} of ${rows.length}`);
  db.close();
}

main().catch((err) => {
  console.error('[backfill-result-summaries] fatal:', err);
  process.exit(1);
});
