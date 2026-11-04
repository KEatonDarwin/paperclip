// Memory layout: one big file, or a small core + topic packs (lean/prompt-diet, 2026-10-17).
//
// Measured before the change: memory.md was 123KB (~31K tokens) against its own 80KB contract and
// rode on every fresh prompt and every 25th resumed turn. Most of it is topic detail (CPA, the leads
// rebuild, accounting, job search) that a given turn never touches.
//
// `memory_layout` setting:
//   'single' (default)  today's behaviour, memory.md whole, byte-identical.
//   'core'              memory/core.md (rules + who Kevin is + a pack index) every turn; a pack in
//                       memory/packs/ is attached only when the message touches its topic, once per
//                       CLI session (again after a compaction, since the old copy may be summarised away).
// Falls back to 'single' whenever core.md is missing, so a half-installed layout can't strip memory.
// Rollback is the setting alone: memory_layout=single, next message, no restart.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getSetting } from './conversation-db.js';
import { compactionCount } from './token-diet.js';

// JARVIS_VAULT_ROOT exists for scripts/memory-layout-test.ts (scratch vault); unset in every live unit.
export const VAULT_ROOT = process.env.JARVIS_VAULT_ROOT || '/home/kevin/obsidian/paperclip-wiki';
export const LEGACY_MEMORY_REL = 'agent-memory/jarvis/memory.md';
export const CORE_MEMORY_REL = 'agent-memory/jarvis/memory/core.md';
export const PACKS_REL = 'agent-memory/jarvis/memory/packs';

// At most this many packs ride on one turn, highest trigger score first. Each pack is <=25KB.
const MAX_PACKS_PER_TURN = 3;

export type MemoryLayout = 'single' | 'core';

export function memoryLayout(): MemoryLayout {
  try {
    if ((getSetting('memory_layout') ?? 'single') !== 'core') return 'single';
  } catch {
    return 'single';
  }
  return existsSync(join(VAULT_ROOT, CORE_MEMORY_REL)) ? 'core' : 'single';
}

/** Vault-relative path of the file read_memory/write_memory and the prompt treat as "the memory". */
export function activeMemoryRel(): string {
  return memoryLayout() === 'core' ? CORE_MEMORY_REL : LEGACY_MEMORY_REL;
}

export interface MemoryPack {
  name: string;
  description: string;
  triggers: string[];
  rel: string;
  body: string;
}

let packCache: { key: string; packs: MemoryPack[] } | null = null;

function parsePack(rel: string, text: string): MemoryPack | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const field = (k: string) => (m[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1] ?? '').trim();
  const name = field('name');
  if (!name) return null;
  return {
    name,
    description: field('description'),
    triggers: field('triggers').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
    rel,
    body: text.slice(m[0].length).trim(),
  };
}

/** Every pack in memory/packs/, re-read only when a file's mtime or the file set changes. */
export function listPacks(): MemoryPack[] {
  const dir = join(VAULT_ROOT, PACKS_REL);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
  const key = files.map((f) => `${f}:${statSync(join(dir, f)).mtimeMs}`).join('|');
  if (packCache?.key === key) return packCache.packs;
  const packs: MemoryPack[] = [];
  for (const f of files) {
    try {
      const p = parsePack(`${PACKS_REL}/${f}`, readFileSync(join(dir, f), 'utf-8'));
      if (p) packs.push(p);
    } catch { /* an unreadable pack is skipped, never fatal */ }
  }
  packCache = { key, packs };
  return packs;
}

/** The index block substituted for {{PACK_INDEX}} in core.md. */
export function packIndex(): string {
  const packs = listPacks();
  if (!packs.length) return '_(no packs installed)_';
  return packs.map((p) => `- **${p.name}** — \`${p.rel}\` — ${p.description}`).join('\n');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Packs whose triggers appear in `text`, best match first, capped. Triggers match on word edges. */
export function packsForMessage(text: string, packs: MemoryPack[] = listPacks()): MemoryPack[] {
  const hay = text.toLowerCase();
  const scored = packs
    .map((p) => ({
      p,
      score: p.triggers.filter((t) => new RegExp(`(^|[^a-z0-9])${escapeRe(t.trim())}($|[^a-z0-9])`).test(hay)).length,
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_PACKS_PER_TURN).map((s) => s.p);
}

function renderPacks(packs: MemoryPack[], note: string): string {
  if (!packs.length) return '';
  return [
    `<memory_packs>${note} These are sections of your persistent memory, as authoritative as the core.`,
    ...packs.map((p) => `<pack name="${p.name}" path="${p.rel}">\n${p.body}\n</pack>`),
    '</memory_packs>',
    '',
    '',
  ].join('\n');
}

const STATE_DIR = join(homedir(), '.jarvis', 'memory-injections');
interface PackState { sessionId: string; compactions: number; sent: Record<string, string> }

/**
 * The per-turn pack block. '' unless the core layout is on and the message matches a pack.
 * With a live CLI session, a pack already sent in this session (same content, no compaction since)
 * is not sent again. Never throws.
 */
export function memoryPacksForTurn(conversationId: number, sessionId: string | null, text: string): string {
  try {
    if (memoryLayout() !== 'core') return '';
    const matched = packsForMessage(text);
    if (!matched.length) return '';
    const note = ` Auto-attached because this message touches: ${matched.map((p) => p.name).join(', ')}.`;
    if (!sessionId) return renderPacks(matched, note);

    mkdirSync(STATE_DIR, { recursive: true });
    const statePath = join(STATE_DIR, `${conversationId}.packs.json`);
    let prev: PackState | null = null;
    try { prev = JSON.parse(readFileSync(statePath, 'utf8')) as PackState; } catch { prev = null; }
    const compactions = compactionCount(sessionId);
    const fresh = !prev || prev.sessionId !== sessionId || compactions < 0 || prev.compactions !== compactions;
    const sent: Record<string, string> = fresh ? {} : { ...prev!.sent };
    const sig = (p: MemoryPack) => `${p.body.length}:${p.body.slice(0, 64)}:${p.body.slice(-64)}`;
    const toSend = matched.filter((p) => sent[p.name] !== sig(p));
    for (const p of toSend) sent[p.name] = sig(p);
    writeFileSync(statePath, JSON.stringify({ sessionId, compactions, sent }), { mode: 0o600 });
    return renderPacks(toSend, note);
  } catch {
    return '';
  }
}
