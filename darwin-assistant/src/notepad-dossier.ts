import { execFile } from 'node:child_process';
import type { Database as DatabaseType } from 'better-sqlite3';
import { getSetting, sqliteDb } from './conversation-db.js';
import { getNotepadLine } from './notepad.js';
import { assertModelSpawnAllowed } from './notepad-gate.js';
import {
  resolveTopic,
  gatherEvidence,
  extractAllBranchTokens,
  extractAllRepoTokens,
  type DossierEvidence,
  type SourceAvailability,
  type GatherEvidenceOptions,
} from './notepad-dossier-sources.js';
import { extractJsonObject } from './tools/ux-reviewer/vision-critique.js';

// Node #107 — "assemble the dossier — and make it physically unable to
// invent a repo, a branch, or a goal." This is the composer that sits on
// top of node #863's deterministic resolveTopic/gatherEvidence: it turns
// that evidence into the one thing a marker click is actually supposed to
// open — a thread that is ALREADY ORIENTED, or an honest admission that
// JARVIS has nothing yet.
//
// THE STRUCTURAL GUARANTEE THIS FILE EXISTS TO PROVIDE: `repo`, `branch`,
// `goal`, and every `prior_work` entry are read ONLY off the deterministic
// evidence rows (or a direct DB row keyed off a ref those rows already
// named) -- never off model output. The ONE model call this module makes is
// scoped to exactly two things ("narrative" prose and an "open_question"),
// and its output is VALIDATED before it is trusted: every branch-shaped
// token, repo-shaped name, and "#<digits>" reference the model's text
// contains is checked against the evidence corpus, and if even one is
// absent, the ENTIRE model output is discarded -- the dossier falls back to
// the deterministic renderer, which is built exclusively from evidence and
// therefore cannot lie. A rejected model call never produces a dossier
// worse than the deterministic floor; it can only fail to add a narrative
// paragraph on top of it.
//
// This function performs ZERO writes. It reads notepad_lines (if line_id is
// given), the goal/tree/thread_summary/orientation evidence sources, and
// returns a TopicDossier. Nothing here touches notepad_markers,
// notepad_line_state, or any other table.

export type DossierConfidence = 'none' | 'weak' | 'strong';

export interface TopicDossier {
  line_id: number | null;
  text: string;
  topic: string | null;
  confidence: DossierConfidence;
  repo: string | null;
  branch: string | null;
  goal: { goal_id: number; node_id: number | null; title: string } | null;
  prior_work: string[];
  open_question: string | null;
  evidence: DossierEvidence[];
  availability: SourceAvailability[];
  rendered: string;
  unresolved_reason: string | null;
}

export interface BuildDossierInput {
  line_id?: number;
  text?: string;
}

export interface BuildDossierOptions {
  /** Injection seam for a sim/check -- stub the model call entirely so it
   *  never touches the real CLI. Without a stub, defaultRunOneShot is used
   *  and assertModelSpawnAllowed() is called first (outside any try/catch),
   *  mirroring notepad-gate.ts's / notepad-moves.ts's own contract: a sim
   *  that forgot to stub this seam must fail loudly, not quietly. */
  runOneShot?: (prompt: string) => Promise<string>;
  timeoutMs?: number;
  db?: DatabaseType;
  /** Forwarded to gatherEvidence -- see GatherEvidenceOptions. */
  cacheDir?: string;
  orientationCacheTtlMs?: number;
}

// == The one permitted model call ============================================

const CLAUDE_BIN = process.env.UX_REVIEWER_CLAUDE_BIN || 'claude';
const DEFAULT_DOSSIER_MODEL = 'claude-sonnet-5';
const DEFAULT_DOSSIER_TIMEOUT_MS = 25 * 1000;

function dossierModelSetting(): string {
  const raw = getSetting('notepad_dossier_model');
  return raw && raw.trim() ? raw.trim() : DEFAULT_DOSSIER_MODEL;
}

/**
 * The real CLI spawn -- NO API KEYS (deletes ANTHROPIC_API_KEY from the
 * child env), identical shape to notepad-gate.ts's / notepad-moves.ts's
 * defaultRunOneShot: `claude -p <prompt> --output-format json --model <id>`.
 */
function defaultRunOneShot(prompt: string): Promise<string> {
  assertModelSpawnAllowed();
  const model = dossierModelSetting();
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return new Promise((resolve, reject) => {
    execFile(
      CLAUDE_BIN,
      ['-p', prompt, '--output-format', 'json', '--model', model],
      { timeout: DEFAULT_DOSSIER_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error(`notepad dossier call failed: ${err.message}${stderr ? ` | ${stderr.slice(0, 300)}` : ''}`));
          return;
        }
        try {
          const envelope = JSON.parse(stdout.trim()) as { result?: string };
          resolve(typeof envelope.result === 'string' ? envelope.result : stdout);
        } catch {
          resolve(stdout);
        }
      },
    );
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`notepad dossier call timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

interface KnownFacts {
  topic: string;
  goal: { goal_id: number; node_id: number | null; title: string } | null;
  repo: string | null;
  branch: string | null;
}

function buildDossierPrompt(text: string, facts: KnownFacts, evidence: DossierEvidence[]): string {
  const evidenceLines = evidence
    .map((e, i) => {
      const tags = [e.repo ? `repo: ${e.repo}` : null, e.branch ? `branch: ${e.branch}` : null].filter(Boolean).join(', ');
      return `${i + 1}. [${e.kind}] ${e.title}${tags ? ` (${tags})` : ''}\n   ${e.snippet.replace(/\s+/g, ' ').slice(0, 300)}`;
    })
    .join('\n');

  const knownFacts = [
    `Topic: ${facts.topic}`,
    facts.goal
      ? `Goal: #${facts.goal.goal_id}${facts.goal.node_id != null ? ` node #${facts.goal.node_id}` : ''} -- ${facts.goal.title}`
      : 'Goal: none found in evidence',
    facts.repo ? `Repo: ${facts.repo}` : 'Repo: none found in evidence',
    facts.branch ? `Branch: ${facts.branch}` : 'Branch: none found in evidence',
  ].join('\n');

  return [
    'You are drafting a short internal briefing for JARVIS about ONE notepad line Kevin',
    'wrote, so a fresh conversation opens already oriented instead of having to ask',
    '"what is this about?"',
    '',
    `The notepad line: ${JSON.stringify(text)}`,
    '',
    'Everything already known about this, gathered deterministically -- this, plus the',
    'evidence rows below, is the ONLY information you may draw on. Do not use outside',
    'knowledge, and do not assume anything about repos/branches/goals beyond what is',
    'written here.',
    knownFacts,
    '',
    'Evidence rows:',
    evidenceLines || '(none)',
    '',
    'Write exactly two things:',
    '1. "narrative" -- 1-3 plain-English sentences of context, using ONLY the facts and',
    '   evidence above. NEVER name a repo, branch, file, or "#<number>" reference that is',
    '   not literally present in the text above -- if you are not sure of something, say',
    '   so in the narrative instead of guessing or inventing one.',
    '2. "open_question" -- the single most useful question this line raises given the',
    '   evidence, or null if the evidence does not clearly imply one. Do not force one.',
    '',
    'Return ONLY a JSON object, no markdown fences, no prose before or after it, with',
    'exactly this shape:',
    '{"narrative": "...", "open_question": "..." | null}',
  ].join('\n');
}

interface ParsedDossierModelOutput {
  narrative: string | null;
  open_question: string | null;
}

function parseDossierModelOutput(raw: string): ParsedDossierModelOutput | null {
  const parsed = extractJsonObject(raw) as { narrative?: unknown; open_question?: unknown } | null;
  if (!parsed || typeof parsed !== 'object') return null;
  const narrative = typeof parsed.narrative === 'string' && parsed.narrative.trim() ? parsed.narrative.trim() : null;
  const openQuestion =
    typeof parsed.open_question === 'string' && parsed.open_question.trim() ? parsed.open_question.trim() : null;
  return { narrative, open_question: openQuestion };
}

// The one phrase a dossier must NEVER contain, in any confidence tier, per
// this node's done_means -- assert it here too (not just in the check
// script) so a future caller cannot regress it by constructing a
// hand-written narrative that happens to say it.
const BANNED_PHRASE_RE = /kevin wants you to work on this line from his notes/i;

/**
 * Every "#<digits>" token appearing anywhere in `text` -- used both to scan
 * the evidence corpus (what's ALREADY legitimately present) and to scan a
 * model's free text (what it CITED), so the two can be compared.
 */
function extractNodeRefTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/#(\d+)/g)) out.add(`#${m[1]}`);
  return [...out];
}

interface EvidenceCorpus {
  branches: Set<string>;
  repos: Set<string>;
  nodeRefs: Set<string>;
}

function buildEvidenceCorpus(evidence: DossierEvidence[], goal: KnownFacts['goal']): EvidenceCorpus {
  const branches = new Set<string>();
  const repos = new Set<string>();
  const nodeRefs = new Set<string>();
  for (const e of evidence) {
    // The corpus is everything LITERALLY PRESENT in what the model was
    // shown -- not just the structured `.branch`/`.repo` fields (which only
    // ever hold the single AUTHORITATIVE branch/repo per row). A tree row's
    // snippet can legitimately mention a superseded branch inside its
    // conflict note (see treeEvidence in notepad-dossier-sources.ts); the
    // model citing that historical branch back is using real evidence, not
    // inventing one, so it must not be rejected. Scanning the full blob
    // (ref + title + snippet) for every shape of token evidence could
    // contain -- not only the one field extraction happened to promote to
    // `.branch`/`.repo` -- is what makes that distinction correctly.
    const blob = `${e.ref} ${e.title} ${e.snippet}`;
    if (e.branch) branches.add(e.branch);
    for (const b of extractAllBranchTokens(blob)) branches.add(b);
    if (e.repo) repos.add(e.repo);
    for (const r of extractAllRepoTokens(blob)) repos.add(r);
    for (const t of extractNodeRefTokens(blob)) nodeRefs.add(t);
  }
  if (goal) {
    nodeRefs.add(`#${goal.goal_id}`);
    if (goal.node_id != null) nodeRefs.add(`#${goal.node_id}`);
  }
  return { branches, repos, nodeRefs };
}

/**
 * Validate a candidate model narrative/open_question against the evidence
 * corpus. Returns ok:true only when EVERY branch/repo/node-ref token the
 * model's text cites is one the deterministic evidence already proved --
 * one invented token anywhere rejects the whole output (rule 3 of the
 * node's spec: "be willing to throw it away").
 */
function validateModelOutput(parsed: ParsedDossierModelOutput, corpus: EvidenceCorpus): { ok: true } | { ok: false; reason: string } {
  const combined = `${parsed.narrative ?? ''}\n${parsed.open_question ?? ''}`;

  if (BANNED_PHRASE_RE.test(combined)) {
    return { ok: false, reason: 'model output rejected: used the banned placeholder phrasing' };
  }

  for (const b of extractAllBranchTokens(combined)) {
    if (!corpus.branches.has(b)) return { ok: false, reason: `model output rejected: cited unknown branch '${b}'` };
  }
  for (const r of extractAllRepoTokens(combined)) {
    if (!corpus.repos.has(r)) return { ok: false, reason: `model output rejected: cited unknown repo '${r}'` };
  }
  for (const n of extractNodeRefTokens(combined)) {
    if (!corpus.nodeRefs.has(n)) return { ok: false, reason: `model output rejected: cited unknown node reference '${n}'` };
  }
  return { ok: true };
}

// == Deterministic derivation of repo/branch/goal/prior_work =================

function firstDefined(evidence: DossierEvidence[], key: 'repo' | 'branch'): string | null {
  for (const e of evidence) {
    const v = e[key];
    if (v) return v;
  }
  return null;
}

function goalRefFromEvidence(
  db: DatabaseType,
  evidence: DossierEvidence[],
): { goal_id: number; node_id: number | null; title: string } | null {
  for (const e of evidence) {
    if (e.kind === 'goal') {
      const m = e.ref.match(/^goal:(\d+)(?:#(\d+))?$/);
      if (!m) continue;
      return { goal_id: Number(m[1]), node_id: m[2] ? Number(m[2]) : null, title: e.title };
    }
    if (e.kind === 'tree') {
      const m = e.ref.match(/^tree-([^#]+)(?:#(\d+))?$/);
      if (!m) continue;
      const treeId = m[1];
      try {
        const row = db
          .prepare(`SELECT goal_id, id AS node_id, title FROM goal_nodes WHERE tree_id = ? ORDER BY id DESC LIMIT 1`)
          .get(treeId) as { goal_id: number; node_id: number; title: string } | undefined;
        if (row) return { goal_id: row.goal_id, node_id: row.node_id, title: row.title };
      } catch {
        // goal_nodes unreachable -- this tree evidence simply has no
        // structured goal reference; fall through to the next evidence row.
      }
    }
  }
  return null;
}

/** Up to 5 short lines describing what's already known, in evidence score
 *  order. Orientation rows are reference docs, not "work that happened" --
 *  excluded here on purpose. */
function priorWorkLines(evidence: DossierEvidence[]): string[] {
  return evidence
    .filter((e) => e.kind === 'goal' || e.kind === 'tree' || e.kind === 'thread_summary')
    .slice(0, 5)
    .map((e) => `${e.title}: ${e.snippet.replace(/\s+/g, ' ').slice(0, 160)}`);
}

// == The deterministic renderer (the floor a rejected/failed model call can
// == never fall below) ========================================================

function renderNoneConfidence(text: string): string {
  return `JARVIS has no context on this line yet -- "${text}" doesn't match anything in goals, trees, or recent threads. Starting cold; nothing prior to draw on.`;
}

function renderDeterministic(params: {
  topic: string;
  confidence: DossierConfidence;
  repo: string | null;
  branch: string | null;
  goal: KnownFacts['goal'];
  priorWork: string[];
  openQuestion: string | null;
  narrative: string | null;
}): string {
  const lines: string[] = [`Topic: ${params.topic}`];

  if (params.goal) {
    lines.push(
      params.goal.node_id != null
        ? `Goal #${params.goal.goal_id}, node #${params.goal.node_id}: ${params.goal.title}`
        : `Goal #${params.goal.goal_id}: ${params.goal.title}`,
    );
  }
  if (params.repo || params.branch) {
    lines.push(`Repo/branch: ${[params.repo, params.branch].filter(Boolean).join(' @ ')}`);
  }

  if (params.priorWork.length > 0) {
    lines.push('Prior work:');
    for (const p of params.priorWork) lines.push(`- ${p}`);
  } else {
    lines.push('No prior work found in goals, trees, or recent threads.');
  }

  if (params.narrative) lines.push(params.narrative);

  if (params.confidence === 'weak') {
    const missing: string[] = [];
    if (!params.goal) missing.push('no linked goal or tree');
    if (!params.repo && !params.branch) missing.push('no repo or branch named in the evidence');
    lines.push(`JARVIS does not know: ${missing.length > 0 ? missing.join('; ') : 'the full picture -- evidence is thin'}.`);
  }

  if (params.openQuestion) lines.push(`Open question: ${params.openQuestion}`);

  return lines.join('\n');
}

// == The public entry point ==================================================

/**
 * Assemble a TopicDossier for one notepad line (by id or raw text). Zero
 * writes. See the module doc above for the structural guarantee this
 * provides: repo/branch/goal/prior_work are evidence-sourced facts, never
 * model output, and the model's own narrative/open_question are discarded
 * wholesale (falling back to a pure-evidence deterministic render) the
 * moment they cite anything the evidence didn't already prove.
 */
export async function buildTopicDossier(input: BuildDossierInput, opts: BuildDossierOptions = {}): Promise<TopicDossier> {
  const db = opts.db ?? sqliteDb;

  let lineId: number | null = input.line_id ?? null;
  let text: string;
  if (typeof input.text === 'string' && input.text.trim()) {
    text = input.text;
  } else if (lineId != null) {
    const line = getNotepadLine(lineId);
    if (!line) throw new Error(`notepad line ${lineId} not found`);
    text = line.text;
  } else {
    throw new Error('buildTopicDossier requires line_id or text');
  }

  const resolved = resolveTopic(text, db);
  const gatherOpts: GatherEvidenceOptions = { cacheDir: opts.cacheDir, orientationCacheTtlMs: opts.orientationCacheTtlMs };

  // -- topic:null -- confidence 'none', no source is even attempted, no
  // model call. Repo/branch/goal stay null and prior_work stays empty, per
  // this node's done_means -- there is nothing to be confident ABOUT.
  if (!resolved.topic) {
    const { evidence, availability } = await gatherEvidence(resolved.topic, resolved.terms, db, gatherOpts);
    return {
      line_id: lineId,
      text,
      topic: null,
      confidence: 'none',
      repo: null,
      branch: null,
      goal: null,
      prior_work: [],
      open_question: null,
      evidence,
      availability,
      rendered: renderNoneConfidence(text),
      unresolved_reason: null,
    };
  }

  const { evidence, availability } = await gatherEvidence(resolved.topic, resolved.terms, db, gatherOpts);

  const goal = goalRefFromEvidence(db, evidence);
  const repo = firstDefined(evidence, 'repo');
  const branch = firstDefined(evidence, 'branch');
  const priorWork = priorWorkLines(evidence);

  const foundGoalOrTree = evidence.some((e) => e.kind === 'goal' || e.kind === 'tree');
  const foundRepoOrBranch = repo !== null || branch !== null;
  const confidence: DossierConfidence = foundGoalOrTree && foundRepoOrBranch ? 'strong' : 'weak';

  const facts: KnownFacts = { topic: resolved.topic, goal, repo, branch };
  const corpus = buildEvidenceCorpus(evidence, goal);

  let openQuestion: string | null = null;
  let narrative: string | null = null;
  let unresolvedReason: string | null = null;

  const usingDefaultSpawn = !opts.runOneShot;
  if (usingDefaultSpawn) {
    // Outside the try/catch on purpose -- see notepad-gate.ts's identical
    // contract: under a scratch DB this throws loudly and synchronously OUT
    // of this function, rather than being caught and silently downgraded to
    // an all-fallback dossier that would read as a passing sim.
    assertModelSpawnAllowed();
  }
  const runOneShot = opts.runOneShot ?? defaultRunOneShot;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DOSSIER_TIMEOUT_MS;
  const prompt = buildDossierPrompt(text, facts, evidence);

  try {
    const raw = await withTimeout(runOneShot(prompt), timeoutMs);
    const parsed = parseDossierModelOutput(raw);
    if (!parsed) {
      unresolvedReason = 'model output rejected: response was not valid JSON in the expected shape';
    } else {
      const verdict = validateModelOutput(parsed, corpus);
      if (verdict.ok) {
        narrative = parsed.narrative;
        openQuestion = parsed.open_question;
      } else {
        unresolvedReason = verdict.reason;
      }
    }
  } catch (err) {
    unresolvedReason = `model call failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const rendered = renderDeterministic({
    topic: resolved.topic,
    confidence,
    repo,
    branch,
    goal,
    priorWork,
    openQuestion,
    narrative,
  });

  return {
    line_id: lineId,
    text,
    topic: resolved.topic,
    confidence,
    repo,
    branch,
    goal,
    prior_work: priorWork,
    open_question: openQuestion,
    evidence,
    availability,
    rendered,
    unresolved_reason: unresolvedReason,
  };
}
