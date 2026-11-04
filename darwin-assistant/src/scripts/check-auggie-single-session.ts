// DAR-759 smoke test — Augment (auggie) is ONE session regardless of model.
//
// This repo has no unit-test framework; it runs standalone checks via tsx the
// same way the src/scripts/* pollers run. This script exercises the REAL
// session-adapter resolution + the resume-vs-replay predicate from agent.ts and
// asserts:
//   1. Switching model WITHIN auggie keeps one session (adapter unchanged ->
//      the switch predicate is false -> session id preserved, NO replay built).
//   2. Switching PROVIDER still trips the predicate (session nulled -> replay).
//   3. A legacy row with only an auggie shelf model name (e.g. "gpt-5.5") and
//      no session_adapter no longer mis-resolves to codex/claude while running
//      through auggie.
//
// Run: JARVIS_DB_PATH=/tmp/dar759-check.db npx tsx src/scripts/check-auggie-single-session.ts
import { resolveSessionAdapter, adapterFromModel } from '../agent.js';
import type { ConversationRow, TurnRow } from '../conversation-db.js';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}` + (pass ? '' : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`));
}

// Minimal fixtures — resolveSessionAdapter only reads conv.session_adapter and
// turns[i].model, so we cast partials rather than build full rows.
function conv(session_adapter: string | null): ConversationRow {
  return { session_adapter, claude_session_id: 'sess-abc' } as unknown as ConversationRow;
}
function turn(model: string | null): TurnRow {
  return { model } as unknown as TurnRow;
}

// The exact resume-vs-replay predicate from runConversationTurn (agent.ts):
//   a fresh session is built (replay) IFF sessionId && stored && stored !== adapter.id
function wouldReplay(storedAdapter: string | null, currentAdapterId: string, sessionId: string | null): boolean {
  return !!sessionId && !!storedAdapter && storedAdapter !== currentAdapterId;
}

console.log('--- resolveSessionAdapter: session_adapter is authoritative ---');
check('stored=auggie wins over shelf model gpt-5.5', resolveSessionAdapter(conv('auggie'), [turn('gpt-5.5')], 'auggie'), 'auggie');
check('stored=claude respected', resolveSessionAdapter(conv('claude'), [turn('claude-opus-4-8')], 'claude'), 'claude');

console.log('\n--- resolveSessionAdapter: legacy rows (no session_adapter) ---');
// The bug: an auggie turn whose model is "gpt-5.5" used to mis-resolve to codex.
check('legacy auggie shelf model gpt-5.5 while running auggie -> auggie (not codex)', resolveSessionAdapter(conv(null), [turn('gpt-5.5')], 'auggie'), 'auggie');
check('legacy auggie shelf model claude-opus while running auggie -> auggie (not claude)', resolveSessionAdapter(conv(null), [turn('claude-opus-4-8')], 'auggie'), 'auggie');
// Non-auggie legacy inference still works as before.
check('legacy gpt-5.5 while running codex -> codex', resolveSessionAdapter(conv(null), [turn('gpt-5.5')], 'codex'), 'codex');
check('legacy claude model while running claude -> claude', resolveSessionAdapter(conv(null), [turn('claude-opus-4-8')], 'claude'), 'claude');
check('adapterFromModel unchanged for real openai model', adapterFromModel('gpt-5.5'), 'codex');

console.log('\n--- Scenario 3: switch model WITHIN auggie = NO replay, session preserved ---');
{
  // Session was minted by auggie; now the runtime adapter is still auggie but a
  // different shelf model was picked. storedSessionAdapter must resolve to auggie.
  const stored = resolveSessionAdapter(conv('auggie'), [turn('claude-opus-4-8'), turn('gpt-5.5')], 'auggie');
  check('within-auggie stored adapter resolves to auggie', stored, 'auggie');
  check('within-auggie: wouldReplay is FALSE (session preserved)', wouldReplay(stored, 'auggie', 'sess-abc'), false);
}

console.log('\n--- Scenario 1/2: switch PROVIDER = replay still fires ---');
{
  const storedFromAuggie = resolveSessionAdapter(conv('auggie'), [turn('gpt-5.5')], 'claude');
  check('auggie -> claude: replay fires', wouldReplay(storedFromAuggie, 'claude', 'sess-abc'), true);
  const storedFromClaude = resolveSessionAdapter(conv('claude'), [turn('claude-opus-4-8')], 'auggie');
  check('claude -> auggie: replay fires', wouldReplay(storedFromClaude, 'auggie', 'sess-abc'), true);
  const storedFromCodex = resolveSessionAdapter(conv('codex'), [turn('gpt-5.5')], 'claude');
  check('codex -> claude: replay fires', wouldReplay(storedFromCodex, 'claude', 'sess-abc'), true);
}

console.log('\n--- Edge: no prior session -> never a replay regardless of adapters ---');
check('no session id: wouldReplay false', wouldReplay('claude', 'auggie', null), false);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
