import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  sqliteDb,
  getConversation,
  getSetting,
  setSetting,
  addTurn,
} from './conversation-db.js';
import { isConversationActive } from './agent.js';
import { findClaudeAccount } from './claude-accounts.js';
import { isScratchEnv } from './sim-guard.js';

// ── Talk-seat daily rollover (goal #19, PLAN outbox/talk-daily-rollover) ──────
//
// The Talk seat (cockpit:alpha-talk) runs on a native --resume CLI session, so
// every step re-reads the whole session. With claude_autocompact_tokens=0 that
// session grows toward the full window — recent steps were replaying 1.3M–2.3M
// cached tokens EACH. The fix keeps it ONE chat but gives it a fresh head every
// morning: at ~04:00 CT (or mid-day if the session passes ~400k before then) a
// B-account one-shot distils the day's turns into a day card, posts a visible
// divider, and clears the session pointer so the next message starts fresh — and
// the persona digest seeds the fresh head with the recent cards.
//
// Everything here is plain SQLite + one model one-shot. The session pointer is
// only ever CLEARED, never a transcript row deleted (PLAN rule). The whole thing
// is gated OFF by default behind settings-KV `talk_daily_rollover`.

// ── config ───────────────────────────────────────────────────────────────────

/** A seat the rollover manages. The live one is alpha-talk; tests add their own
 *  isolated target so the proof never touches the real seat's days folder. */
export interface RolloverTarget {
  externalId: string;
  /** Absolute dir the day cards are written into (one .md per rollover). */
  daysDir: string;
}

const VAULT = '/home/kevin/obsidian/paperclip-wiki';

/** The live seat. A test passes its own target into the functions below instead
 *  of ever reading this list, so a forced proof-run can never write a card into
 *  the real seat's days folder. */
export const LIVE_TARGETS: RolloverTarget[] = [
  {
    externalId: 'cockpit:alpha-talk',
    daysDir: path.join(VAULT, 'agent-memory/jarvis-alpha-talk/days'),
  },
];

/** Kill switch — settings-KV `talk_daily_rollover`. Anything other than the
 *  literal string 'on' (including absent) means OFF. Default OFF until Kevin
 *  flips it after the proof. */
export const KILL_SWITCH_KEY = 'talk_daily_rollover';
export function rolloverEnabled(): boolean {
  return (getSetting(KILL_SWITCH_KEY) ?? 'off').trim().toLowerCase() === 'on';
}

/** Mid-day safety net: roll when the live session's replayed context passes this
 *  many tokens. Overridable via settings-KV for tuning without a redeploy. */
const DEFAULT_MIDDAY_TOKEN_CAP = 400_000;
export function middayTokenCap(): number {
  const raw = getSetting('talk_rollover_midday_token_cap');
  const n = raw != null && raw.trim() !== '' ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MIDDAY_TOKEN_CAP;
}

/** Chronological sort key for a card filename. `YYYY-MM-DD.md` is part 1 of its
 *  date; `YYYY-MM-DD-partN.md` is part N. A plain lexical sort gets this wrong
 *  twice over ('-' < '.' puts the bare date AFTER its parts, and 'part10' <
 *  'part2'), which would pick the wrong "last card". Returns [date, part]. */
export function cardSortKey(filename: string): [string, number] {
  const m = /^(\d{4}-\d{2}-\d{2})(?:-part(\d+))?\.md$/.exec(filename);
  if (!m) return [filename, 0];
  return [m[1], m[2] ? parseInt(m[2], 10) : 1];
}
export function sortCardFiles(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const [da, pa] = cardSortKey(a);
    const [db, pb] = cardSortKey(b);
    return da === db ? pa - pb : da < db ? -1 : 1;
  });
}

/** In-process lock so the 04:00 run, its idle retries, the mid-day tick, and a
 *  manual call can never summarize the same seat concurrently (they share one
 *  event loop; the writer is awaited, so two entrants could both pass the
 *  marker check before either advances it). */
const rolling = new Set<string>();

const WRITER_MODEL = 'claude-haiku-4-5-20251001';
const WRITER_TIMEOUT_MS = 90_000;
/** Cap the day's conversation text handed to the writer. The seat's own turns
 *  are already summaries-of-work, so this is generous. */
const MAX_PROMPT_CHARS = 120_000;
/** Per-turn cap so one pathologically huge turn can't blow the whole budget (or
 *  the model's context) on its own. */
const MAX_TURN_CHARS = 24_000;

// settings keys that track per-seat rollover state (keyed by external_id)
const lastIdxKey = (ext: string) => `talk_rollover_last_idx:${ext}`;
const lastAtKey = (ext: string) => `talk_rollover_last_at:${ext}`;

// ── token measurement ─────────────────────────────────────────────────────────

const latestAssistantTokensStmt = sqliteDb.prepare<[number], {
  turn_index: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
}>(
  `SELECT turn_index, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
   FROM turns
   WHERE conversation_id = ? AND role = 'assistant'
     AND (input_tokens IS NOT NULL OR cache_read_tokens IS NOT NULL)
   ORDER BY turn_index DESC LIMIT 1`,
);

export interface SessionTokens {
  turnIndex: number | null;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** The number that matters for "how big is this session per step" — what the
   *  native --resume replays each turn. */
  replayed: number;
}

/** The replayed-context size of the most recent assistant step. Zero when the
 *  conversation has no token-bearing assistant turn yet.
 *
 *  This is a HEURISTIC backstop for the mid-day net, not a precise session-token
 *  accounting: the turns table stores per-turn usage, not per-model-call, and
 *  doesn't tag which session a turn belonged to. So right after a clear the last
 *  (stale) assistant turn can still read big — but the marker guard in
 *  runTalkRollover ("no new turns since last rollover") makes that a harmless
 *  no-op, never a double-roll. Firing the net a little early or late only shifts
 *  WHEN a fresh head is cut, which is exactly what the net is for. */
export function measureSessionTokens(conversationId: number): SessionTokens {
  const r = latestAssistantTokensStmt.get(conversationId);
  if (!r) return { turnIndex: null, input: 0, cacheRead: 0, cacheWrite: 0, replayed: 0 };
  const input = r.input_tokens ?? 0;
  const cacheRead = r.cache_read_tokens ?? 0;
  const cacheWrite = r.cache_write_tokens ?? 0;
  return { turnIndex: r.turn_index, input, cacheRead, cacheWrite, replayed: input + cacheRead + cacheWrite };
}

// ── the day's turns ────────────────────────────────────────────────────────────

const contentTurnsSinceStmt = sqliteDb.prepare<[number, number], {
  turn_index: number;
  role: string;
  content: string | null;
  created_at: string;
}>(
  // user + assistant text only — tool_call/tool_result/bump never reach the card.
  // Deliberately NOT getTurnsLean: we don't need the debug blobs and must not
  // pull them into the heap on a 400-turn thread (the 2026-09-25 OOM lesson).
  `SELECT turn_index, role, content, created_at
   FROM turns
   WHERE conversation_id = ? AND turn_index > ?
     AND role IN ('user', 'assistant')
     AND content IS NOT NULL AND content <> ''
   ORDER BY turn_index ASC`,
);

export interface DayTurn {
  turnIndex: number;
  role: string;
  content: string;
  createdAt: string;
}

/** Content turns added since the last rollover for this seat. */
export function gatherTurnsSince(conversationId: number, sinceIdx: number): DayTurn[] {
  return contentTurnsSinceStmt.all(conversationId, sinceIdx).map((r) => ({
    turnIndex: r.turn_index,
    role: r.role,
    content: r.content ?? '',
    createdAt: r.created_at,
  }));
}

// ── day-card prompt + one-shot ──────────────────────────────────────────────────

/** The date a card is filed under = the LOCAL date of the newest turn in the
 *  window (the day the work happened), so a 04:00 Monday run that closes Sunday's
 *  session files the card as Sunday. Falls back to `now` when the window is
 *  empty (shouldn't happen — we skip empty windows). */
export function cardDateFor(turns: DayTurn[], now: Date): string {
  const last = turns.length ? turns[turns.length - 1].createdAt : null;
  const d = last ? new Date(last.replace(' ', 'T') + 'Z') : now;
  // turns.created_at is stored as UTC 'YYYY-MM-DD HH:MM:SS'; render in CT so the
  // filename matches the day Kevin lived.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

export function humanDayLabel(dateIso: string): string {
  // dateIso is 'YYYY-MM-DD' (already CT). Render "Sunday, Oct 25".
  const d = new Date(dateIso + 'T12:00:00Z');
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric',
  }).format(d);
}

export function buildDayCardPrompt(label: string, turns: DayTurn[]): string {
  // Build from the NEWEST turn backward so that, if the day is huge, we keep the
  // most recent context (where we left off / what's still open) rather than the
  // oldest. The whole window is still marked rolled — the card is a lossy summary
  // either way — so keeping the tail is the right loss.
  const parts: string[] = [];
  let size = 0;
  let trimmed = false;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const who = t.role === 'user' ? 'Kevin' : 'JARVIS';
    // Cap a single turn so one giant message can't exhaust the budget / the
    // model's context by itself.
    const content = t.content.length > MAX_TURN_CHARS
      ? t.content.slice(0, MAX_TURN_CHARS) + '\n…(long turn trimmed)…'
      : t.content;
    const block = `\n### ${who} (${t.createdAt})\n${content}\n`;
    if (size + block.length > MAX_PROMPT_CHARS && parts.length > 0) { trimmed = true; break; }
    parts.push(block);
    size += block.length;
  }
  parts.reverse();
  let transcript = (trimmed ? '\n…(earlier turns trimmed — oldest dropped)…\n' : '') + parts.join('');
  return `You are closing out one working day in Kevin's front-seat chat with JARVIS, so a fresh JARVIS head tomorrow can pick up exactly where this one left off WITHOUT re-reading the whole day.

Write a "day card" in Markdown for ${label}. Use exactly these sections, each a "## " heading, omitting a section only if it is genuinely empty:

## Done
## Changed (with paths / links)
## Created (with paths / links)
## Decided
## Still open
## Lanes in flight

Under "Lanes in flight", list any spawned chats, trees, goals, or background jobs that are still running or owe something, with the thread id / goal id and what each owes.

Rules:
- Be concrete and specific — names, ids, paths, numbers. This card REPLACES the transcript for tomorrow's head, so anything omitted is forgotten.
- Capture EVERY specific fact stated — names, ids, file paths, branch names, dollar amounts, dates, metrics — even if mentioned only once in passing. A number said once still belongs on the card.
- Keep it tight: facts, not prose. Bullets under each heading.
- Do not invent anything not in the conversation below.
- Output ONLY the Markdown card, starting with "## Done". No preamble, no code fence.

Conversation for ${label}:
"""${transcript}
"""`;
}

/** The B-account claude one-shot that distils the day's turns into a card.
 *  Subscription binary only, NEVER an API key. Resolves the card markdown, or
 *  throws (caller fail-closes on a throw). */
export function runDayCardOneShot(prompt: string, model = WRITER_MODEL, timeoutMs = WRITER_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    // Automation runs on Claude B (binding rule). Pin the config dir explicitly
    // so the one-shot never silently spends account A, whatever jarvis.service's
    // own CLAUDE_CONFIG_DIR is.
    const accountB = findClaudeAccount('b');
    env.CLAUDE_CONFIG_DIR = accountB?.config_dir ?? '/home/kevin/.claude-b';

    const child = spawn(
      process.env.CLAUDE_CLI_PATH || 'claude',
      ['--print', '-', '--output-format', 'stream-json', '--verbose', '--model', model],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`talk-rollover writer timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref?.();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`talk-rollover writer exited ${code}: ${stderr.trim().slice(0, 300)}`));
        return;
      }
      let text = '';
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          const message = event.message as Record<string, unknown> | undefined;
          const content = message?.content;
          if (event.type === 'assistant' && Array.isArray(content)) {
            for (const block of content as Array<Record<string, unknown>>) {
              if (block.type === 'text' && typeof block.text === 'string') text += block.text;
            }
          }
          if (event.type === 'result' && typeof event.result === 'string') text = event.result;
        } catch {
          text += trimmed;
        }
      }
      resolve(text.trim());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

// ── writing the card, divider, and session clear ───────────────────────────────

/** Pick the card filename. The first roll for a date is `YYYY-MM-DD.md`; a later
 *  roll the same date (the mid-day safety net) becomes `YYYY-MM-DD-part2.md`,
 *  `-part3`, … so no card is ever overwritten. Returns the absolute path and the
 *  1-based part number. */
export function pickCardPath(daysDir: string, dateIso: string): { file: string; part: number } {
  const base = path.join(daysDir, `${dateIso}.md`);
  if (!existsSync(base)) return { file: base, part: 1 };
  let part = 2;
  for (;;) {
    const p = path.join(daysDir, `${dateIso}-part${part}.md`);
    if (!existsSync(p)) return { file: p, part };
    part += 1;
  }
}

const clearSessionStmt = sqliteDb.prepare<[number]>(
  // Same effect as setThreadMcpConnectors (conversation-db.ts:348): drop the
  // native --resume pointer so the next message starts a fresh CLI session.
  // NEVER touches the turns table.
  `UPDATE conversations
   SET claude_session_id = NULL, session_adapter = NULL, session_account = NULL,
       updated_at = datetime('now')
   WHERE id = ?`,
);

/** Clear the session pointer AND advance the two markers in one transaction, so
 *  a crash between them can't leave a window half-rolled. */
const commitRollover = sqliteDb.transaction(
  (convId: number, idxKey: string, idxVal: string, atKey: string, atVal: string) => {
    clearSessionStmt.run(convId);
    setSetting(idxKey, idxVal);
    setSetting(atKey, atVal);
  },
);

export interface RolloverResult {
  ran: boolean;
  reason: string;           // why it ran or was skipped
  externalId: string;
  cardFile?: string;
  part?: number;
  label?: string;
  turnsRolled?: number;
  lastIdx?: number;
  tokensBefore?: SessionTokens;
}

export interface RolloverOpts {
  target: RolloverTarget;
  now?: Date;
  /** test seam — inject a fake writer. Defaults to the real B one-shot. */
  runOneShot?: (prompt: string) => Promise<string>;
  /** test seam — override the in-flight check. Defaults to isConversationActive. */
  isActive?: (conversationId: number) => boolean;
  /** 'morning' (04:00) or 'midday' (safety net). Affects the reason string only. */
  trigger?: 'morning' | 'midday' | 'manual';
  /** skip the kill-switch gate (proof-run only — the default honors it). */
  bypassKillSwitch?: boolean;
}

/**
 * Run ONE rollover cycle for one seat. Order is fail-closed on purpose:
 *   1. gather the day's turns   (nothing new → skip, leave session alone)
 *   2. write the day card FILE
 *   3. post the visible divider (bump role — not a user turn, never wakes the seat)
 *   4. ONLY THEN clear the session pointer + advance the marker
 * If 2 or 3 throw, 4 never runs, so we never lose the thread with no card to show
 * for it. Returns a structured result; never throws for a skip.
 */
export async function runTalkRollover(opts: RolloverOpts): Promise<RolloverResult> {
  const { target } = opts;
  const now = opts.now ?? new Date();
  const ext = target.externalId;
  const base: RolloverResult = { ran: false, reason: '', externalId: ext };

  if (!opts.bypassKillSwitch && !rolloverEnabled()) {
    return { ...base, reason: 'kill switch off' };
  }

  const conv = getConversation(ext);
  if (!conv) return { ...base, reason: 'conversation not found' };

  const isActive = opts.isActive ?? isConversationActive;
  if (isActive(conv.id)) return { ...base, reason: 'a turn is in flight — retry later' };

  // Concurrency lock: the morning run, its retries, the mid-day tick, and a
  // manual call share one event loop and all await the writer, so without this
  // two of them could both pass the marker check and double-roll.
  if (rolling.has(ext)) return { ...base, reason: 'a rollover is already running for this seat' };
  rolling.add(ext);
  try {
    const lastIdxRaw = getSetting(lastIdxKey(ext));
    const lastIdx = lastIdxRaw != null && lastIdxRaw.trim() !== '' ? parseInt(lastIdxRaw, 10) : -1;
    const sinceIdx = Number.isFinite(lastIdx) ? lastIdx : -1;

    const turns = gatherTurnsSince(conv.id, sinceIdx);
    if (turns.length === 0) {
      return { ...base, reason: 'no new turns since last rollover — nothing to card' };
    }
    // The marker only ever advances to the END OF THE WINDOW WE GATHERED — never
    // a fresh MAX(turn_index). Any turn that lands while the writer runs is left
    // for the next rollover instead of being silently swallowed by the marker.
    const windowEndIdx = turns[turns.length - 1].turnIndex;

    const tokensBefore = measureSessionTokens(conv.id);
    const dateIso = cardDateFor(turns, now);
    const label = humanDayLabel(dateIso);

    // build + run the writer
    const prompt = buildDayCardPrompt(label, turns);
    const runOneShot = opts.runOneShot ?? ((p: string) => {
      if (isScratchEnv()) {
        return Promise.reject(new Error('[talk-rollover] refused real one-shot in scratch env'));
      }
      return runDayCardOneShot(p);
    });

    let cardBody = '';
    try {
      cardBody = (await runOneShot(prompt)).trim();
    } catch (err) {
      return { ...base, reason: `writer failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!cardBody) return { ...base, reason: 'writer returned empty card' };
    // A card must look like a card. The stream-json parser falls back to raw
    // text on a non-JSON line, so a CLI error string could otherwise masquerade
    // as a card and authorize a session clear — reject anything without a
    // '## ' section heading (fail-closed, nothing mutated).
    if (!/^##\s/m.test(cardBody)) {
      return { ...base, reason: 'writer output is not a valid card (no ## heading) — not rolling' };
    }

    // RE-CHECK right before mutating state: a turn may have started during the
    // writer run, or Kevin may have flipped the switch off. Either way, abort
    // WITHOUT writing the card or clearing the session — the next idle rollover
    // picks the window up cleanly.
    if (!opts.bypassKillSwitch && !rolloverEnabled()) {
      return { ...base, reason: 'kill switch flipped off mid-roll — aborted before any change' };
    }
    if (isActive(conv.id)) {
      return { ...base, reason: 'a turn started mid-roll — aborted before any change' };
    }
    // A turn may have started AND FINISHED during the writer (idle again now).
    // It left content turns the card doesn't cover; clearing the session now
    // would drop them from the fresh head until the next roll. Abort instead —
    // the next idle roll summarizes the whole thing.
    if (gatherTurnsSince(conv.id, windowEndIdx).length > 0) {
      return { ...base, reason: 'new turns arrived mid-roll — aborted before any change' };
    }

    const { file, part } = pickCardPath(target.daysDir, dateIso);
    const partSuffix = part > 1 ? ` (part ${part})` : '';
    const frontMatter =
      `<!-- talk day card | seat=${ext} | date=${dateIso}${partSuffix} | turns=${turns.length} ` +
      `| idx=${turns[0].turnIndex}..${windowEndIdx} ` +
      `| replayed_tokens_before=${tokensBefore.replayed} | generated=${now.toISOString()} -->\n`;
    const header = `# 📅 ${label}${partSuffix}\n\n`;
    try {
      mkdirSync(target.daysDir, { recursive: true });
      writeFileSync(file, frontMatter + header + cardBody + '\n', 'utf8');
    } catch (err) {
      return { ...base, reason: `card write failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    // visible divider — bump role: non-user, never wakes the seat, not counted
    // as a transcript message. First body line becomes the preview.
    const firstLine = cardBody.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) ?? '';
    const dividerContent = `📅 ${label}${partSuffix} — fresh session. Yesterday's card saved.`;
    try {
      addTurn(
        conv.id,
        'bump',
        dividerContent,
        undefined,
        JSON.stringify({
          kind: 'talk_rollover',
          date: dateIso,
          part,
          card_path: file,
          turns: turns.length,
          preview: firstLine.slice(0, 160),
          trigger: opts.trigger ?? 'manual',
          replayed_tokens_before: tokensBefore.replayed,
        }),
      );
    } catch (err) {
      // The card is on disk; without the divider the seat still rolls, but surface
      // the failure rather than clearing the session as if all was well.
      return {
        ...base,
        reason: `divider post failed (card written): ${err instanceof Error ? err.message : String(err)}`,
        cardFile: file,
        part,
      };
    }

    // clear the session pointer + advance the marker, atomically so a crash
    // between them can't leave the window half-committed. Done LAST so any
    // failure above never strands the seat with a wiped session and no card.
    commitRollover(conv.id, lastIdxKey(ext), String(windowEndIdx), lastAtKey(ext), now.toISOString());

    return {
      ran: true,
      reason: `rolled ${turns.length} turn(s) → ${path.basename(file)}`,
      externalId: ext,
      cardFile: file,
      part,
      label,
      turnsRolled: turns.length,
      lastIdx: windowEndIdx,
      tokensBefore,
    };
  } finally {
    rolling.delete(ext);
  }
}

// ── digest seed section (deliverable #4 lives in digest.py; this is the TS twin
//    used only to prove the seed content in the hermetic check) ────────────────

export interface SeedSectionInput {
  daysDir: string;
  /** open items — one line each (the fresh head's to-do carryover). */
  openItems: string[];
  recentCount?: number; // default 3
  maxChars?: number;    // default 20000
  now?: Date;
}

/** Build the digest seed section the fresh head sees: today's open items + the
 *  last N day cards in full + a one-line index of older cards. Bounded so the
 *  whole digest stays under the persona's 30k cap. This is the reference the
 *  Python digest.py mirrors; the hermetic check asserts they agree in shape. */
export function buildSeedSection(input: SeedSectionInput): string {
  const recentCount = input.recentCount ?? 3;
  const maxChars = input.maxChars ?? 20_000;
  const lines: string[] = [];
  lines.push('## Talk seat — carried forward');
  lines.push('');
  if (input.openItems.length) {
    lines.push('### Open items');
    for (const it of input.openItems) lines.push(`- ${it}`);
    lines.push('');
  }

  let cards: string[] = [];
  try {
    cards = existsSync(input.daysDir)
      ? sortCardFiles(readdirSync(input.daysDir).filter((f) => /\.md$/.test(f)))
      : [];
  } catch {
    cards = [];
  }
  const recent = cards.slice(-recentCount);
  const older = cards.slice(0, Math.max(0, cards.length - recentCount));

  lines.push(`### Recent day cards (last ${recent.length})`);
  for (const f of recent) {
    let body = '';
    try {
      body = readFileSync(path.join(input.daysDir, f), 'utf8');
    } catch {
      body = '_(unreadable)_';
    }
    lines.push(`<day-card file="${f}">`);
    lines.push(body.trim());
    lines.push('</day-card>');
    lines.push('');
  }
  if (older.length) {
    lines.push(`### Older cards (${older.length}, read on demand)`);
    lines.push(older.map((f) => f.replace(/\.md$/, '')).join(', '));
    lines.push('');
  }

  let out = lines.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n_(seed truncated)_\n';
  return out;
}

// ── the worker ──────────────────────────────────────────────────────────────────

function nowCT(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
}

/** ms until the next HH:00 CT (default 04:00). Same offset trick as the existing
 *  8am briefing scheduler in index.ts (reused deliberately rather than inventing
 *  a divergent TZ calc). Known shared limitation: at the two DST transitions a
 *  year it can be ±1h off — harmless for a "roughly 04:00" housekeeping job, and
 *  the idle-retry loop absorbs it. */
export function msUntilNextCT(hour: number, from: Date = new Date()): number {
  const now = from;
  const target = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  target.setHours(hour, 0, 0, 0);
  if (target.getTime() <= new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' })).getTime()) {
    target.setDate(target.getDate() + 1);
  }
  const cstNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const offset = now.getTime() - cstNow.getTime();
  return target.getTime() + offset - now.getTime();
}

const MORNING_HOUR = 4;
const MORNING_RETRY_MS = 10 * 60 * 1000; // retry every 10 min while a turn runs
const MORNING_MAX_RETRIES = 8;           // ~80 min of retries, then give up for today
const MIDDAY_TICK_MS = 15 * 60 * 1000;   // how often the safety net checks

let morningTimer: NodeJS.Timeout | null = null;
let middayTimer: NodeJS.Timeout | null = null;

async function runMorning(retriesLeft: number): Promise<void> {
  // Whole body guarded: rolloverEnabled() reads the DB, and this runs via
  // `void runMorning(...)`, so an uncaught throw would be an unhandled rejection.
  try {
    if (!rolloverEnabled()) return; // honor a flip-to-off since scheduling
    for (const target of LIVE_TARGETS) {
      try {
        const res = await runTalkRollover({ target, trigger: 'morning' });
        // Retry on any transient "seat was busy / raced" reason, not just the
        // entry-gate "in flight" — a turn that started during the writer aborts
        // with a 'mid-roll' reason and must still be retried, or the morning
        // roll is abandoned until mid-day/next day.
        if (!res.ran && /in flight|mid-roll|already running/.test(res.reason) && retriesLeft > 0) {
          setTimeout(() => { void runMorning(retriesLeft - 1); }, MORNING_RETRY_MS).unref?.();
          return;
        }
        if (res.ran) console.log(`[talk-rollover] morning: ${res.externalId}: ${res.reason}`);
      } catch (err) {
        console.error(`[talk-rollover] morning failed for ${target.externalId}:`, err);
      }
    }
  } catch (err) {
    console.error('[talk-rollover] morning tick failed:', err);
  }
}

async function runMiddayCheck(): Promise<void> {
  try {
    if (!rolloverEnabled()) return;
    const cap = middayTokenCap();
    for (const target of LIVE_TARGETS) {
      try {
        const conv = getConversation(target.externalId);
        if (!conv) continue;
        if (isConversationActive(conv.id)) continue; // wait for an idle gap
        const tok = measureSessionTokens(conv.id);
        if (tok.replayed < cap) continue;
        // runTalkRollover no-ops when there are no new turns since the last roll,
        // so a just-cleared session whose last (stale) assistant turn still reads
        // big can't double-roll — it simply reports 'no new turns'.
        const res = await runTalkRollover({ target, trigger: 'midday' });
        if (res.ran) console.log(`[talk-rollover] midday (session ${tok.replayed} ≥ ${cap}): ${res.reason}`);
      } catch (err) {
        console.error(`[talk-rollover] midday check failed for ${target.externalId}:`, err);
      }
    }
  } catch (err) {
    console.error('[talk-rollover] midday tick failed:', err);
  }
}

function scheduleMorning(): void {
  const ms = msUntilNextCT(MORNING_HOUR);
  morningTimer = setTimeout(() => {
    void runMorning(MORNING_MAX_RETRIES);
    scheduleMorning();
  }, ms);
  morningTimer.unref?.();
  console.log(`[talk-rollover] next morning rollover in ${(ms / 3_600_000).toFixed(1)}h`);
}

/** Start the rollover worker: the 04:00 CT morning roll + the ~400k mid-day
 *  safety net. Cheap at rest (one SELECT per 15-min tick when enabled). Entirely
 *  gated by the kill switch, so with it OFF this does nothing but hold timers. */
export function startTalkRolloverWorker(): void {
  if (morningTimer || middayTimer) return;
  scheduleMorning();
  middayTimer = setInterval(() => { void runMiddayCheck(); }, MIDDAY_TICK_MS);
  middayTimer.unref?.();
  console.log('[talk-rollover] worker started (kill switch gates all work)');
}

/** Used by the hermetic check to read a just-written card back off disk. */
export function listDayCards(daysDir: string): { file: string; mtime: number }[] {
  if (!existsSync(daysDir)) return [];
  const files = sortCardFiles(readdirSync(daysDir).filter((f) => /\.md$/.test(f)));
  return files.map((f) => ({ file: f, mtime: statSync(path.join(daysDir, f)).mtimeMs }));
}
