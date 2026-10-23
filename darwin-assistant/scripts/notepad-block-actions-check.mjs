#!/usr/bin/env node
// NOTEPAD BLOCK ACTIONS ROUTE CHECK (node #1060) — exercises the three block
// action routes added on top of node #1059's forceNotepadBlockRead and node
// #869/#943's openNotepadHandoff:
//   POST /notepad/blocks/:blockId/read  -> forceNotepadBlockRead
//   POST /notepad/blocks/:blockId/chat  -> openNotepadHandoff, now legal on
//                                          a block with NO marker
//   POST /notepad/blocks/:blockId/done  -> markLineDone on every text-bearing
//                                          member line (CARRY-FORWARD.md §6)
//
// HOW THIS IS DRIVEN, AND WHY -- every 400/404 guard, the entire /done route
// (no model call anywhere in it), and /chat's SECOND-call (reused-thread)
// path are driven over the REAL express router via the REAL startUiServer(),
// exactly like notepad-actions-route-check.mjs already does for a
// model-seam-free notepad route. That covers most of this file.
//
// It is NOT possible to drive /read's or /chat's FIRST-open happy path that
// way and stay hermetic: forceNotepadBlockRead -> decideNotepadMoves and
// openNotepadHandoff -> buildTopicDossier both call assertModelSpawnAllowed()
// OUTSIDE their own try/catch the moment no runOneShot stub is supplied
// (notepad-moves.ts, notepad-dossier.ts) -- under a scratch DB/JARVIS_SIM=1
// that throws synchronously, by design (sim-guard.ts's whole point: a sim
// must never be able to reach a real billed spawn). The real routes take no
// request-body lever to inject a stub (nor should they -- that is not a sane
// production API surface). notepad-handoff-route-check.mjs and
// notepad-force-read-check.mjs hit this exact wall already and resolved it
// the same way this file does: reimplement the route's own thin guard
// (here, resolveBlockAnchor -- copied verbatim from api-v1.ts's
// resolveNotepadBlockAnchor) and call the REAL exported function the route
// calls (forceNotepadBlockRead / openNotepadHandoff) with a stubbed model
// seam, then compose the response with the SAME dayWithMarkers() shape
// api-v1.ts's notepadDayWithMarkers() produces (openNotepadDay +
// activeNotepadMarkers + notepadBlockStates, unchanged). Every one of those
// direct-call assertions is cross-checked against a real HTTP GET /notepad
// afterward, so an accidental drift between this file's composition and the
// route's own would still be caught.
//
//   npm run build && JARVIS_DB_PATH=/tmp/notepad-block-actions-check.db JARVIS_SIM=1 node scripts/notepad-block-actions-check.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

process.env.JARVIS_SIM = '1';
delete process.env.ANTHROPIC_API_KEY;

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

console.log(`[notepad-block-actions-check] DB: ${DB_PATH}`);

function claudeProcessCount() {
  try {
    const out = execSync('pgrep -c -f claude', { encoding: 'utf8' });
    return parseInt(out.trim(), 10) || 0;
  } catch (err) {
    if (err && err.status === 1) return 0;
    throw err;
  }
}

const spawnsBefore = claudeProcessCount();

process.env.JARVIS_SMARTY_PANTS_URL = 'http://127.0.0.1:1';
process.env.JARVIS_MCP_NATIVE_TIMEOUT_MS = '5000';

// A spare port, set BEFORE ui-server.js is imported (UI_PORT is computed at
// module-load time from this env var).
const PORT = 35678 + (process.pid % 1000);
process.env.JARVIS_UI_PORT = String(PORT);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

const distDir = path.join(repoRoot, 'dist');
const { putNotepadDay, getNotepadLineState, getNotepadDay, getNotepadLineDay } = await import(path.join(distDir, 'notepad.js'));
const { parseNotepadBlocks, notepadBlockId } = await import(path.join(distDir, 'notepad-blocks.js'));
const { getNotepadMarker, activeNotepadMarkers } = await import(path.join(distDir, 'notepad-markers.js'));
const { openNotepadDay } = await import(path.join(distDir, 'notepad-rollover.js'));
const { notepadBlockStates } = await import(path.join(distDir, 'notepad-block-state.js'));
const { resolveActionRef: resolveNotepadActionRef } = await import(path.join(distDir, 'notepad-action-resolver.js'));
const { openNotepadHandoff, notepadHandoffThreadExt } = await import(path.join(distDir, 'notepad-handoff.js'));
const { forceNotepadBlockRead } = await import(path.join(distDir, 'notepad-force-read.js'));
const { getConversation, getTurns } = await import(path.join(distDir, 'conversation-db.js'));
const { mintApiKey } = await import(path.join(distDir, 'api-keys.js'));
const { startUiServer } = await import(path.join(distDir, 'ui-server.js'));
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

startUiServer();
const { plaintext: apiKey } = mintApiKey('notepad-block-actions-check', 'admin');

async function httpPost(pathAndQuery, body) {
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let respBody = null;
  try {
    respBody = await res.json();
  } catch {
    respBody = null;
  }
  return { status: res.status, body: respBody };
}

async function httpGet(pathAndQuery) {
  const res = await fetch(`${BASE}${pathAndQuery}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  let respBody = null;
  try {
    respBody = await res.json();
  } catch {
    respBody = null;
  }
  return { status: res.status, body: respBody };
}

// ── the same composition api-v1.ts's notepadDayWithMarkers() performs ──────
function dayWithMarkers(day) {
  const base = openNotepadDay(day);
  const markers = activeNotepadMarkers(day).map((m) => ({
    line_id: m.line_id,
    kind: m.kind,
    reason: m.reason,
    action_ref: m.action_ref,
  }));
  const blocks = notepadBlockStates(day);
  return { ...base, markers, blocks };
}

// ── the same guard api-v1.ts's resolveNotepadBlockAnchor performs ──────────
function resolveBlockAnchor(blockId) {
  const day = getNotepadLineDay(blockId);
  if (!day) return null;
  const { lines } = getNotepadDay(day);
  const block = parseNotepadBlocks(lines).find((b) => notepadBlockId(b) === blockId);
  if (!block) return null;
  return { day, block };
}

// ── the same block shape api-v1.ts's notepadBlockForLine produces ──────────
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

// Mirrors POST /notepad/blocks/:blockId/read exactly, but with a stubbable
// model seam -- see the file header for why this can't be real HTTP.
async function readRoute(blockId, forceOpts = {}) {
  if (!Number.isInteger(blockId) || blockId <= 0) {
    return { status: 400, body: { error: 'invalid_block_id' } };
  }
  const resolved = resolveBlockAnchor(blockId);
  if (!resolved) return { status: 404, body: { error: 'block_not_found' } };
  const result = await forceNotepadBlockRead(resolved.day, blockId, forceOpts);
  return { status: 200, body: { ...dayWithMarkers(resolved.day), read: { outcome: result.outcome, marker: result.marker } } };
}

// Mirrors POST /notepad/blocks/:blockId/chat exactly, but with a stubbable
// model seam.
async function chatRoute(blockId, handoffOpts = {}) {
  if (!Number.isInteger(blockId) || blockId <= 0) {
    return { status: 400, body: { error: 'invalid_block_id' } };
  }
  const resolved = resolveBlockAnchor(blockId);
  if (!resolved) return { status: 404, body: { error: 'block_not_found' } };
  const result = await openNotepadHandoff(blockId, { block: blockForLine(blockId), allowMarkerless: true, ...handoffOpts });
  return { status: result.created ? 201 : 200, body: { ...dayWithMarkers(resolved.day), chat: result } };
}

// ── (1) malformed blockId -> 400 on all three, via REAL HTTP ───────────────
// sendError's real shape is {error: {code, message}} (see api-v1.ts's
// sendError), matching notepad-actions-route-check.mjs's own assertions --
// not the flat {error: '<code>'} shape the OTHER sibling checks' locally
// REIMPLEMENTED route logic happens to use.
for (const action of ['read', 'chat', 'done']) {
  const nonNumeric = await httpPost(`/notepad/blocks/abc/${action}`);
  check(`${action}: non-numeric blockId returns 400`, nonNumeric.status === 400 && nonNumeric.body?.error?.code === 'invalid_block_id');
  const zero = await httpPost(`/notepad/blocks/0/${action}`);
  check(`${action}: blockId 0 returns 400`, zero.status === 400 && zero.body?.error?.code === 'invalid_block_id');
}

// ── (2) unknown blockId -> 404 on all three, via REAL HTTP ─────────────────
for (const action of ['read', 'chat', 'done']) {
  const result = await httpPost(`/notepad/blocks/999999999/${action}`);
  check(`${action}: unknown blockId returns 404`, result.status === 404 && result.body?.error?.code === 'block_not_found');
}

// ── (3) /read happy path -- MOVE outcome (direct call, stubbed model) ──────
const D_READ_MOVE = '2026-09-10';
let moveHeadlineId;
{
  const saved = putNotepadDay(D_READ_MOVE, ['Topic Read Move', '  - alpha read'].join('\n'));
  moveHeadlineId = lineIdByText(saved, 'Topic Read Move');

  // #191 contract: a forced read ALWAYS answers. The stub returns the
  // {kind, take, one_liner} shape the rewritten forceNotepadBlockRead asks for.
  const stub = async () => JSON.stringify({ kind: 'take_it', take: 'JARVIS can take this — full take here.', one_liner: 'JARVIS can take this' });
  const result = await readRoute(moveHeadlineId, { runOneShot: stub });

  check('read (answered): 200', result.status === 200);
  check('read (answered): read.outcome is answered', result.body.read.outcome === 'answered');
  check('read (answered): read.marker carries kind + the ONE-LINER as reason', result.body.read.marker?.kind === 'take_it' && result.body.read.marker?.reason === 'JARVIS can take this');
  check(
    'read (answered): response markers[] ALREADY carries the new marker -- no second fetch needed',
    result.body.markers.some((m) => m.line_id === moveHeadlineId && m.kind === 'take_it'),
  );
  check(
    // The forced read now writes `acted` + a thread link, so the gutter state
    // is ACTED (linked), which outranks `move` in the block-state precedence.
    'read (answered): response blocks[] ALREADY reports gutter state acted -- no second fetch needed',
    result.body.blocks.find((b) => b.headline_line_id === moveHeadlineId)?.state === 'acted',
  );
  check(
    'read (answered): the take landed IN THE THREAD as an assistant turn',
    (() => {
      const conv = getConversation(notepadHandoffThreadExt(moveHeadlineId));
      if (!conv) return false;
      const turns = getTurns(conv.id);
      return turns.some((t) => t.role === 'assistant' && /full take here/.test(t.content ?? ''));
    })(),
  );
  check(
    'read (answered): marker action_ref is the canonical thread:<ext>',
    result.body.read.marker?.action_ref === `thread:${notepadHandoffThreadExt(moveHeadlineId)}`,
  );

  // Cross-check against a real HTTP GET, proving this file's dayWithMarkers()
  // composition matches the real route's, not a divergent reimplementation.
  const httpView = await httpGet(`/notepad?date=${D_READ_MOVE}`);
  check('read (answered): a real GET /notepad sees the same marker', httpView.body.markers.some((m) => m.line_id === moveHeadlineId && m.kind === 'take_it'));
}

// ── (4) /read happy path -- SILENT outcome (direct call, stubbed model) ────
const D_READ_SILENT = '2026-09-11';
{
  const saved = putNotepadDay(D_READ_SILENT, ['Topic Read Silent', '  - beta silent'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic Read Silent');
  const childId = lineIdByText(saved, '  - beta silent');

  // #191 KILLED the silent outcome for forced reads -- "read, nothing to
  // add" was a non-answer to a direct question (Kevin, 2026-09-27). The
  // old moves-shaped empty response is now GARBAGE to the parser (no
  // `take` field), so it must land as FALLBACK: nothing written anywhere.
  const stub = async () => JSON.stringify({ moves: [] });
  const result = await readRoute(headlineId, { runOneShot: stub });

  check('read (no-silent): 200', result.status === 200);
  check('read (no-silent): outcome is fallback, NEVER silent', result.body.read.outcome === 'fallback');
  check("read (no-silent): the outcome vocabulary no longer contains 'silent'", ['answered', 'fallback'].includes(result.body.read.outcome));
  check('read (no-silent): read.marker is null', result.body.read.marker === null);
  check('read (no-silent): response markers[] stays empty', result.body.markers.length === 0);
  check('read (no-silent): NOTHING written -- headline has no ledger row', getNotepadLineState(headlineId) === undefined);
  check('read (no-silent): NOTHING written -- member line has no ledger row', getNotepadLineState(childId) === undefined);
  check('read (no-silent): NO thread was created', getConversation(notepadHandoffThreadExt(headlineId)) === undefined);
}

// ── (5) /chat on a MARKERLESS block -- creation (direct call, stubbed model)
const D_CHAT = '2026-09-12';
let chatHeadlineId;
let firstChatResult;
{
  const saved = putNotepadDay(D_CHAT, ['Kevin opened topic himself', '  - child one', '  - child two'].join('\n'));
  chatHeadlineId = lineIdByText(saved, 'Kevin opened topic himself');

  check('chat markerless precondition: no marker exists on this line', getNotepadMarker(chatHeadlineId) === undefined);

  const stubDossier = async () => '{}';
  const postCalls = [];
  const stubPost = async (text, externalId, messageId) => {
    postCalls.push({ text, externalId, messageId });
    return '[stub] posted';
  };

  const result = await chatRoute(chatHeadlineId, { dossierOpts: { runOneShot: stubDossier }, postMessage: stubPost });
  firstChatResult = result;

  check('chat markerless: 201', result.status === 201);
  check('chat markerless: created true', result.body.chat.created === true);
  check('chat markerless: thread_ext is deterministic per line_id', result.body.chat.thread_ext === notepadHandoffThreadExt(chatHeadlineId));

  const seededPrompt = result.body.chat.seeded_prompt;
  check('chat markerless: seeded_prompt is a non-empty string', typeof seededPrompt === 'string' && seededPrompt.length > 0);
  check('chat markerless: says Kevin opened this himself, no JARVIS judgement yet', seededPrompt.includes('Kevin opened this notepad topic himself') && seededPrompt.includes('no JARVIS judgement on it yet'));
  check(
    'chat markerless: does NOT invent a move kind label',
    !seededPrompt.includes('JARVIS proposed taking this on') &&
      !seededPrompt.includes('JARVIS flagged this as needing a decision') &&
      !seededPrompt.includes('JARVIS believes this is already done'),
  );
  check('chat markerless: still ends with a start-working instruction', seededPrompt.includes('Start working on this now'));
  check('chat markerless: the whole block rides along verbatim', seededPrompt.includes('child one') && seededPrompt.includes('child two'));

  check('chat markerless: the seed post fired exactly once', postCalls.length === 1);
  check('chat markerless: the seed post used the same prompt echoed back', postCalls[0]?.text === seededPrompt);
  check('chat markerless: the seed post targeted the right thread ext', postCalls[0]?.externalId === result.body.chat.thread_ext);

  const canonicalRef = `thread:${result.body.chat.thread_ext}`;
  const ledger = getNotepadLineState(chatHeadlineId);
  check('chat markerless: no marker row was ever created (there was nothing to hang one on)', getNotepadMarker(chatHeadlineId) === undefined);
  check('chat markerless: the per-line ledger STILL records acted with the CANONICAL thread: ref', ledger?.state === 'acted' && ledger?.action_ref === canonicalRef);
  check('chat markerless: that ref resolves to a LIVE conversation (the dead-link regression)', resolveNotepadActionRef(canonicalRef).exists === true);
  check('chat markerless: the conversation was actually created', !!getConversation(result.body.chat.thread_ext));
  check('chat markerless: response day payload already carries markers[]/blocks[] (no second fetch needed)', Array.isArray(result.body.markers) && Array.isArray(result.body.blocks));

  const httpView = await httpGet(`/notepad?date=${D_CHAT}`);
  check('chat markerless: a real GET /notepad agrees the block is now acted', httpView.body.blocks.find((b) => b.headline_line_id === chatHeadlineId)?.state === 'acted');
}

// ── (6) /chat twice -- reused thread, driven over REAL HTTP this time ──────
// (this call structurally cannot reach the model seam: openNotepadHandoff
// returns from its find-or-create check the moment `existing` is truthy,
// before buildTopicDossier is ever called -- so hitting it unstubbed, for
// real, over the real router is genuinely hermetic.)
{
  const second = await httpPost(`/notepad/blocks/${chatHeadlineId}/chat`);
  check('chat second call (real HTTP): 200, not 201', second.status === 200);
  check('chat second call: created false', second.body.chat.created === false);
  check('chat second call: SAME thread_ext as the first call', second.body.chat.thread_ext === firstChatResult.body.chat.thread_ext);
  check('chat second call: seeded_prompt is null (nothing (re-)sent)', second.body.chat.seeded_prompt === null);

  const ledgerAfter = getNotepadLineState(chatHeadlineId);
  const canonicalRef = `thread:${firstChatResult.body.chat.thread_ext}`;
  check('chat second call: the ledger ref is unchanged (no re-seed, no re-write)', ledgerAfter?.action_ref === canonicalRef && ledgerAfter?.state === 'acted');
}

// ── (7) /done -- every text-bearing member line, blank lines skipped,
//        idempotent, and a following rollover leaves the block behind ──────
const D_DONE = '2026-09-13';
const D_DONE_NEXT = '2026-09-14';
{
  const saved = putNotepadDay(D_DONE, ['Topic Done', '  - alpha', '   ', '  - beta'].join('\n'));
  const headlineId = lineIdByText(saved, 'Topic Done');
  const alphaId = lineIdByText(saved, '  - alpha');
  const blankId = lineIdByText(saved, '   ');
  const betaId = lineIdByText(saved, '  - beta');

  const before = await httpGet(`/notepad?date=${D_DONE}`);
  check('done precondition: the block starts out unseen', before.body.blocks.find((b) => b.headline_line_id === headlineId)?.state === 'unseen');

  const result = await httpPost(`/notepad/blocks/${headlineId}/done`);
  check('done: 200', result.status === 200);
  check(
    'done: response blocks[] ALREADY reflects the change (unseen -> seen) -- no second fetch needed',
    result.body.blocks.find((b) => b.headline_line_id === headlineId)?.state === 'seen',
  );

  check('done: headline marked done', getNotepadLineState(headlineId)?.state === 'done');
  check('done: alpha marked done', getNotepadLineState(alphaId)?.state === 'done');
  check('done: beta marked done', getNotepadLineState(betaId)?.state === 'done');
  check('done: the blank line is skipped -- no ledger row at all', getNotepadLineState(blankId) === undefined);

  const again = await httpPost(`/notepad/blocks/${headlineId}/done`);
  check('done: calling it twice is not an error (idempotent)', again.status === 200);
  check('done: still done after the second call', getNotepadLineState(alphaId)?.state === 'done');

  // #188 VERIFIER GAP 1 -- `Mark done` must not erase what the block BECAME.
  // Drive the REAL chain: open a chat on this block (writes action_ref
  // `thread:<ext>` + an `acted` ledger row), THEN mark it done, THEN ask the
  // STORE whether the link survived. The bug this pins was a bare
  // `action_ref = excluded.action_ref` in notepad.ts's UPSERT, which NULLed the
  // ref on every state that carries none -- so a finished topic silently lost
  // the thread Kevin had just opened from it.
  {
    const chat = await httpPost(`/notepad/blocks/${headlineId}/chat`);
    // 201 on first creation, 200 on reuse -- the route's own documented shape.
    check('done+ref: chat on the block first -> 200/201', chat.status === 200 || chat.status === 201);
    const refAfterChat = getNotepadLineState(headlineId)?.action_ref ?? null;
    check('done+ref: the chat wrote a thread: action_ref', !!refAfterChat && refAfterChat.startsWith('thread:'));

    const reDone = await httpPost(`/notepad/blocks/${headlineId}/done`);
    check('done+ref: marking done again -> 200', reDone.status === 200);
    const st = getNotepadLineState(headlineId);
    check('done+ref: state is done', st?.state === 'done');
    check(
      'done+ref: the action_ref SURVIVED being marked done (not NULLed)',
      st?.action_ref === refAfterChat,
    );
  }

  const rolled = await httpGet(`/notepad?date=${D_DONE_NEXT}`);
  const rolledTexts = rolled.body.lines.map((l) => l.text);
  check(
    'done: a done topic is NOT carried forward by a real rollover',
    !rolledTexts.includes('Topic Done') && !rolledTexts.includes('  - alpha') && !rolledTexts.includes('  - beta'),
  );
}

// ── (8) zero net new claude processes spawned across the whole run ─────────
const spawnsAfter = claudeProcessCount();
check(`no net new claude processes spawned (before=${spawnsBefore}, after=${spawnsAfter})`, spawnsAfter <= spawnsBefore);

console.log(failed ? '\nFAILED' : '\nALL PASS');
process.exit(failed ? 1 : 0);
