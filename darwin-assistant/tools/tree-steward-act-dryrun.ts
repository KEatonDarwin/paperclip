// TREE STEWARD — TEST-FREE DRY-RUN PROOF for executeAutoAnswer (node #1718)
//
// This is a plain CLI script (run with `npx tsx`), NOT a test runner. It proves
// the auto-answer effect path END TO END with FAKE effects: no database, no test
// runner, no model call, no network. It imports ONLY `executeAutoAnswer` and the
// `StewardEffects` type from the real module — nothing that could open a DB. If
// merely importing this module opened a database, that itself would be the bug
// (see STEP 3 / the import-hazard fix in src/tree-steward-act.ts).
//
// The whole point: prove the three effects fire exactly once, in the right order
// (answerNode -> recordDecision -> postOriginLine), that audit/breadcrumb failures
// NEVER block the answer, and that an answer failure short-circuits so we never
// write an audit row claiming we answered when we did not.
//
// It also must be able to FAIL: see tools/tree-steward-act-dryrun.ts mutation step
// in the node spec — reorder the effects in executeAutoAnswer and checks 1 & 8 go red.

import { executeAutoAnswer, type StewardEffects } from '../src/tree-steward-act.js';

// ---- recorded call log -----------------------------------------------------
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

type ThrowOn = 'answerNode' | 'recordDecision' | 'postOriginLine' | null;

/** Build a fake StewardEffects that records an ordered call log instead of doing
 *  anything real. A throwing effect throws FIRST, before recording, so that after
 *  an answerNode throw the log is genuinely empty (proving nothing downstream ran).
 */
function makeFakes(throwOn: ThrowOn = null): { log: Call[]; effects: StewardEffects } {
  const log: Call[] = [];
  const effects: StewardEffects = {
    answerNode(nodeId, answer) {
      if (throwOn === 'answerNode') throw new Error('fake answerNode blew up');
      log.push({ effect: 'answerNode', nodeId, answer });
    },
    recordDecision(input) {
      if (throwOn === 'recordDecision') throw new Error('fake recordDecision blew up');
      log.push({ effect: 'recordDecision', input });
    },
    postOriginLine(treeId, line) {
      if (throwOn === 'postOriginLine') throw new Error('fake postOriginLine blew up');
      log.push({ effect: 'postOriginLine', treeId, line });
    },
  };
  return { log, effects };
}

// ---- tiny check harness ----------------------------------------------------
const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
}

// A realistic auto-answer. Single-line so check 5 can assert the line contains it
// verbatim; answerNode must receive this exact string (check 3).
const ANSWER =
  "Adopt the worker's own recommendation: answer through the existing POST /hopper-nodes/:id/answer path.";
const ARGS = {
  nodeId: 1716,
  treeId: 'tree-91d31b19',
  title: 'Auto-answer the stuck blocked_question',
  question: 'Should the steward adopt the worker recommendation or wait for Kevin?',
  answer: ANSWER,
  category: 'adopt_recommendation',
  reason: 'single_clear_recommendation',
};

// === Scenario A: HAPPY PATH (checks 1-5) ===================================
{
  const { log, effects } = makeFakes();
  const res = executeAutoAnswer(ARGS, effects);

  // 1. All three effects, exactly once each, in order.
  const order = log.map((c) => c.effect).join(' -> ');
  const orderOk =
    log.length === 3 &&
    log[0].effect === 'answerNode' &&
    log[1].effect === 'recordDecision' &&
    log[2].effect === 'postOriginLine';
  check('happy-path-order', orderOk, `3 effects once each, order = [${order}]`);

  // 2. Return value: all three flags true.
  check(
    'return-flags-all-true',
    res.answered === true && res.decisionWritten === true && res.linePosted === true,
    `answered=${res.answered} decisionWritten=${res.decisionWritten} linePosted=${res.linePosted}`,
  );

  // 3. answerNode received the answer VERBATIM (module must not rewrite it).
  const a = log.find((c) => c.effect === 'answerNode') as Extract<Call, { effect: 'answerNode' }> | undefined;
  check(
    'answer-passed-verbatim',
    !!a && a.answer === ANSWER && a.nodeId === ARGS.nodeId,
    a ? `answerNode got nodeId=${a.nodeId}, answer identical=${a.answer === ANSWER}` : 'answerNode never called',
  );

  // 4. Decision row the fake received: decision == the answer, category matches,
  //    rationale cites the classifier reason + category. NOTE: decided_by 'jarvis'
  //    is NOT in what executeAutoAnswer passes — it is hard-set inside
  //    realStewardEffects.recordDecision (src/tree-steward-act.ts, `decidedBy: 'jarvis'`),
  //    so the fake never observes it. We assert only what the fake actually sees.
  const d = log.find((c) => c.effect === 'recordDecision') as Extract<Call, { effect: 'recordDecision' }> | undefined;
  const dOk =
    !!d &&
    d.input.decision === ANSWER &&
    d.input.category === ARGS.category &&
    d.input.nodeId === ARGS.nodeId &&
    d.input.rationale.includes(ARGS.reason) &&
    d.input.rationale.includes(ARGS.category);
  check(
    'decision-payload',
    dOk,
    d
      ? `decision==answer=${d.input.decision === ANSWER}, category='${d.input.category}', rationale cites reason+category=${d.input.rationale.includes(ARGS.reason) && d.input.rationale.includes(ARGS.category)} (decided_by set inside realStewardEffects, not observed here)`
      : 'recordDecision never called',
  );

  // 5. Origin line: exactly one line, mentions node id + category, contains answer.
  const p = log.find((c) => c.effect === 'postOriginLine') as Extract<Call, { effect: 'postOriginLine' }> | undefined;
  const lineOk =
    !!p &&
    !p.line.includes('\n') &&
    p.line.split('\n').length === 1 &&
    p.line.includes(`#${ARGS.nodeId}`) &&
    p.line.includes(ARGS.category) &&
    p.line.includes(ANSWER);
  check(
    'origin-line-shape',
    lineOk,
    p ? `single-line=${!p.line.includes('\n')}, has #${ARGS.nodeId}+category+answer=${p.line.includes(`#${ARGS.nodeId}`) && p.line.includes(ARGS.category) && p.line.includes(ANSWER)}` : 'postOriginLine never called',
  );
}

// === Scenario B: AUDIT FAILURE MUST NOT BLOCK THE BUILD (check 6) ==========
{
  const { log, effects } = makeFakes('recordDecision');
  const res = executeAutoAnswer(ARGS, effects);
  const postRan = log.some((c) => c.effect === 'postOriginLine');
  check(
    'audit-failure-non-blocking',
    res.answered === true && res.decisionWritten === false && res.linePosted === true && postRan,
    `answered=${res.answered} decisionWritten=${res.decisionWritten} linePosted=${res.linePosted}; postOriginLine still ran=${postRan}`,
  );
}

// === Scenario C: BREADCRUMB FAILURE MUST NOT BLOCK THE BUILD (check 7) ======
{
  const { log, effects } = makeFakes('postOriginLine');
  const res = executeAutoAnswer(ARGS, effects);
  const answerRan = log.some((c) => c.effect === 'answerNode');
  check(
    'breadcrumb-failure-non-blocking',
    res.answered === true && res.linePosted === false && answerRan,
    `answered=${res.answered} linePosted=${res.linePosted} decisionWritten=${res.decisionWritten}; answerNode ran=${answerRan}`,
  );
}

// === Scenario D: ANSWER FAILURE SHORT-CIRCUITS (check 8) — the one that matters
{
  const { log, effects } = makeFakes('answerNode');
  const res = executeAutoAnswer(ARGS, effects);
  const noDownstream = !log.some((c) => c.effect === 'recordDecision' || c.effect === 'postOriginLine');
  check(
    'answer-failure-short-circuits',
    res.answered === false &&
      res.decisionWritten === false &&
      res.linePosted === false &&
      log.length === 0 &&
      noDownstream,
    `answered=${res.answered} decisionWritten=${res.decisionWritten} linePosted=${res.linePosted}; call log length=${log.length} (empty => recordDecision & postOriginLine never ran)`,
  );
}

// ---- report ----------------------------------------------------------------
let passed = 0;
for (const r of results) {
  if (r.pass) passed++;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
}
const failed = results.length - passed;
console.log(`\n${results.length} checks, ${passed} passed, ${failed} failed`);
process.exit(0);
