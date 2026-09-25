import { execFile } from 'node:child_process';
import { getSetting } from './conversation-db.js';
import { assertModelSpawnAllowed } from './notepad-gate.js';
import { buildNotepadReviewContext } from './notepad-review.js';
import type { NotepadReviewContext, ReviewLine } from './notepad-review.js';
import { extractJsonObject } from './tools/ux-reviewer/vision-critique.js';

// The speaking bar (goal 6 node #103 / #62's "JARVIS speaks only when it has
// something worth saying"): given the whole-note review context (node #99/
// #100's buildNotepadReviewContext + runNotepadPass), decide -- per line --
// whether there is a REAL move here, and which of exactly four kinds:
//
//   take_it      -- "I can take this."
//   question     -- "a question that changes the work."
//   already_done -- "you already did this."
//   context      -- "here's context you're missing."
//
// SILENCE IS THE DEFAULT, at every layer this module touches:
//   - zero candidate lines -> zero model call, empty moves, no exception.
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
//     line" noise budget as a hard invariant of this module's OUTPUT,
//     independent of what the model actually said.
//
// This module makes exactly one model call (one sonnet one-shot) per
// invocation, batched over every candidate line, mirroring notepad-gate.ts's
// shape. It does NOT write to the per-line ledger and does NOT persist a
// marker anywhere -- that is goal node #104 ("a marker belongs to the line,
// survives edits, and never fires twice"), a separate, not-yet-built layer.
// This function only decides; a caller acts on what it returns.

/** The four kinds of real move JARVIS can have on a notepad line. Nothing
 *  else is a move -- everything else is silence. */
export type NotepadMoveKind = 'take_it' | 'question' | 'already_done' | 'context';

const MOVE_KINDS: ReadonlySet<string> = new Set<NotepadMoveKind>(['take_it', 'question', 'already_done', 'context']);

/** One line's real move: at most one of these exists per line_id in a
 *  NotepadMovesResult -- a line with no move simply has no entry. */
export interface NotepadMove {
  line_id: number;
  kind: NotepadMoveKind;
  reason: string; // one short line, never empty
}

/**
 * Why `moves` has the shape it does:
 *  - 'no_candidates' -- the review context had zero surfaced lines; no model
 *    call was made at all.
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
  candidate_count: number; // review.lines.filter(surfaced).length
  moves: NotepadMove[]; // sparse -- absence of an entry for a line_id IS silence
  outcome: NotepadMovesOutcome;
}

const CLAUDE_BIN = process.env.UX_REVIEWER_CLAUDE_BIN || 'claude';
const DEFAULT_MOVES_MODEL = 'claude-sonnet-5';
const DEFAULT_MOVES_TIMEOUT_MS = 30 * 1000;

// Goal #62's whole point: "a normal day produces a handful of markers, not
// one per line." The prompt ASKS the model to stay silent, but a prompt is
// not an invariant -- an over-eager or misbehaving model can still return a
// well-formed, validly-shaped move for every single candidate. This cap is
// what makes the noise budget true regardless of what the model actually
// does, the same way the four-kind/one-per-line checks in
// parseMovesResponse hold regardless of what the model returns.
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
      { timeout: DEFAULT_MOVES_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env },
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

function buildMovesPrompt(review: NotepadReviewContext, candidates: ReviewLine[]): string {
  const candidateList = candidates.map((c) => `- line_id ${c.line_id}`).join('\n');
  return [
    "You are reading Kevin's freeform daily notepad on JARVIS's behalf, deciding",
    'whether any line deserves a real move -- and staying SILENT otherwise.',
    '',
    'Below is the WHOLE note for the day, in document order. Every line already',
    'carries its history: "[ACTED -> ref]" means JARVIS already did something',
    'about it, "[seen]" means JARVIS looked and judged nothing was needed,',
    '"[dismissed]" means it was explicitly ruled out, "[RECONCILE -- was ACTED,',
    'text changed since]" means the line changed after JARVIS already acted on',
    'it, "[NEW -- previously ...]" means the text changed since that prior',
    'judgment. A plain unmarked line was never looked at before.',
    '',
    '=== WHOLE NOTE ===',
    review.rendered,
    '=== END WHOLE NOTE ===',
    '',
    'Judge ONLY these line_ids -- every other line above is shown purely for',
    'context; never assign a move to a line_id that is not in this list:',
    candidateList,
    '',
    'For EACH line_id above, decide: is there a REAL move here? A real move is',
    'exactly one of these four kinds -- nothing else counts:',
    '  "take_it"      -- I can take this: a concrete task or ask JARVIS could act on.',
    '  "question"     -- a question or decision that changes the work, needs Kevin.',
    '  "already_done" -- this asks for something already handled (the whole-note',
    '                   history above shows it) -- tell him so instead of nagging.',
    "  \"context\"      -- Kevin is missing context JARVIS actually has that changes",
    '                   how he would read this line.',
    '',
    'STAY SILENT for almost everything. A normal day produces a HANDFUL of moves,',
    'not one per line. Silence is the default outcome for a candidate line -- a',
    'grocery list, a stray thought, small talk, or a line whose history above',
    'already covers it gets NO entry at all. Only include a line_id when you are',
    'genuinely confident there is something real to say, with a short, specific,',
    'one-line reason (never a restatement of the line itself).',
    '',
    'Return ONLY a JSON object -- no markdown fences, no prose before or after.',
    'A line_id you are silent on is simply OMITTED -- never list it with a "none"',
    'kind or similar placeholder. Use EXACTLY this shape:',
    '{"moves": [{"line_id": 123, "kind": "take_it", "reason": "one short line"}]}',
    'An empty {"moves": []} is a completely valid, and often correct, answer.',
  ].join('\n');
}

/**
 * Parse the model's raw response into a validated, deduped move list.
 * Defensive by construction, mirroring notepad-gate.ts's parseGateResponse:
 * an unparseable response, a non-object/non-array shape, a malformed entry,
 * an entry whose line_id was never one of the candidates asked about, an
 * unrecognized kind, or a blank reason are all DROPPED rather than trusted
 * -- they simply produce no entry, i.e. silence for that line. A line_id
 * that appears more than once keeps only its FIRST valid entry, enforcing
 * "at most one move per line" as an invariant of the return value itself,
 * regardless of what the model's response actually contained.
 */
function parseMovesResponse(raw: string, candidateIds: ReadonlySet<number>): NotepadMove[] {
  const parsed = extractJsonObject(raw) as { moves?: unknown } | null;
  const rawMoves = parsed && Array.isArray(parsed.moves) ? parsed.moves : null;
  if (!rawMoves) return [];

  const moves: NotepadMove[] = [];
  const claimed = new Set<number>();
  for (const entry of rawMoves) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const lineId = typeof e.line_id === 'number' ? e.line_id : NaN;
    const kind = typeof e.kind === 'string' ? e.kind : '';
    const reason = typeof e.reason === 'string' ? e.reason.trim() : '';
    if (!Number.isFinite(lineId)) continue; // malformed entry -- ignored
    if (!candidateIds.has(lineId)) continue; // an id we never asked about -- ignored, never trusted
    if (!MOVE_KINDS.has(kind)) continue; // not one of the four real kinds -- ignored
    if (reason.length === 0) continue; // a move with no reason isn't trustworthy
    if (claimed.has(lineId)) continue; // at most one move per line -- first valid entry wins
    claimed.add(lineId);
    moves.push({ line_id: lineId, kind: kind as NotepadMoveKind, reason });
  }
  return moves;
}

/**
 * Enforce the noise budget: even a fully-valid, well-formed response from an
 * over-eager model (one entry per candidate, every kind legal, every reason
 * non-empty) must still come out as a HANDFUL of moves, not one per line --
 * per goal #62's own acceptance bar. `parseMovesResponse` already guarantees
 * shape/dedup/candidate-membership; this is the layer above it that
 * guarantees COUNT, independent of anything the model actually said.
 *
 * When `moves` is within budget, it passes through untouched (order
 * preserved). When it overflows, the survivors are the ones whose lines
 * come FIRST in document order -- the same "read top to bottom" order the
 * whole-note prompt itself renders -- so which moves survive a truncation
 * is deterministic and reproducible, never an artifact of whatever order
 * the model happened to list them in.
 */
function capMoves(moves: NotepadMove[], candidates: ReviewLine[]): NotepadMove[] {
  const max = movesMaxPerDaySetting();
  if (moves.length <= max) return moves;
  const docOrder = new Map(candidates.map((c, i) => [c.line_id, i]));
  return [...moves].sort((a, b) => (docOrder.get(a.line_id) ?? 0) - (docOrder.get(b.line_id) ?? 0)).slice(0, max);
}

/**
 * Decide the speaking-bar moves for `day`: is there a real move on any
 * currently-surfaced line, and which of the four kinds?
 *
 * Candidates are exactly `review.lines` where `surfaced` is true (i.e.
 * whatever `unscannedLines(day)` currently returns per
 * docs/notepad/LINE-IDENTITY.md's decision table) -- the same "what's up
 * for a look right now" set notepad-review.ts already derives, reused
 * rather than re-derived here.
 *
 *  - Zero candidates: returns immediately, `outcome: 'no_candidates'`, no
 *    model call.
 *  - Otherwise: ONE batched model call (one sonnet one-shot) over every
 *    candidate, given the whole-note review context for history/meaning.
 *    A failed/timed-out call resolves to `outcome: 'fallback'` with `moves`
 *    forced empty -- never a guess. A completed call is `outcome: 'model'`
 *    with whatever validly-shaped, in-scope moves survived parsing (often
 *    none -- an empty list is a normal, correct answer).
 *
 * `opts.review` lets a caller that already built the review context (e.g. a
 * future full-pass wiring) hand it in rather than re-querying the DB;
 * omitted, this builds it fresh from `day`. `opts.runOneShot`/`timeoutMs`
 * are the same injection seams notepad-gate.ts exposes, for sims/checks.
 */
export async function decideNotepadMoves(
  day: string,
  opts?: { review?: NotepadReviewContext; runOneShot?: (prompt: string) => Promise<string>; timeoutMs?: number },
): Promise<NotepadMovesResult> {
  const review = opts?.review ?? buildNotepadReviewContext(day);
  const candidates = review.lines.filter((line) => line.surfaced);

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
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_MOVES_TIMEOUT_MS;
  const prompt = buildMovesPrompt(review, candidates);
  const candidateIds = new Set(candidates.map((c) => c.line_id));

  try {
    const raw = await withTimeout(runOneShot(prompt), timeoutMs);
    const moves = capMoves(parseMovesResponse(raw, candidateIds), candidates);
    return { day, candidate_count: candidates.length, moves, outcome: 'model' };
  } catch {
    // Spawn failure, non-zero exit, or a timeout -- forced total silence
    // for this batch. A missed move costs Kevin nothing he didn't already
    // have; a guessed one trains him to ignore markers.
    return { day, candidate_count: candidates.length, moves: [], outcome: 'fallback' };
  }
}
