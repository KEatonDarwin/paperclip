// tree-steward-shadow-dryrun.ts — a plain CLI (NOT a test suite) that proves,
// model-free and real-database-free, that:
//   • card-only mode (the default) performs ZERO effects on a blocked_question;
//   • 'live' mode DOES run the effects;
//   • the morning rollup renders, stays quiet on an empty night, and can never
//     throw and kill the 8am Build Standup.
//
// HOW IT STAYS DATABASE-SAFE (node #1726, STEP 3): importing the steward modules
// opens the jarvis.db sqlite handle at module load (conversation-db does
// `new Database(process.env.JARVIS_DB_PATH ?? <...>/jarvis.db)` at module scope).
// To avoid ever touching the real jarvis.db we (a) set JARVIS_DB_PATH to a FRESH
// /tmp file BEFORE any steward/db module is imported, and (b) import every such
// module DYNAMICALLY inside main() so the env is already in place when the handle
// opens. We print the resolved scratch path up top. The caller also captures the
// real jarvis.db mtime before and after to prove it is untouched.
//
// Run:  JARVIS_DB_PATH=/tmp/steward-dryrun-<...>.db npx tsx tools/tree-steward-shadow-dryrun.ts
// (the script also self-defaults JARVIS_DB_PATH if the caller did not set one.)

// ── STEP 0: lock the environment BEFORE anything opens a DB or a socket. ──────
// A unique scratch DB under /tmp, only if the caller did not already pin one.
if (!process.env.JARVIS_DB_PATH || !process.env.JARVIS_DB_PATH.trim()) {
  process.env.JARVIS_DB_PATH = `/tmp/steward-dryrun-${process.pid}-${Date.now()}.db`;
}
// Guarantee NO external ntfy push can fire when the steward raises a card
// (createNotification → scheduleNtfyDelivery returns immediately when this is unset).
delete process.env.JARVIS_NTFY_TOPIC_URL;

let passed = 0;
let failed = 0;
const results: string[] = [];

function check(name: string, ok: boolean, detail: string): void {
  if (ok) passed++;
  else failed++;
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`;
  results.push(line);
  console.log(line);
}

/** Capture everything written to console.log/console.error during fn(), while
 *  still letting it through to the real stdout so the run stays observable. */
async function captureConsole(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const sink = (orig: (...a: unknown[]) => void) => (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    orig(...args);
  };
  console.log = sink(origLog) as typeof console.log;
  console.error = sink(origErr) as typeof console.error;
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return lines;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(`[dryrun] resolved JARVIS_DB_PATH = ${process.env.JARVIS_DB_PATH}`);
  console.log(`[dryrun] JARVIS_NTFY_TOPIC_URL set? ${process.env.JARVIS_NTFY_TOPIC_URL ? 'YES' : 'no (external push disabled)'}`);

  // ── DYNAMIC imports — env is pinned, so the sqlite handle opens on /tmp. ────
  const trigger = await import('../src/tree-steward-trigger.js');
  const rollup = await import('../src/tree-steward-rollup.js');
  const guard = await import('../src/tree-steward-guard.js');
  const db = await import('../src/conversation-db.js');
  const decisions = await import('../src/jarvis-decisions.js');
  const notifs = await import('../src/notifications.js');

  const {
    stewardMode,
    onBlockedQuestionFinished,
    __resetStewardTriggerGuardForDryRun,
  } = trigger;
  const { stewardRollup, renderStewardBlock } = rollup;
  const { STEWARD_STATE_KEY } = guard;
  const { getSetting, setSetting, deleteSetting } = db;
  const { listJarvisDecisions } = decisions;
  const { listNotifications } = notifs;

  const ANSWER_PREFIX = 'Tree Steward auto-answer';
  const STEWARD_SOURCE = 'tree-steward';

  const countStewardDecisions = (): number =>
    listJarvisDecisions({ decidedBy: 'jarvis', limit: 1000 }).filter(
      (r) => typeof r.rationale === 'string' && r.rationale.startsWith(ANSWER_PREFIX),
    ).length;
  const stewardCards = () =>
    listNotifications(1000).filter((n) => n.source === STEWARD_SOURCE);

  // An auto-answerable blocked_question: a real worker-style recommendation on
  // its OWN line (Rule 5 needs the RECOMMENDATION label at line-start), and no
  // escalation / test-DB-fence words anywhere.
  const AUTO_Q =
    "For the standup header, should the greeting read 'Morning' or 'Hi'?\n" +
    "RECOMMENDATION: use 'Morning' to match the existing tone.";
  const mkCtx = (nodeId: number) => ({
    nodeId,
    treeId: 'tree-dryrun-steward',
    title: 'Standup greeting wording',
    question: AUTO_Q,
    result: null as string | null,
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CHECK 1 — MODE DEFAULT: unset steward_mode resolves to 'card_only'.
  // ─────────────────────────────────────────────────────────────────────────
  deleteSetting('steward_mode');
  const m1 = await stewardMode();
  check('1-MODE-DEFAULT', m1 === 'card_only', `steward_mode unset → stewardMode()='${m1}' (want card_only)`);

  // ─────────────────────────────────────────────────────────────────────────
  // CHECK 2 — only the exact 'live' (trimmed/lower-cased) is live; all junk is
  // card_only.
  // ─────────────────────────────────────────────────────────────────────────
  const junk = ['', 'yes', 'on', 'LIVE-ish', 'card only'];
  const junkBad: string[] = [];
  for (const v of junk) {
    setSetting('steward_mode', v);
    const got = await stewardMode();
    if (got !== 'card_only') junkBad.push(`'${v}'→${got}`);
  }
  const liveCases = ['live', 'LIVE  '];
  const liveBad: string[] = [];
  for (const v of liveCases) {
    setSetting('steward_mode', v);
    const got = await stewardMode();
    if (got !== 'live') liveBad.push(`'${v}'→${got}`);
  }
  check(
    '2-MODE-EXACT-LIVE',
    junkBad.length === 0 && liveBad.length === 0,
    junkBad.length === 0 && liveBad.length === 0
      ? `all 5 junk values → card_only; 'live' & 'LIVE  ' → live`
      : `MISMATCH junk=[${junkBad.join(',')}] live=[${liveBad.join(',')}]`,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // CHECK 3 — THE ONE THAT MATTERS. In card_only, feeding the trigger an
  // auto-answerable blocked_question performs ZERO effects:
  //   • no Decision Ledger row written,
  //   • guard state (recordStewardAnswer) untouched → NOT called,
  //   • no AUTO-ANSWER effect line on the console,
  // while a SHADOW card IS raised (checked in #4).
  // SEAM: observed CALL LOG = scratch-DB state deltas (decision rows, guard-state
  // settings key) + captured console. This observes the EFFECTS by state change,
  // not merely "no error thrown".
  // ─────────────────────────────────────────────────────────────────────────
  deleteSetting('steward_mode'); // card_only (default)
  deleteSetting(STEWARD_STATE_KEY); // guard state empty → null means "never recorded"
  __resetStewardTriggerGuardForDryRun();
  const decBefore3 = countStewardDecisions();
  const cardsBefore3 = stewardCards().length;
  const guardBefore3 = getSetting(STEWARD_STATE_KEY);

  const log3 = await captureConsole(async () => {
    await onBlockedQuestionFinished(mkCtx(990001));
    await sleep(120); // let any fire-and-forget effect promises settle
  });

  const decAfter3 = countStewardDecisions();
  const guardAfter3 = getSetting(STEWARD_STATE_KEY);
  const sawShadow3 = log3.some((l) => l.includes('SHADOW (card_only)'));
  // The REAL effect line is the only one that reports `answered=` (format:
  // "... : AUTO-ANSWER (cat) — answered=... decision=... origin=..."). The SHADOW
  // line's own text contains the phrase "would AUTO-ANSWER", so matching on the
  // bare token "AUTO-ANSWER" would collide with it — we must key on `answered=`,
  // which the shadow line never carries.
  const sawAutoAnswer3 = log3.some((l) => l.includes('AUTO-ANSWER') && l.includes('answered='));
  const noDecision3 = decAfter3 - decBefore3 === 0;
  const guardUntouched3 = guardBefore3 === null && guardAfter3 === null;
  const zeroEffects =
    noDecision3 && guardUntouched3 && sawShadow3 && !sawAutoAnswer3;
  check(
    '3-CARDONLY-ZERO-EFFECTS',
    zeroEffects,
    `decisionΔ=${decAfter3 - decBefore3}(want 0) guardState=${guardAfter3 === null ? 'null' : 'SET'}(want null→recordStewardAnswer NOT called) ` +
      `console: SHADOW=${sawShadow3} AUTO-ANSWER=${sawAutoAnswer3}(want false)`,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // CHECK 4 — in card_only a card IS raised carrying wouldHaveAnswered with the
  // answer text it would have given.
  // ─────────────────────────────────────────────────────────────────────────
  const cardsAfter3 = stewardCards();
  const raisedOne = cardsAfter3.length - cardsBefore3 === 1;
  const newest = cardsAfter3[0];
  const body = newest?.body ?? '';
  const hasWould = /Would have answered:/i.test(body);
  const carriesAnswer = body.includes('Morning'); // the recommendation it adopted
  check(
    '4-CARDONLY-CARD-WOULDHAVE',
    raisedOne && hasWould && carriesAnswer,
    `cardsΔ=${cardsAfter3.length - cardsBefore3}(want 1) body has "Would have answered:"=${hasWould} carries adopted answer ('Morning')=${carriesAnswer}`,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // CHECK 5 — flip steward_mode to 'live': the SAME input now DOES run the
  // effects. We observe (a) the Decision Ledger row written by the auto-answer
  // effect, and (b) the guard's recordStewardAnswer bump — i.e. the answer call
  // actually ran, not merely "no crash".
  // ─────────────────────────────────────────────────────────────────────────
  setSetting('steward_mode', 'live');
  deleteSetting(STEWARD_STATE_KEY);
  __resetStewardTriggerGuardForDryRun();
  const decBefore5 = countStewardDecisions();

  const log5 = await captureConsole(async () => {
    await onBlockedQuestionFinished(mkCtx(990002));
    await sleep(200); // async effects (answerNode/recordDecision) are fire-and-forget
  });
  // Poll briefly for the decision row to land (recordDecision runs after a
  // dynamic-import microtask inside the fire-and-forget effect).
  let decAfter5 = countStewardDecisions();
  for (let i = 0; i < 20 && decAfter5 - decBefore5 < 1; i++) {
    await sleep(25);
    decAfter5 = countStewardDecisions();
  }
  const guardAfter5 = getSetting(STEWARD_STATE_KEY);
  let guardN = 0;
  let guardHasNode = false;
  try {
    const st = guardAfter5 ? JSON.parse(guardAfter5) : null;
    const entry = st?.trees?.['tree-dryrun-steward'];
    guardN = entry?.n ?? 0;
    guardHasNode = Array.isArray(entry?.nodes) && entry.nodes.includes(990002);
  } catch { /* leave zeros */ }
  const sawAutoAnswer5 = log5.some((l) => l.includes('AUTO-ANSWER') && l.includes('answered=true'));
  const wroteDecision5 = decAfter5 - decBefore5 === 1;
  const recorded5 = guardN === 1 && guardHasNode;
  check(
    '5-LIVE-RUNS-EFFECTS',
    wroteDecision5 && recorded5 && sawAutoAnswer5,
    `decisionΔ=${decAfter5 - decBefore5}(want 1) guardState n=${guardN} nodeRecorded=${guardHasNode}(recordStewardAnswer called) console AUTO-ANSWER answered=true=${sawAutoAnswer5}`,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // CHECK 6 — ROLLUP renders: with answer + park entries, renderStewardBlock
  // returns a non-empty block naming BOTH and reporting the mode. Pure — no DB.
  // ─────────────────────────────────────────────────────────────────────────
  const r6 = {
    answered: ["• has_recommendation: should the greeting read 'Morning' or 'Hi'"],
    parked: ['• #4242 tree-abc123 — a real product call with no recommendation'],
    answeredCount: 1,
    parkedCount: 1,
    mode: 'live',
  };
  const block6 = renderStewardBlock(r6);
  const names6 =
    block6.length > 0 &&
    block6.includes('Morning') && // the answered entry
    block6.includes('#4242') && // the parked entry
    block6.includes('Auto-answered') &&
    block6.includes('Parked') &&
    /tree steward.*—.*live/i.test(block6); // reports the mode
  check(
    '6-ROLLUP-RENDERS',
    names6,
    `block len=${block6.length} names answered('Morning')=${block6.includes('Morning')} parked('#4242')=${block6.includes('#4242')} mode-reported=${/tree steward.*—.*live/i.test(block6)}`,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // CHECK 7 — ROLLUP QUIET: nothing in the window → renderStewardBlock returns
  // '' so the standup stays silent on an empty night. Pure — no DB.
  // ─────────────────────────────────────────────────────────────────────────
  const block7 = renderStewardBlock({
    answered: [],
    parked: [],
    answeredCount: 0,
    parkedCount: 0,
    mode: 'card_only',
  });
  check('7-ROLLUP-QUIET', block7 === '', `empty window → renderStewardBlock()='${block7}' (want empty string)`);

  // ─────────────────────────────────────────────────────────────────────────
  // CHECK 8 — ROLLUP CANNOT KILL THE MORNING. Force the underlying read to throw
  // (close the shared sqlite handle), then assert stewardRollup STILL returns
  // empty lists rather than propagating — briefing.ts warns a throw/hang here
  // once killed the 8am message for 17 days. MUST be last: it closes the handle.
  // ─────────────────────────────────────────────────────────────────────────
  db.sqliteDb.close(); // every subsequent getSetting/list*  now throws at the DB layer
  let threw8 = false;
  let empty8 = false;
  let quiet8 = false;
  try {
    const r8 = stewardRollup();
    empty8 =
      Array.isArray(r8.answered) && r8.answered.length === 0 &&
      Array.isArray(r8.parked) && r8.parked.length === 0 &&
      r8.answeredCount === 0 && r8.parkedCount === 0;
    quiet8 = renderStewardBlock(r8) === '';
  } catch {
    threw8 = true; // propagation = the exact failure this guards against
  }
  check(
    '8-ROLLUP-NEVER-THROWS',
    !threw8 && empty8 && quiet8,
    threw8
      ? 'stewardRollup PROPAGATED the DB error (would kill the 8am briefing)'
      : `DB read forced to throw → stewardRollup returned empty lists (answered/parked=[] counts=0) and renders ''`,
  );

  // ── Summary ───────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${total} checks, ${passed} passed, ${failed} failed`);
}

main()
  .catch((err) => {
    console.error('[dryrun] FATAL — the harness itself threw:', err);
    console.log(`\n${passed + failed + 1} checks, ${passed} passed, ${failed + 1} failed`);
  })
  .finally(() => {
    // CLI always exits 0 — a failing CHECK is reported in the summary line, not
    // as a process failure.
    process.exit(0);
  });
