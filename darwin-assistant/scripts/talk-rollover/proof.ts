/**
 * END-TO-END PROOF of the Talk-seat rollover (goal #19) — NOT hermetic: it makes
 * TWO real Claude-B one-shots (the day-card writer + a fresh-head recall). It is
 * isolated to a throwaway DB + temp days dir and to the test seat
 * cockpit:alpha-talk-rollover-test, so it never touches the real alpha-talk seat
 * or its days folder.
 *
 * It proves the load-bearing claim: a fresh session seeded ONLY by the digest
 * day card can recall yesterday's work. Scores a 10-question recall check and
 * reports tokens-per-step before (the bloated session) vs after (the fresh head).
 *
 * Run (needs Claude B authed + headroom):
 *   JARVIS_DB_PATH=/tmp/talk-rollover-proof.db npx tsx scripts/talk-rollover/proof.ts
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sqliteDb, getConversation, addTurn } from '../../src/conversation-db.js';
import { runTalkRollover, runDayCardOneShot, buildSeedSection, measureSessionTokens, type RolloverTarget } from '../../src/talk-rollover.js';
import { findClaudeAccount } from '../../src/claude-accounts.js';

const MODEL = 'claude-haiku-4-5-20251001'; // conservative: if haiku recalls, the real (bigger) seat certainly does
const TEST_EXT = 'cockpit:alpha-talk-rollover-test';

// A realistic "day" with 10 checkable facts baked in.
const DAY: Array<[string, string]> = [
  ['user', "Morning. Let's get the Harbor dashboard out the door today."],
  ['assistant', "On it. I shipped the Harbor dashboard to the STAGING environment this morning on branch feat/harbor-filters. Preview is up."],
  ['user', "Nice. What about the SSO migration we talked about?"],
  ['assistant', "I'd defer the SSO migration to November — it's not blocking Harbor and the rollback plan still needs review. Parked it."],
  ['user', "Agreed, defer SSO to November. Anything break?"],
  ['assistant', "Found one bug: the CSV export mangles rows that contain commas. Logged it. Not a launch blocker for Harbor."],
  ['user', "Good catch. Did you kick off the billing work?"],
  ['assistant', "Yes — spawned a lane, tree-77a2, for the billing reconciler. It's running now and owes a first pass by tonight."],
  ['user', "Remind me to call the vendor tomorrow."],
  ['assistant', "Noted: call the vendor Brightline tomorrow. Also, this week's revenue came in at $48,200."],
  ['user', "Where's the writeup?"],
  ['assistant', "I created outbox/harbor/README.md with the launch notes. Still open: we're waiting on Mike's Lovable build for the intake form, and the SSO rollback plan needs a review before November."],
];

// 10 recall questions, each with the keyword(s) that prove a real recall.
const QUESTIONS: Array<{ q: string; expect: string[] }> = [
  { q: '1. What is the name of the dashboard we shipped, and to which environment?', expect: ['harbor', 'staging'] },
  { q: '2. What branch was it on?', expect: ['feat/harbor-filters'] },
  { q: '3. What did we decide about the SSO migration?', expect: ['defer', 'november'] },
  { q: '4. What bug did we find?', expect: ['csv', 'comma'] },
  { q: '5. What lane/tree is running the billing reconciler?', expect: ['tree-77a2'] },
  { q: '6. Which vendor am I supposed to call tomorrow?', expect: ['brightline'] },
  { q: "7. What was this week's revenue?", expect: ['48,200'] },
  { q: '8. What are we waiting on from Mike?', expect: ['intake form'] },
  { q: '9. What file did you create for the launch notes?', expect: ['outbox/harbor/readme.md'] },
  { q: '10. What still needs review before November?', expect: ['rollback'] },
];

function askB(prompt: string, model = MODEL, timeoutMs = 90_000): Promise<{ text: string; inputTokens: number; cacheRead: number }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY;
    env.CLAUDE_CONFIG_DIR = findClaudeAccount('b')?.config_dir ?? '/home/kevin/.claude-b';
    const child = spawn(process.env.CLAUDE_CLI_PATH || 'claude',
      ['--print', '-', '--output-format', 'stream-json', '--verbose', '--model', model],
      { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', settled = false;
    const to = setTimeout(() => { if (!settled) { settled = true; child.kill('SIGTERM'); reject(new Error('recall timed out')); } }, timeoutMs);
    to.unref?.();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(to); reject(e); } });
    child.on('close', (code) => {
      if (settled) return; settled = true; clearTimeout(to);
      if (code !== 0) return reject(new Error(`recall exited ${code}: ${stderr.slice(0, 200)}`));
      let text = '', inputTokens = 0, cacheRead = 0;
      for (const line of stdout.split(/\r?\n/)) {
        const t = line.trim(); if (!t) continue;
        try {
          const e = JSON.parse(t) as any;
          const content = e.message?.content;
          if (e.type === 'assistant' && Array.isArray(content))
            for (const b of content) if (b.type === 'text' && typeof b.text === 'string') text += b.text;
          if (e.type === 'result' && typeof e.result === 'string') text = e.result;
          const u = e.usage || e.message?.usage;
          if (u) { inputTokens = u.input_tokens ?? inputTokens; cacheRead = u.cache_read_input_tokens ?? cacheRead; }
        } catch { /* non-json line */ }
      }
      resolve({ text: text.trim(), inputTokens, cacheRead });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

async function main() {
  const daysRoot = mkdtempSync(path.join(os.tmpdir(), 'talk-proof-days-'));
  const target: RolloverTarget = { externalId: TEST_EXT, daysDir: path.join(daysRoot, 'days') };
  console.log(`PROOF: talk-seat rollover end-to-end on ${TEST_EXT}\n  DB=${process.env.JARVIS_DB_PATH}\n  days=${target.daysDir}\n`);

  // build the test seat + a bloated session (simulate the real 1M+ cache reads)
  sqliteDb.prepare(`INSERT INTO conversations (external_id, slack_channel) VALUES (?, NULL)`).run(TEST_EXT);
  const cid = getConversation(TEST_EXT)!.id;
  sqliteDb.prepare(`UPDATE conversations SET claude_session_id='proof-bloated-session', session_adapter='claude', session_account='b' WHERE id=?`).run(cid);
  let step = 0;
  for (const [role, content] of DAY) {
    if (role === 'assistant') {
      step++;
      // grow the replayed context like the real seat: ~250k per step up to ~1.5M
      addTurn(cid, 'assistant', content, undefined, undefined, undefined,
        { inputTokens: 12, cacheReadTokens: 250_000 * step, cacheWriteTokens: 20_000 });
    } else {
      addTurn(cid, 'user', content);
    }
  }
  const before = measureSessionTokens(cid);
  console.log(`[before] bloated session replays ~${before.replayed.toLocaleString()} tokens on its last step (input ${before.input} + cacheRead ${before.cacheRead.toLocaleString()} + cacheWrite ${before.cacheWrite.toLocaleString()})`);

  // FORCE one real rollover (real B writer one-shot, kill switch bypassed for the proof)
  console.log('\n[rollover] running the REAL B day-card writer…');
  const res = await runTalkRollover({ target, runOneShot: runDayCardOneShot, isActive: () => false, bypassKillSwitch: true, trigger: 'manual' });
  if (!res.ran) throw new Error(`rollover did not run: ${res.reason}`);
  console.log(`[rollover] ${res.reason}`);
  const conv = getConversation(TEST_EXT)!;
  console.log(`[rollover] session cleared? ${conv.claude_session_id === null ? 'YES' : 'NO (' + conv.claude_session_id + ')'}`);
  const bump = sqliteDb.prepare(`SELECT content FROM turns WHERE conversation_id=? AND role='bump'`).get(cid) as any;
  console.log(`[rollover] divider posted? ${bump ? 'YES — ' + bump.content : 'NO'}`);
  const card = readFileSync(res.cardFile!, 'utf8');
  console.log(`\n[card] ${res.cardFile}  (${card.length} chars)\n${card.split('\n').slice(0, 40).join('\n')}\n…`);

  // fresh head: seed from the day card ONLY, then answer the 10 questions
  const seed = buildSeedSection({ daysDir: target.daysDir, openItems: ['call the vendor Brightline', 'review the SSO rollback plan'] });
  const recallPrompt =
    `You are JARVIS resuming Kevin's front-seat chat on a FRESH session. You do NOT have yesterday's transcript — only this carried-forward context:\n\n` +
    `${seed}\n\n` +
    `Answer these questions using ONLY the context above. Be concise, one line each, numbered to match.\n` +
    QUESTIONS.map((x) => x.q).join('\n');
  console.log(`\n[recall] fresh-head seed is ${seed.length} chars (~${Math.round(seed.length / 4).toLocaleString()} tokens). Asking ${QUESTIONS.length} questions on a fresh B session…`);
  const ans = await askB(recallPrompt);
  const answer = ans.text.toLowerCase();
  let score = 0;
  for (const { q, expect } of QUESTIONS) {
    const got = expect.every((e) => answer.includes(e.toLowerCase()));
    if (got) score++;
    console.log(`  ${got ? '✓' : '✗'} ${q.split('.')[0]}  expect[${expect.join(', ')}]`);
  }
  const afterReplayed = (ans.inputTokens || 0) + (ans.cacheRead || 0);
  console.log(`\n[after] fresh head's recall step read ~${afterReplayed.toLocaleString()} tokens (input ${ans.inputTokens} + cacheRead ${ans.cacheRead.toLocaleString()})`);
  console.log(`\n==== RECALL SCORE: ${score}/${QUESTIONS.length} (pass = >=9) ====`);
  console.log(`==== TOKENS/STEP: before ~${before.replayed.toLocaleString()}  →  after ~${afterReplayed.toLocaleString()}  (${before.replayed > 0 ? Math.round((1 - afterReplayed / before.replayed) * 100) : 0}% smaller) ====`);
  console.log('\n--- full recall answer ---\n' + ans.text);

  rmSync(daysRoot, { recursive: true, force: true });
  if (score < 9) { console.error('\nPROOF FAILED: recall below 9/10'); process.exit(1); }
  console.log('\nPROOF PASSED');
}

main().catch((e) => { console.error('PROOF ERROR:', e); process.exit(1); });
