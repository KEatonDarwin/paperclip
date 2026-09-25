import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database as DatabaseType } from 'better-sqlite3';
import { normalizeLineText } from './notepad.js';
import { nativeCall } from './tools/mcp-native.js';

// Node #863 — "topic resolver + evidence gathering from the sources that
// already exist." This is the layer BELOW the future dossier composer (node
// #63's job): given one notepad line and a live DB, deterministically
// answer "what is this about, and what do we already know about it" with
// ZERO model calls. The failure mode this module is designed against is a
// CONFIDENT DOSSIER ABOUT THE WRONG THING — so every step below either
// resolves off real, structural data (a goal/node/tree row, a cached or
// freshly-fetched orientation document) or returns an honest null/empty
// answer. Nothing here paraphrases, summarizes, or guesses a repo/branch
// that isn't literally present in the evidence text it read.

// == Tokenization ============================================================
//
// One normalizer for both the incoming line and every candidate document's
// title, so "does this line share vocabulary with this goal/node/tree" is a
// real set-intersection, not two different notions of "a word". Reuses
// notepad.ts's normalizeLineText (trim -> strip bullet -> collapse
// whitespace -> casefold) rather than re-implementing it — the same
// load-bearing reasoning notepad.ts itself calls out for its own hash.
//
// STOPWORDS deliberately includes both ordinary English function words AND
// generic todo/action vocabulary ("fix", "check", "today", "thing",
// "stuff", ...). A line like "fix the thing today" or a bare "stuff" must
// never resolve to a topic just because a goal title happens to share one
// of those words — stripping them at the tokenizer is a stronger guarantee
// than hoping IDF weighting alone downweights them enough, and it's what
// makes an all-generic line come back with ZERO tokens (and therefore
// topic: null) before the registry is even consulted.
const STOPWORDS: ReadonlySet<string> = new Set([
  // function words
  'a', 'an', 'and', 'or', 'but', 'the', 'to', 'of', 'in', 'on', 'at', 'by',
  'for', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my',
  'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'his', 'her',
  'if', 'so', 'than', 'then', 'not', 'no', 'yes', 'ok', 'okay', 'also',
  'about', 'into', 'over', 'out', 'up', 'down', 'off', 'again', 'still',
  'just', 'can', 'could', 'should', 'would', 'will', 'may', 'might', 'must',
  'have', 'has', 'had', 'do', 'does', 'did', 'get', 'got', 'go', 'goes',
  'went', 'one', 'two', 'all', 'any', 'each', 'some', 'more', 'most',
  // generic todo/action vocabulary — see the module doc above
  'fix', 'check', 'look', 'looking', 'see', 'review', 'update', 'handle',
  'todo', 'task', 'item', 'thing', 'things', 'stuff', 'note', 'need',
  'needs', 'please', 'pls', 'plz', 'asap', 'now', 'today', 'tomorrow',
  'yesterday', 'morning', 'afternoon', 'evening', 'later', 'soon', 'still',
  'make', 'sure', 'remember', 'ping', 'follow',
]);

function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  return normalizeLineText(text)
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// == Registry: the candidate topics THIS DB actually knows about ===========
//
// A "topic" is anchored to something real: a goal, a goal node, or a hopper
// tree — never a keyword invented in the abstract. A node's token set
// inherits its parent goal's title tokens (via the real goal_nodes.goal_id
// FK — not a guess), and a tree launched from a node inherits that same
// node+goal vocabulary (via goal_nodes.tree_id). That enrichment is what
// lets a line naming the PARENT goal's subject ("perclickity") resolve to a
// specific CHILD node/tree whose own title never repeats that word (e.g. a
// tree topic that's just "Zoom 3 identity browser...") — the goal_id/
// tree_id foreign keys are the structural link that makes that legitimate,
// not a heuristic.
type CandidateKind = 'goal' | 'tree';

interface CandidateDoc {
  kind: CandidateKind;
  ref: string;
  title: string;
  tokens: Set<string>;
  goalId?: number;
  nodeId?: number;
  treeId?: string;
}

function buildRegistry(db: DatabaseType): CandidateDoc[] {
  const docs: CandidateDoc[] = [];
  const goalTitles = new Map<number, string>();

  try {
    const goals = db
      .prepare(`SELECT id, title FROM goals WHERE archived = 0`)
      .all() as Array<{ id: number; title: string }>;
    for (const g of goals) {
      goalTitles.set(g.id, g.title);
      const tokens = new Set(tokenize(g.title));
      if (tokens.size > 0) docs.push({ kind: 'goal', ref: `goal:${g.id}`, title: g.title, tokens, goalId: g.id });
    }
  } catch {
    // goals table unreachable in this DB — registry simply has no goal docs.
  }

  const nodeTreeLinks: Array<{ nodeId: number; goalId: number; treeId: string | null }> = [];
  try {
    const nodes = db
      .prepare(`SELECT id, goal_id, title, tree_id FROM goal_nodes WHERE state != 'discarded'`)
      .all() as Array<{ id: number; goal_id: number; title: string; tree_id: string | null }>;
    for (const n of nodes) {
      const goalTitle = goalTitles.get(n.goal_id) || '';
      const tokens = new Set<string>([...tokenize(n.title), ...tokenize(goalTitle)]);
      if (tokens.size > 0) {
        docs.push({ kind: 'goal', ref: `goal:${n.goal_id}#${n.id}`, title: n.title, tokens, goalId: n.goal_id, nodeId: n.id });
      }
      nodeTreeLinks.push({ nodeId: n.id, goalId: n.goal_id, treeId: n.tree_id });
    }
  } catch {
    // goal_nodes table unreachable — registry simply has no node docs.
  }

  try {
    const trees = db.prepare(`SELECT id, topic FROM hopper_trees`).all() as Array<{ id: string; topic: string }>;
    for (const t of trees) {
      const link = nodeTreeLinks.find((l) => l.treeId === t.id);
      const goalTitle = link ? goalTitles.get(link.goalId) || '' : '';
      const tokens = new Set<string>([...tokenize(t.topic), ...tokenize(goalTitle)]);
      if (tokens.size > 0) {
        docs.push({ kind: 'tree', ref: `tree-${t.id}`, title: t.topic, tokens, treeId: t.id, goalId: link?.goalId });
      }
    }
  } catch {
    // hopper_trees table unreachable — registry simply has no tree docs.
  }

  return docs;
}

function documentFrequency(registry: CandidateDoc[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const doc of registry) for (const t of doc.tokens) df.set(t, (df.get(t) ?? 0) + 1);
  return df;
}

/**
 * A candidate's score against a token set is the sum of 1/df(t) over every
 * shared distinctive token t. A single token that appears in only ONE
 * candidate document (df=1) contributes exactly 1.0 on its own — a rare,
 * specific word (a product name, a branch-shaped token) is allowed to
 * resolve a topic by itself. Several tokens that are each common across
 * many documents (high df) need to co-occur to reach the same bar. That is
 * the whole reasoning behind TOPIC_RESOLVE_THRESHOLD = 1.0 below: it is
 * exactly the score one maximally-distinctive shared token produces, so
 * resolution requires "one real signal", not an accumulation of noise.
 */
function scoreAgainst(tokens: Set<string>, doc: CandidateDoc, df: Map<string, number>): { score: number; matched: string[] } {
  const matched: string[] = [];
  let score = 0;
  for (const t of tokens) {
    if (doc.tokens.has(t)) {
      matched.push(t);
      score += 1 / (df.get(t) ?? 1);
    }
  }
  return { score, matched };
}

const TOPIC_RESOLVE_THRESHOLD = 1.0;

export function resolveTopic(text: string, db: DatabaseType): { topic: string | null; terms: string[]; score: number } {
  const lineTokens = new Set(tokenize(text));
  if (lineTokens.size === 0) return { topic: null, terms: [], score: 0 };

  const registry = buildRegistry(db);
  if (registry.length === 0) return { topic: null, terms: [], score: 0 };

  const df = documentFrequency(registry);
  let best: { doc: CandidateDoc; score: number; matched: string[] } | null = null;

  for (const doc of registry) {
    const { score, matched } = scoreAgainst(lineTokens, doc, df);
    if (matched.length === 0) continue;
    const better =
      !best ||
      score > best.score ||
      (score === best.score && doc.tokens.size < best.doc.tokens.size) ||
      (score === best.score && doc.tokens.size === best.doc.tokens.size && doc.ref < best.doc.ref);
    if (better) best = { doc, score, matched };
  }

  if (!best || best.score < TOPIC_RESOLVE_THRESHOLD) {
    return { topic: null, terms: [], score: best?.score ?? 0 };
  }
  return { topic: best.doc.title, terms: best.matched, score: best.score };
}

// == Evidence gathering ======================================================

export type DossierSourceKind = 'goal' | 'tree' | 'thread_summary' | 'orientation' | 'recall';

export interface DossierEvidence {
  kind: DossierSourceKind;
  title: string;
  ref: string;
  snippet: string;
  score: number;
  repo?: string;
  branch?: string;
}

export interface SourceAvailability {
  kind: DossierSourceKind;
  available: boolean;
  reason?: string;
}

export interface GatherEvidenceOptions {
  /** Overrides the default `darwin-assistant/.cache` directory. Tests point
   *  this at a fresh temp dir to control whether a cache hit is possible. */
  cacheDir?: string;
  /** TTL for both the orientation list cache and per-key content cache. */
  orientationCacheTtlMs?: number;
}

const MAX_EVIDENCE = 12;

// -- repo/branch extraction --------------------------------------------------
//
// Extraction ONLY reads what evidence text actually names. Nothing here
// invents a repo or branch when the text is silent — both fields simply
// stay undefined, which is a correct answer, not a gap.

const EXPLICIT_BRANCH_LABEL = /\bBRANCH\s+(\S+)/i;
// The house style for branch names across every tree spec seen in practice
// (see the AUTO memory's tree writeups): a short prefix, a slash, then a
// lowercase-dash-shaped slug.
const BRANCH_SHAPE = /\b(?:hopper|sandbox|perclickity|mbi|bi)\/[a-z0-9][a-z0-9._-]*/i;

function extractBranch(text: string | null | undefined): string | null {
  if (!text) return null;
  const labeled = text.match(EXPLICIT_BRANCH_LABEL);
  if (labeled?.[1]) return labeled[1].replace(/[,.;:)]+$/, '');
  const generic = text.match(BRANCH_SHAPE);
  return generic ? generic[0] : null;
}

const KNOWN_REPOS = [
  'darwin-assistant',
  'jarvis-command-center',
  'DarwinIntakeSystem',
  'hub2-lane-engine',
  'hub-2.0-kevin-clone',
  'darwin-investor-network',
  'foreman-eye',
  'darwin-mcp-host',
  'darwin-mcp-host-port',
  'accounting-bridge-cron',
  'darwin-dashboard',
  'darwin-models',
  'perclickity-suite',
  'SHIM',
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractRepo(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const name of KNOWN_REPOS) {
    if (new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(text)) return name;
  }
  return null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// -- goal/node evidence rows -------------------------------------------------

function goalEvidenceRow(db: DatabaseType, doc: CandidateDoc, score: number): DossierEvidence {
  let snippet = '';
  let text = '';
  try {
    if (doc.nodeId != null) {
      const row = db
        .prepare(`SELECT done_means, notes, plan FROM goal_nodes WHERE id = ?`)
        .get(doc.nodeId) as { done_means: string | null; notes: string | null; plan: string | null } | undefined;
      text = [row?.done_means, row?.notes, row?.plan].filter(Boolean).join('\n');
    } else if (doc.goalId != null) {
      const row = db
        .prepare(`SELECT done_means, notes FROM goals WHERE id = ?`)
        .get(doc.goalId) as { done_means: string | null; notes: string | null } | undefined;
      text = [row?.done_means, row?.notes].filter(Boolean).join('\n');
    }
  } catch {
    text = '';
  }
  snippet = (text || doc.title).slice(0, 400);
  return {
    kind: 'goal',
    title: doc.title,
    ref: doc.ref,
    snippet,
    score,
    repo: extractRepo(text) ?? undefined,
    branch: extractBranch(text) ?? undefined,
  };
}

// -- tree evidence rows -------------------------------------------------------
//
// One evidence row per finished (status='done') node under the tree, newest
// first. If two finished nodes name DIFFERENT branches, the most recently
// finished node's branch wins as the authoritative answer for every row of
// that tree, and the row whose OWN text disagrees gets a conflict note
// appended to its snippet — never silently dropped, never silently
// overwritten with no trace.

interface FinishedNodeRow {
  id: number;
  title: string;
  result: string | null;
  spec: string | null;
}

function treeEvidence(db: DatabaseType, doc: CandidateDoc, score: number): DossierEvidence[] {
  let finished: FinishedNodeRow[] = [];
  try {
    finished = db
      .prepare(`SELECT id, title, result, spec FROM hopper_nodes WHERE tree_id = ? AND status = 'done' ORDER BY id DESC`)
      .all(doc.treeId) as FinishedNodeRow[];
  } catch {
    finished = [];
  }

  if (finished.length === 0) {
    return [
      {
        kind: 'tree',
        title: doc.title,
        ref: doc.ref,
        snippet: `tree ${doc.treeId} (no finished nodes yet)`,
        score,
      },
    ];
  }

  // finished is DESC by id, so finished[0] is the most recently finished
  // node — its own branch mention (if any) is authoritative.
  let authoritativeBranch: string | null = null;
  for (const n of finished) {
    const b = extractBranch(n.result) ?? extractBranch(n.spec);
    if (b) {
      authoritativeBranch = b;
      break;
    }
  }

  const out: DossierEvidence[] = [];
  for (const n of finished.slice(0, 4)) {
    const text = [n.result, n.spec].filter(Boolean).join('\n');
    const ownBranch = extractBranch(n.result) ?? extractBranch(n.spec);
    let snippet = (n.result || n.spec || n.title).slice(0, 400);
    let branch = ownBranch ?? authoritativeBranch ?? undefined;
    if (ownBranch && authoritativeBranch && ownBranch !== authoritativeBranch) {
      snippet += ` [conflict: this node named branch '${ownBranch}'; the most recently finished node names '${authoritativeBranch}']`;
      branch = authoritativeBranch;
    }
    out.push({
      kind: 'tree',
      title: `${doc.title} — node #${n.id}: ${n.title}`,
      ref: `${doc.ref}#${n.id}`,
      snippet,
      score,
      repo: extractRepo(text) ?? undefined,
      branch,
    });
  }
  return out;
}

// -- thread_summaries ---------------------------------------------------------

function threadSummaryEvidence(db: DatabaseType, terms: string[]): DossierEvidence[] {
  const rows = db
    .prepare(
      `SELECT ts.id AS id, ts.content AS content, c.external_id AS external_id
       FROM thread_summaries ts JOIN conversations c ON c.id = ts.conversation_id
       ORDER BY ts.id DESC LIMIT 200`,
    )
    .all() as Array<{ id: number; content: string; external_id: string }>;

  const termSet = new Set(terms);
  const scored: Array<{ row: (typeof rows)[number]; score: number }> = [];
  for (const row of rows) {
    const contentTokens = new Set(tokenize(row.content));
    let score = 0;
    for (const t of termSet) if (contentTokens.has(t)) score += 1;
    if (score > 0) scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, 3).map(({ row, score }) => ({
    kind: 'thread_summary' as const,
    title: `Thread summary: ${row.external_id}`,
    ref: row.external_id,
    snippet: row.content.slice(0, 400),
    score,
  }));
}

// -- orientation store (smarty-pants, via the native MCP client) ------------
//
// Live response shapes (verified against the real server, not guessed):
//   list_orientations -> content[0].text is a JSON STRING:
//     {"operation":..., "success":true, "data":{"orientations":[{"key","title",...}]}}
//   get_orientation    -> same envelope, "data":{"key","chain","items","content"}
//     where "content" is the full markdown document.
//   An unknown key comes back as an MCP-level tool error (isError:true) with
//   a plain-text message, NOT the success envelope — that is handled below
//   by treating "doesn't parse as the expected JSON shape" as "no match",
//   not as a crash.
//
// Caching: BOTH the key list and each fetched document's content are
// cached to disk (darwin-assistant/.cache/ by default) so a repeat call —
// and every run of the check script — needs no network at all once warm.
// A cache miss/expiry falls through to one network attempt, with one retry.

interface OrientationListItem {
  key: string;
  title: string;
}

function defaultCacheDir(): string {
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(distDir, '..', '.cache');
}

function readJsonIfFresh<T>(file: string, ttlMs: number): T | null {
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > ttlMs) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJsonBestEffort(file: string, data: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {
    // Cache write is a pure optimization — never let a failed write surface
    // as an evidence-gathering failure.
  }
}

async function nativeCallWithRetry(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; result: string; error?: string }> {
  let last = await nativeCall('smarty-pants', tool, args);
  if (!last.ok) last = await nativeCall('smarty-pants', tool, args); // one retry, per spec
  return last;
}

async function getOrientationList(
  opts: GatherEvidenceOptions,
): Promise<{ ok: true; orientations: OrientationListItem[] } | { ok: false; reason: string }> {
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const ttlMs = opts.orientationCacheTtlMs ?? 10 * 60 * 1000;
  const cacheFile = path.join(cacheDir, 'orientation-list.json');

  const cached = readJsonIfFresh<{ orientations: OrientationListItem[] }>(cacheFile, ttlMs);
  if (cached && Array.isArray(cached.orientations)) return { ok: true, orientations: cached.orientations };

  const called = await nativeCallWithRetry('orientation-tool', { operation: 'list_orientations' });
  if (!called.ok) return { ok: false, reason: called.error || 'orientation-tool list_orientations failed' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(called.result);
  } catch {
    return { ok: false, reason: 'orientation-tool returned a non-JSON response' };
  }
  const orientationsRaw = (parsed as { data?: { orientations?: unknown } } | undefined)?.data?.orientations;
  if (!Array.isArray(orientationsRaw)) {
    return { ok: false, reason: 'orientation-tool response missing data.orientations' };
  }
  const orientations: OrientationListItem[] = orientationsRaw
    .map((o) => {
      const rec = o as Record<string, unknown>;
      return { key: String(rec.key ?? ''), title: String(rec.title ?? rec.key ?? '') };
    })
    .filter((o) => o.key.length > 0);

  writeJsonBestEffort(cacheFile, { fetchedAt: new Date().toISOString(), orientations });
  return { ok: true, orientations };
}

async function getOrientationContent(
  key: string,
  opts: GatherEvidenceOptions,
): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const ttlMs = opts.orientationCacheTtlMs ?? 10 * 60 * 1000;
  const cacheFile = path.join(cacheDir, `orientation-content-${key}.json`);

  const cached = readJsonIfFresh<{ content: string }>(cacheFile, ttlMs);
  if (cached && typeof cached.content === 'string') return { ok: true, content: cached.content };

  const called = await nativeCallWithRetry('orientation-tool', { operation: 'get_orientation', key });
  if (!called.ok) return { ok: false, reason: called.error || 'orientation-tool get_orientation failed' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(called.result);
  } catch {
    return { ok: false, reason: 'orientation-tool returned a non-JSON response' };
  }
  const content = (parsed as { data?: { content?: unknown } } | undefined)?.data?.content;
  if (typeof content !== 'string' || content.length === 0) {
    return { ok: false, reason: `orientation-tool has no content for key '${key}'` };
  }

  writeJsonBestEffort(cacheFile, { fetchedAt: new Date().toISOString(), key, content });
  return { ok: true, content };
}

async function orientationEvidence(
  terms: string[],
  opts: GatherEvidenceOptions,
): Promise<{ available: boolean; reason?: string; evidence?: DossierEvidence }> {
  const list = await getOrientationList(opts);
  if (!list.ok) return { available: false, reason: list.reason };

  const termSet = new Set(terms);
  let best: { item: OrientationListItem; score: number } | null = null;
  for (const item of list.orientations) {
    const docTokens = new Set(tokenize(`${item.title} ${item.key}`));
    let score = 0;
    for (const t of termSet) if (docTokens.has(t)) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { item, score };
  }
  if (!best) return { available: true }; // reachable; genuinely no matching key — correct silence, not a failure.

  const content = await getOrientationContent(best.item.key, opts);
  if (!content.ok) return { available: false, reason: content.reason };

  return {
    available: true,
    evidence: {
      kind: 'orientation',
      title: best.item.title || best.item.key,
      ref: best.item.key,
      snippet: content.content.slice(0, 600),
      score: best.score,
    },
  };
}

// -- recall / shared-context probe -------------------------------------------
//
// The shared-context 'recall' layer (a persona tool + GET /api/v1/recall)
// was DESIGNED but is not present on this branch — verified by probing for
// its compiled output rather than assuming either way. This function never
// builds a replacement; absence is reported honestly as unavailable.

function probeRecall(): SourceAvailability {
  try {
    const distDir = path.dirname(fileURLToPath(import.meta.url));
    const recallPath = path.join(distDir, 'recall.js');
    if (!fs.existsSync(recallPath)) {
      return { kind: 'recall', available: false, reason: 'recall.ts is not present on this branch (shared-context build not merged here)' };
    }
    return { kind: 'recall', available: true, reason: 'present on this branch but not wired into evidence gathering' };
  } catch (err) {
    return { kind: 'recall', available: false, reason: errMsg(err) };
  }
}

// == The public entry point ==================================================

export async function gatherEvidence(
  topic: string | null,
  terms: string[],
  db: DatabaseType,
  opts: GatherEvidenceOptions = {},
): Promise<{ evidence: DossierEvidence[]; availability: SourceAvailability[] }> {
  // An unresolved line must come back EMPTY — no source is even attempted.
  if (!topic || terms.length === 0) return { evidence: [], availability: [] };

  const evidence: DossierEvidence[] = [];
  const availability: SourceAvailability[] = [];

  // -- goal + tree evidence, re-scored against the resolved terms ----------
  let registry: CandidateDoc[] = [];
  try {
    registry = buildRegistry(db);
    availability.push({ kind: 'goal', available: true });
    availability.push({ kind: 'tree', available: true });
  } catch (err) {
    const reason = errMsg(err);
    availability.push({ kind: 'goal', available: false, reason });
    availability.push({ kind: 'tree', available: false, reason });
  }

  if (registry.length > 0) {
    const df = documentFrequency(registry);
    const termSet = new Set(terms);
    const scored = registry
      .map((doc) => ({ doc, ...scoreAgainst(termSet, doc, df) }))
      .filter((s) => s.matched.length > 0 && s.score > 0)
      .sort((a, b) => b.score - a.score);

    for (const { doc, score } of scored) {
      try {
        if (doc.kind === 'tree') evidence.push(...treeEvidence(db, doc, score));
        else evidence.push(goalEvidenceRow(db, doc, score));
      } catch {
        // A single candidate's row fetch failing does not sink the others.
      }
    }
  }

  // -- thread_summaries -------------------------------------------------------
  try {
    evidence.push(...threadSummaryEvidence(db, terms));
    availability.push({ kind: 'thread_summary', available: true });
  } catch (err) {
    availability.push({ kind: 'thread_summary', available: false, reason: errMsg(err) });
  }

  // -- orientation store --------------------------------------------------
  try {
    const result = await orientationEvidence(terms, opts);
    availability.push({ kind: 'orientation', available: result.available, reason: result.reason });
    if (result.evidence) evidence.push(result.evidence);
  } catch (err) {
    availability.push({ kind: 'orientation', available: false, reason: errMsg(err) });
  }

  // -- recall / shared-context (not on this branch) ------------------------
  availability.push(probeRecall());

  evidence.sort((a, b) => b.score - a.score);
  return { evidence: evidence.slice(0, MAX_EVIDENCE), availability };
}
