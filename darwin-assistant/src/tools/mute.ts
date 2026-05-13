import type { ToolDef } from './index.js';
import { query } from '../db.js';

export const muteReminders: ToolDef = {
  name: 'mute_reminders',
  description:
    'Mute all JARVIS reminders for a specific item. The item will no longer appear in morning briefings, check-ins, "what\'s next" prompts, or conversational lead-ins. Use when Kevin says "stop reminding me about X" or "mute X". For recurring calendar events, store the base event ID to mute the entire series.',
  parameters: {
    type: 'object',
    properties: {
      source_type: {
        type: 'string',
        enum: ['calendar', 'shim_task', 'paperclip', 'scheduled_task', 'manual'],
        description: 'Type of item to mute',
      },
      source_id: {
        type: 'string',
        description:
          'ID in the source system — Google Calendar event ID, SHIM task ID, Paperclip issue identifier (e.g. DAR-453), etc.',
      },
      reason: {
        type: 'string',
        description: 'Optional reason for the mute (e.g. "Kevin is on autopilot for this")',
      },
    },
    required: ['source_type', 'source_id'],
  },
  execute: async (args) => {
    const { source_type, source_id, reason } = args as {
      source_type: string;
      source_id: string;
      reason?: string;
    };
    const rows = await query<{ id: string; source_type: string; source_id: string }>(
      `INSERT INTO jarvis_reminder_mutes (source_type, source_id, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (source_type, source_id) DO UPDATE SET reason = EXCLUDED.reason
       RETURNING id, source_type, source_id`,
      [source_type, source_id, reason ?? null],
    );
    await query(
      `UPDATE jarvis_checkins SET status = 'cancelled'
       WHERE source_type = $1 AND source_id = $2 AND status = 'pending'`,
      [source_type, source_id],
    );
    return { muted: rows[0], note: 'Existing pending check-ins for this item were also cancelled.' };
  },
};

export const unmuteReminders: ToolDef = {
  name: 'unmute_reminders',
  description:
    'Re-enable JARVIS reminders for a previously muted item. Use when Kevin says "start reminding me about X again" or "unmute X".',
  parameters: {
    type: 'object',
    properties: {
      source_type: {
        type: 'string',
        enum: ['calendar', 'shim_task', 'paperclip', 'scheduled_task', 'manual'],
        description: 'Type of item to unmute',
      },
      source_id: {
        type: 'string',
        description: 'ID in the source system',
      },
    },
    required: ['source_type', 'source_id'],
  },
  execute: async (args) => {
    const { source_type, source_id } = args as {
      source_type: string;
      source_id: string;
    };
    const rows = await query<{ id: string }>(
      `DELETE FROM jarvis_reminder_mutes
       WHERE source_type = $1 AND source_id = $2
       RETURNING id`,
      [source_type, source_id],
    );
    if (!rows.length) return { error: 'No mute found for that item' };
    return { unmuted: true, source_type, source_id };
  },
};

export const listMuted: ToolDef = {
  name: 'list_muted',
  description:
    'List all items Kevin has muted. Shows source type, ID, reason, and when it was muted.',
  parameters: {
    type: 'object',
    properties: {
      source_type: {
        type: 'string',
        enum: ['calendar', 'shim_task', 'paperclip', 'scheduled_task', 'manual'],
        description: 'Filter by source type. Omit to list all.',
      },
    },
  },
  execute: async (args) => {
    const { source_type } = args as { source_type?: string };
    if (source_type) {
      return query(
        `SELECT id, source_type, source_id, reason, created_by, created_at
         FROM jarvis_reminder_mutes
         WHERE source_type = $1
         ORDER BY created_at DESC`,
        [source_type],
      );
    }
    return query(
      `SELECT id, source_type, source_id, reason, created_by, created_at
       FROM jarvis_reminder_mutes
       ORDER BY created_at DESC`,
    );
  },
};
