#!/usr/bin/env node
/**
 * improver-export.mjs — sanitized telemetry snapshot for jarvis-improver.
 *
 *   node scripts/improver-export.mjs --db <jarvis.db> --out <snapshot.jsonl> [--days 7] [--repo <git dir>]
 *
 * Writes one JSON event per line in the schema jarvis-improver consumes
 * (KEatonDarwin/jarvis-improver docs/SPEC.md §2 — the miner):
 *   {"id","ts","kind","job_id","thread_id","model","exit_code","error_excerpt",
 *    "tokens_in","tokens_out","wall_ms","harness_commit"}
 *
 * Standalone on purpose: plain Node ESM + better-sqlite3, no server imports, so it
 * runs with jarvis.service down. The db is opened READ-ONLY. Exit 2 = bad usage.
 *
 * Sources (all bounded to the last --days by their timestamp column, UTC):
 *   worker_fail  hopper_nodes whose status is blocked / blocked_question / failed /
 *                error, or whose result opens "VERDICT: FAIL". Excerpt =
 *                result for a FAIL verdict (result_summary is a layman paraphrase),
 *                else result_summary, else question, else result. Tokens/wall summed from
 *                the worker thread's turns. thread_id falls back to the tree's origin.
 *   watchdog     watch_events (the only table scripts/jarvis-watchdog.py writes
 *                alarms to — it upserts one row per (sentinel, subject_key)), rows
 *                with severity error|warning whose state isn't a healthy one.
 *                dead_turn subject_key "<conversation_id>:<turn_index>" → turn-<id>.
 *   waste        turns whose prompt tokens exceed the window's p95 (nearest-rank,
 *                computed in SQL over every turn with input_tokens in the window).
 *                "Prompt tokens" = input_tokens + cache_read_tokens + cache_write_tokens
 *                when those columns exist: raw input_tokens excludes cached context
 *                (live p95 was ~226), so alone it can't see a bloated prompt.
 *                tokens_in on every event uses the same sum.
 *   stall        turns whose timing_ms (wall-clock duration column) > 10 min.
 *   correction   not exported in v0 (no source).
 *
 * Sanitization: every free-text field goes through scrub() — tokens, bearer/basic
 * auth, credential assignments, URL userinfo, any "password" mention, non-Darwin
 * emails, 20+ char hex runs and key-shaped base64 runs — then is cut to 2000 chars.
 * Excerpts are still UNTRUSTED data downstream (prompt-injection), per the spec.
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_EXCERPT = 2000;
export const STALL_MS = 10 * 60 * 1000;
const FAIL_STATUSES = ['blocked', 'blocked_question', 'failed', 'error'];
const HEALTHY_WATCH_STATES = ['ok', 'flowing', 'active', 'resolved', 'recovered'];

/** Key-shaped base64/alnum run: 20+ chars with digits and either mixed case or no separators. */
function looksLikeKey(run) {
  if (/^[0-9a-fA-F]+$/.test(run)) return false; // pure hex is the hex rule's job (incl. its kept-SHA exemption)
  const digits = (run.match(/\d/g) || []).length;
  if (digits < 3 || !/[A-Za-z]/.test(run)) return false;
  return (/[A-Z]/.test(run) && /[a-z]/.test(run)) || !/[-_]/.test(run);
}

/** Redact secrets/PII from free text and truncate. Exported for tests. */
export function scrub(input, max = MAX_EXCERPT) {
  if (input === null || input === undefined) return null;
  let s = String(input).slice(0, max * 10);
  // PEM private-key blocks (whole block, even if the END marker was truncated off)
  s = s.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[REDACTED_PEM]');
  // URL userinfo: scheme://userinfo@host — greedy to the LAST @ before whitespace, so
  // passwords containing '@' or '/' are fully covered (redis://u:p@ss@host, mongodb+srv://u:a/b@host)
  s = s.replace(/([a-z][a-z0-9+.-]*:\/\/)\S+@/gi, '$1[REDACTED_CREDS]@');
  // JWTs: three dot-separated base64url segments starting eyJ — no length floor (short/dev JWTs leak too)
  s = s.replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]');
  // AWS key ids: fixed 4-char prefix + 16 of [A-Z0-9] (often <3 digits, so the generic rules miss them)
  s = s.replace(/\b(?:AKIA|ASIA|AIDA|AROA|AGPA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]');
  // AWS-style 40-char secrets: exactly 40 of base64-ish incl. '/', mixed case + a digit
  s = s.replace(/(?<![A-Za-z0-9+\/=])[A-Za-z0-9+\/]{40}(?![A-Za-z0-9+\/=])/g, (m) =>
    (/[A-Z]/.test(m) && /[a-z]/.test(m) && /\d/.test(m) ? '[REDACTED_KEY40]' : m));
  // Provider token shapes (OpenAI/Anthropic sk-, GitHub gho_/ghp_, Slack xox*, JWTs)
  s = s.replace(/\b(sk|gho|ghp|xoxb|xoxp|eyJ[A-Za-z0-9_-]{20,})[A-Za-z0-9_\-\.]{8,}/g, '[REDACTED_TOKEN]');
  // Authorization schemes
  s = s.replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]');
  s = s.replace(/\bBasic\s+[A-Za-z0-9+\/]{8,}={0,2}/g, 'Basic [REDACTED]');
  s = s.replace(/\bJWT\s+[A-Za-z0-9_\-\.]{8,}/g, 'JWT [REDACTED]');
  // NAME=value / "name": "value" where the name smells like a credential
  s = s.replace(
    /[A-Za-z0-9_.\-]*(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|key)["']?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
    '[REDACTED_SECRET]',
  );
  // Any remaining password mention, plus its value when phrased "password is X" / "pwd: X"
  s = s.replace(/[A-Za-z0-9_.\-]*(?:pass(?:word|wd)|\bpwd\b)[A-Za-z0-9_.\-]*["']?(?:\s*(?:is|was|=|:|->)\s*("[^"]*"|'[^']*'|\S+))?/gi, '[REDACTED_PASSWORD]');
  // Emails except our own domain
  s = s.replace(/[A-Za-z0-9._%+\-]+@([A-Za-z0-9.\-]+\.[A-Za-z]{2,})/g, (m, dom) =>
    /(^|\.)darwininvestornetwork\.com$/i.test(dom) ? m : '[REDACTED_EMAIL]');
  // Long hex runs (keys, hashes, session ids) — but keep a 40-hex git SHA when the
  // surrounding text says that's what it is (useful signal for the improver's miner)
  s = s.replace(/\b[0-9a-fA-F]{20,}\b/g, (m, off, str) =>
    (m.length === 40 && /(?:commit|sha1?|rev(?:ision)?)[\s:=#'"-]*$/i.test(str.slice(Math.max(0, off - 16), off)) ? m : '[REDACTED_HEX]'));
  // Key-shaped base64 runs (incl. '/' so slash-bearing secrets don't split under the 20-char floor)
  s = s.replace(/[A-Za-z0-9+\/_\-]{20,}={0,2}/g, (m) => (looksLikeKey(m) ? '[REDACTED_B64]' : m));
  return s.length > max ? s.slice(0, max) : s;
}

/** sqlite "YYYY-MM-DD HH:MM:SS" (UTC) → ISO-8601 Z. */
function toIso(ts) {
  if (!ts) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${String(ts).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function exitCodeFrom(text) {
  const m = /exit(?:ed)?(?: with)?(?: code| status)\s*[:=]?\s*(-?\d{1,3})\b/i.exec(text || '');
  return m ? Number(m[1]) : null;
}

const intOrNull = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Math.trunc(Number(v)));

function harnessCommit(repoDir) {
  try {
    return execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function tableCols(db, table) {
  return new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((r) => r.name));
}

function event(kind, rowKey, f, commit) {
  const excerpt = scrub(f.error_excerpt) ?? '';
  return {
    id: `evt_${kind}_${rowKey}`,
    ts: toIso(f.ts),
    kind,
    job_id: f.job_id,
    thread_id: scrub(f.thread_id, 200),
    model: scrub(f.model, 200),
    exit_code: f.exit_code ?? exitCodeFrom(excerpt),
    error_excerpt: excerpt,
    tokens_in: intOrNull(f.tokens_in),
    tokens_out: intOrNull(f.tokens_out),
    wall_ms: intOrNull(f.wall_ms),
    harness_commit: commit,
  };
}

/** Collect events from an open (read-only) db. Returns { events, counts, notes }. */
export function collectEvents(db, { days = 7, commit = 'unknown' } = {}) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const events = [];
  const notes = [];

  const turnCols = tableCols(db, 'turns');
  const promptTokens = (a) => ['input_tokens', 'cache_read_tokens', 'cache_write_tokens']
    .filter((c) => turnCols.has(c)).map((c, i) => (i ? `COALESCE(${a}.${c}, 0)` : `${a}.${c}`)).join(' + ') || 'NULL';

  // ── worker_fail ─────────────────────────────────────────────────────────
  const nodeCols = tableCols(db, 'hopper_nodes');
  if (nodeCols.size) {
    const has = (c) => nodeCols.has(c);
    const hasTrees = tableCols(db, 'hopper_trees').has('origin_thread_ext');
    const hasTurns = turnCols.has('conversation_id');
    const tokenJoin = hasTurns
      ? `(SELECT SUM(${promptTokens('t')}) FROM turns t JOIN conversations c ON c.id = t.conversation_id WHERE c.external_id = n.worker_thread_ext) AS tokens_in,
         (SELECT SUM(t.output_tokens) FROM turns t JOIN conversations c ON c.id = t.conversation_id WHERE c.external_id = n.worker_thread_ext) AS tokens_out,
         (SELECT SUM(t.timing_ms) FROM turns t JOIN conversations c ON c.id = t.conversation_id WHERE c.external_id = n.worker_thread_ext AND t.role = 'assistant') AS wall_ms`
      : 'NULL AS tokens_in, NULL AS tokens_out, NULL AS wall_ms';
    const rows = db.prepare(`
      SELECT n.id, n.status, n.updated_at, ${has('model') ? 'n.model' : 'NULL'} AS model,
             n.worker_thread_ext, ${hasTrees ? 't.origin_thread_ext' : 'NULL'} AS origin_thread_ext,
             ${has('result_summary') ? 'n.result_summary' : 'NULL'} AS result_summary,
             n.question, n.result, ${tokenJoin}
      FROM hopper_nodes n ${hasTrees ? 'LEFT JOIN hopper_trees t ON t.id = n.tree_id' : ''}
      WHERE n.updated_at >= ?
        AND (n.status IN (${FAIL_STATUSES.map(() => '?').join(',')}) OR n.result LIKE 'VERDICT: FAIL%')
      ORDER BY n.updated_at`).all(cutoff, ...FAIL_STATUSES);
    for (const r of rows) {
      const verdictFail = /^VERDICT: FAIL/.test(r.result ?? '');
      const text = (verdictFail ? [r.result] : [r.result_summary, r.question, r.result]).find((x) => x && String(x).trim())
        ?? `hopper node ${r.status} with no result recorded`;
      events.push(event('worker_fail', r.id, {
        ts: r.updated_at, job_id: `node-${r.id}`, thread_id: r.worker_thread_ext || r.origin_thread_ext || null,
        model: r.model, error_excerpt: text, tokens_in: r.tokens_in, tokens_out: r.tokens_out, wall_ms: r.wall_ms,
      }, commit));
    }
  } else notes.push('worker_fail skipped: no hopper_nodes table');

  // ── watchdog ────────────────────────────────────────────────────────────
  if (tableCols(db, 'watch_events').size) {
    const rows = db.prepare(`
      SELECT w.id, w.sentinel, w.subject_key, w.state, w.severity, w.message, w.updated_at,
             c.external_id AS thread_ext, c.thread_model AS model, tu.id AS turn_id
      FROM watch_events w
      LEFT JOIN conversations c ON w.sentinel = 'dead_turn' AND c.id = CAST(substr(w.subject_key, 1, instr(w.subject_key, ':') - 1) AS INTEGER)
      LEFT JOIN turns tu ON tu.id = (SELECT id FROM turns WHERE conversation_id = c.id
                                     AND turn_index = CAST(substr(w.subject_key, instr(w.subject_key, ':') + 1) AS INTEGER)
                                     ORDER BY id LIMIT 1)
      WHERE w.updated_at >= ? AND w.severity IN ('error', 'warning')
        AND w.state NOT IN (${HEALTHY_WATCH_STATES.map(() => '?').join(',')})
      ORDER BY w.updated_at`).all(cutoff, ...HEALTHY_WATCH_STATES);
    for (const r of rows) {
      events.push(event('watchdog', r.id, {
        ts: r.updated_at,
        job_id: r.turn_id ? `turn-${r.turn_id}` : `watch-${r.sentinel}-${r.subject_key}`,
        thread_id: r.thread_ext ?? null, model: r.model ?? null,
        error_excerpt: `watchdog ${r.sentinel} ${r.state} (${r.severity})\n${r.message ?? ''}`,
      }, commit));
    }
  } else notes.push('watchdog skipped: no watch_events table');

  // ── waste + stall (turns) ───────────────────────────────────────────────
  const turnSelect = (extraWhere) => `
    SELECT tu.id, tu.created_at, tu.role, ${turnCols.has('tool_name') ? 'tu.tool_name' : 'NULL'} AS tool_name,
           COALESCE(tu.model, c.thread_model) AS model, c.external_id AS thread_ext,
           ${promptTokens('tu')} AS input_tokens, tu.output_tokens, tu.timing_ms,
           ${turnCols.has('error_detail') ? 'tu.error_detail' : 'NULL'} AS error_detail
    FROM turns tu LEFT JOIN conversations c ON c.id = tu.conversation_id
    WHERE tu.created_at >= ? ${extraWhere} ORDER BY tu.created_at`;
  const turnEvent = (kind, r, summary) => event(kind, r.id, {
    ts: r.created_at, job_id: `turn-${r.id}`, thread_id: r.thread_ext ?? null, model: r.model,
    error_excerpt: r.error_detail && String(r.error_detail).trim() ? r.error_detail : summary,
    tokens_in: r.input_tokens, tokens_out: r.output_tokens, wall_ms: r.timing_ms,
  }, commit);
  const what = (r) => `${r.role}${r.tool_name ? ` ${r.tool_name}` : ''}`;

  if (turnCols.has('input_tokens')) {
    const p95 = db.prepare(`
      WITH w AS (SELECT ${promptTokens('t')} v, ROW_NUMBER() OVER (ORDER BY ${promptTokens('t')}) rn, COUNT(*) OVER () n
                 FROM turns t WHERE t.input_tokens IS NOT NULL AND t.created_at >= ?)
      SELECT v FROM w WHERE rn = (n * 95 + 99) / 100`).get(cutoff)?.v;
    if (p95 !== undefined) {
      for (const r of db.prepare(turnSelect(`AND tu.input_tokens IS NOT NULL AND ${promptTokens('tu')} > ?`)).all(cutoff, p95)) {
        events.push(turnEvent('waste', r, `${what(r)} turn prompt tokens above window p95 (${p95})`));
      }
    }
  } else notes.push('waste skipped: turns has no input_tokens column');

  if (turnCols.has('timing_ms')) {
    for (const r of db.prepare(turnSelect('AND tu.timing_ms > ?')).all(cutoff, STALL_MS)) {
      events.push(turnEvent('stall', r, `${what(r)} turn ran past the ${STALL_MS}ms stall threshold`));
    }
  } else notes.push('stall skipped: turns has no timing_ms duration column');

  events.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
  const counts = { worker_fail: 0, watchdog: 0, stall: 0, waste: 0 };
  for (const e of events) counts[e.kind]++;
  return { events, counts, notes };
}

function parseArgs(argv) {
  const out = { days: 7 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--db') out.db = val();
    else if (a === '--out') out.out = val();
    else if (a === '--days') out.days = Number(val());
    else if (a === '--repo') out.repo = val();
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

const USAGE = 'usage: node scripts/improver-export.mjs --db <jarvis.db> --out <snapshot.jsonl> [--days 7] [--repo <git dir>]';

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`improver-export: ${e.message}\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) { console.log(USAGE); return; }
  if (!args.db) { console.error(`improver-export: --db is required\n${USAGE}`); process.exit(2); }
  if (!existsSync(args.db)) { console.error(`improver-export: --db file not found: ${args.db}`); process.exit(2); }
  if (!args.out) { console.error(`improver-export: --out is required\n${USAGE}`); process.exit(2); }
  if (!(args.days > 0)) { console.error('improver-export: --days must be a positive number'); process.exit(2); }
  if (resolve(args.out) === resolve(args.db)) { console.error('improver-export: --out must not be the --db file'); process.exit(2); }

  const repo = args.repo ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const db = new Database(args.db, { readonly: true, fileMustExist: true });
  let result;
  try {
    result = collectEvents(db, { days: args.days, commit: harnessCommit(repo) });
  } finally {
    db.close();
  }
  const tmp = `${args.out}.tmp-${process.pid}`;
  writeFileSync(tmp, result.events.map((e) => JSON.stringify(e)).join('\n') + (result.events.length ? '\n' : ''));
  renameSync(tmp, args.out);
  console.log(JSON.stringify({ out: args.out, days: args.days, total: result.events.length, counts: result.counts, notes: result.notes }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
