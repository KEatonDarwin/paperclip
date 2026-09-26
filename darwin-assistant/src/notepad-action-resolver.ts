import { parseActionRef, type ParsedActionRef } from './notepad-dispatch.js';
import { getNotepadDay, getNotepadLineState } from './notepad.js';
import { getNotepadMarker } from './notepad-markers.js';
import { getGoalTree } from './goals.js';
import { getHopperItem } from './hopper.js';
import { getWorkstream } from './workstreams.js';
import { getConversation } from './conversation-db.js';

// Node #877 — the READ side of node #873/#874/#875's routing work: given an
// action_ref string already on a notepad line's ledger, resolve it back to a
// live target Kevin can actually click into, and expose a day's acted lines
// with that resolution attached. This module owns exactly two things:
// resolveActionRef (one ref -> one record) and listNotepadActedActions (one
// day -> every acted line + its resolution). It does not decide what a line
// routes to (notepad-route-rule.ts) and it does not own any sink's storage
// (goals.ts/hopper.ts/workstreams.ts/conversation-db.ts do) — it only reads
// from each.
//
// THE RULE THAT MATTERS (per the node spec): a ref whose target is gone is
// exists:false with a broken_reason — never omitted, never silently
// swallowed, never returned as an empty success. Same for a ref that doesn't
// parse at all. A surface that quietly drops evidence is worse than one that
// admits a gap.
//
// Cockpit link conventions used for `url` (confirmed against the actual
// cockpit frontend routes in jarvis-command-center/src/routes/, not
// guessed): goal -> `/goals/$goalId` (goals_.$goalId.tsx, also documented in
// docs/goals/CONTRACT.md's namespace rule); thread -> `/thread/$externalId`
// (thread.$externalId.tsx). Hopper and workstreams have no per-item deep
// link in that frontend today (hopper.tsx / flight-deck.tsx take no id/search
// param) — their url is the bare page.
//
// Never resolves or emits anything pointing at DAR / Paperclip: parseActionRef
// only recognizes the four schemes above, so there is no code path here that
// could reach it (same static guarantee notepad-route-check.mjs proves for
// the write side).

export type ResolvedActionRefKind = ParsedActionRef['sink'] | 'unknown';

export interface ResolvedActionRef {
  kind: ResolvedActionRefKind;
  /** A stable string identifying the target within its kind — goal:
   *  `<goal_id>:<node_id>`, hopper/workstream: the numeric id as a string,
   *  thread: the thread_ext, unknown: the raw ref string. */
  id: string;
  exists: boolean;
  /** The human-readable thing Kevin reads on the line. Null when exists is
   *  false — there is nothing honest to show. */
  label: string | null;
  /** Null when exists is false. */
  url: string | null;
  /** Null when exists is true. Always set (a real reason, not a generic
   *  string) when exists is false. */
  broken_reason: string | null;
}

function broken(kind: ResolvedActionRefKind, id: string, reason: string): ResolvedActionRef {
  return { kind, id, exists: false, label: null, url: null, broken_reason: reason };
}

function resolveGoalProposal(goalId: number, nodeId: number): ResolvedActionRef {
  const id = `${goalId}:${nodeId}`;
  const tree = getGoalTree(goalId, true);
  if (!tree) return broken('goal_proposal', id, `goal #${goalId} not found`);
  const node = tree.nodes.find((n) => n.id === nodeId);
  if (!node) return broken('goal_proposal', id, `node #${nodeId} not found in goal #${goalId}`);
  return {
    kind: 'goal_proposal',
    id,
    exists: true,
    label: `#${node.id} ${node.title}`,
    url: `/goals/${goalId}`,
    broken_reason: null,
  };
}

function resolveHopper(candidateId: number): ResolvedActionRef {
  const id = String(candidateId);
  const item = getHopperItem(candidateId);
  if (!item) return broken('hopper', id, `hopper candidate #${candidateId} not found`);
  return { kind: 'hopper', id, exists: true, label: item.title, url: '/hopper', broken_reason: null };
}

function resolveWorkstream(workstreamId: number): ResolvedActionRef {
  const id = String(workstreamId);
  const ws = getWorkstream(workstreamId);
  if (!ws) return broken('workstream', id, `workstream #${workstreamId} not found`);
  return { kind: 'workstream', id, exists: true, label: ws.title, url: '/flight-deck', broken_reason: null };
}

function resolveThread(threadExt: string): ResolvedActionRef {
  const conv = getConversation(threadExt);
  if (!conv) return broken('thread', threadExt, `conversation '${threadExt}' not found`);
  return {
    kind: 'thread',
    id: threadExt,
    exists: true,
    label: conv.title ?? conv.external_id,
    url: `/thread/${encodeURIComponent(threadExt)}`,
    broken_reason: null,
  };
}

/** Resolve one action_ref string to a live target. Never throws — a
 *  malformed ref (doesn't match any of the four known schemes) resolves the
 *  same way a ref whose target row is gone does: exists:false with a
 *  broken_reason, kind 'unknown'. */
export function resolveActionRef(ref: string): ResolvedActionRef {
  const parsed = parseActionRef(ref);
  if (!parsed) return broken('unknown', ref, `unrecognized action_ref format: ${JSON.stringify(ref)}`);
  switch (parsed.sink) {
    case 'goal_proposal':
      return resolveGoalProposal(parsed.goal_id, parsed.node_id);
    case 'hopper':
      return resolveHopper(parsed.candidate_id);
    case 'workstream':
      return resolveWorkstream(parsed.workstream_id);
    case 'thread':
      return resolveThread(parsed.thread_ext);
  }
}

export interface NotepadActedAction {
  line_id: number;
  line_text: string;
  move_kind: string | null;
  action_ref: string;
  resolved: ResolvedActionRef;
}

/**
 * Every ACTED line for `day`, in note order, with its action_ref resolved.
 * A line with no action_ref at all (never dispatched) is omitted — it was
 * never acted on. A line with a broken action_ref IS included, with
 * resolved.exists === false (see resolveActionRef's doc comment). An
 * absent/empty day returns an empty array, never null.
 */
export function listNotepadActedActions(day: string): NotepadActedAction[] {
  const { lines } = getNotepadDay(day);
  const out: NotepadActedAction[] = [];
  for (const line of lines) {
    const state = getNotepadLineState(line.id);
    if (!state || state.state !== 'acted' || !state.action_ref) continue;
    out.push({
      line_id: line.id,
      line_text: line.text,
      move_kind: getNotepadMarker(line.id)?.kind ?? null,
      action_ref: state.action_ref,
      resolved: resolveActionRef(state.action_ref),
    });
  }
  return out;
}
