import { execFile } from 'node:child_process';
import { getSetting } from './conversation-db.js';
import { assertModelSpawnAllowed } from './notepad-gate.js';
import { notepadBlockId } from './notepad-blocks.js';
import { buildNotepadReviewContext } from './notepad-review.js';
import type { NotepadReviewContext } from './notepad-review.js';
import { extractJsonObject } from './tools/ux-reviewer/vision-critique.js';

// The speaking bar (goal 6 node #103 / #62's "JARVIS speaks only when it has
// something worth saying"): given the whole-note review context (node #99/
// #100's buildNotepadReviewContext + runNotepadPass), decide -- per topic
// BLOCK -- whether there is a REAL move here, and which of exactly four kinds:
//
//   take_it      -- "I can take this."
//   question     -- "a question that changes the work."
//   already_done -- "you already did this."
//   context      -- "here's context you're missing."
//
// NODE #943 -- WHY THIS IS PER-BLOCK NOW. Kevin, 2026-09-26: "one line at a
// time isn't exactly a 'thing to do' every time... never look at the line on
// its own, look at the entire block." A move is decided about a whole topic
// (a zero-indent headline plus everything indented under it, per
// docs/notepad/BLOCKS.md) rather than about one dash fragment that only makes
// sense next to its siblings. Storage, line identity, the per-line state
// ledger and carry-forward are UNTOUCHED by this -- `surfaced` still comes
// from notepad.ts's unscannedLines() one line at a time, and a block only
// enters play when one of its OWN member lines surfaces. Blocks are the
// judgment layer; the ledger still remembers by line.
//
// SILENCE IS THE DEFAULT, at every layer this module touches:
//   - zero candidate blocks -> zero model call, empty moves, no exception.
//   - the model call itself fails/times out -> EVERY candidate is silent,
//     never guessed at.
//   - a malformed/incomplete/duplicate/unrecognized entry in the model's
//     response is dropped, never upgraded into a move.
//   - the model is instructed, explicitly, that omission IS the answer for
//     everything it is not confident about -- there is no "none" kind to
//     emit, because emitting anything at all is the noisy path.
//   - the prompt's silence instruction is a request, not a guarantee -- if
//     an over-eager model returns a validly-shaped move for every single
//     candidate anyway, capMoves() below enforces the "handful, not one per
//     block" noise budget as a hard invariant of this module's OUTPUT,
//     independent of what the model actually said.
//
// This module makes exactly one model call (one sonnet one-shot) per
// invocation, batched over every candidate block, mirroring notepad-gate.ts's
// shape. It does NOT write to the per-line ledger and does NOT persist a
// marker anywhere -- that is goal node #104 ("a marker belongs to the line,
// survives edits, and never fires twice"), a separate layer. This function
// only decides; a caller acts on what it returns.

/** The four kinds of real move JARVIS can have on a notepad block. Nothing
 *  else is a move -- everything else is silence. */
export type NotepadMoveKind = 'take_it' | 'question' | 'already_done' | 'context';

const MOVE_KINDS: ReadonlySet<string> = new Set<NotepadMoveKind>(['take_it', 'question', 'already_done', 'context']);

/**
 * One BLOCK that is up for a move decision. Shaped identically to
 * notepad-gate.ts's GateBlockCandidate on purpose -- the two judgment stages
 * speak the same block vocabulary, so a verdict from either resolves back to
 * the same per-line ids.
 */
export interface MoveBlockCandidate {
  block_id: number;
  headline_line_id: number | null;
  headline: string | null;
  member_line_ids: number[];
  /** The block rendered verbatim, one "[line_id N] <raw text>" row per member. */
  text: string;
}

/** One block's real move: at most one of these exists per block_id in a
 *  NotepadMovesResult -- a block with no move simply has no entry.
 *
 *  `block_id` is the headline line's id (or the first member's id for a
 *  headline:null lead-in block), which is exactly the line a caller stamps
 *  the marker and the `acted` ledger row onto; `member_line_ids` is how the
 *  rest of the block gets marked `seen` in the same act. */
export interface NotepadMove {
  block_id: number;
  headline_line_id: number | null;
  member_line_ids: number[];
  kind: NotepadMoveKind;
  reason: string; // one short line, never empty
}

/**
 * Why `moves` has the shape it does:
 *  - 'no_candidates' -- the review context had zero blocks with a surfaced
 *    member line; no model call was made at all.
 *  - 'model'          -- the model call completed; `moves` is whatever it
 *    validly proposed (often empty -- an empty response is a correct,
 *    common answer, not a failure), CAPPED to the noise budget
 *    (settings-KV `notepad_moves_max_per_day`, default 5) if the model
 *    over-proposed -- see capMoves() below.
 *  - 'fallback'        -- the model call itself failed (spawn error,
 *    non-zero exit, timeout); `moves` is forced empty regardless of what a
 *    partial/garbled response might have contained.
 */
export type NotepadMovesOutcome = 'no_candidates' | 'model' | 'fallback';

export interface NotepadMovesResult {
  day: string;
  /** How many BLOCKS were in play (node #943 -- this used to count lines). */
  candidate_count: number;
  moves: NotepadMove[]; // sparse -- absence of an entry for a block_id IS silence
  outcome: NotepadMovesOutcome;
}

const CLAUDE_BIN = process.env.UX_REVIEWER_CLAUDE_BIN || 'claude';
const DEFAULT_MOVES_MODEL = 'claude-sonnet-5';
// Same correction as the gate's (see notepad-gate.ts): the moves prompt is
// the whole reviewable day plus every dossier, and 30s never once survived a
// real note -- it fell back to "no moves", which is indistinguishable from a
// quiet day. The dry run needed 1,140s; this is the production floor.
const DEFAULT_MOVES_TIMEOUT_MS = 600 * 1000;

/** Settings-KV override so a slow day can be widened without a deploy. */
function movesTimeoutMs(): number {
  const raw = getSetting('notepad_moves_timeout_ms');
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 5_000 ? n : DEFAULT_MOVES_TIMEOUT_MS;
}

// Goal #62's whole point: "a normal day produces a handful of markers, not
// one per line." The prompt ASKS the model to stay silent, but a prompt is
// not an invariant -- an over-eager or misbehaving model can still return a
// well-formed, validly-shaped move for every single candidate. This cap is
// what makes the noise budget true regardless of what the model actually
// does, the same way the four-kind/one-per-block checks in
// parseMovesResponse hold regardless of what the model returns. Since node
// #943 the unit it counts is BLOCKS per day, not lines -- which is the
// budget Kevin actually meant, since one topic he wrote is one thing JARVIS
// might speak up about.
const DEFAULT_MAX_MOVES_PER_DAY = 5;

function movesModelSetting(): string {
  const raw = getSetting('notepad_moves_model');
  return raw && raw.trim() ? raw.trim() : DEFAULT_MOVES_MODEL;
}

function movesMaxPerDaySetting(): number {
  const raw = getSetting('notepad_moves_max_per_day');
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_MOVES_PER_DAY;
}

/**
 * The real CLI spawn -- NO API KEYS (deletes ANTHROPIC_API_KEY from the
 * child env), same `claude -p <prompt> --output-format json --model <id>`
 * shape as notepad-gate.ts/jarvis-brief.ts/workbench.ts. Re-asserts the
 * guard defensively at the actual spawn site, same discipline as the gate.
 */
function defaultRunOneShot(prompt: string): Promise<string> {
  assertModelSpawnAllowed();
  const model = movesModelSetting();
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return new Promise((resolve, reject) => {
    execFile(
      CLAUDE_BIN,
      ['-p', prompt, '--output-format', 'json', '--model', model],
      { timeout: movesTimeoutMs(), maxBuffer: 16 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error(`notepad moves call failed: ${err.message}${stderr ? ` | ${stderr.slice(0, 300)}` : ''}`));
          return;
        }
        try {
          const envelope = JSON.parse(stdout.trim()) as { result?: string };
          resolve(typeof envelope.result === 'string' ? envelope.result : stdout);
        } catch {
          resolve(stdout);
        }
      },
    );
  });
}

/** Reject `promise` with a timeout error after `ms`, without leaking the timer. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`notepad moves call timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Which BLOCKS are up for a move decision: every block in the review context
 * that has at least one currently-surfaced member line.
 *
 * `surfaced` is still decided one line at a time by notepad.ts's
 * unscannedLines(day) (per docs/notepad/LINE-IDENTITY.md) -- this only groups
 * that answer by block. One surfaced child is enough to put its whole topic
 * in play, junk siblings included, because judging a child without its
 * headline is precisely the mistake this node exists to stop.
 */
export function moveBlockCandidates(review: NotepadReviewContext): MoveBlockCandidate[] {
  const surfacedIds = new Set(review.lines.filter((line) => line.surfaced).map((line) => line.line_id));
  return review.blocks
    .filter((block) => block.member_line_ids.some((id) => surfacedIds.has(id)))
    .map((block) => ({
      block_id: notepadBlockId(block),
      headline_line_id: block.headline_line_id,
      headline: block.headline,
      member_line_ids: block.member_line_ids,
      text: block.text,
    }));
}

function headlineLabel(candidate: MoveBlockCandidate): string {
  return candidate.headline !== null
    ? candidate.headline.trim()
    : '(no headline -- a leading fragment, judge it by its lines)';
}

function buildMovesPrompt(review: NotepadReviewContext, candidates: MoveBlockCandidate[]): string {
  const candidateList = candidates.map((c) => `- block ${c.block_id}: ${headlineLabel(c)}\n${c.text}`).join('\n\n');
  return [
    "You are reading Kevin's freeform daily notepad on JARVIS's behalf, deciding",
    'whether any TOPIC deserves a real move -- and staying SILENT otherwise.',
    '',
    'Kevin writes in topic BLOCKS, not isolated lines: a headline on its own line',
    'with zero indentation, and everything he wrote about it indented beneath it',
    '(usually dashed, never uniformly indented). NEVER judge one line on its own --',
    'judge the whole block. A move belongs to a block, not to a line inside it.',
    '',
    'Below is the WHOLE note for the day, in document order. Every row is prefixed',
    'with its "[line_id N]" and then carries its history: "[ACTED -> ref]" means',
    'JARVIS already did something about it, "[seen]" means JARVIS looked and judged',
    'nothing was needed, "[dismissed]" means it was explicitly ruled out,',
    '"[RECONCILE -- was ACTED, text changed since]" means the line changed after',
    'JARVIS already acted on it, "[NEW -- previously ...]" means the text changed',
    'since that prior judgment. A plain unmarked line was never looked at before.',
    '',
    '=== WHOLE NOTE ===',
    review.rendered,
    '=== END WHOLE NOTE ===',
    '',
    'Judge ONLY these blocks -- every other part of the note above is shown purely',
    'for context; never assign a move to a block_id that is not in this list:',
    '',
    candidateList,
    '',
    'For EACH block above, decide: is there a REAL move here? A real move is',
    'exactly one of these four kinds -- nothing else counts:',
    '  "take_it"      -- I can take this: a concrete task or ask JARVIS could act on.',
    '  "question"     -- a question or decision that changes the work, needs Kevin.',
    '  "already_done" -- this asks for something already handled (the whole-note',
    '                   history above shows it) -- tell him so instead of nagging.',
    "  \"context\"      -- Kevin is missing context JARVIS actually has that changes",
    '                   how he would read this block.',
    '',
    'STAY SILENT for almost everything. A normal day produces a HANDFUL of moves,',
    'not one per block. Silence is the default outcome for a candidate block -- a',
    'grocery list, a stray thought, small talk, or a block whose history above',
    'already covers it gets NO entry at all. Only include a block_id when you are',
    'genuinely confident there is something real to say, with a short, specific,',
    'one-line reason (never a restatement of the block itself).',
    '',
    'Return ONLY a JSON object -- no markdown fences, no prose before or after.',
    'A block_id you are silent on is simply OMITTED -- never list it with a "none"',
    'kind or similar placeholder. Use EXACTLY this shape:',
    '{"moves": [{"block_id": 123, "kind": "take_it", "reason": "one short line"}]}',
    'An empty {"moves": []} is a completely valid, and often correct, answer.',
  ].join('\n');
}

/**
 * Parse the model's raw response into a validated, deduped move list.
 * Defensive by construction, mirroring notepad-gate.ts's parseGateResponse:
 * an unparseable response, a non-object/non-array shape, a malformed entry,
 * an entry whose block_id was never one of the candidates asked about, an
 * unrecognized kind, or a blank reason are all DROPPED rather than trusted
 * -- they simply produce no entry, i.e. silence for that block. A block_id
 * that appears more than once keeps only its FIRST valid entry, enforcing
 * "at most one move per block" as an invariant of the return value itself,
 * regardless of what the model's response actually contained.
 */
function parseMovesResponse(raw: string, candidatesById: ReadonlyMap<number, MoveBlockCandidate>): NotepadMove[] {
  const parsed = extractJsonObject(raw) as { moves?: unknown } | null;
  const rawMoves = parsed && Array.isArray(parsed.moves) ? parsed.moves : null;
  if (!rawMoves) return [];

  const moves: NotepadMove[] = [];
  const claimed = new Set<number>();
  for (const entry of rawMoves) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const blockId = typeof e.block_id === 'number' ? e.block_id : NaN;
    const kind = typeof e.kind === 'string' ? e.kind : '';
    const reason = typeof e.reason === 'string' ? e.reason.trim() : '';
    if (!Number.isFinite(blockId)) continue; // malformed entry -- ignored
    const candidate = candidatesById.get(blockId);
    if (!candidate) continue; // a block we never asked about -- ignored, never trusted
    if (!MOVE_KINDS.has(kind)) continue; // not one of the four real kinds -- ignored
    if (reason.length === 0) continue; // a move with no reason isn't trustworthy
    if (claimed.has(blockId)) continue; // at most one move per block -- first valid entry wins
    claimed.add(blockId);
    moves.push({
      block_id: blockId,
      headline_line_id: candidate.headline_line_id,
      member_line_ids: candidate.member_line_ids,
      kind: kind as NotepadMoveKind,
      reason,
    });
  }
  return moves;
}

/**
 * Enforce the noise budget: even a fully-valid, well-formed response from an
 * over-eager model (one entry per candidate block, every kind legal, every
 * reason non-empty) must still come out as a HANDFUL of moves, not one per
 * topic -- per goal #62's own acceptance bar. `parseMovesResponse` already
 * guarantees shape/dedup/candidate-membership; this is the layer above it
 * that guarantees COUNT, independent of anything the model actually said.
 *
 * When `moves` is within budget, it passes through untouched (order
 * preserved). When it overflows, the survivors are the ones whose blocks
 * come FIRST in document order -- the same "read top to bottom" order the
 * whole-note prompt itself renders -- so which moves survive a truncation
 * is deterministic and reproducible, never an artifact of whatever order
 * the model happened to list them in.
 */
function capMoves(moves: NotepadMove[], candidates: MoveBlockCandidate[]): NotepadMove[] {
  const max = movesMaxPerDaySetting();
  if (moves.length <= max) return moves;
  const docOrder = new Map(candidates.map((c, i) => [c.block_id, i]));
  return [...moves].sort((a, b) => (docOrder.get(a.block_id) ?? 0) - (docOrder.get(b.block_id) ?? 0)).slice(0, max);
}

/**
 * Decide the speaking-bar moves for `day`: is there a real move on any
 * currently-surfaced topic BLOCK, and which of the four kinds?
 *
 * Candidates are exactly the blocks of `review.blocks` with at least one
 * member line where `surfaced` is true (i.e. whatever `unscannedLines(day)`
 * currently returns per docs/notepad/LINE-IDENTITY.md, grouped by block per
 * docs/notepad/BLOCKS.md) -- the same "what's up for a look right now" set
 * notepad-review.ts already derives, reused rather than re-derived here.
 *
 *  - Zero candidate blocks: returns immediately, `outcome: 'no_candidates'`,
 *    no model call.
 *  - Otherwise: ONE batched model call (one sonnet one-shot) over every
 *    candidate block, given the whole-note review context for history/meaning.
 *    A failed/timed-out call resolves to `outcome: 'fallback'` with `moves`
 *    forced empty -- never a guess. A completed call is `outcome: 'model'`
 *    with whatever validly-shaped, in-scope moves survived parsing (often
 *    none -- an empty list is a normal, correct answer).
 *
 * `opts.review` lets a caller that already built the review context (e.g.
 * runNotepadSpeak) hand it in rather than re-querying the DB; omitted, this
 * builds it fresh from `day`. `opts.runOneShot`/`timeoutMs` are the same
 * injection seams notepad-gate.ts exposes, for sims/checks.
 */
export async function decideNotepadMoves(
  day: string,
  opts?: { review?: NotepadReviewContext; runOneShot?: (prompt: string) => Promise<string>; timeoutMs?: number },
): Promise<NotepadMovesResult> {
  const review = opts?.review ?? buildNotepadReviewContext(day);
  const candidates = moveBlockCandidates(review);

  if (candidates.length === 0) {
    return { day, candidate_count: 0, moves: [], outcome: 'no_candidates' };
  }

  const usingDefaultSpawn = !opts?.runOneShot;
  if (usingDefaultSpawn) {
    // Outside the try/catch on purpose -- same discipline as
    // runNotepadGate: under a scratch DB this must throw loudly and
    // synchronously OUT of this function, never be caught and silently
    // downgraded to a passing-looking all-fallback result.
    assertModelSpawnAllowed();
  }
  const runOneShot = opts?.runOneShot ?? defaultRunOneShot;
  const timeoutMs = opts?.timeoutMs ?? movesTimeoutMs();
  const prompt = buildMovesPrompt(review, candidates);
  const candidatesById = new Map(candidates.map((c) => [c.block_id, c]));

  try {
    const raw = await withTimeout(runOneShot(prompt), timeoutMs);
    const moves = capMoves(parseMovesResponse(raw, candidatesById), candidates);
    return { day, candidate_count: candidates.length, moves, outcome: 'model' };
  } catch {
    // Spawn failure, non-zero exit, or a timeout -- forced total silence
    // for this batch. A missed move costs Kevin nothing he didn't already
    // have; a guessed one trains him to ignore markers.
    return { day, candidate_count: candidates.length, moves: [], outcome: 'fallback' };
  }
}
