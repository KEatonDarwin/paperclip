import type { ToolDef } from './index.js';
import { query } from '../db.js';

export const enqueueCheckin: ToolDef = {
  name: 'enqueue_checkin',
  description:
    'Schedule a check-in reminder for Kevin at a specific time. Use this when Kevin asks to be reminded about something, or when you want to follow up on a task later. Source types: calendar, shim_task, paperclip, manual.',
  parameters: {
    type: 'object',
    properties: {
      fire_at: {
        type: 'string',
        description: 'ISO 8601 timestamp for when to fire the check-in (e.g. "2026-05-07T14:30:00-05:00")',
      },
      reason: {
        type: 'string',
        description: 'Context for JARVIS when the check-in fires — what to check on and why',
      },
      source_type: {
        type: 'string',
        enum: ['calendar', 'shim_task', 'paperclip', 'manual'],
        description: 'What system produced this check-in',
      },
      source_id: {
        type: 'string',
        description: 'ID in the source system (calendar event ID, SHIM task ID, etc.)',
      },
    },
    required: ['fire_at', 'reason', 'source_type'],
  },
  execute: async (args) => {
    const { fire_at, reason, source_type, source_id } = args as {
      fire_at: string;
      reason: string;
      source_type: string;
      source_id?: string;
    };
    const rows = await query<{ id: string; fire_at: string }>(
      `INSERT INTO jarvis_checkins (fire_at, reason, source_type, source_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, fire_at`,
      [fire_at, reason, source_type, source_id ?? null],
    );
    return rows[0];
  },
};

export const listCheckins: ToolDef = {
  name: 'list_checkins',
  description:
    "List Kevin's upcoming or recent check-ins. Defaults to pending check-ins ordered by fire time.",
  parameters: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'fired', 'cancelled', 'skipped'],
        description: 'Filter by status. Defaults to pending.',
      },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
  },
  execute: async (args) => {
    const { status = 'pending', limit = 20 } = args as {
      status?: string;
      limit?: number;
    };
    return query(
      `SELECT id, fire_at, reason, source_type, source_id, status, created_at
       FROM jarvis_checkins
       WHERE status = $1
       ORDER BY fire_at ASC
       LIMIT $2`,
      [status, limit],
    );
  },
};

export const cancelCheckin: ToolDef = {
  name: 'cancel_checkin',
  description:
    'Cancel a pending check-in by ID. Use when Kevin says he no longer needs a reminder or the task is already done.',
  parameters: {
    type: 'object',
    properties: {
      checkin_id: { type: 'string', description: 'UUID of the check-in to cancel' },
    },
    required: ['checkin_id'],
  },
  execute: async (args) => {
    const { checkin_id } = args as { checkin_id: string };
    const rows = await query<{ id: string; status: string }>(
      `UPDATE jarvis_checkins SET status = 'cancelled'
       WHERE id = $1 AND status = 'pending'
       RETURNING id, status`,
      [checkin_id],
    );
    if (!rows.length) return { error: 'Check-in not found or already processed' };
    return rows[0];
  },
};
