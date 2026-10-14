// Token diet for long chats (2026-10-13, Kevin: "do whatever you can to make it more efficient").
//
// Measured on this box before the change:
//   * 1M-window Claude models never summarized until ~970K of context. ~9,000 recent steps each re-read
//     300K+ tokens. The forex chat sat at 672K per step after one day.
//   * On every resumed turn the full memory file (~24K tokens) was re-pasted into the session, even when
//     it had not changed. That was 7 copies (~166K tokens) in the forex chat alone, all re-read on every step.
//
// Two levers, both reversible from settings:
//   1. EARLY SUMMARY: for 1M-window models, set CLAUDE_AUTOCOMPACT_PCT_OVERRIDE so the CLI compacts at
//      `claude_autocompact_tokens` (default 250000; 0 disables). Proven 2026-10-13 that the override fires
//      in headless --resume mode (99,654 → 25,614 tokens on the next message). The full transcript stays
//      in jarvis.db, so detail lost to the summary is still searchable.
//   2. MEMORY ONCE PER SESSION: on resume, inject the full memory only when the session is new to us, was
//      compacted since the last injection (the old copy may have been summarized away), or every
//      `memory_full_every_turns` turns (default 25). Otherwise inject a one-line "unchanged" marker, or
//      just the changed lines when the file was edited. `memory_dedupe` = off reverts to always-full.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSetting } from './conversation-db.js';

// Models proven on this box to run past 300K without compacting, i.e. 1M windows.
const ONE_MILLION_WINDOW = new Set([
  'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7',
  'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-fable-5', 'claude-fable-5-1',
]);

/** Percent of the window at which the CLI should auto-compact, or null to leave the CLI default. */
export function autocompactPctFor(model: string | null | undefined): number | null {
  if (!model || !ONE_MILLION_WINDOW.has(model)) return null;
  const target = Number(getSetting('claude_autocompact_tokens') ?? '250000');
  if (!Number.isFinite(target) || target <= 0) return null;
  const pct = Math.round((target / 1_000_000) * 100);
  return pct >= 5 && pct < 95 ? pct : null;
}

const STATE_DIR = join(homedir(), '.jarvis', 'memory-injections');
const CLI_CWD_SLUG = (process.env.JARVIS_CLI_CWD ?? join(homedir(), '.jarvis-cli-workspace')).replace(/[^A-Za-z0-9]/g, '-');

interface InjectionState { sessionId: string; sha: string; compactions: number; turnsSinceFull: number }

/** How many times this CLI session has been compacted (-1 = session file not found → be safe, send full). */
function compactionCount(sessionId: string): number {
  const dirs = new Set([join(homedir(), '.claude'), join(homedir(), '.claude-b')]);
  if (process.env.CLAUDE_CONFIG_DIR) dirs.add(process.env.CLAUDE_CONFIG_DIR);
  for (const d of dirs) {
    const f = join(d, 'projects', CLI_CWD_SLUG, `${sessionId}.jsonl`);
    if (!existsSync(f)) continue;
    try {
      const text = readFileSync(f, 'utf8');
      // Count only real boundary records. A transcript that merely QUOTES the marker (in a tool result or
      // a message) stores it JSON-escaped (\\"subtype\\":...), so the unescaped key:value pair below is structural.
      return text.split('"subtype":"compact_boundary"').length - 1;
    } catch {
      return -1;
    }
  }
  return -1;
}

function lineDiff(oldText: string, newText: string): { removed: string[]; added: string[] } {
  const oldSet = new Set(oldText.split('\n'));
  const newSet = new Set(newText.split('\n'));
  return {
    removed: oldText.split('\n').filter((l) => l.trim() && !newSet.has(l)),
    added: newText.split('\n').filter((l) => l.trim() && !oldSet.has(l)),
  };
}

/**
 * The <memory_refresh> block for a RESUMED turn. `fullBlock` is what loadMemoryBlock() returned.
 * Never throws: any state problem falls back to the full block (today's behaviour).
 */
export function memoryRefreshForResume(conversationId: number, sessionId: string, fullBlock: string): string {
  const full = `<memory_refresh>\n${fullBlock}\n</memory_refresh>`;
  try {
    if ((getSetting('memory_dedupe') ?? 'on') === 'off') return full;
    const everyN = Math.max(1, Number(getSetting('memory_full_every_turns') ?? '25') || 25);
    mkdirSync(STATE_DIR, { recursive: true });
    const statePath = join(STATE_DIR, `${conversationId}.json`);
    const bodyPath = join(STATE_DIR, `${conversationId}.md`);
    const sha = createHash('sha1').update(fullBlock).digest('hex');
    const compactions = compactionCount(sessionId);
    let prev: InjectionState | null = null;
    try { prev = JSON.parse(readFileSync(statePath, 'utf8')) as InjectionState; } catch { prev = null; }

    const sendFull = !prev || prev.sessionId !== sessionId || compactions < 0 || prev.compactions !== compactions
      || prev.turnsSinceFull + 1 >= everyN || !existsSync(bodyPath);
    if (sendFull) {
      writeFileSync(bodyPath, fullBlock, { mode: 0o600 });
      writeFileSync(statePath, JSON.stringify({ sessionId, sha, compactions, turnsSinceFull: 0 }), { mode: 0o600 });
      return full;
    }
    const next: InjectionState = { sessionId, sha, compactions, turnsSinceFull: prev!.turnsSinceFull + 1 };
    if (prev!.sha === sha) {
      writeFileSync(statePath, JSON.stringify(next), { mode: 0o600 });
      return '<memory_refresh unchanged="true">Your persistent memory file is unchanged since it was last loaded earlier in this session. That copy is still current and authoritative.</memory_refresh>';
    }
    const oldBody = readFileSync(bodyPath, 'utf8');
    const { removed, added } = lineDiff(oldBody, fullBlock);
    const diffChars = removed.join('\n').length + added.join('\n').length;
    if (diffChars > fullBlock.length * 0.3) {          // a big rewrite: just resend it all
      writeFileSync(bodyPath, fullBlock, { mode: 0o600 });
      writeFileSync(statePath, JSON.stringify({ ...next, turnsSinceFull: 0 }), { mode: 0o600 });
      return full;
    }
    writeFileSync(bodyPath, fullBlock, { mode: 0o600 });
    writeFileSync(statePath, JSON.stringify(next), { mode: 0o600 });
    return [
      '<memory_refresh mode="diff">Your persistent memory file was edited since it was last loaded in this session. Apply these line changes to that copy; everything else is unchanged and still authoritative.',
      removed.length ? `REMOVED LINES:\n${removed.map((l) => `- ${l}`).join('\n')}` : 'REMOVED LINES: none',
      added.length ? `ADDED OR REPLACED LINES:\n${added.map((l) => `+ ${l}`).join('\n')}` : 'ADDED LINES: none',
      '</memory_refresh>',
    ].join('\n');
  } catch {
    return full;
  }
}
