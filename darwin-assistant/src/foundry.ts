import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getOrCreateConversation, getSetting, sqliteDb } from './conversation-db.js';
import {
  agreeHopperTree,
  createHopperTree,
  getHopperTree,
  getHopperNode,
  listTreeNodes,
  retryHopperNode,
  type HopperNodeRow,
  type HopperNodeStatus,
  type HopperTreeRow,
  type NewNodeInput,
} from './hopper-engine.js';
import { createNotification } from './notifications.js';
import { sseBus, type SSEEvent } from './sse-bus.js';
import { setPreviewLink } from './thread-links.js';

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

interface BlueprintModule {
  key: string;
  name: string;
  kind: FoundryModuleKind;
  purpose: string;
  contract: { provides: unknown[]; requires: unknown[] };
  acceptance: string[];
  depends_on: string[];
}

interface Blueprint {
  name: string;
  prompt: string;
  modules: BlueprintModule[];
  wiring: unknown[];
  integration: { test: string; docs?: string };
  run: { command: string; preview_url?: string };
  assumptions?: string[];
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
const COMPLETE_NODE_STATUSES = new Set<HopperNodeStatus>(['done', 'split']);

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
    AND status IN ('draft','planned')
`);
const setPlanningStmt = sqliteDb.prepare<[string | null, string]>(`
  UPDATE foundry_projects
  SET status = 'planning',
      planner_model = ?,
      last_error = NULL,
      updated_at = datetime('now')
  WHERE id = ?
`);
const setPlannerFailedStmt = sqliteDb.prepare<[string, string]>(`
  UPDATE foundry_projects
  SET status = 'draft',
      last_error = ?,
      updated_at = datetime('now')
  WHERE id = ?
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

function stageLoadout(stage: FoundryStageKey): { adapter: string; model: string } {
  const defaults: Record<FoundryStageKey, { adapter: string; model: string }> = {
    build: { adapter: 'codex', model: 'gpt-5.5' },
    test: { adapter: 'claude', model: 'claude-sonnet-5' },
    doc: { adapter: 'claude', model: 'claude-haiku-4-5-20251001' },
  };
  const fallback = defaults[stage];
  const raw = getSetting(`foundry_${stage}_model`)?.trim()
    || process.env[`FOUNDRY_${stage.toUpperCase()}_MODEL`]?.trim()
    || '';
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

function wiringFields(value: unknown): { from: string | null; requires: string | null; to: string | null } {
  if (!isRecord(value)) return { from: null, requires: null, to: null };
  return {
    from: nonEmptyString(value.from),
    requires: nonEmptyString(value.requires),
    to: nonEmptyString(value.to),
  };
}

function normalizeBlueprint(input: unknown): Blueprint | null {
  if (!isRecord(input)) return null;
  if (!Array.isArray(input.modules)) return null;
  return input as unknown as Blueprint;
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
    if (provider && !provides.some((p) => provideName(p) === w.requires)) {
      errors.push(`wiring ${w.from}:${w.requires} -> ${w.to} does not bind to a provide named '${w.requires}'`);
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
  if (doc?.status === 'running') return 'documenting';
  if (completeNode(doc)) return 'documented';
  if (test?.status === 'running') return 'testing';
  if (completeNode(test)) return 'tested';
  if (build?.status === 'running') return 'building';
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

function emitProject(action: 'created' | 'updated' | 'deleted', project: FoundryProjectRow, modules?: FoundryModuleRow[]): void {
  sseBus.emit('sse', { type: 'foundry_project', action, project: serializeFoundryProject(project, modules) });
}

function emitModule(action: 'created' | 'updated' | 'deleted', module: FoundryModuleRow): void {
  sseBus.emit('sse', { type: 'foundry_module', action, project_id: module.project_id, module: serializeFoundryModule(module) });
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

export function getProjectWithModules(id: string): { project: FoundryProjectResponse; modules: FoundryModuleResponse[] } | null {
  const row = getProjectStmt.get(id) ?? null;
  if (!row) return null;
  const modules = projectModulesStmt.all(id);
  return {
    project: serializeFoundryProject(row, modules),
    modules: modules.map(serializeFoundryModule),
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

export function setBlueprint(id: string, blueprintInput: unknown): { project: FoundryProjectResponse; modules: FoundryModuleResponse[] } {
  const project = getProjectStmt.get(id) ?? null;
  if (!project) throw new FoundryError(404, 'foundry_project_not_found', 'foundry project not found');
  if (project.status !== 'draft' && project.status !== 'planned') {
    throw new FoundryError(409, 'foundry_project_locked', 'blueprint can only be changed while project is draft or planned');
  }
  const validation = validateBlueprint(blueprintInput);
  if (!validation.ok) {
    throw new FoundryError(400, 'invalid_blueprint', 'blueprint is invalid', { errors: validation.errors });
  }
  const bp = blueprintInput as Blueprint;
  const tx = sqliteDb.transaction(() => {
    const info = setBlueprintStmt.run(JSON.stringify(bp), bp.run.command.trim(), id);
    if (info.changes !== 1) throw new FoundryError(409, 'foundry_project_locked', 'blueprint can only be changed while project is draft or planned');
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

export function markProjectPlanning(id: string, plannerModel?: string | null): FoundryProjectResponse | null {
  setPlanningStmt.run(plannerModel ?? null, id);
  const row = getProjectStmt.get(id) ?? null;
  if (row) emitProject('updated', row);
  return row ? serializeFoundryProject(row) : null;
}

export function markProjectPlannerFailed(id: string, message: string): FoundryProjectResponse | null {
  setPlannerFailedStmt.run(message.slice(0, 1000), id);
  const row = getProjectStmt.get(id) ?? null;
  if (row) emitProject('updated', row);
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

function projectBaseRef(project: FoundryProjectRow): string {
  return `origin/${project.base_branch}`;
}

function worktreePath(project: FoundryProjectRow, suffix: string): string {
  const root = process.env.FOUNDRY_WORKTREES ?? '/home/kevin/foundry-worktrees';
  return path.join(root, `${project.id}-${suffix}`);
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

export function composeStageSpec(stage: FoundryStageKey, module: FoundryModuleRow, project: FoundryProjectRow): string {
  const wt = worktreePath(project, module.key);
  const base = projectBaseRef(project);
  const allowContracts = module.kind === 'contracts'
    ? 'You may also write shared interface artifacts under contracts/.'
    : 'You may read contracts/ but do not edit it unless a failing test requires a tiny compatibility fix.';
  const common = [
    `Foundry project: ${project.name} (${project.id})`,
    `Original prompt: ${project.prompt}`,
    `Repository: ${project.repo_path}`,
    `Module branch: ${module.branch}`,
    `Module worktree: ${wt}`,
    '',
    'Module contract:',
    '```json',
    moduleDetails(project, module),
    '```',
    '',
    'GUARD:',
    '- Work only in the named module worktree. Never edit /home/kevin/paperclip/darwin-assistant or /home/kevin/paperclip/jarvis-command-center.',
    '- Do not touch production systems or production databases. No destructive git operations. No merges to main. No external sends.',
    '- NO API KEYS for model calls. If a model call is needed, use local subscription CLI binaries only.',
    `- Scope: edit only modules/${module.key}/. ${allowContracts}`,
    '- Commit your work before finishing. Push the module branch if the repository has a usable origin.',
    '',
    'Worktree setup:',
    '```bash',
    `mkdir -p ${JSON.stringify(path.dirname(wt))}`,
    `git -C ${JSON.stringify(project.repo_path)} fetch origin ${JSON.stringify(project.base_branch)} || true`,
    `git -C ${JSON.stringify(project.repo_path)} worktree add ${JSON.stringify(wt)} -b ${JSON.stringify(module.branch)} ${JSON.stringify(base)}`,
    '```',
    `If ${base} is unavailable because this is a local-only scaffold, use ${project.base_branch} as the base and report that push was skipped.`,
  ].join('\n');

  if (stage === 'build') {
    return [
      common,
      '',
      'STAGE 1 — BUILD',
      `Implement ONLY modules/${module.key}/ plus allowed contract files. Create the universal module deliverables: module.json, src/, tests/, and README.md.`,
      'Every provided interface needs at least one contract test. Run the module test command green.',
      'Finish done with commit sha, files changed, implemented provides, and exact test command/result. Finish split only if this module truly cannot fit one worker. Finish blocked_question for the one decision only Kevin can make.',
    ].join('\n');
  }

  if (stage === 'test') {
    return [
      common,
      '',
      'STAGE 2 — TEST',
      'You are the independent tester. Do not rely on the build worker reasoning; use the contract, acceptance criteria, and branch diff.',
      'Run the module tests. Add refutation/contract tests for each acceptance criterion where needed. Check Module Standard compliance: isolation, declared interfaces, four deliverables, docs present.',
      `Write modules/${module.key}/VERIFY.md with verdict, evidence per criterion, and limitations. Small fixes are allowed; structural problems should block with specifics.`,
      'Commit and push any test/fix/VERIFY.md changes. Finish done with the verdict summary and commands run.',
    ].join('\n');
  }

  return [
    common,
    '',
    'STAGE 3 — DOC',
    `Fill modules/${module.key}/README.md from what actually exists in the diff, module.json, tests, and VERIFY.md evidence.`,
    'Sections: What it does, Interface, How to run, How to test, Evidence, Limitations, Depends on.',
    'Commit and push the docs. Finish done with the docs commit sha and anything intentionally left undocumented.',
  ].join('\n');
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
      spec: composeStageSpec('build', module, project),
      priority: 30,
      adapter: build.adapter,
      model: build.model,
    },
    {
      title: `TEST ${module.key}`,
      spec: composeStageSpec('test', module, project),
      depends_on_indexes: [0],
      priority: 20,
      adapter: test.adapter,
      model: test.model,
    },
    {
      title: `DOC ${module.key}`,
      spec: composeStageSpec('doc', module, project),
      depends_on_indexes: [1],
      priority: 10,
      adapter: doc.adapter,
      model: doc.model,
    },
  ];
  const created = createHopperTree(`foundry:${project.id}/${module.key}`, project.origin_thread_ext ?? null, nodeInputs);
  agreeHopperTree(created.tree.id);
  const stageNodes = {
    build: created.nodes[0]?.id ?? null,
    test: created.nodes[1]?.id ?? null,
    doc: created.nodes[2]?.id ?? null,
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
  return { tree: created.tree, nodes: created.nodes, module: updated };
}

function recomputeProjectStatus(projectId: string): FoundryProjectRow | null {
  const project = getProjectStmt.get(projectId) ?? null;
  if (!project || project.status === 'launched' || project.status === 'planning') return project;
  const modules = projectModulesStmt.all(projectId);
  let next: FoundryProjectStatus = project.blueprint ? 'planned' : 'draft';
  if (modules.some((module) => module.stage === 'blocked' || module.stage === 'needs_answer')) {
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

function composeIntegrationSpec(stage: 'merge' | 'review' | 'docs', project: FoundryProjectRow, modules: FoundryModuleRow[]): string {
  const bp = loadBlueprint(project);
  const branch = `foundry/${project.id}/integration`;
  const wt = worktreePath(project, 'integration');
  const branches = modules.map((module) => module.branch);
  const common = [
    `Foundry integration for ${project.name} (${project.id})`,
    `Original prompt: ${project.prompt}`,
    `Repository: ${project.repo_path}`,
    `Integration branch: ${branch}`,
    `Integration worktree: ${wt}`,
    '',
    'Blueprint:',
    '```json',
    JSON.stringify(bp, null, 2),
    '```',
    '',
    'Module branches:',
    ...branches.map((moduleBranch) => `- ${moduleBranch}`),
    '',
    'GUARD: no production systems/databases, no API keys for model calls, no merges to main, no external sends. Work only in the integration branch/worktree and commit before finishing.',
  ].join('\n');
  if (stage === 'merge') {
    return [
      common,
      '',
      'INTEGRATION STAGE 1 — MERGE AND WIRE',
      `Create branch ${branch} off ${projectBaseRef(project)} in the integration worktree. Merge every module branch listed above.`,
      'Apply blueprint wiring only where needed: env examples, imports, compose files, or adapters that let the modules run together.',
      `Run the integration command: ${bp?.integration?.test ?? '(missing integration.test)'}.`,
      'Finish done with merge commit sha, integration command/result, and any wiring files changed. Block with concrete conflicts or failed integration evidence.',
    ].join('\n');
  }
  if (stage === 'review') {
    return [
      common,
      '',
      'INTEGRATION STAGE 2 — ADVERSARIAL REVIEW',
      'Review the integrated whole against the original prompt, every module acceptance list, the declared contracts, and the integration test evidence.',
      'Try to refute the claim that this project is ready. Do not make broad rewrites; small verification fixes are acceptable if obvious.',
      'Finish done with a verdict, risks, and exact evidence reviewed. Block if a correctness or integration issue must be fixed first.',
    ].join('\n');
  }
  return [
    common,
    '',
    'INTEGRATION STAGE 3 — PROJECT DOCS',
    'Write or update project README.md and ARCHITECTURE.md from foundry.json plus the module READMEs/VERIFY files.',
    'Document module map, wiring, run command, integration command, and known limits. Commit and push.',
    'Finish done with docs commit sha and doc files touched.',
  ].join('\n');
}

function maybePlantIntegrationTree(projectId: string): HopperTreeRow | null {
  const project = getProjectStmt.get(projectId) ?? null;
  if (!project || project.status === 'launched' || project.integration_tree_id) return null;
  const modules = projectModulesStmt.all(projectId).map((module) => refreshModuleStage(project, module).module);
  if (!modules.length || !modules.every((module) => stageAtLeast(module.stage, 'documented'))) return null;

  const merge = { adapter: 'codex', model: 'gpt-5.5' };
  const review = { adapter: 'claude', model: 'claude-opus-5' };
  const docs = { adapter: 'codex', model: 'gpt-5.5' };
  const created = createHopperTree(`foundry:${project.id}/integration`, project.origin_thread_ext ?? null, [
    {
      title: `MERGE ${project.id}`,
      spec: composeIntegrationSpec('merge', project, modules),
      priority: 30,
      adapter: merge.adapter,
      model: merge.model,
    },
    {
      title: `REVIEW ${project.id}`,
      spec: composeIntegrationSpec('review', project, modules),
      depends_on_indexes: [0],
      priority: 20,
      adapter: review.adapter,
      model: review.model,
    },
    {
      title: `DOCS ${project.id}`,
      spec: composeIntegrationSpec('docs', project, modules),
      depends_on_indexes: [1],
      priority: 10,
      adapter: docs.adapter,
      model: docs.model,
    },
  ]);
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
  setProjectStatusStmt.run('building', id);
  maybePlantReadyModules(id);
  maybePlantIntegrationTree(id);
  const result = getProjectWithModules(id);
  if (!result) throw new FoundryError(404, 'foundry_project_not_found', 'foundry project not found');
  emitProject('updated', getProjectStmt.get(id)!, projectModulesStmt.all(id));
  return result;
}

function handleIntegrationTreeEvent(project: FoundryProjectRow, node: HopperNodeRow): void {
  const nodes = listTreeNodes(project.integration_tree_id ?? node.tree_id);
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

  const wasReady = project.status === 'ready';
  for (const module of projectModulesStmt.all(project.id)) {
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
    const refreshed = refreshModuleStage(project, module);
    recomputeProjectStatus(project.id);
    if (refreshed.stageChanged && (refreshed.module.stage === 'tested' || refreshed.module.stage === 'documented')) {
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
  sseBus.on('sse', handleFoundrySse);
  console.log('[foundry] lifecycle listener started');
}

export function goProject(id: string): { project: FoundryProjectResponse; launched: true; preview_url: string | null } {
  const project = getProjectStmt.get(id) ?? null;
  if (!project) throw new FoundryError(404, 'foundry_project_not_found', 'foundry project not found');
  if (project.status !== 'ready') throw new FoundryError(409, 'foundry_project_not_ready', 'project must be ready before GO');
  const blueprint = loadBlueprint(project);
  const runCommand = project.run_command?.trim() || blueprint?.run?.command?.trim() || '';
  if (!runCommand) throw new FoundryError(400, 'foundry_missing_run_command', 'project has no run.command');
  const logDir = path.join(project.repo_path, '.foundry');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'run.log');
  const childEnv = { ...process.env };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.OPENAI_API_KEY;
  try {
    const out = fs.openSync(logPath, 'a');
    try {
      const child = spawn(runCommand, {
        cwd: project.repo_path,
        shell: true,
        detached: true,
        stdio: ['ignore', out, out],
        env: childEnv,
      });
      child.unref();
    } finally {
      fs.closeSync(out);
    }
  } catch (err) {
    throw new FoundryError(500, 'foundry_go_failed', err instanceof Error ? err.message : String(err));
  }
  const previewUrl = blueprint?.run?.preview_url?.trim() || null;
  setProjectLaunchedStmt.run(previewUrl, id);
  const launched = getProjectStmt.get(id);
  if (!launched) throw new FoundryError(404, 'foundry_project_not_found', 'foundry project not found');
  if (previewUrl && launched.origin_thread_ext) {
    const conversation = getOrCreateConversation(launched.origin_thread_ext);
    setPreviewLink(conversation.id, previewUrl, launched.name);
  }
  emitProject('updated', launched, projectModulesStmt.all(id));
  return { project: serializeFoundryProject(launched, projectModulesStmt.all(id)), launched: true, preview_url: previewUrl };
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

export function isProjectStatus(value: string): value is FoundryProjectStatus {
  return PROJECT_STATUSES.includes(value as FoundryProjectStatus);
}

export function isModuleStage(value: string): value is FoundryModuleStage {
  return MODULE_STAGES.includes(value as FoundryModuleStage);
}
