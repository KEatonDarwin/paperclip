// TWO-WAY CONTEXT BRIDGE PROOF HARNESS (hopper node #1419, tree-1cc231ce) —
// extends the #278-style proof pattern (scripts/companion-thread-proof.ts) to
// prove node #1408's thread_bridges table + getBridgedThreads resolver and
// node #1413's buildBridgedContext digest injection actually connect two real
// threads in both directions, end to end, through real `claude` CLI turns.
//
// Same bootstrap discipline as companion-thread-proof.ts: a /tmp scratch DB
// (conversation-db.js's module-load-time `new Database(DB_PATH)` IS the
// schema init — no separate migration runner), the REAL exported functions
// from dist/ (never reimplemented), and runClaude() called directly rather
// than through processMessage() (sim-guard blocks real turns from a non-live
// DB through that path — see companion-thread-proof.ts's header for the full
// rationale, unchanged here).
//
// WHAT THIS PROVES THAT #1400/#1401 DIDN'T: those harnesses drove ONE
// companion thread in isolation. This harness creates a SECOND thread
// (cockpit:goal-12), links them with a real thread_bridges row, seeds each
// side with a specific, falsifiable detail only the OTHER side said, then
// calls the REAL buildBridgedContext() (bridged-context.ts, unmodified,
// dynamic-imported from dist/) before each side's turn — proving the digest
// actually carries cross-thread information rather than asserting the
// plumbing exists in the abstract.
//
//   npm run build
//   JARVIS_DB_PATH=/tmp/companion-bridge-proof-$(date +%s).db npx tsx scripts/companion-context-bridge-proof.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');

// ── scratch DB guard (must run before any dist/ module is imported) ───────
const raw = process.env.JARVIS_DB_PATH;
if (!raw || !raw.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path (e.g. /tmp/companion-bridge-proof-<ts>.db).');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
const LIVE_DB = path.resolve(__dirname, '..', 'jarvis.db');
if (DB_PATH === LIVE_DB) {
  console.error('FATAL: refusing to run against the live jarvis.db. Use a /tmp scratch path.');
  process.exit(1);
}
if (!DB_PATH.startsWith('/tmp/')) {
  console.error(`FATAL: refusing a scratch path outside /tmp (${DB_PATH}).`);
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

console.log(`[bridge-proof] scratch DB: ${DB_PATH}`);
console.log(`[bridge-proof] JARVIS_SIM=${process.env.JARVIS_SIM ?? '(unset)'} (must stay unset/0 — real claude CLI turns)`);

let failed = false;
let directionAFailed = false;
let directionBFailed = false;
function check(label: string, ok: boolean, scope?: 'A' | 'B'): void {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
    if (scope === 'A') directionAFailed = true;
    if (scope === 'B') directionBFailed = true;
  }
}

// Same falsifiable operator-vocab signal as companion-thread-proof.ts's
// ASSERTION 1, reused here for the #276 advisory (step 5 of the spec): does
// the bridged digest itself — derived purely from the partner thread's own
// turns, per bridged-context.ts's design comment — carry any operator/
// autonomy-dial language.
const OPERATOR_VOCAB = [
  'hopper', 'throttle', 'governor', 'autonomy dial', 'chief of staff',
  'overwatch', 'cockpit', 'paperclip', 'shim', 'darwin investor network',
  'hub 2.0', 'hub 1.0', 'perclickity', 'deploy', 'goal tree', 'workstream',
  "kevin's personal ai", 'hard limiter', 'jarvis_autonomy_dial',
];
function operatorVocabHits(text: string): string[] {
  const lower = text.toLowerCase();
  return OPERATOR_VOCAB.filter((term) => lower.includes(term));
}

async function main() {
  const {
    getOrCreateCompanionThread,
    companionIdFromThread,
  } = await import(path.join(distDir, 'companion-chat.js'));
  const {
    getConversation,
    getOrCreateConversation,
    addTurn,
    getTurns,
    sqliteDb,
    updateSessionState,
    setThreadModelOverride,
  } = await import(path.join(distDir, 'conversation-db.js'));
  const { memoryProfileForThread } = await import(path.join(distDir, 'prompt.js'));
  const { resolveConversationRuntime, buildInitialPrompt, runClaude } = await import(
    path.join(distDir, 'agent.js')
  );
  const { getBridgedThreads } = await import(path.join(distDir, 'conversation-db.js'));
  const { buildBridgedContext } = await import(path.join(distDir, 'bridged-context.js'));

  // ── Step 1: create both real threads ──────────────────────────────────────
  const WIFE_ID = 'bridge-proof';
  const { external_id: companionExt, created: companionCreated } = getOrCreateCompanionThread(WIFE_ID);
  check('step 1: companion thread created', companionCreated === true);

  const GOAL_EXT = 'cockpit:goal-12';
  const goalConvInitial = getOrCreateConversation(GOAL_EXT);
  check('step 1: goal-12 thread created', !!goalConvInitial);
  // Pin the goal thread to claude/sonnet-5 the real way (same exported
  // setThreadModelOverride() the companion thread uses to pin to opus) so its
  // runtime resolution is deterministic rather than falling through to
  // whatever global adapter/model settings happen to be unset on a fresh
  // scratch DB.
  setThreadModelOverride(goalConvInitial.id, 'claude', 'claude-sonnet-5');

  let companionConv = getConversation(companionExt)!;
  let goalConv = getConversation(GOAL_EXT)!;
  const companionRuntime = resolveConversationRuntime(companionConv);
  const goalRuntime = resolveConversationRuntime(goalConv);
  check('step 1: companion runtime resolves opus (#277 guard)', companionRuntime.adapter.id === 'claude' && !!companionRuntime.model?.startsWith('claude-opus-'));
  check('step 1: goal-12 runtime resolves claude-sonnet-5', goalRuntime.adapter.id === 'claude' && goalRuntime.model === 'claude-sonnet-5');

  // ── Step 2: bridge them the REAL way — node #1408's thread_bridges table,
  // the only schema this feature has (no insert helper is exported; the
  // table itself, not any re-derived logic, is what we're exercising). ──────
  sqliteDb
    .prepare(`INSERT INTO thread_bridges (thread_a_ext, thread_b_ext, kind) VALUES (?, ?, ?)`)
    .run(companionExt, GOAL_EXT, 'companion-goal12');

  const partnersOfCompanion = getBridgedThreads(companionExt);
  const partnersOfGoal = getBridgedThreads(GOAL_EXT);
  check('step 2: getBridgedThreads(companion) resolves goal-12 (symmetric UNION query)', partnersOfCompanion.includes(GOAL_EXT));
  check('step 2: getBridgedThreads(goal-12) resolves companion (symmetric UNION query)', partnersOfGoal.includes(companionExt));

  // ── Step 3: seed each side with a SPECIFIC, memorable, falsifiable detail
  // only that side said — real opus/sonnet turns, persisted via the real
  // addTurn + updateSessionState path. ───────────────────────────────────────
  const companionProfile = memoryProfileForThread(companionExt);
  const goalProfile = memoryProfileForThread(GOAL_EXT);
  check('step 3: companion thread profile is "companion"', companionProfile === 'companion');
  check('step 3: goal-12 thread profile is "full" (ordinary JARVIS thread)', goalProfile === 'full');

  // Uses Lola's real name (Kevin's actual kid, per memory) rather than a
  // fabricated one — a made-up kid name collided with the real family facts
  // already loaded into the goal-12 thread's full JARVIS memory profile
  // ("your kids are Maxwell and Lola"), which made the model correctly treat
  // the digest as suspicious/injected content rather than a real note from
  // the companion thread (see the first run's artifact for that failure
  // mode). The wish item itself is still fabricated for this proof.
  const SEED_HER_MSG =
    "Quick note for the wish catalog — Lola's #1 pick this year is the Bluey Ultimate Lights & Sounds Playhouse. Wanted to flag it before I forget!";
  const SEED_KEVIN_MSG =
    "For the wish catalog project, let's cap each kid's gift budget at $40 — keep it simple and consistent across the board.";

  async function seedTurn(
    conv: { id: number; external_id: string },
    runtime: { adapter: unknown; model: string | null; options: unknown },
    profile: string,
    userMessage: string,
    label: string,
  ): Promise<{ sessionIdAfter: string | null; replyText: string }> {
    const stdinContent = buildInitialPrompt(userMessage, profile as never, conv.external_id);
    console.log(`\n[bridge-proof] === seed: ${label} ===`);
    const result = await runClaude(stdinContent, null, undefined, runtime as never);
    console.log(`[bridge-proof] ${label} replied in ${result.text.length} chars, model=${result.model ?? '(none)'}`);
    addTurn(conv.id, 'user', userMessage, undefined, undefined, undefined, { model: (runtime as { model: string | null }).model ?? undefined });
    addTurn(conv.id, 'assistant', result.text, undefined, undefined, undefined, {
      model: result.model ?? (runtime as { model: string | null }).model ?? undefined,
      claudeOutput: result.rawOutput,
    });
    updateSessionState(conv.id, result.sessionId ?? null, (runtime as { adapter: { id: string } }).adapter.id, result.accountKey ?? null);
    return { sessionIdAfter: result.sessionId ?? null, replyText: result.text };
  }

  const herSeed = await seedTurn(companionConv, companionRuntime, companionProfile, SEED_HER_MSG, 'her seed (companion)');
  check('step 3: her seed turn returned non-empty text', herSeed.replyText.trim().length > 0);
  companionConv = getConversation(companionExt)!;
  check('step 3: her seed turn captured a session id', !!companionConv.claude_session_id);

  const kevinSeed = await seedTurn(goalConv, goalRuntime, goalProfile, SEED_KEVIN_MSG, "Kevin's seed (goal-12)");
  check("step 3: Kevin's seed turn returned non-empty text", kevinSeed.replyText.trim().length > 0);
  goalConv = getConversation(GOAL_EXT)!;
  check("step 3: Kevin's seed turn captured a session id", !!goalConv.claude_session_id);

  // ── DIRECTION A: a companion-thread turn, with the goal-12 digest injected,
  // must reference Kevin's seeded $40 budget cap. ───────────────────────────
  console.log('\n[bridge-proof] === DIRECTION A: companion thread sees goal-12 digest ===');
  const bridgedForCompanion = await buildBridgedContext(companionExt);
  check('DIRECTION A: buildBridgedContext(companion) returned a non-empty digest', bridgedForCompanion.trim().length > 0, 'A');
  check('DIRECTION A: digest is tagged with the goal-12 source', bridgedForCompanion.includes(`source="${GOAL_EXT}"`), 'A');

  const DIRECTION_A_MSG =
    "Before I add more to the wish catalog — did we ever land on a per-kid budget limit? I don't remember us settling on a number.";
  const memBlockA = (await import(path.join(distDir, 'prompt.js'))).loadMemoryBlock(undefined, companionProfile);
  const directionAStdin = bridgedForCompanion + `<memory_refresh>\n${memBlockA}\n</memory_refresh>\n\n${DIRECTION_A_MSG}`;
  const resultA = await runClaude(directionAStdin, herSeed.sessionIdAfter, undefined, companionRuntime as never);
  console.log(`--- DIRECTION A reply ---\n${resultA.text}\n--- end DIRECTION A reply ---`);
  addTurn(companionConv.id, 'user', DIRECTION_A_MSG, undefined, undefined, undefined, { claudeInput: JSON.stringify({ directionAStdin }) });
  addTurn(companionConv.id, 'assistant', resultA.text, undefined, undefined, undefined, { model: resultA.model ?? undefined, claudeOutput: resultA.rawOutput });

  const directionAPass = resultA.text.includes('40');
  check(
    `DIRECTION A: her reply references Kevin's seeded $40 budget cap from the goal-12 digest — evidence: "${resultA.text.slice(0, 300)}"`,
    directionAPass,
    'A',
  );
  // Scan only the digest's INNER content (the summary text itself), not the
  // wrapping `<bridged_context source="cockpit:goal-12">` tag — the source
  // attribute necessarily echoes the partner thread's own external_id, which
  // would trip the "cockpit" term as a false positive unrelated to whether
  // operator/autonomy-dial language leaked into the SUMMARIZED CONTENT.
  const bridgedForCompanionInner = bridgedForCompanion.replace(/<bridged_context[^>]*>|<\/bridged_context>/g, '');
  const directionAOperatorHits = operatorVocabHits(bridgedForCompanionInner);
  check(
    `ADVISORY (#276, informational): the goal-12 digest's SUMMARIZED CONTENT injected into the companion thread carries NO operator/autonomy-dial vocabulary — evidence: ${JSON.stringify(directionAOperatorHits)}`,
    directionAOperatorHits.length === 0,
  );

  // ── DIRECTION B: a goal-12 thread turn, with the companion digest injected,
  // must reference her seeded Lola/Bluey detail. ────────────────────────────
  console.log('\n[bridge-proof] === DIRECTION B: goal-12 thread sees companion digest ===');
  const bridgedForGoal = await buildBridgedContext(GOAL_EXT);
  check('DIRECTION B: buildBridgedContext(goal-12) returned a non-empty digest', bridgedForGoal.trim().length > 0, 'B');
  check('DIRECTION B: digest is tagged with the companion thread source', bridgedForGoal.includes(`source="${companionExt}"`), 'B');

  // Explicitly steers away from the full JARVIS tool surface (a cockpit:goal-*
  // thread's system prompt gives the model the real tools block, so an
  // open-ended "what's she flagged" question invites a `goals` tool call
  // instead of a direct answer). This harness is proving the bridged DIGEST
  // surfaces in the model's answer, not JARVIS's general tool-use judgment —
  // so the question is framed to request a direct read of already-injected
  // context, same as asking a person "off the top of your head, no lookups."
  const DIRECTION_B_MSG =
    "Quick one, no need to pull up any tools or look anything up — just off the top of your head from what's already in front of you: what's the latest specific item she's flagged for the wish catalog?";
  const memBlockB = (await import(path.join(distDir, 'prompt.js'))).loadMemoryBlock(undefined, goalProfile);
  const directionBStdin = bridgedForGoal + `<memory_refresh>\n${memBlockB}\n</memory_refresh>\n\n${DIRECTION_B_MSG}`;
  const resultB = await runClaude(directionBStdin, kevinSeed.sessionIdAfter, undefined, goalRuntime as never);
  console.log(`--- DIRECTION B reply ---\n${resultB.text}\n--- end DIRECTION B reply ---`);
  addTurn(goalConv.id, 'user', DIRECTION_B_MSG, undefined, undefined, undefined, { claudeInput: JSON.stringify({ directionBStdin }) });
  addTurn(goalConv.id, 'assistant', resultB.text, undefined, undefined, undefined, { model: resultB.model ?? undefined, claudeOutput: resultB.rawOutput });

  const resultBLower = resultB.text.toLowerCase();
  const directionBPass = resultBLower.includes('lola') && resultBLower.includes('bluey');
  check(
    `DIRECTION B: Kevin's reply references her seeded Lola/Bluey detail from the companion digest — evidence: "${resultB.text.slice(0, 300)}"`,
    directionBPass,
    'B',
  );

  // ── Persistence sanity: both conversations now hold their full turn sets ──
  const companionTurns = getTurns(companionConv.id);
  const goalTurns = getTurns(goalConv.id);
  check('persistence: companion thread holds 4 turns (seed pair + direction-A pair)', companionTurns.length === 4);
  check('persistence: goal-12 thread holds 4 turns (seed pair + direction-B pair)', goalTurns.length === 4);

  const verdict = !directionAFailed && !directionBFailed ? 'PASS' : 'FAIL';
  const failingDirections = [directionAFailed ? 'A' : null, directionBFailed ? 'B' : null].filter(Boolean);

  const artifact = {
    generatedAt: new Date().toISOString(),
    scratchDbPath: DB_PATH,
    companionExternalId: companionExt,
    goalExternalId: GOAL_EXT,
    seeds: { herSeed: SEED_HER_MSG, kevinSeed: SEED_KEVIN_MSG },
    directionA: {
      pass: directionAPass,
      bridgedDigest: bridgedForCompanion,
      userMessage: DIRECTION_A_MSG,
      stdinSent: directionAStdin,
      reply: resultA.text,
      operatorVocabHitsInDigest: directionAOperatorHits,
    },
    directionB: {
      pass: directionBPass,
      bridgedDigest: bridgedForGoal,
      userMessage: DIRECTION_B_MSG,
      stdinSent: directionBStdin,
      reply: resultB.text,
    },
    verdict,
    failingDirections,
    overallFailed: failed,
  };
  fs.writeFileSync('/tmp/companion-bridge-proof-output.json', JSON.stringify(artifact, null, 2));
  console.log('\n[bridge-proof] wrote /tmp/companion-bridge-proof-output.json');

  console.log(`\nVERDICT: ${verdict}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
