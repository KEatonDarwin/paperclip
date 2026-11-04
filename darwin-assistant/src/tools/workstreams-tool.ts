import { getConversation } from '../conversation-db.js';
import type { ToolDef } from './index.js';
import {
  attachWorkstreamLink,
  completeWorkstreamStep,
  createWorkstream,
  flipTurn,
  getWorkstream,
  isWorkstreamActor,
  isWorkstreamLinkKind,
  isWorkstreamTurn,
  jotWorkstream,
  listWorkstreams,
  logWorkstreamEvent,
  updateWorkstream,
  type WorkstreamActor,
  type WorkstreamTurn,
} from '../workstreams.js';

// Flight Deck bug (Kevin, 2b0a7683): cards created from a chat had no link
// back to it. Skip the Flight Deck page itself and a workstream's own
// 💬 Discuss thread — neither is a meaningful "origin" to link back to.
const SKIP_ORIGIN_EXT = /^cockpit:workstream-\d+$/;

function originChatLabel(ext: string): string {
  try {
    const conversation = getConversation(ext);
    const title = conversation?.title?.trim();
    if (title) return `Origin chat · ${title.length > 48 ? `${title.slice(0, 48).trimEnd()}...` : title}`;
  } catch {
    /* fall through to generic label */
  }
  return 'Origin chat';
}

// FLIGHT DECK tool — keeps Kevin's cockpit surface true as work moves. A
// workstream is one ball in the air; the important fields are `turn` (whose
// move it is) and `next_action` (what that person should do next). Use this
// whenever a thread/tree/todo changes who owns the next step.
export const workstreams: ToolDef = {
  name: 'workstreams',
  description:
    "Maintain Kevin's Flight Deck workstreams — the one surface for balls in the air. Keep it TRUE while working: flip turns (jarvis|kevin|external|parked|done), set next_action, attach threads/trees/todo roots/commitments/URLs, and log outcomes to the timeline. Operations: 'list', 'create', 'update', 'flip', 'attach', 'log', 'done_step', 'jot'.",
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['list', 'create', 'update', 'flip', 'attach', 'log', 'done_step', 'jot'],
        description: 'What to do.',
      },
      id: { type: 'number', description: 'Workstream id. Required for update/flip/attach/log/done_step.' },
      include_done: { type: 'boolean', description: 'For list: include completed workstreams.' },
      title: { type: 'string', description: 'Workstream title. Required for create; optional for update.' },
      what: { type: 'string', description: 'What this workstream is about.' },
      turn: {
        type: 'string',
        enum: ['jarvis', 'kevin', 'external', 'parked', 'done'],
        description: 'Whose turn it is.',
      },
      next_action: { type: 'string', description: 'One clear next action.' },
      next_owner: { type: 'string', description: 'Who owns the next action.' },
      smart_todo_root_id: { type: 'number', description: 'Optional Smart Todo root id.' },
      group_id: { type: 'number', description: 'Optional cockpit group id.' },
      sort_order: { type: 'number', description: 'Optional sort order.' },
      archived: { type: 'boolean', description: 'Archive/unarchive the workstream.' },
      kind: {
        type: 'string',
        enum: ['thread', 'tree', 'todo_root', 'commitment', 'url'],
        description: 'Link kind for attach.',
      },
      ref: { type: 'string', description: 'Link reference for attach.' },
      label: { type: 'string', description: 'Optional link label.' },
      actor: {
        type: 'string',
        enum: ['jarvis', 'kevin', 'system'],
        description: 'Timeline actor for log/flip/create/update.',
      },
      text: { type: 'string', description: 'Timeline text for log, or jot text for jot.' },
      note: { type: 'string', description: "Kevin's optional Done-step note." },
    },
    required: ['operation'],
  },
  execute: async (args, context) => {
    const op = typeof args.operation === 'string' ? args.operation : '';
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
    const id = () => num(args.id);
    const actor = (): WorkstreamActor => {
      const raw = str(args.actor);
      return raw && isWorkstreamActor(raw) ? raw : 'jarvis';
    };

    if (op === 'list') {
      return { workstreams: listWorkstreams(args.include_done === true) };
    }

    if (op === 'create') {
      const title = str(args.title);
      if (!title) return { error: 'create needs a title' };
      const rawTurn = str(args.turn);
      const turn = rawTurn && isWorkstreamTurn(rawTurn) ? rawTurn : undefined;
      const workstream = createWorkstream({
        title,
        what: str(args.what),
        turn,
        next_action: str(args.next_action),
        next_owner: str(args.next_owner),
        smart_todo_root_id: num(args.smart_todo_root_id),
        group_id: num(args.group_id),
        sort_order: num(args.sort_order),
        actor: actor(),
      });

      const originExt = context && typeof context.externalId === 'string' ? context.externalId.trim() : '';
      if (originExt && originExt !== 'cockpit:flight-deck' && !SKIP_ORIGIN_EXT.test(originExt)) {
        try {
          attachWorkstreamLink({
            workstream_id: workstream.id,
            kind: 'thread',
            ref: originExt,
            label: originChatLabel(originExt),
          });
        } catch {
          /* a pre-existing link (or any attach failure) must never fail workstream creation */
        }
      }

      const refreshed = getWorkstream(workstream.id);
      return { ok: true, workstream: refreshed ?? workstream };
    }

    if (op === 'update') {
      const workstreamId = id();
      if (workstreamId === null) return { error: 'update needs id' };
      const rawTurn = str(args.turn);
      const turn = rawTurn && isWorkstreamTurn(rawTurn) ? rawTurn : undefined;
      const patch: Parameters<typeof updateWorkstream>[1] = {
        title: str(args.title) ?? undefined,
        what: args.what !== undefined ? str(args.what) : undefined,
        turn,
        next_action: args.next_action !== undefined ? str(args.next_action) : undefined,
        next_owner: args.next_owner !== undefined ? str(args.next_owner) : undefined,
        smart_todo_root_id: args.smart_todo_root_id !== undefined ? num(args.smart_todo_root_id) : undefined,
        group_id: args.group_id !== undefined ? num(args.group_id) : undefined,
        sort_order: num(args.sort_order) ?? undefined,
        archived: bool(args.archived),
        actor: actor(),
        event_text: str(args.text),
      };
      const workstream = updateWorkstream(workstreamId, patch);
      return workstream ? { ok: true, workstream } : { error: `workstream ${workstreamId} not found` };
    }

    if (op === 'flip') {
      const workstreamId = id();
      if (workstreamId === null) return { error: 'flip needs id' };
      const rawTurn = str(args.turn);
      if (!rawTurn || !isWorkstreamTurn(rawTurn)) return { error: 'flip needs a valid turn' };
      const workstream = flipTurn(workstreamId, rawTurn as WorkstreamTurn, {
        actor: actor(),
        text: str(args.text),
        next_action: args.next_action !== undefined ? str(args.next_action) : undefined,
        next_owner: args.next_owner !== undefined ? str(args.next_owner) : undefined,
      });
      return workstream ? { ok: true, workstream } : { error: `workstream ${workstreamId} not found` };
    }

    if (op === 'attach') {
      const workstreamId = id();
      if (workstreamId === null) return { error: 'attach needs id' };
      const rawKind = str(args.kind);
      const ref = str(args.ref);
      if (!rawKind || !isWorkstreamLinkKind(rawKind)) return { error: 'attach needs a valid kind' };
      if (!ref) return { error: 'attach needs ref' };
      const link = attachWorkstreamLink({
        workstream_id: workstreamId,
        kind: rawKind,
        ref,
        label: str(args.label),
      });
      const workstream = getWorkstream(workstreamId);
      return link && workstream ? { ok: true, link, workstream } : { error: `workstream ${workstreamId} not found` };
    }

    if (op === 'log') {
      const workstreamId = id();
      if (workstreamId === null) return { error: 'log needs id' };
      const text = str(args.text);
      if (!text) return { error: 'log needs text' };
      const event = logWorkstreamEvent(workstreamId, actor(), text);
      const workstream = getWorkstream(workstreamId);
      return event && workstream ? { ok: true, event, workstream } : { error: `workstream ${workstreamId} not found` };
    }

    if (op === 'done_step') {
      const workstreamId = id();
      if (workstreamId === null) return { error: 'done_step needs id' };
      const workstream = completeWorkstreamStep(workstreamId, str(args.note));
      return workstream ? { ok: true, workstream } : { error: `workstream ${workstreamId} not found` };
    }

    if (op === 'jot') {
      const text = str(args.text) ?? str(args.note);
      if (!text) return { error: 'jot needs text' };
      return jotWorkstream(text);
    }

    return { error: `unknown operation: ${op || '(none)'}` };
  },
};
