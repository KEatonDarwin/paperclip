import { buildNotepadReviewContext } from './notepad-review.js';
import { reconcileNotepadMarker, type NotepadMarker, type NotepadMarkerKind } from './notepad-markers.js';
import { markLineActed } from './notepad.js';
import { notepadBlockId } from './notepad-blocks.js';
import { notepadOneShot } from './notepad-moves.js';
import { notepadHandoffThreadExt } from './notepad-handoff.js';
import { addTurn, getConversation, getOrCreateConversation, renameConversation, getSetting } from './conversation-db.js';

// Node #191 -- "Read & respond ALWAYS responds -- in a chat, boiled down on
// the hover." This replaces node #1059's first cut, which routed the forced
// read through decideNotepadMoves and inherited the background pass's
// silence discipline. Kevin hit exactly that on 2026-09-27: he clicked
// Read & respond on his "Jarvis Harness" block and got "read -- nothing to
// add". His words: "What I would expect is it would read it, and it would
// have a response no matter what."
//
// The design distinction this file now encodes:
//
//   UNPROMPTED pass (notepad-speak.ts)  -> silence is a feature. JARVIS
//     reads uninvited, so it speaks only when it has a real move (#62).
//   FORCED read (this file)             -> silence is a non-answer. Kevin's
//     click is a QUESTION, and questions get answers. The model is required
//     to produce a take -- "this could work, with caveats" beats quiet.
//
// One sonnet one-shot produces BOTH deliverables:
//   - `take`      -> the full response, written INTO the block's chat thread
//                    (the same deterministic cockpit:notepad-line-<id> thread
//                    the #108 handoff uses, so a later "Open a chat" click
//                    lands in the same conversation, never a duplicate).
//   - `one_liner` -> the marker's reason, i.e. what the HOVER shows, with
//                    action_ref = thread:<ext> so the hover links to the chat.
//
// The thread write uses conversation-db's addTurn directly -- an assistant
// message inserted with NO model turn spawned in the thread (agent.ts's own
// persistence path, and addTurn emits the SSE event so an open cockpit sees
// it live). processMessage is deliberately NOT called: the take was already
// generated; asking the thread's model to re-answer would double the cost
// and the wait.
//
// What survives from the first cut, verbatim in spirit:
//   - Both gates stay bypassed (settle + "complete thought") -- the click is
//     the trigger.
//   - The daily marker budget does not apply -- he asked, he pays.
//   - `fallback` writes NOTHING anywhere -- a broken model call must never
//     be laundered into an answer, a marker, or a thread post.
//   - Unknown block id throws -- the route turns it into a 404.

/** The outcome of one forced block read -- see the module doc above. */
export interface ForceNotepadBlockReadResult {
  block_id: number;
  /** Non-null on 'answered' -- the marker whose reason is the one-liner. */
  marker: NotepadMarker | null;
  /** The block's chat thread ext, non-null on 'answered'. */
  thread_ext: string | null;
  /** True when this call CREATED the thread (vs appending to an existing one). */
  thread_created: boolean;
  /** 'answered' -- take posted to the thread, marker holds the one-liner.
   *  'fallback' -- the model call failed/timed out; nothing was written.
   *  (There is deliberately NO 'silent' outcome. See module doc.) */
  outcome: 'answered' | 'fallback';
}

const KINDS: NotepadMarkerKind[] = ['take_it', 'question', 'already_done', 'context'];
const ONE_LINER_MAX = 180;

function forcedReadTimeoutMs(): number {
  const raw = getSetting('notepad_moves_timeout_ms');
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 30_000 ? n : 600_000;
}

/** Reject after `ms` without leaking the timer -- same shape as notepad-moves. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`forced read timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

interface ForcedTake {
  kind: NotepadMarkerKind;
  take: string;
  one_liner: string;
}

/** Strict-ish JSON parse: tolerate code fences and stray prose around the
 *  object, reject anything missing the three required fields. Returns null
 *  on garbage -- the caller treats that as a fallback, never as an answer. */
export function parseForcedTake(raw: string): ForcedTake | null {
  const text = raw.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Partial<ForcedTake>;
    const kind = KINDS.includes(obj.kind as NotepadMarkerKind) ? (obj.kind as NotepadMarkerKind) : 'context';
    const take = typeof obj.take === 'string' ? obj.take.trim() : '';
    let oneLiner = typeof obj.one_liner === 'string' ? obj.one_liner.trim() : '';
    if (!take) return null;
    // A missing one-liner degrades gracefully to the take's first line --
    // never to silence.
    if (!oneLiner) oneLiner = take.split('\n')[0].slice(0, ONE_LINER_MAX);
    if (oneLiner.length > ONE_LINER_MAX) oneLiner = `${oneLiner.slice(0, ONE_LINER_MAX - 1)}…`;
    return { kind, take, one_liner: oneLiner };
  } catch {
    return null;
  }
}

function buildForcedPrompt(rendered: string, headline: string | null, blockText: string): string {
  return [
    'You are JARVIS. Kevin clicked "Read & respond" on ONE topic block in his daily notepad.',
    'That click is a direct question: "what do you think about this?" — so you MUST answer.',
    'Silence, "nothing to add", or restating his words are all failures. If the topic is thin,',
    'say what is missing and propose the next concrete step. If it is an idea, give a real take —',
    '"this could work, with these caveats" — grounded in what the rest of the note tells you.',
    '',
    '=== THE BLOCK HE ASKED ABOUT ===',
    headline !== null ? `Headline: ${JSON.stringify(headline)}` : '(no headline — a leading fragment)',
    blockText,
    '',
    '=== HIS FULL NOTE TODAY (context; prior JARVIS actions are pinned per line) ===',
    rendered,
    '',
    'Reply with STRICT JSON only, no code fences, exactly this shape:',
    '{"kind":"take_it|question|already_done|context","take":"<your full response in markdown — the real substance, a few paragraphs is fine>","one_liner":"<one sentence, max 140 chars — the hover-card version of your take>"}',
    '',
    'kind: take_it = you could run with this yourself; question = you need ONE decision from Kevin first',
    '(and your take should end with that question); already_done = this exists, say where; context = analysis/opinion.',
  ].join('\n');
}

/**
 * Force a read of ONE block, right now, and ALWAYS answer.
 *
 * Throws if `blockId` does not name a real block on `day` (a stale client is
 * a loud 404, never a silent no-op). `opts.runOneShot`/`opts.timeoutMs` are
 * the usual injection seams for sims/checks.
 */
export async function forceNotepadBlockRead(
  day: string,
  blockId: number,
  opts?: { runOneShot?: (prompt: string) => Promise<string>; timeoutMs?: number; now?: Date },
): Promise<ForceNotepadBlockReadResult> {
  const review = buildNotepadReviewContext(day);
  const block = review.blocks.find((b) => notepadBlockId(b) === blockId);
  if (!block) {
    throw new Error(`notepad block ${blockId} not found on day ${day}`);
  }

  const textByLineId = new Map(review.lines.map((l) => [l.line_id, l.text]));
  const blockText = block.member_line_ids
    .map((id) => `[line_id ${id}] ${textByLineId.get(id) ?? ''}`)
    .join('\n');

  const prompt = buildForcedPrompt(review.rendered, block.headline, blockText);
  const run = opts?.runOneShot ?? notepadOneShot;
  const timeoutMs = opts?.timeoutMs ?? forcedReadTimeoutMs();

  let parsed: ForcedTake | null = null;
  try {
    parsed = parseForcedTake(await withTimeout(run(prompt), timeoutMs));
  } catch {
    parsed = null;
  }
  // Model failure or garbage out -> FALLBACK: write nothing anywhere. The
  // route surfaces it as an error state, which is the honest answer -- "the
  // read broke" must stay distinguishable from any kind of answer.
  if (!parsed) {
    return { block_id: blockId, marker: null, thread_ext: null, thread_created: false, outcome: 'fallback' };
  }

  // ── The chat: same deterministic per-line thread the #108 handoff uses,
  // so Read & respond and Open a chat always converge on ONE conversation.
  const externalId = notepadHandoffThreadExt(blockId);
  const existing = getConversation(externalId);
  const conv = getOrCreateConversation(externalId);
  const created = !existing;
  if (created) {
    const headlineText = block.headline ?? textByLineId.get(blockId) ?? `notepad block ${blockId}`;
    renameConversation(conv.id, headlineText.slice(0, 120));
  }
  // The action record (visible, honest: he clicked, this is what was read),
  // then the take as a plain assistant message. addTurn emits SSE, so an
  // open cockpit sees both land live. NO model turn is spawned here.
  addTurn(conv.id, 'user', `[Read & respond] Kevin asked for a take on this notepad block:\n\n${blockText}`);
  addTurn(conv.id, 'assistant', parsed.take);

  // ── The hover: one-liner as the marker's reason, linked to the chat.
  // forced:true -- his click today outranks a dismissal yesterday (#104's
  // memory stays fully in force for the unprompted pass).
  const actionRef = `thread:${externalId}`;
  const marker = reconcileNotepadMarker(
    blockId,
    { kind: parsed.kind, reason: parsed.one_liner, action_ref: actionRef },
    { forced: true },
  );
  // Ledger: the block ACTED and is linked -- the gutter flips to "acted",
  // #110's column resolves the ref, rollover keeps carrying it (an answered
  // question is not a closed topic; Mark done is what closes it).
  markLineActed(blockId, actionRef);

  return { block_id: blockId, marker, thread_ext: externalId, thread_created: created, outcome: 'answered' };
}
