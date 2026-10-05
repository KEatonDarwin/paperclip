#!/usr/bin/env node
// COMPANION NEVER-FRONTIER MODEL GUARD CHECK — acceptance test for node #1398
// (tree-461d2d3d, "Companion chat thread type routed to Opus — Never-frontier
// model guard"). Scratch DB, no HTTP, no model calls.
//
// Proves resolveConversationRuntime() (the single chokepoint every
// runConversationTurn call — initial, session-expiry retry, context-overflow
// retry, and account-rescue retry — funnels through once per turn, agent.ts
// ~1404-1729) ALWAYS resolves a companion thread to a claude-opus-* model,
// regardless of what's actually stored on the thread:
//
//   (1) companion thread forced to adapter=claude, model=claude-fable-5-1
//       (a real Fable id) -> resolves to claude/claude-opus-5.
//   (2) companion thread forced to adapter=codex, model=gpt-5.5 (a real
//       non-Anthropic id) -> resolves to claude/claude-opus-5.
//   (3) companion thread forced to adapter=claude, model=NULL (empty/no
//       override) -> resolves to claude/claude-opus-5.
//   (4) continuation path: resolving the SAME companion thread a second time
//       (simulating the next turn re-resolving runtime) still yields
//       claude-opus-*, for every one of the above three forced states.
//   (5) control: a NON-companion thread forced to model=claude-fable-5-1
//       still resolves to claude-fable-5-1 unchanged — the guard is
//       companion-only and does not touch any other thread kind.
//
// Imports the real companion-chat.js/conversation-db.js/agent.js modules so
// this exercises production code, not a re-implementation of it.
//
//   npm run companion-model-guard:check
//   (= npm run build && JARVIS_DB_PATH=/tmp/companion-model-guard-check.db node scripts/companion-model-guard-check.mjs)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── scratch DB guard (same pattern as companion-thread-check.mjs) ──────────
const raw = process.env.JARVIS_DB_PATH;
if (!raw || !raw.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must be set to a scratch path.');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

process.env.JARVIS_SIM = '1';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

console.log(`[companion-model-guard-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { getOrCreateCompanionThread } = await import(path.join(distDir, 'companion-chat.js'));
const { getOrCreateConversation, getConversation, setThreadModelOverride } = await import(
  path.join(distDir, 'conversation-db.js')
);
const { resolveConversationRuntime } = await import(path.join(distDir, 'agent.js'));

let failed = false;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

function isOpus(model) {
  return typeof model === 'string' && model.startsWith('claude-opus-');
}

// ── (1)-(3) companion thread forced to each never-frontier state ───────────
const { external_id: companionExt } = getOrCreateCompanionThread('guard-check');

const cases = [
  { label: 'forced claude-fable-5-1', adapter: 'claude', model: 'claude-fable-5-1' },
  { label: 'forced codex/gpt-5.5 (non-anthropic provider)', adapter: 'codex', model: 'gpt-5.5' },
  { label: 'forced empty (claude adapter, null model)', adapter: 'claude', model: null },
];

for (const c of cases) {
  setThreadModelOverride(getConversation(companionExt).id, c.adapter, c.model);

  const conv = getConversation(companionExt);
  check(`(1-3) ${c.label}: stored as requested before resolution`, conv.thread_adapter === c.adapter && conv.thread_model === c.model);

  const resolved = resolveConversationRuntime(conv);
  check(`(1-3) ${c.label}: resolves to claude adapter`, resolved.adapter.id === 'claude');
  check(`(1-3) ${c.label}: resolves to a claude-opus-* model`, isOpus(resolved.model));
  check(`(1-3) ${c.label}: resolves to exactly claude-opus-5`, resolved.model === 'claude-opus-5');

  // ── (4) continuation path: re-resolving the same (now-persisted) thread a
  // second time, as the next turn would, still yields the opus coercion —
  // this isn't a one-shot fluke tied to the write that just happened.
  const convAgain = getConversation(companionExt);
  const resolvedAgain = resolveConversationRuntime(convAgain);
  check(`(4) ${c.label}: continuation re-resolution still claude-opus-*`, isOpus(resolvedAgain.model) && resolvedAgain.adapter.id === 'claude');
}

// ── (5) control: non-companion thread is untouched ─────────────────────────
const plain = getOrCreateConversation('cockpit:not-companion-guard-check');
setThreadModelOverride(plain.id, 'claude', 'claude-fable-5-1');
const plainConv = getConversation('cockpit:not-companion-guard-check');
const plainResolved = resolveConversationRuntime(plainConv);
check('(5) control: non-companion thread keeps claude adapter', plainResolved.adapter.id === 'claude');
check('(5) control: non-companion thread keeps claude-fable-5-1 unchanged (guard is companion-only)', plainResolved.model === 'claude-fable-5-1');

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
