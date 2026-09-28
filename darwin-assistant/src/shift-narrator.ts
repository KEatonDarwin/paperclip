import { sqliteDb, getOrCreateConversation, addTurn, getSetting } from './conversation-db.js';
import { laymanFreeform } from './layman-summary.js';

// ---------------------------------------------------------------------------
// SHIFT NARRATOR — the play-by-play in the shift's own chat.
//
// Kevin (notepad line 264, 2026-09-27): "every time you move to the next thing
// (or make a decision that makes a difference) the main chat should be like a
// narrator. Tell me what you just did, and tell me what is coming next. Use
// terms like 'as expected, I did this' and 'it was unexpected in the planning,
// but I had to do this'. Keep everything as layman as possible … a play by play
// that virtually any tech person could understand."
//
// Mechanism: night-shift.ts's `insertNightEvent` is the ONE chokepoint every
// shift transition already passes through (item started/done/failed/blocked,
// inserts, unparks, holds, serial fallback, tail re-plans, run start/stop).
// It calls `noteShiftEvent` here. Events are buffered per run and flushed a few
// seconds after the burst settles (one tick can produce 3-6 events: an item
// finishes, a replan is inserted, the next item starts) so Kevin gets ONE
// conversational beat per change of topic, not six fragments.
//
// Each beat = deterministic facts (what happened, expected-vs-unexpected
// classification, what is running now, what is queued next) → ONE subscription
// claude CLI one-shot that writes it in JARVIS's first-person voice → posted as
// a plain assistant turn into `cockpit:shift-<id>` (addTurn emits SSE, so the
// open cockpit sees it land live). If the model call fails, a deterministic
// template beat is posted instead — the narrator is never silent.
//
// This module deliberately does NOT import night-shift.ts (it is imported BY
// it); everything it needs is read straight from night_runs / night_items /
// goals / hopper_nodes with tiny indexed SELECTs.
//
// Settings-KV knobs: night_narrator_enabled ('0' = off, default on),
// night_narrator_model (default claude-sonnet-5), night_narrator_debounce_ms
// (default 6000).
// ---------------------------------------------------------------------------

const SETTING_ENABLED = 'night_narrator_enabled';
const SETTING_MODEL = 'night_narrator_model';
const SETTING_DEBOUNCE = 'night_narrator_debounce_ms';
const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_DEBOUNCE_MS = 6_000;
const MODEL_TIMEOUT_MS = 75_000;
const MAX_BEAT_CHARS = 1_800;
const NARRATION_KIND = 'narration';
const MARK = '🎙 ';

/** Event kinds that are NOT a change of topic — the orchestrator's own log
 *  lines (already in the chat), the plan review, and our own narration. */
const SKIP_KINDS = new Set(['orchestrator_log', 'plan_review', NARRATION_KIND, 'planned']);

export type Expectation = 'expected' | 'unexpected' | 'good_news' | 'milestone' | 'neutral';

export interface ShiftBeatEvent {
  at: string;
  itemId: number | null;
  actor: string;
  kind: string;
  text: string;
  data: unknown;
  expectation: Expectation;
  itemTitle: string | null;
  itemKind: string | null;
  goalTitle: string | null;
  attempt: number | null;
  position: number | null;
}

interface RunBuffer {
  events: ShiftBeatEvent[];
  timer: NodeJS.Timeout | null;
  flushing: boolean;
  again: boolean;
}

const buffers = new Map<number, RunBuffer>();

// ---------------------------------------------------------------------------
// Reads (all tiny, all indexed by id)
// ---------------------------------------------------------------------------

interface RunLite { id: number; thread_ext: string | null; label: string | null; status: string; goal_ids: number[]; lanes: number }
interface ItemLite {
  id: number; position: number; goal_id: number; node_id: number | null; kind: string; title: string; why: string;
  status: string; lane: number | null; attempt: number; tree_id: string | null; result_summary: string | null; est_minutes: number;
}

function readRun(runId: number): RunLite | null {
  const r = sqliteDb.prepare(`SELECT id, thread_ext, label, status, goal_ids, config FROM night_runs WHERE id = ?`).get(runId) as
    { id: number; thread_ext: string | null; label: string | null; status: string; goal_ids: string | null; config: string | null } | undefined;
  if (!r) return null;
  let goalIds: number[] = [];
  let lanes = 3;
  try { goalIds = JSON.parse(r.goal_ids ?? '[]') as number[]; } catch { /* keep [] */ }
  try { lanes = Number((JSON.parse(r.config ?? '{}') as { lanes?: number }).lanes ?? 3); } catch { /* keep 3 */ }
  return { id: r.id, thread_ext: r.thread_ext, label: r.label, status: r.status, goal_ids: goalIds, lanes };
}

function readItem(itemId: number): ItemLite | null {
  return (sqliteDb.prepare(
    `SELECT id, position, goal_id, node_id, kind, title, why, status, lane, attempt, tree_id, result_summary, est_minutes FROM night_items WHERE id = ?`,
  ).get(itemId) as ItemLite | undefined) ?? null;
}

function readItems(runId: number): ItemLite[] {
  return sqliteDb.prepare(
    `SELECT id, position, goal_id, node_id, kind, title, why, status, lane, attempt, tree_id, result_summary, est_minutes FROM night_items WHERE run_id = ? ORDER BY position ASC`,
  ).all(runId) as ItemLite[];
}

const goalTitleCache = new Map<number, string>();
function goalTitle(goalId: number): string {
  const hit = goalTitleCache.get(goalId);
  if (hit) return hit;
  const r = sqliteDb.prepare(`SELECT title FROM goals WHERE id = ?`).get(goalId) as { title: string } | undefined;
  const t = r?.title ?? `goal #${goalId}`;
  goalTitleCache.set(goalId, t);
  return t;
}

function treeProgress(treeId: string | null): { done: number; total: number; running: string | null } | null {
  if (!treeId) return null;
  const rows = sqliteDb.prepare(`SELECT title, status FROM hopper_nodes WHERE tree_id = ?`).all(treeId) as Array<{ title: string; status: string }>;
  if (!rows.length) return null;
  const done = rows.filter((r) => r.status === 'done').length;
  const running = rows.find((r) => r.status === 'running')?.title ?? null;
  return { done, total: rows.length, running };
}

function ctTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
}

// ---------------------------------------------------------------------------
// Classification — the "as expected" vs "wasn't in the plan" call is made HERE,
// deterministically, so the model only has to phrase it, never judge it.
// ---------------------------------------------------------------------------

export function classifyShiftEvent(kind: string, text: string, data: unknown, item: ItemLite | null): Expectation {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  switch (kind) {
    case 'item_started':
      if (d.second_ask === true) return 'unexpected';            // had to re-ask the orchestrator
      if (item && item.attempt > 1) return 'unexpected';          // a retry, not the original plan
      if (item?.kind === 'unblock' || item?.kind === 'replant') return 'unexpected';
      return 'expected';
    case 'item_done':
      if (/VERDICT:\s*FAIL/i.test(text) || /never planted/i.test(text)) return 'unexpected';
      return 'expected';
    case 'item_failed':
    case 'item_blocked':
      return 'unexpected';
    case 'item_skipped':
      return 'neutral';
    case 'item_inserted':
      return 'unexpected';                                        // replan / unblock / replant = not in the original list
    case 'item_unparked':
    case 'hold_clear':
      return 'good_news';
    case 'hold':
    case 'serial_fallback':
    case 'replanned_tail':
      return 'unexpected';
    case 'run_started':
    case 'run_stopped':
    case 'run_complete':
    case 'run_paused':
    case 'run_resumed':
      return 'milestone';
    default:
      return 'neutral';
  }
}

// ---------------------------------------------------------------------------
// Entry point — called by night-shift.ts's insertNightEvent
// ---------------------------------------------------------------------------

function enabled(): boolean {
  return (getSetting(SETTING_ENABLED) ?? '1').trim() !== '0';
}

function debounceMs(): number {
  const n = Number(getSetting(SETTING_DEBOUNCE) ?? DEFAULT_DEBOUNCE_MS);
  return Number.isFinite(n) && n >= 500 && n <= 120_000 ? n : DEFAULT_DEBOUNCE_MS;
}

/** Buffer one shift event for narration. Never throws. */
export function noteShiftEvent(runId: number, itemId: number | null, actor: string, kind: string, text: string | null | undefined, data?: unknown): void {
  try {
    if (SKIP_KINDS.has(kind)) return;
    if (!enabled()) return;
    const item = itemId != null ? readItem(itemId) : null;
    const ev: ShiftBeatEvent = {
      at: new Date().toISOString(),
      itemId, actor, kind,
      text: (text ?? '').slice(0, 600),
      data: data ?? null,
      expectation: classifyShiftEvent(kind, text ?? '', data, item),
      itemTitle: item?.title ?? null,
      itemKind: item?.kind ?? null,
      goalTitle: item ? goalTitle(item.goal_id) : null,
      attempt: item?.attempt ?? null,
      position: item?.position ?? null,
    };
    let buf = buffers.get(runId);
    if (!buf) { buf = { events: [], timer: null, flushing: false, again: false }; buffers.set(runId, buf); }
    buf.events.push(ev);
    scheduleFlush(runId, buf);
  } catch (err) {
    console.error('[shift-narrator] noteShiftEvent failed', err);
  }
}

function scheduleFlush(runId: number, buf: RunBuffer): void {
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    buf.timer = null;
    void flush(runId);
  }, debounceMs());
  buf.timer.unref?.();
}

/** Flush now (used by the stop path so the wrap beat lands before the report). */
export async function flushShiftNarration(runId: number): Promise<void> {
  const buf = buffers.get(runId);
  if (!buf) return;
  if (buf.timer) { clearTimeout(buf.timer); buf.timer = null; }
  await flush(runId);
}

async function flush(runId: number): Promise<void> {
  const buf = buffers.get(runId);
  if (!buf) return;
  if (buf.flushing) { buf.again = true; return; }
  if (!buf.events.length) return;
  buf.flushing = true;
  const events = buf.events.splice(0, buf.events.length);
  try {
    await narrateBeat(runId, events);
  } catch (err) {
    console.error('[shift-narrator] beat failed', err);
  } finally {
    buf.flushing = false;
    if (buf.again || buf.events.length) { buf.again = false; scheduleFlush(runId, buf); }
  }
}

// ---------------------------------------------------------------------------
// The beat: facts → voice → post
// ---------------------------------------------------------------------------

const EXPECTATION_LABEL: Record<Expectation, string> = {
  expected: 'AS EXPECTED (this was the plan)',
  unexpected: 'NOT IN THE PLAN (had to adapt)',
  good_news: 'GOOD NEWS (something cleared)',
  milestone: 'MILESTONE',
  neutral: 'NEUTRAL',
};

function factLine(ev: ShiftBeatEvent): string {
  const who = ev.itemTitle ? `"${ev.itemTitle}" (${ev.itemKind ?? '?'} step${ev.attempt && ev.attempt > 1 ? `, attempt ${ev.attempt}` : ''}) for goal "${ev.goalTitle}"` : '(run-level)';
  return `- ${ctTime(ev.at)} CT · ${ev.kind} · ${EXPECTATION_LABEL[ev.expectation]} · ${who} · detail: ${ev.text || '—'}`;
}

function nowBlock(run: RunLite): string {
  const items = readItems(run.id);
  const running = items.filter((i) => i.status === 'running');
  const queued = items.filter((i) => i.status === 'queued').slice(0, 3);
  const doneN = items.filter((i) => i.status === 'done').length;
  const failedN = items.filter((i) => i.status === 'failed' || i.status === 'blocked').length;
  const lines: string[] = [];
  lines.push(`Scoreboard: ${doneN} done · ${failedN} failed/blocked · ${items.filter((i) => i.status === 'queued').length} still queued · ${running.length}/${run.lanes} lanes busy.`);
  if (running.length) {
    lines.push('Running right now:');
    for (const r of running) {
      const p = treeProgress(r.tree_id);
      lines.push(`- lane ${r.lane ?? '?'}: "${r.title}" (${r.kind}${r.attempt > 1 ? `, attempt ${r.attempt}` : ''}) for goal "${goalTitle(r.goal_id)}"${p ? ` — ${p.done}/${p.total} sub-tasks done${p.running ? `, currently: ${p.running}` : ''}` : ''}`);
    }
  } else {
    lines.push('Running right now: nothing.');
  }
  if (queued.length) {
    lines.push('Up next (in order):');
    for (const q of queued) lines.push(`- "${q.title}" (${q.kind}) for goal "${goalTitle(q.goal_id)}" — why it is queued: ${q.why || '—'}`);
  } else {
    lines.push('Up next: the list is empty — the planner will look for more.');
  }
  return lines.join('\n');
}

function buildPrompt(run: RunLite, events: ShiftBeatEvent[]): string {
  return `You are JARVIS, Kevin's chief of staff, narrating an overnight autonomous work session ("shift #${run.id}${run.label ? ` — ${run.label}` : ''}") live in its chat. Kevin is probably asleep and will read this in the morning as a play-by-play.

Write the next beat of the play-by-play: what just happened, whether it matched the plan, why we are moving to what we are moving to, and what comes next. Speak in first person, past tense for what happened, like you are telling a smart friend who knows tech in general but nothing about the specifics.

HARD RULES:
- Use the expectation labels below literally in spirit: for AS EXPECTED say things like "As expected, ..."; for NOT IN THE PLAN say things like "This wasn't in the original plan, but ..." or "Unexpectedly, ..."; for GOOD NEWS say so.
- Explain WHY we went to each thing in plain words (the "why it is queued" notes give you the reason — translate them, never paste them).
- 3 to 7 sentences, one short paragraph, conversational. Plain text only: no markdown, no bullets, no headers, no emoji.
- No file paths, no branch names, no function or table names, no SQL, no id numbers (no "#123", no "tree-abc"), no model names, no lane numbers. Goal names and task titles are fine — simplify them if they are jargon.
- Do not invent facts, causes, or outcomes that are not in the facts below. If a detail is missing, leave it out.
- Do not greet, do not sign off, do not ask questions.

WHAT JUST HAPPENED (newest last):
${events.map(factLine).join('\n')}

WHERE THINGS STAND NOW:
${nowBlock(run)}`;
}

/** Deterministic fallback — used when the model call fails so the chat is
 *  never silent on a topic change. Plain, honest, a little stiff. */
function fallbackBeat(run: RunLite, events: ShiftBeatEvent[]): string {
  const parts: string[] = [];
  for (const ev of events) {
    const what = ev.itemTitle ? `"${ev.itemTitle}"` : 'the run';
    switch (ev.kind) {
      case 'item_started': parts.push(`${ev.expectation === 'expected' ? 'As planned' : 'Off-plan'}, I started ${what}${ev.goalTitle ? ` for ${ev.goalTitle}` : ''}.`); break;
      case 'item_done': parts.push(`${ev.expectation === 'expected' ? 'As expected' : 'Not quite as planned'}, ${what} finished: ${ev.text.split(' — ').slice(-1)[0]}.`); break;
      case 'item_failed': parts.push(`Unexpectedly, ${what} failed: ${ev.text.split(' — ').slice(-1)[0]}.`); break;
      case 'item_blocked': parts.push(`Unexpectedly, ${what} got blocked: ${ev.text.split(' — ').slice(-1)[0]}.`); break;
      case 'item_inserted': parts.push(`This wasn't in the original plan, but I added a follow-up step: ${what}.`); break;
      case 'item_unparked': parts.push(`Good news: ${what} is unstuck and back in the queue.`); break;
      case 'hold': parts.push(`I had to pause new work: ${ev.text}.`); break;
      case 'hold_clear': parts.push('Good news: the pause lifted and work is flowing again.'); break;
      case 'serial_fallback': parts.push(`Nothing else could run in parallel, so I pushed ${what} through on its own rather than sit idle.`); break;
      case 'replanned_tail': parts.push('The list ran dry, so I asked the planner for more and kept going.'); break;
      case 'run_started': parts.push('The shift is underway.'); break;
      case 'run_stopped': case 'run_complete': parts.push(`The shift ended: ${ev.text}.`); break;
      default: parts.push(`${ev.kind.replace(/_/g, ' ')}: ${ev.text}.`);
    }
  }
  const items = readItems(run.id);
  const next = items.find((i) => i.status === 'queued');
  if (next) parts.push(`Next up is "${next.title}" for ${goalTitle(next.goal_id)}.`);
  return parts.join(' ').slice(0, MAX_BEAT_CHARS);
}

async function narrateBeat(runId: number, events: ShiftBeatEvent[]): Promise<void> {
  const run = readRun(runId);
  if (!run) return;
  const model = (getSetting(SETTING_MODEL) ?? '').trim() || DEFAULT_MODEL;
  let text = await laymanFreeform({
    prompt: buildPrompt(run, events),
    model,
    timeoutMs: MODEL_TIMEOUT_MS,
    maxChars: MAX_BEAT_CHARS,
    where: 'shift-narrator',
  });
  let source: 'model' | 'fallback' = 'model';
  if (!text) { text = fallbackBeat(run, events); source = 'fallback'; }
  if (!text.trim()) return;

  const ext = run.thread_ext ?? 'cockpit:night-shift';
  const conv = getOrCreateConversation(ext);
  addTurn(conv.id, 'assistant', `${MARK}${text.trim()}`);
  // Recorded as a night event too (kind 'narration' — SKIP_KINDS keeps us from
  // narrating our own narration) so the morning report can replay the beats.
  sqliteDb.prepare(`INSERT INTO night_events (run_id, item_id, actor, kind, text, data) VALUES (?,?,?,?,?,?)`)
    .run(runId, events.length === 1 ? events[0].itemId : null, 'jarvis', NARRATION_KIND, text.trim(),
      JSON.stringify({ source, model: source === 'model' ? model : null, kinds: events.map((e) => e.kind), expectations: events.map((e) => e.expectation) }));
}

/** The beats for one run, oldest first — the report's "Play-by-play" section. */
export function listShiftNarration(runId: number): Array<{ at: string; text: string }> {
  const rows = sqliteDb.prepare(`SELECT created_at, text FROM night_events WHERE run_id = ? AND kind = ? ORDER BY id ASC`)
    .all(runId, NARRATION_KIND) as Array<{ created_at: string; text: string | null }>;
  return rows.filter((r) => r.text).map((r) => ({ at: r.created_at, text: r.text as string }));
}

/** Test seam — the exact prompt a beat would send, for prose checks on a DB copy. */
export function __buildBeatPrompt(runId: number, events: ShiftBeatEvent[]): string | null {
  const run = readRun(runId);
  return run ? buildPrompt(run, events) : null;
}
export function __fallbackBeat(runId: number, events: ShiftBeatEvent[]): string | null {
  const run = readRun(runId);
  return run ? fallbackBeat(run, events) : null;
}

/** Test seam. */
export function __resetShiftNarrator(): void {
  for (const b of buffers.values()) if (b.timer) clearTimeout(b.timer);
  buffers.clear();
  goalTitleCache.clear();
}
