import { query } from './db.js';

interface MuteRow {
  source_type: string;
  source_id: string;
}

export async function isMuted(sourceType: string, sourceId: string): Promise<boolean> {
  if (!sourceId) return false;

  if (sourceType === 'calendar') {
    const rows = await query<MuteRow>(
      `SELECT source_type, source_id FROM jarvis_reminder_mutes
       WHERE source_type = 'calendar'
       AND ($1 = source_id OR $1 LIKE source_id || '%')
       LIMIT 1`,
      [sourceId],
    );
    return rows.length > 0;
  }

  const rows = await query<MuteRow>(
    `SELECT source_type, source_id FROM jarvis_reminder_mutes
     WHERE source_type = $1 AND source_id = $2
     LIMIT 1`,
    [sourceType, sourceId],
  );
  return rows.length > 0;
}

export async function getMutedSourceIds(sourceType: string): Promise<Set<string>> {
  const rows = await query<MuteRow>(
    `SELECT source_id FROM jarvis_reminder_mutes WHERE source_type = $1`,
    [sourceType],
  );
  return new Set(rows.map((r) => r.source_id));
}
