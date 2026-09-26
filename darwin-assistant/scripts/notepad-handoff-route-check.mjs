#!/usr/bin/env node
// NOTEPAD HANDOFF ROUTE CHECK — exercises node #869's two additions:
//   (a) src/notepad-handoff.ts (buildNotepadHandoffPrompt, openNotepadHandoff)
//   (b) POST /notepad/markers/:lineId/open, reimplemented here the same way
//       notepad-marker-route-check.mjs reimplements the dismiss route — this
//       repo has no "drive the real express router" check convention
//       anywhere (grepped scripts/ for startUiServer -- it is defined only in
//       src/index.ts, never used by a check script), so this drives the
//       handler LOGIC directly against a scratch DB, over the exact exported
//       functions the real route calls (getNotepadMarker, openNotepadHandoff),
//       reimplementing only the two thin 400/404 guards that live inline in
//       the route closure itself.
//
// Covers:
//   (1) malformed lineId -> 400 invalid_line_id (never reaches the store).
//   (2) an unknown line (no marker, no line row at all) -> 404 marker_not_found.
//   (3) first open on a real marked line: 201, created:true, a seeded_prompt
//       that carries the line verbatim, the marker's kind+reason, the
//       dossier's own honest "no context" rendering (topic resolves to
//       nothing for this fixture line, on purpose -- proves the composer
//       reuses node #107's dossier text rather than inventing its own), and
//       ends with a "start working now" instruction. The one seed post fires
//       exactly once, with the exact prompt, thread ext, and a turn:<id>:0
//       message id. The marker's action_ref AND the per-line ledger
//       (notepad_line_state) both record the thread ext as 'acted'.
//   (4) second open on the SAME line: 200, created:false, seeded_prompt:null,
//       the SAME thread_ext as (3), and the seed-post stub is NOT called a
//       second time (idempotent).
//   (5) a second, independent marked line opened WITHOUT stubbing the seed
//       post -- exercises the real default (agent.js's processMessage) and
//       proves it does not throw and does not block the route response
//       (fire-and-forget), relying on sim-guard (src/sim-guard.ts) to no-op
//       the actual spawn under this scratch JARVIS_DB_PATH.
//   (6b) NODE #943 — THE BLOCK FORM: clicking a marker that sits on a topic
//       BLOCK's headline opens a thread seeded with the WHOLE topic (every
//       indented child, verbatim, with its line_id), and the dossier it was
//       composed from was built over the whole block too. The route resolves
//       the block from the line the same way src/handlers/api-v1.ts does.
//   (7) ZERO CLAUDE PROCESSES spawned across the whole run (before/after
//       pgrep snapshot) -- this node makes no model calls of its own; the one
//       real model seam it drives (buildTopicDossier's narrative call) is
//       always stubbed here, exactly like notepad-dossier-check.mjs does.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-handoff-route-check.db node scripts/notepad-handoff-route-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── scratch DB guard (copied verbatim from the sibling notepad checks) ──────
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

console.log(`[notepad-handoff-route-check] DB: ${DB_PATH}`);

function claudeProcessCount() {
  try {
    const out = execSync('pgrep -c -f claude', { encoding: 'utf8' });
    return parseInt(out.trim(), 10) || 0;
  } catch (err) {
    // pgrep exits 1 when nothing matches -- that's zero, not a failure.
    if (err && err.status === 1) return 0;
    throw err;
  }
}

const spawnsBefore = claudeProcessCount();

// Same isolation as notepad-dossier-check.mjs: force the orientation source
// unreachable (fast-fail) for the whole process, since this check has
// nothing to do with orientation and must not depend on the network being up.
process.env.JARVIS_SMARTY_PANTS_URL = 'http://127.0.0.1:1';
process.env.JARVIS_MCP_NATIVE_TIMEOUT_MS = '5000';

const distDir = path.join(__dirname, '..', 'dist');
const { putNotepadDay, getNotepadLineState, getNotepadDay, getNotepadLineDay } = await import(path.join(distDir, 'notepad.js'));
const { parseNotepadBlocks, notepadBlockId } = await import(path.join(distDir, 'notepad-blocks.js'));
const { reconcileNotepadMarker, getNotepadMarker } = await import(path.join(distDir, 'notepad-markers.js'));
const { resolveActionRef: resolveNotepadActionRef } = await import(
  path.join(distDir, 'notepad-action-resolver.js')
);
const { openNotepadHandoff, buildNotepadHandoffPrompt, notepadHandoffThreadExt } = await import(
  path.join(distDir, 'notepad-handoff.js')
);
const { getConversation } = await import(path.join(distDir, 'conversation-db.js'));
await import(path.join(distDir, 'goals.js')); // side effect only: creates goals/goal_nodes/goal_events
await import(path.join(distDir, 'hopper-engine.js')); // side effect only: creates hopper_trees/hopper_nodes

let failed = false;
function check(label, ok) {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    console.error(`FAIL  ${label}`);
    failed = true;
  }
}

function lineIdByText(saved, text) {
  const line = saved.lines.find((l) => l.text === text);
  assert.ok(line, `fixture line '${text}' must exist`);
  return line.id;
}

// Never touches the real CLI -- returns an empty object so buildTopicDossier
// keeps narrative/open_question null and falls back to the pure-evidence
// deterministic render, same stub shape notepad-dossier-check.mjs uses.
const stubRunOneShot = async () => '{}';

// Mirrors the route's own two inline guards exactly, then defers everything
// else to the real exported openNotepadHandoff -- the same shape
// notepad-marker-route-check.mjs's dismissRoute() uses for the dismiss route.
/** Mirrors the block resolution the real route (src/handlers/api-v1.ts,
 *  notepadBlockForLine) performs before calling openNotepadHandoff. */
function blockForLine(lineId) {
  const day = getNotepadLineDay(lineId);
  if (!day) return null;
  const { lines } = getNotepadDay(day);
  const block = parseNotepadBlocks(lines).find((b) => b.member_line_ids.includes(lineId));
  if (!block) return null;
  const textById = new Map(lines.map((l) => [l.id, l.text]));
  return {
    block_id: notepadBlockId(block),
    headline_line_id: block.headline_line_id,
    headline: block.headline,
    lines: block.member_line_ids.map((id) => ({ line_id: id, text: textById.get(id) ?? '' })),
  };
}

async function openRoute(lineId, opts = {}) {
  if (!Number.isInteger(lineId) || lineId <= 0) {
    return { status: 400, body: { error: 'invalid_line_id', message: 'lineId must be a positive integer' } };
  }
  const marker = getNotepadMarker(lineId);
  if (!marker) {
    return { status: 404, body: { error: 'marker_not_found', message: `no notepad marker on line '${lineId}'` } };
  }
  const result = await openNotepadHandoff(lineId, opts);
  return { status: result.created ? 201 : 200, body: result };
}

// -- (1) malformed lineId -> 400, never reaches the store -------------------
{
  const result = await openRoute(NaN);
  check('malformed (NaN) lineId returns 400', result.status === 400);
  check('malformed lineId returns invalid_line_id', result.body.error === 'invalid_line_id');

  const zero = await openRoute(0);
  check('lineId 0 returns 400 (not a positive integer)', zero.status === 400);
}

// -- (2) unknown line (no marker, no line row at all) -> 404 ----------------
{
  const result = await openRoute(999999);
  check('unknown line returns 404', result.status === 404);
  check('unknown line returns marker_not_found', result.body.error === 'marker_not_found');
}

const DAY = '2026-09-25';
const saved = putNotepadDay(
  DAY,
  ['- grab milk on the way home', '- fix the composer bug', 'a plain note with no marker'].join('\n'),
);
const lineA = lineIdByText(saved, '- grab milk on the way home');
const lineB = lineIdByText(saved, '- fix the composer bug');
const lineC = lineIdByText(saved, 'a plain note with no marker');

// lineC deliberately gets NO marker -- proves a real, existing line with no
// marker still 404s the same way an unknown line does (getNotepadMarker is
// the one gate, exactly mirroring the dismiss route's own behavior).
{
  const result = await openRoute(lineC);
  check('a real line with no marker still returns 404 marker_not_found', result.status === 404 && result.body.error === 'marker_not_found');
}

reconcileNotepadMarker(lineA, { kind: 'take_it', reason: 'a concrete task JARVIS can do' });
reconcileNotepadMarker(lineB, { kind: 'question', reason: 'needs a decision from Kevin' });

// -- (3) first open on lineA: 201, created, seeded, dossier-composed prompt -
let seededPrompt = null;
let threadExt = null;
{
  let postCalls = [];
  const stubPost = async (text, externalId, messageId) => {
    postCalls.push({ text, externalId, messageId });
    return '[stub] posted';
  };

  const result = await openRoute(lineA, { dossierOpts: { runOneShot: stubRunOneShot }, postMessage: stubPost });

  check('first open returns 201', result.status === 201);
  check('first open reports created:true', result.body.created === true);
  check('first open thread_ext is deterministic per line_id', result.body.thread_ext === notepadHandoffThreadExt(lineA));
  check('first open seeded_prompt is a non-empty string', typeof result.body.seeded_prompt === 'string' && result.body.seeded_prompt.length > 0);

  threadExt = result.body.thread_ext;
  seededPrompt = result.body.seeded_prompt;

  check('seeded_prompt carries the line verbatim', seededPrompt.includes('grab milk on the way home'));
  check("seeded_prompt names the marker's kind", seededPrompt.includes('JARVIS proposed taking this on'));
  check("seeded_prompt carries the marker's reason", seededPrompt.includes('a concrete task JARVIS can do'));
  check('seeded_prompt honestly admits no dossier context (reused from node #107, not invented)', seededPrompt.includes('JARVIS has no context on this line yet'));
  check('seeded_prompt ends with a start-working instruction, not a question back to Kevin', seededPrompt.includes('Start working on this now'));
  check("seeded_prompt matches buildNotepadHandoffPrompt's own contract for confidence:none", seededPrompt.includes('JARVIS has no context') && !/what did you mean/i.test(seededPrompt));

  check('the seed post fired exactly once', postCalls.length === 1);
  check('the seed post used the SAME prompt echoed back in the response', postCalls[0]?.text === seededPrompt);
  check('the seed post targeted the right thread ext', postCalls[0]?.externalId === threadExt);
  check('the seed post used a turn:<id>:0 message id', /^turn:\d+:0$/.test(postCalls[0]?.messageId ?? ''));

  // CANONICAL FORM. These two assertions used to expect the BARE external_id,
  // which is what the handoff wrote -- and that is exactly why every handoff
  // rendered as a dead link in #110's "what it became" column: parseActionRef
  // in notepad-dispatch.ts only understands the prefixed schemes, so a bare
  // ext parsed as null and resolved broken. The prefixed form is the contract
  // (notepad-dispatch.ts documents `thread:<thread_ext>` as canonical and
  // re-stamps the ledger with it), so the CHECK conforms, not the contract.
  const canonicalRef = `thread:${threadExt}`;

  const marker = getNotepadMarker(lineA);
  check("the marker's action_ref holds the canonical thread: ref", marker?.action_ref === canonicalRef);

  const ledger = getNotepadLineState(lineA);
  check("the per-line ledger records state 'acted'", ledger?.state === 'acted');
  check("the per-line ledger's action_ref holds the canonical thread: ref", ledger?.action_ref === canonicalRef);
  check(
    'that ref resolves to a LIVE target (the dead-link regression)',
    resolveNotepadActionRef(canonicalRef).exists === true,
  );

  check('the conversation was actually created', !!getConversation(threadExt));
}

// -- (4) second open on the SAME line: reused, no second seed message -------
{
  let postCalls = 0;
  const stubPost = async () => {
    postCalls++;
    return '[stub] posted';
  };

  const result = await openRoute(lineA, { dossierOpts: { runOneShot: stubRunOneShot }, postMessage: stubPost });

  check('second open returns 200 (not 201)', result.status === 200);
  check('second open reports created:false', result.body.created === false);
  check('second open returns the SAME thread_ext', result.body.thread_ext === threadExt);
  check('second open seeded_prompt is null (nothing (re-)sent)', result.body.seeded_prompt === null);
  check('second open posts NO second seed message', postCalls === 0);

  // Dossier isn't even rebuilt on reuse -- prove it by handing a runOneShot
  // that throws if it's ever invoked, and confirming the call still succeeds.
  const explosive = { runOneShot: async () => { throw new Error('must not be called on a reused thread'); } };
  const again = await openRoute(lineA, { dossierOpts: explosive, postMessage: stubPost });
  check('second open never touches the dossier seam at all', again.status === 200 && postCalls === 0);
}

// -- (5) an independent line, opened WITHOUT stubbing the seed post ---------
//    (exercises the real default: agent.js's processMessage, sim-guarded) --
{
  const result = await openRoute(lineB, { dossierOpts: { runOneShot: stubRunOneShot } });
  check('opening with the real (unstubbed) postMessage default does not throw', result.status === 201);
  check('opening with the real default still reports created:true', result.body.created === true);
  check("lineB's seeded_prompt names its own marker kind/reason", result.body.seeded_prompt.includes('JARVIS flagged this as needing a decision from Kevin') && result.body.seeded_prompt.includes('needs a decision from Kevin'));

  // The fire-and-forget post is async and unawaited inside openNotepadHandoff
  // -- give its microtask/promise chain a tick to actually run (and, under
  // this scratch DB, for sim-guard to refuse it) before the process-count
  // snapshot below.
  await new Promise((resolve) => setTimeout(resolve, 200));
}

// -- (6) buildNotepadHandoffPrompt is a pure composer -- proven directly, ---
//    not just through the route -----------------------------------------
{
  const dossier = {
    line_id: null,
    text: 'irrelevant',
    topic: null,
    confidence: 'none',
    repo: null,
    branch: null,
    goal: null,
    prior_work: [],
    open_question: null,
    evidence: [],
    availability: [],
    rendered: 'JARVIS has no context on this line yet -- "test line" doesn\'t match anything in goals, trees, or recent threads. Starting cold; nothing prior to draw on.',
    unresolved_reason: null,
  };
  const prompt = buildNotepadHandoffPrompt(
    { text: 'test line' },
    { kind: 'already_done', reason: 'this shipped last week' },
    dossier,
  );
  check('buildNotepadHandoffPrompt embeds the exact dossier.rendered text (reused, not rebuilt)', prompt.includes(dossier.rendered));
  check('buildNotepadHandoffPrompt names the already_done kind', prompt.includes('JARVIS believes this is already done'));
  check('buildNotepadHandoffPrompt carries the reason', prompt.includes('this shipped last week'));
}

// -- (6b) THE BLOCK FORM: a marker on a topic headline seeds the WHOLE topic
{
  const BLOCK_DAY = '2026-09-26';
  const savedBlock = putNotepadDay(
    BLOCK_DAY,
    ['Universal KPI Goal', '  - needs a row cap on the prod SELECTs', '     - Ian flagged the 3am run', '  - who owns the value store?'].join('\n'),
  );
  const headlineId = lineIdByText(savedBlock, 'Universal KPI Goal');
  const childIds = savedBlock.lines.filter((l) => l.id !== headlineId).map((l) => l.id);
  reconcileNotepadMarker(headlineId, { kind: 'take_it', reason: 'JARVIS can add the row cap' });

  const resolvedBlock = blockForLine(headlineId);
  check('(6b) the route resolves the headline line to its own topic block', resolvedBlock?.block_id === headlineId && resolvedBlock.lines.length === 4);

  let dossierPrompt = null;
  const result = await openRoute(headlineId, {
    block: resolvedBlock,
    dossierOpts: {
      runOneShot: async (prompt) => {
        dossierPrompt = prompt;
        return stubRunOneShot(prompt);
      },
    },
    postMessage: async () => '[stub] posted',
  });

  check('(6b) first open of the block returns 201', result.status === 201);
  const prompt = result.body.seeded_prompt;
  check('(6b) THE SEED: the prompt names the topic by its headline', prompt.includes('The topic — "Universal KPI Goal"'));
  check(
    '(6b) THE SEED: every child line rides along verbatim, with its line_id and real indentation',
    childIds.every((id) => prompt.includes(`[line_id ${id}] ${savedBlock.lines.find((l) => l.id === id).text}`)),
  );
  check('(6b) THE SEED: it still ends with a start-working instruction', prompt.includes('Start working on this now'));
  check(
    '(6b) THE DOSSIER: the one model call it makes was asked about the BLOCK, not the headline alone',
    dossierPrompt === null || (dossierPrompt.includes('ONE topic BLOCK') && dossierPrompt.includes('Ian flagged the 3am run')),
  );
  check("(6b) the per-line ledger still records 'acted' on the HEADLINE line", getNotepadLineState(headlineId)?.state === 'acted');
}

// -- (7) zero claude processes spawned across the whole run -----------------
const spawnsAfter = claudeProcessCount();
check(`no net new claude processes spawned (before=${spawnsBefore}, after=${spawnsAfter})`, spawnsAfter <= spawnsBefore);

console.log(failed ? '\nFAILED' : '\nALL PASS');
if (!failed) {
  console.log('\n--- sample seeded_prompt (lineA, "- grab milk on the way home") ---');
  console.log(seededPrompt);
  console.log('--- end ---');
}
process.exit(failed ? 1 : 0);
