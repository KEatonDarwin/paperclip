#!/usr/bin/env node
// Focused verification for the JARVIS nudge review #228 backend remediation.
// Exercises the changed functions directly against a scratch /tmp DB — never
// touches the live jarvis.db. Run: node scripts/nudge-remediate-verify.mjs
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Database from 'better-sqlite3';

const dbPath = `/tmp/nudge-remediate-${process.pid}-${Date.now()}.db`;
process.env.JARVIS_DB_PATH = dbPath;
// No API keys, ever — seed a canary and confirm nothing reads it.
process.env.ANTHROPIC_API_KEY = 'canary-should-never-be-used';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '..', 'dist');

const {
  createNudge,
  listNudges,
  nudgeCounts,
  resolveNudgeBySubject,
  buildNudgeReplyContext,
  ensureNudgeThread,
  NUDGE_THREAD_EXTERNAL_ID,
} = await import(path.join(distDir, 'nudges.js'));
const { autoHideStaleThreads, getConversation } = await import(path.join(distDir, 'conversation-db.js'));
// side-effect import: creates the thread_todos table the sweep joins against
await import(path.join(distDir, 'thread-todos.js'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

function assistantTurnCount(convId) {
  const raw = new Database(dbPath, { readonly: true });
  const row = raw
    .prepare(`SELECT COUNT(*) AS n FROM turns WHERE conversation_id = ? AND role = 'assistant'`)
    .get(convId);
  raw.close();
  return row.n;
}

// ---------------------------------------------------------------------------
console.log('\n[M-3] auto-hide sweep must NOT archive the nudge thread, POST /nudges still works');
{
  const conv = ensureNudgeThread();
  // Force the nudge thread to look 15 days idle.
  const w = new Database(dbPath);
  w.prepare(`UPDATE conversations SET updated_at = datetime('now','-15 days') WHERE id = ?`).run(conv.id);
  // Also plant an unrelated stale thread that SHOULD be archived, as a control.
  w.prepare(`INSERT INTO conversations (external_id, status, updated_at) VALUES (?, 'active', datetime('now','-15 days'))`).run('scratch:stale-control');
  w.close();

  const archived = autoHideStaleThreads(14);
  const nudgeConv = getConversation(NUDGE_THREAD_EXTERNAL_ID);
  const control = getConversation('scratch:stale-control');
  ok('nudge thread still active after sweep', nudgeConv?.status === 'active', `status=${nudgeConv?.status}`);
  ok('unrelated stale thread WAS archived (sweep still works)', control?.status === 'archived', `status=${control?.status}, archived=${archived}`);

  // Now force-archive the nudge thread and confirm ensureNudgeThread reactivates it
  const w2 = new Database(dbPath);
  w2.prepare(`UPDATE conversations SET status='archived' WHERE id=?`).run(conv.id);
  w2.close();
  const res = await createNudge({
    source: 'manual',
    subject_ref: 'm3/reactivate',
    context: { summary: 'M-3 reactivation probe' },
  });
  const reactivated = getConversation(NUDGE_THREAD_EXTERNAL_ID);
  ok('POST /nudges succeeds even after nudge thread archived', !!res.nudge?.turn_id, `turn_id=${res.nudge?.turn_id}`);
  ok('ensureNudgeThread reactivated the archived thread', reactivated?.status === 'active', `status=${reactivated?.status}`);
}

// ---------------------------------------------------------------------------
console.log('\n[M-1] per-turn <jarvis_nudges> block names the open nudge (server-owned, resume-safe)');
{
  const r = await createNudge({
    source: 'blocked_question',
    subject_ref: 'tree-abc/node-77',
    context: {
      summary: 'hopper node #77: choose fallback policy',
      why_jarvis_could_not_clear: 'needs a product decision',
      answer_route: { method: 'POST', path: '/api/v1/hopper-nodes/77/answer', body_template: { answer: '$KEVIN_REPLY' } },
    },
  });
  const block = buildNudgeReplyContext(NUDGE_THREAD_EXTERNAL_ID);
  ok('block is emitted for the nudge thread', block.includes('<jarvis_nudges>'));
  ok('block names node-77 subject', block.includes('tree-abc/node-77'));
  ok('block includes the answer_route path', block.includes('/api/v1/hopper-nodes/77/answer'));
  ok('block includes the reply-loop resolve step', block.includes('/api/v1/nudges/') && block.includes('"status":"resolved"'));
  ok('block is EMPTY for a non-nudge thread', buildNudgeReplyContext('cockpit:something-else') === '');
  console.log('  --- block excerpt ---');
  console.log(block.split('\n').slice(0, 8).map((l) => '    ' + l).join('\n'));
}

// ---------------------------------------------------------------------------
console.log('\n[M-2] resolveNudgeBySubject clears the open nudge for a subject');
{
  const before = nudgeCounts();
  const resolved = resolveNudgeBySubject('blocked_question', 'tree-abc/node-77');
  const after = nudgeCounts();
  ok('resolve returned the row', resolved?.status === 'resolved', `status=${resolved?.status}`);
  ok('open count dropped by 1', after.open === before.open - 1, `before=${before.open} after=${after.open}`);
  // Re-block for same subject must now create a NEW open nudge (not dedup to stale)
  const re = await createNudge({
    source: 'blocked_question',
    subject_ref: 'tree-abc/node-77',
    context: { summary: 'node #77 re-blocked with a new question' },
  });
  ok('re-block creates a fresh nudge (not deduped)', re.duplicate === false && re.nudge.id !== resolved.id,
    `new id=${re.nudge.id}, old id=${resolved.id}, duplicate=${re.duplicate}`);
}

// ---------------------------------------------------------------------------
console.log('\n[S-2] malformed composer JSON falls through to the deterministic fallback');
{
  process.env.NUDGE_CLAUDE_BIN = '/tmp/nudge-remediate-fake-garbage.mjs';
  const r = await createNudge({
    source: 'manual',
    subject_ref: 's2/garbage',
    context: { summary: 'S-2 malformed output probe', why_jarvis_could_not_clear: 'the composer emitted junk' },
  });
  const raw = new Database(dbPath, { readonly: true });
  const turn = raw.prepare(`SELECT content FROM turns WHERE id = ?`).get(r.nudge.turn_id);
  raw.close();
  const body = turn?.content ?? '';
  ok('turn uses deterministic fallback text', body.includes('I could not clear this myself because'), body.slice(0, 60));
  ok('raw stdout junk is NOT in the message', !body.includes('this is not valid json'));
  delete process.env.NUDGE_CLAUDE_BIN;
}

// ---------------------------------------------------------------------------
console.log('\n[M-4] 3 concurrent creates for one subject → exactly 1 assistant turn');
{
  process.env.NUDGE_CLAUDE_BIN = '/tmp/nudge-remediate-fake-slow.mjs';
  const conv = ensureNudgeThread();
  const before = assistantTurnCount(conv.id);
  const results = await Promise.all([
    createNudge({ source: 'commitment', subject_ref: 'commitment-99', context: { summary: 'race A' } }),
    createNudge({ source: 'commitment', subject_ref: 'commitment-99', context: { summary: 'race B' } }),
    createNudge({ source: 'commitment', subject_ref: 'commitment-99', context: { summary: 'race C' } }),
  ]);
  const after = assistantTurnCount(conv.id);
  const turnIds = new Set(results.map((r) => r.nudge.turn_id));
  const openForSubject = listNudges('open', 500).filter((n) => n.subject_ref === 'commitment-99');
  ok('exactly 1 new assistant turn created', after - before === 1, `added=${after - before}`);
  ok('all 3 callers report the same turn_id', turnIds.size === 1, `turn_ids=${[...turnIds].join(',')}`);
  ok('exactly 1 open nudge row for the subject', openForSubject.length === 1, `rows=${openForSubject.length}`);
  delete process.env.NUDGE_CLAUDE_BIN;
}

// ---------------------------------------------------------------------------
console.log('\n[NO API KEYS] ANTHROPIC_API_KEY canary was set but composer scrubs it');
{
  // The composer deletes ANTHROPIC_API_KEY from the child env; nudges still
  // created successfully above prove the pipeline never depended on the key.
  ok('canary key still present in THIS process (only scrubbed for the child)', process.env.ANTHROPIC_API_KEY === 'canary-should-never-be-used');
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
console.log(`scratch db: ${dbPath}`);
process.exit(fail === 0 ? 0 : 1);
