// Pure helpers for the After queue (no DB import, so they can be checked alone).
// At drain, every pending queued message for a thread becomes ONE turn:
//   - expired rows are dropped first,
//   - a single row passes through untouched,
//   - several rows are joined oldest-first under a header that says later wins,
//     with their images/files unioned and the newest reply-link kept.

export interface MergeableRow {
  id: number;
  content: string;
  created_at: string; // sqlite `YYYY-MM-DD HH:MM:SS` (UTC) or ISO
  images: string | null;
  files: string | null;
  reply_to_turn_index: number | null;
  sender?: string | null;
  expires_at?: string | null;
}

export interface MergedMessage {
  content: string;
  images: string | null;
  files: string | null;
  reply_to_turn_index: number | null;
  count: number;
}

export function parseDbTime(s: string): number {
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
}

export function isExpired(row: Pick<MergeableRow, 'expires_at'>, nowMs: number): boolean {
  if (!row.expires_at) return false;
  const t = parseDbTime(row.expires_at);
  return Number.isFinite(t) && t <= nowMs;
}

function unionJsonArrays(values: Array<string | null>): string | null {
  const out: unknown[] = [];
  for (const v of values) {
    if (!v) continue;
    try {
      const a = JSON.parse(v);
      if (Array.isArray(a)) out.push(...a);
    } catch { /* skip a malformed column rather than lose the whole merge */ }
  }
  return out.length ? JSON.stringify(out) : null;
}

export function mergeQueued(rows: MergeableRow[]): MergedMessage | null {
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  if (sorted.length === 1) {
    const r = sorted[0];
    return { content: r.content, images: r.images, files: r.files, reply_to_turn_index: r.reply_to_turn_index, count: 1 };
  }
  const lines = sorted.map((r) => {
    const t = r.created_at.includes('T') ? r.created_at.slice(11, 19) : r.created_at.slice(11, 19);
    return `[${t}Z${r.sender ? ` ${r.sender}` : ''}] ${r.content}`;
  });
  const replyTo = [...sorted].reverse().find((r) => r.reply_to_turn_index != null)?.reply_to_turn_index ?? null;
  return {
    content: `${sorted.length} messages arrived while you were working. Oldest first; where they conflict, the later one wins.\n\n${lines.join('\n\n')}`,
    images: unionJsonArrays(sorted.map((r) => r.images)),
    files: unionJsonArrays(sorted.map((r) => r.files)),
    reply_to_turn_index: replyTo,
    count: sorted.length,
  };
}
