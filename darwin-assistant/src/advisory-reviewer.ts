import { execFile } from 'node:child_process';
import { getSetting } from './conversation-db.js';
import { isScratchEnv } from './sim-guard.js';
import { branchExists, runGit } from './hopper-git.js';
import { setHopperNodeAdvisory, type HopperNodeRow, type HopperTreeRow } from './hopper-engine.js';

// ADVISORY REVIEWER -- a NON-BLOCKING second pair of eyes (Haiku) beside the
// gating reviewer (Opus). The bake-off (outbox/model-bakeoff/LADDER-2026-11-04.md)
// showed Haiku catches ~41% of defects for free but false-alarms on nearly every
// clean case, so it is useful as a "worth a look" note and fatal as a gate.
//
// HARD CONTRACT (do not weaken):
//   * It never fails a node, never triggers a fix, never blocks a merge.
//   * Its text goes ONLY in hopper_nodes.advisory_review. goals-autopilot's
//     parseVerdict reads node.result; night-shift.ts / shift-narrator.ts regex
//     result_summary for a VERDICT FAIL line -- so neither `result` nor
//     `result_summary` is ever written here.
//   * maybeRunAdvisoryReview never throws and never rejects: every failure
//     (spawn error, timeout, empty diff, empty output, db error) stores nothing.
//
// Settings-KV (re-read every call, so a change needs no restart):
//   advisory_reviewer_model       unset => DEFAULT_MODEL; 'off' => disabled; else the model id
//   advisory_reviewer_timeout_ms  default 120000 (floor 5000)

/** The ONE trigger: gate nodes. VERIFY: = autopilot / night-shift gate, ACCEPT: = sprint lane. */
export const ADVISORY_TRIGGER_RE = /^\s*(VERIFY|ACCEPT):/i;

const DEFAULT_MODEL = 'claude-haiku-5-5';
const DEFAULT_TIMEOUT_MS = 120_000;
const DIFF_CAP_BYTES = 24 * 1024;
const OUTPUT_CAP_CHARS = 4000;
const CLAUDE_BIN = process.env.UX_REVIEWER_CLAUDE_BIN || 'claude';
// Automation runs on Claude B (rule: A is Kevin's, at the keyboard).
const CLAUDE_B_DIR = '/home/kevin/.claude-b';
// Lockfiles / generated noise would eat the 24KB window and say nothing.
const DIFF_EXCLUDES = [
  ':(exclude)package-lock.json',
  ':(exclude)pnpm-lock.yaml',
  ':(exclude)yarn.lock',
  ':(exclude)bun.lockb',
  ':(exclude)*.min.js',
  ':(exclude)*.map',
];

function modelSetting(): string | null {
  const raw = getSetting('advisory_reviewer_model');
  const v = raw && raw.trim() ? raw.trim() : DEFAULT_MODEL;
  return v.toLowerCase() === 'off' ? null : v;
}

function timeoutMs(): number {
  const raw = getSetting('advisory_reviewer_timeout_ms');
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 5_000 ? n : DEFAULT_TIMEOUT_MS;
}

/** Reject after `ms` without leaking the timer. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`advisory review timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** The repo's default branch: origin/HEAD target, else main, else master. */
function defaultBase(repoPath: string): string | null {
  const head = runGit(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], 10_000);
  if (head.ok && head.output.trim()) return head.output.trim();
  for (const b of ['main', 'master']) if (branchExists(repoPath, b)) return b;
  return null;
}

/**
 * The diff of the work the gate just judged, taken from a PERSISTENT branch (so
 * it cannot race worktree pruning): the tree's integration branch (where the
 * gated work has landed) else the node's own branch, against its merge-base with
 * the repo's default branch. Null = nothing usable, the caller skips.
 */
function buildDiff(node: HopperNodeRow, tree: HopperTreeRow): string | null {
  const repo = tree.repo_path?.trim();
  if (!repo) return null; // legacy shared-checkout tree: no persistent branch to diff
  const ref = [tree.integration_branch, node.node_branch].find((b): b is string => !!b && branchExists(repo, b));
  const base = defaultBase(repo);
  if (!ref || !base) return null;
  const mb = runGit(repo, ['merge-base', base, ref], 30_000);
  if (!mb.ok || !mb.output.trim()) return null;
  const diff = runGit(repo, ['diff', '--no-color', `${mb.output.trim()}..${ref}`, '--', '.', ...DIFF_EXCLUDES], 60_000);
  if (!diff.ok || !diff.output.trim()) return null;
  if (Buffer.byteLength(diff.output) <= DIFF_CAP_BYTES) return diff.output;
  const cut = Buffer.from(diff.output).subarray(0, DIFF_CAP_BYTES).toString('utf8');
  return `${cut}\n[... diff truncated at ${DIFF_CAP_BYTES} bytes ...]`;
}

function buildPrompt(node: HopperNodeRow, tree: HopperTreeRow, diff: string): string {
  // Not node.spec: a gate node's spec is the long gate instruction block (it even
  // tells the gate to emit a VERDICT line) -- we want the work's goal, not that.
  const doneMeans = `${node.title} — ${tree.topic}`.slice(0, 1500);
  return (
    'You are an ADVISORY second reviewer. Your notes are non-binding and shown beside a separate gating ' +
    "reviewer's verdict — you never pass or fail anything. Below is the diff for a change the gate has already " +
    'judged. List up to 8 concrete things worth a second look: correctness bugs, safety/security issues, missed ' +
    'edge cases, or clear simplifications. Format each as: file then line then what then why it matters. If the ' +
    'diff looks clean, say so in one line. Do not restate the diff. Do NOT output any line starting with the word ' +
    'VERDICT. Keep under ~250 words.\n\n' +
    `Done means: ${doneMeans}\n\nDiff:\n${diff}`
  );
}

/** Spawn the claude CLI (subscription binary, NO API key), prompt over stdin. Rejects on any failure. */
function runModel(prompt: string, model: string, ms: number): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: CLAUDE_B_DIR };
  delete env.ANTHROPIC_API_KEY;
  return new Promise((resolve, reject) => {
    const child = execFile(
      CLAUDE_BIN,
      ['-p', '-', '--output-format', 'json', '--model', model],
      { timeout: ms, maxBuffer: 8 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error(`advisory review call failed: ${err.message}${stderr ? ` | ${stderr.slice(0, 300)}` : ''}`));
          return;
        }
        try {
          const envelope = JSON.parse(stdout.trim()) as { result?: string; is_error?: boolean };
          if (envelope.is_error) {
            reject(new Error('advisory review call returned is_error'));
            return;
          }
          resolve(typeof envelope.result === 'string' ? envelope.result : '');
        } catch {
          resolve(stdout);
        }
      },
    );
    child.stdin?.on('error', () => undefined); // child died before reading -- the callback reports it
    child.stdin?.end(prompt);
  });
}

/** Never let advisory text look like a gate verdict to any regex that scans for one. */
function sanitize(raw: string): string {
  return raw
    .split('\n')
    .filter((l) => !/^\s*[*_#>\-\s]*VERDICT\b/i.test(l))
    .join('\n')
    .trim()
    .slice(0, OUTPUT_CAP_CHARS);
}

/**
 * Fire-and-forget entry point, called from finishHopperNode. Resolves (never
 * rejects) whether it stored a note or silently skipped.
 */
export async function maybeRunAdvisoryReview(node: HopperNodeRow | null, tree: HopperTreeRow | null): Promise<void> {
  try {
    if (!node || !tree) return;
    if (!ADVISORY_TRIGGER_RE.test(node.title)) return;
    if (node.advisory_review) return; // already has one
    if (isScratchEnv()) return; // a sim never spawns a model
    const model = modelSetting();
    if (!model) return; // 'off'
    const diff = buildDiff(node, tree);
    if (!diff) return;
    const ms = timeoutMs();
    const raw = await withTimeout(runModel(buildPrompt(node, tree, diff), model, ms), ms + 5_000);
    const note = sanitize(raw);
    if (!note) return;
    setHopperNodeAdvisory(node.id, note);
  } catch (err) {
    // Advisory only: a failure stores nothing and must never reach the finish path.
    console.error(`[advisory-reviewer] skipped node ${node?.id ?? '?'}:`, err instanceof Error ? err.message : err);
  }
}
