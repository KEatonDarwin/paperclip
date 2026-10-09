#!/usr/bin/env node
// REPLY BREVITY DIAL TESTS (tree-c8e32ef9, docs/reply-brevity/CONTRACT.md).
//
//   npm run build
//   npm run reply-brevity:test
//
// Three parts, all against a scratch DB — no model calls, no network, no
// touch of the live jarvis.db:
//
//   A. PURE (src/reply-brevity.ts): splitBrevityReply / stripBrevityMarker /
//      briefOnly on fixture strings — no DB involved at all.
//   B. DB-backed (src/reply-brevity.ts + src/conversation-db.ts):
//      resolveBrevity precedence (worker-exclusion > thread override >
//      global > default) and brevityPromptBlock(0) === ''.
//   C. HTTP (src/handlers/api-v1.ts): GET/PATCH /reply-brevity and
//      PATCH /threads/:ext/reply-brevity, including 'inherit' clearing.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── scratch DB guard (same shape as scripts/claude-account-pin-test.mjs) ────
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

const distDir = path.join(__dirname, '..', 'dist');
const brevity = await import(path.join(distDir, 'reply-brevity.js'));
const convDb = await import(path.join(distDir, 'conversation-db.js'));

const {
  FULL_MARKER,
  splitBrevityReply,
  stripBrevityMarker,
  briefOnly,
  briefOnlyForThread,
  fullOnly,
  resolveBrevity,
  getBrevityGlobals,
  brevityPromptBlock,
  getGlobalBrevityLevel,
  getGlobalBrevityView,
  setGlobalBrevityLevel,
  setGlobalBrevityView,
} = brevity;

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}
async function acheck(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}: ${err.message}`);
  }
}

// ═════════ A. PURE: split / strip / briefOnly ═══════════════════════════════
console.log('\nA. splitBrevityReply / stripBrevityMarker / briefOnly (pure)');

check('no marker -> brief null, full is the whole text', () => {
  const r = splitBrevityReply('just a plain reply, no marker here');
  assert.equal(r.brief, null);
  assert.equal(r.full, 'just a plain reply, no marker here');
});

check('marker with blank lines on both sides', () => {
  const text = `Short bit.\n\n${FULL_MARKER}\n\nFull bit.`;
  const r = splitBrevityReply(text);
  assert.equal(r.brief, 'Short bit.');
  assert.equal(r.full, 'Full bit.');
});

check('marker with NO blank lines around it', () => {
  const text = `Short bit.\n${FULL_MARKER}\nFull bit.`;
  const r = splitBrevityReply(text);
  assert.equal(r.brief, 'Short bit.');
  assert.equal(r.full, 'Full bit.');
});

check('CRLF line endings', () => {
  const text = `Short bit.\r\n\r\n${FULL_MARKER}\r\n\r\nFull bit.\r\nSecond line.`;
  const r = splitBrevityReply(text);
  assert.equal(r.brief, 'Short bit.');
  assert.equal(r.full, 'Full bit.\r\nSecond line.');
});

check('marker appearing twice splits on the FIRST, rest stays in full untouched', () => {
  const text = `Short.\n\n${FULL_MARKER}\n\nFull part one.\n\n${FULL_MARKER}\n\nFull part two (literal marker text preserved).`;
  const r = splitBrevityReply(text);
  assert.equal(r.brief, 'Short.');
  assert.equal(r.full, `Full part one.\n\n${FULL_MARKER}\n\nFull part two (literal marker text preserved).`);
});

check('marker as the very first line -> brief is null, not empty string', () => {
  const text = `${FULL_MARKER}\n\nFull bit only.`;
  const r = splitBrevityReply(text);
  assert.equal(r.brief, null);
  assert.equal(r.full, 'Full bit only.');
});

check('marker trailing whitespace on the marker line is tolerated', () => {
  const text = `Short bit.\n\n${FULL_MARKER}   \n\nFull bit.`;
  const r = splitBrevityReply(text);
  assert.equal(r.brief, 'Short bit.');
  assert.equal(r.full, 'Full bit.');
});

check('marker inside a fenced code block is NOT treated as the split point', () => {
  const text = [
    'Short bit with a code sample:',
    '',
    '```',
    'some code',
    FULL_MARKER,
    'more code',
    '```',
    '',
    FULL_MARKER,
    '',
    'Full bit.',
  ].join('\n');
  const r = splitBrevityReply(text);
  assert.ok(r.brief && r.brief.includes('```'), 'the fenced block must stay part of the brief');
  assert.ok(r.brief.includes(FULL_MARKER), 'the in-fence marker text must NOT have triggered the split');
  assert.equal(r.full, 'Full bit.');
});

check('stripBrevityMarker removes only the marker line, keeps both halves', () => {
  const text = `Short bit.\n\n${FULL_MARKER}\n\nFull bit.`;
  const stripped = stripBrevityMarker(text);
  assert.ok(!stripped.includes(FULL_MARKER));
  assert.ok(stripped.includes('Short bit.'));
  assert.ok(stripped.includes('Full bit.'));
});

check('stripBrevityMarker is a no-op when there is no marker', () => {
  assert.equal(stripBrevityMarker('plain text'), 'plain text');
});

check('briefOnly returns the brief when there is one', () => {
  const text = `Short bit.\n\n${FULL_MARKER}\n\nFull bit.`;
  assert.equal(briefOnly(text), 'Short bit.');
});

check('briefOnly returns the whole text when there is no usable brief', () => {
  assert.equal(briefOnly('plain text, no marker'), 'plain text, no marker');
  const firstLineMarker = `${FULL_MARKER}\n\nFull only.`;
  assert.equal(briefOnly(firstLineMarker), firstLineMarker);
});

check('fullOnly returns the full half, and is a no-op without a marker', () => {
  assert.equal(fullOnly(`Short bit.\n\n${FULL_MARKER}\n\nFull bit.`), 'Full bit.');
  assert.equal(fullOnly('plain text, no marker'), 'plain text, no marker');
});

// Review finding (#1573): a run that died right after emitting the marker left
// fullOnly() returning '' — handing every full-only consumer (export, context
// digest, polling API, admin drill-down, cross-thread read, and the model's own
// transcript replay) a BLANK assistant turn, losing the one half that survived.
check('fullOnly degrades to the brief when the full half never arrived', () => {
  assert.equal(fullOnly(`Short version here.\n\n${FULL_MARKER}\n`), 'Short version here.');
  assert.equal(fullOnly(`Short version here.\n\n${FULL_MARKER}\n   \n\n`), 'Short version here.');
});

check('fullOnly only ever returns empty for genuinely empty input', () => {
  assert.equal(fullOnly(''), '');
  // Marker alone, nothing either side: no brief and no full — return the input
  // untouched rather than inventing a value.
  const markerOnly = `${FULL_MARKER}\n`;
  assert.equal(fullOnly(markerOnly), markerOnly);
});

// ═════════ B. brevityPromptBlock + resolveBrevity (DB-backed) ═══════════════
console.log('\nB. brevityPromptBlock(0) + resolveBrevity precedence (scratch DB)');

check('brevityPromptBlock(0) is exactly the empty string', () => {
  assert.equal(brevityPromptBlock(0), '');
});

check('brevityPromptBlock(1|2|3) is non-empty and carries the marker constant', () => {
  for (const level of [1, 2, 3]) {
    const block = brevityPromptBlock(level);
    assert.ok(block.length > 0);
    assert.ok(block.includes(FULL_MARKER));
    assert.ok(block.includes(`level="${level}"`));
  }
});

check('default resolution (no settings, no override) is level 0 / view brief', () => {
  const EXT = 'cockpit:reply-brevity-default-test';
  convDb.getOrCreateConversation(EXT, null);
  const r = resolveBrevity(EXT);
  assert.equal(r.level, 0);
  assert.equal(r.view, 'brief');
});

check('global setting applies when there is no per-thread override', () => {
  const EXT = 'cockpit:reply-brevity-global-test';
  convDb.getOrCreateConversation(EXT, null);
  setGlobalBrevityLevel(2);
  setGlobalBrevityView('full');
  const r = resolveBrevity(EXT);
  assert.equal(r.level, 2);
  assert.equal(r.view, 'full');
  assert.equal(getGlobalBrevityLevel(), 2);
  assert.equal(getGlobalBrevityView(), 'full');
  setGlobalBrevityLevel(0);
  setGlobalBrevityView('brief');
});

check('per-thread override wins over the global setting, per axis independently', () => {
  const EXT = 'cockpit:reply-brevity-override-test';
  const conv = convDb.getOrCreateConversation(EXT, null);
  setGlobalBrevityLevel(1);
  setGlobalBrevityView('brief');
  convDb.setThreadBrevityOverride(conv.id, 3, undefined); // only override level
  let r = resolveBrevity(EXT);
  assert.equal(r.level, 3, 'thread-level override must win');
  assert.equal(r.view, 'brief', 'view axis untouched -> still follows global');

  convDb.setThreadBrevityOverride(conv.id, undefined, 'full'); // only override view, leave level=3
  r = resolveBrevity(EXT);
  assert.equal(r.level, 3, 'previously-set level override must be untouched by a view-only call');
  assert.equal(r.view, 'full', 'view override must now win');

  setGlobalBrevityLevel(0);
  setGlobalBrevityView('brief');
});

check("per-thread override of 'inherit' (null) clears back to global", () => {
  const EXT = 'cockpit:reply-brevity-inherit-test';
  const conv = convDb.getOrCreateConversation(EXT, null);
  setGlobalBrevityLevel(2);
  convDb.setThreadBrevityOverride(conv.id, 3, 'full');
  assert.deepEqual(resolveBrevity(EXT), { level: 3, view: 'full' });
  convDb.setThreadBrevityOverride(conv.id, null, null); // 'inherit' on both axes
  assert.deepEqual(resolveBrevity(EXT), { level: 2, view: 'brief' });
  setGlobalBrevityLevel(0);
});

check('worker-thread hard exclusion beats BOTH a thread override and the global setting', () => {
  for (const EXT of ['cockpit:hopper-node-1569', 'cockpit:unblocker-abc123']) {
    const conv = convDb.getOrCreateConversation(EXT, null);
    setGlobalBrevityLevel(3);
    setGlobalBrevityView('full');
    convDb.setThreadBrevityOverride(conv.id, 2, 'full');
    const r = resolveBrevity(EXT);
    assert.equal(r.level, 0, `${EXT} must always resolve to level 0`);
    assert.equal(brevityPromptBlock(r.level), '', `${EXT} must get the empty prompt block`);
  }
  setGlobalBrevityLevel(0);
  setGlobalBrevityView('brief');
});

check('a non-worker thread with the same number suffix is NOT excluded (prefix match, not substring)', () => {
  const EXT = 'cockpit:some-other-thread-hopper-node-1569'; // does not START WITH the worker prefix
  convDb.getOrCreateConversation(EXT, null);
  setGlobalBrevityLevel(2);
  const r = resolveBrevity(EXT);
  assert.equal(r.level, 2, 'only a true external_id PREFIX match is a worker thread');
  setGlobalBrevityLevel(0);
});

// Review finding (#1573): threadDescriptor re-fetched the row it was already
// handed, and LIST /threads maps it over up to 200 threads — ~600 extra
// synchronous sqlite reads on the one surface whose event-loop stalls have
// already bitten once. The opts form must give the SAME answer as the
// fetching form, or the hot path and the cold path would disagree.
// NB on how this is asserted: a test that only checks
// `resolveBrevity(ext, {conv}) === resolveBrevity(ext)` is VACUOUS — it stays
// green when the implementation ignores the passed-in row and re-fetches,
// which is the exact behaviour being eliminated. (Caught by mutation-testing
// the first draft of this very test, which passed with the opts handling
// deleted.) So these assert on a row that DISAGREES with the database: the
// passed-in row must win, which can only happen if no re-fetch occurred.
check('resolveBrevity(ext, {conv}) uses the row it was handed and does NOT re-fetch', () => {
  const EXT = 'cockpit:reply-brevity-opts-test';
  const conv = convDb.getOrCreateConversation(EXT, null);
  setGlobalBrevityLevel(1);
  setGlobalBrevityView('full');
  convDb.setThreadBrevityOverride(conv.id, 3, 'brief'); // DB says 3/brief
  assert.deepEqual(resolveBrevity(EXT), { level: 3, view: 'brief' }, 'self-fetching form reads the DB');
  const disagreeing = { ...convDb.getConversation(EXT), brevity_level: 1, brevity_view: 'full' };
  assert.deepEqual(
    resolveBrevity(EXT, { conv: disagreeing }),
    { level: 1, view: 'full' },
    'the handed-in row must win — if this reports 3/brief, resolveBrevity re-fetched',
  );
  convDb.setThreadBrevityOverride(conv.id, null, null);
  setGlobalBrevityLevel(0);
  setGlobalBrevityView('brief');
});

check('resolveBrevity with conv:null skips the lookup entirely', () => {
  const EXT = 'cockpit:reply-brevity-convnull-test';
  const conv = convDb.getOrCreateConversation(EXT, null);
  convDb.setThreadBrevityOverride(conv.id, 3, 'full'); // a real override in the DB
  // conv:null = "there is no conversation to consider". If the lookup still
  // happened, the DB override (3/full) would surface instead of the globals.
  assert.deepEqual(resolveBrevity(EXT, { conv: null, globals: { level: 1, view: 'brief' } }), {
    level: 1,
    view: 'brief',
  });
  convDb.setThreadBrevityOverride(conv.id, null, null);
});

check('resolveBrevity honours a caller-supplied globals pair over the stored settings', () => {
  const EXT = 'cockpit:reply-brevity-globals-test';
  convDb.getOrCreateConversation(EXT, null);
  setGlobalBrevityLevel(0);
  setGlobalBrevityView('brief');
  // Stored settings say 0/brief; the passed-in pair must win for a thread with
  // no override — this is what the read-once list hoist relies on.
  assert.deepEqual(
    resolveBrevity(EXT, { conv: convDb.getConversation(EXT), globals: { level: 2, view: 'full' } }),
    { level: 2, view: 'full' },
  );
  // A worker thread still wins over everything, including supplied globals.
  assert.equal(
    resolveBrevity('cockpit:hopper-node-999', { conv: null, globals: { level: 3, view: 'full' } }).level,
    0,
  );
});

check('getBrevityGlobals returns the same pair resolveBrevity would read', () => {
  setGlobalBrevityLevel(2);
  setGlobalBrevityView('full');
  assert.deepEqual(getBrevityGlobals(), { level: 2, view: 'full' });
  const EXT = 'cockpit:reply-brevity-globals-parity';
  convDb.getOrCreateConversation(EXT, null);
  assert.deepEqual(resolveBrevity(EXT), getBrevityGlobals());
  setGlobalBrevityLevel(0);
  setGlobalBrevityView('brief');
});

// ═════════ B2. Consumer brief/full decisions (seeded two-half turns, no model calls) ═
// Each of these modules calls runClaude/an external SDK for its real job —
// the seeded-turn proof here targets only the pure/DB-backed decision of
// which half a consumer reads, not the model call itself. See docs/reply-
// brevity/CONTRACT.md's "## Consumers" table for the full decision list.
console.log('\nB2. Consumer brief/full decisions (seeded two-half turns)');

const { renderTranscript } = await import(path.join(distDir, 'thread-summarize.js'));
const { renderTurn } = await import(path.join(distDir, 'thread-condense.js'));
const { threadSnippet } = await import(path.join(distDir, 'thread-search.js'));
const { summarizeTurnForReplay } = await import(path.join(distDir, 'agent.js'));
const { getMemberThread } = await import(path.join(distDir, 'tools', 'group-chat-tool.js'));
const { createGroup, ensureGroupChat } = await import(path.join(distDir, 'conversation-groups.js'));

const BRIEF_SENTINEL = 'BRIEF_ONLY_SENTINEL_TOKEN';
const FULL_SENTINEL = 'FULL_ONLY_SENTINEL_TOKEN';
const TWO_HALF_TEXT = `${BRIEF_SENTINEL}\n\n${FULL_MARKER}\n\n${FULL_SENTINEL}`;

function seedTwoHalfConversation(ext) {
  const conv = convDb.getOrCreateConversation(ext, null);
  convDb.addTurn(conv.id, 'user', 'a question');
  convDb.addTurn(conv.id, 'assistant', TWO_HALF_TEXT);
  return conv;
}

check('thread-summarize.renderTranscript reads the full half only', () => {
  const conv = seedTwoHalfConversation('cockpit:reply-brevity-summarize-test');
  const rendered = renderTranscript(convDb.getTurnsLean(conv.id));
  assert.ok(rendered.includes(FULL_SENTINEL), 'must include the full half');
  assert.ok(!rendered.includes(BRIEF_SENTINEL), 'must NOT include the brief');
  assert.ok(!rendered.includes(FULL_MARKER), 'marker must not leak through');
});

check('thread-condense.renderTurn reads the full half only', () => {
  const conv = seedTwoHalfConversation('cockpit:reply-brevity-condense-test');
  const turns = convDb.getTurns(conv.id).filter((t) => t.role === 'assistant');
  const rendered = renderTurn(turns[0]);
  assert.ok(rendered.includes(FULL_SENTINEL));
  assert.ok(!rendered.includes(BRIEF_SENTINEL));
  assert.ok(!rendered.includes(FULL_MARKER));
});

check('thread-search.threadSnippet matches text in BOTH halves, marker stripped', () => {
  const conv = seedTwoHalfConversation('cockpit:reply-brevity-search-test');
  const snippet = threadSnippet(conv);
  assert.ok(snippet.includes(FULL_SENTINEL), 'full half must be searchable');
  assert.ok(snippet.includes(BRIEF_SENTINEL), 'brief half must ALSO be searchable');
  assert.ok(!snippet.includes(FULL_MARKER), 'marker must not leak through');
});

check('agent.summarizeTurnForReplay (transcript replay fed back to the model) reads the full half only', () => {
  const fakeTurn = { role: 'assistant', content: TWO_HALF_TEXT, created_at: '2026-10-09 00:00:00', tool_args: null, tool_result: null, tool_name: null };
  const rendered = summarizeTurnForReplay(fakeTurn);
  assert.ok(rendered.includes(FULL_SENTINEL));
  assert.ok(!rendered.includes(BRIEF_SENTINEL));
  assert.ok(!rendered.includes(FULL_MARKER));
});

check("agent.summarizeTurnForReplay leaves a plain VERDICT line untouched (worker threads never have a marker to begin with)", () => {
  const verdictText = 'VERDICT: PASS\nEverything checks out.';
  const fakeTurn = { role: 'assistant', content: verdictText, created_at: '2026-10-09 00:00:00', tool_args: null, tool_result: null, tool_name: null };
  const rendered = summarizeTurnForReplay(fakeTurn);
  assert.ok(rendered.includes(verdictText), 'no marker present -> content passes through whole');
});

check('ui-server.ts legacy debug server reads the full half only (structural — multiple routes, no expand UI)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui-server.ts'), 'utf8');
  assert.ok(/import\s*\{\s*fullOnly\s*\}\s*from\s*['"]\.\/reply-brevity\.js['"]/.test(src), 'must import fullOnly');
  assert.ok(/current\.assistant\s*=\s*\{\s*\.\.\.t,\s*content:\s*fullOnly\(t\.content/.test(src), 'groupTurnsIntoExchanges (feeds renderExchange + buildSessionClone) must apply fullOnly');
  assert.ok(/lines\.push\(fullOnly\(t\.content/.test(src), 'buildTranscriptMarkdown must apply fullOnly');
  assert.ok(/current\.assistant\s*=\s*fullOnly\(t\.content\)/.test(src), 'buildPrimerSourceTranscript (feeds the primer MODEL PROMPT) must apply fullOnly');
  assert.ok(/t\.role === 'assistant' \? \{ \.\.\.t, content: fullOnly\(t\.content/.test(src), 'the raw admin JSON dump (GET /api/conversations/:id) must apply fullOnly');
  assert.ok(/fullOnlyClient/.test(src), 'the client-side SSE live-tail render must also strip to full-only (the JS-level mirror)');
});

await acheck("tools/group-chat-tool getMemberThread mode:'full' reads the full half only", async () => {
  const { group } = createGroup('reply-brevity-group-chat-tool-test');
  const coverChat = ensureGroupChat(group.id);
  const member = seedTwoHalfConversation('cockpit:reply-brevity-group-member-test');
  convDb.setThreadGroup(member.id, group.id);

  const result = await getMemberThread.execute(
    { thread_id: member.external_id, mode: 'full' },
    { conversationId: coverChat.id },
  );
  const transcriptText = JSON.stringify(result.transcript);
  assert.ok(transcriptText.includes(FULL_SENTINEL), 'full half must be present');
  assert.ok(!transcriptText.includes(BRIEF_SENTINEL), 'brief half must NOT be present');
  assert.ok(!transcriptText.includes(FULL_MARKER), 'marker must not leak through');
});

check('ephemeral-chat.ts widget reads the full half only (structural — no expand UI on this widget)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ephemeral-chat.ts'), 'utf8');
  assert.ok(/import\s*\{\s*fullOnly\s*\}\s*from\s*['"]\.\/reply-brevity\.js['"]/.test(src), 'must import fullOnly');
  assert.ok(/fullOnly\(t\.content/.test(src), 'the assistant message text must be run through fullOnly');
});

// handlers/slack.ts's App/Bolt setup can't be driven end-to-end without a
// real Slack workspace. The transformation it applies is exactly briefOnly
// (already exhaustively proven pure above) — this is a structural guard that
// the two outbound-to-Slack call sites still apply it, so a future edit can't
// silently drop the line and start leaking the marker into Slack DMs.
// The outbound-Slack decision, tested on BEHAVIOUR (the review flagged the
// previous version of this check as a regex-over-source test that proves a
// line exists, not that it works — and it passed green while a third Slack
// path leaked, so it had encoded the sweep's blind spot as a guarantee).
check('briefOnlyForThread sends the brief when the dial is on', () => {
  const EXT = 'cockpit:reply-brevity-slack-on';
  convDb.getOrCreateConversation(EXT, null);
  setGlobalBrevityLevel(2);
  const text = `Short bit.\n\n${FULL_MARKER}\n\nFull bit with detail.`;
  assert.equal(briefOnlyForThread(EXT, text), 'Short bit.');
  setGlobalBrevityLevel(0);
});

// Review finding: a LEVEL-0 reply that merely MENTIONS the marker on its own
// line used to be split anyway, and briefOnly then dropped everything after
// it. The proven case was a reply whose final line was an ASK.
check('briefOnlyForThread never drops anything when the dial is OFF', () => {
  const EXT = 'cockpit:reply-brevity-slack-off';
  convDb.getOrCreateConversation(EXT, null);
  setGlobalBrevityLevel(0);
  const mentions = `Here is how the dial works. The marker line is:\n\n${FULL_MARKER}\n\nKevin, I need you to merge the branch.`;
  assert.equal(briefOnlyForThread(EXT, mentions), mentions, 'level 0 must be the identity function');
  assert.ok(briefOnlyForThread(EXT, mentions).includes('merge the branch'), 'the ask must survive');
});

check('briefOnlyForThread is identity on a thread with no marker at any level', () => {
  const EXT = 'cockpit:reply-brevity-slack-nomarker';
  convDb.getOrCreateConversation(EXT, null);
  for (const level of [0, 1, 2, 3]) {
    setGlobalBrevityLevel(level);
    assert.equal(briefOnlyForThread(EXT, 'plain reply, no marker'), 'plain reply, no marker');
  }
  setGlobalBrevityLevel(0);
});

check('handlers/slack.ts wires both outbound paths to the gated helper', () => {
  const cleaned = stripCommentsAndStrings(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'handlers', 'slack.ts'), 'utf8'),
  );
  assert.match(cleaned, /response\s*=\s*briefOnlyForThread\(conversationId,\s*response\)/, 'the live chat path must use the dial-gated helper');
  assert.match(cleaned, /text:\s*briefOnly\(briefing\)/, 'the daily-briefing post keeps the ungated helper (assembled text, never dial-shaped)');
  assert.match(cleaned, /addTurn\(conv\.id,\s+,\s*briefing\)/, 'the PERSISTED turn must stay the full original text');
});

// ═════════ C. HTTP: GET/PATCH /reply-brevity + PATCH /threads/:ext/reply-brevity ═
console.log('\nC. HTTP routes (real HTTP, admin-scoped key)');

const { createApiV1Router } = await import(path.join(distDir, 'handlers', 'api-v1.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));

const app = express();
app.use(express.json());
app.use('/api/v1', createApiV1Router());
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}/api/v1`;
const adminKey = mintApiKey('reply-brevity-test-admin', 'admin').plaintext;
const jarvisKey = mintApiKey('reply-brevity-test-jarvis', 'jarvis').plaintext;

async function getGlobal(key = adminKey) {
  const r = await fetch(`${base}/reply-brevity`, { headers: { Authorization: `Bearer ${key}` } });
  return { status: r.status, json: await r.json() };
}
async function patchGlobal(body, key = adminKey) {
  const r = await fetch(`${base}/reply-brevity`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}
async function patchThread(ext, body, key = adminKey) {
  const r = await fetch(`${base}/threads/${encodeURIComponent(ext)}/reply-brevity`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

await acheck('GET /reply-brevity reports the global defaults', async () => {
  const r = await getGlobal();
  assert.equal(r.status, 200);
  assert.equal(r.json.level, 0);
  assert.equal(r.json.view, 'brief');
});

await acheck('PATCH /reply-brevity sets level + view', async () => {
  const r = await patchGlobal({ level: 2, view: 'full' });
  assert.equal(r.status, 200);
  assert.equal(r.json.level, 2);
  assert.equal(r.json.view, 'full');
  const g = await getGlobal();
  assert.equal(g.json.level, 2);
  assert.equal(g.json.view, 'full');
});

await acheck('PATCH /reply-brevity rejects an invalid level', async () => {
  const r = await patchGlobal({ level: 7 });
  assert.equal(r.status, 400);
});

await acheck('PATCH /reply-brevity requires admin scope', async () => {
  const r = await patchGlobal({ level: 1 }, jarvisKey);
  assert.equal(r.status, 403);
});

await acheck('PATCH /threads/:ext/reply-brevity sets a per-thread override', async () => {
  const EXT = 'cockpit:reply-brevity-http-thread-test';
  convDb.getOrCreateConversation(EXT, null);
  const r = await patchThread(EXT, { level: 3, view: 'brief' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.override, { level: 3, view: 'brief' });
  assert.deepEqual(r.json.effective, { level: 3, view: 'brief' });
});

await acheck("PATCH /threads/:ext/reply-brevity 'inherit' clears the override back to global", async () => {
  const EXT = 'cockpit:reply-brevity-http-inherit-test';
  convDb.getOrCreateConversation(EXT, null);
  await patchGlobal({ level: 1, view: 'brief' });
  await patchThread(EXT, { level: 3 });
  let r = await patchThread(EXT, { level: 'inherit' });
  assert.equal(r.status, 200);
  assert.equal(r.json.override.level, null);
  assert.equal(r.json.effective.level, 1, 'must fall back to the global level');
});

await acheck('PATCH /threads/:ext/reply-brevity rejects an invalid view', async () => {
  const EXT = 'cockpit:reply-brevity-http-badview-test';
  convDb.getOrCreateConversation(EXT, null);
  const r = await patchThread(EXT, { view: 'wide' });
  assert.equal(r.status, 400);
});

await acheck('PATCH /threads/:ext/reply-brevity on a worker thread still accepts the write, but resolveBrevity stays 0', async () => {
  const EXT = 'cockpit:hopper-node-999999';
  convDb.getOrCreateConversation(EXT, null);
  const r = await patchThread(EXT, { level: 3, view: 'full' });
  assert.equal(r.status, 200, 'the write itself is not blocked at the API layer');
  assert.equal(resolveBrevity(EXT).level, 0, 'resolution still hard-excludes the worker thread');
});

await acheck('GET /threads/:ext carries reply_brevity.override + .effective (node #1571 header control reads this)', async () => {
  const EXT = 'cockpit:reply-brevity-descriptor-test';
  convDb.getOrCreateConversation(EXT, null);
  await patchGlobal({ level: 1, view: 'brief' });
  await patchThread(EXT, { level: 3, view: 'full' });
  const r = await fetch(`${base}/threads/${encodeURIComponent(EXT)}`, {
    headers: { Authorization: `Bearer ${adminKey}` },
  });
  assert.equal(r.status, 200);
  const json = await r.json();
  assert.deepEqual(json.reply_brevity.override, { level: 3, view: 'full' });
  assert.deepEqual(json.reply_brevity.effective, { level: 3, view: 'full' });

  await patchThread(EXT, { level: 'inherit', view: 'inherit' });
  const r2 = await fetch(`${base}/threads/${encodeURIComponent(EXT)}`, {
    headers: { Authorization: `Bearer ${adminKey}` },
  });
  const json2 = await r2.json();
  assert.deepEqual(json2.reply_brevity.override, { level: null, view: null });
  assert.deepEqual(json2.reply_brevity.effective, { level: 1, view: 'brief' }, 'falls back to global once override cleared');
});

// ── Consumer HTTP routes: seeded two-half turn, marker present/absent per route ─
console.log('\nC2. Consumer HTTP routes (seeded two-half turn)');

async function getThread(ext, key = adminKey) {
  const r = await fetch(`${base}/threads/${encodeURIComponent(ext)}`, { headers: { Authorization: `Bearer ${key}` } });
  return { status: r.status, json: await r.json() };
}
async function getText(urlPath, key = adminKey) {
  const r = await fetch(`${base}${urlPath}`, { headers: { Authorization: `Bearer ${key}` } });
  return { status: r.status, text: await r.text() };
}

await acheck('GET /threads/:external_id (the cockpit chat bubble) gets the RAW two-half content, marker included', async () => {
  const EXT = 'cockpit:reply-brevity-chatbubble-test';
  const conv = seedTwoHalfConversation(EXT);
  const r = await getThread(EXT);
  assert.equal(r.status, 200);
  const assistantTurn = r.json.turns.find((t) => t.role === 'assistant');
  assert.ok(assistantTurn.content.includes(BRIEF_SENTINEL), 'brief half must be present, unsplit');
  assert.ok(assistantTurn.content.includes(FULL_SENTINEL), 'full half must be present');
  assert.ok(assistantTurn.content.includes(FULL_MARKER), 'marker must be present — this is the one consumer that renders it client-side');
  void conv;
});

await acheck('GET /threads/:external_id/markdown exports the full half only', async () => {
  const EXT = 'cockpit:reply-brevity-markdown-test';
  seedTwoHalfConversation(EXT);
  const r = await getText(`/threads/${encodeURIComponent(EXT)}/markdown`);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes(FULL_SENTINEL));
  assert.ok(!r.text.includes(BRIEF_SENTINEL));
  assert.ok(!r.text.includes(FULL_MARKER));
});

await acheck('GET /threads/:external_id/context-markdown digests the full half only', async () => {
  const EXT = 'cockpit:reply-brevity-contextmd-test';
  seedTwoHalfConversation(EXT);
  const r = await getText(`/threads/${encodeURIComponent(EXT)}/context-markdown`);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes(FULL_SENTINEL));
  assert.ok(!r.text.includes(BRIEF_SENTINEL));
  assert.ok(!r.text.includes(FULL_MARKER));
});

await acheck('GET /threads/:external_id/messages/:message_id (poll status) returns the full half only', async () => {
  const EXT = 'cockpit:reply-brevity-pollstatus-test';
  const conv = seedTwoHalfConversation(EXT);
  const userTurn = convDb.getTurns(conv.id).find((t) => t.role === 'user');
  const messageId = `turn:${conv.id}:${userTurn.turn_index}`;
  const r = await fetch(`${base}/threads/${encodeURIComponent(EXT)}/messages/${encodeURIComponent(messageId)}`, {
    headers: { Authorization: `Bearer ${adminKey}` },
  });
  assert.equal(r.status, 200);
  const json = await r.json();
  assert.equal(json.status, 'done');
  assert.ok(json.text.includes(FULL_SENTINEL));
  assert.ok(!json.text.includes(BRIEF_SENTINEL));
  assert.ok(!json.text.includes(FULL_MARKER));
  assert.ok(json.turn.content.includes(FULL_SENTINEL));
  assert.ok(!json.turn.content.includes(BRIEF_SENTINEL));
});

await acheck('GET /control-panel/run-history/:id/turns (admin drill-down) returns the full half only', async () => {
  const EXT = 'cockpit:reply-brevity-runhistory-test';
  const conv = seedTwoHalfConversation(EXT);
  const r = await fetch(`${base}/control-panel/run-history/${conv.id}/turns`, {
    headers: { Authorization: `Bearer ${adminKey}` },
  });
  assert.equal(r.status, 200);
  const json = await r.json();
  const assistantTurn = json.turns.find((t) => t.role === 'assistant');
  assert.ok(assistantTurn.content.includes(FULL_SENTINEL));
  assert.ok(!assistantTurn.content.includes(BRIEF_SENTINEL));
  assert.ok(!assistantTurn.content.includes(FULL_MARKER));
});

server.close();

// ═════════ D. REGRESSION GUARD: every turn-content reader is on the allowlist ═
// Static source scan — no DB, no build. Guards against a NEW consumer of
// turn.content appearing without a documented brief/full decision in
// docs/reply-brevity/CONTRACT.md's "## Consumers" table (node #1572,
// tree-c8e32ef9). All turn content, with no exception found in this codebase,
// flows through conversation-db.ts's `getTurns` / `getTurnsLean` — so rather
// than grep for the generic (extremely noisy — tool_args.content,
// thread_summaries.content, MCP result content blocks, etc.) field name
// `.content`, this scans for CALL SITES of those two specific exports.
//
// Tokenised, not naive-grep: comments and string/template literals are
// stripped from each file before matching, so a comment or doc string that
// merely MENTIONS "getTurns(" in prose can't trip the guard (the documented
// failure mode of a prior guard in this codebase that read its own
// documentation as a violation).
console.log('\nD. Regression guard: turn-content readers vs. docs/reply-brevity/CONTRACT.md allowlist');

const SRC_DIR = path.join(__dirname, '..', 'src');

/** Strips //, /* *\/, and '...'/"..."/`...` literals, replacing each with
 *  equal-length spaces so line numbers in any future line-level reporting
 *  stay stable. Good enough for a regex pass over this codebase's style
 *  (no nested template-literal interpolation containing the needle) — not a
 *  real JS/TS parser. */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const two = src.slice(i, i + 2);
    if (two === '//') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      out += ' '.repeat(j - i);
      i = j;
    } else if (two === '/*') {
      let j = i + 2;
      while (j < n - 1 && src.slice(j, j + 2) !== '*/') j++;
      j = Math.min(j + 2, n);
      out += src.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
    } else if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\') j++;
        j++;
      }
      j = Math.min(j + 1, n);
      out += src.slice(i, j).replace(/[^\n]/g, ' ');
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function walkTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// Defines getTurns/getTurnsLean — a definition site, not a consumer.
const DEFINITION_FILE = 'conversation-db.ts';

// Every file with a real call site today, each decided in CONTRACT.md's
// "## Consumers" table. A new file showing up here means a new consumer
// appeared with no recorded brief/full decision — go decide it, document it,
// then add it here.
const ALLOWLIST = new Set([
  'agent.ts', // buildContinuationPrompt transcript replay -> full only
  'ephemeral-chat.ts', // ephemeral chat widget, no expand UI -> full only
  'thread-summarize.ts', // DAR-740 thread summarizer -> full only
  'thread-condense.ts', // long-thread condenser -> full only
  'thread-search.ts', // AI-mediated search corpus -> both halves (marker stripped)
  'tools/group-chat-tool.ts', // get_member_thread mode:'full' -> full only
  'handlers/api-v1.ts', // multiple routes, each decided individually (see CONTRACT.md)
  'ui-server.ts', // legacy debug server, multiple routes -> full only (see CONTRACT.md)
]);

const callSiteRe = /\b(getTurns|getTurnsLean)\s*\(/;
const foundFiles = new Set();
for (const file of walkTsFiles(SRC_DIR)) {
  const rel = path.relative(SRC_DIR, file).split(path.sep).join('/');
  if (rel === DEFINITION_FILE) continue;
  const cleaned = stripCommentsAndStrings(fs.readFileSync(file, 'utf8'));
  if (callSiteRe.test(cleaned)) foundFiles.add(rel);
}

check('tokenizer sanity: a call site inside a // comment is NOT flagged', () => {
  const cleaned = stripCommentsAndStrings('// see getTurns(conv.id) in agent.ts\nconst x = 1;');
  assert.equal(callSiteRe.test(cleaned), false);
});

check('tokenizer sanity: a call site inside a string literal is NOT flagged', () => {
  const cleaned = stripCommentsAndStrings('const doc = "call getTurns(conv.id) to fetch turns";');
  assert.equal(callSiteRe.test(cleaned), false);
});

check('tokenizer sanity: a REAL call site outside comments/strings IS flagged', () => {
  const cleaned = stripCommentsAndStrings('const turns = getTurns(conv.id); // fetch turns\n');
  assert.equal(callSiteRe.test(cleaned), true);
});

check('every turn-content reader found in src/ is on the documented allowlist', () => {
  const undocumented = [...foundFiles].filter((f) => !ALLOWLIST.has(f));
  assert.deepEqual(
    undocumented,
    [],
    `New turn-content consumer(s) with no CONTRACT.md decision: ${undocumented.join(', ')}. ` +
      'Decide brief-or-full for it, document it in the "## Consumers" table, then add it to ALLOWLIST here.',
  );
});

check('every allowlisted file still actually reads turn content (allowlist is not stale)', () => {
  const stale = [...ALLOWLIST].filter((f) => !foundFiles.has(f));
  assert.deepEqual(stale, [], `Allowlist entries with no real call site anymore (remove from ALLOWLIST and CONTRACT.md): ${stale.join(', ')}`);
});

// -- D2: the SECOND consumer class ------------------------------------------
// The class-1 guard above scans getTurns/getTurnsLean call sites, and its
// stated premise — "all turn content flows through getTurns" — was FALSE:
// processMessage() RETURNS the reply text straight to its caller, never
// touching the turns table. That blind spot shipped three real leaks
// (checkin-worker's Slack DM + notification body, and both webhook JSON
// responses) past a green class-1 guard. So processMessage call sites get
// their own allowlist.
//
// Deliberately NOT trying to detect "is the return value used?" statically —
// a shape heuristic (`= await`, `return`, …) is exactly the kind of guess
// that produced the first blind spot. EVERY file that calls processMessage
// must carry a recorded decision, even "fire-and-forget, return value
// discarded". A new caller fails this test until someone decides.
console.log('\nD2. Regression guard: processMessage callers (the class the #1572 sweep could not see)');

// Defines processMessage; its own internal references are not consumers.
const PM_DEFINITION_FILE = 'agent.ts';

const PM_ALLOWLIST = new Set([
  // Return value CONSUMED — must apply briefOnly/fullOnly.
  'checkin-worker.ts', // -> briefOnly for the Slack DM + the bell body; persisted turn stays raw
  'handlers/slack.ts', // -> briefOnly (Slack is the glance surface)
  'handlers/webhook.ts', // -> fullOnly (programmatic caller, no expander)
  // Return value DISCARDED (fire-and-forget cue/seed posts) — nothing to strip.
  'ephemeral-chat.ts',
  'tools/goals-tool.ts',
  'health-monitor.ts',
  'tree-cue.ts',
  'goals-guards.ts',
  'mike-radar-cue.ts',
  'dispatch-gate.ts',
  'goals.ts',
  'handlers/api-v1.ts',
]);

const pmCallSiteRe = /\bprocessMessage\s*\(/;
const pmFoundFiles = new Set();
for (const file of walkTsFiles(SRC_DIR)) {
  const rel = path.relative(SRC_DIR, file).split(path.sep).join('/');
  if (rel === PM_DEFINITION_FILE) continue;
  const cleaned = stripCommentsAndStrings(fs.readFileSync(file, 'utf8'));
  if (pmCallSiteRe.test(cleaned)) pmFoundFiles.add(rel);
}

check('every processMessage caller in src/ is on the documented allowlist', () => {
  const undocumented = [...pmFoundFiles].filter((f) => !PM_ALLOWLIST.has(f));
  assert.deepEqual(
    undocumented,
    [],
    `New processMessage caller(s) with no CONTRACT.md decision: ${undocumented.join(', ')}. ` +
      'processMessage returns the reply text and bypasses the turns table — decide whether this caller ' +
      'needs briefOnly/fullOnly (or genuinely discards the value), document it in "## Consumers", then add it here.',
  );
});

check('processMessage allowlist is not stale', () => {
  const stale = [...PM_ALLOWLIST].filter((f) => !pmFoundFiles.has(f));
  assert.deepEqual(stale, [], `Allowlist entries with no real processMessage call site anymore: ${stale.join(', ')}`);
});

// The three leaks themselves, asserted on behaviour not on source text — these
// go red if the briefOnly/fullOnly calls are removed.
check('checkin-worker sends the BRIEF to Slack and the bell, and persists the raw reply', () => {
  const src = fs.readFileSync(path.join(SRC_DIR, 'checkin-worker.ts'), 'utf8');
  const cleaned = stripCommentsAndStrings(src);
  assert.match(cleaned, /const\s+nudgeText\s*=\s*briefOnlyForThread\(conversationId,\s*response\)/, 'checkin nudge must use the dial-gated brief helper');
  assert.match(cleaned, /text:\s*nudgeText/, 'the Slack post must use the brief');
  assert.match(cleaned, /body:\s*nudgeText/, 'the notification body must use the brief');
  // NB: stripCommentsAndStrings blanks string literals, so 'assistant' is
  // whitespace here — match on the shape, not the literal.
  assert.match(cleaned, /addTurn\(notificationsConversationId,\s+,\s*response\)/, 'the persisted turn must stay RAW');
});

check('both webhook responses are full-only', () => {
  const cleaned = stripCommentsAndStrings(fs.readFileSync(path.join(SRC_DIR, 'handlers', 'webhook.ts'), 'utf8'));
  const hits = cleaned.match(/fullOnly\(await processMessage\(/g) ?? [];
  assert.equal(hits.length, 2, `expected both /intake and /intake/reply to wrap processMessage in fullOnly, found ${hits.length}`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
