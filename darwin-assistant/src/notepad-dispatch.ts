import type { TopicDossier } from './notepad-dossier.js';
import {
  routeNotepadLine,
  type RouteLineInput,
  type RouteMoveInput,
  type NotepadRouteSink,
  type NotepadRouteDecision,
} from './notepad-route-rule.js';
import { getNotepadLineState, markLineActed } from './notepad.js';
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

// == dispatchNotepadLine ======================================================

export interface DispatchNotepadLineInput {
  line: RouteLineInput;
  move: RouteMoveInput;
  /** The full dossier (node #107), if one was built for this line — used for
   *  its `.goal` when the sink is goal_proposal. Only `confidence` is
   *  forwarded to the router (the only field it currently consults). */
  dossier?: TopicDossier | null;
  /** Forwarded to the router for goal-heading-section detection. */
  allLines?: RouteLineInput[];
  /** Injection seam forwarded verbatim to openNotepadHandoff when the sink is
   *  (or falls back to) thread — lets a sim/check stub the dossier's model
   *  call and the seed post, exactly as notepad-handoff-route-check.mjs
   *  already does for node #869 directly. Omitted, this uses
   *  openNotepadHandoff's own real defaults. */
  handoffOpts?: OpenNotepadHandoffOptions;
}

export interface DispatchNotepadLineResult {
  /** false when this line already had an action_ref on its ledger row before
   *  this call — nothing was written, `action_ref` is whatever was already
   *  there. */
  created: boolean;
  /** The sink actually acted on. Can differ from `decision.sink` exactly once
   *  in the current wiring: a goal_proposal decision with no attachment point
   *  (no dossier.goal, or the proposed parent rejects a new child) falls back
   *  to `thread` — see actOnGoalProposal below. */
  sink: NotepadRouteSink;
  action_ref: string;
  /** The router's own decision, kept for forensics even when a fallback changed
   *  what actually happened. */
  decision: NotepadRouteDecision;
  detail?: Record<string, unknown>;
}

interface SinkOutcome {
  sink: NotepadRouteSink;
  action_ref: string;
  detail?: Record<string, unknown>;
}

function goalProposalDoneMeans(lineText: string): string {
  return `"${lineText.trim().replace(/\s+/g, ' ')}" is done.`;
}

/**
 * thread sink — delegates entirely to node #869's openNotepadHandoff (the
 * only thread-handoff mechanism on this branch; see the node spec). That
 * function already writes the line's ledger action_ref (bare thread_ext, no
 * scheme prefix) and the marker's action_ref on first open, and is itself
 * idempotent (a second call for the same line is a pure read).
 *
 * We re-stamp the ledger with the CANONICAL `thread:<thread_ext>` form right
 * after, so every sink's ledger action_ref is parseable by parseActionRef the
 * same way — the marker's action_ref is left exactly as #869 wrote it (bare
 * thread_ext), since that is its own established contract with the cockpit
 * UI, not something this node owns.
 */
async function actOnThread(line: RouteLineInput, opts?: OpenNotepadHandoffOptions): Promise<SinkOutcome> {
  const result = await openNotepadHandoff(line.line_id, opts);
  const actionRef = buildActionRef({ sink: 'thread', thread_ext: result.thread_ext });
  markLineActed(line.line_id, actionRef);
  return { sink: 'thread', action_ref: actionRef, detail: { thread_ext: result.thread_ext, handoff_created: result.created } };
}

/**
 * goal_proposal sink — propose a ghost node under whatever goal/node the
 * dossier's deterministic evidence already named (node #107's
 * `dossier.goal`). Creating a brand-new GOAL is Kevin's call by contract
 * (see createGoal in goals.ts) — this only ever calls proposeGoalNodes
 * against an EXISTING goal, never createGoal.
 *
 * When the dossier named no goal at all, or the goal it named rejects a new
 * child right now (proposeGoalNodes throws — e.g. its parent node isn't in a
 * state that accepts children), there is no safe attachment point to invent
 * one for. Per this codebase's standing rule (renderNoneConfidence,
 * routeNotepadLine's own thread default, decideNotepadMoves' silence-by-
 * default) — a chat is always safe, inventing a home for an idea is not —
 * this falls back to the thread handoff rather than guessing a goal.
 */
async function actOnGoalProposal(
  line: RouteLineInput,
  move: RouteMoveInput,
  dossier: TopicDossier | null,
  handoffOpts?: OpenNotepadHandoffOptions,
): Promise<SinkOutcome> {
  const target = dossier?.goal ?? null;
  if (!target) return actOnThread(line, handoffOpts);

  try {
    const title = line.text.trim();
    const { nodes } = proposeGoalNodes(target.goal_id, {
      parent_id: target.node_id,
      items: [
        {
          title,
          done_means: goalProposalDoneMeans(title),
          notes: move.reason ? `JARVIS's read: ${move.reason}` : undefined,
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
    return actOnThread(line, handoffOpts);
  }
}

/** hopper sink — file a pending candidate card. A candidate, not started
 *  work: Kevin still clicks Yes/Yes-but/Dismiss before anything runs. */
function actOnHopper(line: RouteLineInput, move: RouteMoveInput): SinkOutcome {
  const item = createHopperItem({
    title: line.text.trim().slice(0, 200),
    summary: move.reason ?? null,
    source: 'notepad',
    source_ref: `notepad-line-${line.line_id}`,
    raw_message: line.text,
  });
  return {
    sink: 'hopper',
    action_ref: buildActionRef({ sink: 'hopper', candidate_id: item.id }),
    detail: { candidate_id: item.id },
  };
}

/** workstream sink — find-or-create via jotWorkstream's own fuzzy match
 *  (title/what token overlap against open workstreams — "create or attach",
 *  per the node spec), then make sure it actually carries a turn and a
 *  next_action, since a fresh jot lands `parked` with no next_action. */
function actOnWorkstream(line: RouteLineInput, move: RouteMoveInput): SinkOutcome {
  const text = line.text.trim();
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
 * Dispatch one notepad line: route it (node #873's pure table), then act on
 * whichever sink the router named, then write the result back onto the
 * line's ledger row (notepad_line_state.action_ref via markLineActed) so the
 * line is marked 'acted' and won't re-fire until its text changes.
 *
 * IDEMPOTENT on line_id: if the ledger already holds an action_ref for this
 * line, this returns that existing ref with `created:false` and performs NO
 * sink call and NO write — dispatching the same line twice never creates a
 * second goal proposal / hopper card / workstream.
 */
export async function dispatchNotepadLine(input: DispatchNotepadLineInput): Promise<DispatchNotepadLineResult> {
  const decision = routeNotepadLine({
    line: input.line,
    move: input.move,
    dossier: input.dossier ? { confidence: input.dossier.confidence } : undefined,
    allLines: input.allLines,
  });

  const existingState = getNotepadLineState(input.line.line_id);
  if (existingState?.action_ref) {
    const parsed = parseActionRef(existingState.action_ref);
    return {
      created: false,
      sink: parsed?.sink ?? decision.sink,
      action_ref: existingState.action_ref,
      decision,
      detail: parsed ?? undefined,
    };
  }

  const dossier = input.dossier ?? null;
  let outcome: SinkOutcome;
  switch (decision.sink) {
    case 'goal_proposal':
      outcome = await actOnGoalProposal(input.line, input.move, dossier, input.handoffOpts);
      break;
    case 'hopper':
      outcome = actOnHopper(input.line, input.move);
      break;
    case 'workstream':
      outcome = actOnWorkstream(input.line, input.move);
      break;
    case 'thread':
      outcome = await actOnThread(input.line, input.handoffOpts);
      break;
  }

  // actOnThread already wrote the ledger (and the marker, via
  // openNotepadHandoff) itself — every other sink writes here, once, in the
  // one canonical scheme.
  if (outcome.sink !== 'thread') {
    markLineActed(input.line.line_id, outcome.action_ref);
    if (getNotepadMarker(input.line.line_id)) setNotepadMarkerActionRef(input.line.line_id, outcome.action_ref);
  }

  return { created: true, sink: outcome.sink, action_ref: outcome.action_ref, decision, detail: outcome.detail };
}
