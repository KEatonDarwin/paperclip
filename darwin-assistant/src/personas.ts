// PERSONA LEVELS (Alpha JARVIS, 2026-10-14) — "different levels of JARVIS as we go along".
//
// A level is a FOLDER: identity.md (who you are), memory.md (its own persistent memory,
// read/written by read_memory/write_memory in that seat), playbook/ (method + dated
// patterns the trainer writes), questions.md. Which thread gets which level is a CONFIG
// ROW in agent-memory/personas.json — adding a level never needs code.
//
// Precedence (narrow on purpose): ephemeral worker threads keep worker-core.md exactly as
// before (prompt.ts decides that first); a thread matched by the registry gets its persona
// block; every other thread is the plain JARVIS persona + shared memory, byte-identical to
// before this file existed. A missing/corrupt registry = no personas (fail to the old path).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface PersonaDef {
  key: string;
  label: string;
  /** absolute dir holding identity.md / memory.md / playbook/ / questions.md */
  dir: string;
  identity?: string;            // default identity.md
  memory?: string;              // default memory.md
  playbook?: string;            // default playbook (subdir)
  playbook_recent?: number;     // dated pattern files to inject, newest first (default 3)
  inherit_shared_memory?: boolean; // default true: the shared JARVIS memory rides along
  /** optional model-free command whose stdout is injected every turn as <persona_digest> */
  live_digest_cmd?: string[];
  live_digest_ttl_seconds?: number; // default 90
  live_digest_max_chars?: number;   // default 30000
  match: { exact?: string[]; prefix?: string[] };
}

const DEFAULT_REGISTRY = '/home/kevin/obsidian/paperclip-wiki/agent-memory/personas.json';

export function personasRegistryPath(): string {
  return process.env.JARVIS_PERSONAS_FILE || DEFAULT_REGISTRY;
}

let cache: { path: string; mtimeMs: number; defs: PersonaDef[] } | null = null;

/** Read the registry fresh whenever the file changed (cheap stat per call). Never throws. */
export function loadPersonas(): PersonaDef[] {
  const path = personasRegistryPath();
  try {
    const st = statSync(path);
    if (cache && cache.path === path && cache.mtimeMs === st.mtimeMs) return cache.defs;
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { personas?: unknown };
    const defs = (Array.isArray(raw.personas) ? raw.personas : [])
      .filter((p): p is PersonaDef =>
        !!p && typeof p === 'object'
        && typeof (p as PersonaDef).key === 'string'
        && typeof (p as PersonaDef).dir === 'string'
        && !!(p as PersonaDef).match && typeof (p as PersonaDef).match === 'object');
    cache = { path, mtimeMs: st.mtimeMs, defs };
    return defs;
  } catch {
    cache = null;
    return [];
  }
}

/** The persona a thread is bound to, or null for the plain JARVIS persona. */
export function resolvePersonaForThread(externalId: string | null | undefined): PersonaDef | null {
  if (!externalId) return null;
  for (const p of loadPersonas()) {
    if (p.match.exact?.includes(externalId)) return p;
    if (p.match.prefix?.some((pre) => pre && externalId.startsWith(pre))) return p;
  }
  return null;
}

export function personaByKey(key: string): PersonaDef | null {
  return loadPersonas().find((p) => p.key === key) ?? null;
}

/** Absolute path of the persona's OWN memory file for a thread, or null (shared memory). */
export function personaMemoryPathForThread(externalId: string | null | undefined): string | null {
  const p = resolvePersonaForThread(externalId);
  return p ? join(p.dir, p.memory || 'memory.md') : null;
}

function readOr(path: string, fallback: string): string {
  try {
    const s = readFileSync(path, 'utf-8').trim();
    return s || fallback;
  } catch {
    return fallback;
  }
}

function tail(s: string, lines: number): string {
  const arr = s.split('\n');
  return arr.length <= lines ? s : arr.slice(-lines).join('\n');
}

/** Playbook = the method file(s) + the newest N dated pattern files + the newest proposals file. */
export function renderPlaybook(p: PersonaDef): string {
  const dir = join(p.dir, p.playbook || 'playbook');
  if (!existsSync(dir)) return '';
  const out: string[] = [];
  let top: string[] = [];
  try { top = readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { top = []; }
  for (const f of top) out.push(`### ${f}\n\n${readOr(join(dir, f), '')}`);
  const recent = Math.max(0, p.playbook_recent ?? 3);
  for (const sub of ['patterns', 'proposals']) {
    const sdir = join(dir, sub);
    if (!existsSync(sdir)) continue;
    let files: string[] = [];
    try { files = readdirSync(sdir).filter((f) => f.endsWith('.md')).sort().reverse(); } catch { files = []; }
    const take = sub === 'patterns' ? recent : Math.min(1, recent);
    for (const f of files.slice(0, take)) out.push(`### ${sub}/${f}\n\n${readOr(join(sdir, f), '')}`);
  }
  return out.join('\n\n');
}

/**
 * The memory block for a persona seat. Replaces (worker) or wraps (inherit) the shared
 * block. `sharedBlock` is what loadMemoryBlock(maxChars,'full') returned, passed in so this
 * module never imports prompt.ts (prompt.ts imports us).
 */
export function buildPersonaMemoryBlock(p: PersonaDef, sharedBlock: () => string): string {
  const identityPath = join(p.dir, p.identity || 'identity.md');
  const memoryPath = join(p.dir, p.memory || 'memory.md');
  const identity = readOr(identityPath, `_(identity file missing: ${identityPath})_`);
  const memory = readOr(memoryPath, '_(no own memory yet)_');
  const playbook = renderPlaybook(p);
  const questions = readOr(join(p.dir, 'questions.md'), '');
  const parts: string[] = [
    `## Who you are in this seat — ${p.label || p.key} (persona level "${p.key}")`,
    `_Source: ${identityPath}. Injected fresh every turn. This seat has its OWN memory file (${memoryPath}); \`read_memory\`/\`write_memory\` here read and write THAT file, not the shared JARVIS memory. Same diet rules: supersede in place, keep it lean._`,
    '',
    identity,
    '',
    '---',
    '',
    `## Your own memory (${p.key})`,
    '',
    memory,
    '',
    '---',
  ];
  if (playbook) parts.push('', `## Your playbook (${join(p.dir, p.playbook || 'playbook')})`, '', playbook, '', '---');
  if (questions) parts.push('', '## Your questions log (questions.md, newest tail)', '', tail(questions, 60), '', '---');
  if (p.inherit_shared_memory !== false) {
    parts.push('', '## The shared JARVIS memory (inherited — everything JARVIS knows; your own memory above wins on how YOU work, the non-negotiables win over both)', '', sharedBlock());
  }
  return parts.join('\n');
}

// ── live digest (model-free command, cached) ─────────────────────────────────
const digestCache = new Map<string, { at: number; text: string }>();

export function buildPersonaDigestBlock(externalId: string | null | undefined): string {
  const p = resolvePersonaForThread(externalId);
  if (!p || !p.live_digest_cmd || !p.live_digest_cmd.length) return '';
  const ttl = Math.max(5, p.live_digest_ttl_seconds ?? 90) * 1000;
  const max = Math.max(1000, p.live_digest_max_chars ?? 30000);
  const hit = digestCache.get(p.key);
  const now = Date.now();
  let text: string;
  if (hit && now - hit.at < ttl) {
    text = hit.text;
  } else {
    try {
      const [cmd, ...args] = p.live_digest_cmd;
      text = execFileSync(cmd, args, { encoding: 'utf-8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }).trim();
    } catch (err) {
      text = `_(digest unavailable: ${err instanceof Error ? err.message.split('\n')[0] : String(err)})_`;
    }
    if (text.length > max) text = `${text.slice(0, max)}\n_(digest truncated to ${max} chars)_`;
    digestCache.set(p.key, { at: now, text });
  }
  return `<persona_digest persona="${p.key}" generated="${new Date().toISOString()}">\n${text}\n</persona_digest>\n\n`;
}

/** test hook */
export function _resetPersonaCaches(): void {
  cache = null;
  digestCache.clear();
}
