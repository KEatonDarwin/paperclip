// docs-pass (2026-11-01) — the automatic, goal-level documentation pass.
//
// Replaces the old "Write the feature docs" machine node (plan + test loop + ACCEPT + fix round
// + two reviews + verify, ~20 min on goal #57 — ending in two doc defects an existence check
// would have caught for free). The shape is deliberately small:
//
//   1. FACTS AS IT GOES  (model-free)  — recordNodeFacts(): when a machine node passes its gate
//      and LANDS on the base branch, append a factual record to a per-goal facts file: the
//      node's title + done_means, the plan summary, each build step's finish summary, the
//      routes / artisan commands / pages / files the diff added, the tests that passed.
//   2. ONE DOCS PASS     (one cheap model) — maybeStartDocsPass(): when the goal's LAST machine
//      node has landed, Haiku turns the facts file into docs/_branches/<branch>/README.md and
//      commits it to the goal's branch. No tree, no plan, no review loop.
//   3. EXISTENCE CHECK   (model-free)  — every route, artisan command, page and file the README
//      names must exist on the branch. One retry with the mismatches fed back; if it still
//      fails the README is committed anyway with a visible warning line + a loud goal event.
//      Tests are NOT re-run for docs.
//   4. ONE SWITCH        — see docsPassEnabled().
//
// This module imports only conversation-db (no goals.ts) so goals.ts, the night shift and the
// autopilot can all call it without a circular import. It never throws out of a public entry
// point that sits in a verify/tick path.

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sqliteDb, getSetting, setSetting } from './conversation-db.js';
import { baseFromNotes, repoFromNotes } from './goal-order.js';

// -- settings / constants ----------------------------------------------------

const PROTECTED = new Set(['main', 'master', 'before']);
const FACTS_DIR = '/home/kevin/obsidian/paperclip-wiki/outbox/goal-facts';
const DEFAULT_SHAPE = '/home/kevin/obsidian/paperclip-wiki/outbox/staydesk-docs-sample/README.md';
const CLAUDE_BIN = '/home/kevin/.local/bin/claude';
const CLAUDE_B_DIR = '/home/kevin/.claude-b';
const HAIKU_TIMEOUT_MS = 6 * 60_000;
const MAX_RESUMES = 3;

type DocsStatus = 'running' | 'done' | 'warn' | 'failed' | 'skipped';
interface DocsState {
  status: DocsStatus;
  started_at: string;
  finished_at?: string;
  facts_n: number;
  repo?: string;
  base?: string;
  commit?: string;
  attempts?: number;
  mismatches?: string[];
  seconds?: number;
  resumes?: number;
  note?: string;
}

const active = new Map<number, Promise<void>>();

const stateKey = (goalId: number): string => `goal_docs_state_${goalId}`;

function readState(goalId: number): DocsState | null {
  const raw = getSetting(stateKey(goalId));
  if (!raw) return null;
  try { return JSON.parse(raw) as DocsState; } catch { return null; }
}
function writeState(goalId: number, st: DocsState): void {
  setSetting(stateKey(goalId), JSON.stringify(st));
}

function nowCt(): string {
  return new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }) + ' CT';
}

function goalEvent(goalId: number, kind: string, text: string, data?: unknown): void {
  sqliteDb.prepare(`INSERT INTO goal_events (goal_id, node_id, actor, kind, text, data) VALUES (?, NULL, 'system', ?, ?, ?)`)
    .run(goalId, kind, text, data !== undefined ? JSON.stringify(data) : null);
}

/** Mirror a docs-pass line into the running night shift (if any) so the shift page shows it. */
function shiftNote(goalId: number, text: string): void {
  try {
    const runs = sqliteDb.prepare(`SELECT id, goal_ids FROM night_runs WHERE status IN ('running','paused')`).all() as { id: number; goal_ids: string }[];
    for (const r of runs) {
      let ids: number[] = [];
      try { ids = JSON.parse(r.goal_ids) as number[]; } catch { /* ignore */ }
      if (ids.includes(goalId)) {
        sqliteDb.prepare(`INSERT INTO night_events (run_id, item_id, actor, kind, text, data) VALUES (?, NULL, 'system', 'narration', ?, NULL)`)
          .run(r.id, text);
      }
    }
  } catch { /* best effort */ }
}

function git(repo: string, args: string[], timeout = 30_000): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
function gitTry(repo: string, args: string[], timeout = 30_000): string | null {
  try { return git(repo, args, timeout); } catch { return null; }
}

// -- the one switch ----------------------------------------------------------

interface LeafRow { id: number; title: string; state: string; notes: string | null; done_means: string | null; tree_id: string | null; plan: string | null }

function machineLeaves(goalId: number): LeafRow[] {
  return sqliteDb.prepare(
    `SELECT id, title, state, notes, done_means, tree_id, plan FROM goal_nodes
      WHERE goal_id = ? AND leaf_kind = 'machine' AND state NOT IN ('discarded','ghost') ORDER BY sort_order, id`,
  ).all(goalId) as LeafRow[];
}

/** The docs-pass switch, most specific first:
 *    1. settings-KV `goal_docs_pass_<goalId>` = 0|off / 1|on   (per goal, flip any time)
 *    2. the goal's notes carry `[docs-pass: off]`              (set when the goal is created)
 *    3. settings-KV `goal_docs_pass_enabled` = 0               (global kill)
 *    4. default: ON when the goal builds code on a branch — a machine leaf's notes name a REPO
 *       and a non-protected `--base` branch — otherwise OFF. */
export function docsPassEnabled(goalId: number): { on: boolean; why: string } {
  const per = (getSetting(`goal_docs_pass_${goalId}`) ?? '').trim().toLowerCase();
  if (per === '0' || per === 'off') return { on: false, why: `settings-KV goal_docs_pass_${goalId}=${per}` };
  const g = sqliteDb.prepare(`SELECT notes FROM goals WHERE id = ?`).get(goalId) as { notes: string | null } | undefined;
  if (per === '1' || per === 'on') return { on: true, why: `settings-KV goal_docs_pass_${goalId}=${per}` };
  if (/\[docs-pass:\s*off\]/i.test(g?.notes ?? '')) return { on: false, why: 'goal notes carry [docs-pass: off]' };
  if (getSetting('goal_docs_pass_enabled') === '0') return { on: false, why: 'settings-KV goal_docs_pass_enabled=0 (global kill)' };
  for (const n of machineLeaves(goalId)) {
    const base = baseFromNotes(n.notes);
    if (repoFromNotes(n.notes) && base && !PROTECTED.has(base.toLowerCase())) return { on: true, why: `default: builds on branch ${base}` };
  }
  return { on: false, why: 'default: no machine leaf names a REPO + non-protected --base branch' };
}

// -- facts as it goes --------------------------------------------------------

interface NodeLike { id: number; goal_id?: number; title: string; done_means: string | null; notes: string | null; plan?: string | null; tree_id: string | null }
interface TreeLike { id: string; repo_path: string | null; integration_branch: string | null }
export interface BaseSnapshot { repo: string; base: string; sha: string }

/** Where the base branch is right now — taken just BEFORE the land so the diff is exact. */
export function snapshotBase(node: NodeLike, tree: TreeLike): BaseSnapshot | null {
  try {
    const base = baseFromNotes(node.notes);
    const repo = tree.repo_path || repoFromNotes(node.notes);
    if (!base || !repo || PROTECTED.has(base.toLowerCase())) return null;
    const sha = gitTry(repo, ['rev-parse', '--verify', base])?.trim();
    return sha ? { repo, base, sha } : null;
  } catch { return null; }
}

/** Facts dir — overridable with settings-KV `goal_facts_dir` so the offline regeneration proof
 *  can write to a scratch dir without touching the engine-written files. Defaults to FACTS_DIR. */
function factsDir(): string { return (getSetting('goal_facts_dir') || FACTS_DIR).trim(); }
function factsPath(goalId: number): string { return path.join(factsDir(), `goal-${goalId}.md`); }

function clip(s: string | null | undefined, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Routes / artisan commands / pages / files / tests the diff ADDED — from the diff, not prose. */
function diffFacts(repo: string, from: string, to: string): string[] {
  const out: string[] = [];
  const ns = gitTry(repo, ['diff', '--name-status', `${from}..${to}`]);
  const files = (ns ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [st, ...rest] = l.split(/\s+/);
    return { st, file: rest.join(' ') };
  });
  const added = files.filter((f) => f.st.startsWith('A')).map((f) => f.file);
  const modified = files.filter((f) => !f.st.startsWith('A') && !f.st.startsWith('D')).map((f) => f.file);
  out.push(`- Files added (${added.length}): ${added.map((f) => `\`${f}\``).join(', ') || '—'}`);
  out.push(`- Files modified (${modified.length}): ${modified.map((f) => `\`${f}\``).join(', ') || '—'}`);

  const routeDiff = gitTry(repo, ['diff', '-U0', `${from}..${to}`, '--', 'routes']) ?? '';
  const routes: string[] = [];
  const commands: string[] = [];
  for (const line of routeDiff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const r = /Route::(get|post|put|patch|delete|any|view|resource)\(\s*['"]([^'"]+)['"]/.exec(line);
    if (r) {
      const nm = /->name\(\s*['"]([^'"]+)['"]/.exec(line);
      routes.push(`${r[1].toUpperCase()} ${r[2].startsWith('/') ? r[2] : `/${r[2]}`}${nm ? ` (name \`${nm[1]}\`)` : ''}`);
    }
    const c = /Artisan::command\(\s*['"]([^'"\s]+)/.exec(line);
    if (c) commands.push(c[1]);
  }
  for (const f of added.filter((x) => /^app\/Console\/Commands\/.+\.php$/.test(x))) {
    const body = gitTry(repo, ['show', `${to}:${f}`]) ?? '';
    const sig = /\$signature\s*=\s*['"]([^'"\s]+)/.exec(body);
    if (sig) commands.push(sig[1]);
  }
  out.push(`- Routes added: ${routes.length ? routes.map((x) => `\`${x}\``).join(', ') : '—'}`);
  out.push(`- Artisan commands added: ${commands.length ? commands.map((x) => `\`${x}\``).join(', ') : '—'}`);
  const pages = added.filter((x) => /^resources\/views\/.+\.blade\.php$/.test(x));
  out.push(`- Pages/views added: ${pages.length ? pages.map((x) => `\`${x}\``).join(', ') : '—'}`);

  const testFiles = added.filter((x) => /^tests\/.+\.php$/.test(x));
  const testNames: string[] = [];
  for (const f of testFiles) {
    const body = gitTry(repo, ['show', `${to}:${f}`]) ?? '';
    for (const m of body.matchAll(/public function (test\w+|\w+_(?:it|should)\w*)\s*\(/g)) testNames.push(`${path.basename(f)}::${m[1]}`);
    for (const m of body.matchAll(/\b(?:it|test)\(\s*['"]([^'"]+)['"]/g)) testNames.push(`${path.basename(f)}: ${m[1]}`);
  }
  out.push(`- Test files added (${testFiles.length}): ${testFiles.map((x) => `\`${x}\``).join(', ') || '—'}`);
  if (testNames.length) out.push(`- Test methods (${testNames.length}): ${testNames.slice(0, 40).join('; ')}`);
  return out;
}

type Db = typeof sqliteDb;

/** The node's whole tree chain, oldest→newest (the landing tree last). A replan/patch tree
 *  keeps the FIRST tree's integration (merge-back) branch, so trees sharing it + the repo ARE
 *  the chain. Without this, a replanned node's facts only ever saw the final patch tree and lost
 *  the original feature's plan, its build steps and its TEST-gate counts (goal #58 node #478,
 *  2026-11-01). Falls back to [finalId] when there is no integration branch to group on. */
function treeChain(db: Db, repo: string, integrationBranch: string | null | undefined, finalId: string): string[] {
  if (!integrationBranch) return [finalId];
  const rows = db.prepare(
    `SELECT id FROM hopper_trees WHERE integration_branch = ? AND repo_path = ? ORDER BY created_at, id`,
  ).all(integrationBranch, repo) as { id: string }[];
  const ids = rows.map((r) => r.id);
  if (!ids.includes(finalId)) ids.push(finalId);
  return ids;
}

/** Test totals from a tree's TEST gate nodes (every run). */
function gateCounts(treeId: string, db: Db = sqliteDb): string {
  const rows = db.prepare(`SELECT title, result FROM hopper_nodes WHERE tree_id = ? AND title LIKE 'TEST gate%' ORDER BY id`).all(treeId) as { title: string; result: string | null }[];
  const parts: string[] = [];
  for (const r of rows) {
    const m = /"passed"\s*:\s*(\d+)[^}]*?"failed"\s*:\s*(\d+)[^}]*?"total"\s*:\s*(\d+)/s.exec(r.result ?? '');
    if (m) parts.push(`${r.title}: ${m[1]} passed, ${m[2]} failed (total ${m[3]})`);
  }
  return parts.join('; ');
}

/** TEST-gate counts across the WHOLE chain, labelled by tree when there is more than one. */
function gateCountsChain(chain: string[], db: Db = sqliteDb): string {
  const parts: string[] = [];
  for (let i = 0; i < chain.length; i += 1) {
    const c = gateCounts(chain[i], db);
    if (c) parts.push(chain.length > 1 ? `[${i === 0 ? 'original' : `patch ${i}`}] ${c}` : c);
  }
  return parts.length ? parts.join('; ') : 'no TEST gate result recorded on any tree for this node';
}

/** Plan summary across the chain: the original feature's plan first, then each patch round. */
function planSummaryChain(node: NodeLike, chain: string[], db: Db = sqliteDb): string {
  const parts: string[] = [];
  for (let i = 0; i < chain.length; i += 1) {
    const planning = db.prepare(`SELECT result FROM hopper_nodes WHERE tree_id = ? AND node_kind = 'planning' ORDER BY id LIMIT 1`).get(chain[i]) as { result: string | null } | undefined;
    const c = clip(planning?.result, chain.length > 1 ? 600 : 900);
    if (c) parts.push(chain.length > 1 ? `${i === 0 ? 'Original' : `Patch round ${i}`}: ${c}` : c);
  }
  if (parts.length) return parts.join('\n    ');
  try {
    if (node.plan) {
      const p = JSON.parse(node.plan) as { what?: string; deliverable?: string };
      const t = [p.what, p.deliverable].filter(Boolean).join(' — ');
      if (t) return clip(t, 900);
    }
  } catch { /* fall through */ }
  return '(no plan summary recorded)';
}

function buildSteps(treeId: string, db: Db = sqliteDb): string[] {
  const rows = db.prepare(
    `SELECT title, status, node_kind, result, result_summary FROM hopper_nodes WHERE tree_id = ? ORDER BY id`,
  ).all(treeId) as { title: string; status: string; node_kind: string | null; result: string | null; result_summary: string | null }[];
  const out: string[] = [];
  for (const r of rows) {
    if (r.node_kind === 'planning') continue;
    if (/^(ACCEPT|TEST gate|TEST REVIEW|REVIEW)/.test(r.title)) {
      out.push(`  - ${r.title} (${r.status}): ${clip(r.result, 160)}`);
    } else {
      out.push(`  - ${r.title} (${r.status}): ${clip(r.result, 700)}`);
    }
  }
  return out;
}

/** Build steps across the WHOLE chain, each tree labelled when there is more than one. */
function buildStepsChain(chain: string[], db: Db = sqliteDb): string[] {
  const out: string[] = [];
  for (let i = 0; i < chain.length; i += 1) {
    if (chain.length > 1) out.push(`  [${i === 0 ? 'original tree' : `patch tree ${i}`} ${chain[i]}]`);
    out.push(...buildSteps(chain[i], db));
  }
  return out;
}

/** The facts block for ONE node — pure, read-only, db-injectable. Walks the node's whole tree
 *  chain so a replanned node keeps its original plan, build steps and TEST-gate counts. Used by
 *  recordNodeFacts (live) and by the offline regeneration proof (with a read-only db). */
export function buildNodeBlock(node: NodeLike, tree: TreeLike, pre: BaseSnapshot | null, db: Db = sqliteDb): string {
  const base = baseFromNotes(node.notes);
  const repo = tree.repo_path || repoFromNotes(node.notes);
  if (!base || !repo || PROTECTED.has(base.toLowerCase())) return '';
  const post = gitTry(repo, ['rev-parse', '--verify', base])?.trim() ?? null;
  const intOnBase = !!(tree.integration_branch && gitTry(repo, ['merge-base', '--is-ancestor', tree.integration_branch, base]) !== null);
  const landed = !!post && ((!!pre && pre.sha !== post) || intOnBase);
  const from = pre?.sha ?? (tree.integration_branch ? gitTry(repo, ['merge-base', base, tree.integration_branch])?.trim() ?? null : null);
  const chain = treeChain(db, repo, tree.integration_branch, tree.id);

  const lines: string[] = [];
  lines.push(`## Node #${node.id} — ${node.title}`);
  lines.push(`<!-- node:${node.id} landed=${landed ? 'yes' : 'no'} -->`);
  lines.push(`- Landed on \`${base}\`: ${landed ? `yes — ${from ? from.slice(0, 8) : '?'}..${post ? post.slice(0, 8) : '?'}, ${nowCt()}` : 'NO — the node passed its gate but git does not show it on the base branch'}`);
  lines.push(`- Done means: ${clip(node.done_means, 900)}`);
  lines.push(`- Plan: ${planSummaryChain(node, chain, db)}`);
  lines.push(`- Tests (from the TEST gate): ${gateCountsChain(chain, db)}`);
  lines.push(`- Build steps (${chain.length} tree${chain.length > 1 ? 's' : ''}: ${chain.join(' → ')}):`);
  lines.push(...buildStepsChain(chain, db));
  if (landed && from && post) {
    lines.push('- What the diff added (from git, not prose):');
    lines.push(...diffFacts(repo, from, post).map((l) => `  ${l}`));
  }
  lines.push('');
  return lines.join('\n');
}

/** Append (or replace) this node's block in the goal's facts file. Model-free. */
export function recordNodeFacts(goalId: number, node: NodeLike, tree: TreeLike, pre: BaseSnapshot | null): void {
  if (!docsPassEnabled(goalId).on) return;
  const base = baseFromNotes(node.notes);
  const repo = tree.repo_path || repoFromNotes(node.notes);
  if (!base || !repo || PROTECTED.has(base.toLowerCase())) return;
  const block = buildNodeBlock(node, tree, pre);
  if (!block) return;
  const landed = /<!-- node:\d+ landed=yes -->/.test(block);

  fs.mkdirSync(factsDir(), { recursive: true });
  const fp = factsPath(goalId);
  const g = sqliteDb.prepare(`SELECT title FROM goals WHERE id = ?`).get(goalId) as { title: string } | undefined;
  const testProject = /jarvis-test\s+([\w-]+)/.exec(node.notes ?? '')?.[1] ?? '';
  let doc = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf8') : '';
  if (!doc) {
    doc = `# Facts — goal #${goalId}: ${g?.title ?? ''}\n_Engine-written, model-free. Not edited by hand._\n\n` +
      `<!-- facts:v1 repo=${repo} base=${base} test=${testProject} -->\n- Repo: \`${repo}\`\n- Branch: \`${base}\`\n- Test command: ${testProject ? `\`jarvis-test ${testProject}\`` : '(not recorded)'}\n\n`;
  }
  const marker = `## Node #${node.id} — `;
  const idx = doc.indexOf(marker);
  if (idx >= 0) {
    const next = doc.indexOf('\n## Node #', idx + 5);
    doc = doc.slice(0, idx) + block + (next >= 0 ? doc.slice(next + 1) : '');
  } else {
    doc += block;
  }
  fs.writeFileSync(fp, doc);
  goalEvent(goalId, 'docs_facts', `Facts recorded for node #${node.id} (${landed ? 'landed' : 'NOT landed'}) → ${fp}`, { node_id: node.id, landed, facts_path: fp });
}

function landedFactsCount(goalId: number): number {
  try {
    const doc = fs.readFileSync(factsPath(goalId), 'utf8');
    return (doc.match(/<!-- node:\d+ landed=yes -->/g) ?? []).length;
  } catch { return 0; }
}
function unlandedFacts(goalId: number): number[] {
  try {
    const doc = fs.readFileSync(factsPath(goalId), 'utf8');
    return [...doc.matchAll(/<!-- node:(\d+) landed=no -->/g)].map((m) => Number(m[1]));
  } catch { return []; }
}

// -- the docs pass ------------------------------------------------------------

/** True while the goal's docs pass is in flight. Also self-heals: if the process restarted
 *  mid-pass (state=running but no live promise), the pass is resumed here. */
export function docsPassPending(goalId: number): boolean {
  try {
    const st = readState(goalId);
    if (!st || st.status !== 'running') return false;
    if (active.has(goalId)) return true;
    if ((st.resumes ?? 0) >= MAX_RESUMES) {
      finishState(goalId, st, 'failed', { note: `docs pass resumed ${MAX_RESUMES}x after restarts and never finished` });
      goalEvent(goalId, 'docs_pass_failed', `Docs pass abandoned after ${MAX_RESUMES} resumes — the human leaf is released without docs. Re-run by setting settings-KV goal_docs_state_${goalId} to empty.`);
      return false;
    }
    st.resumes = (st.resumes ?? 0) + 1;
    writeState(goalId, st);
    launch(goalId);
    return true;
  } catch { return false; }
}

function finishState(goalId: number, st: DocsState, status: DocsStatus, extra: Partial<DocsState> = {}): void {
  const now = new Date();
  writeState(goalId, { ...st, ...extra, status, finished_at: now.toISOString(), seconds: Math.round((now.getTime() - Date.parse(st.started_at)) / 1000) });
}

/** Called after every landed node. Starts the one docs pass when the LAST machine node landed. */
export function maybeStartDocsPass(goalId: number): void {
  const sw = docsPassEnabled(goalId);
  if (!sw.on) return;
  const leaves = machineLeaves(goalId);
  if (!leaves.length || leaves.some((l) => l.state !== 'done')) return;      // not the last one yet
  const n = landedFactsCount(goalId);
  const st = readState(goalId);
  if (st?.status === 'running') return;
  if (st && (st.status === 'done' || st.status === 'warn') && st.facts_n >= n) return;  // already documented this much
  const unlanded = unlandedFacts(goalId);
  if (n === 0 || unlanded.length) {
    const why = n === 0
      ? 'no machine node has a landed facts record (nothing on the branch to document)'
      : `node(s) ${unlanded.map((i) => `#${i}`).join(', ')} passed but are NOT on the base branch`;
    writeState(goalId, { status: 'skipped', started_at: new Date().toISOString(), finished_at: new Date().toISOString(), facts_n: n, note: why });
    goalEvent(goalId, 'docs_pass_skipped', `Docs pass SKIPPED: ${why}. The human leaf is released without docs.`);
    shiftNote(goalId, `Docs pass skipped for goal #${goalId}: ${why}.`);
    return;
  }
  const doc = fs.readFileSync(factsPath(goalId), 'utf8');
  const meta = /<!-- facts:v1 repo=(\S+) base=(\S+) test=(\S*) -->/.exec(doc);
  writeState(goalId, { status: 'running', started_at: new Date().toISOString(), facts_n: n, repo: meta?.[1], base: meta?.[2], resumes: 0 });
  goalEvent(goalId, 'docs_pass_started', `Docs pass started: ${n} landed node(s) → docs/_branches/${meta?.[2] ?? '?'}/README.md (Haiku, one pass + existence check). Facts: ${factsPath(goalId)}`, { facts_n: n });
  shiftNote(goalId, `Docs pass started for goal #${goalId} (${n} landed node(s)); the human sign-off waits for it.`);
  launch(goalId);
}

function launch(goalId: number): void {
  if (active.has(goalId)) return;
  const p = runDocsPass(goalId)
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[docs-pass] goal ${goalId} crashed: ${msg}`);
      const st = readState(goalId);
      if (st) finishState(goalId, st, 'failed', { note: msg.slice(0, 400) });
      goalEvent(goalId, 'docs_pass_failed', `Docs pass FAILED: ${msg.slice(0, 400)} — the human leaf is released without docs.`);
      shiftNote(goalId, `Docs pass FAILED for goal #${goalId}: ${msg.slice(0, 200)}`);
    })
    .finally(() => { active.delete(goalId); });
  active.set(goalId, p);
}

// ---- existence check (model-free) ----

const BUILTIN_ARTISAN = /^(test|serve|tinker|about|list|help|migrate(:[\w-]+)?|db:[\w-]+|queue:[\w-]+|key:generate|storage:link|route:[\w-]+|config:[\w-]+|cache:[\w-]+|view:[\w-]+|event:[\w-]+|schedule:[\w-]+|make:[\w:-]+|optimize(:[\w-]+)?|vendor:publish|package:discover|down|up|env|inspire|model:[\w-]+|lang:[\w-]+|session:[\w-]+|auth:[\w-]+|pail|sail:[\w-]+|breeze:[\w-]+)$/;
const SKIP_PATH_PREFIX = ['/home', '/tmp', '/var', '/usr', '/etc', '/opt', '/dev', '/mnt', '/storage', '/build', '/vendor', '/public', '/node_modules'];
const SETUP_CREATED = [/^\.env$/, /^database\/database\.sqlite$/, /^vendor(\/|$)/, /^node_modules(\/|$)/, /^public\/build(\/|$)/, /^storage\//, /^bootstrap\/cache\//, /^public\/storage/];

function listPhp(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else if (e.name.endsWith('.php')) out.push(f);
    }
  };
  walk(dir);
  return out;
}

export function checkReadme(readme: string, wt: string): string[] {
  const miss: string[] = [];
  const routesText = listPhp(path.join(wt, 'routes')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const cmdText = [
    ...listPhp(path.join(wt, 'app/Console')).map((f) => fs.readFileSync(f, 'utf8')),
    routesText,
  ].join('\n');
  const appCommands = new Set<string>();
  for (const m of cmdText.matchAll(/Artisan::command\(\s*['"]([^'"\s]+)/g)) appCommands.add(m[1]);
  for (const m of cmdText.matchAll(/\$signature\s*=\s*['"]([^'"\s]+)/g)) appCommands.add(m[1]);

  // artisan commands — anywhere in the text
  const seenCmd = new Set<string>();
  for (const m of readme.matchAll(/php\s+artisan\s+([a-z][\w:.-]*)/gi)) {
    const c = m[1].replace(/[.,;:]+$/, '');
    if (seenCmd.has(c)) continue;
    seenCmd.add(c);
    if (!appCommands.has(c) && !BUILTIN_ARTISAN.test(c)) miss.push(`artisan command \`${c}\` is not defined in routes/console.php or app/Console`);
  }

  // routes / pages — inline code spans that are paths, METHOD /path, and localhost URLs
  const paths = new Set<string>();
  for (const m of readme.matchAll(/`([^`\n]+)`/g)) {
    const t = m[1].trim();
    const meth = /^(?:GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/.exec(t);
    if (meth) paths.add(meth[1]);
    else if (/^\/[A-Za-z0-9_\-/{}]*$/.test(t)) paths.add(t);
  }
  for (const m of readme.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(\/[A-Za-z0-9_\-/{}]*)/g)) paths.add(m[1]);
  for (const raw of paths) {
    const p = raw.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
    if (p === '/' || SKIP_PATH_PREFIX.some((s) => p === s || p.startsWith(`${s}/`))) continue;
    const segs = p.split('/').filter(Boolean).filter((s) => !/^\{.*\}$/.test(s) && !/^\d+$/.test(s));
    const bad = segs.find((s) => {
      const esc = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return !new RegExp(`['"/]${esc}(?=['"/{?])`).test(routesText) && !new RegExp(`resource\\(\\s*['"]${esc}['"]`).test(routesText);
    });
    if (bad) miss.push(`route/page \`${raw}\`: no route in routes/*.php contains "${bad}"`);
  }

  // files — inline code spans that look like repo paths
  const files = new Set<string>();
  for (const m of readme.matchAll(/`([^`\n]+)`/g)) {
    let t = m[1].trim().replace(/^\.\//, '').replace(/::.*$/, '').replace(/:\d+(-\d+)?$/, '');
    if (/[\s*<>{}$|;]/.test(t) || t.includes('...')) continue;
    if (/^(app|routes|resources|database|tests|config|docs|public)\//.test(t) || /^[\w.-]+\/[\w./@-]+\.(php|js|json|md|css|sql|ts|vue|xml)$/.test(t)) files.add(t);
  }
  for (const f of files) {
    if (SETUP_CREATED.some((re) => re.test(f))) continue;
    if (/^docs\/_branches\//.test(f)) continue;
    if (!fs.existsSync(path.join(wt, f))) miss.push(`file \`${f}\` does not exist on the branch`);
  }
  return miss;
}

// ---- the Haiku call ----

function runHaiku(prompt: string): Promise<string> {
  const model = getSetting('goal_docs_model') || 'claude-haiku-5-5';
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    env.CLAUDE_CONFIG_DIR = CLAUDE_B_DIR;           // automation runs on Claude B
    const args = ['--print', '-', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
      '--model', model, '--tools', '', '--no-session-persistence', '--disable-slash-commands'];
    const child = spawn(CLAUDE_BIN, args, { env, cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`haiku timed out after ${HAIKU_TIMEOUT_MS / 1000}s`)); }, HAIKU_TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let result: string | null = null; let isErr = false;
      for (const line of out.split('\n')) {
        if (!line.startsWith('{')) continue;
        try {
          const ev = JSON.parse(line) as { type?: string; result?: string; is_error?: boolean };
          if (ev.type === 'result') { result = ev.result ?? ''; isErr = !!ev.is_error; }
        } catch { /* ignore */ }
      }
      if (result && !isErr) { resolve(result); return; }
      reject(new Error(`haiku produced no result (exit ${code}, ${out.length}B out): ${(result ?? err).slice(0, 300)}`));
    });
    child.stdin.end(prompt);
  });
}

function stripFence(t: string): string {
  const m = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(t);
  return (m ? m[1] : t).trim();
}

function groundTruth(wt: string): string {
  const parts: string[] = [];
  const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s);
  for (const f of ['routes/web.php', 'routes/console.php']) {
    try { parts.push(`### ${f}\n\`\`\`php\n${cap(fs.readFileSync(path.join(wt, f), 'utf8'), 7000)}\n\`\`\``); } catch { /* absent */ }
  }
  const cmds = listPhp(path.join(wt, 'app/Console')).map((f) => {
    const sig = /\$signature\s*=\s*['"]([^'"]+)/.exec(fs.readFileSync(f, 'utf8'));
    return sig ? `${path.relative(wt, f)}  →  ${sig[1]}` : null;
  }).filter(Boolean);
  if (cmds.length) parts.push(`### Artisan command classes\n${cmds.join('\n')}`);
  const ls = gitTry(wt, ['ls-files', 'app', 'resources/views', 'database', 'tests', 'config', 'composer.json', 'package.json', '.env.example', 'phpunit.xml']) ?? '';
  parts.push(`### Files on the branch (app, views, database, tests)\n${cap(ls.trim(), 6000)}`);
  return parts.join('\n\n');
}

function buildPrompt(args: { facts: string; shape: string; truth: string; base: string; testCmd: string; mismatches: string[] | null }): string {
  const fix = args.mismatches?.length
    ? `\n\n## FIX THESE — your previous draft named things that DO NOT EXIST on the branch\nA mechanical check failed on:\n${args.mismatches.map((m) => `- ${m}`).join('\n')}\nRewrite the README so every one of these is removed or corrected using only the GROUND TRUTH below. Keep everything else.`
    : '';
  return [
    `You are writing the documentation README for a feature branch called \`${args.base}\`. You have NO tools and cannot run anything: you work only from the FACTS and GROUND TRUTH below. Output ONLY the README markdown — no preamble, no code fence around the whole thing.`,
    `## What to write\nA first-time-reader README, in plain English, that someone who has never seen this branch can follow end to end. Follow the SAMPLE's section order, tone and depth (plain-English top; what it does; how it works with the file for each step; the rules and where they are enforced; the data; SET UP & VERIFY with each command in order and what you should see; commands & pages table; things to try). The sample documents a DIFFERENT build — copy its structure and plainness, none of its facts.`,
    `## Hard rules\n- Every artisan command, route/page and file path you name MUST appear in the FACTS or GROUND TRUTH. Never invent one. If you are unsure a thing exists, leave it out.\n- Quote test counts only from the FACTS ("TEST gate" lines). Never guess a number; where an output depends on the clock or the data, say it is clock-dependent / run it and see.\n- The test command is: ${args.testCmd}. Show it exactly.\n- The branch is \`${args.base}\`. Put a line near the top: "_Branch \`${args.base}\`. Written automatically from what was built; every command, route and file below was checked against the branch._"\n- Do not claim a behaviour the FACTS do not support. If a limitation or a deliberate demo case is in the FACTS, state it plainly.`,
    fix,
    `# SAMPLE README (shape reference only)\n${args.shape}`,
    `# FACTS (what the engine recorded as each node landed)\n${args.facts}`,
    `# GROUND TRUTH (the branch as it is now)\n${args.truth}`,
  ].join('\n\n');
}

async function runDocsPass(goalId: number): Promise<void> {
  const st0 = readState(goalId);
  if (!st0 || st0.status !== 'running') return;
  const t0 = Date.parse(st0.started_at);
  const factsFile = factsPath(goalId);
  const facts = fs.readFileSync(factsFile, 'utf8');
  const meta = /<!-- facts:v1 repo=(\S+) base=(\S+) test=(\S*) -->/.exec(facts);
  if (!meta) throw new Error('facts file has no header');
  const [, repo, base, test] = meta;
  if (PROTECTED.has(base.toLowerCase())) throw new Error(`refusing to write docs onto protected branch ${base}`);
  const testCmd = test ? `\`jarvis-test ${test}\`` : 'the project\'s jarvis-test command';
  const shapePath = getSetting('goal_docs_shape_path') || DEFAULT_SHAPE;
  const shape = fs.existsSync(shapePath) ? fs.readFileSync(shapePath, 'utf8') : '(no sample available — use plain sections: what it does, how it works, rules, data, set up & verify, commands & pages, things to try)';

  const oldSha = git(repo, ['rev-parse', '--verify', base]).trim();
  const wtRoot = `${repo}-worktrees`;
  fs.mkdirSync(wtRoot, { recursive: true });
  const wt = path.join(wtRoot, `docs-pass-g${goalId}-${Date.now().toString(36)}`);
  git(repo, ['worktree', 'add', '--detach', wt, base]);
  try {
    const truth = groundTruth(wt);
    let readme = '';
    let mismatches: string[] = [];
    let attempts = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      attempts = attempt;
      const raw = await runHaiku(buildPrompt({ facts, shape, truth, base, testCmd, mismatches: attempt === 1 ? null : mismatches }));
      readme = stripFence(raw);
      if (readme.length < 400) throw new Error(`haiku README is implausibly short (${readme.length}B)`);
      mismatches = checkReadme(readme, wt);
      goalEvent(goalId, 'docs_pass_check', `Existence check, attempt ${attempt}: ${mismatches.length ? `${mismatches.length} mismatch(es)` : 'clean'}${mismatches.length ? ` — ${mismatches.slice(0, 6).join(' | ')}` : ''}`, { attempt, mismatches });
      if (!mismatches.length) break;
    }
    if (mismatches.length) {
      readme = `> ⚠️ **Docs check warning:** ${mismatches.length} reference(s) in this README could not be found on this branch after a retry: ${mismatches.slice(0, 8).join('; ')}. Treat those lines as unverified until someone fixes them.\n\n${readme}`;
    }

    const rel = `docs/_branches/${base}/README.md`;
    fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
    fs.writeFileSync(path.join(wt, rel), `${readme.trim()}\n`);
    git(wt, ['add', rel]);
    git(wt, ['-c', 'user.name=JARVIS docs-pass', '-c', 'user.email=jarvis@localhost', 'commit', '-q', '-m',
      `docs(${base}): automatic feature README${mismatches.length ? ' (with check warning)' : ''}\n\nWritten by the engine's goal docs pass from the per-goal facts file; existence-checked against the branch.`]);
    const commit = git(wt, ['rev-parse', 'HEAD']).trim();

    // Land the docs commit on the branch: fast-forward only, compare-and-swap on the old tip.
    const cur = gitTry(repo, ['symbolic-ref', '--short', 'HEAD'])?.trim() ?? null;
    if (cur === base) git(repo, ['merge', '--ff-only', commit]);
    else git(repo, ['update-ref', `refs/heads/${base}`, commit, oldSha]);
    const onBase = gitTry(repo, ['merge-base', '--is-ancestor', commit, base]) !== null;
    if (!onBase) throw new Error(`docs commit ${commit.slice(0, 8)} is not on ${base} after the update`);

    const st = readState(goalId) ?? st0;
    const secs = Math.round((Date.now() - t0) / 1000);
    finishState(goalId, st, mismatches.length ? 'warn' : 'done', { commit, attempts, mismatches, repo, base });
    if (mismatches.length) {
      const text = `Docs pass finished WITH WARNING in ${secs}s: README committed (${commit.slice(0, 8)}) but ${mismatches.length} reference(s) failed the existence check after a retry: ${mismatches.join('; ')}`;
      goalEvent(goalId, 'docs_pass_warning', text, { commit, mismatches });
      shiftNote(goalId, `⚠️ ${text}`);
      console.warn(`[docs-pass] goal ${goalId}: ${text}`);
    } else {
      const text = `Docs pass done in ${secs}s: ${rel} committed to ${base} (${commit.slice(0, 8)}); existence check clean${attempts > 1 ? ' after one retry' : ''}.`;
      goalEvent(goalId, 'docs_pass_done', text, { commit, attempts });
      shiftNote(goalId, text);
    }
  } finally {
    // Remove only the temp worktree this pass created.
    gitTry(repo, ['worktree', 'remove', '--force', wt]);
  }
}

