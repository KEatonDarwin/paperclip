import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sqliteDb } from './conversation-db.js';
import { getHopperNode, type HopperNodeStatus } from './hopper-engine.js';
import { sseBus } from './sse-bus.js';

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

for (const col of ['last_error TEXT']) {
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
const insertProjectStmt = sqliteDb.prepare<[string, string, string, string, string]>(`
  INSERT INTO foundry_projects (id, name, prompt, repo_path, base_branch)
  VALUES (?, ?, ?, ?, ?)
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
  insertProjectStmt.run(id, name, prompt, repoPath, baseBranch);
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

export function isProjectStatus(value: string): value is FoundryProjectStatus {
  return PROJECT_STATUSES.includes(value as FoundryProjectStatus);
}

export function isModuleStage(value: string): value is FoundryModuleStage {
  return MODULE_STAGES.includes(value as FoundryModuleStage);
}
