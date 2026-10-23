#!/usr/bin/env node
// NOTEPAD REPLAY CHECK — replays one messy, realistic day of notepad edits
// through the REAL exported API (src/notepad.ts) and proves no line is ever
// picked up twice. This is the end-to-end proof that the three prior nodes
// (line-identity diff, the LINE-IDENTITY.md contract, and the per-line state
// ledger) hold together under a day that looks like Kevin's actual notepad:
// loose headers, dash bullets, inconsistent indentation, blank-ish lines,
// duplicate lines, a URL, a very long line, typos, reindents, a line moved
// under a different header, a split, a delete, and a meaning change on an
// already-acted line.
//
// No HTTP, no model calls. Drives putNotepadDay/unscannedLines/markLineSeen/
// markLineActed/markLineDismissed/lineTextHash directly — never reimplements
// the hash or the diff.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-replay-check.db node scripts/notepad-replay-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── scratch DB guard ─────────────────────────────────────────────────────────
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

console.log(`[notepad-replay-check] DB: ${DB_PATH}`);

const distDir = path.join(__dirname, '..', 'dist');
const { putNotepadDay, unscannedLines, markLineSeen, markLineActed, markLineDismissed, getNotepadLine, getNotepadLineState, lineTextHash } =
  await import(path.join(distDir, 'notepad.js'));

let failed = false;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failed = true;
  }
}

const DAY = '2026-09-25';

// ── the day's fixture, as it starts ──────────────────────────────────────────
// Loose header, dash bullets, inconsistent indentation, a typo, TWO IDENTICAL
// duplicate lines ("- ping ian"), a bare URL line, and one very long line.
const INITIAL_DOC = [
  'Notes 9/25',
  '- cal Mike about the invoice', // typo: "cal" -> fixed to "call" later
  '- ping ian',
  '- ping ian', // identical duplicate
  'TODO',
  '  - fix the leak in the shed',
  '  - buy dog food',
  '  - schedule vet appt',
  '- https://example.com/some/report?query=1&foo=bar',
  '- Ian said this is going to be a really long one because he wanted to explain the entire history of the account reconciliation project going all the way back to March including every meeting note and every side conversation and every excuse Mike gave along the way which is why this line just keeps going and going and going',
];

const MIKE_REF = 'test:action:mike-invoice';
const PING_REF = 'test:action:ping-ian-first';

// The long line gets split later. Derive the two fragments by slicing the
// original (never by hand-transcribing) so there's no risk of a typo making
// the "leading fragment" not actually be a prefix of the original text.
const LONG_LINE_ORIGINAL = INITIAL_DOC[9];
const LONG_SPLIT_MARKER = ' and every excuse Mike gave';
const LONG_SPLIT_AT = LONG_LINE_ORIGINAL.indexOf(LONG_SPLIT_MARKER);
const LONG_LINE_LEAD = LONG_LINE_ORIGINAL.slice(0, LONG_SPLIT_AT);
const LONG_LINE_TRAIL = '-' + LONG_LINE_ORIGINAL.slice(LONG_SPLIT_AT); // "- and every excuse Mike gave ..."

// ── bookkeeping ───────────────────────────────────────────────────────────────
const offeredSet = new Set(); // `${line_id}:${hash}` for every (line_id, hash) ever OFFERED
const existedSet = new Set(); // `${line_id}:${hash}` for every (line_id, hash) that ever EXISTED in a saved doc
const existedMeta = new Map(); // key -> { line_id, text }
const allLineIdsEver = new Set();
const everMarkedIds = new Set();
const actionRefsUsed = new Set();
const offersLog = []; // { round, line_id, text, kind, action_ref }
let dupOfferViolations = 0;
let coverageViolations = 0;
let burstOfferCount = 0; // offers that occurred during the keystroke-typing bursts

// ids captured after round 1 (unambiguous by idx at that point)
let headerId, mikeInvoiceId, pingIanFirstId, pingIanSecondId, todoHeaderId, fixLeakId, buyDogFoodId, vetApptId, urlId, longLineId;

function markOffer(offer, decision) {
  everMarkedIds.add(offer.line_id);
  if (decision.type === 'seen') {
    markLineSeen(offer.line_id);
  } else if (decision.type === 'dismissed') {
    markLineDismissed(offer.line_id, decision.note);
  } else if (decision.type === 'acted') {
    markLineActed(offer.line_id, decision.ref);
    actionRefsUsed.add(decision.ref);
  }
}

/**
 * Default marking policy for every round after round 1: two specific lines
 * (mikeInvoiceId, pingIanFirstId) are always re-affirmed as acted with their
 * ORIGINAL ref whenever offered (this is the "resolve the reconciliation"
 * step); the URL line is always dismissed; everything else is marked seen.
 * A per-round overrideFn may force a specific decision (checked first).
 */
function decideAction(offer, overrideFn) {
  if (overrideFn) {
    const forced = overrideFn(offer);
    if (forced) return forced;
  }
  if (offer.line_id === mikeInvoiceId) return { type: 'acted', ref: MIKE_REF };
  if (offer.line_id === pingIanFirstId) return { type: 'acted', ref: PING_REF };
  if (offer.line_id === urlId) return { type: 'dismissed', note: 'reference link only' };
  return { type: 'seen' };
}

/** idx-based policy used ONLY for round 1, before any ids are known. */
function initialPolicy(offer) {
  switch (offer.idx) {
    case 1:
      return { type: 'acted', ref: MIKE_REF };
    case 2:
      return { type: 'acted', ref: PING_REF };
    case 8:
      return { type: 'dismissed', note: 'reference link only' };
    default:
      return { type: 'seen' };
  }
}

/**
 * Save `docLines`, scan, tally every offer (asserting no (line_id, hash) pair
 * is ever offered twice), mark everything that came back, and record every
 * (line_id, hash) that EXISTED in this save for the coverage check.
 */
function runRound(label, docLines, overrideFn, isBurst) {
  const saved = putNotepadDay(DAY, docLines.join('\n'));

  for (const line of saved.lines) {
    allLineIdsEver.add(line.id);
    const hash = lineTextHash(line.text);
    const key = `${line.id}:${hash}`;
    existedSet.add(key);
    if (!existedMeta.has(key)) existedMeta.set(key, { line_id: line.id, text: line.text });
  }

  const offers = unscannedLines(DAY);
  const offersById = new Map();
  for (const offer of offers) {
    const hash = lineTextHash(offer.text);
    const key = `${offer.line_id}:${hash}`;
    if (offeredSet.has(key)) {
      dupOfferViolations++;
      console.error(`FAIL  [round ${label}] line ${offer.line_id} offered twice for the same content: "${offer.text}"`);
    } else {
      offeredSet.add(key);
    }
    offersLog.push({ round: label, line_id: offer.line_id, text: offer.text, kind: offer.kind, action_ref: offer.action_ref });
    offersById.set(offer.line_id, offer);
    if (isBurst) burstOfferCount++;

    const decision = decideAction(offer, overrideFn);
    markOffer(offer, decision);
  }

  return { saved, offers, offersById };
}

// ── ROUND 1: the initial messy day ───────────────────────────────────────────
{
  const { saved, offers } = runRound('1-initial', INITIAL_DOC, initialPolicy);
  check('round 1: 10 lines saved', saved.lines.length === 10);
  check('round 1: all 10 lines surfaced as unscanned (nothing pre-marked)', offers.length === 10);

  const ids = saved.lines.map((l) => l.id);
  [headerId, mikeInvoiceId, pingIanFirstId, pingIanSecondId, todoHeaderId, fixLeakId, buyDogFoodId, vetApptId, urlId, longLineId] = ids;
  check('round 1: the two "ping ian" duplicates got distinct ids', pingIanFirstId !== pingIanSecondId);
}

// `doc` is the live mutable text of the day, mirrored in JS so we can build
// each next full-text PUT. It starts as a copy of INITIAL_DOC.
let doc = [...INITIAL_DOC];

// ── typo fix on the invoice line (written much earlier in the day) ──────────
{
  doc[1] = '- call Mike about the invoice'; // "cal" -> "call"
  const { offersById } = runRound('2-typo-fix', doc);
  const offer = offersById.get(mikeInvoiceId);
  check(
    'typo fix: surfaces as reconcile, not a bare first-look',
    offer?.kind === 'reconcile',
    `got kind=${offer?.kind}`
  );
  check(
    'typo fix: carries the ORIGINAL action_ref (no second action)',
    offer?.action_ref === MIKE_REF,
    `got action_ref=${offer?.action_ref}`
  );
}

// ── typing a brand-new line one keystroke at a time ──────────────────────────
const TARGET_LINE_1 = '- email ian re q3';
let newLineId;
{
  for (let i = 1; i <= TARGET_LINE_1.length; i++) {
    const partial = TARGET_LINE_1.slice(0, i);
    if (i === 1) doc.push(partial);
    else doc[doc.length - 1] = partial;
    const { saved } = runRound(`typing1-${i}`, doc, undefined, true);
    if (i === TARGET_LINE_1.length) newLineId = saved.lines[saved.lines.length - 1].id;
  }
  check('keystroke typing: final line has the full target text', doc[doc.length - 1] === TARGET_LINE_1);
  check('keystroke typing: line id is defined', typeof newLineId === 'number');
}

// ── re-indent a block (TODO items go from 2-space to 4-space indent) ────────
{
  const before = { fixLeak: doc[5], buyDogFood: doc[6], vetAppt: doc[7] };
  doc[5] = '    - fix the leak in the shed';
  doc[6] = '    - buy dog food';
  doc[7] = '    - schedule vet appt';
  const { offers } = runRound('reindent', doc);
  check(
    're-indent block: whitespace-only change produces zero offers (hash is indent-blind)',
    offers.length === 0,
    `got ${offers.length} offers: ${offers.map((o) => o.text).join(', ')}`
  );
  check('re-indent: text actually changed on disk', before.fixLeak !== doc[5] && before.buyDogFood !== doc[6]);
}

// ── move a line under a different header (TODO -> new DONE header) ──────────
{
  const buyDogFoodText = doc[6]; // '    - buy dog food'
  doc.splice(6, 1); // remove from TODO block
  doc.push('DONE', buyDogFoodText); // new header + the moved line, unchanged text
  const { offers, saved } = runRound('move', doc);
  // The moved line itself is a same-text move (no offer). The only offer this
  // round is the brand-new "DONE" header line we just introduced.
  check(
    'move under a different header: the only offer this round is the new header line',
    offers.length === 1 && offers[0].text === 'DONE',
    `got ${offers.length} offers: ${offers.map((o) => o.text).join(', ')}`
  );
  check(
    'move under a different header: the moved line kept its original id (same-text move)',
    saved.lines.find((l) => l.text === buyDogFoodText)?.id === buyDogFoodId
  );
}

// ── split one line into two ──────────────────────────────────────────────────
// Split the LONG line, not the keystroke-typed one: the typed line's history
// is literally every prefix of its target text, so splitting it at any
// prefix boundary would reproduce a hash that line already carried mid-typing
// — a legitimate replay of an earlier state under the decision table (the
// current hash differs from the LAST recorded hash, so it correctly
// resurfaces), but it would trip assertion 1's "never offered twice for the
// same (line_id, hash)" over the whole day. The long line was never typed
// incrementally, so its post-split fragments are genuinely new content.
let longLineTrailId;
{
  const splitIdx = doc.indexOf(LONG_LINE_ORIGINAL);
  check('split: found the long line to split', splitIdx !== -1);
  doc.splice(splitIdx, 1, LONG_LINE_LEAD, LONG_LINE_TRAIL);
  const { saved, offersById } = runRound('split', doc);
  const leading = saved.lines.find((l) => l.text === LONG_LINE_LEAD);
  const trailing = saved.lines.find((l) => l.text === LONG_LINE_TRAIL);
  check('split: leading fragment keeps the original line id', leading?.id === longLineId);
  check('split: trailing fragment gets a brand-new id', !!trailing && trailing.id !== longLineId);
  longLineTrailId = trailing?.id;
  check(
    'split: leading fragment surfaced as first_look (seen state, text changed)',
    offersById.get(longLineId)?.kind === 'first_look'
  );
  check(
    'split: trailing fragment surfaced as first_look (brand-new line)',
    offersById.get(longLineTrailId)?.kind === 'first_look'
  );
}

// ── delete a line ─────────────────────────────────────────────────────────────
{
  const vetApptText = '    - schedule vet appt';
  const idx = doc.indexOf(vetApptText);
  check('delete: found the line to delete', idx !== -1);
  check('delete: state row exists before delete', getNotepadLineState(vetApptId) !== undefined);
  doc.splice(idx, 1);
  runRound('delete', doc);
  check('delete: line itself is gone', getNotepadLine(vetApptId) === undefined);
  check('delete: state row is gone too (ON DELETE CASCADE)', getNotepadLineState(vetApptId) === undefined);
}

// ── a MEANING change to a line already marked acted ─────────────────────────
{
  const idx = doc.indexOf('- call Mike about the invoice');
  check('meaning change: found the acted line', idx !== -1);
  doc[idx] = '- do NOT call Mike, Ian is handling it';
  const { offersById } = runRound('meaning-change', doc);
  const offer = offersById.get(mikeInvoiceId);
  check(
    'meaning change on acted line: surfaces as reconcile',
    offer?.kind === 'reconcile',
    `got kind=${offer?.kind}`
  );
  check(
    'meaning change on acted line: carries the SAME original action_ref, exactly',
    offer?.action_ref === MIKE_REF,
    `got action_ref=${offer?.action_ref}`
  );
}

// ── a small unrelated header edit, just to vary the day further ─────────────
{
  doc[0] = 'Notes 9/25 (updated)';
  runRound('header-edit', doc);
}

// ── a second brand-new line, typed one keystroke at a time ──────────────────
const TARGET_LINE_2 = '- call bank';
let callBankId;
{
  for (let i = 1; i <= TARGET_LINE_2.length; i++) {
    const partial = TARGET_LINE_2.slice(0, i);
    if (i === 1) doc.push(partial);
    else doc[doc.length - 1] = partial;
    const { saved } = runRound(`typing2-${i}`, doc, undefined, true);
    if (i === TARGET_LINE_2.length) callBankId = saved.lines[saved.lines.length - 1].id;
  }
  check('second keystroke line: final text matches target', doc[doc.length - 1] === TARGET_LINE_2);
}

// ── insert a whole new line at once, dismiss it ──────────────────────────────
const FYI_TEXT = '- FYI: lunch with Mike moved to 1pm';
let fyiId;
{
  doc.push(FYI_TEXT);
  const { saved, offers } = runRound('fyi-insert', doc, (offer) => (offer.text === FYI_TEXT ? { type: 'dismissed', note: 'fyi only' } : null));
  fyiId = saved.lines.find((l) => l.text === FYI_TEXT)?.id;
  check('fyi line: exactly one offer this round (only new line changed)', offers.length === 1, `got ${offers.length}`);
  check('fyi line: was marked dismissed', getNotepadLineState(fyiId)?.state === 'dismissed');
}

// ── a redundant no-op save: nothing changed -> zero offers ──────────────────
{
  const { offers } = runRound('noop-1', doc);
  check('no-op save: zero offers when nothing changed', offers.length === 0, `got ${offers.length}`);
}

// ── edit the long line's (post-split) leading fragment once more ────────────
{
  const idx = doc.indexOf(LONG_LINE_LEAD);
  check('long line: found the (post-split) leading fragment', idx !== -1);
  doc[idx] = doc[idx] + ' and going even more than that';
  const { offersById } = runRound('long-line-edit', doc);
  check('long line edit: surfaces as first_look', offersById.get(longLineId)?.kind === 'first_look');
}

// ── final settle: no-op again ─────────────────────────────────────────────────
{
  const { offers } = runRound('noop-final', doc);
  check('final no-op save: zero offers (day has settled)', offers.length === 0, `got ${offers.length}`);
}

// ── ASSERTION 1: no (line_id, hash) pair ever offered twice ─────────────────
check('ASSERTION 1: no (line_id, hash) pair was ever offered twice', dupOfferViolations === 0, `${dupOfferViolations} violation(s)`);

// ── ASSERTION 4: total distinct actions == deliberately-acted lines, no dupes ─
check(
  'ASSERTION 4: exactly 2 distinct action_ref values used, matching the 2 deliberately-acted lines',
  actionRefsUsed.size === 2 && actionRefsUsed.has(MIKE_REF) && actionRefsUsed.has(PING_REF),
  `actionRefsUsed=${[...actionRefsUsed].join(',')}`
);

// ── ASSERTION 5: every line in the FINAL document has exactly one state row,
//    and no orphan state rows survive the deletions ──────────────────────────
{
  let orphanViolations = 0;
  for (const id of everMarkedIds) {
    const line = getNotepadLine(id);
    const state = getNotepadLineState(id);
    if (line && !state) {
      orphanViolations++;
      console.error(`FAIL  [assertion 5] line ${id} ("${line.text}") still exists but has NO state row`);
    }
    if (!line && state) {
      orphanViolations++;
      console.error(`FAIL  [assertion 5] line ${id} was deleted but its state row survived (orphan): ${JSON.stringify(state)}`);
    }
  }
  check(
    'ASSERTION 5: every surviving line has exactly one state row; no orphan rows after deletion',
    orphanViolations === 0,
    `${orphanViolations} violation(s)`
  );
  check('deleted line (vetAppt) specifically: no line row, no state row', getNotepadLine(vetApptId) === undefined && getNotepadLineState(vetApptId) === undefined);
}

// ── ASSERTION 6 (the one the node notes don't name): COVERAGE ───────────────
// Every distinct (line_id, hash) that ever EXISTED in a saved document must
// have been OFFERED at least once before being marked. A script that never
// calls unscannedLines, or that only keeps the LAST offer per line, would
// pass assertions 1/4/5 while proving the scanner never actually ran — this
// is the check that rules that out.
{
  for (const [key, meta] of existedMeta) {
    if (!offeredSet.has(key)) {
      coverageViolations++;
      console.error(`FAIL  [coverage] content state never offered: line ${meta.line_id} "${meta.text}"`);
    }
  }
  for (const key of offeredSet) {
    if (!existedSet.has(key)) {
      coverageViolations++;
      console.error(`FAIL  [coverage] an offer's (line_id, hash) was never actually a saved state: ${key}`);
    }
  }
  check(
    'ASSERTION 6 (coverage): every distinct content state that existed was offered at least once',
    coverageViolations === 0,
    `${coverageViolations} violation(s)`
  );
  console.log(`coverage: distinct content states existed=${existedSet.size} offered=${offeredSet.size}`);
}

// The keystroke-typing burst is EXPECTED to produce one offer per distinct
// content state (which is not quite one per keystroke — a couple of adjacent
// keystrokes normalize to the same hash, e.g. "-" and "- ", and those are
// correctly skipped, not offered twice). Collapsing a whole burst into a
// single offer is the SETTLE-AND-READ pass (goal-6 node #61) and is
// explicitly out of scope here per LINE-IDENTITY.md §5 — this script only
// records and reports the burst's raw offer count, it does not debounce it.
console.log(`burst offers (typing1 + typing2, not debounced — that's node #61): ${burstOfferCount}`);

// ── final summary ─────────────────────────────────────────────────────────────
console.log(
  `\nlines: ${allLineIdsEver.size}  offers: ${offersLog.length}  actions: ${actionRefsUsed.size}  violations: ${dupOfferViolations + coverageViolations}`
);

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
