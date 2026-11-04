import type { TopicDossier } from './notepad-dossier.js';
import {
  routeNotepadLine,
  routeNotepadBlock,
  type RouteLineInput,
  type RouteBlockInput,
  type RouteMoveInput,
  type NotepadRouteSink,
  type NotepadRouteDecision,
} from './notepad-route-rule.js';
import type { DossierBlockInput } from './notepad-dossier.js';
import { getNotepadLineState, markLineActed, markLineSeen } from './notepad.js';
import { getNotepadMarker, setNotepadMarkerActionRef } from './notepad-markers.js';
import { openNotepadHandoff, type OpenNotepadHandoffOptions } from './notepad-handoff.js';
import { proposeGoalNodes } from './goals.js';
import { createHopperItem } from './hopper.js';
import { jotWorkstream, updateWorkstream } from './workstreams.js';

// Node #874 — the SINKS: wiring node #873's pure routing rule to the three
// real machinery stores (goals/hopper/workstreams) plus node #869's existing
// thread handoff, with one documented action_ref scheme all four write and
// one idempotency check that makes dispatching the same line twice a no-op.
//
// This module owns exactly two things: dispatchNotepadLine (the orchestrator
// — route, then act on the sink, then write the ledger) and the
// buildActionRef/parseActionRef pair (the ONE place the action_ref string
// format is defined, so a future resolver — node #110 — has one place to
// read from). It does not decide the sink (notepad-route-rule.ts does) and it
// does not own any sink's storage (goals.ts/hopper.ts/workstreams.ts/
// notepad-handoff.ts do) — it only calls into each with the line/move it was
// given.

// == The action_ref scheme ====================================================
// One string format per sink, documented here once:
//   goal:<goal_id>:<node_id>   — a proposed (ghost) goal_nodes row
//   hopper:<candidate_id>      — a hopper_items row
//   workstream:<workstream_id> — a workstreams row
//   thread:<thread_ext>        — a cockpit conversation external_id
//
// The thread_ext itself already contains a colon (`cockpit:notepad-line-42`),
// so parseActionRef's thread branch takes EVERYTHING after the first
// `thread:` prefix, not just the next token.

export type ParsedActionRef =
  | { sink: 'goal_proposal'; goal_id: number; node_id: number }
  | { sink: 'hopper'; candidate_id: number }
  | { sink: 'workstream'; workstream_id: number }
  | { sink: 'thread'; thread_ext: string };

export function buildActionRef(ref: ParsedActionRef): string {
  switch (ref.sink) {
    case 'goal_proposal':
      return `goal:${ref.goal_id}:${ref.node_id}`;
    case 'hopper':
      return `hopper:${ref.candidate_id}`;
    case 'workstream':
      return `workstream:${ref.workstream_id}`;
    case 'thread':
      return `thread:${ref.thread_ext}`;
  }
}

/** Resolve an action_ref string back to a live target. Returns null for
 *  anything not shaped like one of the four schemes above (e.g. a stale/
 *  hand-written ledger value from before this scheme existed) — the caller
 *  decides how to handle an unparseable ref, this never guesses. */
export function parseActionRef(ref: string): ParsedActionRef | null {
  const goalMatch = ref.match(/^goal:(\d+):(\d+)$/);
  if (goalMatch) return { sink: 'goal_proposal', goal_id: Number(goalMatch[1]), node_id: Number(goalMatch[2]) };
  const hopperMatch = ref.match(/^hopper:(\d+)$/);
  if (hopperMatch) return { sink: 'hopper', candidate_id: Number(hopperMatch[1]) };
  const workstreamMatch = ref.match(/^workstream:(\d+)$/);
  if (workstreamMatch) return { sink: 'workstream', workstream_id: Number(workstreamMatch[1]) };
  const threadMatch = ref.match(/^thread:(.+)$/);
  if (threadMatch) return { sink: 'thread', thread_ext: threadMatch[1] };
  return null;
}

// == dispatchNotepadBlock / dispatchNotepadLine ===============================
//
// NODE #943 -- DISPATCH ACTS ON A BLOCK. Kevin's rule (docs/notepad/BLOCKS.md):
// "never look at the line on its own, look at the entire block." A topic is a
// zero-indent headline plus everything indented under it, and that whole topic
// is what gets proposed as a goal / filed as a hopper card / attached to a
// workstream / opened as a thread.
//
// THE LEDGER IS STILL PER-LINE, and untouched (notepad.ts is not this node's
// to change). Acting on a block writes, through the SAME lineage-aware
// per-line ledger that already existed:
//   - the HEADLINE line  -> `acted`, carrying the action_ref;
//   - every OTHER member -> `seen` (JARVIS looked at it, as part of the topic,
//     and it needs no action of its own).
// The marker likewise lands on the headline line only -- one marker per
// topic, which is exactly the "a handful of markers, not one per line" bar.
//
// `dispatchNotepadLine` is kept as the single-line entry point (one line IS a
// one-member block under the block rule, and the per-line router with its
// backward heading walk is still the right judge for a caller that genuinely
// only has one line -- e.g. scripts/notepad-dry-run.mjs). It shares every
// sink actor and the ledger write below with the block form; only the routing
// decision and the subject differ.

/** What a dispatch is actually acting ON -- one line, or one whole block. */
interface DispatchSubject {
  /** The line the action_ref + marker are stamped on: the block's headline
   *  (or the lone line). This is also the idempotence key. */
  acted_line_id: number;
  /** Every line covered by this dispatch, document order, headline included. */
  member_line_ids: number[];
  /** The short title a sink row gets: the headline, or the line's own text. */
  title: string;
  /** The full text, verbatim -- the whole block in block mode. */
  text: string;
  /** Non-null in block mode -- forwarded to the handoff so a thread is seeded
   *  with the whole topic rather than its headline alone. */
  block: DossierBlockInput | null;
  /** Stable provenance string for the hopper card. */
  source_ref: string;
}

function lineSubject(line: RouteLineInput): DispatchSubject {
  return {
    acted_line_id: line.line_id,
    member_line_ids: [line.line_id],
    title: line.text.trim(),
    text: line.text,
    block: null,
    source_ref: `notepad-line-${line.line_id}`,
  };
}

/** The block's title: its headline, or -- for a headline:null lead-in block --
 *  its first line with any content. Never empty when the block has content. */
function blockTitle(block: RouteBlockInput): string {
  if (block.headline !== null && block.headline.trim()) return block.headline.trim();
  const firstReal = block.lines.find((l) => l.text.trim().length > 0);
  return (firstReal?.text ?? block.lines[0]?.text ?? '').trim();
}

function blockSubject(block: RouteBlockInput): DispatchSubject {
  return {
    acted_line_id: block.block_id,
    member_line_ids: block.lines.map((l) => l.line_id),
    title: blockTitle(block),
    text: block.lines.map((l) => l.text).join('\n'),
    block: {
      block_id: block.block_id,
      headline_line_id: block.headline_line_id,
      headline: block.headline,
      lines: block.lines.map((l) => ({ line_id: l.line_id, text: l.text })),
    },
    source_ref: `notepad-block-${block.block_id}`,
  };
}

export interface DispatchNotepadLineInput {
  line: RouteLineInput;
  move: RouteMoveInput;
  /** The full dossier (node #107), if one was built for this line -- used for
   *  its `.goal` when the sink is goal_proposal. Only `confidence` is
   *  forwarded to the router (the only field it currently consults). */
  dossier?: TopicDossier | null;
  /** Forwarded to the router for goal-heading-section detection. */
  allLines?: RouteLineInput[];
  /** Injection seam forwarded verbatim to openNotepadHandoff when the sink is
   *  (or falls back to) thread -- lets a sim/check stub the dossier's model
   *  call and the seed post, exactly as notepad-handoff-route-check.mjs
   *  already does for node #869 directly. Omitted, this uses
   *  openNotepadHandoff's own real defaults. */
  handoffOpts?: OpenNotepadHandoffOptions;
}

export interface DispatchNotepadBlockInput {
  /** The topic block, with every member line's RAW text (no render prefixes). */
  block: RouteBlockInput;
  move: RouteMoveInput;
  dossier?: TopicDossier | null;
  handoffOpts?: OpenNotepadHandoffOptions;
}

export interface DispatchNotepadBlockResult {
  /** false when the acted line already had an action_ref on its ledger row
   *  before this call -- nothing was written, `action_ref` is whatever was
   *  already there. */
  created: boolean;
  /** The sink actually acted on. Can differ from `decision.sink` exactly once
   *  in the current wiring: a goal_proposal decision with no attachment point
   *  (no dossier.goal, or the proposed parent rejects a new child) falls back
   *  to `thread` -- see actOnGoalProposal below. */
  sink: NotepadRouteSink;
  action_ref: string;
  /** The router's own decision, kept for forensics even when a fallback changed
   *  what actually happened. */
  decision: NotepadRouteDecision;
  /** The line carrying the `acted` ledger row + the action_ref + the marker. */
  acted_line_id: number;
  /** Members this dispatch marked `seen` -- empty for a single-line dispatch,
   *  and for a block whose other members already carried real actions. */
  seen_line_ids: number[];
  detail?: Record<string, unknown>;
}

/** Kept as the historical name; a line dispatch and a block dispatch return
 *  the identical shape, because a line IS a one-member block. */
export type DispatchNotepadLineResult = DispatchNotepadBlockResult;

interface SinkOutcome {
  sink: NotepadRouteSink;
  action_ref: string;
  detail?: Record<string, unknown>;
}

function goalProposalDoneMeans(title: string): string {
  return `"${title.trim().replace(/\s+/g, ' ')}" is done.`;
}

/**
 * thread sink -- delegates entirely to node #869's openNotepadHandoff (the
 * only thread-handoff mechanism on this branch; see the node spec). That
 * function already writes the line's ledger action_ref (bare thread_ext, no
 * scheme prefix) and the marker's action_ref on first open, and is itself
 * idempotent (a second call for the same line is a pure read). In block mode
 * it is handed the whole block, so the thread opens seeded with the entire
 * topic rather than its headline alone.
 *
 * We re-stamp the ledger with the CANONICAL `thread:<thread_ext>` form right
 * after, so every sink's ledger action_ref is parseable by parseActionRef the
 * same way -- the marker's action_ref is left exactly as #869 wrote it (bare
 * thread_ext), since that is its own established contract with the cockpit
 * UI, not something this node owns.
 */
async function actOnThread(subject: DispatchSubject, opts?: OpenNotepadHandoffOptions): Promise<SinkOutcome> {
  const handoffOpts: OpenNotepadHandoffOptions = subject.block ? { ...(opts ?? {}), block: subject.block } : { ...(opts ?? {}) };
  const result = await openNotepadHandoff(subject.acted_line_id, handoffOpts);
  const actionRef = buildActionRef({ sink: 'thread', thread_ext: result.thread_ext });
  markLineActed(subject.acted_line_id, actionRef);
  return { sink: 'thread', action_ref: actionRef, detail: { thread_ext: result.thread_ext, handoff_created: result.created } };
}

/**
 * goal_proposal sink -- propose a ghost node under whatever goal/node the
 * dossier's deterministic evidence already named (node #107's
 * `dossier.goal`). Creating a brand-new GOAL is Kevin's call by contract
 * (see createGoal in goals.ts) -- this only ever calls proposeGoalNodes
 * against an EXISTING goal, never createGoal.
 *
 * In block mode the ghost node's title is the block's HEADLINE (the topic),
 * and the block's full text rides along in the notes -- so Kevin reviews one
 * ghost per topic, with everything he wrote under it visible, rather than one
 * ghost per dash.
 *
 * When the dossier named no goal at all, or the goal it named rejects a new
 * child right now (proposeGoalNodes throws -- e.g. its parent node isn't in a
 * state that accepts children), there is no safe attachment point to invent
 * one for. Per this codebase's standing rule (renderNoneConfidence,
 * routeNotepadLine's own thread default, decideNotepadMoves' silence-by-
 * default) -- a chat is always safe, inventing a home for an idea is not --
 * this falls back to the thread handoff rather than guessing a goal.
 */
async function actOnGoalProposal(
  subject: DispatchSubject,
  move: RouteMoveInput,
  dossier: TopicDossier | null,
  handoffOpts?: OpenNotepadHandoffOptions,
): Promise<SinkOutcome> {
  const target = dossier?.goal ?? null;
  if (!target) return actOnThread(subject, handoffOpts);

  try {
    const title = subject.title;
    const notes = [
      move.reason ? `JARVIS's read: ${move.reason}` : null,
      subject.block ? `From Kevin's note:\n${subject.text}` : null,
    ]
      .filter(Boolean)
      .join('\n\n');
    const { nodes } = proposeGoalNodes(target.goal_id, {
      parent_id: target.node_id,
      items: [
        {
          title,
          done_means: goalProposalDoneMeans(title),
          notes: notes || undefined,
        },
      ],
      actor: 'jarvis',
    });
    const node = nodes[0];
    return {
      sink: 'goal_proposal',
      action_ref: buildActionRef({ sink: 'goal_proposal', goal_id: target.goal_id, node_id: node.id }),
      detail: { goal_id: target.goal_id, node_id: node.id },
    };
  } catch {
    return actOnThread(subject, handoffOpts);
  }
}

/** hopper sink -- file a pending candidate card. A candidate, not started
 *  work: Kevin still clicks Yes/Yes-but/Dismiss before anything runs. The
 *  card's raw_message is the WHOLE block in block mode, so whoever picks it
 *  up sees the topic, not a headline stripped of its detail. */
function actOnHopper(subject: DispatchSubject, move: RouteMoveInput): SinkOutcome {
  const item = createHopperItem({
    title: subject.title.slice(0, 200),
    summary: move.reason ?? null,
    source: 'notepad',
    source_ref: subject.source_ref,
    raw_message: subject.text,
  });
  return {
    sink: 'hopper',
    action_ref: buildActionRef({ sink: 'hopper', candidate_id: item.id }),
    detail: { candidate_id: item.id },
  };
}

/** workstream sink -- find-or-create via jotWorkstream's own fuzzy match
 *  (title/what token overlap against open workstreams -- "create or attach",
 *  per the node spec), then make sure it actually carries a turn and a
 *  next_action, since a fresh jot lands `parked` with no next_action. */
function actOnWorkstream(subject: DispatchSubject, move: RouteMoveInput): SinkOutcome {
  const text = subject.title;
  const { matched, workstream } = jotWorkstream(text);
  updateWorkstream(workstream.id, {
    turn: 'jarvis',
    next_action: move.reason || text,
    actor: 'jarvis',
    event_text: matched ? `Notepad line matched here: ${text}` : `Notepad line dispatched here: ${text}`,
  });
  return {
    sink: 'workstream',
    action_ref: buildActionRef({ sink: 'workstream', workstream_id: workstream.id }),
    detail: { workstream_id: workstream.id, matched },
  };
}

/**
 * The shared body: given a routing decision and the subject it was made
 * about, act on the sink and write the per-line ledger. Both public entry
 * points funnel through here, so a line and a block are dispatched by exactly
 * the same code -- only the routing decision and the subject differ.
 */
async function dispatchSubject(
  subject: DispatchSubject,
  decision: NotepadRouteDecision,
  move: RouteMoveInput,
  dossier: TopicDossier | null,
  handoffOpts?: OpenNotepadHandoffOptions,
): Promise<DispatchNotepadBlockResult> {
  // IDEMPOTENCE, per block: the acted line (the headline) is the key. A block
  // whose headline already carries an action_ref is NOT re-dispatched -- no
  // sink call, no second goal proposal / hopper card / workstream, no write.
  const existingState = getNotepadLineState(subject.acted_line_id);
  if (existingState?.action_ref) {
    const parsed = parseActionRef(existingState.action_ref);
    return {
      created: false,
      sink: parsed?.sink ?? decision.sink,
      action_ref: existingState.action_ref,
      decision,
      acted_line_id: subject.acted_line_id,
      seen_line_ids: [],
      detail: parsed ?? undefined,
    };
  }

  let outcome: SinkOutcome;
  switch (decision.sink) {
    case 'goal_proposal':
      outcome = await actOnGoalProposal(subject, move, dossier, handoffOpts);
      break;
    case 'hopper':
      outcome = actOnHopper(subject, move);
      break;
    case 'workstream':
      outcome = actOnWorkstream(subject, move);
      break;
    case 'thread':
      outcome = await actOnThread(subject, handoffOpts);
      break;
  }

  // actOnThread already wrote the ledger (and the marker, via
  // openNotepadHandoff) itself -- every other sink writes here, once, in the
  // one canonical scheme.
  if (outcome.sink !== 'thread') {
    markLineActed(subject.acted_line_id, outcome.action_ref);
    if (getNotepadMarker(subject.acted_line_id)) setNotepadMarkerActionRef(subject.acted_line_id, outcome.action_ref);
  }

  // Every OTHER member of the block was looked at as part of this topic and
  // needs no action of its own -> 'seen'. A member that already carries a
  // real action_ref of its own (dispatched individually at some earlier
  // point) is left alone: downgrading an 'acted' line to 'seen' would throw
  // away the lineage the ledger exists to keep.
  const seenLineIds: number[] = [];
  for (const id of subject.member_line_ids) {
    if (id === subject.acted_line_id) continue;
    if (getNotepadLineState(id)?.action_ref) continue;
    markLineSeen(id);
    seenLineIds.push(id);
  }

  return {
    created: true,
    sink: outcome.sink,
    action_ref: outcome.action_ref,
    decision,
    acted_line_id: subject.acted_line_id,
    seen_line_ids: seenLineIds,
    detail: outcome.detail,
  };
}

/**
 * Dispatch one notepad BLOCK: route it (node #943's block rule table, run
 * over the whole topic), then act on whichever sink the router named, then
 * write the per-line ledger -- `acted` + action_ref on the headline, `seen`
 * on every other member.
 *
 * IDEMPOTENT on the headline line: if its ledger row already holds an
 * action_ref, this returns that existing ref with `created:false` and
 * performs NO sink call and NO write.
 */
export async function dispatchNotepadBlock(input: DispatchNotepadBlockInput): Promise<DispatchNotepadBlockResult> {
  const decision = routeNotepadBlock({
    block: input.block,
    move: input.move,
    dossier: input.dossier ? { confidence: input.dossier.confidence } : undefined,
  });
  return dispatchSubject(blockSubject(input.block), decision, input.move, input.dossier ?? null, input.handoffOpts);
}

/**
 * Dispatch one notepad LINE -- the single-line entry point, unchanged in
 * behaviour: routed by node #873's per-line table (including its backward
 * walk for a `Potential Goals:` heading section, which is why `allLines` is
 * still accepted here), then acted on and ledgered by exactly the same code
 * the block form uses.
 *
 * IDEMPOTENT on line_id: if the ledger already holds an action_ref for this
 * line, this returns that existing ref with `created:false` and performs NO
 * sink call and NO write -- dispatching the same line twice never creates a
 * second goal proposal / hopper card / workstream.
 */
export async function dispatchNotepadLine(input: DispatchNotepadLineInput): Promise<DispatchNotepadLineResult> {
  const decision = routeNotepadLine({
    line: input.line,
    move: input.move,
    dossier: input.dossier ? { confidence: input.dossier.confidence } : undefined,
    allLines: input.allLines,
  });
  return dispatchSubject(lineSubject(input.line), decision, input.move, input.dossier ?? null, input.handoffOpts);
}
