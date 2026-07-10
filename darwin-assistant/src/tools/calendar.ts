import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDef } from './index.js';

const execFileAsync = promisify(execFile);

const GOG_BIN = '/usr/local/bin/gog';

function gogAccount(): string {
  return process.env.GOG_ACCOUNT?.trim() || 'kevineatonfx@gmail.com';
}

function gogCalendarId(): string {
  return process.env.GOG_CALENDAR_ID?.trim() || 'primary';
}

async function runGog(
  subcommand: string,
  args: string[],
  opts: { json?: boolean; force?: boolean } = {},
): Promise<unknown> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GOG_KEYRING_BACKEND: 'file',
    GOG_KEYRING_PASSWORD: '',
  };
  const allArgs = ['calendar', subcommand, ...args, '--no-input', '-a', gogAccount()];
  if (opts.json !== false) allArgs.push('--json', '--results-only');
  if (opts.force) allArgs.push('--force');

  const { stdout } = await execFileAsync(GOG_BIN, allArgs, { env });
  if (!stdout.trim()) return null;
  return JSON.parse(stdout);
}

export const createCalendarEvent: ToolDef = {
  name: 'create_calendar_event',
  description:
    'Create a Google Calendar event for personal tasks, reminders, or appointments with a specific time.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Event title' },
      startTime: {
        type: 'string',
        description: 'Start date/time in ISO 8601 format, e.g. 2026-05-03T11:00:00',
      },
      endTime: {
        type: 'string',
        description:
          'End date/time in ISO 8601 format. If no duration given, default to 30 minutes after start.',
      },
      description: { type: 'string', description: 'Event description or notes' },
      location: { type: 'string', description: 'Optional location' },
    },
    required: ['title', 'startTime', 'endTime'],
  },
  execute: async (args) => {
    const { title, startTime, endTime, description, location } = args as {
      title: string;
      startTime: string;
      endTime: string;
      description?: string;
      location?: string;
    };

    try {
      const gogArgs = [
        gogCalendarId(),
        '--summary', title,
        '--from', startTime,
        '--to', endTime,
      ];
      if (description) gogArgs.push('--description', description);
      if (location) gogArgs.push('--location', location);

      const created = (await runGog('create', gogArgs, { json: true })) as {
        id?: string;
        summary?: string;
      } | null;

      return {
        created: true,
        eventId: created?.id,
        title: created?.summary ?? title,
        start: startTime,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { created: false, error: msg };
    }
  },
};
