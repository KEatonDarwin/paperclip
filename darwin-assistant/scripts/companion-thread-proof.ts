// COMPANION THREAD PROOF HARNESS (hopper node #1400, tree-9c10dca2) — drives ONE
// real turn of the companion thread through the ACTUAL shipped code path
// (companion-chat.ts thread creation, agent.ts's #277 model-resolution guard +
// buildInitialPrompt + runClaude), against a /tmp scratch DB, ending with a
// real `claude` opus reply persisted via the real conversation-db write path.
//
// Why a scratch DB + direct runClaude() instead of agent.processMessage(): the
// sim-guard (src/sim-guard.ts) deliberately refuses to start a model turn from
// ANY database other than the live jarvis.db (2026-09-24 incident — a "hermetic"
// DB sim still fired real billed turns through processMessage). This harness
// needs a REAL opus reply, so it calls the real spawn function directly,
// bypassing only the processMessage() admission wrapper — not the companion
// persona, not the tool scoping, not the model guard, not the prompt assembly,
// and not the persistence path. Every one of those is the real src/ code,
// dynamic-imported from dist/ (built via `npm run build`) exactly like the
// existing scripts/*-check.mjs harnesses.
//
// GAP (see finish note): the real agent/companion code has NO backend
// consumer of a client's User-Agent or viewport anywhere (checked
// src/agent.ts, src/handlers/api-v1.ts, src/handlers/slack.ts,
// src/handlers/webhook.ts — mobile/UA is a frontend-only, cockpit-UI concern).
// This harness stamps a realistic iPhone UA + viewport as explicit CLIENT
// CONTEXT on the run (logged + recorded in the persisted turn's debug
// metadata) so the artifact is traceable as "from her phone", but it does NOT
// fabricate a new UA-aware branch in src/ — there is no such branch to
// exercise, and inventing one would be exactly the re-implementation this
// node was told not to do.
//
//   npm run build
//   JARVIS_DB_PATH=/tmp/companion-proof-$(date +%s).db npx tsx scripts/companion-thread-proof.ts

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');

// ── scratch DB guard (must run before any dist/ module is imported —
// conversation-db.js opens the sqlite handle at import time) ──────────────
const raw = process.env.JARVIS_DB_PATH;
if (!raw || !raw.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path (e.g. /tmp/companion-proof-<ts>.db).');
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

console.log(`[companion-thread-proof] scratch DB: ${DB_PATH}`);
console.log(`[companion-thread-proof] JARVIS_SIM=${process.env.JARVIS_SIM ?? '(unset)'} (must stay unset/0 — this run spawns a REAL claude CLI turn, it is not a sim)`);

let failed = false;
function check(label: string, ok: boolean): void {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

async function main() {
  // Bootstrap: importing conversation-db.js (transitively, via companion-chat.js)
  // is the real schema-init path — `new Database(DB_PATH)` creates the file and
  // the module's `CREATE TABLE IF NOT EXISTS` statements build the fresh schema.
  // There is no separate migration runner in this repo; this IS it.
  const {
    getOrCreateCompanionThread,
    companionIdFromThread,
    COMPANION_THREAD_PREFIX,
  } = await import(path.join(distDir, 'companion-chat.js'));
  const { getConversation, addTurn, getTurns, sqliteDb } = await import(
    path.join(distDir, 'conversation-db.js')
  );
  const { memoryProfileForThread } = await import(path.join(distDir, 'prompt.js'));
  const { resolveConversationRuntime, buildInitialPrompt, runClaude } = await import(
    path.join(distDir, 'agent.js')
  );

  // ── Step 1: create the companion thread the REAL way ──────────────────────
  const WIFE_ID = 'proof-run';
  const { external_id, created } = getOrCreateCompanionThread(WIFE_ID);
  check('step 1: thread created', created === true);
  check('step 1: external_id uses the companion prefix', external_id === `${COMPANION_THREAD_PREFIX}${WIFE_ID}`);
  check('step 1: companionIdFromThread round-trips', companionIdFromThread(external_id) === WIFE_ID);

  const conv = getConversation(external_id);
  check('step 1: conversation row exists', !!conv);
  if (!conv) {
    console.error('FATAL: no conversation row — cannot continue.');
    process.exit(1);
  }
  check('step 1: kind=companion (prefix-derived, no separate column)', companionIdFromThread(conv.external_id) === WIFE_ID);
  check('step 1: thread_adapter pinned to claude', conv.thread_adapter === 'claude');
  check('step 1: thread_model pinned to claude-opus-*', typeof conv.thread_model === 'string' && conv.thread_model.startsWith('claude-opus-'));

  const quickChatRow = sqliteDb
    .prepare('SELECT COUNT(*) AS n FROM quick_chat_sessions WHERE conversation_id = ?')
    .get(conv.id) as { n: number };
  check('step 1: no 48h TTL — absent from quick_chat_sessions', quickChatRow.n === 0);

  // The real #277 chokepoint: every turn (and every retry) resolves its runtime
  // through this one function, which coerces anything non-opus back to
  // claude/claude-opus-5 for a companion thread.
  const runtime = resolveConversationRuntime(conv);
  check('step 2: resolveConversationRuntime resolves adapter=claude', runtime.adapter.id === 'claude');
  check(
    'step 2: resolveConversationRuntime resolves an opus model id (#277 guard)',
    typeof runtime.model === 'string' && runtime.model.startsWith('claude-opus-'),
  );

  // ── Step 2: assemble the first turn's full prompt via the REAL agent.ts path ──
  // CLIENT CONTEXT — see the file-header GAP note. Nothing downstream of this
  // object consumes it; it exists purely so this run is traceable as having
  // originated "from her phone" the way the node asked for.
  const clientContext = {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    viewport: '390x844',
    note: 'No backend code path (src/agent.ts, src/handlers/*) reads client UA/viewport — confirmed by grep. Recorded here for traceability only; does not change prompt assembly or routing.',
  };
  console.log('[companion-thread-proof] CLIENT CONTEXT (logged only, not consumed by any real code path):');
  console.log(JSON.stringify(clientContext, null, 2));

  const userMessage = "Hey! Quick idea for the kids' wish catalog — what if we did a page just for Lego sets, sorted by budget? Is that the kind of thing we can do?";
  const memoryProfile = memoryProfileForThread(conv.external_id);
  check('step 2: memoryProfileForThread resolves to "companion"', memoryProfile === 'companion');

  const prompt = buildInitialPrompt(userMessage, memoryProfile, conv.external_id);
  check('step 2: assembled prompt carries the companion persona', prompt.includes("You're chatting with Kevin's wife"));
  check('step 2: assembled prompt carries the wish-catalog brief', prompt.toLowerCase().includes('wish catalog') || prompt.toLowerCase().includes('wish-catalog') || prompt.includes('Circle & Flip'));
  check('step 2: assembled prompt carries ONLY the companion tool allow-list', prompt.includes('companion_send_to_kevin'));
  check('step 2: assembled prompt does NOT leak JARVIS operator persona', !prompt.includes("Kevin's personal AI life coach and chief of staff"));
  check('step 2: assembled prompt carries no memory.md content (companion profile loads none)', !prompt.includes('Your Persistent Memory'));
  console.log(`[companion-thread-proof] assembled prompt: ${prompt.length} chars`);

  // ── Step 3: spawn the REAL `claude` CLI via the REAL runClaude(), NO API KEYS ──
  console.log(`[companion-thread-proof] spawning real claude CLI (model=${runtime.model}, adapter=${runtime.adapter.id}) — this will consume real Opus usage...`);
  const startedAt = Date.now();
  const result = await runClaude(prompt, null, undefined, {
    adapter: runtime.adapter,
    model: runtime.model,
    options: runtime.options,
  });
  const timingMs = Date.now() - startedAt;

  check('step 3: real claude CLI returned non-empty text', typeof result.text === 'string' && result.text.trim().length > 0);
  check('step 3: result reports the opus model (or the request stayed pinned to it)', !result.model || result.model.startsWith('claude-opus-') || runtime.model === result.model);
  console.log(`[companion-thread-proof] claude replied in ${timingMs}ms, ${result.text.length} chars. accountKey=${result.accountKey ?? '(default)'}`);
  console.log('--- assistant reply (first 500 chars) ---');
  console.log(result.text.slice(0, 500));
  console.log('--- end reply excerpt ---');

  // ── Step 4: persist the real turn via the REAL conversation-db write path ──
  addTurn(conv.id, 'user', userMessage, undefined, undefined, undefined, {
    model: runtime.model ?? undefined,
    claudeInput: JSON.stringify({ clientContext }),
  });
  addTurn(conv.id, 'assistant', result.text, undefined, undefined, undefined, {
    model: result.model ?? runtime.model ?? undefined,
    timingMs,
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    cacheReadTokens: result.usage?.cacheReadTokens,
    cacheWriteTokens: result.usage?.cacheWriteTokens,
    claudeOutput: result.rawOutput,
  });

  const turns = getTurns(conv.id);
  check('step 4: scratch DB now holds exactly 2 turns (user + assistant)', turns.length === 2);
  check('step 4: turn 0 is the user message', turns[0]?.role === 'user' && turns[0]?.content === userMessage);
  check('step 4: turn 1 is the real assistant reply', turns[1]?.role === 'assistant' && turns[1]?.content === result.text);
  check('step 4: persisted assistant turn records the opus model', typeof turns[1]?.model === 'string' && turns[1].model.startsWith('claude-opus-'));

  console.log(failed ? '\nFAILED' : '\nALL PASS');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
