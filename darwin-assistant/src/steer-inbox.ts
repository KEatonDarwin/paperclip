import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// STEER INBOX (2026-10-29) — hand a running chat new information without
// stopping it. Pure filesystem on purpose: no DB table, no schema change, and
// the hook that delivers it needs no HTTP call or key.
//
//   server  writeSteer()  ->  <root>/<conversationId>/<id>.pending.json
//   claude  PostToolUse hook (bin/steer-hook, injected per spawn via
//           `--settings`) renames pending -> claimed (atomic: one hook wins)
//           and returns the text as additionalContext, so the model sees it
//           before its next step.
//   server  settleSteer() at turn end: anything still pending (never reached a
//           step boundary) or claimed on a turn that errored/was stopped is
//           handed back to the existing queue as an After message. Never lost.
//
// This module imports no DB code so the hook path and tests can load it alone.

const ROOT = process.env.JARVIS_STEER_ROOT ?? join(homedir(), '.jarvis', 'steer');
// Files written before this process started belong to a dead process.
const BOOT_MS = Date.now();

export interface SteerItem {
  id: string;
  text: string;
  from: string;
  sent_at: string; // ISO
}

export interface InterruptItem {
  text: string;
  from: string;
  note: string;
  sent_at: string;
}

export function steerDir(conversationId: number): string {
  return join(ROOT, String(conversationId));
}

export function steerHookPath(): string {
  // src/ and dist/ both sit one level under the package root, bin/ beside them.
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'steer-hook');
}

/** JSON for `claude --settings`: one PostToolUse hook, fail-open by construction. */
export function steerSettingsJson(dir: string): string {
  return JSON.stringify({
    hooks: {
      PostToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: `python3 -I ${shq(steerHookPath())} ${shq(dir)}`, timeout: 5 }],
        },
      ],
    },
  });
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function newId(): string {
  // Sorts oldest-first; the random tail keeps two writes in one ms distinct.
  return `${Date.now().toString().padStart(14, '0')}-${Math.random().toString(36).slice(2, 8)}`;
}

function listBy(dir: string, suffix: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(suffix)).sort();
  } catch {
    return [];
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function writeSteer(conversationId: number, text: string, from: string): SteerItem {
  const dir = steerDir(conversationId);
  mkdirSync(dir, { recursive: true });
  const item: SteerItem = { id: newId(), text, from, sent_at: new Date().toISOString() };
  // write-then-rename so a hook never reads a half-written file
  const tmp = join(dir, `${item.id}.tmp`);
  writeFileSync(tmp, JSON.stringify(item), 'utf8');
  renameSync(tmp, join(dir, `${item.id}.pending.json`));
  return item;
}

export function writeInterrupt(conversationId: number, item: InterruptItem): void {
  const dir = steerDir(conversationId);
  mkdirSync(dir, { recursive: true });
  const id = newId();
  const tmp = join(dir, `${id}.tmp`);
  writeFileSync(tmp, JSON.stringify(item), 'utf8');
  renameSync(tmp, join(dir, `${id}.interrupt.json`));
}

/** Pop the oldest pending interrupt for a conversation (read + delete), or null. */
export function takeInterrupt(conversationId: number): InterruptItem | null {
  const dir = steerDir(conversationId);
  for (const f of listBy(dir, '.interrupt.json')) {
    const p = join(dir, f);
    const item = readJson<InterruptItem>(p);
    try { unlinkSync(p); } catch { /* another taker won */ }
    if (item && typeof item.text === 'string') return item;
  }
  return null;
}

function drain(dir: string, suffix: string, remove: boolean): SteerItem[] {
  const out: SteerItem[] = [];
  for (const f of listBy(dir, suffix)) {
    const p = join(dir, f);
    const item = readJson<SteerItem>(p);
    if (remove) { try { unlinkSync(p); } catch { /* gone */ } }
    if (item && typeof item.text === 'string') out.push(item);
  }
  return out;
}

/**
 * Turn is over. Returns the items that did NOT reach the model and must go back
 * on the queue; deletes everything else. `ok` = the turn finished normally, so
 * claimed items were seen. Anything else (error / Stop) also returns claimed
 * items: a duplicate is cheaper than a lost instruction.
 */
export function settleSteerFiles(conversationId: number, ok: boolean): SteerItem[] {
  const dir = steerDir(conversationId);
  const pending = drain(dir, '.pending.json', true);
  const claimed = drain(dir, '.claimed.json', true);
  const back = ok ? pending : [...claimed, ...pending];
  return back.sort((a, b) => (a.sent_at < b.sent_at ? -1 : a.sent_at > b.sent_at ? 1 : 0));
}

/** Items left behind by a previous process (restart mid-turn). Returns + removes them. */
export function sweepStaleSteerFiles(conversationId: number): SteerItem[] {
  const dir = steerDir(conversationId);
  const stale: SteerItem[] = [];
  for (const suffix of ['.pending.json', '.claimed.json']) {
    for (const f of listBy(dir, suffix)) {
      const p = join(dir, f);
      let mtime = Infinity;
      try { mtime = statSync(p).mtimeMs; } catch { continue; }
      if (mtime >= BOOT_MS) continue; // written by this process
      const item = readJson<SteerItem>(p);
      try { unlinkSync(p); } catch { /* gone */ }
      if (item && typeof item.text === 'string') stale.push(item);
    }
  }
  return stale.sort((a, b) => (a.sent_at < b.sent_at ? -1 : 1));
}

/** One message out of demoted steer items (a single item passes through verbatim). */
export function formatDemoted(items: SteerItem[]): string {
  if (items.length === 1) return items[0].text;
  const lines = items.map((i) => `[${i.sent_at.slice(11, 19)}Z ${i.from}] ${i.text}`);
  return `${items.length} messages arrived while you were working and could not be delivered mid-turn. Oldest first; where they conflict, the later one wins.\n\n${lines.join('\n\n')}`;
}
