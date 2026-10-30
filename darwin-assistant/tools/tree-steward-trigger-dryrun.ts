// tree-steward-trigger-dryrun.ts — a model-free, test-runner-free, DB-free PROOF
// that the Tree Steward trigger (src/tree-steward-trigger.ts) fires EXACTLY ONCE
// per blocked_question node and routes each kind of question to the right action.
//
// This is a PLAIN CLI SCRIPT, not a test suite. Run it with:
//   npx tsx tools/tree-steward-trigger-dryrun.ts
// (the script sets a throwaway JARVIS_DB_PATH itself; the npm/engine runner may
//  also pass one on the command line — either way nothing touches the real DB).
//
// DB HAZARD — ROUTE A (env-var redirect), chosen deliberately.
// src/tree-steward-trigger.ts reads the `tree_steward` kill switch via
//   const { getSetting } = await import('./conversation-db.js');
// and conversation-db.ts opens a better-sqlite3 handle AT MODULE LOAD against
//   process.env.JARVIS_DB_PATH ?? <repo>/jarvis.db
// so merely importing it would open the real jarvis.db. We prevent that by
// setting JARVIS_DB_PATH to a FRESH /tmp file BEFORE anything imports that module
// (both here, as the very first statements, and — when the engine runs us — on the
// command line). conversation-db then opens the throwaway file; the real DB is
// never opened or written. We print the resolved path up front and the harness
// `ls -la`s the real DB before/after to show its mtime is unchanged.
// Route A is chosen over refactoring the trigger to a wrapped-dynamic-import
// (route B) because the env var already exists — we change NO production code to
// suit a harness, and route A also lets us exercise the real kill switch against
// the throwaway DB (check 7).
//
// It captures console.log/console.error, drives onBlockedQuestionFinished with
// hand-written in-memory contexts (never read from any database), and asserts the
// emitted "[tree-steward] …" line (or its absence). It always exits 0; a FAIL is a
// reported finding, not a throw.

// --- STEP 0: redirect the DB to a throwaway path BEFORE importing anything that opens it.
import os from 'node:os';
import path from 'node:path';

const REAL_DB = '/home/kevin/paperclip/darwin-assistant/jarvis.db';
const THROWAWAY_DB =
  process.env.JARVIS_DB_PATH ??
  path.join(os.tmpdir(), `tree-steward-dryrun-${process.pid}-${Date.now()}.db`);
process.env.JARVIS_DB_PATH = THROWAWAY_DB;

// A static import of the TRIGGER is safe: it opens no DB at load — its getSetting
// read is a dynamic import inside the function, and its tree-steward import is
// `import type`, erased at runtime. conversation-db is imported DYNAMICALLY inside
// main(), strictly after the env var above is set.
import {
  onBlockedQuestionFinished,
  __resetStewardTriggerGuardForDryRun,
  type StewardTriggerContext,
} from '../src/tree-steward-trigger.js';

// ---------------------------------------------------------------------------
// console capture — the only way to observe the (inert) trigger's one effect.
// ---------------------------------------------------------------------------
const realLog = console.log.bind(console);
const realErr = console.error.bind(console);
let captured: string[] = [];

function startCapture(): void {
  captured = [];
  console.log = (...a: unknown[]) => void captured.push(a.map((x) => String(x)).join(' '));
  console.error = (...a: unknown[]) => void captured.push(a.map((x) => String(x)).join(' '));
}
function stopCapture(): void {
  console.log = realLog;
  console.error = realErr;
}
/** Only lines the steward itself prints; load-time noise is filtered out. */
function stewardLines(): string[] {
  return captured.filter((l) => l.startsWith('[tree-steward]'));
}
function parseEmit(line: string): { nodeId: number; action: string; category: string } | null {
  const m = line.match(/^\[tree-steward\] node (\d+) tree (.+?): (\w+) \((\w+)\)/);
  return m ? { nodeId: Number(m[1]), action: m[3], category: m[4] } : null;
}

async function fire(ctx: StewardTriggerContext) {
  startCapture();
  try {
    await onBlockedQuestionFinished(ctx);
  } finally {
    stopCapture();
  }
  const lines = stewardLines();
  return { lines, emit: lines.length ? parseEmit(lines[0]) : null, raw: lines[0] ?? '' };
}

// ---------------------------------------------------------------------------
// check accounting
// ---------------------------------------------------------------------------
let total = 0;
let passed = 0;
let failed = 0;
function record(ok: boolean, name: string, detail: string): void {
  total++;
  if (ok) passed++;
  else failed++;
  realLog(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

// A hand-written, auto-answerable context: a plain product/spec call carrying an
// explicit RECOMMENDATION line, with no escalation-bar or test/DB-fence words.
const AUTO: Omit<StewardTriggerContext, 'nodeId'> = {
  treeId: 'tree-dryrun',
  title: 'Pick the default layout density',
  question: 'Should the summary panel default to a compact or a roomy layout?',
  result: 'Both render fine.\nRECOMMENDATION: default to the compact layout.\nEither is acceptable.',
};

async function main(): Promise<void> {
  realLog(`[dryrun] resolved JARVIS_DB_PATH = ${process.env.JARVIS_DB_PATH}`);
  realLog(`[dryrun] real DB that must stay untouched = ${REAL_DB}`);

  if (path.resolve(process.env.JARVIS_DB_PATH as string) === path.resolve(REAL_DB)) {
    realLog('[dryrun] REFUSING to run: JARVIS_DB_PATH points at the real jarvis.db.');
    process.exit(0);
  }

  // Warm conversation-db once, OUTSIDE any capture window, so its load-time work
  // (opening the throwaway file, creating the settings table) never pollutes a
  // check. This opens the THROWAWAY path, because the env var is already set.
  const { setSetting, getSetting } = await import('../src/conversation-db.js');
  setSetting('tree_steward', 'on'); // known-good baseline on the throwaway DB.
  realLog(`[dryrun] throwaway kill-switch baseline tree_steward='${getSetting('tree_steward')}'\n`);

  const ONCE_ID = 70101;

  // 1 — product/spec question with an explicit RECOMMENDATION -> auto_answer.
  {
    const r = await fire({ nodeId: ONCE_ID, ...AUTO });
    record(
      !!r.emit && r.emit.action === 'auto_answer',
      'check1  product/spec + RECOMMENDATION -> auto_answer',
      r.emit ? `emitted action=${r.emit.action} category=${r.emit.category}` : `NO EMISSION (expected auto_answer); raw="${r.raw}"`,
    );
  }

  // 2 — SAME nodeId again -> nothing emitted. THE exactly-once proof.
  {
    const r = await fire({ nodeId: ONCE_ID, ...AUTO });
    record(
      r.lines.length === 0,
      'check2  EXACTLY-ONCE: same nodeId again -> no emission',
      r.lines.length === 0 ? 'second call for the same node emitted nothing (correct)' : `LEAK: ${r.lines.length} line(s): "${r.raw}"`,
    );
  }

  // 3 — reset the guard, call the SAME nodeId a third time -> it emits again.
  {
    __resetStewardTriggerGuardForDryRun();
    const r = await fire({ nodeId: ONCE_ID, ...AUTO });
    record(
      !!r.emit && r.emit.action === 'auto_answer',
      'check3  guard reset -> same nodeId emits again (guard is a real guard)',
      r.emit ? `re-emitted action=${r.emit.action}` : `NO EMISSION after reset; raw="${r.raw}"`,
    );
  }

  // 4 — escalation-bar question (restart jarvis.service) -> park_card.
  {
    const r = await fire({
      nodeId: 70104,
      treeId: 'tree-dryrun',
      title: 'Apply the change',
      question: 'Should I restart jarvis.service now to load the change?',
      result: 'The change is built and ready.',
    });
    record(
      !!r.emit && r.emit.action === 'park_card',
      'check4  escalation (restart jarvis.service) -> park_card',
      r.emit ? `action=${r.emit.action} category=${r.emit.category}` : `NO EMISSION; raw="${r.raw}"`,
    );
  }

  // 5 — a question asking to run the test suite -> park_card with the fence category.
  {
    const r = await fire({
      nodeId: 70105,
      treeId: 'tree-dryrun',
      title: 'Confirm before done',
      question: 'Should I run the test suite before we call this done?',
      result: 'The build is green.',
    });
    record(
      !!r.emit && r.emit.action === 'park_card' && r.emit.category === 'fence_test_or_db',
      'check5  run the test suite -> park_card (fence_test_or_db)',
      r.emit ? `action=${r.emit.action} category=${r.emit.category}` : `NO EMISSION; raw="${r.raw}"`,
    );
  }

  // 6 — a real product/spec call with NO recommendation -> park_card.
  {
    const r = await fire({
      nodeId: 70106,
      treeId: 'tree-dryrun',
      title: 'Export format',
      question: 'Should the export format be CSV or XLSX for the weekly roll-up?',
      result: 'Both are plausible and I could not pick one with confidence.',
    });
    record(
      !!r.emit && r.emit.action === 'park_card' && r.emit.category === 'no_recommendation',
      'check6  real call, no recommendation -> park_card (no_recommendation)',
      r.emit ? `action=${r.emit.action} category=${r.emit.category}` : `NO EMISSION; raw="${r.raw}"`,
    );
  }

  // 7 — kill switch. OFF suppresses an otherwise auto-answerable node; ON re-emits.
  //      Distinct nodeIds so the exactly-once guard never masks the kill-switch effect
  //      (the guard is set BEFORE the kill-switch read, so a node seen while OFF is
  //       marked handled — we must use a fresh id for the ON half).
  setSetting('tree_steward', 'off');
  {
    const r = await fire({ nodeId: 70107, ...AUTO });
    record(
      r.lines.length === 0,
      'check7a  kill-switch OFF -> no emission on an auto-answerable question',
      r.lines.length === 0 ? `switch='${getSetting('tree_steward')}' suppressed emission` : `LEAK while OFF: "${r.raw}"`,
    );
  }
  setSetting('tree_steward', 'on');
  {
    const r = await fire({ nodeId: 70108, ...AUTO });
    record(
      !!r.emit && r.emit.action === 'auto_answer',
      'check7b  kill-switch ON -> emits again (fresh nodeId)',
      r.emit ? `switch='${getSetting('tree_steward')}' action=${r.emit.action}` : `NO EMISSION while ON; raw="${r.raw}"`,
    );
  }

  realLog(`\n${total} checks, ${passed} passed, ${failed} failed`);
  process.exit(0);
}

main().catch((err) => {
  stopCapture();
  realErr('[dryrun] harness error (NOT a steward emission):', err);
  realLog(`\n${total} checks, ${passed} passed, ${failed} failed`);
  process.exit(0);
});
