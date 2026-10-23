/**
 * MIKE RADAR — pure parsers for the Lovable Watcher archive.
 *
 * Deliberately dependency-free (no DB, no SSE, no fs) so the whole thing is
 * unit-testable against fixture JSONL and can be re-run over the real 27 MB
 * archive in a second. Every shape here was measured against
 * /home/kevin/perclickity-suite/lovable-watch/archive/ on 2026-10-05 — see
 * DESIGN.md §1 for the counts these parsers are asserted against.
 *
 * THE THREE JOBS:
 *  1. `parseToolUses`  — the real change signal. Only 90 of 2,764 rows carry a
 *     `diff`, but 1,118 assistant rows carry `<lov-tool-use>` blocks whose
 *     `data=` JSON names the files/tables/functions that were touched.
 *  2. `normalizeDiff`  — the captured hunks, in FOUR wire shapes: a
 *     double-encoded JSON string, a plain object, a bare JSON array, and —
 *     contrary to DESIGN.md §1 fact 3 — plain **unified-diff text**, which is
 *     roughly half of the 90 diff-carrying rows and holds most of the hunks.
 *     Plus summary-only hunks (18 of 540 carry `{summary}` and no `lines`).
 *  3. `deriveHeadline` / `stripToolUses` — turning a 15 KB assistant message
 *     into a feed label and into an affordable report input.
 *
 * NOTHING here throws on bad input. A malformed line is the caller's problem
 * to count, not ours to crash on.
 */

// ---------------------------------------------------------------------------
// Raw archive row
// ---------------------------------------------------------------------------

/** One `<uuid>.jsonl` message line as the watcher wrote it. */
export interface ArchiveMessageRow {
  captured_at?: string;
  project_id?: string;
  /** Present on 17 rows — a free name source the watcher happened to capture. */
  project_name?: string;
  message_id?: string;
  role?: string;
  created_at?: string;
  text?: string;
  commit_sha?: string | null;
  diff?: unknown;
  edit_id?: string;
}

/** One `_new_projects.jsonl` line. NOTE: keyed `id`, not `project_id`. */
export interface ArchiveProjectMetaRow {
  id?: string;
  name?: string | null;
  description?: string | null;
  created_at?: string;
  captured_at?: string;
}

export type ArchiveLine =
  | { kind: 'message'; row: ArchiveMessageRow }
  | { kind: 'project_meta'; row: ArchiveProjectMetaRow }
  | { kind: 'bad'; raw: string; error: string };

/**
 * Classify one archive line. A project-metadata row is distinguished by having
 * `id` and no `role` (the watcher writes both shapes into the same tree).
 * Exactly one line in today's archive is not JSON at all (a 5-byte `EMPTY`);
 * it comes back as `kind:'bad'` so the sweep can count it and move on.
 */
export function classifyArchiveLine(raw: string): ArchiveLine | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    return { kind: 'bad', raw: trimmed.slice(0, 200), error: err instanceof Error ? err.message : String(err) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'bad', raw: trimmed.slice(0, 200), error: 'line is not a JSON object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.role === 'string' && typeof obj.message_id === 'string') {
    return { kind: 'message', row: obj as ArchiveMessageRow };
  }
  if (typeof obj.id === 'string' && obj.role === undefined) {
    return { kind: 'project_meta', row: obj as ArchiveProjectMetaRow };
  }
  return { kind: 'bad', raw: trimmed.slice(0, 200), error: 'unrecognised row shape' };
}

// ---------------------------------------------------------------------------
// <lov-tool-use> parsing
// ---------------------------------------------------------------------------

export type MikeChangeAction =
  | 'write'
  | 'edit'
  | 'delete'
  | 'migration'
  | 'edge_fn'
  | 'sql'
  | 'secret'
  | 'other';

export interface MikeChange {
  /** Normalised kind — what the feed groups and colours by. */
  action: MikeChangeAction;
  /** The raw Lovable tool name, e.g. `code--line_replace`. */
  tool: string;
  /** File path when the tool touched a file; null for migrations/SQL/secrets. */
  path: string | null;
  /** Short human hint (migration name, function names, first line of SQL). */
  note: string | null;
}

/** Which Lovable tools actually CHANGE something. Reads (`code--view`,
 *  `supabase--read_query`, `code--exec`, `lov-think`, `tool_search`, …) are
 *  deliberately absent: `change_count` must mean "Mike's agent modified
 *  something", not "the agent did a thing". Measured counts for these tools on
 *  2026-10-05 are asserted by scripts/mike-radar-parse-check.mjs. */
const TOOL_ACTIONS: Record<string, MikeChangeAction> = {
  'code--write': 'write',
  'lov-write': 'write',
  'code--line_replace': 'edit',
  'lov-line-replace': 'edit',
  'code--apply_patch': 'edit',
  'code--delete': 'delete',
  'lov-delete': 'delete',
  'lov-rename': 'edit',
  'supabase--migration': 'migration',
  'lov_database--migration': 'migration',
  'lov-supabase-migration': 'migration',
  'supabase--deploy_edge_functions': 'edge_fn',
  'lov-deploy-edge-functions': 'edge_fn',
  'supabase--run_sql': 'sql',
  'secrets--set_secret': 'secret',
  'secrets--update_secret': 'secret',
  'secrets--add_secret': 'secret',
  'lov-secret-form': 'secret',
};

/** Risk markers derived DETERMINISTICALLY from the day's actions — never from
 *  a model. `prod_sql` is `supabase--run_sql`: ad-hoc SQL against a live
 *  Supabase project is the single scariest thing in this archive. */
const ACTION_RISK: Partial<Record<MikeChangeAction, string>> = {
  migration: 'migration',
  secret: 'secret',
  edge_fn: 'edge_fn',
  sql: 'prod_sql',
};

export function riskFlagsFromChanges(changes: MikeChange[]): string[] {
  const flags = new Set<string>();
  for (const c of changes) {
    const flag = ACTION_RISK[c.action];
    if (flag) flags.add(flag);
  }
  return [...flags].sort();
}

/**
 * The tag matcher. Measured fact that makes this safe: the watcher's capture
 * escapes `>` as `&gt;` inside attribute values (610 occurrences), so a bare
 * `>` really does terminate the tag and `[^>]*` cannot run off the end.
 */
const TOOL_USE_TAG_RE = /<lov-tool-use\b([^>]*)>/g;
const ATTR_RE = /([a-zA-Z][\w-]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * Undo the attribute-level escaping: inside `data="…"` a structural JSON quote
 * is written `\"` and a literal backslash `\\`. One left-to-right pass is
 * exactly right — `\\\"` becomes `\` + `"` = `\"`, which is a JSON-escaped
 * quote inside a string value, i.e. still valid JSON.
 */
function unescapeAttr(value: string): string {
  return value.replace(/\\(["\\])/g, '$1');
}

const ENTITIES: Record<string, string> = {
  apos: "'",
  quot: '"',
  lt: '<',
  gt: '>',
  amp: '&',
};

/** `&amp;` is resolved last by construction (the regex sees the original text,
 *  so a decoded `&` can never be re-decoded into something else). */
export function decodeEntities(value: string): string {
  return value.replace(/&(apos|quot|lt|gt|amp|#x?[0-9a-fA-F]+);/g, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name.startsWith('#x') || name.startsWith('#X')
        ? parseInt(name.slice(2), 16)
        : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name] ?? whole;
  });
}

function attrsOf(tagBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(tagBody)) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

/** Parse a tool's `data=` attribute into an object. Two-step because `&quot;`
 *  does appear inside some payloads: try the plain backslash-unescape first
 *  (the common case, and entity-decoding it would corrupt genuine `&apos;`
 *  text), then fall back to entity-decoding before giving up. */
function parseToolData(rawAttr: string): Record<string, unknown> | null {
  const once = unescapeAttr(rawAttr);
  for (const candidate of [once, decodeEntities(once)]) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function str(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.trim();
    return t ? t : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function firstLine(value: string, max: number): string {
  const line = value.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.slice(0, max);
}

function noteFor(action: MikeChangeAction, data: Record<string, unknown> | null): string | null {
  if (!data) return null;
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = str(data[k]);
      if (v) return v;
    }
    return null;
  };
  switch (action) {
    case 'migration': {
      const sql = pick('query', 'sql', 'migration_sql');
      const name = pick('name', 'migration_name');
      if (name && sql) return `${name}: ${firstLine(sql, 120)}`;
      return name ?? (sql ? firstLine(sql, 160) : null);
    }
    case 'sql': {
      const sql = pick('query', 'sql');
      return sql ? firstLine(sql, 160) : null;
    }
    case 'edge_fn': {
      const names = data.function_names;
      if (Array.isArray(names)) {
        const list = names.map((n) => str(n)).filter((n): n is string => !!n);
        if (list.length) return list.join(', ').slice(0, 160);
      }
      return pick('function_names', 'function_name', 'name');
    }
    case 'secret':
      // Only the NAME, never the value — a secret value must not land in jarvis.db.
      return pick('secret_name', 'target_name', 'name', 'key');
    default:
      return pick('user_facing_description', 'description') ?? null;
  }
}

/**
 * Every change-producing tool call in one assistant message, in order.
 * Duplicate (action, path) pairs are collapsed — Lovable commonly issues a
 * dozen `code--line_replace` calls against the same file in one message and
 * the feed wants "edited src/x.tsx", not twelve rows.
 */
export function parseToolUses(text: string | null | undefined): MikeChange[] {
  if (!text) return [];
  const out: MikeChange[] = [];
  const seen = new Set<string>();
  TOOL_USE_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOOL_USE_TAG_RE.exec(text)) !== null) {
    const attrs = attrsOf(m[1]);
    const tool = attrs.name ? decodeEntities(unescapeAttr(attrs.name)) : '';
    if (!tool) continue;
    const action = TOOL_ACTIONS[tool];
    if (!action) continue;
    const data = attrs.data !== undefined ? parseToolData(attrs.data) : null;
    const path = data ? str(data.file_path) ?? str(data.path) ?? str(data.filePath) : null;
    const change: MikeChange = {
      action,
      tool,
      path: path ? decodeEntities(path).slice(0, 400) : null,
      note: noteFor(action, data),
    };
    const key = `${action}\u0000${change.path ?? ''}\u0000${change.path ? '' : change.note ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(change);
    if (out.length >= 200) break; // a single message never legitimately touches 200 things
  }
  return out;
}

/**
 * Replace every `<lov-tool-use …>…</lov-tool-use>` block with a one-line
 * marker. This is what makes the daily-report prompt affordable: a raw
 * assistant message is 5-15 KB of tool payload, the stripped form is ~10×
 * smaller and still says what was touched.
 */
export function stripToolUses(text: string | null | undefined): string {
  if (!text) return '';
  const changes = new Map<string, MikeChange>();
  for (const c of parseToolUses(text)) changes.set(c.tool, c);
  let out = text.replace(
    /<lov-tool-use\b([^>]*)>[\s\S]*?<\/lov-tool-use>/g,
    (_whole, body: string) => {
      const attrs = attrsOf(body);
      const tool = attrs.name ? decodeEntities(unescapeAttr(attrs.name)) : 'tool';
      if (tool === 'lov-think') return '';
      const data = attrs.data !== undefined ? parseToolData(attrs.data) : null;
      const path = data ? str(data.file_path) ?? str(data.path) : null;
      const action = TOOL_ACTIONS[tool];
      const hint = path ?? (action ? noteFor(action, data) : null);
      return `\n[tool: ${tool}${hint ? ` ${hint}` : ''}]\n`;
    },
  );
  // Self-closing / unterminated variants (a truncated capture leaves an open tag).
  out = out.replace(/<lov-tool-use\b[^>]*>/g, '').replace(/<\/lov-tool-use>/g, '');
  out = decodeEntities(out);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

const LOV_TAG_LINE_RE = /^<\/?lov-[\w-]+/;

/**
 * The feed label: the first real prose line of a message, with tool blocks and
 * markdown chrome out of the way. Never more than 200 chars.
 */
export function deriveHeadline(text: string | null | undefined, max = 200): string | null {
  if (!text) return null;
  const stripped = stripToolUses(text);
  for (const raw of stripped.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    if (line.startsWith('[tool:')) continue;
    if (LOV_TAG_LINE_RE.test(line)) continue;
    line = line.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').replace(/^>\s+/, '');
    line = line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
    line = line.trim();
    if (!line) continue;
    return line.slice(0, max);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Diff normalisation
// ---------------------------------------------------------------------------

export type MikeDiffKind = 'none' | 'parsed' | 'opaque';

/** Which wire shape the capture arrived in. Diagnostics only — all three
 *  readable shapes normalise to the same `{diffs:[…]}` payload. */
export type MikeDiffSource = 'none' | 'json_string' | 'json_object' | 'json_array' | 'unified_text' | 'unknown';

export interface MikeDiffHunkLine {
  type: string;
  content: string;
}

export interface MikeDiffHunk {
  oldStart?: number;
  oldCount?: number;
  newStart?: number;
  newCount?: number;
  /** Absent on 18 of 540 measured hunks — those carry only `summary`. */
  lines?: MikeDiffHunkLine[];
  /** Prose stand-in when the capture had no line-level detail. */
  summary?: string;
}

export interface MikeDiffFile {
  action?: string;
  file_path?: string;
  file_type?: string;
  is_image?: boolean;
  hunks: MikeDiffHunk[];
}

export interface MikeNormalizedDiff {
  diffs: MikeDiffFile[];
}

export interface NormalizeDiffResult {
  kind: MikeDiffKind;
  source: MikeDiffSource;
  /** Set when kind === 'parsed'. */
  diff: MikeNormalizedDiff | null;
  /** Set when kind === 'opaque' — the verbatim original, so nothing is lost. */
  raw: string | null;
  /** Hunks kept after normalisation (diagnostics / test assertions). */
  hunk_count: number;
  /** Hunks that carried only a `summary` and no `lines`. */
  summary_only_hunks: number;
  /** Hunks dropped for having neither `lines` nor `summary`. */
  dropped_hunks: number;
}

const NO_DIFF: NormalizeDiffResult = {
  kind: 'none',
  source: 'none',
  diff: null,
  raw: null,
  hunk_count: 0,
  summary_only_hunks: 0,
  dropped_hunks: 0,
};

function normalizeHunk(value: unknown): { hunk: MikeDiffHunk | null; summaryOnly: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { hunk: null, summaryOnly: false };
  const h = value as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const base: MikeDiffHunk = {
    oldStart: num(h.oldStart),
    oldCount: num(h.oldCount),
    newStart: num(h.newStart),
    newCount: num(h.newCount),
  };
  if (Array.isArray(h.lines)) {
    const lines: MikeDiffHunkLine[] = [];
    for (const l of h.lines) {
      if (!l || typeof l !== 'object') continue;
      const row = l as Record<string, unknown>;
      lines.push({
        type: typeof row.type === 'string' ? row.type : 'context',
        content: typeof row.content === 'string' ? row.content : '',
      });
    }
    if (lines.length) return { hunk: { ...base, lines }, summaryOnly: false };
  }
  const summary = str(h.summary);
  if (summary) return { hunk: { ...base, summary }, summaryOnly: true };
  // Neither lines nor summary — nothing a renderer could show (DESIGN §1 fact 6).
  return { hunk: null, summaryOnly: false };
}

function normalizeDiffObject(value: Record<string, unknown>): NormalizeDiffResult | null {
  const rawDiffs = value.diffs;
  if (!Array.isArray(rawDiffs)) return null;
  const files: MikeDiffFile[] = [];
  let hunkCount = 0;
  let summaryOnly = 0;
  let dropped = 0;
  for (const entry of rawDiffs) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const f = entry as Record<string, unknown>;
    const hunks: MikeDiffHunk[] = [];
    if (Array.isArray(f.hunks)) {
      for (const h of f.hunks) {
        const { hunk, summaryOnly: so } = normalizeHunk(h);
        if (!hunk) { dropped++; continue; }
        hunks.push(hunk);
        hunkCount++;
        if (so) summaryOnly++;
      }
    }
    files.push({
      action: str(f.action) ?? undefined,
      file_path: str(f.file_path) ?? str(f.path) ?? undefined,
      file_type: str(f.file_type) ?? undefined,
      is_image: typeof f.is_image === 'boolean' ? f.is_image : undefined,
      hunks,
    });
  }
  return {
    kind: 'parsed',
    source: 'json_object',
    diff: { diffs: files },
    raw: null,
    hunk_count: hunkCount,
    summary_only_hunks: summaryOnly,
    dropped_hunks: dropped,
  };
}

// ---------------------------------------------------------------------------
// Unified-diff TEXT
//
// DESIGN.md §1 fact 3 claimed every captured diff is JSON. Re-measured
// 2026-10-05 against the live archive: that is WRONG. Of the 90 rows carrying a
// diff, only ~47 are JSON (a `{diffs:[…]}` string, a plain object, or once a
// bare array) — the other ~43 are plain **unified diff text**
// (`--- a/x` / `+++ b/x` / `@@ -a,b +c,d @@`) and they carry 500 hunks across
// 152 files, MORE hunk detail than the whole JSON side. Dumping those into
// `kind:'opaque'` and rendering a <pre> would have thrown away the richest half
// of the diff data, so they are parsed into the same normalised shape and the
// renderer only ever sees one format.
// ---------------------------------------------------------------------------

const DIFF_OLD_FILE_RE = /^---\s+(.*)$/;
const DIFF_NEW_FILE_RE = /^\+\+\+\s+(.*)$/;
const DIFF_HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;
/** `=== edit: src/x.tsx ===` — the shape Mike's Hub 2.0 CRM project emits. */
const DIFF_EQ_FILE_RE = /^===\s*(?:(\w+)\s*:\s*)?(.+?)\s*===$/;

/**
 * `b/src/x.tsx` -> `src/x.tsx`; `/dev/null` -> null. Also strips a tab-suffixed
 * timestamp (`b/x.ts\t2026-01-01`) and a trailing human annotation that some
 * captures append (`src/x.tsx (new, 122 lines)`).
 */
function cleanDiffPath(raw: string): string | null {
  let path = raw.split('\t')[0].trim();
  if (!path || path === '/dev/null') return null;
  path = path.replace(/\s*\((?:new|deleted|modified|renamed)[^)]*\)\s*$/i, '').trim();
  path = path.replace(/^[ab]\//, '');
  return path || null;
}

/**
 * True when the string looks like a textual diff rather than prose. Needs a
 * file header AND at least one changed line — "I changed the button --- it
 * works now" must not be mistaken for a diff.
 */
export function looksLikeUnifiedDiff(text: string): boolean {
  const hasHeader =
    /^(?:---|\+\+\+)\s+\S/m.test(text) || /^===\s*\w+\s*:\s*\S/m.test(text);
  if (!hasHeader) return false;
  return /^@@\s+-\d+/m.test(text) || /^[+-]\S/m.test(text);
}

const EQ_ACTIONS: Record<string, string> = {
  edit: 'modify',
  modify: 'modify',
  update: 'modify',
  new: 'new',
  add: 'new',
  create: 'new',
  delete: 'delete',
  remove: 'delete',
};

/**
 * Parse textual diffs into the same normalised `{diffs:[…]}` shape the JSON
 * captures produce, so the renderer only ever sees one format.
 *
 * Handles all three textual variants measured in the archive:
 *   1. Standard unified diff — `--- a/x` / `+++ b/x` / `@@ -a,b +c,d @@`.
 *   2. `=== edit: src/x.tsx ===` file headers with real `@@` hunks.
 *   3. `--- src/x.tsx` followed by bare `+`/`-` summary bullets and NO `@@`
 *      header — those become one hunk with no line numbers, which renders as a
 *      normal add/del block.
 */
export function parseUnifiedDiff(text: string): NormalizeDiffResult | null {
  if (!looksLikeUnifiedDiff(text)) return null;

  const files: MikeDiffFile[] = [];
  let current: MikeDiffFile | null = null;
  let hunk: MikeDiffHunk | null = null;
  let hunkCount = 0;
  let oldPath: string | null = null;
  /** True right after a `---` header, when a `+++` is the new-side of the pair
   *  rather than a file header of its own. */
  let awaitingNewSide = false;

  const closeHunk = () => {
    if (hunk?.lines) {
      // A diff that ends with a newline yields one trailing empty element from
      // the split; keeping it would render a phantom blank context row at the
      // bottom of every hunk.
      while (hunk.lines.length && hunk.lines[hunk.lines.length - 1].type === 'context'
             && hunk.lines[hunk.lines.length - 1].content === '') {
        hunk.lines.pop();
      }
    }
    if (hunk && current && hunk.lines?.length) {
      current.hunks.push(hunk);
      hunkCount++;
    }
    hunk = null;
  };
  const closeFile = () => {
    closeHunk();
    if (current && (current.hunks.length || current.file_path)) files.push(current);
    current = null;
    oldPath = null;
    awaitingNewSide = false;
  };
  /** A `+`/`-` line outside any `@@` block still carries real information
   *  (variant 3) — open an implicit, line-number-less hunk for it. */
  const ensureHunk = () => {
    if (!current) current = { action: 'modify', hunks: [] };
    if (!hunk) hunk = { lines: [] };
    return hunk;
  };

  for (const line of text.split(/\r?\n/)) {
    const eqFile = DIFF_EQ_FILE_RE.exec(line);
    if (eqFile) {
      closeFile();
      current = {
        action: eqFile[1] ? EQ_ACTIONS[eqFile[1].toLowerCase()] ?? 'modify' : 'modify',
        file_path: cleanDiffPath(eqFile[2]) ?? undefined,
        hunks: [],
      };
      continue;
    }

    const oldFile = DIFF_OLD_FILE_RE.exec(line);
    if (oldFile) {
      closeFile();
      oldPath = cleanDiffPath(oldFile[1]);
      current = { action: oldPath === null ? 'new' : 'modify', file_path: oldPath ?? undefined, hunks: [] };
      awaitingNewSide = true;
      continue;
    }

    const newFile = DIFF_NEW_FILE_RE.exec(line);
    if (newFile) {
      const newPath = cleanDiffPath(newFile[1]);
      if (awaitingNewSide && current) {
        // The new-side of a `---`/`+++` pair: /dev/null on either side tells us
        // whether the file was created or deleted.
        current.action = oldPath === null ? 'new' : newPath === null ? 'delete' : 'modify';
        current.file_path = newPath ?? oldPath ?? undefined;
      } else {
        closeFile();
        current = { action: 'new', file_path: newPath ?? undefined, hunks: [] };
      }
      awaitingNewSide = false;
      continue;
    }

    const hunkHead = DIFF_HUNK_RE.exec(line);
    if (hunkHead) {
      closeHunk();
      awaitingNewSide = false;
      if (!current) current = { action: 'modify', hunks: [] };
      hunk = {
        oldStart: parseInt(hunkHead[1], 10),
        oldCount: hunkHead[2] !== undefined ? parseInt(hunkHead[2], 10) : 1,
        newStart: parseInt(hunkHead[3], 10),
        newCount: hunkHead[4] !== undefined ? parseInt(hunkHead[4], 10) : 1,
        lines: [],
      };
      continue;
    }

    awaitingNewSide = false;
    // Within a hunk body: '+' add, '-' del, ' ' or '' context. Anything else
    // ('\ No newline at end of file', 'diff --git', 'index abc..def') is noise.
    const marker = line[0];
    if (marker === '+') ensureHunk().lines!.push({ type: 'add', content: line.slice(1) });
    else if (marker === '-') ensureHunk().lines!.push({ type: 'del', content: line.slice(1) });
    else if (hunk?.lines && (marker === ' ' || line === '')) {
      hunk.lines.push({ type: 'context', content: line.slice(1) });
    }
  }
  closeFile();

  if (!files.length || hunkCount === 0) return null;
  return {
    kind: 'parsed',
    source: 'unified_text',
    diff: { diffs: files },
    raw: null,
    hunk_count: hunkCount,
    summary_only_hunks: 0,
    dropped_hunks: 0,
  };
}

/**
 * Normalise every measured wire shape to `{diffs:[…]}`:
 *   - a double-encoded JSON **string** whose `diffs` is an array,
 *   - a plain **object** with the same shape,
 *   - a bare JSON **array** of file entries, and
 *   - plain **textual diff** (standard unified, `=== edit: path ===`, or
 *     `--- path` with bare `+`/`-` bullets) — see `parseUnifiedDiff`.
 * Anything else becomes `kind:'opaque'` with the original preserved verbatim.
 * That valve claims zero rows in today's archive, but it is kept so a future
 * shape change degrades into "here it is, unparsed" instead of throwing.
 */
export function normalizeDiff(diff: unknown): NormalizeDiffResult {
  if (diff === null || diff === undefined) return NO_DIFF;

  if (typeof diff === 'string') {
    const trimmed = diff.trim();
    if (!trimmed || trimmed === 'null') return NO_DIFF;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') {
        const normalized = Array.isArray(parsed)
          ? normalizeDiffObject({ diffs: parsed })
          : normalizeDiffObject(parsed as Record<string, unknown>);
        if (normalized) {
          return { ...normalized, source: Array.isArray(parsed) ? 'json_array' : 'json_string' };
        }
      }
    } catch {
      /* not JSON — the common case: textual diff */
    }
    const unified = parseUnifiedDiff(diff);
    if (unified) return unified;
    return { ...NO_DIFF, kind: 'opaque', source: 'unknown', raw: diff.slice(0, 200_000) };
  }

  if (typeof diff === 'object' && !Array.isArray(diff)) {
    const obj = diff as Record<string, unknown>;
    const direct = normalizeDiffObject(obj);
    if (direct) return direct;
    // `diffs` present but still encoded as a string (or as diff text).
    if (typeof obj.diffs === 'string') {
      const inner = normalizeDiff(obj.diffs);
      if (inner.kind === 'parsed') return inner;
    }
  }

  if (Array.isArray(diff)) {
    const normalized = normalizeDiffObject({ diffs: diff });
    if (normalized) return { ...normalized, source: 'json_array' };
  }

  try {
    return { ...NO_DIFF, kind: 'opaque', source: 'unknown', raw: JSON.stringify(diff).slice(0, 200_000) };
  } catch {
    return { ...NO_DIFF, kind: 'opaque', source: 'unknown', raw: String(diff).slice(0, 200_000) };
  }
}

/** Every file path a normalised diff touches — used to backfill `changes[]`
 *  when a row has a diff but no recognisable tool-use block. */
export function diffFilePaths(diff: MikeNormalizedDiff | null): string[] {
  if (!diff) return [];
  const out: string[] = [];
  for (const f of diff.diffs) {
    if (f.file_path && !out.includes(f.file_path)) out.push(f.file_path);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Names and ids
// ---------------------------------------------------------------------------

export const MIKE_NAME_MAX = 80;

export interface NameGuardResult {
  name: string | null;
  /** The text that got demoted out of `name`, if any. */
  description: string | null;
}

/**
 * DESIGN §1 fact 2: 12 of the 90 `_new_projects.jsonl` entries have the project
 * *description* leaked into `name` (816a7a7c's is 650 chars of prose). A name
 * longer than 80 chars or containing a newline is not a name — demote it to
 * description and let the caller fall back to the short id.
 */
export function guardProjectName(
  name: string | null | undefined,
  description: string | null | undefined,
): NameGuardResult {
  const desc = str(description);
  const raw = str(name);
  if (!raw) return { name: null, description: desc };
  if (raw.length > MIKE_NAME_MAX || /[\r\n]/.test(raw)) {
    return { name: null, description: desc ?? raw.slice(0, 4_000) };
  }
  return { name: raw, description: desc };
}

export function shortId(projectId: string): string {
  return projectId.slice(0, 8);
}

/**
 * Lovable message ids look like `main:agent#00000000062791#don:TBUDWCXY` or
 * `main:user#00000000000087#usr:NKLJ7LJA`. The middle field is monotonic, so
 * consecutive ids reveal the gaps the watcher's 30-messages-per-sweep cap leaves
 * behind (DESIGN §10). 1,515 of 2,764 ids carry one; the rest return null and
 * simply don't contribute.
 *
 * CRITICAL: `main:user#…` and `main:agent#…` are SEPARATE sequence namespaces —
 * user ids run in the tens while agent ids run in the tens of thousands. Gap
 * detection must compare within a namespace, never across, or every single
 * user→agent transition reads as a 60,000-message hole. (That bug showed up as
 * 764 "gaps" on a 2,773-row archive before the namespace was split out.)
 */
export interface MessageSeq {
  /** e.g. `main:user` — the namespace the number is monotonic within. */
  ns: string;
  seq: number;
}

export function messageSeq(messageId: string | null | undefined): MessageSeq | null {
  if (!messageId) return null;
  const m = /^([a-z]+:[a-z]+)#(\d+)#/.exec(messageId);
  if (!m) return null;
  const n = parseInt(m[2], 10);
  return Number.isFinite(n) ? { ns: m[1], seq: n } : null;
}
