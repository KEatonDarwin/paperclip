import {
  getSidecarTurnById,
  markSidecarAccepted,
  type CrossChatSidecarPayload,
} from './cross-chat-sidecar.js';
import { proposeGoalNodes, GoalError, type GoalNodeRow } from './goals.js';

// ACCEPT HANDLER (node #1447, tree-02951798) — Kevin's one-click "take this
// wish and land it in my own systems" action on a cross_chat_sidecar card.
// Deliberately NOT a tool: it is only ever called from the authed cockpit API
// route (api-v1.ts), which requires the main JARVIS_COCKPIT_KEY bearer token.
// Her scoped thin client (companion-guest-auth/companion-thin-client, a
// different branch) never gets a route wired to this — there is nothing here
// for it to reach by construction.

export const GOAL_12_ID = 12;

export type AcceptTarget = 'shim_task' | 'goal12_ghost';

export class AcceptError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** The request object a real create_shim_task call would receive. Never sent to live SHIM here. */
export interface ShimTaskRequest {
  title: string;
  description: string;
  mode: 'personal';
}

export interface AcceptResult {
  sidecar_id: number;
  target: AcceptTarget;
  provenance: string;
  /** Present only for target=goal12_ghost: the real ghost node that was created. */
  node?: GoalNodeRow;
  /** Present only for target=shim_task: the formed request, NOT written to live SHIM. */
  shim_request?: ShimTaskRequest;
}

function provenanceLabel(payload: CrossChatSidecarPayload): string {
  return `from ${payload.from_label}`;
}

/**
 * Loads a cross_chat_sidecar turn by its global turn id and lands it in
 * exactly one of Kevin's systems. goal12_ghost reuses proposeGoalNodes (the
 * same function the `goals` tool's `propose` op calls) so the resulting node
 * is a real ghost under goal 12, not a parallel implementation. shim_task
 * only CONSTRUCTS the create_shim_task request — it never calls SHIM.
 */
export function acceptSidecar(sidecarId: number, target: AcceptTarget): AcceptResult {
  const turn = getSidecarTurnById(sidecarId);
  if (!turn) throw new AcceptError(404, 'sidecar_not_found', `no cross_chat_sidecar turn with id ${sidecarId}`);
  if (turn.sidecar_accepted_at) {
    throw new AcceptError(409, 'already_accepted', `sidecar ${sidecarId} was already accepted (target=${turn.sidecar_accept_target})`);
  }

  let payload: CrossChatSidecarPayload;
  try {
    payload = JSON.parse(turn.tool_args ?? '{}') as CrossChatSidecarPayload;
  } catch {
    throw new AcceptError(500, 'bad_sidecar_payload', `sidecar ${sidecarId} has unparseable tool_args`);
  }
  const provenance = provenanceLabel(payload);

  if (target === 'goal12_ghost') {
    let nodes: GoalNodeRow[];
    try {
      ({ nodes } = proposeGoalNodes(GOAL_12_ID, {
        parent_id: null,
        items: [{
          title: payload.summary,
          done_means: `Review and decide: ${payload.summary}`,
          notes: provenance,
        }],
        actor: 'jarvis',
      }));
    } catch (err) {
      if (err instanceof GoalError) throw new AcceptError(err.status, err.code, err.message);
      throw err;
    }
    const node = nodes[0];
    markSidecarAccepted(sidecarId, target, String(node.id));
    return { sidecar_id: sidecarId, target, provenance, node };
  }

  if (target === 'shim_task') {
    const shimRequest: ShimTaskRequest = {
      title: payload.summary,
      description: provenance,
      mode: 'personal',
    };
    // No live SHIM write — nothing to record as a resulting id yet.
    markSidecarAccepted(sidecarId, target, null);
    return { sidecar_id: sidecarId, target, provenance, shim_request: shimRequest };
  }

  throw new AcceptError(400, 'invalid_target', `target must be 'shim_task' or 'goal12_ghost', got '${target as string}'`);
}
