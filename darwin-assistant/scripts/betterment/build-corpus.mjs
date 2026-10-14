// Betterment lane — REPLAY CORPUS builder (tree-a0046db1 node #1668).
//
//   npx tsx scripts/betterment/build-corpus.mjs --db <COPY of jarvis.db> [--out <dir>]
//        [--memory <memory.md>] [--worker-core <worker-core.md>] [--reseed-checklist]
//
// Selects ~200 representative recent USER turns (each one = one memory/prompt assembly in
// src/agent.ts) across thread classes and records the inputs the assembly needs:
// thread class, memory profile, session position, compaction state, prior-turn marker,
// adapter/model, timestamp and a scrubbed input excerpt. Output (all under --out):
//   corpus.jsonl            one record per replayed turn, in replay order
//   meta.json               selection parameters + the live memory settings that steer token-diet.ts
//   memory-snapshot.md      frozen copy of the memory file the replay injects (deterministic scoring)
//   worker-core-snapshot.md frozen copy of worker-core.md
//   facts-checklist.json    load-bearing markers the FULL profile must keep (seeded once; kept on rebuild)
//
// Determinism: the window is anchored to MAX(turns.created_at) in the db (never Date.now), every
// query orders by stable keys, and meta.json carries no wall-clock. Same db copy → identical bytes.
// The db is opened {readonly, fileMustExist} + query_only — point it at a COPY, never the live file.
// Every free-text field goes through scrub() from scripts/improver-export.mjs (not re-implemented).
//
// Session/compaction inference (jarvis.db only keeps the CURRENT claude_session_id, so):
//   * a conversation = one CLI session; session_position = this user turn's index in the conversation.
//   * a context reset (auto-compaction or a fresh session) = a model call whose total context
//     (input + cache_read + cache_write) is < 50% of the previous call's, when that was ≥ 60k tokens.
//     compactions_before = resets observed on calls BEFORE this turn's first call — what the CLI
//     session file would show when agent.ts decides what memory to inject.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { scrub } from '../improver-export.mjs';
import { memoryProfileForThread } from '../../src/prompt.ts';

export const DEFAULT_OUT = '/home/kevin/jarvis-betterment/corpus';
export const LIVE_MEMORY = '/home/kevin/obsidian/paperclip-wiki/agent-memory/jarvis/memory.md';
export const LIVE_WORKER_CORE = '/home/kevin/obsidian/paperclip-wiki/agent-memory/jarvis/worker-core.md';
export const WINDOW_DAYS = 14;
export const PER_CONVERSATION_CAP = 20;
export const QUOTAS = { interactive: 90, worker: 50, goal: 40, other: 20 }; // ≈200 turns
export const MEMORY_SETTINGS = ['memory_dedupe', 'memory_full_every_turns', 'claude_autocompact_tokens'];
const RESET_MIN_CTX = 60_000;
const RESET_RATIO = 0.5;

// 5 section headings + 20 distinctive literals from the live memory file (sampled 2026-10-14).
export const SEED_MARKERS = [
  '# 🧭 BOX IDENTITY', '# 🚨 NON-NEGOTIABLES', '# 🤝 AUTONOMY & VOICE', '# 🌳 THE ENGINE', '# 📌 CURRENT STATE',
  'hub1q', 'work switch', 'NO API KEYS', 'CODE RED', 'php artisan test', 'kuojrvfdjjqhqyvkuiam',
  'jarvis.service', 'ntfy', 'Flight Deck', 'rate_change_log', 'force-push', 'Kevin deploys', 'log_bin',
  'jarvis-db-guard', 'Phoenix9', 'tdhmike_dhub', 'PAPERCLIP THE ISSUE TRACKER IS DEAD', 'SHORT AND PLAIN',
  'CLAUDE B', 'depends_on',
];

export function threadClass(externalId) {
  const e = externalId || '';
  if (e.startsWith('cockpit:hopper-node-') || e.startsWith('cockpit:unblocker-')) return 'worker';
  if (e.startsWith('cockpit:goal-')) return 'goal';
  if (e.startsWith('cockpit:shift-') || e.startsWith('cockpit:night-shift') || e.startsWith('ephemeral:')) return 'other';
  if (e.startsWith('cockpit:') || e.startsWith('slack:')) return 'interactive';
  return 'other';
}

const adapterFor = (conv, model) => conv.session_adapter || conv.thread_adapter
  || (model && /^(gpt|o\d)/.test(model) ? 'codex' : 'claude');

/** Build the corpus in memory. Pure function of the db contents. */
export function buildCorpus(db, { quotas = QUOTAS, windowDays = WINDOW_DAYS, perConversationCap = PER_CONVERSATION_CAP } = {}) {
  const anchor = db.prepare('SELECT MAX(created_at) AS m FROM turns').get().m;
  if (!anchor) throw new Error('turns table is empty');
  const since = db.prepare(`SELECT datetime(?, ?) AS s`).get(anchor, `-${windowDays} days`).s;

  const convs = db.prepare(`
    SELECT c.id, c.external_id, c.session_adapter, c.thread_adapter, c.thread_model,
           MAX(t.created_at) AS last_user_at
      FROM conversations c JOIN turns t ON t.conversation_id = c.id
     WHERE t.role = 'user' AND t.created_at >= ?
     GROUP BY c.id
     ORDER BY last_user_at DESC, c.id DESC`).all(since);

  const turnsOf = db.prepare(`
    SELECT id, turn_index, role, content, created_at, input_tokens, cache_read_tokens, cache_write_tokens,
           model, error_detail
      FROM turns WHERE conversation_id = ? ORDER BY turn_index ASC, id ASC`);

  const picked = { interactive: [], worker: [], goal: [], other: [] };
  for (const conv of convs) {
    const cls = threadClass(conv.external_id);
    const room = quotas[cls] - picked[cls].length;
    if (room <= 0) continue;
    const rows = turnsOf.all(conv.id);
    // Walk the whole conversation once: user-turn positions, delivery, context resets.
    const userTurns = [];
    let resets = 0;
    let prevCtx = null;
    let cur = null;
    for (const r of rows) {
      if (r.role === 'user') {
        cur = { row: r, position: userTurns.length, compactions_before: resets, first_model: null, delivered: false };
        userTurns.push(cur);
        continue;
      }
      if (r.input_tokens !== null && r.input_tokens !== undefined) {
        const ctx = (r.input_tokens || 0) + (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0);
        if (prevCtx !== null && prevCtx >= RESET_MIN_CTX && ctx < prevCtx * RESET_RATIO) resets++;
        prevCtx = ctx;
        if (cur && cur.first_model === null) cur.first_model = r.model || null;
      }
      if (cur && r.role === 'assistant' && !(r.error_detail && String(r.error_detail).trim())) cur.delivered = true;
    }
    const inWindow = userTurns.filter((u) => u.row.created_at >= since);
    const slice = inWindow.slice(-Math.min(perConversationCap, room));
    for (const u of slice) {
      const prior = u.position > 0 ? userTurns[u.position - 1] : null;
      const model = u.first_model || conv.thread_model || null;
      picked[cls].push({
        session_key: `c${conv.id}`,
        conversation_id: conv.id,
        external_id: scrub(conv.external_id, 200),
        thread_class: cls,
        memory_profile: memoryProfileForThread(conv.external_id),
        session_position: u.position,
        compactions_before: u.compactions_before,
        prior_turn: prior ? { present: true, delivered: prior.delivered } : { present: false, delivered: null },
        delivered: u.delivered,
        adapter: adapterFor(conv, model),
        model,
        created_at: u.row.created_at,
        input_chars: (u.row.content || '').length,
        input_excerpt: scrub(u.row.content ?? '', 2000) ?? '',
      });
    }
  }

  const records = [];
  for (const cls of Object.keys(quotas)) {
    for (const r of picked[cls]) records.push({ seq: records.length, ...r });
  }
  const settings = {};
  const hasSettings = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'`).get();
  for (const k of MEMORY_SETTINGS) {
    settings[k] = hasSettings ? (db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null) : null;
  }
  const perClass = Object.fromEntries(Object.keys(quotas).map((c) => [c, {
    turns: picked[c].length, sessions: new Set(picked[c].map((r) => r.session_key)).size,
  }]));
  const meta = {
    anchor, since, window_days: windowDays, per_conversation_cap: perConversationCap, quotas,
    records: records.length, per_class: perClass, live_settings: settings,
    reset_rule: { min_ctx_tokens: RESET_MIN_CTX, ratio: RESET_RATIO },
  };
  return { records, meta };
}

function parseArgs(argv) {
  const a = { out: DEFAULT_OUT, memory: LIVE_MEMORY, workerCore: LIVE_WORKER_CORE, reseed: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { if (i + 1 >= argv.length) throw new Error(`${k} needs a value`); return argv[++i]; };
    if (k === '--db') a.db = v();
    else if (k === '--out') a.out = v();
    else if (k === '--memory') a.memory = v();
    else if (k === '--worker-core') a.workerCore = v();
    else if (k === '--reseed-checklist') a.reseed = true;
    else throw new Error(`unknown arg ${k}`);
  }
  return a;
}

export function writeCorpus(args) {
  if (!args.db || !fs.existsSync(args.db)) throw new Error(`--db file not found: ${args.db}`);
  const db = new Database(args.db, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  let built;
  try { built = buildCorpus(db); } finally { db.close(); }

  fs.mkdirSync(args.out, { recursive: true });
  const memory = fs.readFileSync(args.memory, 'utf8');
  fs.writeFileSync(path.join(args.out, 'memory-snapshot.md'), memory, { mode: 0o600 });
  fs.copyFileSync(args.workerCore, path.join(args.out, 'worker-core-snapshot.md'));

  const checklistPath = path.join(args.out, 'facts-checklist.json');
  if (args.reseed || !fs.existsSync(checklistPath)) {
    fs.writeFileSync(checklistPath, JSON.stringify({ markers: SEED_MARKERS }, null, 2) + '\n');
  }
  const { markers } = JSON.parse(fs.readFileSync(checklistPath, 'utf8'));
  const missing = markers.filter((m) => !memory.includes(m));
  if (missing.length) throw new Error(`facts checklist markers absent from the memory snapshot: ${JSON.stringify(missing)}`);

  const tmp = path.join(args.out, `corpus.jsonl.tmp-${process.pid}`);
  fs.writeFileSync(tmp, built.records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.renameSync(tmp, path.join(args.out, 'corpus.jsonl'));
  fs.writeFileSync(path.join(args.out, 'meta.json'), JSON.stringify(built.meta, null, 2) + '\n');
  return built.meta;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(writeCorpus(parseArgs(process.argv.slice(2)))));
  } catch (e) {
    console.error(`build-corpus: ${e.message}`);
    process.exit(2);
  }
}
