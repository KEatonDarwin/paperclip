import type { ToolDef } from './index.js';
import {
  listThreadLinks,
  setPreviewLink,
  addThreadLink,
  deleteThreadLink,
  clearThreadLinks,
  getThreadLink,
} from '../thread-links.js';

function normalizeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v) return null;
  // Accept bare hosts by defaulting to https; reject anything that still isn't a URL.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
  try {
    // eslint-disable-next-line no-new
    new URL(candidate);
    return candidate;
  } catch {
    return null;
  }
}

// The per-thread "relevant links" bar shown under the title of the CURRENT
// cockpit window (and every pane of a group window). Use this so Kevin can see,
// at a glance across ~5 side-by-side chats all building the same repo, which
// preview/builds URL belongs to which chat. Set the preview URL here the moment
// a lane produces one (e.g. after start_lovable_lane / rebuild_lovable_lane, or
// any <branch>.builds.thedarwinhub.com build) — the bar fills in live. Links are
// scoped to the current conversation automatically; JARVIS never passes an id.
export const threadLinks: ToolDef = {
  name: 'thread_links',
  description:
    "Manage the 'relevant links' bar shown under the title of the CURRENT cockpit window (also visible in each pane of a group window). Use it to surface this thread's live preview/build URL and any reference links so Kevin can tell parallel chats apart. Set the preview URL the moment you have one (e.g. a <branch>.builds.thedarwinhub.com or Lovable preview after building a lane). Links are auto-scoped to the current conversation. Operations: 'set_preview' (the primary/hero URL — needs url, optional label; idempotent, replaces the existing preview), 'add' (a secondary link — needs url, optional label), 'list', 'remove' (needs link_id), 'clear' (remove all).",
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['set_preview', 'add', 'list', 'remove', 'clear'],
        description: 'What to do.',
      },
      url: {
        type: 'string',
        description: 'The link URL. Required for set_preview and add. A bare host is assumed https://.',
      },
      label: {
        type: 'string',
        description: "Optional short label for the link (e.g. 'Media buy page', 'GitHub'). Falls back to the URL host if omitted.",
      },
      link_id: {
        type: 'number',
        description: 'Target link id. Required for remove.',
      },
    },
    required: ['operation'],
  },
  execute: async (args, context) => {
    const conversationId = context?.conversationId;
    if (!conversationId) {
      return { error: 'No active conversation — thread links are only available inside a cockpit conversation.' };
    }
    const op = typeof args.operation === 'string' ? args.operation : '';
    const label = typeof args.label === 'string' && args.label.trim() ? args.label.trim() : null;

    switch (op) {
      case 'list':
        return { links: listThreadLinks(conversationId) };

      case 'set_preview': {
        const url = normalizeUrl(args.url);
        if (!url) return { error: 'a valid url is required for set_preview' };
        return { ok: true, link: setPreviewLink(conversationId, url, label) };
      }

      case 'add': {
        const url = normalizeUrl(args.url);
        if (!url) return { error: 'a valid url is required for add' };
        return { ok: true, link: addThreadLink(conversationId, url, label) };
      }

      case 'remove': {
        const id = Number(args.link_id);
        if (!id) return { error: 'remove needs a link_id' };
        const existing = getThreadLink(id);
        if (!existing || existing.conversation_id !== conversationId) {
          return { error: 'link_not_found on this thread' };
        }
        deleteThreadLink(id);
        return { ok: true, removed_id: id };
      }

      case 'clear':
        return { ok: true, removed: clearThreadLinks(conversationId) };

      default:
        return { error: `unknown operation: ${op || '(none)'}` };
    }
  },
};
