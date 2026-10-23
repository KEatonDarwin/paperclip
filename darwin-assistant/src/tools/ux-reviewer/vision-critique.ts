// JARVIS UX Reviewer — vision critique (DAR-685, slice 2).
//
// The "taste" half of the reviewer. Slice 1 (capture-harness.ts) produced a
// manifest of screenshots across screens x states x viewports. This slice reads
// that manifest and, for each captured cell, shows the PNG to a vision-capable
// model alongside the rubric (rubric.ts) and asks for structured findings:
// objective DEFECTS (severity-graded) + subjective SUGGESTIONS, each anchored to
// a region of the UI. The output feeds the bug-intake sink + fixer loop.
//
// Vision path: the local `claude` CLI (subscription login — NO ANTHROPIC_API_KEY
// on this box) can *see* an image when its absolute path is referenced in the
// prompt. We invoke `claude -p ... --output-format json`, which returns an
// envelope whose `.result` field is the model's text; we ask the model to emit a
// strict JSON object and extract it robustly (fences / prose tolerated).
//
// Design notes:
//  - Per-cell isolation, mirroring capture: one cell that times out or returns
//    unparseable output records an error and does NOT abort the pass.
//  - Bounded concurrency (default 3): each CLI turn is a heavy model call, so we
//    pool rather than fan out all 18 cells at once.
//  - Objective vs subjective is preserved end-to-end so the fixer can treat
//    defects (must-fix) and suggestions (nice-to-have) differently.

import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_RUBRIC, rubricToPrompt, type Rubric } from './rubric.js';
import type { CaptureCell, CaptureManifest } from './capture-harness.js';

export type Severity = 'high' | 'medium' | 'low';

export interface Defect {
  severity: Severity;
  region: string; // where in the UI ("top nav", "thread table row 3")
  title: string;
  detail: string;
  rubric?: number | null; // objective rubric item # that was violated, if any
}

export interface Suggestion {
  region: string;
  title: string;
  detail: string;
}

export interface CellCritique {
  screen: string;
  state: string;
  viewport: string;
  file?: string; // absolute PNG path critiqued
  ok: boolean; // model returned parseable findings
  summary?: string;
  defects: Defect[];
  suggestions: Suggestion[];
  error?: string; // set when ok=false (timeout / parse failure / skipped)
  critiqueMs?: number;
  costUsd?: number;
  raw?: string; // model text when JSON extraction failed (for debugging)
}

export interface CritiqueReport {
  project: string;
  baseUrl: string;
  manifestRunId: string;
  startedAt: string;
  finishedAt: string;
  model: string;
  totalCells: number; // ok capture cells considered
  critiquedCells: number; // cells that produced parseable findings
  defectCount: number;
  suggestionCount: number;
  bySeverity: Record<Severity, number>;
  totalCostUsd: number;
  outDir: string;
  cells: CellCritique[];
}

export interface CritiqueOptions {
  rubric?: Rubric; // default DEFAULT_RUBRIC
  claudeBin?: string; // default UX_REVIEWER_CLAUDE_BIN or "claude"
  model?: string; // default UX_REVIEWER_VISION_MODEL or CLI default (must be vision-capable)
  concurrency?: number; // default 3
  perCellTimeoutMs?: number; // default 180000
  outFile?: string; // where findings.json lands (default: <manifest outDir>/findings.json)
  // Optional filter: only critique cells matching this predicate (e.g. skip some viewports).
  filter?: (cell: CaptureCell) => boolean;
}

const DEFAULT_CLAUDE_BIN = process.env.UX_REVIEWER_CLAUDE_BIN || 'claude';
const DEFAULT_MODEL = process.env.UX_REVIEWER_VISION_MODEL || '';

/**
 * Repair the two failure classes that make otherwise-balanced model JSON
 * un-parseable, in a single string-aware pass:
 *   1. Raw control chars (unescaped newlines/tabs/CR) inside string values —
 *      the model writes multi-line `detail` text without escaping.
 *   2. Trailing commas before `}` / `]`.
 * Anything inside a JSON string is left byte-for-byte except control-char
 * escaping, so real punctuation in critique prose is never mangled.
 */
export function repairJson(candidate: string): string {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];
    const code = candidate.charCodeAt(i);
    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
      } else if (ch === '\\') {
        out += ch;
        esc = true;
      } else if (ch === '"') {
        out += ch;
        inStr = false;
      } else if (code < 0x20) {
        // Unescaped control char inside a string — escape it.
        out += ch === '\n' ? '\\n' : ch === '\t' ? '\\t' : ch === '\r' ? '\\r' : '\\u' + code.toString(16).padStart(4, '0');
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === '}' || ch === ']') {
      // Drop a trailing comma (and any whitespace after it) preceding this close.
      let j = out.length - 1;
      while (j >= 0 && /\s/.test(out[j])) j--;
      if (j >= 0 && out[j] === ',') out = out.slice(0, j) + out.slice(j + 1);
      out += ch;
    } else {
      out += ch;
    }
  }
  return out;
}

function tryParse(candidate: string): any | null {
  try {
    return JSON.parse(candidate);
  } catch {
    try {
      return JSON.parse(repairJson(candidate));
    } catch {
      return null;
    }
  }
}

/** Extract the first balanced JSON object from arbitrary model text. */
export function extractJsonObject(text: string): any | null {
  if (!text) return null;
  let s = text.trim();
  // strip ```json ... ``` or ``` ... ``` fences (closing fence optional)
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  if (s.startsWith('{')) {
    const parsed = tryParse(s);
    if (parsed !== null) return parsed;
    /* fall through to balance scan */
  }
  // balance-scan for the first {...} (string-aware so braces in values don't fool it)
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return tryParse(s.slice(start, i + 1));
      }
    }
  }
  return null;
}

function buildCellPrompt(cell: CaptureCell, project: string, rubric: Rubric): string {
  const consoleErrs = cell.consoleErrors.length ? cell.consoleErrors.map((e) => `  - ${e}`).join('\n') : '  (none)';
  const netFails = cell.failedRequests.length ? cell.failedRequests.map((e) => `  - ${e}`).join('\n') : '  (none)';
  return [
    rubricToPrompt(rubric),
    '',
    'CONTEXT FOR THIS SCREENSHOT:',
    `- Project: ${project}`,
    `- Screen: ${cell.screen}`,
    `- State: ${cell.state}${cell.stateDescription ? ` — ${cell.stateDescription}` : ''}`,
    `- Viewport: ${cell.viewport}`,
    `- Page title: ${cell.title ?? '(unknown)'}`,
    `- Console errors captured during load:`,
    consoleErrs,
    `- Failed network requests (excluding deliberately-blocked hosts):`,
    netFails,
    '',
    `The screenshot to review is the image file at this absolute path: ${cell.file}`,
    'Open and look at that image now, then judge ONLY what is visible in it.',
    '',
    'Return ONLY a JSON object — no markdown fences, no prose before or after — with EXACTLY this shape:',
    '{',
    '  "summary": "one concise sentence overall impression of this screen/state",',
    '  "defects": [',
    '    {"severity": "high|medium|low", "region": "where in the UI", "title": "short label", "detail": "what is wrong and why", "rubric": <objective item number 1-9 or null>}',
    '  ],',
    '  "suggestions": [',
    '    {"region": "where in the UI", "title": "short label", "detail": "the human-touch improvement"}',
    '  ]',
    '}',
    'If there are no defects, use an empty array. Do not invent problems that are not visible.',
  ].join('\n');
}

interface ClaudeResult {
  result: string;
  costUsd?: number;
  isError: boolean;
}

function runClaudeVision(
  prompt: string,
  imageDir: string,
  opts: { bin: string; model: string; timeoutMs: number },
): Promise<ClaudeResult> {
  const args = ['-p', prompt, '--output-format', 'json', '--add-dir', imageDir];
  if (opts.model) args.push('--model', opts.model);
  // The claude adapter deletes ANTHROPIC_API_KEY to force subscription login; do
  // the same so a stray key can't switch this onto metered API billing.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return new Promise<ClaudeResult>((resolve, reject) => {
    execFile(
      opts.bin,
      args,
      { timeout: opts.timeoutMs, maxBuffer: 32 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error(`claude vision call failed: ${err.message}${stderr ? ` | ${stderr.slice(0, 300)}` : ''}`));
          return;
        }
        let envelope: any = null;
        try {
          envelope = JSON.parse(stdout.trim());
        } catch {
          // stdout wasn't the envelope; treat raw stdout as the result text
        }
        if (envelope && typeof envelope.result === 'string') {
          resolve({ result: envelope.result, costUsd: envelope.total_cost_usd, isError: !!envelope.is_error });
        } else {
          resolve({ result: stdout, costUsd: undefined, isError: false });
        }
      },
    );
  });
}

async function critiqueCell(cell: CaptureCell, project: string, opts: Required<Omit<CritiqueOptions, 'outFile' | 'filter'>>): Promise<CellCritique> {
  const base: CellCritique = {
    screen: cell.screen,
    state: cell.state,
    viewport: cell.viewport,
    file: cell.file,
    ok: false,
    defects: [],
    suggestions: [],
  };
  if (!cell.file) {
    return { ...base, error: 'no screenshot file (capture cell was not ok)' };
  }
  const prompt = buildCellPrompt(cell, project, opts.rubric);
  const t0 = Date.now();
  try {
    const res = await runClaudeVision(prompt, dirname(cell.file), {
      bin: opts.claudeBin,
      model: opts.model,
      timeoutMs: opts.perCellTimeoutMs,
    });
    let parsed = extractJsonObject(res.result);
    let costUsd = res.costUsd;
    // One retry with a stricter reminder — covers the failure class the
    // deterministic repair can't (e.g. an unescaped quote mid-string), where
    // re-asking the (non-deterministic) model usually yields clean JSON.
    if (!parsed || typeof parsed !== 'object') {
      const retry = await runClaudeVision(
        prompt + '\n\nIMPORTANT: your previous reply was not valid JSON. Reply with STRICT, valid JSON only — escape every newline and quote inside string values, and use no trailing commas.',
        dirname(cell.file),
        { bin: opts.claudeBin, model: opts.model, timeoutMs: opts.perCellTimeoutMs },
      );
      const retryParsed = extractJsonObject(retry.result);
      if (retry.costUsd) costUsd = (costUsd ?? 0) + retry.costUsd;
      if (retryParsed && typeof retryParsed === 'object') {
        parsed = retryParsed;
      } else {
        return { ...base, error: 'could not parse JSON from model output (after retry)', raw: res.result.slice(0, 1500), critiqueMs: Date.now() - t0, costUsd };
      }
    }
    const critiqueMs = Date.now() - t0;
    const defects: Defect[] = Array.isArray(parsed.defects)
      ? parsed.defects.map((d: any) => ({
          severity: normalizeSeverity(d?.severity),
          region: String(d?.region ?? '').slice(0, 300),
          title: String(d?.title ?? '').slice(0, 300),
          detail: String(d?.detail ?? '').slice(0, 1500),
          rubric: typeof d?.rubric === 'number' ? d.rubric : null,
        }))
      : [];
    const suggestions: Suggestion[] = Array.isArray(parsed.suggestions)
      ? parsed.suggestions.map((s: any) => ({
          region: String(s?.region ?? '').slice(0, 300),
          title: String(s?.title ?? '').slice(0, 300),
          detail: String(s?.detail ?? '').slice(0, 1500),
        }))
      : [];
    return {
      ...base,
      ok: true,
      summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 500) : undefined,
      defects,
      suggestions,
      critiqueMs,
      costUsd,
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message.slice(0, 500) : String(err), critiqueMs: Date.now() - t0 };
  }
}

function normalizeSeverity(v: any): Severity {
  const s = String(v ?? '').toLowerCase();
  if (s === 'high' || s === 'critical' || s === 'blocker') return 'high';
  if (s === 'low' || s === 'minor' || s === 'nit') return 'low';
  return 'medium';
}

/** Run a bounded-concurrency map over items. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Read a capture manifest and critique every ok cell with the vision model.
 * Writes findings.json into the manifest's outDir (or opts.outFile) and returns
 * the aggregated report.
 */
export async function critiqueManifest(manifest: CaptureManifest, options: CritiqueOptions = {}): Promise<CritiqueReport> {
  const opts: Required<Omit<CritiqueOptions, 'outFile' | 'filter'>> = {
    rubric: options.rubric ?? DEFAULT_RUBRIC,
    claudeBin: options.claudeBin ?? DEFAULT_CLAUDE_BIN,
    model: options.model ?? DEFAULT_MODEL,
    concurrency: options.concurrency ?? 3,
    perCellTimeoutMs: options.perCellTimeoutMs ?? 180000,
  };
  const filter = options.filter ?? (() => true);
  const candidates = manifest.cells.filter((c) => c.ok && c.file && filter(c));

  const startedAt = new Date().toISOString();
  const critiques = await pool(candidates, opts.concurrency, (cell) => critiqueCell(cell, manifest.project, opts));
  const finishedAt = new Date().toISOString();

  const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  let defectCount = 0;
  let suggestionCount = 0;
  let totalCostUsd = 0;
  for (const c of critiques) {
    defectCount += c.defects.length;
    suggestionCount += c.suggestions.length;
    for (const d of c.defects) bySeverity[d.severity]++;
    if (typeof c.costUsd === 'number') totalCostUsd += c.costUsd;
  }

  const report: CritiqueReport = {
    project: manifest.project,
    baseUrl: manifest.baseUrl,
    manifestRunId: manifest.runId,
    startedAt,
    finishedAt,
    model: opts.model || '(cli default)',
    totalCells: candidates.length,
    critiquedCells: critiques.filter((c) => c.ok).length,
    defectCount,
    suggestionCount,
    bySeverity,
    totalCostUsd,
    outDir: manifest.outDir,
    cells: critiques,
  };

  const outFile = options.outFile ?? join(manifest.outDir, 'findings.json');
  await writeFile(outFile, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

/** Convenience: load a manifest.json from disk and critique it. */
export async function critiqueManifestFile(manifestPath: string, options: CritiqueOptions = {}): Promise<CritiqueReport> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as CaptureManifest;
  return critiqueManifest(manifest, options);
}
