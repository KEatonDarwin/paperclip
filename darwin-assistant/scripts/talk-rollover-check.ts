/**
 * Hermetic check for the Talk-seat daily rollover (src/talk-rollover.ts).
 *
 * Runs against a throwaway JARVIS_DB_PATH with JARVIS_SIM=1 and CLAUDE_CLI_PATH
 * pointed at /bin/false, so NO real model turn can fire. Every load-bearing claim
 * is proven by MUTATION and by asserting the on-disk file actually changed — a
 * test written only from the implementation's own happy path proves nothing
 * (testing-discipline SKILL).
 *
 * Run: JARVIS_DB_PATH=/tmp/talk-rollover-check.db JARVIS_SIM=1 \
 *      CLAUDE_CLI_PATH=/bin/false npx tsx scripts/talk-rollover-check.ts
 */
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sqliteDb, getConversation, getSetting, setSetting, addTurn } from '../src/conversation-db.js';
import {
  runTalkRollover,
  measureSessionTokens,
  gatherTurnsSince,
  buildSeedSection,
  pickCardPath,
  cardDateFor,
  rolloverEnabled,
  sortCardFiles,
  buildDayCardPrompt,
  KILL_SWITCH_KEY,
  type RolloverTarget,
  type DayTurn,
} from '../src/talk-rollover.js';

let passed = 0;
let failed = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; fails.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const daysRoot = mkdtempSync(path.join(os.tmpdir(), 'talk-rollover-days-'));

function freshConv(ext: string): number {
  sqliteDb.prepare(`INSERT INTO conversations (external_id, slack_channel) VALUES (?, NULL)`).run(ext);
  return getConversation(ext)!.id;
}
function setSession(convId: number, sid: string | null): void {
  sqliteDb.prepare(
    `UPDATE conversations SET claude_session_id=?, session_adapter='claude', session_account='b' WHERE id=?`,
  ).run(sid, convId);
}
function addUser(convId: number, content: string): void { addTurn(convId, 'user', content); }
function addAsst(convId: number, content: string, tokens?: { input?: number; cacheRead?: number; cacheWrite?: number }): void {
  addTurn(convId, 'assistant', content, undefined, undefined, undefined, {
    inputTokens: tokens?.input, cacheReadTokens: tokens?.cacheRead, cacheWriteTokens: tokens?.cacheWrite,
  });
}
function target(ext: string): RolloverTarget {
  return { externalId: ext, daysDir: path.join(daysRoot, ext.replace(/[^a-z0-9]/gi, '_')) };
}
const FIXED_NOW = new Date('2026-10-26T09:00:00Z');
const okOneShot = (marker: string) => async () =>
  `## Done\n- ${marker}\n\n## Still open\n- carry this forward: ${marker}\n`;

async function main() {
  console.log('talk-rollover hermetic check\n');

  // ── A. kill switch OFF (default) → no-op, nothing touched ──────────────────
  {
    const t = target('cockpit:test-a');
    const cid = freshConv(t.externalId);
    setSession(cid, 'sess-A');
    addUser(cid, 'hello'); addAsst(cid, 'hi');
    ok('A1 default is OFF', rolloverEnabled() === false);
    const res = await runTalkRollover({ target: t, now: FIXED_NOW, runOneShot: okOneShot('A'), isActive: () => false });
    ok('A2 skipped with kill switch off', res.ran === false && /kill switch off/.test(res.reason), res.reason);
    ok('A3 no card dir created', !existsSync(t.daysDir));
    ok('A4 session pointer untouched', getConversation(t.externalId)!.claude_session_id === 'sess-A');
  }

  // turn the switch ON for the rest
  setSetting(KILL_SWITCH_KEY, 'on');
  ok('switch flips ON', rolloverEnabled() === true);

  // ── B. happy path: card written, bump posted, session cleared, marker set ──
  let cardFileB = '';
  {
    const t = target('cockpit:test-b');
    const cid = freshConv(t.externalId);
    setSession(cid, 'sess-B');
    addUser(cid, 'Kevin: we shipped the widget and decided to defer the audit');
    addAsst(cid, 'JARVIS: widget shipped, audit deferred', { input: 10, cacheRead: 500_000, cacheWrite: 20_000 });
    const res = await runTalkRollover({ target: t, now: FIXED_NOW, trigger: 'morning', runOneShot: okOneShot('WIDGET-SHIP'), isActive: () => false });
    ok('B1 ran', res.ran === true, res.reason);
    cardFileB = res.cardFile ?? '';
    ok('B2 card file exists on disk', !!cardFileB && existsSync(cardFileB));
    const body = cardFileB && existsSync(cardFileB) ? readFileSync(cardFileB, 'utf8') : '';
    ok('B3 card content is the writer output (file actually changed)', body.includes('WIDGET-SHIP'));
    ok('B4 card has the day header', body.includes('# 📅'));
    // divider is a bump turn, not user/assistant
    const bumps = sqliteDb.prepare(`SELECT content, tool_args FROM turns WHERE conversation_id=? AND role='bump'`).all(cid) as any[];
    ok('B5 exactly one bump divider posted', bumps.length === 1);
    ok('B6 divider is a bump role (never wakes the seat / not counted as message)', bumps.length === 1 && /fresh session/.test(bumps[0].content));
    ok('B7 divider metadata tags the rollover', bumps.length === 1 && JSON.parse(bumps[0].tool_args).kind === 'talk_rollover');
    // session cleared
    const conv = getConversation(t.externalId)!;
    ok('B8 claude_session_id cleared', conv.claude_session_id === null);
    ok('B9 session_adapter + account cleared', (conv as any).session_adapter == null && (conv as any).session_account == null);
    // marker advanced
    ok('B10 marker advanced past the rolled turns', (getSetting(`talk_rollover_last_idx:${t.externalId}`) ?? '') !== '');
    // transcript rows NEVER deleted
    const turnCount = (sqliteDb.prepare(`SELECT COUNT(*) c FROM turns WHERE conversation_id=?`).get(cid) as any).c;
    ok('B11 transcript rows preserved (user+asst+bump = 3)', turnCount === 3);

    // ── C. idempotence: immediate re-run has nothing new ──────────────────────
    const res2 = await runTalkRollover({ target: t, now: FIXED_NOW, runOneShot: okOneShot('SHOULD-NOT-RUN'), isActive: () => false });
    ok('C1 second run skips (no new turns)', res2.ran === false && /no new turns/.test(res2.reason), res2.reason);
    ok('C2 no second card written', readdirSync(t.daysDir).length === 1);

    // ── G. bump excluded from the next window; new user turn rolls as part2 ────
    addUser(cid, 'Kevin: next day, we started the migration');
    addAsst(cid, 'JARVIS: migration underway', { input: 8, cacheRead: 40_000, cacheWrite: 5_000 });
    const lastIdx = parseInt(getSetting(`talk_rollover_last_idx:${t.externalId}`)!, 10);
    const windowTurns = gatherTurnsSince(cid, lastIdx);
    ok('G1 next window excludes the bump divider', windowTurns.every((x) => x.role !== 'bump'));
    ok('G2 next window is exactly the 2 new content turns', windowTurns.length === 2);
    const res3 = await runTalkRollover({ target: t, now: FIXED_NOW, trigger: 'midday', runOneShot: okOneShot('MIGRATION'), isActive: () => false });
    ok('G3 same-date re-roll becomes part 2', res3.ran === true && res3.part === 2, `part=${res3.part}`);
    ok('G4 part2 file is a distinct file', (res3.cardFile ?? '').includes('-part2.md') && existsSync(res3.cardFile!));
  }

  // ── D. in-flight → refuse, touch nothing ───────────────────────────────────
  {
    const t = target('cockpit:test-d');
    const cid = freshConv(t.externalId);
    setSession(cid, 'sess-D');
    addUser(cid, 'busy'); addAsst(cid, 'working');
    const res = await runTalkRollover({ target: t, now: FIXED_NOW, runOneShot: okOneShot('D'), isActive: () => true });
    ok('D1 refused while a turn is in flight', res.ran === false && /in flight/.test(res.reason), res.reason);
    ok('D2 no card written', !existsSync(t.daysDir) || readdirSync(t.daysDir).length === 0);
    ok('D3 session pointer preserved', getConversation(t.externalId)!.claude_session_id === 'sess-D');
  }

  // ── E. REAL failure injected: writer throws → fail-closed, session NOT cleared
  {
    const t = target('cockpit:test-e');
    const cid = freshConv(t.externalId);
    setSession(cid, 'sess-E');
    addUser(cid, 'kevin said something'); addAsst(cid, 'reply');
    const boom = async () => { throw new Error('writer blew up (injected)'); };
    const res = await runTalkRollover({ target: t, now: FIXED_NOW, runOneShot: boom, isActive: () => false });
    ok('E1 run reports writer failure', res.ran === false && /writer failed/.test(res.reason), res.reason);
    ok('E2 NO card written on writer failure', !existsSync(t.daysDir) || readdirSync(t.daysDir).length === 0);
    ok('E3 session pointer PRESERVED (fail-closed — thread not stranded)', getConversation(t.externalId)!.claude_session_id === 'sess-E');
    ok('E4 no bump posted on failure', (sqliteDb.prepare(`SELECT COUNT(*) c FROM turns WHERE conversation_id=? AND role='bump'`).get(cid) as any).c === 0);
    ok('E5 marker not advanced on failure', (getSetting(`talk_rollover_last_idx:${t.externalId}`) ?? '') === '');
  }

  // ── F. empty card → fail-closed too ────────────────────────────────────────
  {
    const t = target('cockpit:test-f');
    const cid = freshConv(t.externalId);
    setSession(cid, 'sess-F');
    addUser(cid, 'x'); addAsst(cid, 'y');
    const res = await runTalkRollover({ target: t, now: FIXED_NOW, runOneShot: async () => '   ', isActive: () => false });
    ok('F1 empty card rejected', res.ran === false && /empty/.test(res.reason), res.reason);
    ok('F2 session preserved on empty card', getConversation(t.externalId)!.claude_session_id === 'sess-F');
  }

  // ── I. token measurement = input + cacheRead + cacheWrite of latest asst ────
  {
    const t = target('cockpit:test-i');
    const cid = freshConv(t.externalId);
    addAsst(cid, 'old', { input: 1, cacheRead: 100, cacheWrite: 10 });
    addAsst(cid, 'new', { input: 5, cacheRead: 900_000, cacheWrite: 50_000 });
    const tok = measureSessionTokens(cid);
    ok('I1 replayed = input+cacheRead+cacheWrite of the LATEST assistant turn', tok.replayed === 5 + 900_000 + 50_000, `got ${tok.replayed}`);
    ok('I2 zero when no token-bearing turn', measureSessionTokens(freshConv('cockpit:test-i2')).replayed === 0);
  }

  // ── H. pickCardPath increments parts, never overwrites ─────────────────────
  {
    const t = target('cockpit:test-h');
    const p1 = pickCardPath(t.daysDir, '2026-10-20');
    ok('H1 first is the bare date', p1.part === 1 && p1.file.endsWith('2026-10-20.md'));
  }

  // ── E2E mutation: two DIFFERENT writer outputs produce two DIFFERENT files ──
  {
    const t = target('cockpit:test-mut');
    const cid = freshConv(t.externalId);
    addUser(cid, 'day one work'); addAsst(cid, 'ok one', { cacheRead: 10 });
    const r1 = await runTalkRollover({ target: t, now: FIXED_NOW, runOneShot: okOneShot('ALPHA-MARK'), isActive: () => false });
    addUser(cid, 'day one more'); addAsst(cid, 'ok two', { cacheRead: 10 });
    const r2 = await runTalkRollover({ target: t, now: FIXED_NOW, runOneShot: okOneShot('BETA-MARK'), isActive: () => false });
    const b1 = readFileSync(r1.cardFile!, 'utf8');
    const b2 = readFileSync(r2.cardFile!, 'utf8');
    ok('MUT1 first file carries ALPHA-MARK only', b1.includes('ALPHA-MARK') && !b1.includes('BETA-MARK'));
    ok('MUT2 second file carries BETA-MARK only', b2.includes('BETA-MARK') && !b1.includes('BETA-MARK'));
    ok('MUT3 mutation changed the on-disk output', b1 !== b2);
  }

  // ── N. chronological card sort (codex #3): parts after bare date, 2 < 10 ───
  {
    const sorted = sortCardFiles(['2026-10-26-part10.md', '2026-10-26.md', '2026-10-26-part2.md', '2026-10-25.md']);
    ok('N1 date ascending then part ascending (bare = part 1, 2 before 10)',
      JSON.stringify(sorted) === JSON.stringify(['2026-10-25.md', '2026-10-26.md', '2026-10-26-part2.md', '2026-10-26-part10.md']),
      sorted.join(','));
  }

  // ── O. re-check before clear: turn starts mid-roll → abort, nothing mutated ─
  {
    const t = target('cockpit:test-o');
    const cid = freshConv(t.externalId);
    setSession(cid, 'sess-O');
    addUser(cid, 'hi'); addAsst(cid, 'yo', { cacheRead: 10 });
    let calls = 0;
    const flipActive = () => { calls += 1; return calls >= 2; }; // idle at entry, busy at the re-check
    const res = await runTalkRollover({ target: t, now: FIXED_NOW, runOneShot: okOneShot('O'), isActive: flipActive });
    ok('O1 aborts when a turn starts mid-roll', res.ran === false && /mid-roll/.test(res.reason), res.reason);
    ok('O2 no card written on mid-roll abort', !existsSync(t.daysDir) || readdirSync(t.daysDir).length === 0);
    ok('O3 session preserved on mid-roll abort', getConversation(t.externalId)!.claude_session_id === 'sess-O');
    ok('O4 no bump on mid-roll abort', (sqliteDb.prepare(`SELECT COUNT(*) c FROM turns WHERE conversation_id=? AND role='bump'`).get(cid) as any).c === 0);
  }

  // ── P. kill switch flipped OFF during the writer → abort, nothing mutated ───
  {
    const t = target('cockpit:test-p');
    const cid = freshConv(t.externalId);
    setSession(cid, 'sess-P');
    addUser(cid, 'hi'); addAsst(cid, 'yo', { cacheRead: 10 });
    const flipOff = async () => { setSetting(KILL_SWITCH_KEY, 'off'); return okOneShot('P')(); };
    const res = await runTalkRollover({ target: t, now: FIXED_NOW, runOneShot: flipOff, isActive: () => false });
    ok('P1 aborts when switch flipped off mid-roll', res.ran === false && /flipped off/.test(res.reason), res.reason);
    ok('P2 session preserved', getConversation(t.externalId)!.claude_session_id === 'sess-P');
    setSetting(KILL_SWITCH_KEY, 'on'); // restore for later blocks
  }

  // ── Q. writer output with no ## heading → rejected, fail-closed ─────────────
  {
    const t = target('cockpit:test-q');
    const cid = freshConv(t.externalId);
    setSession(cid, 'sess-Q');
    addUser(cid, 'hi'); addAsst(cid, 'yo', { cacheRead: 10 });
    const res = await runTalkRollover({ target: t, now: FIXED_NOW, runOneShot: async () => 'Error: subscription spent. Please retry.', isActive: () => false });
    ok('Q1 non-card output rejected', res.ran === false && /not a valid card/.test(res.reason), res.reason);
    ok('Q2 session preserved on junk output', getConversation(t.externalId)!.claude_session_id === 'sess-Q');
  }

  // ── R. concurrency lock: two concurrent rolls → one runs, one is refused ────
  {
    const t = target('cockpit:test-r');
    const cid = freshConv(t.externalId);
    setSession(cid, 'sess-R');
    addUser(cid, 'hi'); addAsst(cid, 'yo', { cacheRead: 10 });
    const slow = () => new Promise<string>((r) => setTimeout(() => r('## Done\n- R\n'), 20));
    const [a, b] = await Promise.all([
      runTalkRollover({ target: t, now: FIXED_NOW, runOneShot: slow, isActive: () => false }),
      runTalkRollover({ target: t, now: FIXED_NOW, runOneShot: slow, isActive: () => false }),
    ]);
    const ranCount = [a, b].filter((x) => x.ran).length;
    const lockedCount = [a, b].filter((x) => /already running/.test(x.reason)).length;
    ok('R1 exactly one concurrent roll ran', ranCount === 1, `ran=${ranCount}`);
    ok('R2 the other was refused by the lock', lockedCount === 1, `${a.reason} | ${b.reason}`);
    ok('R3 only one card written', readdirSync(t.daysDir).length === 1);
  }

  // ── S. turn finishes DURING the writer (idle again) → abort, don't clear ───
  {
    const t = target('cockpit:test-s');
    const cid = freshConv(t.externalId);
    setSession(cid, 'sess-S');
    addUser(cid, 'hi'); addAsst(cid, 'yo', { cacheRead: 10 });
    // writer "takes a while", during which a new turn lands AND completes (idle)
    const raceyWriter = async () => { addUser(cid, 'oh one more thing'); addAsst(cid, 'noted', { cacheRead: 10 }); return '## Done\n- S\n'; };
    const res = await runTalkRollover({ target: t, now: FIXED_NOW, runOneShot: raceyWriter, isActive: () => false });
    ok('S1 aborts when new turns land mid-roll (start-and-finish race)', res.ran === false && /new turns arrived mid-roll/.test(res.reason), res.reason);
    ok('S2 no card written', !existsSync(t.daysDir) || readdirSync(t.daysDir).length === 0);
    ok('S3 session preserved — the new turn is not stranded in a cleared session', getConversation(t.externalId)!.claude_session_id === 'sess-S');
  }

  // ── T. prompt caps: tail kept when over budget, single huge turn capped ────
  {
    const many: DayTurn[] = [];
    for (let i = 0; i < 400; i++) many.push({ turnIndex: i, role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'x'.repeat(2000), createdAt: '2026-10-26 09:00:00' });
    const p = buildDayCardPrompt('Mon, Oct 26', many);
    ok('T1 over-budget prompt keeps the newest turn (tail)', p.includes('turn 399'));
    ok('T2 over-budget prompt drops the oldest turn', !p.includes('turn 0 ') && p.includes('earlier turns trimmed'));
    const huge: DayTurn[] = [{ turnIndex: 0, role: 'user', content: 'y'.repeat(500_000), createdAt: '2026-10-26 09:00:00' }];
    const ph = buildDayCardPrompt('Mon, Oct 26', huge);
    ok('T3 a single huge turn is capped, not passed whole', ph.length < 60_000 && ph.includes('long turn trimmed'));
  }

  // ── L. seed section (TS twin): open items + last 3 + older index + cap ─────
  // Write four distinct-date cards directly: cardDateFor keys off a turn's real
  // created_at, so driving it through runTalkRollover can't produce 4 clean
  // dates in one run. buildSeedSection is what we're proving here, so give it
  // honest, deterministic fixtures (filename sort == chronological for dates).
  {
    const t = target('cockpit:test-seed');
    mkdirSync(t.daysDir, { recursive: true });
    const seedDates = ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'];
    seedDates.forEach((d, i) => {
      const body = i === seedDates.length - 1
        ? `# 📅 day\n\n## Done\n- CARD${i}\n\n## Still open\n- finish the audit\n- call the vendor\n`
        : `# 📅 day\n\n## Done\n- CARD${i}\n`;
      writeFileSync(path.join(t.daysDir, `${d}.md`), body, 'utf8');
    });
    const files = readdirSync(t.daysDir).filter((f) => /\.md$/.test(f)).sort();
    ok('L0 four day cards on disk', files.length === 4, `got ${files.length}`);
    const seed = buildSeedSection({ daysDir: t.daysDir, openItems: ['finish the audit', 'call the vendor'], now: FIXED_NOW });
    ok('L1 seed has the carried-forward header', seed.includes('Talk seat — carried forward'));
    ok('L2 open items present', seed.includes('finish the audit') && seed.includes('call the vendor'));
    ok('L3 last 3 cards embedded in full', seed.includes('CARD1') && seed.includes('CARD2') && seed.includes('CARD3'));
    ok('L4 oldest card (CARD0) is in the index, not embedded in full', !seed.includes('<day-card file="2026-10-21'), 'CARD0 should be older-index only');
    ok('L5 older index names the oldest card', /Older cards \(1/.test(seed) && seed.includes('2026-10-21'));
    const capped = buildSeedSection({ daysDir: t.daysDir, openItems: [], maxChars: 200 });
    ok('L6 cap enforced', capped.length <= 200 + 40 && capped.includes('seed truncated'));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  try { rmSync(daysRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  if (failed > 0) { console.error('FAILED: ' + fails.join('; ')); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
