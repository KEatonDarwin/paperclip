#!/usr/bin/env node
// LIVE STREAM ACCUMULATOR TESTS (src/live-stream.ts)
//
//   npm run live-stream:test
//
// Pure: no DB, no network, no model calls. Every case replays the raw stream
// events an adapter really emits and asserts what the browser ends up showing.
//
// Part B is the anti-vacuous proof: the SAME fixtures are run through a replica
// of the OLD inline agent.ts logic, and the test asserts the old logic FAILS
// them. A regression test that cannot fail on the broken code proves nothing.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createStreamAccumulator } from '../dist/live-stream.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0;
const results = [];
function ok(name, fn) {
  try {
    fn();
    pass++;
    results.push(`  ok   ${name}`);
  } catch (err) {
    results.push(`  FAIL ${name}\n       ${err.message.split('\n')[0]}`);
    process.exitCode = 1;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────
const asstEvent = (id, blocks) => ({ type: 'assistant', message: { id, content: blocks } });
const textBlock = (text) => ({ type: 'text', text });
const thinkBlock = (thinking) => ({ type: 'thinking', thinking });
const textDelta = (text) => ({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
const thinkDelta = (thinking) => ({
  type: 'content_block_delta',
  delta: { type: 'thinking_delta', thinking },
});

// What the browser has after replaying a stream: deltas appended in order.
function clientView(events) {
  const acc = createStreamAccumulator();
  let shownText = '';
  let shownThinking = '';
  // What the cockpit's "Thinking… ~N tokens" label would read, and every value
  // it passed through — so a count that went BACKWARDS is catchable.
  let shownTokens = 0;
  const tokenSeq = [];
  for (const e of events) {
    for (const emit of acc.handle(e)) {
      if (emit.kind === 'text') shownText += emit.delta;
      else if (emit.kind === 'thinking') shownThinking += emit.delta;
      else if (emit.kind === 'thinking_progress') {
        shownTokens = emit.tokens;
        tokenSeq.push(emit.tokens);
      } else throw new Error(`unknown emit kind ${emit.kind}`);
    }
  }
  return { shownText, shownThinking, shownTokens, tokenSeq, acc };
}

// Replica of the OLD inline handler from agent.ts (pre-2026-10-13), text only.
function oldClientView(events) {
  let accumulatedText = '';
  let shown = '';
  for (const event of events) {
    if (event.type === 'content_block_delta') {
      const d = event.delta;
      if (d?.type === 'text_delta' && typeof d.text === 'string') {
        shown += d.text;
        accumulatedText += d.text;
      }
      continue;
    }
    if (event.type === 'assistant') {
      const content = event.message?.content;
      if (Array.isArray(content)) {
        let fullText = '';
        for (const b of content) if (b.type === 'text' && typeof b.text === 'string') fullText += b.text;
        if (fullText.length > accumulatedText.length) {
          shown += fullText.slice(accumulatedText.length);
          accumulatedText = fullText;
        }
      }
    }
  }
  return shown;
}

// ── FIXTURE: a real multi-step Claude turn (no content_block_delta at all,
// because the CLI is spawned without --include-partial-messages).
const M1 = 'Let me check the three files first.';
const M2 = 'Found it.';
const M3 = "The bug is in the slice, and I'll fix it now.";
const CLAUDE_TURN = [
  asstEvent('msg_1', [textBlock(M1)]),
  asstEvent('msg_2', [textBlock(M2)]),
  asstEvent('msg_3', [textBlock(M3)]),
];

console.log('\nA. the fixed accumulator');

ok('every assistant message reaches the browser, in order, byte for byte', () => {
  const { shownText } = clientView(CLAUDE_TURN);
  assert.equal(shownText, M1 + M2 + M3);
});

ok('a SHORTER later message is not dropped (the mid-turn freeze)', () => {
  const { shownText } = clientView([asstEvent('a', [textBlock('A long first message here.')]), asstEvent('b', [textBlock('Short.')])]);
  assert.equal(shownText, 'A long first message here.Short.');
});

ok('a LONGER later message is not sliced mid-word (the eaten characters)', () => {
  const { shownText } = clientView([asstEvent('a', [textBlock('Hello there')]), asstEvent('b', [textBlock('World, this is much longer text here')])]);
  assert.equal(shownText, 'Hello thereWorld, this is much longer text here');
});

ok('.text matches what the browser shows (partial-persist stays correct)', () => {
  const { shownText, acc } = clientView(CLAUDE_TURN);
  assert.equal(acc.text, shownText);
});

ok('thinking blocks stream, and separately from reply text', () => {
  const { shownText, shownThinking } = clientView([
    asstEvent('m1', [thinkBlock('Checking the join first.'), textBlock('One moment.')]),
    asstEvent('m2', [thinkBlock('That rate is net, not gross.'), textBlock('Here it is.')]),
  ]);
  assert.equal(shownThinking, 'Checking the join first.That rate is net, not gross.');
  assert.equal(shownText, 'One moment.Here it is.');
});

ok('thinking never leaks into the reply buffer', () => {
  const { acc } = clientView([asstEvent('m1', [thinkBlock('secret reasoning'), textBlock('visible')])]);
  assert.equal(acc.text, 'visible');
  assert.equal(acc.thinking, 'secret reasoning');
});

ok('codex synthetic whole-text deltas still append verbatim', () => {
  const { shownText } = clientView([textDelta('step one done. '), textDelta('step two done.')]);
  assert.equal(shownText, 'step one done. step two done.');
});

ok('thinking deltas append verbatim', () => {
  const { shownThinking } = clientView([thinkDelta('weighing '), thinkDelta('two options')]);
  assert.equal(shownThinking, 'weighing two options');
});

ok('deltas then the matching snapshot do not duplicate the message', () => {
  const { shownText } = clientView([
    textDelta('Hello '),
    textDelta('world'),
    asstEvent('m1', [textBlock('Hello world')]),
  ]);
  assert.equal(shownText, 'Hello world');
});

ok('a snapshot that EXTENDS what deltas streamed emits only the tail', () => {
  const { shownText } = clientView([
    textDelta('Hello '),
    asstEvent('m1', [textBlock('Hello world')]),
  ]);
  assert.equal(shownText, 'Hello world');
});

ok('the same message id arriving twice is not re-emitted', () => {
  const { shownText } = clientView([
    asstEvent('m1', [textBlock('Only once.')]),
    asstEvent('m1', [textBlock('Only once.')]),
  ]);
  assert.equal(shownText, 'Only once.');
});

ok('a rewritten snapshot for the same id sends the whole snapshot, never a guessed cut', () => {
  const { shownText } = clientView([
    asstEvent('m1', [textBlock('draft text')]),
    asstEvent('m1', [textBlock('completely different')]),
  ]);
  assert.equal(shownText, 'draft textcompletely different');
});

ok('id-less assistant events are each treated as a whole new message', () => {
  const { shownText } = clientView([
    { type: 'assistant', message: { content: [textBlock('first bit here')] } },
    { type: 'assistant', message: { content: [textBlock('second')] } },
  ]);
  assert.equal(shownText, 'first bit heresecond');
});

ok('malformed / unrelated events are ignored without throwing', () => {
  const acc = createStreamAccumulator();
  for (const e of [
    { type: 'assistant' },
    { type: 'assistant', message: null },
    { type: 'assistant', message: { content: 'nope' } },
    { type: 'assistant', message: { id: 'x', content: [{ type: 'text' }, { type: 'tool_use', name: 'Bash' }] } },
    { type: 'content_block_delta' },
    { type: 'content_block_delta', delta: { type: 'text_delta' } },
    { type: 'result' },
  ]) {
    assert.deepEqual(acc.handle(e), []);
  }
  assert.equal(acc.text, '');
  assert.equal(acc.thinking, '');
});

ok('reset clears both buffers and the per-message state', () => {
  const acc = createStreamAccumulator();
  acc.handle(asstEvent('m1', [thinkBlock('t'), textBlock('abc')]));
  acc.reset();
  assert.equal(acc.text, '');
  assert.equal(acc.thinking, '');
  const out = acc.handle(asstEvent('m1', [textBlock('abc')]));
  assert.deepEqual(out, [{ kind: 'text', delta: 'abc' }]);
});

ok('a tool-only message between two text messages does not disturb the stream', () => {
  const { shownText } = clientView([
    asstEvent('m1', [textBlock('Reading the file.')]),
    asstEvent('m2', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }]),
    asstEvent('m3', [textBlock('Done reading.')]),
  ]);
  assert.equal(shownText, 'Reading the file.Done reading.');
});

// ── A2. the --include-partial-messages shape (2026-10-13) ─────────────────
// These replay REAL `claude --print --output-format stream-json --verbose
// --include-partial-messages` output, captured from the CLI on 2026-10-13 and
// committed as scripts/fixtures/claude-partial-stream.jsonl. The CLI nests each
// Anthropic event inside {type:"stream_event"} and REDACTS reasoning text, so a
// fixture written by hand would have been a guess about both.
const REAL = readFileSync(join(HERE, 'fixtures', 'claude-partial-stream.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

// The reply text the CLI's own complete assistant message says it sent.
const REAL_FINAL = REAL.filter((e) => e.type === 'assistant').flatMap((e) =>
  (e.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text),
).join('');

ok('real CLI partial stream: browser text matches the message exactly', () => {
  const { shownText } = clientView(REAL);
  assert.equal(shownText, REAL_FINAL);
  assert.ok(REAL_FINAL.length > 200, 'fixture should be a substantial reply');
});

ok('real CLI partial stream: no duplication when the snapshot follows the deltas', () => {
  const { shownText } = clientView(REAL);
  // The whole failure mode here is the complete `assistant` message arriving
  // after its own deltas and being replayed as a second copy.
  assert.equal(shownText.indexOf(REAL_FINAL), 0);
  assert.equal(shownText.length, REAL_FINAL.length);
});

ok('real CLI partial stream: reasoning text is redacted, tokens are not', () => {
  const { shownThinking, shownTokens, acc } = clientView(REAL);
  assert.equal(shownThinking, '', 'the CLI sends no reasoning text — do not invent any');
  assert.ok(shownTokens > 0, 'but it does send a token estimate');
  assert.equal(acc.thinkingTokens, shownTokens);
});

ok('real CLI partial stream: redacted thinking never leaks into the reply', () => {
  const { shownText, acc } = clientView(REAL);
  assert.equal(acc.text, shownText);
  assert.ok(!shownText.includes('undefined'));
  assert.ok(!shownText.includes('estimated_tokens'));
});

const wrapped = (inner) => ({ type: 'stream_event', event: inner });
const thinkTokenDelta = (estimated_tokens, index = 0) =>
  wrapped({
    type: 'content_block_delta',
    index,
    delta: { type: 'thinking_delta', thinking: '', estimated_tokens },
  });

ok('stream_event wrapper is unwrapped for text too', () => {
  const { shownText } = clientView([wrapped(textDelta('Hel')), wrapped(textDelta('lo'))]);
  assert.equal(shownText, 'Hello');
});

ok('estimated_tokens is cumulative per block, not summed', () => {
  // Observed from the CLI: 50, 50, 100, 100 for ONE block = 100 total.
  const { shownTokens, tokenSeq } = clientView([
    thinkTokenDelta(50),
    thinkTokenDelta(50),
    thinkTokenDelta(100),
    thinkTokenDelta(100),
  ]);
  assert.equal(shownTokens, 100);
  assert.deepEqual(tokenSeq, [50, 100], 'only report when the number actually moves');
});

ok('token count never goes backwards', () => {
  const { shownTokens, tokenSeq } = clientView([
    thinkTokenDelta(200),
    thinkTokenDelta(50),
    thinkTokenDelta(60),
  ]);
  assert.equal(shownTokens, 200);
  assert.deepEqual(tokenSeq, [200]);
  assert.ok(tokenSeq.every((n, i) => i === 0 || n > tokenSeq[i - 1]));
});

ok('separate blocks in one message each count', () => {
  const { shownTokens } = clientView([thinkTokenDelta(100, 0), thinkTokenDelta(80, 1)]);
  assert.equal(shownTokens, 180);
});

ok('tokens accumulate across messages even though block indexes restart', () => {
  const { shownTokens } = clientView([
    wrapped({ type: 'message_start' }),
    thinkTokenDelta(100, 0),
    wrapped({ type: 'message_start' }),
    thinkTokenDelta(70, 0),
  ]);
  assert.equal(shownTokens, 170, 'index 0 of the second message must not overwrite the first');
});

ok('a redacted thinking block in a complete message adds no text', () => {
  const { shownText, shownThinking } = clientView([
    asstEvent('m1', [thinkBlock(''), textBlock('The answer.')]),
  ]);
  assert.equal(shownText, 'The answer.');
  assert.equal(shownThinking, '');
});

ok('reset clears the token count too', () => {
  const acc = createStreamAccumulator();
  acc.handle(thinkTokenDelta(500));
  assert.equal(acc.thinkingTokens, 500);
  acc.reset();
  assert.equal(acc.thinkingTokens, 0);
});

console.log(results.join('\n'));

// ── B. the old logic must FAIL the same fixtures ───────────────────────────
console.log('\nB. the OLD logic on the same fixtures (these failures are the point)');
const oldResults = [];
let oldProven = 0;
function mustBeBroken(name, events, expected) {
  const got = oldClientView(events);
  if (got === expected) {
    oldResults.push(`  FAIL old logic unexpectedly PASSED: ${name}`);
    process.exitCode = 1;
  } else {
    oldProven++;
    oldResults.push(`  ok   old logic broke it: ${name}\n       showed ${JSON.stringify(got)}`);
  }
}
mustBeBroken('3-message Claude turn', CLAUDE_TURN, M1 + M2 + M3);
mustBeBroken(
  'shorter later message',
  [asstEvent('a', [textBlock('A long first message here.')]), asstEvent('b', [textBlock('Short.')])],
  'A long first message here.Short.',
);
mustBeBroken(
  'longer later message',
  [asstEvent('a', [textBlock('Hello there')]), asstEvent('b', [textBlock('World, this is much longer text here')])],
  'Hello thereWorld, this is much longer text here',
);
// NOTE: the old logic gets the real one-message fixture RIGHT by coincidence —
// it ignored stream_event entirely, so it saw a single complete message and
// emitted all of it (just with nothing on screen until the end). Its corruption
// needs a SECOND message in the tool-turn, which is what any step that calls a
// tool produces. Same real CLI stream, one short follow-up message appended:
const REAL_THEN_SHORT = [...REAL, asstEvent('m-follow-up', [textBlock('Short.')])];
mustBeBroken('real CLI partial stream + a second message', REAL_THEN_SHORT, REAL_FINAL + 'Short.');
console.log(oldResults.join('\n'));

const total = pass + (process.exitCode ? 0 : 0);
console.log(`\nPASS ${pass}   old-logic failures proven ${oldProven}/4`);
if (process.exitCode) {
  console.log('SUITE FAILED');
} else {
  console.log('SUITE GREEN');
}
