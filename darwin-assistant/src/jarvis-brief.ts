// JARVIS-authored cockpit landing brief (2026-07-19).
//
// Kevin's ask: stop handing him a fixed dashboard template with numbers filled
// in. Instead, JARVIS decides — every time the brief goes stale — what
// actually belongs in front of him right now, using everything flowing
// through JARVIS (memory, decisions, autonomy actions, open todos, SHIM,
// Paperclip). The content AND the shape of it are the model's call, not a
// hardcoded layout. The only fixed thing is a small generic rendering
// vocabulary (see BriefBlock) so the frontend has something to draw — what
// blocks appear, how many, and what they say is decided fresh each time.
//
// Generation is a single `claude` CLI call (NO ANTHROPIC_API_KEY — see the
// NO API KEYS rule in JARVIS memory), mirroring the pattern in
// tools/ux-reviewer/vision-critique.ts.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { sqliteDb } from './conversation-db.js';
import { getPaperclipSnapshot, getShimSnapshot, getTopPriorities } from './briefing.js';
import { listJarvisDecisions } from './jarvis-decisions.js';
import { listAutonomyLedger } from './autonomy-ledger.js';
import { extractJsonObject } from './tools/ux-reviewer/vision-critique.js';

const MEMORY_FILE = '/home/kevin/obsidian/paperclip-wiki/agent-memory/jarvis/memory.md';
const TZ = 'America/Chicago';
const CLAUDE_BIN = process.env.UX_REVIEWER_CLAUDE_BIN || 'claude';
const BRIEF_TTL_MS = 10 * 60 * 1000; // regenerate at most every 10 minutes
const CLAUDE_TIMEOUT_MS = 90 * 1000;

export type BriefBlockType = 'heading' | 'text' | 'list' | 'callout' | 'stat' | 'links';

export interface BriefBlock {
  type: BriefBlockType;
  // heading/text
  text?: string;
  // callout
  tone?: 'info' | 'warn' | 'good';
  // list
  items?: string[];
  // stat
  label?: string;
  value?: string;
  // links
  links?: { label: string; url: string }[];
}

export interface Brief {
  generatedAt: string;
  blocks: BriefBlock[];
  stale?: boolean; // true when generation failed and this is a cached/fallback copy
}

let cached: Brief | null = null;
let cachedAt = 0;
let inflight: Promise<Brief> | null = null;

function openTodosForKevin(): string {
  try {
    const rows = sqliteDb
      .prepare<[], { content: string; status: string; external_id: string; title: string | null }>(
        `SELECT t.content, t.status, c.external_id, c.title
         FROM thread_todos t
         JOIN conversations c ON c.id = t.conversation_id
         WHERE t.owner = 'kevin' AND t.status != 'done'
         ORDER BY t.updated_at DESC
         LIMIT 15`,
      )
      .all();
    if (!rows.length) return '(none)';
    return rows
      .map((r) => `- [${r.status}] "${r.content}" (thread: ${r.title ?? r.external_id})`)
      .join('\n');
  } catch (err) {
    return `(could not read thread todos: ${(err as Error).message})`;
  }
}

function recentDecisions(): string {
  try {
    const rows = listJarvisDecisions({ limit: 8 });
    if (!rows.length) return '(none logged recently)';
    return rows
      .map((r) => `- ${r.decided_by === 'jarvis' ? 'JARVIS decided' : 'Kevin decided'}: ${r.question} → ${r.decision ?? '(pending)'}`)
      .join('\n');
  } catch (err) {
    return `(could not read decision ledger: ${(err as Error).message})`;
  }
}

function recentAutonomyActions(): string {
  try {
    const rows = listAutonomyLedger({ limit: 8 });
    if (!rows.length) return '(none logged recently)';
    return rows.map((r) => `- ${r.title}${r.result_status ? ` (${r.result_status})` : ''}`).join('\n');
  } catch (err) {
    return `(could not read autonomy ledger: ${(err as Error).message})`;
  }
}

function readMemory(): string {
  try {
    return readFileSync(MEMORY_FILE, 'utf-8').trim();
  } catch {
    return '(memory file unavailable)';
  }
}

async function buildBriefPrompt(): Promise<string> {
  const nowStr = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: TZ,
  }).format(new Date());

  const [paperclip, shim, priorities] = await Promise.all([
    getPaperclipSnapshot(),
    getShimSnapshot(),
    getTopPriorities(),
  ]);

  return [
    'You are JARVIS, deciding what belongs on Kevin\'s cockpit landing screen RIGHT NOW.',
    '',
    'Kevin\'s explicit instruction: no fixed template, no predefined widgets. Do not just',
    'fill numbers into a standard layout. Use everything below and your own judgment as his',
    'chief of staff to decide what is actually worth surfacing at this exact moment — could be',
    'one thing, could be several, could be a completely different shape next time this runs.',
    'If nothing meaningfully changed or nothing needs his attention, it is completely fine to',
    'say so plainly and briefly rather than padding it out.',
    '',
    `Current time: ${nowStr} (Central).`,
    '',
    '=== YOUR MEMORY (durable facts, directives, active commitments) ===',
    readMemory(),
    '',
    '=== RECENT DECISION LEDGER (choices you made or would have escalated) ===',
    recentDecisions(),
    '',
    '=== RECENT AUTONOMY LEDGER (proactive actions you took) ===',
    recentAutonomyActions(),
    '',
    '=== OPEN THREAD TODOS ASSIGNED TO KEVIN (across all cockpit conversations) ===',
    openTodosForKevin(),
    '',
    '=== PAPERCLIP SNAPSHOT ===',
    paperclip,
    '',
    '=== SHIM SNAPSHOT ===',
    `Tasks: ${shim.tasks}`,
    `Sessions: ${shim.sessions}`,
    '',
    '=== TOP SHIM PRIORITIES ===',
    priorities,
    '',
    'Render your decision as blocks from this vocabulary ONLY (a generic rendering',
    'primitive set — you decide which ones to use, how many, and in what order; there is no',
    'required count and no required mix):',
    '  - {"type": "heading", "text": "..."}',
    '  - {"type": "text", "text": "... (markdown ok: **bold**, *italic*, `code`)"}',
    '  - {"type": "list", "items": ["...", "..."]}',
    '  - {"type": "callout", "tone": "info"|"warn"|"good", "text": "..."}',
    '  - {"type": "stat", "label": "...", "value": "..."}',
    '  - {"type": "links", "links": [{"label": "...", "url": "..."}]}',
    '',
    'Return ONLY a JSON object — no markdown fences, no prose before or after — with EXACTLY',
    'this shape: {"blocks": [ <your chosen blocks> ]}',
    'Keep it tight — this is a glance screen, not a report. Speak to Kevin directly and warmly,',
    'the way you always do, not like a status page.',
  ].join('\n');
}

function runClaudeOneShot(prompt: string): Promise<string> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return new Promise((resolve, reject) => {
    execFile(
      CLAUDE_BIN,
      ['-p', prompt, '--output-format', 'json'],
      { timeout: CLAUDE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error(`claude brief call failed: ${err.message}${stderr ? ` | ${stderr.slice(0, 300)}` : ''}`));
          return;
        }
        try {
          const envelope = JSON.parse(stdout.trim()) as { result?: string };
          resolve(typeof envelope.result === 'string' ? envelope.result : stdout);
        } catch {
          resolve(stdout);
        }
      },
    );
  });
}

async function generateBrief(): Promise<Brief> {
  const prompt = await buildBriefPrompt();
  const raw = await runClaudeOneShot(prompt);
  const parsed = extractJsonObject(raw) as { blocks?: BriefBlock[] } | null;
  if (!parsed || !Array.isArray(parsed.blocks)) {
    throw new Error('brief generation did not return parseable blocks');
  }
  return { generatedAt: new Date().toISOString(), blocks: parsed.blocks };
}

/** Returns the cached brief if fresh; otherwise regenerates (de-duped across
 *  concurrent callers). On generation failure, serves the last-good cached
 *  copy (flagged stale) rather than a blank screen — the landing page should
 *  never hard-fail just because one generation round hiccuped. */
export async function getBrief(forceRefresh = false): Promise<Brief> {
  const fresh = cached && Date.now() - cachedAt < BRIEF_TTL_MS;
  if (fresh && !forceRefresh) return cached!;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const brief = await generateBrief();
      cached = brief;
      cachedAt = Date.now();
      return brief;
    } catch (err) {
      if (cached) return { ...cached, stale: true };
      return {
        generatedAt: new Date().toISOString(),
        blocks: [
          {
            type: 'callout',
            tone: 'warn',
            text: `Couldn't generate your brief just now (${(err as Error).message}). Send me a message and I'll get to work.`,
          },
        ],
      };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
