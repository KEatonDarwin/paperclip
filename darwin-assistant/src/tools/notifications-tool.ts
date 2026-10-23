import type { ToolDef } from './index.js';
import {
  listNotifications,
  createNotification,
  markNotificationRead,
  type NotificationSeverity,
} from '../notifications.js';

const VALID_SEVERITIES: NotificationSeverity[] = ['info', 'success', 'warning', 'error'];

// DAR-761 — cockpit-wide notification layer (bell/center + toasts). Unlike
// thread_todos, this is NOT scoped to the current conversation — it's Kevin's
// single global inbox, so JARVIS can raise something here from any thread (or
// a background job) and have it show up no matter what Kevin has open.
export const notifications: ToolDef = {
  name: 'notifications',
  description:
    "Push something onto Kevin's cockpit notification layer (bell icon + toast), or check what's there. Global — not scoped to this conversation. Use for anything Kevin should be told about even if this thread isn't open: a background job finished, something needs attention, an error occurred. Severities: 'info' (neutral/FYI), 'success', 'warning', 'error' (errors persist in the toast until dismissed). Operations: 'create' (needs severity + title, optional body/source/link), 'list' (recent notifications), 'mark_read' (needs notification_id).",
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['create', 'list', 'mark_read'],
        description: 'What to do.',
      },
      severity: {
        type: 'string',
        enum: VALID_SEVERITIES,
        description: 'Required for create.',
      },
      title: {
        type: 'string',
        description: 'Short headline. Required for create.',
      },
      body: {
        type: 'string',
        description: 'Optional longer detail text.',
      },
      source: {
        type: 'string',
        description: 'Optional label for what raised this (e.g. a subsystem or thread name).',
      },
      link: {
        type: 'string',
        description: 'Optional click-through link/action for the notification.',
      },
      notification_id: {
        type: 'number',
        description: 'Target notification id. Required for mark_read.',
      },
    },
    required: ['operation'],
  },
  execute: async (args) => {
    const op = typeof args.operation === 'string' ? args.operation : '';

    switch (op) {
      case 'list':
        return { notifications: listNotifications(50) };

      case 'create': {
        const severity = (typeof args.severity === 'string' ? args.severity : '') as NotificationSeverity;
        const title = typeof args.title === 'string' ? args.title.trim() : '';
        if (!VALID_SEVERITIES.includes(severity) || !title) {
          return { error: `create needs a severity of ${VALID_SEVERITIES.join('|')} and a title` };
        }
        const body = typeof args.body === 'string' ? args.body : null;
        const source = typeof args.source === 'string' ? args.source : null;
        const link = typeof args.link === 'string' ? args.link : null;
        return { ok: true, notification: createNotification({ severity, title, body, source, link }) };
      }

      case 'mark_read': {
        const id = Number(args.notification_id);
        if (!id) return { error: 'mark_read needs notification_id' };
        return { ok: true, notification: markNotificationRead(id) };
      }

      default:
        return { error: `unknown operation: ${op || '(none)'}` };
    }
  },
};
