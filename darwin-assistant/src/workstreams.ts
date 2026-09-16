import { sqliteDb } from './conversation-db.js';
import { sseBus, type WorkstreamEvent as WorkstreamSseEvent } from './sse-bus.js';

export type WorkstreamTurn = 'jarvis' | 'kevin' | 'external' | 'parked' | 'done';
export type WorkstreamLinkKind = 'thread' | 'tree' | 'todo_root' | 'commitment' | 'url';
export type WorkstreamActor = 'jarvis' | 'kevin' | 'system';

export interface WorkstreamRow {
  id: number;
  title: string;
  what: string | null;
  turn: WorkstreamTurn;
  next_action: string | null;
  next_owner: string | null;
  waiting_since: string | null;
  smart_todo_root_id: number | null;
  group_id: number | null;
  sort_order: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

export interface WorkstreamLinkRow {
  id: number;
  workstream_id: number;
  kind: WorkstreamLinkKind;
  ref: string;
  label: string | null;
  created_at: string;
}

export interface WorkstreamTimelineEventRow {
  id: number;
  workstream_id: number;
  actor: WorkstreamActor;
  text: string;
  created_at: string;
}

export interface WorkstreamWithDetails extends WorkstreamRow {
  links: WorkstreamLinkRow[];
  events: WorkstreamTimelineEventRow[];
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS workstreams (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    title              TEXT NOT NULL,
    what               TEXT,
    turn               TEXT NOT NULL DEFAULT 'parked'
                       CHECK (turn IN ('jarvis','kevin','external','parked','done')),
    next_action        TEXT,
    next_owner         TEXT,
    waiting_since      TEXT,
    smart_todo_root_id INTEGER,
    group_id           INTEGER,
    sort_order         INTEGER NOT NULL DEFAULT 0,
    archived           INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_workstreams_turn
    ON workstreams(archived, turn, waiting_since, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_workstreams_sort
    ON workstreams(archived, sort_order, updated_at DESC);

  CREATE TABLE IF NOT EXISTS workstream_links (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('thread','tree','todo_root','commitment','url')),
    ref           TEXT NOT NULL,
    label         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(workstream_id, kind, ref)
  );

  CREATE INDEX IF NOT EXISTS idx_workstream_links_workstream
    ON workstream_links(workstream_id, kind, created_at);

  CREATE INDEX IF NOT EXISTS idx_workstream_links_ref
    ON workstream_links(kind, ref);

  CREATE TABLE IF NOT EXISTS workstream_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
    actor         TEXT NOT NULL CHECK (actor IN ('jarvis','kevin','system')),
    text          TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_workstream_events_workstream
    ON workstream_events(workstream_id, created_at DESC, id DESC);
`);

const VALID_TURNS = new Set<WorkstreamTurn>(['jarvis', 'kevin', 'external', 'parked', 'done']);
const VALID_LINK_KINDS = new Set<WorkstreamLinkKind>(['thread', 'tree', 'todo_root', 'commitment', 'url']);
const VALID_ACTORS = new Set<WorkstreamActor>(['jarvis', 'kevin', 'system']);

const getByIdStmt = sqliteDb.prepare<[number], WorkstreamRow>(`
  SELECT * FROM workstreams WHERE id = ?
`);

const listOpenStmt = sqliteDb.prepare<[], WorkstreamRow>(`
  SELECT * FROM workstreams
  WHERE archived = 0 AND turn != 'done'
  ORDER BY
    CASE turn
      WHEN 'kevin' THEN 0
      WHEN 'jarvis' THEN 1
      WHEN 'external' THEN 2
      WHEN 'parked' THEN 3
      ELSE 4
    END,
    COALESCE(waiting_since, updated_at) ASC,
    sort_order ASC,
    id ASC
`);

const listWithDoneStmt = sqliteDb.prepare<[], WorkstreamRow>(`
  SELECT * FROM workstreams
  WHERE archived = 0
  ORDER BY
    CASE turn
      WHEN 'kevin' THEN 0
      WHEN 'jarvis' THEN 1
      WHEN 'external' THEN 2
      WHEN 'parked' THEN 3
      WHEN 'done' THEN 4
      ELSE 5
    END,
    COALESCE(waiting_since, updated_at) ASC,
    sort_order ASC,
    id ASC
`);

const listLinksStmt = sqliteDb.prepare<[number], WorkstreamLinkRow>(`
  SELECT * FROM workstream_links
  WHERE workstream_id = ?
  ORDER BY
    CASE kind
      WHEN 'thread' THEN 0
      WHEN 'tree' THEN 1
      WHEN 'todo_root' THEN 2
      WHEN 'commitment' THEN 3
      ELSE 4
    END,
    id ASC
`);

const getLinkByIdStmt = sqliteDb.prepare<[number], WorkstreamLinkRow>(`
  SELECT * FROM workstream_links WHERE id = ?
`);

const getExistingLinkStmt = sqliteDb.prepare<[number, WorkstreamLinkKind, string], WorkstreamLinkRow>(`
  SELECT * FROM workstream_links
  WHERE workstream_id = ? AND kind = ? AND ref = ?
  LIMIT 1
`);

const listRecentEventsStmt = sqliteDb.prepare<[number, number], WorkstreamTimelineEventRow>(`
  SELECT * FROM (
    SELECT * FROM workstream_events
    WHERE workstream_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  )
  ORDER BY created_at ASC, id ASC
`);

const insertWorkstreamStmt = sqliteDb.prepare<
  [string, string | null, WorkstreamTurn, string | null, string | null, WorkstreamTurn, number | null, number | null, number]
>(`
  INSERT INTO workstreams (
    title, what, turn, next_action, next_owner, waiting_since,
    smart_todo_root_id, group_id, sort_order
  )
  VALUES (?, ?, ?, ?, ?, CASE WHEN ? IN ('kevin','external') THEN datetime('now') ELSE NULL END, ?, ?, ?)
`);

const updateWorkstreamStmt = sqliteDb.prepare<
  [
    string,
    string | null,
    string | null,
    string | null,
    number | null,
    number | null,
    number,
    number,
  ]
>(`
  UPDATE workstreams
  SET title = ?,
      what = ?,
      next_action = ?,
      next_owner = ?,
      smart_todo_root_id = ?,
      group_id = ?,
      sort_order = ?,
      updated_at = datetime('now')
  WHERE id = ?
`);

const setArchivedStmt = sqliteDb.prepare<[number, number]>(`
  UPDATE workstreams
  SET archived = ?, updated_at = datetime('now')
  WHERE id = ?
`);

const flipTurnStmt = sqliteDb.prepare<[WorkstreamTurn, WorkstreamTurn, number]>(`
  UPDATE workstreams
  SET turn = ?,
      waiting_since = CASE WHEN ? IN ('kevin','external') THEN datetime('now') ELSE NULL END,
      updated_at = datetime('now')
  WHERE id = ?
`);

const clearNextActionStmt = sqliteDb.prepare<[number]>(`
  UPDATE workstreams
  SET next_action = NULL,
      next_owner = NULL,
      updated_at = datetime('now')
  WHERE id = ?
`);

const insertLinkStmt = sqliteDb.prepare<[number, WorkstreamLinkKind, string, string | null]>(`
  INSERT OR IGNORE INTO workstream_links (workstream_id, kind, ref, label)
  VALUES (?, ?, ?, ?)
`);

const updateLinkLabelStmt = sqliteDb.prepare<[string | null, number]>(`
  UPDATE workstream_links
  SET label = COALESCE(?, label)
  WHERE id = ?
`);

const deleteLinkStmt = sqliteDb.prepare<[number]>(`
  DELETE FROM workstream_links WHERE id = ?
`);

const insertEventStmt = sqliteDb.prepare<[number, WorkstreamActor, string]>(`
  INSERT INTO workstream_events (workstream_id, actor, text)
  VALUES (?, ?, ?)
`);

function waitingTurn(turn: WorkstreamTurn): boolean {
  return turn === 'kevin' || turn === 'external';
}

function assertTurn(turn: string): WorkstreamTurn {
  if (!VALID_TURNS.has(turn as WorkstreamTurn)) {
    throw new Error(`turn must be one of ${Array.from(VALID_TURNS).join(', ')}`);
  }
  return turn as WorkstreamTurn;
}

function assertLinkKind(kind: string): WorkstreamLinkKind {
  if (!VALID_LINK_KINDS.has(kind as WorkstreamLinkKind)) {
    throw new Error(`kind must be one of ${Array.from(VALID_LINK_KINDS).join(', ')}`);
  }
  return kind as WorkstreamLinkKind;
}

function assertActor(actor: string): WorkstreamActor {
  if (!VALID_ACTORS.has(actor as WorkstreamActor)) {
    throw new Error(`actor must be one of ${Array.from(VALID_ACTORS).join(', ')}`);
  }
  return actor as WorkstreamActor;
}

// List rows carry a short tail of the timeline (enough to patch a card from
// one SSE event); the detail GET asks for a deeper slice for the drawer.
const LIST_EVENT_LIMIT = 5;
export const DETAIL_EVENT_LIMIT = 100;

function rowWithDetails(row: WorkstreamRow, eventLimit = LIST_EVENT_LIMIT): WorkstreamWithDetails {
  return {
    ...row,
    links: listLinksStmt.all(row.id),
    events: listRecentEventsStmt.all(row.id, eventLimit),
  };
}

function emit(action: WorkstreamSseEvent['action'], workstream: WorkstreamWithDetails): void {
  sseBus.emit('sse', { type: 'workstream', action, workstream } satisfies WorkstreamSseEvent);
}

function emitById(id: number, action: WorkstreamSseEvent['action'] = 'updated'): WorkstreamWithDetails | null {
  const workstream = getWorkstream(id);
  if (workstream) emit(action, workstream);
  return workstream;
}

export function isWorkstreamTurn(value: unknown): value is WorkstreamTurn {
  return typeof value === 'string' && VALID_TURNS.has(value as WorkstreamTurn);
}

export function isWorkstreamLinkKind(value: unknown): value is WorkstreamLinkKind {
  return typeof value === 'string' && VALID_LINK_KINDS.has(value as WorkstreamLinkKind);
}

export function isWorkstreamActor(value: unknown): value is WorkstreamActor {
  return typeof value === 'string' && VALID_ACTORS.has(value as WorkstreamActor);
}

export function getWorkstream(id: number, eventLimit?: number): WorkstreamWithDetails | null {
  const row = getByIdStmt.get(id);
  return row ? rowWithDetails(row, eventLimit) : null;
}

export function listWorkstreams(includeDone = false): WorkstreamWithDetails[] {
  const rows = includeDone ? listWithDoneStmt.all() : listOpenStmt.all();
  return rows.map(rowWithDetails);
}

export function createWorkstream(args: {
  title: string;
  what?: string | null;
  turn?: WorkstreamTurn | string | null;
  next_action?: string | null;
  next_owner?: string | null;
  smart_todo_root_id?: number | null;
  group_id?: number | null;
  sort_order?: number | null;
  actor?: WorkstreamActor;
  event_text?: string | null;
}): WorkstreamWithDetails {
  const title = args.title.trim();
  if (!title) throw new Error('title is required');
  const turn = args.turn ? assertTurn(String(args.turn)) : 'parked';
  const info = insertWorkstreamStmt.run(
    title,
    args.what ?? null,
    turn,
    args.next_action ?? null,
    args.next_owner ?? (waitingTurn(turn) ? turn : null),
    turn,
    args.smart_todo_root_id ?? null,
    args.group_id ?? null,
    args.sort_order ?? 0,
  );
  const id = Number(info.lastInsertRowid);
  const eventText =
    args.event_text?.trim()
    || `Created workstream${turn !== 'parked' ? `; turn: ${turn}` : ''}.`;
  insertEventStmt.run(id, args.actor ?? 'system', eventText);
  const created = getWorkstream(id);
  if (!created) throw new Error('Failed to load workstream after insert');
  emit('created', created);
  return created;
}

export function updateWorkstream(id: number, patch: {
  title?: string;
  what?: string | null;
  turn?: WorkstreamTurn;
  next_action?: string | null;
  next_owner?: string | null;
  smart_todo_root_id?: number | null;
  group_id?: number | null;
  sort_order?: number;
  archived?: boolean;
  actor?: WorkstreamActor;
  event_text?: string | null;
}): WorkstreamWithDetails | null {
  const existing = getByIdStmt.get(id);
  if (!existing) return null;

  const title = patch.title !== undefined ? patch.title.trim() : existing.title;
  if (!title) throw new Error('title cannot be empty');

  updateWorkstreamStmt.run(
    title,
    patch.what !== undefined ? patch.what : existing.what,
    patch.next_action !== undefined ? patch.next_action : existing.next_action,
    patch.next_owner !== undefined ? patch.next_owner : existing.next_owner,
    patch.smart_todo_root_id !== undefined ? patch.smart_todo_root_id : existing.smart_todo_root_id,
    patch.group_id !== undefined ? patch.group_id : existing.group_id,
    patch.sort_order !== undefined ? patch.sort_order : existing.sort_order,
    id,
  );

  if (patch.archived !== undefined) {
    setArchivedStmt.run(patch.archived ? 1 : 0, id);
  }

  if (patch.turn && patch.turn !== existing.turn) {
    flipTurn(id, patch.turn, {
      actor: patch.actor ?? 'system',
      text: patch.event_text ?? `Turn changed: ${existing.turn} -> ${patch.turn}.`,
      emit_event: false,
    });
  } else if (patch.event_text?.trim()) {
    insertEventStmt.run(id, patch.actor ?? 'system', patch.event_text.trim());
  }

  return emitById(id);
}

export function flipTurn(id: number, turn: WorkstreamTurn, opts: {
  actor?: WorkstreamActor;
  text?: string | null;
  next_action?: string | null;
  next_owner?: string | null;
  emit_event?: boolean;
} = {}): WorkstreamWithDetails | null {
  const existing = getByIdStmt.get(id);
  if (!existing) return null;

  if (opts.next_action !== undefined || opts.next_owner !== undefined) {
    updateWorkstreamStmt.run(
      existing.title,
      existing.what,
      opts.next_action !== undefined ? opts.next_action : existing.next_action,
      opts.next_owner !== undefined ? opts.next_owner : existing.next_owner,
      existing.smart_todo_root_id,
      existing.group_id,
      existing.sort_order,
      id,
    );
  }

  flipTurnStmt.run(turn, turn, id);
  const text = opts.text?.trim() || `Turn changed: ${existing.turn} -> ${turn}.`;
  insertEventStmt.run(id, opts.actor ?? 'system', text);
  return opts.emit_event === false ? getWorkstream(id) : emitById(id);
}

export function attachWorkstreamLink(args: {
  workstream_id: number;
  kind: WorkstreamLinkKind | string;
  ref: string;
  label?: string | null;
}): WorkstreamLinkRow | null {
  if (!getByIdStmt.get(args.workstream_id)) return null;
  const kind = assertLinkKind(String(args.kind));
  const ref = args.ref.trim();
  if (!ref) throw new Error('ref is required');

  const existing = getExistingLinkStmt.get(args.workstream_id, kind, ref) ?? null;
  if (existing) {
    if (args.label !== undefined && args.label !== existing.label) {
      updateLinkLabelStmt.run(args.label, existing.id);
      insertEventStmt.run(args.workstream_id, 'system', `Updated ${kind} link label: ${args.label ?? ref}`);
      emitById(args.workstream_id);
      return getLinkByIdStmt.get(existing.id) ?? existing;
    }
    return existing;
  }

  insertLinkStmt.run(args.workstream_id, kind, ref, args.label ?? null);
  insertEventStmt.run(args.workstream_id, 'system', `Linked ${kind}: ${args.label ?? ref}`);
  emitById(args.workstream_id);
  return getExistingLinkStmt.get(args.workstream_id, kind, ref) ?? null;
}

export function deleteWorkstreamLink(workstreamId: number, linkId: number): WorkstreamLinkRow | null {
  const row = getLinkByIdStmt.get(linkId) ?? null;
  if (!row || row.workstream_id !== workstreamId) return null;
  deleteLinkStmt.run(linkId);
  insertEventStmt.run(workstreamId, 'system', `Removed ${row.kind}: ${row.label ?? row.ref}`);
  emitById(workstreamId);
  return row;
}

export function logWorkstreamEvent(
  workstreamId: number,
  actor: WorkstreamActor | string,
  text: string,
): WorkstreamTimelineEventRow | null {
  if (!getByIdStmt.get(workstreamId)) return null;
  const clean = text.trim();
  if (!clean) throw new Error('text is required');
  insertEventStmt.run(workstreamId, assertActor(String(actor)), clean);
  const event = listRecentEventsStmt.all(workstreamId, 1)[0] ?? null;
  emitById(workstreamId);
  return event;
}

export function completeWorkstreamStep(id: number, note?: string | null): WorkstreamWithDetails | null {
  const existing = getByIdStmt.get(id);
  if (!existing) return null;
  const completed = note?.trim() || existing.next_action || 'Kevin marked this step done.';
  insertEventStmt.run(id, 'kevin', `Done: ${completed}`);
  clearNextActionStmt.run(id);
  flipTurn(id, 'jarvis', {
    actor: 'system',
    text: 'Kevin completed his step; turn moved back to JARVIS.',
    emit_event: false,
  });
  return emitById(id);
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text: string): string[] {
  return Array.from(new Set(normalize(text).split(' ').filter((t) => t.length > 2)));
}

function titleFromJot(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= 120) return clean;
  return `${clean.slice(0, 117).trimEnd()}...`;
}

function jotMatchScore(noteTokens: string[], candidateTokens: string[]): number {
  if (!noteTokens.length || !candidateTokens.length) return 0;
  const candidate = new Set(candidateTokens);
  const shared = noteTokens.filter((t) => candidate.has(t)).length;
  return shared / Math.max(1, noteTokens.length);
}

export function jotWorkstream(text: string): { matched: boolean; workstream: WorkstreamWithDetails } {
  const note = text.trim();
  if (!note) throw new Error('text is required');
  const normalizedNote = normalize(note);
  const noteTokens = tokens(note);
  let best: { row: WorkstreamWithDetails; score: number } | null = null;

  // `"x".includes("")` is true, so a note that normalizes to nothing (emoji /
  // punctuation only) would otherwise "match" the first open workstream.
  // Same for a candidate whose title normalizes to nothing. Such notes just
  // create a new parked workstream (deterministic, never lost).
  const SUBSTRING_MIN = 3;
  const DISTINCTIVE_MIN = 5;
  if (normalizedNote.length >= SUBSTRING_MIN || noteTokens.length > 0) {
    const candidates = listWorkstreams(false).map((row) => {
      const candidateText = [row.title, row.what ?? ''].join(' ');
      return { row, normalized: normalize(candidateText), tokens: tokens(candidateText) };
    });
    // Document frequency across open workstreams: a shared token that only ONE
    // workstream uses (e.g. "perclickity") is a strong signal even when the
    // jot is long and chatty ("making perclickity edits from what Mike gave me").
    const df = new Map<string, number>();
    for (const c of candidates) for (const t of c.tokens) df.set(t, (df.get(t) ?? 0) + 1);

    for (const c of candidates) {
      const substringHit =
        normalizedNote.length >= SUBSTRING_MIN
        && c.normalized.length >= SUBSTRING_MIN
        && (c.normalized.includes(normalizedNote) || normalizedNote.includes(c.normalized));
      const candidateSet = new Set(c.tokens);
      const distinctiveHit = noteTokens.some(
        (t) => t.length >= DISTINCTIVE_MIN && candidateSet.has(t) && df.get(t) === 1,
      );
      const score = substringHit ? 1 : Math.max(jotMatchScore(noteTokens, c.tokens), distinctiveHit ? 0.6 : 0);
      if (score >= 0.5 && (!best || score > best.score)) {
        best = { row: c.row, score };
      }
    }
  }

  if (best) {
    insertEventStmt.run(best.row.id, 'kevin', `Jot: ${note}`);
    const workstream = emitById(best.row.id);
    if (!workstream) throw new Error('Failed to load matched workstream');
    return { matched: true, workstream };
  }

  const created = createWorkstream({
    title: titleFromJot(note),
    what: note,
    turn: 'parked',
    actor: 'kevin',
    event_text: `Jot created this workstream: ${note}`,
  });
  return { matched: false, workstream: created };
}

/**
 * Compose the seed message for a workstream's dedicated discussion thread
 * (the 💬 Discuss button on /flight-deck). Plain string composition — zero
 * model calls; the receiving JARVIS turn does the thinking.
 */
export function composeWorkstreamDiscussSeed(ws: WorkstreamWithDetails): string {
  const links =
    ws.links.map((l) => `- [${l.kind}] ${l.label ?? l.ref} (${l.ref})`).join('\n') || '- (none yet)';
  const timeline =
    ws.events
      .slice(0, 8)
      .map((e) => `- ${e.created_at} · ${e.actor}: ${e.text}`)
      .join('\n') || '- (no events yet)';
  return [
    `🛩 This thread is the DISCUSSION CHANNEL for Flight Deck workstream #${ws.id} — "${ws.title}".`,
    '',
    'Current state:',
    `- What: ${ws.what ?? '(no description)'}`,
    `- Turn: ${ws.turn}${ws.next_owner ? ` (next owner: ${ws.next_owner})` : ''}`,
    `- Next action: ${ws.next_action ?? '(none set)'}`,
    '',
    'Links:',
    links,
    '',
    'Recent timeline:',
    timeline,
    '',
    `JARVIS: you own keeping this workstream TRUE on the Flight Deck via the \`workstreams\` tool (workstream_id ${ws.id}). When Kevin corrects the plan here — "not my turn yet", "we missed a step", "change the next action" — apply it immediately: flip the turn, update next_action, log the outcome to the timeline, attach new links. Confirm each change in one short line. Start by greeting Kevin with a one-paragraph read of where this ball stands and what you believe the next step is.`,
  ].join('\n');
}
