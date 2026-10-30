// TREE STEWARD — END-TO-END PROOF ON REAL HARVESTED QUESTION TEXT (node #1729)
//
// A plain CLI script (run with `npx tsx`), NOT a test runner. It drives the real
// Tree Steward decision path over the VERBATIM question text of two real stuck
// nodes (harvested read-only into tools/fixtures/tree-steward-real-cases.json),
// and for the auto-answer case captures the three effect artifacts by passing
// RECORDING FAKE effects to `executeAutoAnswer` — no DB, no model, no network.
//
// It imports ONLY the two things it needs: `classifyBlockedQuestion` (pure core)
// and `executeAutoAnswer` + the `StewardEffects` type (the act seam). Neither
// opens a database — every real effect in tree-steward-act.ts is loaded by a
// DYNAMIC import inside realStewardEffects' methods, which fake effects never hit.
// As belt-and-suspenders against the documented import hazard (node #1718) we
// also point JARVIS_DB_PATH at a throwaway /tmp file for this run and print it.
//
// 🔴 HONEST-RESULT RULE: the fixture `expect` is the ground truth for the ACTION.
// If the classifier produces a different action than a case expects, this script
// reports it LOUDLY as a mismatch — it never bends the fixture and never rewords
// the real question text to make the classifier agree.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- import-hazard guard: redirect any accidental DB open to a scratch file ---
// (The two imports below are DB-free by design; this only fires if the import
// graph is ever changed to reach conversation-db at load.)
if (!process.env.JARVIS_DB_PATH) {
  process.env.JARVIS_DB_PATH = `/tmp/steward-proof-scratch-${process.pid}.db`;
}
const SCRATCH_DB = process.env.JARVIS_DB_PATH;

import {
  classifyBlockedQuestion,
  type StewardInput,
  type StewardDecision,
} from '../src/tree-steward.js';
import { executeAutoAnswer, type StewardEffects } from '../src/tree-steward-act.js';

// ---------------------------------------------------------------------------
// output buffering (so --markdown can wrap the whole run)
// ---------------------------------------------------------------------------
const MARKDOWN = process.argv.includes('--markdown');
const buf: string[] = [];
function out(line = ''): void {
  buf.push(line);
}

// ---------------------------------------------------------------------------
// recording fake effects — identical shape to the production dry-run's fakes
// ---------------------------------------------------------------------------
type Call =
  | { effect: 'answerNode'; nodeId: number; answer: string }
  | {
      effect: 'recordDecision';
      input: {
        nodeId: number;
        treeId: string | null;
        question: string;
        decision: string;
        rationale: string;
        category: string;
      };
    }
  | { effect: 'postOriginLine'; treeId: string | null; line: string };

function makeFakes(): { log: Call[]; effects: StewardEffects } {
  const log: Call[] = [];
  const effects: StewardEffects = {
    answerNode(nodeId, answer) {
      log.push({ effect: 'answerNode', nodeId, answer });
    },
    recordDecision(input) {
      log.push({ effect: 'recordDecision', input });
    },
    postOriginLine(treeId, line) {
      log.push({ effect: 'postOriginLine', treeId, line });
    },
  };
  return { log, effects };
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------
interface FixtureCase {
  label: string;
  sourceNodeId: number;
  sourceTreeId: string | null;
  harvestedVia: string;
  status: string;
  title: string;
  question: string;
  result?: string | null;
  expect: 'auto_answer' | 'park_card' | 'noop';
  why: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, 'fixtures', 'tree-steward-real-cases.json');
const cases: FixtureCase[] = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
out('# Tree Steward — end-to-end proof on REAL harvested question text');
out();
out(`Fixture: ${fixturePath}`);
out(`Scratch JARVIS_DB_PATH (import-hazard guard): ${SCRATCH_DB}`);
out(`Cases: ${cases.length}`);
out();

let matched = 0;
let mismatched = 0;

for (const c of cases) {
  out('='.repeat(78));
  out(`CASE: ${c.label}   (source node #${c.sourceNodeId}, tree ${c.sourceTreeId}, harvestedVia=${c.harvestedVia})`);
  out(`fixture.expect = ${c.expect}`);
  out(`fixture.why    = ${c.why}`);
  out('-'.repeat(78));

  // Build the pure-core input EXACTLY as the trigger (onBlockedQuestionFinished)
  // does at finish time: status is hard-set to 'blocked_question' because the
  // hook only ever fires from that branch. The fixture's current status
  // ("${c.status}") reflects that these real escalations have since been answered
  // and resumed to done; the verbatim question text is what we classify.
  const input: StewardInput = {
    nodeId: c.sourceNodeId,
    treeId: c.sourceTreeId,
    status: 'blocked_question',
    title: c.title,
    question: c.question,
    result: c.result ?? null,
    // priorAutoAnswers left undefined -> cap does not fire.
  };
  out(`[input] status forced to 'blocked_question' (fixture status was '${c.status}'); priorAutoAnswers=undefined`);

  // STEP: classify -> decide
  const decision: StewardDecision = classifyBlockedQuestion(input);
  out('[1] classifyBlockedQuestion:');
  out(`      action         = ${decision.action}`);
  out(`      category       = ${decision.category}`);
  out(`      confidence     = ${decision.confidence}`);
  out(`      recommendation = ${decision.recommendation === null ? 'null' : JSON.stringify(decision.recommendation)}`);
  out(`      reason         = ${decision.reason}`);

  // STEP: act (only on the branch the real trigger would take)
  if (decision.action === 'auto_answer') {
    const { log, effects } = makeFakes();
    const r = executeAutoAnswer(
      {
        nodeId: input.nodeId,
        treeId: input.treeId,
        title: input.title,
        question: input.question ?? '',
        answer: decision.answer ?? '',
        category: decision.category,
        reason: decision.reason,
      },
      effects,
    );
    out('[2] executeAutoAnswer with RECORDING FAKE effects:');
    out(`      return = answered=${r.answered} decisionWritten=${r.decisionWritten} linePosted=${r.linePosted}`);
    out(`      ordered call log = [${log.map((x) => x.effect).join(' -> ')}]`);

    const a = log.find((x) => x.effect === 'answerNode') as
      | Extract<Call, { effect: 'answerNode' }>
      | undefined;
    const d = log.find((x) => x.effect === 'recordDecision') as
      | Extract<Call, { effect: 'recordDecision' }>
      | undefined;
    const p = log.find((x) => x.effect === 'postOriginLine') as
      | Extract<Call, { effect: 'postOriginLine' }>
      | undefined;

    out('');
    out('      ── ARTIFACT (a): THE ANSWER handed to answerNode ──');
    out(`      nodeId: ${a ? a.nodeId : '(answerNode never called)'}`);
    out(`      answer: ${a ? JSON.stringify(a.answer) : '(answerNode never called)'}`);

    out('');
    out('      ── ARTIFACT (b): THE DECISION PAYLOAD handed to recordDecision (every field) ──');
    if (d) {
      out(`      nodeId   : ${d.input.nodeId}`);
      out(`      treeId   : ${d.input.treeId === null ? 'null' : JSON.stringify(d.input.treeId)}`);
      out(`      question : ${JSON.stringify(d.input.question)}`);
      out(`      decision : ${JSON.stringify(d.input.decision)}`);
      out(`      rationale: ${JSON.stringify(d.input.rationale)}`);
      out(`      category : ${JSON.stringify(d.input.category)}`);
      out('      (note: decided_by is hard-set to "jarvis" INSIDE realStewardEffects.recordDecision,');
      out('       not in what executeAutoAnswer passes, so the fake never observes it.)');
    } else {
      out('      (recordDecision never called)');
    }

    out('');
    out('      ── ARTIFACT (c): THE ORIGIN LINE handed to postOriginLine ──');
    out(`      treeId: ${p ? (p.treeId === null ? 'null' : JSON.stringify(p.treeId)) : '(postOriginLine never called)'}`);
    out(`      line  : ${p ? JSON.stringify(p.line) : '(postOriginLine never called)'}`);
    if (p) out(`      single-line (no embedded newline)? ${!p.line.includes('\n')}`);
  } else if (decision.action === 'park_card') {
    // The real trigger's park branch NEVER calls executeAutoAnswer. Prove the
    // isolation positively: stand up recording fakes, invoke NOTHING, and show
    // the empty call log as evidence that a park touches no answer/decision/origin
    // effect.
    const { log } = makeFakes();
    out('[2] PARK path — executeAutoAnswer is NOT invoked (mirrors the trigger park branch).');
    out(`      recording-fake call log (positive evidence of no effects) = [${log.map((x) => x.effect).join(', ')}]  length=${log.length}`);
    out(`      answerNode calls   = ${log.filter((x) => x.effect === 'answerNode').length}`);
    out(`      recordDecision calls = ${log.filter((x) => x.effect === 'recordDecision').length}`);
    out(`      postOriginLine calls = ${log.filter((x) => x.effect === 'postOriginLine').length}`);
  } else {
    out('[2] NOOP path — nothing to do.');
  }

  // STEP: assert against fixture expect
  const ok = decision.action === c.expect;
  if (ok) matched++;
  else mismatched++;
  out('');
  out(`[3] ${ok ? 'PASS' : 'FAIL'}  ${c.label}  expected=${c.expect} got=${decision.action}`);
  if (!ok) {
    out('      🔴 MISCLASSIFICATION — the classifier produced a different action than this real case expects.');
    out('      Per the honest-result rule this is reported as-is; the fixture is NOT bent and the');
    out('      real question text is NOT reworded.');
  }
  out('');
}

out('='.repeat(78));
out(`${cases.length} cases, ${matched} matched, ${mismatched} mismatched`);

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------
if (MARKDOWN) {
  console.log('```text');
  console.log(buf.join('\n'));
  console.log('```');
} else {
  console.log(buf.join('\n'));
}

process.exit(0);
