// SHARED CONTEXT v0 §1 — the "Shared Now" digest (docs/shared-context/CONTRACT.md).
//
// A deterministic, zero-model-call snapshot of what Kevin + JARVIS have in
// flight RIGHT NOW, built from the server-owned state that already exists in
// jarvis.db (workstreams / hopper trees / goals / watch commitments / thread
// summaries) and injected as prompt text into every non-worker conversation
// on its first turn and again after an idle gap — so a fresh thread on ANY
// provider (Claude A/B, codex, auggie, devin) knows where things stand before
// it asks Kevin "where does X live?".
//
// Import discipline: this module is imported by agent.ts, so it must only
// depend on conversation-db.js (sqliteDb + settings KV) and node built-ins.
// Every section reads with raw SQL inside its own try/catch so the module
// loads and renders on a scratch DB where some tables were never created
// (e.g. watch_commitments, owned by the Python watchdog).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sqliteDb, getSetting } from './conversation-db.js';
import { redactSecrets } from './redact.js';

export interface SharedNowWorkstream {
  id: number;
  title: string;
  turn: string;
  next_action: string | null;
  next_owner: string | null;
  waiting_since: string | null;
  threads: string[];
}
export interface SharedNowTree {
  id: string;
  topic: string;
  status: string;
  origin_thread_ext: string | null;
  updated_at: string;
  counts: Record<string, number>;
  branch: string | null;
  commit: string | null;
  outcome: string | null;
}
export interface SharedNowGoal {
  id: number;
  title: string;
  status: string;
  focus_path: string | null;
  counts: Record<string, number>;
  thread_ext: string | null;
}
export interface SharedNowCommitment {
  id: number;
  subject: string;
  due_at: string;
  thread_ext: string | null;
  check_type: string;
}
export interface SharedNowSummary {
  external_id: string;
  title: string;
  one_liner: string;
  created_at: string;
}
export interface SharedNowData {
  as_of: string;
  workstreams: SharedNowWorkstream[];
  trees: SharedNowTree[];
  goals: SharedNowGoal[];
  commitments: SharedNowCommitment[];
  summaries: SharedNowSummary[];
  truncated: boolean;
}

// -- settings-KV ---------------------------------------------------------------

export const SHARED_NOW_SETTING_KEYS = [
  'shared_now_enabled',
  'shared_now_ttl_sec',
  'shared_now_reinject_min',
  'shared_now_workers',
  'shared_now_max_chars',
  'shared_now_mirror_min',
] as const;

const DEFAULTS = {
  enabled: true,
  ttl_sec: 300,
  reinject_min: 120,
  workers: false,
  max_chars: 7200,
  mirror_min: 10,
};

function intSetting(key: string, fallback: number, min = 0, max = 1_000_000): number {
  const raw = getSetting(key);
  if (raw == null || raw.trim() === '') return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function boolSetting(key: string, fallback: boolean): boolean {
  const raw = getSetting(key);
  if (raw == null || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return fallback;
}

export function sharedNowSettings(): {
  enabled: boolean;
  ttl_sec: number;
  reinject_min: number;
  workers: boolean;
  max_chars: number;
  mirror_min: number;
} {
  return {
    enabled: boolSetting('shared_now_enabled', DEFAULTS.enabled),
    ttl_sec: intSetting('shared_now_ttl_sec', DEFAULTS.ttl_sec, 0, 86_400),
    reinject_min: intSetting('shared_now_reinject_min', DEFAULTS.reinject_min, 0, 100_000),
    workers: boolSetting('shared_now_workers', DEFAULTS.workers),
    max_chars: intSetting('shared_now_max_chars', DEFAULTS.max_chars, 400, 200_000),
    mirror_min: intSetting('shared_now_mirror_min', DEFAULTS.mirror_min, 0, 1440),
  };
}

// -- eligibility ---------------------------------------------------------------

// Plumbing threads that must NOT get the digest by default: ephemeral hopper /
// foundry workers (they get their spec, not the world), disposable quick chats,
// ephemeral one-offs, check-in firings and monitor runs. Group cover chats and
// goal chats are real JARVIS turns and stay eligible.
export const NON_ELIGIBLE_PREFIXES: readonly string[] = [
  'cockpit:hopper-node-',
  'cockpit:foundry-node-',
  'quick:',
  'ephemeral:',
  'checkin:',
  'monitor:',
];

export function isSharedNowEligibleThread(externalId: string, opts?: { workers?: boolean }): boolean {
  if (opts?.workers) return true;
  const ext = (externalId ?? '').toLowerCase();
  return !NON_ELIGIBLE_PREFIXES.some((p) => ext.startsWith(p));
}

// -- helpers -------------------------------------------------------------------

function tableExists(name: string): boolean {
  try {
    const row = sqliteDb
      .prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(name);
    return !!row && row.n > 0;
  } catch {
    return false;
  }
}

function clip(text: string | null | undefined, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

function stripMd(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*>+\s*/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

function firstContentLine(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cleaned = stripMd(line);
    if (!cleaned) continue;
    return clip(cleaned, max);
  }
  return null;
}

// SQLite datetime('now') is UTC without a zone marker — parse it as UTC.
export function parseSqliteUtc(value: string | null | undefined): number | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) ? v.replace(' ', 'T') + 'Z' : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v) ? v + 'Z' : v;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function shortTs(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(' ', 'T').slice(0, 16);
}

// Adversarial review (node #488): the old alternative `\b(?:branch|on)\s+…`
// matched the prose "status 0 on network/timeout" in a node result, so the live
// digest advertised `tree-43fb4584 · branch network/timeout` — a fresh thread on
// any provider would have told Kevin the Guards work lived on that branch. The
// bare `on` alternative is gone; a generic branch must be introduced by the word
// "branch" (an explicit `hopper/…` path still matches on its own).
const BRANCH_RE = /\bhopper\/[A-Za-z0-9._/-]+|\bbranch(?:es)?\s*:?\s+`?([A-Za-z][A-Za-z0-9._-]*\/[A-Za-z0-9._/-]+)`?/i;
const COMMIT_RE = /(?:commit\s*`?|@)([0-9a-f]{7,40})\b/i;

function extractBranch(text: string): string | null {
  const m = BRANCH_RE.exec(text);
  if (!m) return null;
  const raw = (m[1] ?? m[0]).replace(/[`.,;:)]+$/, '');
  return raw || null;
}

function extractCommit(text: string): string | null {
  const m = COMMIT_RE.exec(text);
  return m ? m[1] : null;
}

// -- collectors (each isolated) ------------------------------------------------

const CAPS = { workstreams: 12, trees: 12, goals: 8, commitments: 8, summaries: 10, threadsPerWs: 3 };

function collectWorkstreams(): SharedNowWorkstream[] {
  try {
    if (!tableExists('workstreams')) return [];
    const rows = sqliteDb
      .prepare(
        `SELECT id, title, turn, next_action, next_owner, waiting_since, updated_at
           FROM workstreams
          WHERE archived = 0 AND turn != 'done'
          ORDER BY CASE turn WHEN 'kevin' THEN 0 WHEN 'jarvis' THEN 1 WHEN 'external' THEN 2 WHEN 'parked' THEN 3 ELSE 4 END,
                   COALESCE(waiting_since, updated_at) ASC, sort_order ASC, id ASC
          LIMIT ?`,
      )
      .all(CAPS.workstreams) as Array<{
      id: number; title: string; turn: string; next_action: string | null; next_owner: string | null; waiting_since: string | null;
    }>;
    const linkStmt = tableExists('workstream_links')
      ? sqliteDb.prepare(`SELECT ref FROM workstream_links WHERE workstream_id = ? AND kind = 'thread' ORDER BY created_at DESC, id DESC LIMIT ?`)
      : null;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      turn: r.turn,
      next_action: r.next_action,
      next_owner: r.next_owner,
      waiting_since: r.waiting_since,
      threads: linkStmt ? (linkStmt.all(r.id, CAPS.threadsPerWs) as Array<{ ref: string }>).map((l) => l.ref) : [],
    }));
  } catch (err) {
    console.warn('[shared-now] workstreams section failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

function collectTrees(): SharedNowTree[] {
  try {
    if (!tableExists('hopper_trees')) return [];
    const trees = sqliteDb
      .prepare(
        `SELECT id, topic, status, origin_thread_ext, updated_at
           FROM hopper_trees
          WHERE status IN ('active','done') AND updated_at >= datetime('now','-7 days')
          ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC
          LIMIT ?`,
      )
      .all(CAPS.trees) as Array<{ id: string; topic: string; status: string; origin_thread_ext: string | null; updated_at: string }>;
    const hasNodes = tableExists('hopper_nodes');
    const nodesStmt = hasNodes
      ? sqliteDb.prepare(`SELECT status, result FROM hopper_nodes WHERE tree_id = ? ORDER BY id DESC`)
      : null;
    return trees.map((t) => {
      const counts: Record<string, number> = {};
      let branch: string | null = null;
      let commit: string | null = null;
      let outcome: string | null = null;
      if (nodesStmt) {
        const nodes = nodesStmt.all(t.id) as Array<{ status: string; result: string | null }>;
        for (const n of nodes) counts[n.status] = (counts[n.status] ?? 0) + 1;
        // Newest node first — the docs/push node's result is the one that
        // usually names the branch + commit.
        for (const n of nodes) {
          if (!n.result) continue;
          if (!branch) branch = extractBranch(n.result);
          if (!commit) commit = extractCommit(n.result);
          if (!outcome && n.status === 'done') outcome = firstContentLine(n.result, 140);
          if (branch && commit && outcome) break;
        }
      }
      return { id: t.id, topic: t.topic, status: t.status, origin_thread_ext: t.origin_thread_ext, updated_at: t.updated_at, counts, branch, commit, outcome };
    });
  } catch (err) {
    console.warn('[shared-now] trees section failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

function collectGoals(): SharedNowGoal[] {
  try {
    if (!tableExists('goals')) return [];
    const goals = sqliteDb
      .prepare(
        `SELECT id, title, status, thread_ext FROM goals
          WHERE archived = 0 AND status IN ('ghost','set')
          ORDER BY sort_order ASC, id ASC LIMIT ?`,
      )
      .all(CAPS.goals) as Array<{ id: number; title: string; status: string; thread_ext: string | null }>;
    const hasNodes = tableExists('goal_nodes');
    const hasFocus = tableExists('goal_focus');
    const countStmt = hasNodes
      ? sqliteDb.prepare(`SELECT state, COUNT(*) AS n FROM goal_nodes WHERE goal_id = ? AND state != 'discarded' GROUP BY state`)
      : null;
    const focusStmt = hasFocus ? sqliteDb.prepare(`SELECT node_id FROM goal_focus WHERE goal_id = ?`) : null;
    const nodeStmt = hasNodes ? sqliteDb.prepare(`SELECT id, parent_id, title FROM goal_nodes WHERE id = ?`) : null;
    return goals.map((g) => {
      const counts: Record<string, number> = {};
      if (countStmt) for (const r of countStmt.all(g.id) as Array<{ state: string; n: number }>) counts[r.state] = r.n;
      let focus_path: string | null = null;
      if (focusStmt && nodeStmt) {
        const f = focusStmt.get(g.id) as { node_id: number | null } | undefined;
        if (f?.node_id != null) {
          const titles: string[] = [];
          let cur: number | null = f.node_id;
          let guard = 0;
          while (cur != null && guard++ < 64) {
            const n = nodeStmt.get(cur) as { id: number; parent_id: number | null; title: string } | undefined;
            if (!n) break;
            titles.unshift(clip(n.title, 60));
            cur = n.parent_id;
          }
          focus_path = titles.length ? titles.join(' › ') : null;
        }
      }
      return { id: g.id, title: g.title, status: g.status, focus_path, counts, thread_ext: g.thread_ext };
    });
  } catch (err) {
    console.warn('[shared-now] goals section failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

function collectCommitments(): SharedNowCommitment[] {
  try {
    if (!tableExists('watch_commitments')) return [];
    const rows = sqliteDb
      .prepare(`SELECT id, subject, due_at, thread_ext, check_type FROM watch_commitments WHERE status = 'open' ORDER BY due_at ASC LIMIT ?`)
      .all(CAPS.commitments) as Array<{ id: number; subject: string; due_at: string; thread_ext: string | null; check_type: string }>;
    return rows.map((r) => ({ id: r.id, subject: clip(r.subject, 120), due_at: r.due_at, thread_ext: r.thread_ext, check_type: r.check_type }));
  } catch (err) {
    console.warn('[shared-now] commitments section failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

function collectSummaries(): SharedNowSummary[] {
  try {
    if (!tableExists('thread_summaries') || !tableExists('conversations')) return [];
    // Newest summary per conversation, then newest across conversations. Over-fetch
    // so the eligibility filter (done in JS — prefix rules live in one place)
    // still leaves a full page.
    const rows = sqliteDb
      .prepare(
        `SELECT s.content, s.created_at, c.external_id, c.title
           FROM thread_summaries s
           JOIN (SELECT conversation_id, MAX(id) AS max_id FROM thread_summaries GROUP BY conversation_id) latest
             ON latest.max_id = s.id
           JOIN conversations c ON c.id = s.conversation_id
          WHERE c.status != 'closed'
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT ?`,
      )
      .all(CAPS.summaries * 4) as Array<{ content: string; created_at: string; external_id: string; title: string | null }>;
    const out: SharedNowSummary[] = [];
    for (const r of rows) {
      if (!isSharedNowEligibleThread(r.external_id, { workers: false })) continue;
      out.push({
        external_id: r.external_id,
        title: clip(r.title ?? r.external_id, 80),
        one_liner: firstContentLine(r.content, 160) ?? '',
        created_at: r.created_at,
      });
      if (out.length >= CAPS.summaries) break;
    }
    return out;
  } catch (err) {
    console.warn('[shared-now] summaries section failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

export function collectSharedNow(): SharedNowData {
  return {
    as_of: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    workstreams: collectWorkstreams(),
    trees: collectTrees(),
    goals: collectGoals(),
    commitments: collectCommitments(),
    summaries: collectSummaries(),
    truncated: false,
  };
}

// -- rendering -----------------------------------------------------------------

const HEADER_TEXT =
  'SHARED NOW — what Kevin + JARVIS have in flight across every thread/provider (server-generated, no model). ' +
  'Use it to answer "where does X live / what happened with Y" before asking Kevin. ' +
  'For anything older or deeper: call the `recall` tool (searches other threads, trees, goals, wiki, auto-memory). ' +
  'Flight Deck = /flight-deck, trees = /spawn-tree, goals = /goals.';

const TRUNCATION_FOOTER = '… (digest truncated to fit; call recall for more)';

function countsLine(counts: Record<string, number>, order: string[]): string {
  const parts: string[] = [];
  for (const k of order) if (counts[k]) parts.push(`${k} ${counts[k]}`);
  for (const k of Object.keys(counts).sort()) if (!order.includes(k) && counts[k]) parts.push(`${k} ${counts[k]}`);
  return parts.join(' / ');
}

function renderSections(data: SharedNowData): string[][] {
  const ws = data.workstreams.map((w) => {
    const bits = [`#${w.id} ${clip(w.title, 80)}`, `turn=${w.turn}`];
    if (w.next_action) bits.push(`next: ${clip(w.next_action, 120)}${w.next_owner ? ` (${w.next_owner})` : ''}`);
    if (w.waiting_since) bits.push(`waiting since ${shortTs(w.waiting_since)}`);
    if (w.threads.length) bits.push(`threads: ${w.threads.join(', ')}`);
    return `- ${bits.join(' · ')}`;
  });
  const trees = data.trees.map((t) => {
    const bits = [`${t.id}`, t.status, clip(t.topic, 90)];
    if (t.origin_thread_ext) bits.push(`origin ${t.origin_thread_ext}`);
    if (t.branch || t.commit) bits.push(`${t.branch ? `branch ${t.branch}` : 'commit'}${t.commit ? ` @${t.commit}` : ''}`);
    const total = Object.values(t.counts).reduce((a, b) => a + b, 0);
    if (t.status === 'done') bits.push(`done ${t.counts.done ?? 0}/${total}`);
    else {
      const c = countsLine(t.counts, ['running', 'pending', 'blocked', 'blocked_question', 'done']);
      if (c) bits.push(c);
    }
    if (t.outcome) bits.push(`outcome: ${t.outcome}`);
    return `- ${bits.join(' · ')}`;
  });
  const goals = data.goals.map((g) => {
    const bits = [`#${g.id} ${clip(g.title, 90)}`, g.status];
    if (g.focus_path) bits.push(`focus: ${g.focus_path}`);
    const c = countsLine(g.counts, ['set', 'ghost', 'planned', 'working', 'check', 'done', 'parked']);
    if (c) bits.push(`nodes ${c}`);
    if (g.thread_ext) bits.push(`chat ${g.thread_ext}`);
    return `- ${bits.join(' · ')}`;
  });
  const commitments = data.commitments.map((c) => {
    const bits = [`#${c.id} ${c.subject}`, `due ${shortTs(c.due_at)}`];
    if (c.thread_ext) bits.push(`thread ${c.thread_ext}`);
    return `- ${bits.join(' · ')}`;
  });
  const summaries = data.summaries.map(
    (s) => `- [${s.external_id}] ${s.title}${s.one_liner ? ` — ${s.one_liner}` : ''} (${shortTs(s.created_at)})`,
  );
  const none = ['- (none)'];
  // Credential scrub before the budget maths (redactSecrets never lengthens):
  // next_action / node results / summary one-liners are free text Kevin has
  // pasted keys into. See src/redact.ts.
  const scrub = (lines: string[]) => lines.map(redactSecrets);
  return [
    [`## Workstreams (${data.workstreams.length} open)`, ...(ws.length ? scrub(ws) : none)],
    [`## Trees (last 7 days, ${data.trees.length})`, ...(trees.length ? scrub(trees) : none)],
    [`## Goals (${data.goals.length} open)`, ...(goals.length ? scrub(goals) : none)],
    [`## Commitments (open)`, ...(commitments.length ? scrub(commitments) : none)],
    [`## Recent thread summaries`, ...(summaries.length ? scrub(summaries) : none)],
  ];
}

export function renderSharedNow(data: SharedNowData, maxChars?: number): string {
  const cap = maxChars ?? sharedNowSettings().max_chars;
  const open = `<shared_now as_of="${data.as_of}" ttl_sec="${sharedNowSettings().ttl_sec}">`;
  const close = '</shared_now>';
  const sections = renderSections(data);
  const assemble = (truncated: boolean): string => {
    const body = sections.map((s) => s.join('\n')).join('\n');
    return [open, HEADER_TEXT, '', body, ...(truncated ? [TRUNCATION_FOOTER] : []), close].join('\n');
  };
  let text = assemble(false);
  if (text.length <= cap) {
    data.truncated = false;
    return text;
  }
  // Adversarial review (node #488): strict tail-first trimming starved the two
  // sections that answer Kevin's actual question. Measured against the live DB
  // the digest hit the 7,200-char cap and the trim wiped ALL 10 "Recent thread
  // summaries" and 3 of 4 commitments, while 12 hopper-tree bullets (with their
  // 140-char `outcome:` blobs) kept ~4,000 chars — i.e. the "where does X live"
  // evidence was dropped to preserve tree telemetry.
  //
  // Two phases now. PHASE 1 trims the LONGEST section that is still above its
  // floor, so the fattest section pays first. PHASE 2 (everything at its floor)
  // falls back to the contract's tail-first order.
  data.truncated = true;
  const floors = [3, 3, 2, 2, 3]; // workstreams, trees, goals, commitments, summaries
  const bulletCount = (sec: string[]) =>
    sec.filter((l, i) => i > 0 && l !== '- (none)' && l !== '- …').length;
  const sectionChars = (sec: string[]) => sec.join('\n').length;
  const dropLast = (sec: string[]): boolean => {
    if (sec.length <= 1) return false;
    const last = sec[sec.length - 1];
    if (last === '- (none)' || last === '- …') return false;
    sec.pop();
    if (sec.length === 1) sec.push('- …');
    return true;
  };
  const tailFirst = [4, 3, 2, 1, 0];
  let guard = 0;
  while (text.length > cap && guard++ < 500) {
    let dropped = false;
    // Phase 1 — fattest section above its floor.
    let fattest = -1;
    let fattestChars = -1;
    for (let i = 0; i < sections.length; i++) {
      if (bulletCount(sections[i]) <= floors[i]) continue;
      const chars = sectionChars(sections[i]);
      if (chars > fattestChars) {
        fattestChars = chars;
        fattest = i;
      }
    }
    if (fattest >= 0) dropped = dropLast(sections[fattest]);
    // Phase 2 — everything is at its floor; fall back to tail-first.
    if (!dropped) {
      for (const idx of tailFirst) {
        if (dropLast(sections[idx])) {
          dropped = true;
          break;
        }
      }
    }
    if (!dropped) break;
    text = assemble(true);
  }
  if (text.length > cap) {
    // Pathological cap (smaller than the fixed header): hard-slice the body
    // but keep the footer + closing tag intact so the block still parses.
    const tail = '\n' + TRUNCATION_FOOTER + '\n' + close;
    text = text.slice(0, Math.max(0, cap - tail.length)).trimEnd() + tail;
  }
  return text;
}

// -- cache ---------------------------------------------------------------------

let cache: { at: number; text: string; data: SharedNowData } | null = null;

export function invalidateSharedNow(): void {
  cache = null;
}

export function getSharedNowSnapshot(opts?: { force?: boolean }): { as_of: string; text: string; data: SharedNowData; cached: boolean } {
  const ttlMs = sharedNowSettings().ttl_sec * 1000;
  const now = Date.now();
  if (!opts?.force && cache && now - cache.at < ttlMs) {
    return { as_of: cache.data.as_of, text: cache.text, data: cache.data, cached: true };
  }
  const data = collectSharedNow();
  const text = renderSharedNow(data);
  cache = { at: now, text, data };
  return { as_of: data.as_of, text, data, cached: false };
}

export function buildSharedNow(opts?: { force?: boolean }): string {
  return getSharedNowSnapshot(opts).text;
}

// -- injection decision (CONTRACT §1.5) ----------------------------------------

export function shouldInjectSharedNow(args: {
  externalId: string;
  turns: Array<{ role: string; created_at: string }>;
  nowMs?: number;
}): boolean {
  const s = sharedNowSettings();
  if (!s.enabled) return false;
  if (!isSharedNowEligibleThread(args.externalId, { workers: s.workers })) return false;
  const turns = args.turns ?? [];
  if (turns.length <= 1) return true;
  const prev = turns[turns.length - 2];
  const prevMs = parseSqliteUtc(prev?.created_at);
  if (prevMs == null) return false;
  const now = args.nowMs ?? Date.now();
  return now - prevMs >= s.reinject_min * 60_000;
}

export function sharedNowInjectionBlock(args: {
  externalId: string;
  turns: Array<{ role: string; created_at: string }>;
  nowMs?: number;
}): string {
  try {
    if (!shouldInjectSharedNow(args)) return '';
    return buildSharedNow() + '\n\n';
  } catch (err) {
    console.warn('[shared-now] injection skipped:', err instanceof Error ? err.message : err);
    return '';
  }
}

// -- wiki mirror (CONTRACT §1.7) ----------------------------------------------

const DEFAULT_VAULT_ROOT = '/home/kevin/obsidian/paperclip-wiki';
const MIRROR_REL_PATH = join('agent-memory', 'jarvis', 'now.md');
let lastMirrorHash: string | null = null;

function bodyHash(text: string): string {
  return createHash('sha1').update(text.replace(/as_of="[^"]*"/, 'as_of=""')).digest('hex');
}

export function writeSharedNowMirror(vaultRoot: string = DEFAULT_VAULT_ROOT): { path: string; written: boolean } | null {
  try {
    const snap = getSharedNowSnapshot({ force: true });
    const path = join(vaultRoot, MIRROR_REL_PATH);
    const hash = bodyHash(snap.text);
    if (lastMirrorHash === null && existsSync(path)) {
      // Cold start: compare against what's already on disk so a restart
      // doesn't rewrite an identical file.
      try {
        const existing = readFileSync(path, 'utf8');
        const m = /<shared_now[\s\S]*<\/shared_now>/.exec(existing);
        if (m) lastMirrorHash = bodyHash(m[0]);
      } catch {
        /* unreadable → just write */
      }
    }
    if (lastMirrorHash === hash) return { path, written: false };
    const content = [
      '# JARVIS — Shared Now (auto-mirrored every 10 min; DO NOT EDIT — generated by darwin-assistant src/shared-context.ts)',
      '',
      `_as of ${snap.as_of} · live: GET /api/v1/shared-context/now_`,
      '',
      snap.text,
      '',
    ].join('\n');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
    lastMirrorHash = hash;
    return { path, written: true };
  } catch (err) {
    console.warn('[shared-now] mirror write failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

let mirrorTimer: NodeJS.Timeout | null = null;

export function startSharedNowMirror(): void {
  if (mirrorTimer) return;
  const minutes = sharedNowSettings().mirror_min;
  if (minutes <= 0) {
    console.log('[shared-now] wiki mirror disabled (shared_now_mirror_min=0)');
    return;
  }
  const first = setTimeout(() => {
    const r = writeSharedNowMirror();
    if (r?.written) console.log(`[shared-now] mirrored digest to ${r.path}`);
  }, 20_000);
  first.unref();
  mirrorTimer = setInterval(() => {
    // Re-read the period each tick so a settings change takes effect without a restart.
    if (sharedNowSettings().mirror_min <= 0) return;
    const r = writeSharedNowMirror();
    if (r?.written) console.log(`[shared-now] mirrored digest to ${r.path}`);
  }, minutes * 60_000);
  mirrorTimer.unref();
  console.log(`[shared-now] wiki mirror every ${minutes} min → ${join(DEFAULT_VAULT_ROOT, MIRROR_REL_PATH)}`);
}
