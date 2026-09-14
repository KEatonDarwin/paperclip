import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { getConversation, getOrCreateConversation, setThreadModelOverride, sqliteDb } from './conversation-db.js';
import { getFoundrySetting } from './foundry-settings.js';
import { getFoundrySkillDir, renderTemplate } from './foundry-templates.js';
import {
  agreeHopperTree,
  createHopperTree,
  getHopperTree,
  getHopperNode,
  listTreeNodes,
  prepareFoundryAutoRetry,
  retryHopperNode,
  updateHopperNodeSpec,
  type HopperNodeRow,
  type HopperNodeStatus,
  type HopperTreeRow,
  type NewNodeInput,
} from './hopper-engine.js';
import { createNotification } from './notifications.js';
import { sseBus, type SSEEvent } from './sse-bus.js';
import { setPreviewLink } from './thread-links.js';

/**
 * "Open thread" advisor — a fresh cockpit thread primed to understand either
 * the whole project (orchestrator) or one module, so Kevin can ask questions
 * as they come up. Deterministic external_id per scope so it's reused (one
 * standing advisor per project / per module), lazily primed on first open.
 * Returns the seed text; the cockpit posts it to /threads/:ext/messages only
 * when `primed` is false (mirrors the hopper-promote 2-step). Sonnet-routed.
 */
function readModuleDoc(repoPath: string, key: string, file: string): string | null {
  try {
    const p = path.join(repoPath, 'modules', key, file);
    if (!fs.existsSync(p)) return null;
    const body = fs.readFileSync(p, 'utf8').trim();
    if (!body) return null;
    return body.length > 4000 ? body.slice(0, 4000) + '\n…(truncated)' : body;
  } catch { return null; }
}

export function buildFoundryAdvisor(
  projectId: string,
  moduleKey?: string,
): { external_id: string; seed_text: string; primed: boolean } | null {
  const project = getProjectStmt.get(projectId);
  if (!project) return null;

  const parseJson = <T,>(s: string | null | undefined, fallback: T): T => {
    try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
  };

  let ext: string;
  let seed: string;

  if (moduleKey) {
    const m = moduleByKeyStmt.get(projectId, moduleKey);
    if (!m) return null;
    ext = `cockpit:foundry-advisor-${projectId}--${moduleKey}`;
    const contract = parseJson<{ provides: unknown[]; requires: unknown[] }>(m.contract, { provides: [], requires: [] });
    const acceptance = parseJson<string[]>(m.acceptance, []);
    const verify = readModuleDoc(project.repo_path, moduleKey, 'VERIFY.md');
    const readme = readModuleDoc(project.repo_path, moduleKey, 'README.md');
    seed = [
      `You are the **Foundry advisor** for the \`${moduleKey}\` module in project \`${projectId}\` (${project.name}).`,
      `Answer Kevin's questions about THIS module — what it does, its contract, why it's in its current state, and what fixing/changing it would take. Be concise and concrete; you have the real artifacts below.`,
      ``,
      `PURPOSE: ${m.purpose ?? '(none)'}`,
      `KIND: ${m.kind}   STAGE: ${m.stage ?? '(unknown)'}   BRANCH: ${m.branch ?? '(none)'}`,
      m.blocked_reason ? `BLOCKED REASON: ${m.blocked_reason}` : '',
      ``,
      `CONTRACT provides: ${JSON.stringify(contract.provides)}`,
      `CONTRACT requires: ${JSON.stringify(contract.requires)}`,
      `ACCEPTANCE:\n${acceptance.map((a) => `  - ${a}`).join('\n') || '  (none)'}`,
      ``,
      m.last_result ? `LATEST STAGE RESULT:\n${m.last_result}` : '',
      verify ? `\n=== VERIFY.md ===\n${verify}` : '',
      readme ? `\n=== README.md ===\n${readme}` : '',
      ``,
      `Reply with a one-line "oriented on <module>, ask away" and then wait for Kevin's questions.`,
    ].filter((l) => l !== '').join('\n');
  } else {
    ext = `cockpit:foundry-advisor-${projectId}`;
    const mods = projectModulesStmt.all(projectId);
    const lines = mods.map((m) => `  - ${m.key} [${m.kind}] — ${m.stage ?? '?'}${m.blocked_reason ? ' ⚠ ' + m.blocked_reason.slice(0, 80) : ''} — ${(m.purpose ?? '').slice(0, 90)}`);
    seed = [
      `You are the **Foundry advisor / orchestrator** for project \`${projectId}\` (${project.name}), status **${project.status}**.`,
      `You help Kevin understand and steer the whole build — the plan, how the modules fit, the current state, and what any blocker means / takes to clear. Be concise; you have the live blueprint below. For deep per-module questions, note that each module box has its own advisor thread too.`,
      ``,
      `PROMPT (the goal): ${project.prompt}`,
      ``,
      `MODULES (${mods.length}):\n${lines.join('\n')}`,
      ``,
      project.last_error ? `INTEGRATION / LAST ERROR:\n${project.last_error}` : `INTEGRATION: no error recorded (status ${project.status}).`,
      ``,
      `Reply with a one-line "oriented on ${projectId}, ask away" and then wait for Kevin's questions.`,
    ].filter((l) => l !== '').join('\n');
  }

  const existing = getConversation(ext);
  const primed = !!(existing && existing.status === 'active');
  const conv = getOrCreateConversation(ext);
  // Advisor Q&A → Sonnet (cheap, capable; off the frontier window).
  setThreadModelOverride(conv.id, 'claude', 'claude-sonnet-5');
  return { external_id: ext, seed_text: seed, primed };
}

export type FoundryProjectStatus =
  | 'draft'
  | 'planning'
  | 'planned'
  | 'building'
  | 'integrating'
  | 'ready'
  | 'launched'
  | 'blocked';

export type FoundryModuleKind = 'service' | 'library' | 'ui' | 'job' | 'data' | 'contracts';
export type FoundryModuleStage =
  | 'planned'
  | 'building'
  | 'built'
  | 'testing'
  | 'tested'
  | 'documenting'
  | 'documented'
  | 'integrated'
  | 'blocked'
  | 'needs_answer';

export interface FoundryProjectRow {
  id: string;
  name: string;
  prompt: string;
  repo_path: string;
  base_branch: string;
  status: FoundryProjectStatus;
  blueprint: string | null;
  integration_tree_id: string | null;
  integration_branch: string | null;
  preview_url: string | null;
  run_command: string | null;
  planner_model: string | null;
  origin_thread_ext: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface FoundryModuleRow {
  id: number;
  project_id: string;
  key: string;
  name: string;
  kind: FoundryModuleKind;
  purpose: string;
  contract: string;
  acceptance: string;
  depends_on: string;
  tree_id: string | null;
  stage_nodes: string;
  stage: FoundryModuleStage;
  branch: string;
  last_result: string | null;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface FoundryProgress {
  modules_total: number;
  modules_documented: number;
  modules_integrated: number;
  modules_blocked: number;
  modules_needing_answer: number;
  percent: number;
}

export interface FoundryProjectResponse extends Omit<FoundryProjectRow, 'blueprint'> {
  blueprint: unknown | null;
  progress: FoundryProgress;
}

export interface FoundryStageNodeResponse {
  node_id: number | null;
  status: HopperNodeStatus | 'missing';
  model: string | null;
  attempts: number;
  worker_thread_ext: string | null;
  result: string | null;
}

export interface FoundryModuleResponse extends Omit<FoundryModuleRow, 'contract' | 'acceptance' | 'depends_on' | 'stage_nodes'> {
  contract: { provides: unknown[]; requires: unknown[] };
  acceptance: string[];
  depends_on: string[];
  stage_nodes: Record<'build' | 'test' | 'doc', FoundryStageNodeResponse>;
}

export interface FoundryIntegrationNodeResponse {
  id: number;
  title: string;
  status: HopperNodeStatus;
  model: string | null;
  attempts: number;
  worker_thread_ext: string | null;
}

export interface FoundryIntegrationResponse {
  tree_id: string | null;
  nodes: FoundryIntegrationNodeResponse[];
  auto_retried: boolean;
}

export interface FoundryProjectWithModulesResponse {
  project: FoundryProjectResponse;
  modules: FoundryModuleResponse[];
  integration: FoundryIntegrationResponse;
}

export type FoundryRunSlotStatus = 'free' | 'running' | 'dead' | 'stopped';

export interface FoundryRunSlotRow {
  slot_no: number;
  port: number;
  project_id: string | null;
  pid: number | null;
  run_command: string | null;
  log_path: string | null;
  started_at: string | null;
  status: FoundryRunSlotStatus;
  last_health_at: string | null;
  updated_at: string;
}

interface FoundryRunSlotListRow extends FoundryRunSlotRow {
  project_name: string | null;
}

export interface FoundryRunSlotResponse extends FoundryRunSlotRow {
  project_name: string | null;
  preview_url: string | null;
}

export interface GoProjectOptions {
  slot_no?: number | null;
  replace?: boolean;
  host?: string | null;
}

export interface GoProjectResult {
  project: FoundryProjectResponse;
  launched: true;
  preview_url: string | null;
  slot: FoundryRunSlotResponse;
  blueprint_preview_url: string | null;
}

interface BlueprintModule {
  key: string;
  name: string;
  kind: FoundryModuleKind;
  purpose: string;
  contract: { provides: unknown[]; requires: unknown[] };
  acceptance: string[];
  depends_on: string[];
}

interface FoundryFoundationCheck {
  cmd: string;
  expect_regex?: string;
}

interface FoundryFoundation {
  stack: string;
  scaffold_cmd: string;
  checks: FoundryFoundationCheck[];
}

interface Blueprint {
  name: string;
  prompt: string;
  foundation?: FoundryFoundation;
  modules: BlueprintModule[];
  wiring: unknown[];
  integration: { test: string; docs?: string };
  run: { command: string; preview_url?: string };
  assumptions?: string[];
}

interface FoundationCheckResult {
  cmd: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  expect_regex?: string;
  error?: string;
}

interface ShellCommandResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  error?: string;
}

const PROJECT_STATUSES: FoundryProjectStatus[] = ['draft', 'planning', 'planned', 'building', 'integrating', 'ready', 'launched', 'blocked'];
const MODULE_KINDS: FoundryModuleKind[] = ['service', 'library', 'ui', 'job', 'data', 'contracts'];
const MODULE_STAGES: FoundryModuleStage[] = ['planned', 'building', 'built', 'testing', 'tested', 'documenting', 'documented', 'integrated', 'blocked', 'needs_answer'];
const KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
type FoundryStageKey = 'build' | 'test' | 'doc';
const STAGE_KEYS: FoundryStageKey[] = ['build', 'test', 'doc'];
const STAGE_RANK: Record<FoundryModuleStage, number> = {
  planned: 0,
  building: 1,
  built: 2,
  testing: 3,
  tested: 4,
  documenting: 5,
  documented: 6,
  integrated: 7,
  needs_answer: -1,
  blocked: -1,
};
// A 'split' node is terminal for ITSELF but its children are still doing the
// work; the engine bubbles the parent to 'done' once every child settles. Until
// then the stage must read as in-progress, never as complete (review #3).
const COMPLETE_NODE_STATUSES = new Set<HopperNodeStatus>(['done']);
const IN_PROGRESS_NODE_STATUSES = new Set<HopperNodeStatus>(['running', 'split']);

const CONTRACT_RESOLUTION_RULE = [
  'The contracts module is authoritative. If there is no contracts module, the blueprint declared provides/requires are authoritative.',
  'The deviating module conforms to the contract. Tests that contradict the contract are corrected, never the contract.',
  'Every resolution is appended to DECISIONS.md with the date, module/integration node, conflict, and rule applied.',
  'blocked_question is reserved only for cases where the contract is silent AND the choice changes user-visible behavior with no sane default.',
  'Interface, shape, error-code, naming, and test-vs-contract conflicts must be resolved toward the contract and DECISIONS.md, never sent to Kevin as a question.',
].join('\n');

const FRAMEWORK_PROMPT_RE =
  /\b(laravel|rails|ruby on rails|django|next(?:\.js)?|nuxt|sveltekit|phoenix|express(?:\.js)?(?:\s+(?:app|application|server|shell))?|nestjs|fastapi|flask|spring boot)\b/i;
const FORBIDDEN_FOUNDATION_CHECK_RE =
  /\b(artisan\s+migrate|migrate(?::|$|\s)|db:wipe|db:seed|drop\s+(?:database|table)|truncate\s+table|rm\s+-rf|git\s+reset|git\s+clean|supabase\s+db\s+(?:push|reset))\b/i;
const FOUNDATION_CHECK_TIMEOUT_MS = Math.max(
  1_000,
  parseInt(process.env.FOUNDRY_FOUNDATION_CHECK_TIMEOUT_MS ?? '120000', 10) || 120_000,
);
const FOUNDATION_SCAFFOLD_TIMEOUT_MS = Math.max(
  FOUNDATION_CHECK_TIMEOUT_MS,
  parseInt(process.env.FOUNDRY_FOUNDATION_SCAFFOLD_TIMEOUT_MS ?? '600000', 10) || 600_000,
);
const FOUNDATION_PATH_PREFIX = '/home/kevin/.local/bin:/home/kevin/.npm-global/bin:/usr/local/bin:/usr/bin:/bin';
const FOUNDATION_OUTPUT_TAIL_BYTES = 12_000;

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS foundry_projects (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    prompt              TEXT NOT NULL,
    repo_path           TEXT NOT NULL,
    base_branch         TEXT NOT NULL DEFAULT 'main',
    status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN (
                          'draft',
                          'planning',
                          'planned',
                          'building',
                          'integrating',
                          'ready',
                          'launched',
                          'blocked'
                        )),
    blueprint           TEXT,
    integration_tree_id TEXT,
    integration_branch  TEXT,
    preview_url         TEXT,
    run_command         TEXT,
    planner_model       TEXT,
    origin_thread_ext   TEXT,
    last_error          TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_foundry_projects_status_created
    ON foundry_projects(status, created_at DESC);

  CREATE TABLE IF NOT EXISTS foundry_modules (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id     TEXT NOT NULL REFERENCES foundry_projects(id) ON DELETE CASCADE,
    key            TEXT NOT NULL,
    name           TEXT NOT NULL,
    kind           TEXT NOT NULL
                   CHECK (kind IN ('service','library','ui','job','data','contracts')),
    purpose        TEXT NOT NULL,
    contract       TEXT NOT NULL DEFAULT '{"provides":[],"requires":[]}',
    acceptance     TEXT NOT NULL DEFAULT '[]',
    depends_on     TEXT NOT NULL DEFAULT '[]',
    tree_id        TEXT,
    stage_nodes    TEXT NOT NULL DEFAULT '{}',
    stage          TEXT NOT NULL DEFAULT 'planned'
                   CHECK (stage IN (
                     'planned',
                     'building',
                     'built',
                     'testing',
                     'tested',
                     'documenting',
                     'documented',
                     'integrated',
                     'blocked',
                     'needs_answer'
                   )),
    branch         TEXT NOT NULL,
    last_result    TEXT,
    blocked_reason TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, key)
  );

  CREATE INDEX IF NOT EXISTS idx_foundry_modules_project
    ON foundry_modules(project_id, id);

  CREATE INDEX IF NOT EXISTS idx_foundry_modules_tree
    ON foundry_modules(tree_id);

  CREATE INDEX IF NOT EXISTS idx_foundry_modules_project_stage
    ON foundry_modules(project_id, stage);

  CREATE TABLE IF NOT EXISTS foundry_run_slots (
    slot_no        INTEGER PRIMARY KEY CHECK (slot_no BETWEEN 1 AND 3),
    port           INTEGER NOT NULL,
    project_id     TEXT REFERENCES foundry_projects(id) ON DELETE SET NULL,
    pid            INTEGER,
    run_command    TEXT,
    log_path       TEXT,
    started_at     TEXT,
    status         TEXT NOT NULL DEFAULT 'free'
                   CHECK (status IN ('free','running','dead','stopped')),
    last_health_at TEXT,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_foundry_run_slots_project
    ON foundry_run_slots(project_id);
`);

for (const col of ['last_error TEXT', 'origin_thread_ext TEXT']) {
  try { sqliteDb.exec(`ALTER TABLE foundry_projects ADD COLUMN ${col}`); } catch {}
}

const getProjectStmt = sqliteDb.prepare<[string], FoundryProjectRow>(`SELECT * FROM foundry_projects WHERE id = ?`);
const listProjectsStmt = sqliteDb.prepare<[], FoundryProjectRow>(`SELECT * FROM foundry_projects ORDER BY created_at DESC, id DESC`);
const listProjectsByStatusStmt = sqliteDb.prepare<[FoundryProjectStatus], FoundryProjectRow>(`
  SELECT * FROM foundry_projects WHERE status = ? ORDER BY created_at DESC, id DESC
`);
const projectModulesStmt = sqliteDb.prepare<[string], FoundryModuleRow>(`
  SELECT * FROM foundry_modules WHERE project_id = ? ORDER BY id
`);
const moduleByTreeStmt = sqliteDb.prepare<[string], FoundryModuleRow>(`
  SELECT * FROM foundry_modules WHERE tree_id = ? LIMIT 1
`);
const moduleByKeyStmt = sqliteDb.prepare<[string, string], FoundryModuleRow>(`
  SELECT * FROM foundry_modules WHERE project_id = ? AND key = ? LIMIT 1
`);
const projectByIntegrationTreeStmt = sqliteDb.prepare<[string], FoundryProjectRow>(`
  SELECT * FROM foundry_projects WHERE integration_tree_id = ? LIMIT 1
`);
const insertProjectStmt = sqliteDb.prepare<[string, string, string, string, string, string | null]>(`
  INSERT INTO foundry_projects (id, name, prompt, repo_path, base_branch, origin_thread_ext)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const deleteProjectStmt = sqliteDb.prepare<[string]>(`DELETE FROM foundry_projects WHERE id = ?`);
const deleteModulesStmt = sqliteDb.prepare<[string]>(`DELETE FROM foundry_modules WHERE project_id = ?`);
const insertModuleStmt = sqliteDb.prepare<[
  string,
  string,
  string,
  FoundryModuleKind,
  string,
  string,
  string,
  string,
  string,
]>(`
  INSERT INTO foundry_modules
    (project_id, key, name, kind, purpose, contract, acceptance, depends_on, branch)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const setBlueprintStmt = sqliteDb.prepare<[string, string, string]>(`
  UPDATE foundry_projects
  SET blueprint = ?,
      run_command = ?,
      status = 'planned',
      last_error = NULL,
      updated_at = datetime('now')
  WHERE id = ?
    AND (
      status IN ('draft','planning','planned')
      OR (
        status = 'blocked'
        AND integration_tree_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM foundry_modules m WHERE m.project_id = foundry_projects.id AND m.tree_id IS NOT NULL)
      )
    )
`);
const setBlueprintWhilePlanningStmt = sqliteDb.prepare<[string, string, string]>(`
  UPDATE foundry_projects
  SET blueprint = ?,
      run_command = ?,
      status = 'planned',
      last_error = NULL,
      updated_at = datetime('now')
  WHERE id = ?
    AND status = 'planning'
`);
const setPlanningStmt = sqliteDb.prepare<[string | null, string]>(`
  UPDATE foundry_projects
  SET status = 'planning',
      planner_model = ?,
      last_error = NULL,
      updated_at = datetime('now')
  WHERE id = ?
    AND status IN ('draft','planned')
`);
const setPlannerFailedStmt = sqliteDb.prepare<[string, string]>(`
  UPDATE foundry_projects
  SET status = 'draft',
      last_error = ?,
      updated_at = datetime('now')
  WHERE id = ?
    AND status = 'planning'
`);
const setProjectStatusStmt = sqliteDb.prepare<[FoundryProjectStatus, string]>(`
  UPDATE foundry_projects
  SET status = ?,
      updated_at = datetime('now')
  WHERE id = ?
    AND status <> 'launched'
`);
const setProjectBlockedStmt = sqliteDb.prepare<[string, string]>(`
  UPDATE foundry_projects
  SET status = 'blocked',
      last_error = ?,
      updated_at = datetime('now')
  WHERE id = ?
    AND status <> 'launched'
`);
const setProjectIntegrationStmt = sqliteDb.prepare<[string, string, string]>(`
  UPDATE foundry_projects
  SET integration_tree_id = ?,
      integration_branch = ?,
      status = 'integrating',
      updated_at = datetime('now')
  WHERE id = ?
    AND integration_tree_id IS NULL
    AND status <> 'launched'
`);
const setProjectReadyStmt = sqliteDb.prepare<[string]>(`
  UPDATE foundry_projects
  SET status = 'ready',
      last_error = NULL,
      updated_at = datetime('now')
  WHERE id = ?
    AND status <> 'launched'
`);
const setProjectLaunchedStmt = sqliteDb.prepare<[string | null, string]>(`
  UPDATE foundry_projects
  SET status = 'launched',
      preview_url = ?,
      last_error = NULL,
      updated_at = datetime('now')
  WHERE id = ?
`);
const setModuleTreeStmt = sqliteDb.prepare<[string, string, FoundryModuleStage, string | null, string | null, number]>(`
  UPDATE foundry_modules
  SET tree_id = ?,
      stage_nodes = ?,
      stage = ?,
      last_result = ?,
      blocked_reason = ?,
      updated_at = datetime('now')
  WHERE id = ?
`);
const setModuleStageStmt = sqliteDb.prepare<[FoundryModuleStage, string | null, string | null, number]>(`
  UPDATE foundry_modules
  SET stage = ?,
      last_result = ?,
      blocked_reason = ?,
      updated_at = datetime('now')
  WHERE id = ?
`);
const setModuleIntegratedStmt = sqliteDb.prepare<[number]>(`
  UPDATE foundry_modules
  SET stage = 'integrated',
      updated_at = datetime('now')
  WHERE id = ?
`);
const getRunSlotStmt = sqliteDb.prepare<[number], FoundryRunSlotRow>(`
  SELECT * FROM foundry_run_slots WHERE slot_no = ?
`);
const listRunSlotsStmt = sqliteDb.prepare<[], FoundryRunSlotListRow>(`
  SELECT s.*, p.name AS project_name
  FROM foundry_run_slots s
  LEFT JOIN foundry_projects p ON p.id = s.project_id
  ORDER BY s.slot_no
`);
const getRunSlotWithProjectStmt = sqliteDb.prepare<[number], FoundryRunSlotListRow>(`
  SELECT s.*, p.name AS project_name
  FROM foundry_run_slots s
  LEFT JOIN foundry_projects p ON p.id = s.project_id
  WHERE s.slot_no = ?
`);
const upsertRunSlotStmt = sqliteDb.prepare<[number, number]>(`
  INSERT INTO foundry_run_slots (slot_no, port)
  VALUES (?, ?)
  ON CONFLICT(slot_no) DO UPDATE SET
    port = CASE
      WHEN foundry_run_slots.status = 'running' AND foundry_run_slots.pid IS NOT NULL
        THEN foundry_run_slots.port
      ELSE excluded.port
    END,
    updated_at = CASE
      WHEN (
        CASE
          WHEN foundry_run_slots.status = 'running' AND foundry_run_slots.pid IS NOT NULL
            THEN foundry_run_slots.port
          ELSE excluded.port
        END
      ) <> foundry_run_slots.port
        THEN datetime('now')
      ELSE foundry_run_slots.updated_at
    END
`);
const clearFreeRunSlotStmt = sqliteDb.prepare<[number]>(`
  UPDATE foundry_run_slots
  SET project_id = NULL,
      pid = NULL,
      run_command = NULL,
      log_path = NULL,
      started_at = NULL,
      status = 'free',
      last_health_at = NULL,
      updated_at = datetime('now')
  WHERE slot_no = ?
`);
const setRunSlotRunningStmt = sqliteDb.prepare<[string, number, string, string, number]>(`
  UPDATE foundry_run_slots
  SET project_id = ?,
      pid = ?,
      run_command = ?,
      log_path = ?,
      started_at = datetime('now'),
      status = 'running',
      last_health_at = NULL,
      updated_at = datetime('now')
  WHERE slot_no = ?
`);
const setRunSlotStoppedStmt = sqliteDb.prepare<[number]>(`
  UPDATE foundry_run_slots
  SET pid = NULL,
      status = 'stopped',
      last_health_at = NULL,
      updated_at = datetime('now')
  WHERE slot_no = ?
`);
const setRunSlotDeadStmt = sqliteDb.prepare<[number]>(`
  UPDATE foundry_run_slots
  SET pid = NULL,
      status = 'dead',
      last_health_at = NULL,
      updated_at = datetime('now')
  WHERE slot_no = ?
`);
const setRunSlotHealthStmt = sqliteDb.prepare<[number]>(`
  UPDATE foundry_run_slots
  SET last_health_at = datetime('now'),
      updated_at = datetime('now')
  WHERE slot_no = ?
`);

export class FoundryError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function completeNode(node: HopperNodeRow | null): boolean {
  return !!node && COMPLETE_NODE_STATUSES.has(node.status);
}

function stageNodeIds(row: FoundryModuleRow): Record<FoundryStageKey, number | null> {
  const raw = parseJson<Record<string, unknown>>(row.stage_nodes, {});
  const ids = {} as Record<FoundryStageKey, number | null>;
  for (const stage of STAGE_KEYS) {
    const value = raw[stage];
    ids[stage] = typeof value === 'number'
      ? value
      : isRecord(value) && typeof value.node_id === 'number'
        ? value.node_id
        : null;
  }
  return ids;
}

function stageNode(row: FoundryModuleRow, stage: FoundryStageKey): HopperNodeRow | null {
  const id = stageNodeIds(row)[stage];
  return id == null ? null : getHopperNode(id);
}

function integrationTreeBlocked(project: FoundryProjectRow): boolean {
  if (!project.integration_tree_id) return false;
  return listTreeNodes(project.integration_tree_id).some((node) => node.status === 'blocked' || node.status === 'blocked_question');
}

function integrationTreeDone(project: FoundryProjectRow): boolean {
  if (!project.integration_tree_id) return false;
  const nodes = listTreeNodes(project.integration_tree_id);
  return nodes.length > 0 && nodes.every((node) => COMPLETE_NODE_STATUSES.has(node.status));
}

function stageAtLeast(stage: FoundryModuleStage, target: FoundryModuleStage): boolean {
  return STAGE_RANK[stage] >= STAGE_RANK[target];
}

function latestStageResult(row: FoundryModuleRow): string | null {
  for (const stage of [...STAGE_KEYS].reverse()) {
    const node = stageNode(row, stage);
    if (node?.result) return node.result;
  }
  return null;
}

function blockedReason(row: FoundryModuleRow): string | null {
  for (const stage of STAGE_KEYS) {
    const node = stageNode(row, stage);
    if (node?.status === 'blocked') return node.result ?? `${stage} stage is blocked`;
    if (node?.status === 'blocked_question') return node.question ?? `${stage} stage needs an answer`;
  }
  return null;
}

function inferAdapter(model: string, fallback: string): string {
  const lower = model.toLowerCase();
  if (lower.startsWith('gpt-') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4') || lower.includes('codex')) return 'codex';
  if (lower.startsWith('claude-')) return 'claude';
  if (lower.startsWith('swe') || lower.startsWith('adaptive') || lower.startsWith('gemini') || lower.startsWith('glm') || lower.startsWith('kimi')) return 'devin';
  if (lower.startsWith('opus4') || lower.startsWith('sonnet4')) return 'auggie';
  return fallback;
}

function parseFoundryLoadout(raw: string | null, fallback: { adapter: string; model: string }): { adapter: string; model: string } {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      const model = nonEmptyString(parsed.model);
      if (model) return { adapter: nonEmptyString(parsed.adapter) ?? inferAdapter(model, fallback.adapter), model };
    }
  } catch {
    /* plain string setting */
  }
  if (raw.includes('/')) {
    const [adapter, ...modelParts] = raw.split('/');
    const model = modelParts.join('/').trim();
    if (adapter.trim() && model) return { adapter: adapter.trim(), model };
  }
  return { adapter: inferAdapter(raw, fallback.adapter), model: raw };
}

function stageLoadout(stage: FoundryStageKey): { adapter: string; model: string } {
  const defaults: Record<FoundryStageKey, { adapter: string; model: string }> = {
    build: { adapter: 'codex', model: 'gpt-5.5' },
    test: { adapter: 'claude', model: 'claude-sonnet-5' },
    doc: { adapter: 'claude', model: 'claude-haiku-4-5-20251001' },
  };
  return parseFoundryLoadout(getFoundrySetting(`${stage}_model`), defaults[stage]);
}

function integrationLoadout(): { adapter: string; model: string } {
  return parseFoundryLoadout(getFoundrySetting('integrate_model'), { adapter: 'auggie', model: 'opus4.8' });
}

function slugify(name: string): string {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-');
  return slug || 'foundry-project';
}

function nextProjectId(name: string): string {
  const base = slugify(name);
  let id = base;
  for (let i = 2; getProjectStmt.get(id); i += 1) id = `${base}-${i}`;
  return id;
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', timeout: 30_000 });
}

function gitText(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
}

function outputTail(text: string, maxBytes = FOUNDATION_OUTPUT_TAIL_BYTES): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text.trim();
  return `…(truncated)\n${buf.subarray(buf.length - maxBytes).toString('utf8').trim()}`;
}

function foundationEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  env.PATH = env.PATH ? `${FOUNDATION_PATH_PREFIX}:${env.PATH}` : FOUNDATION_PATH_PREFIX;
  return env;
}

function runFoundationShell(cmd: string, cwd: string, timeoutMs = FOUNDATION_CHECK_TIMEOUT_MS): ShellCommandResult {
  const startedAt = Date.now();
  const result = spawnSync('/bin/bash', ['-lc', cmd], {
    cwd,
    env: foundationEnv(),
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const output = outputTail([stdout, stderr].filter(Boolean).join('\n'));
  const error = result.error instanceof Error ? result.error.message : undefined;
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  const exitCode = typeof result.status === 'number' ? result.status : null;
  // Verbatim audit line: every planner-authored command the server executes,
  // where, and how it ended. Output tails live on the node/project result.
  console.log(
    `[foundry-foundation] cwd=${cwd} exit=${exitCode ?? 'null'}${timedOut ? ' TIMED_OUT' : ''} ms=${Date.now() - startedAt} cmd=${JSON.stringify(cmd)}${error ? ` error=${JSON.stringify(error)}` : ''}`,
  );
  return { exitCode, timedOut, output, error };
}

function ensureGitIdentity(repoPath: string): void {
  try { git(['config', 'user.name', 'JARVIS Foundry'], repoPath); } catch {}
  try { git(['config', 'user.email', 'jarvis-foundry@local'], repoPath); } catch {}
}

function scaffoldRepo(repoPath: string, name: string, prompt: string, baseBranch: string): void {
  fs.mkdirSync(repoPath, { recursive: true });
  try {
    git(['init', '-b', baseBranch], repoPath);
  } catch {
    git(['init'], repoPath);
    git(['checkout', '-B', baseBranch], repoPath);
  }
  git(['config', 'user.name', 'JARVIS Foundry'], repoPath);
  git(['config', 'user.email', 'jarvis-foundry@local'], repoPath);
  fs.mkdirSync(path.join(repoPath, 'modules'), { recursive: true });
  fs.mkdirSync(path.join(repoPath, 'contracts'), { recursive: true });
  fs.writeFileSync(
    path.join(repoPath, 'foundry.json'),
    `${JSON.stringify({
      name,
      prompt,
      modules: [],
      wiring: [],
      integration: { test: '', docs: 'README.md' },
      run: { command: '' },
      assumptions: [],
    }, null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(repoPath, 'README.md'),
    `# ${name}\n\n${prompt}\n\nGenerated by Foundry. The blueprint lives in \`foundry.json\`; modules live under \`modules/\`.\n`,
  );
  git(['add', 'foundry.json', 'README.md', 'modules', 'contracts'], repoPath);
  git(['commit', '-m', 'Initial Foundry scaffold'], repoPath);
}

function maybeScaffoldRepo(repoPath: string, name: string, prompt: string, baseBranch: string): void {
  if (fs.existsSync(repoPath)) return;
  scaffoldRepo(repoPath, name, prompt, baseBranch);
}

function moduleRequiresName(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!isRecord(value)) return null;
  return nonEmptyString(value.interface) ?? nonEmptyString(value.name);
}

function moduleRequiresTarget(value: unknown): string | null {
  return isRecord(value) ? nonEmptyString(value.module) : null;
}

function provideName(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  return isRecord(value) ? nonEmptyString(value.name) : null;
}

function provideNames(value: unknown): string[] {
  const name = provideName(value);
  if (!name) return [];
  if (!isRecord(value)) return [name];
  const type = nonEmptyString(value.type);
  return type ? [name, `${type}:${name}`] : [name];
}

function wiringFields(value: unknown): { from: string | null; requires: string | null; to: string | null } {
  if (!isRecord(value)) return { from: null, requires: null, to: null };
  return {
    from: nonEmptyString(value.from),
    requires: nonEmptyString(value.requires),
    to: nonEmptyString(value.to),
  };
}

function normalizeModuleSpec(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const existingContract = isRecord(input.contract) ? input.contract : {};
  const provides = Array.isArray(existingContract.provides)
    ? existingContract.provides
    : Array.isArray(input.provides)
      ? input.provides
      : undefined;
  const requires = Array.isArray(existingContract.requires)
    ? existingContract.requires
    : Array.isArray(input.requires)
      ? input.requires
      : undefined;
  const normalized: Record<string, unknown> = {
    ...input,
    contract: {
      ...existingContract,
      provides,
      requires,
    },
  };
  delete normalized.provides;
  delete normalized.requires;
  return normalized;
}

function normalizeFoundationCheck(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const normalized: Record<string, unknown> = {
    cmd: typeof input.cmd === 'string' ? input.cmd.trim() : input.cmd,
  };
  if (Object.prototype.hasOwnProperty.call(input, 'expect_regex')) {
    normalized.expect_regex = typeof input.expect_regex === 'string'
      ? input.expect_regex.trim()
      : input.expect_regex;
  }
  return normalized;
}

function normalizeFoundationSpec(input: unknown): unknown {
  if (input == null) return undefined;
  if (!isRecord(input)) return input;
  return {
    stack: typeof input.stack === 'string' ? input.stack.trim() : input.stack,
    scaffold_cmd: typeof input.scaffold_cmd === 'string' ? input.scaffold_cmd.trim() : input.scaffold_cmd,
    checks: Array.isArray(input.checks) ? input.checks.map(normalizeFoundationCheck) : input.checks,
  };
}

function normalizeBlueprint(input: unknown): Blueprint | null {
  if (!isRecord(input)) return null;
  if (!Array.isArray(input.modules)) return null;
  const normalized: Record<string, unknown> = {
    ...input,
    modules: input.modules.map(normalizeModuleSpec),
  };
  if (Object.prototype.hasOwnProperty.call(input, 'foundation')) {
    normalized.foundation = normalizeFoundationSpec(input.foundation);
  }
  return normalized as unknown as Blueprint;
}

function blueprintLooksLikeFrameworkApp(bp: Blueprint): boolean {
  const parts: string[] = [
    bp.name,
    bp.prompt,
    bp.integration?.test,
    bp.run?.command,
    ...(Array.isArray(bp.assumptions) ? bp.assumptions : []),
  ].filter((part): part is string => typeof part === 'string');
  for (const mod of Array.isArray(bp.modules) ? bp.modules : []) {
    if (isRecord(mod)) {
      for (const field of ['key', 'name', 'kind', 'purpose']) {
        const value = mod[field];
        if (typeof value === 'string') parts.push(value);
      }
    }
  }
  return FRAMEWORK_PROMPT_RE.test(parts.join('\n'));
}

export function validateBlueprint(input: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const bp = normalizeBlueprint(input);
  if (!bp) return { ok: false, errors: ['blueprint must be an object with a modules array'] };

  if (!nonEmptyString(bp.name)) errors.push('name is required');
  if (!nonEmptyString(bp.prompt)) errors.push('prompt is required');
  if (!Array.isArray(bp.modules)) errors.push('modules must be an array');
  if (!Array.isArray(bp.wiring)) errors.push('wiring must be an array');
  if (!isRecord(bp.integration) || !nonEmptyString(bp.integration.test)) errors.push('integration.test is required');
  if (!isRecord(bp.run) || !nonEmptyString(bp.run.command)) errors.push('run.command is required');

  const foundation = Object.prototype.hasOwnProperty.call(bp, 'foundation') ? bp.foundation : undefined;
  if (foundation != null) {
    if (!isRecord(foundation)) {
      errors.push('foundation must be an object when present');
    } else {
      if (!nonEmptyString(foundation.stack)) errors.push('foundation.stack is required');
      if (!nonEmptyString(foundation.scaffold_cmd)) errors.push('foundation.scaffold_cmd is required');
      if (!Array.isArray(foundation.checks) || foundation.checks.length < 1) {
        errors.push('foundation.checks must contain at least one check');
      } else {
        for (const [i, check] of foundation.checks.entries()) {
          if (!isRecord(check)) {
            errors.push(`foundation.checks[${i}] must be an object`);
            continue;
          }
          const checkCmd = nonEmptyString(check.cmd);
          if (!checkCmd) {
            errors.push(`foundation.checks[${i}].cmd is required`);
          } else if (FORBIDDEN_FOUNDATION_CHECK_RE.test(checkCmd)) {
            errors.push(`foundation.checks[${i}].cmd must be a read-only assertion, not a migration/destructive command`);
          }
          if (Object.prototype.hasOwnProperty.call(check, 'expect_regex')) {
            if (typeof check.expect_regex !== 'string' || !check.expect_regex.trim()) {
              errors.push(`foundation.checks[${i}].expect_regex must be a non-empty string when present`);
            } else {
              try {
                new RegExp(check.expect_regex);
              } catch (err) {
                errors.push(`foundation.checks[${i}].expect_regex is invalid: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
        }
      }
    }
  } else if (blueprintLooksLikeFrameworkApp(bp)) {
    errors.push('foundation is required for framework application blueprints');
  }

  const modules = Array.isArray(bp.modules) ? bp.modules : [];
  if (modules.length < 1 || modules.length > 12) errors.push('modules must contain between 1 and 12 modules');

  const keys = new Set<string>();
  for (const [i, mod] of modules.entries()) {
    if (!isRecord(mod)) {
      errors.push(`modules[${i}] must be an object`);
      continue;
    }
    const key = nonEmptyString(mod.key);
    if (!key) {
      errors.push(`modules[${i}].key is required`);
    } else if (!KEY_RE.test(key)) {
      errors.push(`module key '${key}' must be kebab-case`);
    } else if (keys.has(key)) {
      errors.push(`module key '${key}' is duplicated`);
    } else {
      keys.add(key);
    }
    if (!nonEmptyString(mod.name)) errors.push(`${key ?? `modules[${i}]`}.name is required`);
    if (!nonEmptyString(mod.purpose)) errors.push(`${key ?? `modules[${i}]`}.purpose is required`);
    if (!MODULE_KINDS.includes(mod.kind as FoundryModuleKind)) {
      errors.push(`${key ?? `modules[${i}]`}.kind must be one of ${MODULE_KINDS.join(', ')}`);
    }
    if (!isRecord(mod.contract)) {
      errors.push(`${key ?? `modules[${i}]`}.contract must be an object`);
    } else {
      if (!Array.isArray(mod.contract.provides)) errors.push(`${key ?? `modules[${i}]`}.contract.provides must be an array`);
      if (!Array.isArray(mod.contract.requires)) errors.push(`${key ?? `modules[${i}]`}.contract.requires must be an array`);
    }
    if (!Array.isArray(mod.acceptance) || mod.acceptance.some((a) => !nonEmptyString(a))) {
      errors.push(`${key ?? `modules[${i}]`}.acceptance must be an array of strings`);
    }
    if (!Array.isArray(mod.depends_on) || mod.depends_on.some((d) => !nonEmptyString(d))) {
      errors.push(`${key ?? `modules[${i}]`}.depends_on must be an array of module keys`);
    }
  }

  for (const mod of modules) {
    if (!isRecord(mod) || !nonEmptyString(mod.key) || !Array.isArray(mod.depends_on)) continue;
    for (const dep of mod.depends_on) {
      const depKey = String(dep).trim();
      if (!keys.has(depKey)) errors.push(`${mod.key}.depends_on references unknown module '${depKey}'`);
    }
  }

  const byKey = new Map<string, BlueprintModule>();
  for (const mod of modules) {
    if (isRecord(mod) && nonEmptyString(mod.key)) byKey.set(String(mod.key), mod as unknown as BlueprintModule);
  }

  for (const wiring of Array.isArray(bp.wiring) ? bp.wiring : []) {
    const w = wiringFields(wiring);
    if (!w.from || !w.requires || !w.to) {
      errors.push('each wiring entry must include from, requires, and to');
      continue;
    }
    if (!byKey.has(w.from)) errors.push(`wiring from '${w.from}' does not match a module`);
    if (!byKey.has(w.to)) errors.push(`wiring to '${w.to}' does not match a module`);
    const provider = byKey.get(w.to);
    const provides = Array.isArray(provider?.contract?.provides) ? provider.contract.provides : [];
    if (provider && !provides.some((p) => provideNames(p).includes(w.requires!))) {
      errors.push(`wiring ${w.from}:${w.requires} -> ${w.to} does not bind to a provide named '${w.requires}'`);
    }
    const consumer = byKey.get(w.from);
    const consumerRequires = Array.isArray(consumer?.contract?.requires) ? consumer.contract.requires : [];
    if (consumer && !consumerRequires.some((r) => moduleRequiresName(r) === w.requires)) {
      errors.push(`wiring ${w.from}:${w.requires} -> ${w.to} is stray: '${w.from}' does not declare a requires named '${w.requires}'`);
    }
  }

  for (const mod of byKey.values()) {
    const requires = Array.isArray(mod.contract.requires) ? mod.contract.requires : [];
    for (const req of requires) {
      const reqName = moduleRequiresName(req);
      if (!reqName) {
        errors.push(`${mod.key}.contract.requires has an entry without interface/name`);
        continue;
      }
      const matches = (Array.isArray(bp.wiring) ? bp.wiring : []).map(wiringFields)
        .filter((w) => w.from === mod.key && w.requires === reqName);
      if (matches.length !== 1) {
        errors.push(`${mod.key}.contract.requires '${reqName}' must bind to exactly one wiring entry`);
        continue;
      }
      const target = moduleRequiresTarget(req);
      if (target && matches[0].to !== target) {
        errors.push(`${mod.key}.contract.requires '${reqName}' targets '${target}' but wiring points to '${matches[0].to}'`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string, trail: string[]): void => {
    if (visited.has(key)) return;
    if (visiting.has(key)) {
      errors.push(`depends_on cycle detected: ${[...trail, key].join(' -> ')}`);
      return;
    }
    visiting.add(key);
    const mod = byKey.get(key);
    const deps = Array.isArray(mod?.depends_on) ? mod.depends_on : [];
    for (const dep of deps) {
      const depKey = String(dep).trim();
      if (byKey.has(depKey)) visit(depKey, [...trail, key]);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of byKey.keys()) visit(key, []);

  if (foundation != null && isRecord(foundation) && !byKey.has('app-shell')) {
    errors.push('foundation blueprints must include an app-shell module that owns root framework wiring');
  }

  return { ok: errors.length === 0, errors };
}

function progressFor(modules: FoundryModuleRow[]): FoundryProgress {
  const modules_total = modules.length;
  const modules_integrated = modules.filter((m) => m.stage === 'integrated').length;
  const modules_documented = modules.filter((m) => m.stage === 'documented' || m.stage === 'integrated').length;
  const modules_blocked = modules.filter((m) => m.stage === 'blocked').length;
  const modules_needing_answer = modules.filter((m) => m.stage === 'needs_answer').length;
  return {
    modules_total,
    modules_documented,
    modules_integrated,
    modules_blocked,
    modules_needing_answer,
    percent: modules_total ? Math.round((modules_documented / modules_total) * 100) : 0,
  };
}

export function deriveStage(project: FoundryProjectRow, module: FoundryModuleRow): FoundryModuleStage {
  const build = stageNode(module, 'build');
  const test = stageNode(module, 'test');
  const doc = stageNode(module, 'doc');
  const nodes = [build, test, doc].filter((node): node is HopperNodeRow => !!node);

  if (nodes.some((node) => node.status === 'blocked')) return 'blocked';
  if (nodes.some((node) => node.status === 'blocked_question')) return 'needs_answer';
  if (integrationTreeDone(project) && completeNode(build) && completeNode(test) && completeNode(doc)) return 'integrated';
  if (doc && IN_PROGRESS_NODE_STATUSES.has(doc.status)) return 'documenting';
  if (completeNode(doc)) return 'documented';
  if (test && IN_PROGRESS_NODE_STATUSES.has(test.status)) return 'testing';
  if (completeNode(test)) return 'tested';
  if (build && IN_PROGRESS_NODE_STATUSES.has(build.status)) return 'building';
  if (completeNode(build)) return 'built';
  return 'planned';
}

function notifyModuleStateChange(project: FoundryProjectRow, module: FoundryModuleRow, stage: FoundryModuleStage): void {
  if (stage !== 'blocked' && stage !== 'needs_answer') return;
  const reason = module.blocked_reason ?? (stage === 'needs_answer' ? 'A worker needs an answer.' : 'A worker blocked.');
  createNotification({
    severity: stage === 'needs_answer' ? 'warning' : 'error',
    title: stage === 'needs_answer'
      ? `🏭 ${project.name} / ${module.name} needs your call`
      : `🏭 ${project.name} / ${module.name} is blocked`,
    body: reason,
    source: 'foundry',
    link: `/foundry?project=${encodeURIComponent(project.id)}&module=${encodeURIComponent(module.key)}`,
  });
}

function refreshModuleStage(project: FoundryProjectRow, module: FoundryModuleRow): { module: FoundryModuleRow; stageChanged: boolean; changed: boolean } {
  const nextStage = deriveStage(project, module);
  const nextResult = latestStageResult(module);
  const nextBlockedReason = blockedReason(module);
  const changed =
    module.stage !== nextStage ||
    (module.last_result ?? null) !== (nextResult ?? null) ||
    (module.blocked_reason ?? null) !== (nextBlockedReason ?? null);

  if (!changed) return { module, stageChanged: false, changed: false };

  const stageChanged = module.stage !== nextStage;
  setModuleStageStmt.run(nextStage, nextResult, nextBlockedReason, module.id);
  const updated = moduleByKeyStmt.get(module.project_id, module.key) ?? module;
  emitModule('updated', updated);
  if (stageChanged) notifyModuleStateChange(project, updated, nextStage);
  return { module: updated, stageChanged, changed: true };
}

function stageNodeFromRaw(raw: unknown, stage: 'build' | 'test' | 'doc'): FoundryStageNodeResponse {
  const value = isRecord(raw) ? raw[stage] : undefined;
  const nodeId = typeof value === 'number'
    ? value
    : isRecord(value) && typeof value.node_id === 'number'
      ? value.node_id
      : null;
  if (nodeId == null) return { node_id: null, status: 'missing', model: null, attempts: 0, worker_thread_ext: null, result: null };
  const node = getHopperNode(nodeId);
  if (!node) return { node_id: nodeId, status: 'missing', model: null, attempts: 0, worker_thread_ext: null, result: null };
  return {
    node_id: node.id,
    status: node.status,
    model: node.model,
    attempts: node.attempts,
    worker_thread_ext: node.worker_thread_ext,
    result: node.result,
  };
}

export function serializeFoundryModule(row: FoundryModuleRow): FoundryModuleResponse {
  const rawStageNodes = parseJson<Record<string, unknown>>(row.stage_nodes, {});
  return {
    ...row,
    contract: parseJson(row.contract, { provides: [], requires: [] }),
    acceptance: parseJson(row.acceptance, []),
    depends_on: parseJson(row.depends_on, []),
    stage_nodes: {
      build: stageNodeFromRaw(rawStageNodes, 'build'),
      test: stageNodeFromRaw(rawStageNodes, 'test'),
      doc: stageNodeFromRaw(rawStageNodes, 'doc'),
    },
  };
}

export function serializeFoundryProject(row: FoundryProjectRow, modules = projectModulesStmt.all(row.id)): FoundryProjectResponse {
  return {
    ...row,
    blueprint: parseJson(row.blueprint, null),
    progress: progressFor(modules),
  };
}

export function serializeFoundryIntegration(row: FoundryProjectRow): FoundryIntegrationResponse {
  if (!row.integration_tree_id) {
    return { tree_id: null, nodes: [], auto_retried: false };
  }
  const nodes = listTreeNodes(row.integration_tree_id);
  return {
    tree_id: row.integration_tree_id,
    nodes: nodes.map((node) => ({
      id: node.id,
      title: node.title,
      status: node.status,
      model: node.model,
      attempts: node.attempts,
      worker_thread_ext: node.worker_thread_ext,
    })),
    auto_retried: nodes.some((node) => (node.foundry_auto_retries ?? 0) > 0),
  };
}

function emitProject(action: 'created' | 'updated' | 'deleted', project: FoundryProjectRow, modules?: FoundryModuleRow[]): void {
  sseBus.emit('sse', { type: 'foundry_project', action, project: serializeFoundryProject(project, modules) });
}

function emitModule(action: 'created' | 'updated' | 'deleted', module: FoundryModuleRow): void {
  sseBus.emit('sse', { type: 'foundry_module', action, project_id: module.project_id, module: serializeFoundryModule(module) });
}

const DEFAULT_RUN_PORTS: [number, number, number] = [4310, 4311, 4312];
let runSlotHealthRunning = false;
let warnedRunPortsRaw: string | null = null;

export function configuredRunPorts(): [number, number, number] {
  const raw = process.env.FOUNDRY_RUN_PORTS?.trim();
  if (!raw) return DEFAULT_RUN_PORTS;
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  const ports = parts.map((part) => Number(part));
  const valid = ports.length === 3
    && ports.every((port) => Number.isInteger(port) && port > 0 && port <= 65535)
    && new Set(ports).size === 3;
  if (!valid) {
    if (warnedRunPortsRaw !== raw) {
      warnedRunPortsRaw = raw;
      console.warn(`[foundry] invalid FOUNDRY_RUN_PORTS=${JSON.stringify(raw)}; using ${DEFAULT_RUN_PORTS.join(',')}`);
    }
    return DEFAULT_RUN_PORTS;
  }
  return ports as [number, number, number];
}

function validSlotNo(slotNo: number): boolean {
  return Number.isInteger(slotNo) && slotNo >= 1 && slotNo <= 3;
}

export function ensureRunSlots(): void {
  const ports = configuredRunPorts();
  for (let i = 0; i < 3; i += 1) {
    upsertRunSlotStmt.run(i + 1, ports[i]);
  }
}

function normalizePreviewHost(host?: string | null): string {
  const raw = (host?.trim() || process.env.FOUNDRY_PREVIEW_HOST?.trim() || 'localhost').split(',')[0]?.trim() || 'localhost';
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    return new URL(withProtocol).hostname || 'localhost';
  } catch {
    return raw.replace(/^https?:\/\//i, '').split('/')[0]?.split(':')[0] || 'localhost';
  }
}

function runSlotPreviewUrl(port: number, host?: string | null): string {
  return `http://${normalizePreviewHost(host)}:${port}`;
}

function serializeRunSlot(row: FoundryRunSlotListRow, host?: string | null): FoundryRunSlotResponse {
  return {
    ...row,
    preview_url: runSlotPreviewUrl(row.port, host),
  };
}

function emitRunSlot(slotNo: number, host?: string | null): void {
  const row = getRunSlotWithProjectStmt.get(slotNo);
  if (!row) return;
  sseBus.emit('sse', { type: 'foundry_run_slot', action: 'updated', slot: serializeRunSlot(row, host) });
}

function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return;
    try {
      process.kill(pid, signal);
    } catch (inner) {
      const innerCode = (inner as NodeJS.ErrnoException).code;
      if (innerCode !== 'ESRCH') throw inner;
    }
  }
}

export function listRunSlots(host?: string | null): FoundryRunSlotResponse[] {
  ensureRunSlots();
  return listRunSlotsStmt.all().map((row) => serializeRunSlot(row, host));
}

function slotOccupants(host?: string | null): FoundryRunSlotResponse[] {
  return listRunSlots(host).filter((slot) => slot.status === 'running' && pidAlive(slot.pid));
}

export function stopRunSlot(slotNo: number, opts: { host?: string | null; emit?: boolean } = {}): FoundryRunSlotResponse {
  ensureRunSlots();
  if (!validSlotNo(slotNo)) throw new FoundryError(400, 'foundry_invalid_slot', 'slot_no must be 1, 2, or 3');
  const row = getRunSlotStmt.get(slotNo) ?? null;
  if (!row) throw new FoundryError(404, 'foundry_slot_not_found', 'foundry run slot not found');
  if (row.status === 'running') {
    if (pidAlive(row.pid)) {
      signalProcessGroup(row.pid!, 'SIGTERM');
      for (let i = 0; i < 8 && pidAlive(row.pid); i += 1) sleepSync(150);
      if (pidAlive(row.pid)) {
        signalProcessGroup(row.pid!, 'SIGKILL');
        for (let i = 0; i < 4 && pidAlive(row.pid); i += 1) sleepSync(100);
      }
    }
    setRunSlotStoppedStmt.run(slotNo);
    if (opts.emit !== false) emitRunSlot(slotNo, opts.host);
  }
  const updated = getRunSlotWithProjectStmt.get(slotNo);
  if (!updated) throw new FoundryError(404, 'foundry_slot_not_found', 'foundry run slot not found');
  return serializeRunSlot(updated, opts.host);
}

export function reconcileRunSlotsAtBoot(host?: string | null): void {
  ensureRunSlots();
  for (const slot of listRunSlotsStmt.all()) {
    if (slot.status === 'free') {
      if (slot.project_id || slot.pid || slot.run_command || slot.log_path || slot.started_at || slot.last_health_at) {
        clearFreeRunSlotStmt.run(slot.slot_no);
        emitRunSlot(slot.slot_no, host);
      }
      continue;
    }
    if (slot.status === 'running' && !pidAlive(slot.pid)) {
      setRunSlotDeadStmt.run(slot.slot_no);
      emitRunSlot(slot.slot_no, host);
      if (slot.project_id) {
        const project = getProjectStmt.get(slot.project_id);
        if (project) emitProject('updated', project, projectModulesStmt.all(project.id));
      }
    }
  }
}

function allocateRunSlot(opts: GoProjectOptions): FoundryRunSlotListRow {
  ensureRunSlots();
  reconcileRunSlotsAtBoot(opts.host);
  const requested = opts.slot_no == null ? null : Number(opts.slot_no);
  if (requested != null && !validSlotNo(requested)) {
    throw new FoundryError(400, 'foundry_invalid_slot', 'slot_no must be 1, 2, or 3');
  }
  const slots = listRunSlotsStmt.all();
  if (requested != null) {
    const target = slots.find((slot) => slot.slot_no === requested) ?? null;
    if (!target) throw new FoundryError(400, 'foundry_invalid_slot', 'slot_no must be 1, 2, or 3');
    if (target.status === 'running' && pidAlive(target.pid)) {
      if (!opts.replace) {
        throw new FoundryError(409, 'foundry_slot_occupied', `Foundry run slot ${requested} is already running`, {
          slot: serializeRunSlot(target, opts.host),
        });
      }
      stopRunSlot(requested, { host: opts.host });
    }
    const refreshed = getRunSlotWithProjectStmt.get(requested);
    if (!refreshed) throw new FoundryError(400, 'foundry_invalid_slot', 'slot_no must be 1, 2, or 3');
    return refreshed;
  }

  const free = slots.find((slot) => slot.status !== 'running' || !pidAlive(slot.pid));
  if (!free) {
    throw new FoundryError(409, 'foundry_slots_full', 'all Foundry run slots are busy', {
      slots: slotOccupants(opts.host).map((slot) => ({
        slot_no: slot.slot_no,
        project_id: slot.project_id,
        project_name: slot.project_name,
        port: slot.port,
        pid: slot.pid,
      })),
    });
  }
  return free;
}

async function probePort(port: number): Promise<boolean> {
  for (const pathPart of ['/health', '/']) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_000);
    try {
      await fetch(`http://127.0.0.1:${port}${pathPart}`, { signal: controller.signal });
      clearTimeout(timeout);
      return true;
    } catch {
      clearTimeout(timeout);
    }
  }
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1_000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export async function runSlotHealthTick(host?: string | null): Promise<void> {
  if (runSlotHealthRunning) return;
  runSlotHealthRunning = true;
  try {
    ensureRunSlots();
    for (const slot of listRunSlotsStmt.all()) {
      if (slot.status !== 'running') continue;
      if (!pidAlive(slot.pid)) {
        setRunSlotDeadStmt.run(slot.slot_no);
        emitRunSlot(slot.slot_no, host);
        if (slot.project_id) {
          const project = getProjectStmt.get(slot.project_id);
          if (project) emitProject('updated', project, projectModulesStmt.all(project.id));
        }
        continue;
      }
      if (await probePort(slot.port)) {
        setRunSlotHealthStmt.run(slot.slot_no);
      }
    }
  } finally {
    runSlotHealthRunning = false;
  }
}

export function listProjects(status: FoundryProjectStatus | 'all' = 'all'): FoundryProjectResponse[] {
  const rows = status === 'all' ? listProjectsStmt.all() : listProjectsByStatusStmt.all(status);
  return rows.map((row) => serializeFoundryProject(row));
}

export function getProject(id: string): FoundryProjectResponse | null {
  const row = getProjectStmt.get(id) ?? null;
  return row ? serializeFoundryProject(row) : null;
}

export function getProjectRow(id: string): FoundryProjectRow | null {
  return getProjectStmt.get(id) ?? null;
}

export function getProjectWithModules(id: string): FoundryProjectWithModulesResponse | null {
  const row = getProjectStmt.get(id) ?? null;
  if (!row) return null;
  const modules = projectModulesStmt.all(id);
  return {
    project: serializeFoundryProject(row, modules),
    modules: modules.map(serializeFoundryModule),
    integration: serializeFoundryIntegration(row),
  };
}

export function createProject(args: {
  name: string;
  prompt: string;
  repo_path?: string | null;
  base_branch?: string | null;
  origin_thread_ext?: string | null;
}): { project: FoundryProjectResponse; modules: FoundryModuleResponse[] } {
  const name = args.name.trim();
  const prompt = args.prompt.trim();
  if (!name) throw new FoundryError(400, 'invalid_request', 'name is required');
  if (!prompt) throw new FoundryError(400, 'invalid_request', 'prompt is required');
  const id = nextProjectId(name);
  const baseBranch = args.base_branch?.trim() || 'main';
  const root = process.env.FOUNDRY_ROOT ?? '/home/kevin/foundry';
  const repoPath = args.repo_path?.trim() || path.join(root, id);
  try {
    maybeScaffoldRepo(repoPath, name, prompt, baseBranch);
  } catch (err) {
    throw new FoundryError(500, 'foundry_repo_error', err instanceof Error ? err.message : String(err));
  }
  insertProjectStmt.run(id, name, prompt, repoPath, baseBranch, args.origin_thread_ext?.trim() || null);
  const created = getProjectStmt.get(id);
  if (!created) throw new FoundryError(500, 'foundry_create_failed', 'project was inserted but could not be loaded');
  emitProject('created', created, []);
  return { project: serializeFoundryProject(created, []), modules: [] };
}

export function setBlueprint(
  id: string,
  blueprintInput: unknown,
  opts: { onlyWhilePlanning?: boolean } = {},
): { project: FoundryProjectResponse; modules: FoundryModuleResponse[] } {
  const project = getProjectStmt.get(id) ?? null;
  if (!project) throw new FoundryError(404, 'foundry_project_not_found', 'foundry project not found');
  const foundationBlocked = project.status === 'blocked'
    && !project.integration_tree_id
    && projectModulesStmt.all(id).every((module) => !module.tree_id);
  if (project.status !== 'draft' && project.status !== 'planning' && project.status !== 'planned' && !foundationBlocked) {
    throw new FoundryError(409, 'foundry_project_locked', 'blueprint can only be changed while project is draft, planning, planned, or blocked before any tree was planted');
  }
  // The planner's own write must not clobber a blueprint Kevin edited (and
  // possibly launched) while the planner was still running.
  if (opts.onlyWhilePlanning && project.status !== 'planning') {
    throw new FoundryError(409, 'foundry_plan_superseded', 'project left the planning state before the planner finished');
  }
  const bp = normalizeBlueprint(blueprintInput);
  const validation = validateBlueprint(bp);
  if (!validation.ok) {
    throw new FoundryError(400, 'invalid_blueprint', 'blueprint is invalid', { errors: validation.errors });
  }
  if (!bp) throw new FoundryError(400, 'invalid_blueprint', 'blueprint is invalid', { errors: validation.errors });
  const tx = sqliteDb.transaction(() => {
    const info = (opts.onlyWhilePlanning ? setBlueprintWhilePlanningStmt : setBlueprintStmt).run(JSON.stringify(bp), bp.run.command.trim(), id);
    if (info.changes !== 1) throw new FoundryError(409, 'foundry_project_locked', 'blueprint can only be changed while project is draft, planning, planned, or blocked before any tree was planted');
    deleteModulesStmt.run(id);
    for (const mod of bp.modules) {
      insertModuleStmt.run(
        id,
        mod.key,
        mod.name,
        mod.kind,
        mod.purpose,
        JSON.stringify({
          provides: Array.isArray(mod.contract.provides) ? mod.contract.provides : [],
          requires: Array.isArray(mod.contract.requires) ? mod.contract.requires : [],
        }),
        JSON.stringify(mod.acceptance),
        JSON.stringify(mod.depends_on),
        `foundry/${id}/${mod.key}`,
      );
    }
  });
  tx();
  const result = getProjectWithModules(id);
  if (!result) throw new FoundryError(404, 'foundry_project_not_found', 'foundry project not found');
  emitProject('updated', getProjectStmt.get(id)!, projectModulesStmt.all(id));
  for (const mod of projectModulesStmt.all(id)) emitModule('created', mod);
  return result;
}

/** Single-flight: returns null unless the project was draft/planned (i.e. a
 *  second concurrent plan, or a plan on a building project, is refused). */
export function markProjectPlanning(id: string, plannerModel?: string | null): FoundryProjectResponse | null {
  const info = setPlanningStmt.run(plannerModel ?? null, id);
  if (info.changes !== 1) return null;
  const row = getProjectStmt.get(id) ?? null;
  if (row) emitProject('updated', row);
  return row ? serializeFoundryProject(row) : null;
}

/** Only a project still in 'planning' drops back to draft — a late planner
 *  failure can never drag a launched/building project backwards. */
export function markProjectPlannerFailed(id: string, message: string): FoundryProjectResponse | null {
  const info = setPlannerFailedStmt.run(message.slice(0, 1000), id);
  const row = getProjectStmt.get(id) ?? null;
  if (row && info.changes === 1) emitProject('updated', row);
  return row ? serializeFoundryProject(row) : null;
}

export function deleteProject(id: string): FoundryProjectResponse | null {
  const row = getProjectStmt.get(id) ?? null;
  if (!row) return null;
  const modules = projectModulesStmt.all(id);
  deleteProjectStmt.run(id);
  for (const mod of modules) emitModule('deleted', mod);
  emitProject('deleted', row, modules);
  return serializeFoundryProject(row, modules);
}

function loadBlueprint(project: FoundryProjectRow): Blueprint | null {
  return normalizeBlueprint(parseJson<unknown>(project.blueprint, null));
}

function foundationFromBlueprint(blueprint: Blueprint | null): FoundryFoundation | null {
  const raw = blueprint?.foundation;
  if (!isRecord(raw)) return null;
  const stack = nonEmptyString(raw.stack);
  const scaffoldCmd = nonEmptyString(raw.scaffold_cmd);
  if (!stack || !scaffoldCmd || !Array.isArray(raw.checks)) return null;
  const checks: FoundryFoundationCheck[] = [];
  for (const check of raw.checks) {
    if (!isRecord(check)) return null;
    const cmd = nonEmptyString(check.cmd);
    if (!cmd) return null;
    const expectRegex = Object.prototype.hasOwnProperty.call(check, 'expect_regex')
      ? nonEmptyString(check.expect_regex)
      : null;
    checks.push(expectRegex ? { cmd, expect_regex: expectRegex } : { cmd });
  }
  return { stack, scaffold_cmd: scaffoldCmd, checks };
}

function persistFoundryJson(project: FoundryProjectRow, blueprint: Blueprint): void {
  fs.writeFileSync(path.join(project.repo_path, 'foundry.json'), `${JSON.stringify(blueprint, null, 2)}\n`);
}

function gitStatusPaths(repoPath: string): string[] {
  const status = gitText(['status', '--porcelain'], repoPath);
  return status
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).split(' -> ').pop()?.trim() ?? line.slice(3).trim())
    .filter(Boolean);
}

function commitSelectedIfChanged(repoPath: string, files: string[], message: string): string | null {
  ensureGitIdentity(repoPath);
  for (const file of files) {
    if (fs.existsSync(path.join(repoPath, file))) git(['add', file], repoPath);
  }
  try {
    execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: repoPath, stdio: 'ignore', timeout: 30_000 });
    return null;
  } catch {
    git(['commit', '-m', message], repoPath);
    return gitText(['rev-parse', 'HEAD'], repoPath).trim();
  }
}

function commitAllIfChanged(repoPath: string, message: string): string | null {
  ensureGitIdentity(repoPath);
  git(['add', '-A'], repoPath);
  try {
    execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: repoPath, stdio: 'ignore', timeout: 30_000 });
    return null;
  } catch {
    git(['commit', '-m', message], repoPath);
    return gitText(['rev-parse', 'HEAD'], repoPath).trim();
  }
}

function readFoundationNote(repoPath: string, sha: string): { scaffold_cmd?: string; stack?: string } | null {
  try {
    const raw = gitText(['notes', '--ref=foundry.scaffold', 'show', sha], repoPath).trim();
    return JSON.parse(raw) as { scaffold_cmd?: string; stack?: string };
  } catch {
    return null;
  }
}

function writeFoundationNote(repoPath: string, sha: string, foundation: FoundryFoundation, mode: 'scaffold' | 'adopt'): void {
  const note = JSON.stringify({
    stack: foundation.stack,
    scaffold_cmd: foundation.scaffold_cmd,
    mode,
    created_at: new Date().toISOString(),
  }, null, 2);
  try {
    execFileSync('git', ['notes', '--ref=foundry.scaffold', 'add', '-f', '-m', note, sha], { cwd: repoPath, stdio: 'ignore', timeout: 30_000 });
  } catch {
    // Git notes are an idempotency aid, not the authoritative gate. The DB-owned
    // blueprint and the FOUNDATION commit subject still control launch/finish.
  }
}

function foundationCommitState(repoPath: string, foundation: FoundryFoundation): {
  current: { sha: string; subject: string; note: { scaffold_cmd?: string; stack?: string } | null } | null;
  other: { sha: string; subject: string } | null;
} {
  let log = '';
  try {
    log = gitText(['log', '--format=%H%x09%s'], repoPath);
  } catch {
    return { current: null, other: null };
  }
  const wantedSubjects = new Set([
    `FOUNDATION scaffold: ${foundation.stack}`,
    `FOUNDATION adopt: ${foundation.stack}`,
  ]);
  let current: { sha: string; subject: string; note: { scaffold_cmd?: string; stack?: string } | null } | null = null;
  let other: { sha: string; subject: string } | null = null;
  for (const line of log.split('\n').filter(Boolean)) {
    const [sha, ...subjectParts] = line.split('\t');
    const subject = subjectParts.join('\t');
    if (!sha || !subject.startsWith('FOUNDATION ')) continue;
    if (wantedSubjects.has(subject) && !current) {
      current = { sha, subject, note: readFoundationNote(repoPath, sha) };
    } else if (/^FOUNDATION (?:scaffold|adopt): /.test(subject) && !wantedSubjects.has(subject) && !other) {
      other = { sha, subject };
    }
  }
  return { current, other };
}

function ensureFoundationRepoClean(project: FoundryProjectRow): void {
  const dirty = gitStatusPaths(project.repo_path).filter((file) => file !== 'foundry.json');
  if (dirty.length) {
    throw new FoundryError(
      409,
      'foundry_foundation_dirty_repo',
      `foundation scaffold refused to run because the project repo has dirty files: ${dirty.slice(0, 12).join(', ')}`,
    );
  }
}

const FOUNDRY_BOOTSTRAP_ENTRIES = ['foundry.json', 'README.md', 'modules', 'contracts'];
const FOUNDRY_APP_MARKERS = ['artisan', 'composer.json', 'package.json', 'pyproject.toml', 'manage.py', 'app', 'bootstrap', 'routes', 'src'];

/** True when the repo holds nothing but the initial Foundry bootstrap
 *  (foundry.json/README/modules/contracts) — i.e. no framework skeleton and no
 *  hand-written app content exists yet. */
function isBareFoundryBootstrap(repoPath: string): boolean {
  if (FOUNDRY_APP_MARKERS.some((entry) => fs.existsSync(path.join(repoPath, entry)))) return false;
  const entries = fs.readdirSync(repoPath).filter((entry) => entry !== '.git');
  return entries.every((entry) => FOUNDRY_BOOTSTRAP_ENTRIES.includes(entry));
}

/** Runs scaffold_cmd in an EMPTY sibling staging directory, then overlays the
 *  result onto the repo (skipping any .git the scaffolder itself created).
 *  Real scaffolders refuse a non-empty target — `composer create-project
 *  laravel/laravel .` fails with "Project directory is not empty" the moment
 *  `.git/` exists (verified 2026-09-12), and create-next-app / rails new are
 *  the same — so the scaffold can never run in the repo itself. A sibling
 *  (same filesystem) keeps the overlay a plain copy with no cross-device
 *  surprises, and the repo is untouched until the scaffold has exited 0. */
function runStagedFoundationScaffold(repoPath: string, foundation: FoundryFoundation): ShellCommandResult {
  const parent = path.dirname(repoPath);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, `.foundry-scaffold-${path.basename(repoPath)}-`));
  try {
    const result = runFoundationShell(foundation.scaffold_cmd, staging, FOUNDATION_SCAFFOLD_TIMEOUT_MS);
    if (result.timedOut || result.exitCode !== 0) return result;
    fs.cpSync(staging, repoPath, {
      recursive: true,
      force: true,
      filter: (source) => path.relative(staging, source).split(path.sep)[0] !== '.git',
    });
    return result;
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
  }
}

// Foundation checks are a server trust boundary: they are read-only assertions
// authored into the DB-owned blueprint by the planner. Workers can edit the
// repo's transparent foundry.json copy, but this runner never trusts it.
function runFoundationChecksInCwd(cwd: string, foundation: FoundryFoundation): FoundationCheckResult[] {
  const results: FoundationCheckResult[] = [];
  for (const check of foundation.checks) {
    if (FORBIDDEN_FOUNDATION_CHECK_RE.test(check.cmd)) {
      results.push({
        cmd: check.cmd,
        ok: false,
        exitCode: null,
        timedOut: false,
        output: '',
        expect_regex: check.expect_regex,
        error: 'foundation checks must be read-only assertions; destructive/migration commands are refused by the server',
      });
      break;
    }
    let regex: RegExp | null = null;
    if (check.expect_regex) {
      try {
        regex = new RegExp(check.expect_regex);
      } catch (err) {
        results.push({
          cmd: check.cmd,
          ok: false,
          exitCode: null,
          timedOut: false,
          output: '',
          expect_regex: check.expect_regex,
          error: `invalid expect_regex: ${err instanceof Error ? err.message : String(err)}`,
        });
        break;
      }
    }
    const shell = runFoundationShell(check.cmd, cwd);
    const regexOk = regex ? regex.test(shell.output) : true;
    const ok = !shell.timedOut && shell.exitCode === 0 && regexOk;
    results.push({
      cmd: check.cmd,
      ok,
      exitCode: shell.exitCode,
      timedOut: shell.timedOut,
      output: shell.output,
      expect_regex: check.expect_regex,
      error: shell.error || (!regexOk ? `output did not match /${check.expect_regex}/` : undefined),
    });
    if (!ok) break;
  }
  return results;
}

function foundationFailureText(foundation: FoundryFoundation, cwd: string, results: FoundationCheckResult[]): string {
  const failing = results.find((result) => !result.ok) ?? results[results.length - 1];
  return [
    'FOUNDATION CHECK FAILED',
    `Stack: ${foundation.stack}`,
    `Checkout: ${cwd}`,
    `Command: ${failing?.cmd ?? '(no command)'}`,
    failing?.timedOut ? `Timed out after ${FOUNDATION_CHECK_TIMEOUT_MS}ms` : `Exit code: ${failing?.exitCode ?? 'null'}`,
    failing?.expect_regex ? `Expected output regex: ${failing.expect_regex}` : null,
    failing?.error ? `Error: ${failing.error}` : null,
    '',
    'Output tail:',
    failing?.output || '(no output)',
  ].filter((line): line is string => line != null).join('\n');
}

function blockProjectForFoundation(project: FoundryProjectRow, code: string, message: string): never {
  const clipped = message.slice(0, 4000);
  setProjectBlockedStmt.run(clipped, project.id);
  const updated = getProjectStmt.get(project.id);
  if (updated) emitProject('updated', updated, projectModulesStmt.all(project.id));
  createNotification({
    severity: 'error',
    title: `🏭 ${project.name} foundation is blocked`,
    body: clipped.slice(0, 1000),
    source: 'foundry',
    link: `/foundry?project=${encodeURIComponent(project.id)}`,
  });
  throw new FoundryError(409, code, message);
}

function runLaunchFoundationChecksOrBlock(project: FoundryProjectRow, foundation: FoundryFoundation): void {
  const results = runFoundationChecksInCwd(project.repo_path, foundation);
  if (results.some((result) => !result.ok)) {
    blockProjectForFoundation(project, 'foundry_foundation_check_failed', foundationFailureText(foundation, project.repo_path, results));
  }
}

function runFoundationScaffoldAtLaunch(project: FoundryProjectRow, blueprint: Blueprint): void {
  const foundation = foundationFromBlueprint(blueprint);
  if (!foundation) {
    persistFoundryJson(project, blueprint);
    commitSelectedIfChanged(project.repo_path, ['foundry.json'], 'foundry: persist blueprint');
    return;
  }

  const commitState = foundationCommitState(project.repo_path, foundation);
  if (commitState.other) {
    blockProjectForFoundation(
      project,
      'foundry_foundation_stack_changed',
      `foundation scaffold refused to run: repo already has ${commitState.other.subject} (${commitState.other.sha}), but blueprint declares ${foundation.stack}`,
    );
  }
  if (commitState.current?.note?.scaffold_cmd && commitState.current.note.scaffold_cmd !== foundation.scaffold_cmd) {
    blockProjectForFoundation(
      project,
      'foundry_foundation_scaffold_changed',
      `foundation scaffold refused to run: ${commitState.current.subject} already exists with scaffold_cmd "${commitState.current.note.scaffold_cmd}", but blueprint now declares "${foundation.scaffold_cmd}". Replan instead of rerunning a non-idempotent scaffold.`,
    );
  }

  ensureFoundationRepoClean(project);

  if (commitState.current) {
    // Idempotent relaunch: bones already committed, only re-assert them.
    persistFoundryJson(project, blueprint);
    runLaunchFoundationChecksOrBlock(project, foundation);
    commitSelectedIfChanged(project.repo_path, ['foundry.json'], 'foundry: update blueprint');
    return;
  }

  const bare = isBareFoundryBootstrap(project.repo_path);
  const preScaffoldChecks = runFoundationChecksInCwd(project.repo_path, foundation);
  if (preScaffoldChecks.length && preScaffoldChecks.every((result) => result.ok)) {
    if (bare) {
      // A gate that passes on an empty repo cannot fail on a faked one. The
      // checks are the only finish-time assertion the planner controls, so a
      // vacuous set is refused at the door rather than silently adopted.
      blockProjectForFoundation(project, 'foundry_foundation_checks_vacuous', [
        'FOUNDATION CHECKS VACUOUS',
        `Stack: ${foundation.stack}`,
        'Every foundation check passed on a repo that has no framework skeleton yet, so the checks assert nothing about the bones.',
        'Fix the blueprint so at least one check fails before scaffold_cmd runs (e.g. `php artisan --version` with expect_regex, `test -f artisan`, `ls vendor/autoload.php`), then relaunch.',
        '',
        ...preScaffoldChecks.map((result) => `- ${result.cmd} => exit ${result.exitCode ?? 'null'}`),
      ].join('\n'));
    }
    // Existing real app content already satisfies the gate: adopt it as the foundation.
    persistFoundryJson(project, blueprint);
    runLaunchFoundationChecksOrBlock(project, foundation);
    const sha = commitSelectedIfChanged(project.repo_path, ['foundry.json'], `FOUNDATION adopt: ${foundation.stack}`);
    if (sha) writeFoundationNote(project.repo_path, sha, foundation, 'adopt');
    return;
  }

  const scaffold = runStagedFoundationScaffold(project.repo_path, foundation);
  if (scaffold.timedOut || scaffold.exitCode !== 0) {
    blockProjectForFoundation(project, 'foundry_foundation_scaffold_failed', [
      'FOUNDATION SCAFFOLD FAILED',
      `Stack: ${foundation.stack}`,
      `Command: ${foundation.scaffold_cmd}`,
      scaffold.timedOut ? `Timed out after ${FOUNDATION_SCAFFOLD_TIMEOUT_MS}ms` : `Exit code: ${scaffold.exitCode ?? 'null'}`,
      scaffold.error ? `Error: ${scaffold.error}` : null,
      '',
      'Output tail:',
      scaffold.output || '(no output)',
    ].filter((line): line is string => line != null).join('\n'));
  }

  persistFoundryJson(project, blueprint);
  fs.mkdirSync(path.join(project.repo_path, 'modules'), { recursive: true });
  fs.mkdirSync(path.join(project.repo_path, 'contracts'), { recursive: true });
  // The scaffold exited 0, so the bones are real: commit them BEFORE asserting
  // the checks. If a planner-authored check is wrong (bad regex, wrong binary
  // name), the project blocks with the check output, the blueprint stays
  // editable (nothing planted yet), and relaunch takes the idempotent path
  // above instead of re-running a non-idempotent scaffold into a dirty repo.
  const sha = commitAllIfChanged(project.repo_path, `FOUNDATION scaffold: ${foundation.stack}`);
  if (sha) writeFoundationNote(project.repo_path, sha, foundation, 'scaffold');
  runLaunchFoundationChecksOrBlock(project, foundation);
}

/** The checkout must be a git checkout whose HEAD descends from the
 *  server-made FOUNDATION commit. This is the planner-independent half of the
 *  gate: a worker that reinitialised, orphaned, or hand-built a tree that
 *  happens to satisfy the checks (a fake `artisan` printing "Laravel
 *  Framework …") still fails here. */
function foundationDerivationFailure(project: FoundryProjectRow, foundation: FoundryFoundation, checkoutPath: string): string | null {
  const state = foundationCommitState(project.repo_path, foundation);
  if (!state.current) {
    return `The project repo ${project.repo_path} has no "FOUNDATION scaffold/adopt: ${foundation.stack}" commit, so no checkout can be verified against it. Relaunch the project to (re)establish the foundation commit.`;
  }
  const headProbe = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: checkoutPath, encoding: 'utf8', timeout: 30_000 });
  const head = headProbe.status === 0 ? String(headProbe.stdout ?? '').trim() : '';
  if (!head) {
    return `${checkoutPath} is not a git checkout with a HEAD commit. Workers must work in a worktree branched from the project base ref, never a bare directory.`;
  }
  const probe = spawnSync('git', ['merge-base', '--is-ancestor', state.current.sha, head], {
    cwd: checkoutPath,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (probe.status === 0) return null;
  return `Checkout HEAD ${head} does not descend from the server-installed foundation commit ${state.current.sha} (${state.current.subject}). A hand-built or re-initialised skeleton is not accepted even when the checks pass — branch from the project base ref.`;
}

function findFoundationGatedCheckout(nodeId: number): {
  project: FoundryProjectRow;
  foundation: FoundryFoundation;
  label: string;
  checkoutPath: string;
} | null {
  const node = getHopperNode(nodeId);
  if (!node) return null;
  const module = moduleByTreeStmt.get(node.tree_id) ?? null;
  if (module) {
    const ids = stageNodeIds(module);
    if (ids.build !== nodeId) return null;
    const project = getProjectStmt.get(module.project_id) ?? null;
    if (!project) return null;
    const foundation = foundationFromBlueprint(loadBlueprint(project));
    if (!foundation) return null;
    return {
      project,
      foundation,
      label: `module BUILD ${module.key}`,
      checkoutPath: worktreePath(project, module.key),
    };
  }

  const project = projectByIntegrationTreeStmt.get(node.tree_id) ?? null;
  if (!project) return null;
  const nodes = listTreeNodes(node.tree_id);
  const first = nodes[0] ?? null;
  if (!first || first.id !== nodeId || !node.title.startsWith(`MERGE ${project.id}`)) return null;
  const foundation = foundationFromBlueprint(loadBlueprint(project));
  if (!foundation) return null;
  return {
    project,
    foundation,
    label: `integration MERGE ${project.id}`,
    checkoutPath: worktreePath(project, 'integration'),
  };
}

export function runFoundryFoundationFinishGate(
  nodeId: number,
  outcome: 'done' | 'split' | 'blocked_question' | 'blocked',
): { ok: true; gated: boolean } | { ok: false; gated: true; result: string } {
  const gated = findFoundationGatedCheckout(nodeId);
  if (!gated) return { ok: true, gated: false };
  if (outcome === 'split') {
    return {
      ok: false,
      gated: true,
      result: [
        'FOUNDATION CHECK FAILED',
        `Stack: ${gated.foundation.stack}`,
        `Checkout: ${gated.checkoutPath}`,
        `Node: ${gated.label}`,
        '',
        'A foundation-gated BUILD/MERGE node cannot finish with outcome=split.',
        'Only outcome=done can unblock dependents, and done is accepted only after the DB-owned foundation checks pass.',
      ].join('\n'),
    };
  }
  if (outcome !== 'done') return { ok: true, gated: true };
  if (!fs.existsSync(gated.checkoutPath) || !fs.statSync(gated.checkoutPath).isDirectory()) {
    return {
      ok: false,
      gated: true,
      result: [
        'FOUNDATION CHECK FAILED',
        `Stack: ${gated.foundation.stack}`,
        `Checkout: ${gated.checkoutPath}`,
        `Node: ${gated.label}`,
        '',
        'The expected checkout/worktree does not exist, so the server cannot verify the framework foundation.',
      ].join('\n'),
    };
  }
  const results = runFoundationChecksInCwd(gated.checkoutPath, gated.foundation);
  if (results.some((result) => !result.ok)) {
    return {
      ok: false,
      gated: true,
      result: foundationFailureText(gated.foundation, gated.checkoutPath, results),
    };
  }
  const derivation = foundationDerivationFailure(gated.project, gated.foundation, gated.checkoutPath);
  if (derivation) {
    return {
      ok: false,
      gated: true,
      result: [
        'FOUNDATION CHECK FAILED',
        `Stack: ${gated.foundation.stack}`,
        `Checkout: ${gated.checkoutPath}`,
        `Node: ${gated.label}`,
        '',
        'FOUNDATION DERIVATION FAILED',
        derivation,
      ].join('\n'),
    };
  }
  return { ok: true, gated: true };
}

/** True when the project repo has an `origin` remote. A freshly scaffolded
 *  Foundry repo (the default `/home/kevin/foundry/<slug>`) has none, so
 *  worktree/merge refs and push instructions must fall back to local branches. */
function repoHasOrigin(project: FoundryProjectRow): boolean {
  try {
    execFileSync('git', ['-C', project.repo_path, 'remote', 'get-url', 'origin'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function projectBaseRef(project: FoundryProjectRow): string {
  return repoHasOrigin(project) ? `origin/${project.base_branch}` : project.base_branch;
}

function remoteTemplateVars(project: FoundryProjectRow): Record<string, string> {
  const hasOrigin = repoHasOrigin(project);
  return {
    remote_prefix: hasOrigin ? 'origin/' : '',
    push_hint: hasOrigin
      ? 'Push ONLY your branch to origin.'
      : 'This repo has NO remote — the branch stays local in the repo; do NOT try to push, and merge local branches directly.',
  };
}

function worktreesRoot(): string {
  return process.env.FOUNDRY_WORKTREES ?? '/home/kevin/foundry-worktrees';
}

function worktreePath(project: FoundryProjectRow, suffix: string): string {
  return path.join(worktreesRoot(), `${project.id}-${suffix}`);
}

function moduleDetails(project: FoundryProjectRow, module: FoundryModuleRow): string {
  return JSON.stringify({
    project: {
      id: project.id,
      name: project.name,
      prompt: project.prompt,
      repo_path: project.repo_path,
      base_branch: project.base_branch,
    },
    module: {
      key: module.key,
      name: module.name,
      kind: module.kind,
      purpose: module.purpose,
      branch: module.branch,
      contract: parseJson(module.contract, { provides: [], requires: [] }),
      acceptance: parseJson(module.acceptance, []),
      depends_on: parseJson(module.depends_on, []),
    },
  }, null, 2);
}

function formatList(value: unknown): string {
  const list = Array.isArray(value) ? value : [];
  if (!list.length) return '- (none)';
  return list.map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n');
}

function formatStringList(value: unknown): string {
  const list = Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : [];
  return list.length ? list.map((item) => `- ${item}`).join('\n') : '- (none)';
}

function moduleTemplateVars(module: FoundryModuleRow, project: FoundryProjectRow, nodeId: number): Record<string, unknown> {
  const contract = parseJson<{ provides: unknown[]; requires: unknown[] }>(module.contract, { provides: [], requires: [] });
  return {
    project: project.id,
    project_name: project.name,
    key: module.key,
    name: module.name,
    kind: module.kind,
    purpose: module.purpose,
    provides: formatList(contract.provides),
    requires: formatList(contract.requires),
    acceptance: formatStringList(parseJson(module.acceptance, [])),
    repo: project.repo_path,
    base_branch: project.base_branch,
    worktrees: worktreesRoot(),
    module_worktree: worktreePath(project, module.key),
    module_branch: module.branch,
    base_ref: projectBaseRef(project),
    ...remoteTemplateVars(project),
    skill_dir: getFoundrySkillDir(),
    node_id: nodeId,
    '#if kind==contracts': module.kind === 'contracts' ? ' and `contracts/`' : '',
    '/if': '',
  };
}

export function composeStageSpec(stage: FoundryStageKey, module: FoundryModuleRow, project: FoundryProjectRow, nodeId: number): string {
  return renderTemplate(stage, moduleTemplateVars(module, project, nodeId));
}

export function plantModuleTree(module: FoundryModuleRow, projectArg?: FoundryProjectRow): {
  tree: HopperTreeRow;
  nodes: HopperNodeRow[];
  module: FoundryModuleRow;
} {
  const project = projectArg ?? getProjectStmt.get(module.project_id) ?? null;
  if (!project) throw new FoundryError(404, 'foundry_project_not_found', 'foundry project not found');
  if (module.tree_id) {
    const tree = getHopperTree(module.tree_id);
    if (!tree) throw new FoundryError(500, 'foundry_tree_missing', 'module has a tree_id but the Hopper tree is missing');
    return {
      tree,
      nodes: listTreeNodes(module.tree_id),
      module,
    };
  }

  const build = stageLoadout('build');
  const test = stageLoadout('test');
  const doc = stageLoadout('doc');
  const nodeInputs: NewNodeInput[] = [
    {
      title: `BUILD ${module.key}`,
      spec: null,
      priority: 30,
      adapter: build.adapter,
      model: build.model,
    },
    {
      title: `TEST ${module.key}`,
      spec: null,
      depends_on_indexes: [0],
      priority: 20,
      adapter: test.adapter,
      model: test.model,
    },
    {
      title: `DOC ${module.key}`,
      spec: null,
      depends_on_indexes: [1],
      priority: 10,
      adapter: doc.adapter,
      model: doc.model,
    },
  ];
  const created = createHopperTree(`foundry:${project.id}/${module.key}`, project.origin_thread_ext ?? null, nodeInputs);
  const buildNodeId = created.nodes[0]?.id ?? null;
  const testNodeId = created.nodes[1]?.id ?? null;
  const docNodeId = created.nodes[2]?.id ?? null;
  if (buildNodeId != null) updateHopperNodeSpec(buildNodeId, composeStageSpec('build', module, project, buildNodeId));
  if (testNodeId != null) updateHopperNodeSpec(testNodeId, composeStageSpec('test', module, project, testNodeId));
  if (docNodeId != null) updateHopperNodeSpec(docNodeId, composeStageSpec('doc', module, project, docNodeId));
  agreeHopperTree(created.tree.id);
  const stageNodes = {
    build: buildNodeId,
    test: testNodeId,
    doc: docNodeId,
  };
  const staged = {
    ...module,
    tree_id: created.tree.id,
    stage_nodes: JSON.stringify(stageNodes),
  };
  const stage = deriveStage(project, staged);
  setModuleTreeStmt.run(created.tree.id, JSON.stringify(stageNodes), stage, latestStageResult(staged), blockedReason(staged), module.id);
  const updated = moduleByKeyStmt.get(module.project_id, module.key);
  if (!updated) throw new FoundryError(500, 'foundry_module_missing', 'module disappeared after tree planting');
  emitModule('updated', updated);
  return { tree: created.tree, nodes: listTreeNodes(created.tree.id), module: updated };
}

function recomputeProjectStatus(projectId: string): FoundryProjectRow | null {
  const project = getProjectStmt.get(projectId) ?? null;
  if (!project || project.status === 'launched' || project.status === 'planning') return project;
  const modules = projectModulesStmt.all(projectId);
  let next: FoundryProjectStatus = project.blueprint ? 'planned' : 'draft';
  if (modules.some((module) => module.stage === 'blocked' || module.stage === 'needs_answer')) {
    next = 'blocked';
  } else if (project.integration_tree_id && integrationTreeBlocked(project)) {
    next = 'blocked';
  } else if (project.integration_tree_id && integrationTreeDone(project)) {
    next = 'ready';
  } else if (modules.length && modules.every((module) => stageAtLeast(module.stage, 'documented'))) {
    next = 'integrating';
  } else if (modules.some((module) => module.tree_id)) {
    next = 'building';
  }
  if (project.status !== next) setProjectStatusStmt.run(next, projectId);
  const updated = getProjectStmt.get(projectId) ?? null;
  if (updated && project.status !== updated.status) emitProject('updated', updated, projectModulesStmt.all(projectId));
  return updated;
}

function maybePlantReadyModules(projectId: string): number {
  const project = getProjectStmt.get(projectId) ?? null;
  if (!project || project.status === 'launched') return 0;
  const modules = projectModulesStmt.all(projectId).map((module) => refreshModuleStage(project, module).module);
  const byKey = new Map(modules.map((module) => [module.key, module]));
  let planted = 0;
  for (const module of modules) {
    if (module.tree_id) continue;
    const deps = parseJson<string[]>(module.depends_on, []);
    const ready = deps.every((depKey) => {
      const dep = byKey.get(depKey);
      return !!dep && stageAtLeast(dep.stage, 'tested');
    });
    if (!ready) continue;
    const result = plantModuleTree(module, project);
    byKey.set(module.key, result.module);
    planted += 1;
  }
  if (planted > 0) recomputeProjectStatus(projectId);
  return planted;
}

function integrationModuleSummary(modules: FoundryModuleRow[]): string {
  if (!modules.length) return '- (none)';
  return modules.map((module) => {
    const contract = parseJson<{ provides: unknown[]; requires: unknown[] }>(module.contract, { provides: [], requires: [] });
    const deps = parseJson<string[]>(module.depends_on, []);
    return [
      `- ${module.key} (${module.kind}) -> ${module.branch}`,
      `  purpose: ${module.purpose}`,
      `  depends_on: ${deps.length ? deps.join(', ') : '(none)'}`,
      `  provides: ${contract.provides.length ? contract.provides.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('; ') : '(none)'}`,
      `  requires: ${contract.requires.length ? contract.requires.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('; ') : '(none)'}`,
    ].join('\n');
  }).join('\n');
}

function integrationAcceptanceSummary(modules: FoundryModuleRow[]): string {
  if (!modules.length) return '- (none)';
  return modules.map((module) => [
    `${module.key}:`,
    formatStringList(parseJson(module.acceptance, [])),
  ].join('\n')).join('\n\n');
}

function integrationTemplateName(stage: 'merge' | 'review' | 'docs'): string {
  if (stage === 'merge') return 'integrate-merge';
  if (stage === 'review') return 'integrate-review';
  return 'integrate-docs';
}

function composeIntegrationSpec(
  stage: 'merge' | 'review' | 'docs',
  project: FoundryProjectRow,
  modules: FoundryModuleRow[],
  nodeId: number,
): string {
  const bp = loadBlueprint(project);
  const vars: Record<string, unknown> = {
    project: project.id,
    project_name: project.name,
    prompt: project.prompt,
    repo: project.repo_path,
    base_branch: project.base_branch,
    base_ref: projectBaseRef(project),
    ...remoteTemplateVars(project),
    worktrees: worktreesRoot(),
    integration_worktree: worktreePath(project, 'integration'),
    integration_branch: `foundry/${project.id}/integration`,
    integration_test: bp?.integration?.test ?? '(missing integration.test)',
    wiring: formatList(bp?.wiring ?? []),
    acceptance_all: integrationAcceptanceSummary(modules),
    node_id: nodeId,
  };
  if (stage === 'docs') {
    vars.modules = modules.map((module) => module.key).join(' ');
  } else {
    vars.modules = integrationModuleSummary(modules);
  }
  return renderTemplate(integrationTemplateName(stage), vars);
}

function maybePlantIntegrationTree(projectId: string): HopperTreeRow | null {
  const project = getProjectStmt.get(projectId) ?? null;
  if (!project || project.status === 'launched' || project.integration_tree_id) return null;
  const modules = projectModulesStmt.all(projectId).map((module) => refreshModuleStage(project, module).module);
  if (!modules.length || !modules.every((module) => stageAtLeast(module.stage, 'documented'))) return null;

  const merge = integrationLoadout();
  const review = { adapter: 'claude', model: 'claude-opus-5' };
  const docs = integrationLoadout();
  const created = createHopperTree(`foundry:${project.id}/integration`, project.origin_thread_ext ?? null, [
    {
      title: `MERGE ${project.id}`,
      spec: null,
      priority: 30,
      adapter: merge.adapter,
      model: merge.model,
    },
    {
      title: `REVIEW ${project.id}`,
      spec: null,
      depends_on_indexes: [0],
      priority: 20,
      adapter: review.adapter,
      model: review.model,
    },
    {
      title: `DOCS ${project.id}`,
      spec: null,
      depends_on_indexes: [1],
      priority: 10,
      adapter: docs.adapter,
      model: docs.model,
    },
  ]);
  const mergeNodeId = created.nodes[0]?.id ?? null;
  const reviewNodeId = created.nodes[1]?.id ?? null;
  const docsNodeId = created.nodes[2]?.id ?? null;
  if (mergeNodeId != null) updateHopperNodeSpec(mergeNodeId, composeIntegrationSpec('merge', project, modules, mergeNodeId));
  if (reviewNodeId != null) updateHopperNodeSpec(reviewNodeId, composeIntegrationSpec('review', project, modules, reviewNodeId));
  if (docsNodeId != null) updateHopperNodeSpec(docsNodeId, composeIntegrationSpec('docs', project, modules, docsNodeId));
  const branch = `foundry/${project.id}/integration`;
  const saved = setProjectIntegrationStmt.run(created.tree.id, branch, project.id);
  if (saved.changes !== 1) return null;
  agreeHopperTree(created.tree.id);
  const updated = getProjectStmt.get(project.id);
  if (updated) emitProject('updated', updated, projectModulesStmt.all(project.id));
  return created.tree;
}

export function launchProject(id: string): { project: FoundryProjectResponse; modules: FoundryModuleResponse[] } {
  const project = getProjectStmt.get(id) ?? null;
  if (!project) throw new FoundryError(404, 'foundry_project_not_found', 'foundry project not found');
  if (!['planned', 'building', 'blocked'].includes(project.status)) {
    throw new FoundryError(409, 'foundry_project_not_planned', 'project must be planned before launch');
  }
  const blueprint = loadBlueprint(project);
  const validation = validateBlueprint(blueprint);
  if (!validation.ok) throw new FoundryError(400, 'invalid_blueprint', 'blueprint is invalid', { errors: validation.errors });
  if (!blueprint) throw new FoundryError(400, 'invalid_blueprint', 'blueprint is invalid', { errors: validation.errors });
  runFoundationScaffoldAtLaunch(project, blueprint);
  setProjectStatusStmt.run('building', id);
  maybePlantReadyModules(id);
  maybePlantIntegrationTree(id);
  const result = getProjectWithModules(id);
  if (!result) throw new FoundryError(404, 'foundry_project_not_found', 'foundry project not found');
  emitProject('updated', getProjectStmt.get(id)!, projectModulesStmt.all(id));
  return result;
}

function foundryAutoDecideEnabled(): boolean {
  const raw = (getFoundrySetting('auto_decide') ?? '1').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

function foundryConflictText(node: HopperNodeRow): string {
  if (node.status === 'blocked_question') return node.question?.trim() || '(no question text)';
  if (node.result?.trim()) return node.result.trim();
  if (node.attempts > 0) {
    return `The worker lease expired or the node blocked after ${node.attempts} attempt(s) without a precise result.`;
  }
  return '(no blocked reason text)';
}

function autoDecisionSpec(node: HopperNodeRow, label: string): string {
  const base = node.spec?.trim() || `# ${node.title}`;
  const conflict = foundryConflictText(node);
  if (/^FOUNDATION (?:CHECK|SCAFFOLD) FAILED/m.test(conflict)) {
    return [
      base,
      '',
      '## AUTO-RETRY (JARVIS policy) — foundation gate rejected the previous finish',
      '',
      `Node ${node.id} (${node.title}) reported done, but the server-side Foundation Gate refused it:`,
      '',
      conflict,
      '',
      `Scope: ${label}. The framework skeleton is server-installed and the checks above are DB-owned; you cannot edit them away. Work in the worktree branched from the project base ref (it already contains the FOUNDATION commit), never re-initialise or hand-build framework files, make the real checks pass, then finish this same Hopper node. If the toolchain is genuinely missing, finish blocked describing exactly what is missing.`,
    ].join('\n');
  }
  return [
    base,
    '',
    '## AUTO-DECISION (JARVIS policy)',
    '',
    '### Contract Resolution Rule',
    CONTRACT_RESOLUTION_RULE,
    '',
    '### The conflict you must resolve',
    `Node ${node.id} (${node.title}) reported:`,
    '',
    conflict,
    '',
    `Scope: ${label}. Resolve the conflict yourself under the Contract Resolution Rule, correct any tests that contradict the authoritative contract, append the resolution to DECISIONS.md, then finish this same Hopper node. Do not ask Kevin unless the contract is silent and the choice changes user-visible behavior with no sane default.`,
  ].join('\n');
}

function retryFoundryNodeWithDecision(args: {
  project: FoundryProjectRow;
  node: HopperNodeRow;
  label: string;
  link: string;
  notify: boolean;
}): HopperNodeRow | null {
  const loadout = integrationLoadout();
  const prepared = prepareFoundryAutoRetry(
    args.node.id,
    autoDecisionSpec(args.node, args.label),
    loadout.adapter,
    loadout.model,
  );
  if (!prepared) return null;
  const retried = retryHopperNode(args.node.id);
  if (!retried || retried.status !== 'pending') return null;
  if (args.notify) {
    createNotification({
      severity: 'info',
      title: `🏭 ${args.project.name}/${args.label}: auto-decided per Contract Resolution Rule, retrying`,
      body: foundryConflictText(args.node).slice(0, 1000),
      source: 'foundry',
      link: args.link,
    });
  }
  return retried;
}

function maybeAutoRetryFoundryNode(args: {
  project: FoundryProjectRow;
  node: HopperNodeRow;
  label: string;
  link: string;
}): boolean {
  if (args.node.status !== 'blocked' && args.node.status !== 'blocked_question') return false;
  if (!foundryAutoDecideEnabled()) return false;
  if ((args.node.foundry_auto_retries ?? 0) > 0) return false;
  return !!retryFoundryNodeWithDecision({ ...args, notify: true });
}

function handleIntegrationTreeEvent(project: FoundryProjectRow, node: HopperNodeRow): void {
  const nodes = listTreeNodes(project.integration_tree_id ?? node.tree_id);
  const retryable = nodes.find((n) => n.id === node.id && (n.status === 'blocked' || n.status === 'blocked_question'))
    ?? nodes.find((n) => n.status === 'blocked_question')
    ?? nodes.find((n) => n.status === 'blocked');
  if (retryable && maybeAutoRetryFoundryNode({
    project,
    node: retryable,
    label: 'integration',
    link: `/foundry?project=${encodeURIComponent(project.id)}`,
  })) {
    return;
  }
  const blockedQuestion = nodes.find((n) => n.status === 'blocked_question');
  if (blockedQuestion) {
    const reason = blockedQuestion.question ?? `${blockedQuestion.title} needs an answer`;
    if (project.status !== 'blocked' || project.last_error !== reason) {
      setProjectBlockedStmt.run(reason, project.id);
      createNotification({
        severity: 'warning',
        title: `🏭 ${project.name} integration needs your call`,
        body: reason,
        source: 'foundry',
        link: `/foundry?project=${encodeURIComponent(project.id)}`,
      });
    }
    const updated = getProjectStmt.get(project.id);
    if (updated) emitProject('updated', updated, projectModulesStmt.all(project.id));
    return;
  }
  const blocked = nodes.find((n) => n.status === 'blocked');
  if (blocked) {
    const reason = blocked.result ?? `${blocked.title} blocked`;
    if (project.status !== 'blocked' || project.last_error !== reason) {
      setProjectBlockedStmt.run(reason, project.id);
      createNotification({
        severity: 'error',
        title: `🏭 ${project.name} integration is blocked`,
        body: reason,
        source: 'foundry',
        link: `/foundry?project=${encodeURIComponent(project.id)}`,
      });
    }
    const updated = getProjectStmt.get(project.id);
    if (updated) emitProject('updated', updated, projectModulesStmt.all(project.id));
    return;
  }
  if (!nodes.length || !nodes.every((n) => COMPLETE_NODE_STATUSES.has(n.status))) return;
  // Never flip ready while any box is red/orange (review #6).
  const projectModules = projectModulesStmt.all(project.id).map((module) => refreshModuleStage(project, module).module);
  if (projectModules.some((module) => module.stage === 'blocked' || module.stage === 'needs_answer')) {
    recomputeProjectStatus(project.id);
    return;
  }

  const wasReady = project.status === 'ready';
  for (const module of projectModules) {
    if (module.stage !== 'integrated') {
      setModuleIntegratedStmt.run(module.id);
      const updatedModule = moduleByKeyStmt.get(module.project_id, module.key);
      if (updatedModule) emitModule('updated', updatedModule);
    }
  }
  setProjectReadyStmt.run(project.id);
  const updated = getProjectStmt.get(project.id);
  if (updated) emitProject('updated', updated, projectModulesStmt.all(project.id));
  if (!wasReady) {
    createNotification({
      severity: 'success',
      title: `🏭 ${project.name} is ready — all boxes green`,
      body: `Integration tree ${project.integration_tree_id ?? node.tree_id} completed. GO is now available.`,
      source: 'foundry',
      link: `/foundry?project=${encodeURIComponent(project.id)}`,
    });
  }
}

function handleFoundrySse(ev: SSEEvent): void {
  if (ev.type !== 'hopper_node') return;
  const node = ev.node;
  const module = moduleByTreeStmt.get(node.tree_id) ?? null;
  if (module) {
    const project = getProjectStmt.get(module.project_id) ?? null;
    if (!project) return;
    if (maybeAutoRetryFoundryNode({
      project,
      node,
      label: module.key,
      link: `/foundry?project=${encodeURIComponent(project.id)}&module=${encodeURIComponent(module.key)}`,
    })) {
      return;
    }
    const refreshed = refreshModuleStage(project, module);
    recomputeProjectStatus(project.id);
    // Plant on every event once the module is >= tested, not only on the
    // change edge: maybePlantReadyModules/maybePlantIntegrationTree refresh
    // every module's stage themselves (which can consume another module's
    // change edge), and both are idempotent (tree_id / integration_tree_id
    // guards), so re-running them is free and never double-plants.
    if (stageAtLeast(refreshed.module.stage, 'tested')) {
      maybePlantReadyModules(project.id);
      maybePlantIntegrationTree(project.id);
    }
    return;
  }
  const project = projectByIntegrationTreeStmt.get(node.tree_id) ?? null;
  if (project) handleIntegrationTreeEvent(project, node);
}

let foundryStarted = false;
export function startFoundry(): void {
  if (foundryStarted) return;
  foundryStarted = true;
  ensureRunSlots();
  reconcileRunSlotsAtBoot();
  const healthTimer = setInterval(() => {
    runSlotHealthTick().catch((err) => console.error('[foundry] run-slot health tick failed', err));
  }, 10_000);
  healthTimer.unref?.();
  sseBus.on('sse', handleFoundrySse);
  console.log('[foundry] lifecycle listener and run-slot sweeper started');
}

export function goProject(id: string, opts: GoProjectOptions = {}): GoProjectResult {
  const project = getProjectStmt.get(id) ?? null;
  if (!project) throw new FoundryError(404, 'foundry_project_not_found', 'foundry project not found');
  if (project.status !== 'ready') throw new FoundryError(409, 'foundry_project_not_ready', 'project must be ready before GO');
  const blueprint = loadBlueprint(project);
  const runCommand = project.run_command?.trim() || blueprint?.run?.command?.trim() || '';
  if (!runCommand) throw new FoundryError(400, 'foundry_missing_run_command', 'project has no run.command');
  const slot = allocateRunSlot(opts);
  const effectiveCommand = runCommand.replaceAll('{{port}}', String(slot.port));
  const logDir = path.join(project.repo_path, '.foundry');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `run-slot-${slot.slot_no}.log`);
  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.OPENAI_API_KEY;
  childEnv.PORT = String(slot.port);
  childEnv.FOUNDRY_SLOT = String(slot.slot_no);
  let childPid: number | null = null;
  try {
    const out = fs.openSync(logPath, 'a');
    try {
      const child = spawn(effectiveCommand, {
        cwd: project.repo_path,
        shell: true,
        detached: true,
        stdio: ['ignore', out, out],
        env: childEnv,
      });
      if (!child.pid) throw new Error('spawn did not return a child pid');
      childPid = child.pid;
      child.unref();
    } finally {
      fs.closeSync(out);
    }
  } catch (err) {
    throw new FoundryError(500, 'foundry_go_failed', err instanceof Error ? err.message : String(err));
  }
  if (!childPid) throw new FoundryError(500, 'foundry_go_failed', 'spawn did not return a child pid');
  setRunSlotRunningStmt.run(project.id, childPid, effectiveCommand, logPath, slot.slot_no);
  const previewUrl = runSlotPreviewUrl(slot.port, opts.host);
  const blueprintPreviewUrl = blueprint?.run?.preview_url?.trim() || null;
  setProjectLaunchedStmt.run(previewUrl, id);
  const launched = getProjectStmt.get(id);
  if (!launched) throw new FoundryError(404, 'foundry_project_not_found', 'foundry project not found');
  if (previewUrl && launched.origin_thread_ext) {
    const conversation = getOrCreateConversation(launched.origin_thread_ext);
    setPreviewLink(conversation.id, previewUrl, launched.name);
  }
  emitProject('updated', launched, projectModulesStmt.all(id));
  emitRunSlot(slot.slot_no, opts.host);
  const launchedSlot = getRunSlotWithProjectStmt.get(slot.slot_no);
  if (!launchedSlot) throw new FoundryError(500, 'foundry_go_failed', 'launched slot could not be loaded');
  return {
    project: serializeFoundryProject(launched, projectModulesStmt.all(id)),
    launched: true,
    preview_url: previewUrl,
    slot: serializeRunSlot(launchedSlot, opts.host),
    blueprint_preview_url: blueprintPreviewUrl,
  };
}

export function retryModule(projectId: string, key: string, stage?: string | null): {
  module: FoundryModuleResponse;
  node: FoundryStageNodeResponse;
} {
  const project = getProjectStmt.get(projectId) ?? null;
  if (!project) throw new FoundryError(404, 'foundry_project_not_found', 'foundry project not found');
  const module = moduleByKeyStmt.get(projectId, key) ?? null;
  if (!module) throw new FoundryError(404, 'foundry_module_not_found', 'foundry module not found');
  const requestedStage = stage?.trim() as FoundryStageKey | undefined;
  if (requestedStage && !STAGE_KEYS.includes(requestedStage)) {
    throw new FoundryError(400, 'invalid_request', 'stage must be build, test, or doc');
  }
  const ids = stageNodeIds(module);
  const retryStage = requestedStage ?? STAGE_KEYS.find((stageKey) => {
    const id = ids[stageKey];
    const node = id == null ? null : getHopperNode(id);
    return node?.status === 'blocked' || node?.status === 'blocked_question';
  });
  if (!retryStage) throw new FoundryError(409, 'foundry_module_not_retryable', 'module has no blocked stage to retry');
  const nodeId = ids[retryStage];
  if (nodeId == null) throw new FoundryError(409, 'foundry_module_not_retryable', 'requested stage has no Hopper node');
  const retried = retryHopperNode(nodeId);
  if (!retried || retried.status !== 'pending') {
    throw new FoundryError(409, 'foundry_module_not_retryable', 'requested stage is not blocked or waiting on an answer');
  }
  const refreshed = refreshModuleStage(project, module).module;
  const latestProject = recomputeProjectStatus(project.id);
  if (latestProject) emitProject('updated', latestProject, projectModulesStmt.all(project.id));
  return {
    module: serializeFoundryModule(refreshed),
    node: stageNodeFromRaw(stageNodeIds(refreshed), retryStage),
  };
}

export function retryIntegration(projectId: string): {
  integration: FoundryIntegrationResponse;
  node: FoundryIntegrationNodeResponse;
} {
  const project = getProjectStmt.get(projectId) ?? null;
  if (!project) throw new FoundryError(404, 'foundry_project_not_found', 'foundry project not found');
  if (!project.integration_tree_id) {
    throw new FoundryError(409, 'foundry_integration_not_retryable', 'project has no integration tree');
  }
  const nodes = listTreeNodes(project.integration_tree_id);
  const blocked = nodes.find((node) => node.status === 'blocked_question') ?? nodes.find((node) => node.status === 'blocked');
  if (!blocked) {
    throw new FoundryError(409, 'foundry_integration_not_retryable', 'integration has no blocked node to retry');
  }
  const retried = retryFoundryNodeWithDecision({
    project,
    node: blocked,
    label: 'integration',
    link: `/foundry?project=${encodeURIComponent(project.id)}`,
    notify: false,
  });
  if (!retried || retried.status !== 'pending') {
    throw new FoundryError(409, 'foundry_integration_not_retryable', 'blocked integration node could not be re-pended');
  }
  setProjectStatusStmt.run('integrating', project.id);
  const updated = getProjectStmt.get(project.id) ?? project;
  emitProject('updated', updated, projectModulesStmt.all(project.id));
  const integration = serializeFoundryIntegration(updated);
  const responseNode = integration.nodes.find((item) => item.id === retried.id);
  if (!responseNode) {
    throw new FoundryError(500, 'foundry_integration_retry_failed', 'retried node could not be loaded');
  }
  return { integration, node: responseNode };
}

export function isProjectStatus(value: string): value is FoundryProjectStatus {
  return PROJECT_STATUSES.includes(value as FoundryProjectStatus);
}

export function isModuleStage(value: string): value is FoundryModuleStage {
  return MODULE_STAGES.includes(value as FoundryModuleStage);
}
