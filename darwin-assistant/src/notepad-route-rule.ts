import type { NotepadMoveKind } from './notepad-moves.js';
import type { TopicDossier } from './notepad-dossier.js';

// Node #873 — the routing RULE: an explicit, testable table from a line +
// its move kind to exactly one sink. This module writes NOTHING anywhere —
// it is a pure function over its inputs, no DB, no model call, no side
// effect. The next node (a sibling of #62/#107, downstream of this one)
// is the one that actually creates a goal proposal / hopper candidate /
// workstream / thread from the sink this returns.
//
// Only `import type` is used for the neighboring modules (node #62's
// NotepadMoveKind, node #107's TopicDossier) so this file has ZERO runtime
// dependency on conversation-db.ts's sqliteDb — those imports are erased at
// compile time. That is what lets the check script below run with no
// JARVIS_DB_PATH and no scratch DB at all: this is a pure-function test.

/** The four sinks a `take_it` line can land in. Everything else is `thread`
 *  — a chat is always a safe default; inventing a sink is not. */
export type NotepadRouteSink = 'goal_proposal' | 'hopper' | 'workstream' | 'thread';

export interface RouteLineInput {
  line_id: number;
  idx: number; // document order, 0-based — see notepad.ts / notepad-review.ts
  text: string;
}

export interface RouteMoveInput {
  kind: NotepadMoveKind;
  reason?: string;
}

export interface RouteNotepadLineInput {
  line: RouteLineInput;
  move: RouteMoveInput;
  /** Node #107's dossier, if one has been built for this line. Not
   *  currently consulted by any rule below — accepted for forward
   *  compatibility with a future model tie-break (see tieBreakRouteWithModel)
   *  — but never required, and never changes the deterministic answer. */
  dossier?: Pick<TopicDossier, 'confidence'> | null;
  /** The WHOLE day's lines, document order, needed only to detect the
   *  GOAL-SHAPE heading section (a line sitting under a `Potential Goals:`
   *  heading). Omit when there's no day context (e.g. a synthetic/one-off
   *  line) — heading-section membership then simply can't match, same as
   *  any other rule that finds no evidence. */
  allLines?: RouteLineInput[];
}

export interface NotepadRouteDecision {
  sink: NotepadRouteSink;
  why: string;
  /** 'high' — exactly one rule matched. 'medium' — more than one rule
   *  matched (a genuinely ambiguous line) and the table's own priority
   *  order picked the winner. 'low' — no rule matched; the thread default
   *  fired. */
  confidence: 'high' | 'medium' | 'low';
}

// == Shape detectors ==========================================================
// Each returns the specific matched reason (a string) or null — never a
// bare boolean — so a rule's `why` always names exactly what fired, not a
// generic label.

/** A line already closed out by an annotation JARVIS itself appends, e.g.
 *  Kevin's real note's `(Created a goal)`. Checked ahead of every shape rule
 *  on purpose: an annotated line must never be re-routed regardless of what
 *  it would otherwise look like. */
const ANNOTATED_RE = /\((?:created|done|already\s+done|completed)\b[^)]*\)\s*$/i;

function alreadyAnnotatedReason(text: string): string | null {
  const m = text.match(ANNOTATED_RE);
  if (!m) return null;
  return `already annotated as created/done (${m[0].trim()}) — not re-routed`;
}

/** Explicit goal cue at the start of the line: `goal:` or `new goal`. */
const GOAL_CUE_RE = /^\s*(goal\s*:|new\s+goal\b)/i;

function goalCueReason(text: string): string | null {
  const m = text.match(GOAL_CUE_RE);
  if (!m) return null;
  return `explicit goal cue ('${m[0].trim()}')`;
}

/** A short, colon-terminated line on its own, e.g. `Potential Goals:` or
 *  `Goals:` — loosely and case-insensitively matched (docs/notepad's
 *  heading convention is freeform, not a fixed enum). */
function isHeadingLine(text: string): boolean {
  const t = text.trim();
  if (!t.endsWith(':')) return false;
  const body = t.slice(0, -1).trim();
  if (!body) return false;
  return /^[A-Za-z][A-Za-z0-9 &/'-]*$/.test(body) && body.split(/\s+/).length <= 5;
}

function isGoalHeadingLine(text: string): boolean {
  const body = text
    .trim()
    .replace(/:$/, '')
    .trim();
  return /^(potential\s+)?goals?$/i.test(body);
}

function isBlankLine(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * Is `line` inside a `Potential Goals:`-shaped heading's section? Walks
 * backward from `line` in document order: a blank line ends the section
 * (not under any heading), the nearest heading line ends the walk (its
 * shape decides membership either way) — the section runs from right after
 * the heading to the next heading or blank-line boundary, per spec.
 */
function goalsHeadingReason(line: RouteLineInput, allLines: RouteLineInput[]): string | null {
  const sorted = [...allLines].sort((a, b) => a.idx - b.idx);
  const pos = sorted.findIndex((l) => l.line_id === line.line_id);
  if (pos <= 0) return null;

  for (let i = pos - 1; i >= 0; i--) {
    const candidate = sorted[i];
    if (isBlankLine(candidate.text)) return null; // section boundary reached first — not under any heading
    if (isHeadingLine(candidate.text)) {
      return isGoalHeadingLine(candidate.text) ? `sits under a "${candidate.text.trim()}" heading section` : null;
    }
  }
  return null;
}

function goalShapeReason(line: RouteLineInput, allLines: RouteLineInput[]): string | null {
  return goalCueReason(line.text) ?? goalsHeadingReason(line, allLines);
}

/** An imperative build/fix/ship instruction (verb at the START of the line)
 *  naming a concrete artifact — a file extension, backticked token, or one
 *  of the artifact nouns from the spec (repo, file, page, endpoint, script, ...). */
const BUILD_VERB_RE = /^\s*(build|fix|ship|add|implement|deploy|create|write|refactor|update|patch|wire\s+up|set\s+up)\b/i;
const ARTIFACT_RE = /`[^`]+`|\.[a-z0-9]{1,5}\b|\b(repo|repository|branch|page|endpoint|script|api|file|component|service|dashboard|migration|worktree)\b/i;

function buildShapeReason(text: string): string | null {
  const verb = text.match(BUILD_VERB_RE);
  if (!verb) return null;
  const artifact = text.match(ARTIFACT_RE);
  if (!artifact) return null;
  return `imperative build cue ('${verb[0].trim()}') naming a concrete artifact ('${artifact[0]}')`;
}

/** Something ongoing, waiting on someone/something else — not a discrete
 *  build JARVIS could just go do. */
const BALL_IN_AIR_RE = /\b(waiting on|blocked on|following up|follow up with|pending on)\b/i;

function ballInAirReason(text: string): string | null {
  const m = text.match(BALL_IN_AIR_RE);
  if (!m) return null;
  return `ball-in-the-air phrase ('${m[0]}')`;
}

// == The rule table ===========================================================
// Priority order top to bottom IS the tie-break for a genuinely ambiguous
// line (one that matches more than one rule) — see the two ambiguous
// fixtures in scripts/notepad-route-rule-check.mjs. A model may only ever
// be asked to choose between sinks THIS table already found eligible (see
// tieBreakRouteWithModel below); it never sees a line the table fully
// resolved with exactly one match.

interface RouteRule {
  sink: NotepadRouteSink;
  match: (line: RouteLineInput, move: RouteMoveInput, allLines: RouteLineInput[]) => string | null;
}

const ROUTE_RULES: RouteRule[] = [
  {
    sink: 'thread',
    match: (_line, move) =>
      move.kind === 'take_it' ? null : `move kind '${move.kind}' is conversation, not machinery`,
  },
  {
    sink: 'thread',
    match: (line) => alreadyAnnotatedReason(line.text),
  },
  {
    sink: 'goal_proposal',
    match: (line, _move, allLines) => goalShapeReason(line, allLines),
  },
  {
    sink: 'hopper',
    match: (line) => buildShapeReason(line.text),
  },
  {
    sink: 'workstream',
    match: (line) => ballInAirReason(line.text),
  },
];

/**
 * Route one notepad line to exactly one sink. Deterministic and pure: same
 * input always produces the same output, no DB, no model call, no clock.
 *
 * Only a `take_it` line is even eligible for goal_proposal / hopper /
 * workstream — every other move kind (question / already_done / context)
 * is conversation, handled by node #869's thread handoff, never machinery.
 */
export function routeNotepadLine(input: RouteNotepadLineInput): NotepadRouteDecision {
  const allLines = input.allLines && input.allLines.length > 0 ? input.allLines : [input.line];

  const matches: Array<{ rule: RouteRule; reason: string }> = [];
  for (const rule of ROUTE_RULES) {
    const reason = rule.match(input.line, input.move, allLines);
    if (reason) matches.push({ rule, reason });
  }

  if (matches.length === 0) {
    return {
      sink: 'thread',
      why: 'no rule matched — defaulting to conversation; a chat is always safe, inventing a sink is not',
      confidence: 'low',
    };
  }

  const winner = matches[0];
  return {
    sink: winner.rule.sink,
    why: winner.reason,
    confidence: matches.length === 1 ? 'high' : 'medium',
  };
}

// == Optional model tie-break (NOT wired into routeNotepadLine above) ========
// The spec allows a model to tie-break between sinks the table already
// found eligible, as a refinement — never a dependency. routeNotepadLine
// itself never needs it (every fixture the check script asserts on is
// resolved by the deterministic table alone, by priority order). This is
// left here only as the seam a future caller could use, in the same
// no-api-keys `claude -p ... --output-format json` shape as
// notepad-moves.ts / notepad-dossier.ts, should a genuinely
// judgment-dependent case ever need one.
export interface RouteTieBreakOptions {
  runOneShot: (prompt: string) => Promise<string>;
}

/**
 * Ask a model to pick ONE of `eligibleSinks` (which routeNotepadLine's own
 * table already narrowed to) for `line.text`. The model's answer is
 * validated against `eligibleSinks` and discarded (falling back to
 * `fallbackSink`) if it names anything else — it may narrow, never expand,
 * the table's own decision.
 */
export async function tieBreakRouteWithModel(
  line: Pick<RouteLineInput, 'text'>,
  eligibleSinks: NotepadRouteSink[],
  fallbackSink: NotepadRouteSink,
  opts: RouteTieBreakOptions,
): Promise<NotepadRouteSink> {
  if (eligibleSinks.length <= 1) return eligibleSinks[0] ?? fallbackSink;
  const prompt = [
    'A notepad-line router already narrowed this line to one of a small set of',
    'eligible sinks. Pick exactly one — you may NOT propose anything outside this list.',
    '',
    `Line: ${JSON.stringify(line.text)}`,
    `Eligible sinks: ${eligibleSinks.join(', ')}`,
    '',
    'Return ONLY a JSON object, no markdown fences, no prose: {"sink": "<one of the eligible sinks>"}',
  ].join('\n');
  try {
    const raw = await opts.runOneShot(prompt);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return fallbackSink;
    const parsed = JSON.parse(match[0]) as { sink?: unknown };
    const sink = typeof parsed.sink === 'string' ? (parsed.sink as NotepadRouteSink) : null;
    return sink && eligibleSinks.includes(sink) ? sink : fallbackSink;
  } catch {
    return fallbackSink;
  }
}
