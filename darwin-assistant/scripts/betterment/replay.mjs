// Betterment lane — corpus REPLAY harness shared by score-memory.mjs and score-cache.mjs.
//
// Re-runs the memory/prompt assembly for every corpus turn, model-free, deterministic, offline.
// The LIVE assembler imports the real functions straight from src/*.ts (read-only use; the scripts
// run under the repo's own tsx loader — `npx tsx scripts/betterment/...` — so no compile step and
// no dist/ copy is involved). Paths mirror src/agent.ts handleMessage:
//   * session_position 0  → buildInitialPrompt(input, profile)  (memory rides in the system prompt)
//   * otherwise (resume)  → memoryRefreshForResume(conv, session, loadMemoryBlock(cap, profile)),
//                           baseline committed only when the turn was actually delivered
// The per-turn context prefix (thread line, autonomy dial, goal/shift blocks…) is NOT replayed —
// those are not memory assembly and need live state; the resume prompt is `<refresh block>\n\n<input>`.
//
// Hermetic: every src path the assembly touches is pointed at scratch (scratch jarvis.db, scratch
// memory-injection state, scratch CLAUDE_CONFIG_DIR, a CLI cwd slug that exists nowhere) BEFORE the
// modules load, and `new Date()` is frozen to each turn's recorded created_at. No model, no network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function readCorpus(dir) {
  const lines = fs.readFileSync(path.join(dir, 'corpus.jsonl'), 'utf8').split('\n').filter(Boolean);
  return {
    dir,
    records: lines.map((l) => JSON.parse(l)),
    meta: JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')),
    checklist: JSON.parse(fs.readFileSync(path.join(dir, 'facts-checklist.json'), 'utf8')).markers,
    memoryFile: path.join(dir, 'memory-snapshot.md'),
    workerCoreFile: path.join(dir, 'worker-core-snapshot.md'),
  };
}

// ── frozen clock ────────────────────────────────────────────────────────────
const RealDate = globalThis.Date;
let frozenMs = null;
class ReplayDate extends RealDate {
  constructor(...args) { if (args.length === 0 && frozenMs !== null) super(frozenMs); else super(...args); }
  static now() { return frozenMs !== null ? frozenMs : RealDate.now(); }
}
const sqliteToMs = (ts) => RealDate.parse(`${String(ts).replace(' ', 'T')}Z`);

/** Run fn with `new Date()` / Date.now() pinned to a sqlite UTC timestamp. */
export function atTime(ts, fn) {
  const prevGlobal = globalThis.Date;
  const prevFrozen = frozenMs;
  frozenMs = sqliteToMs(ts);
  globalThis.Date = ReplayDate;
  try { return fn(); } finally { globalThis.Date = prevGlobal; frozenMs = prevFrozen; }
}

// ── live (src) assembly ─────────────────────────────────────────────────────
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'betterment-replay-'));
const CLI_CWD = path.join(SCRATCH, 'no-such-cli-cwd');
const SLUG = CLI_CWD.replace(/[^A-Za-z0-9]/g, '-');
let srcModules = null;

async function loadSrc() {
  if (srcModules) return srcModules;
  Object.assign(process.env, {
    JARVIS_SIM: '1',
    JARVIS_DB_PATH: path.join(SCRATCH, 'jarvis.db'),
    JARVIS_CLI_CWD: CLI_CWD,
    JARVIS_DEBUG_SPOOL_DIR: path.join(SCRATCH, 'spool'),
    // agent.ts warms model shelves at import; point every CLI at nothing so zero processes start.
    CODEX_BIN: path.join(SCRATCH, 'no-such-codex'),
    AUGGIE_BIN: path.join(SCRATCH, 'no-such-auggie'),
    DEVIN_BIN: path.join(SCRATCH, 'no-such-devin'),
    CLAUDE_BIN: path.join(SCRATCH, 'no-such-claude'),
    CLAUDE_CONFIG_DIR: path.join(SCRATCH, 'claude-config-unset'),
  });
  const prompt = await import('../../src/prompt.ts');
  const diet = await import('../../src/token-diet.ts');
  const agent = await import('../../src/agent.ts');
  const cdb = await import('../../src/conversation-db.ts');
  srcModules = { ...prompt, ...diet, buildInitialPrompt: agent.buildInitialPrompt, buildContinuationPrompt: agent.buildContinuationPrompt, setSetting: cdb.setSetting, getSetting: cdb.getSetting };
  return srcModules;
}

/** Fresh per-replay scratch state (memory-injection baselines + fake CLI session files). */
function freshRun(corpus) {
  const run = fs.mkdtempSync(path.join(SCRATCH, 'run-'));
  process.env.JARVIS_MEMORY_FILE = corpus.memoryFile;
  process.env.JARVIS_WORKER_CORE_FILE = corpus.workerCoreFile;
  process.env.JARVIS_MEMORY_STATE_DIR = path.join(run, 'memory-injections');
  process.env.CLAUDE_CONFIG_DIR = path.join(run, 'claude-config');
  return run;
}

/**
 * The CURRENT live behaviour. An assembler is `{ name, begin(corpus), assemble(rec, session) }`;
 * assemble returns { memory, prompt } — `memory` is exactly the memory text injected this turn,
 * `prompt` the assembled stdin. `session` holds the replay's own per-session scratch (`id`, `seq`).
 */
export async function liveAssembler() {
  const src = await loadSrc();
  const capCache = new Map();
  // Resume-path cap: agent.ts uses 12k chars when contextWindowTokensFor(adapter, model) ≤ 128k. That
  // helper is private, so probe the exported continuation builder (same helper, same rule) once per pair.
  const resumeCap = (adapter, model) => {
    const k = `${adapter}|${model}`;
    if (!capCache.has(k)) {
      const p = src.buildContinuationPrompt([], 'probe', adapter, model, { memoryProfile: 'full' });
      capCache.set(k, p.includes('_(memory truncated to 12000 chars') ? 12_000 : undefined);
    }
    return capCache.get(k);
  };
  return {
    name: 'live',
    begin(corpus) {
      freshRun(corpus);
      for (const [k, v] of Object.entries(corpus.meta.live_settings || {})) if (v !== null) src.setSetting(k, v);
    },
    assemble(rec, session) {
      return atTime(rec.created_at, () => {
        const input = rec.input_excerpt;
        if (rec.session_position === 0) {
          return { path: 'initial', memory: src.loadMemoryBlock(undefined, rec.memory_profile), prompt: src.buildInitialPrompt(input, rec.memory_profile) };
        }
        // The CLI session file is what token-diet.ts reads for the compaction count. Claude sessions get
        // one written with the observed number of boundaries; other adapters have none (→ always full).
        if (rec.adapter === 'claude') {
          const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', SLUG);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${session.id}.jsonl`),
            '{"type":"user"}\n' + '{"type":"system","subtype":"compact_boundary"}\n'.repeat(rec.compactions_before));
        }
        const r = src.memoryRefreshForResume(rec.conversation_id, session.id, src.loadMemoryBlock(resumeCap(rec.adapter, rec.model), rec.memory_profile));
        if (rec.delivered) r.commit();
        return { path: 'resume', memory: r.block, prompt: `${r.block}\n\n${input}` };
      });
    },
  };
}

/** Replay every record in corpus order. Returns per-session ordered results. */
export function replayCorpus(corpus, assembler) {
  assembler.begin(corpus);
  const sessions = new Map();
  const turns = [];
  for (const rec of corpus.records) {
    let s = sessions.get(rec.session_key);
    if (!s) { s = { id: `replay-${rec.session_key}`, key: rec.session_key, thread_class: rec.thread_class, memory_profile: rec.memory_profile, turns: [] }; sessions.set(rec.session_key, s); }
    const out = assembler.assemble(rec, s);
    const t = { rec, path: out.path ?? null, memory: out.memory, prompt: out.prompt };
    s.turns.push(t);
    turns.push(t);
  }
  return { sessions: [...sessions.values()], turns };
}

/** Load a candidate assembler module (`export async function createAssembler()`), or the live one. */
export async function resolveAssembler(modulePath) {
  if (!modulePath) return liveAssembler();
  const mod = await import(path.resolve(modulePath));
  return mod.createAssembler({ liveAssembler, atTime });
}

export function parseCommonArgs(argv, defaults) {
  const a = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { if (i + 1 >= argv.length) throw new Error(`${k} needs a value`); return argv[++i]; };
    if (k === '--corpus') a.corpus = v();
    else if (k === '--assembler') a.assembler = v();
    else throw new Error(`unknown arg ${k}`);
  }
  return a;
}

export function cleanupScratch() {
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
}
