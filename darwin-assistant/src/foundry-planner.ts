import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getProjectRow, markProjectPlannerFailed, setBlueprint, validateBlueprint } from './foundry.js';
import { getFoundryModelSetting } from './foundry-settings.js';
import { getFoundrySkillDir } from './foundry-templates.js';
import { createNotification } from './notifications.js';

const PLANNER_TIMEOUT_MS = 240 * 1000;
const MAX_CLAUDE_OUTPUT_BYTES = 16 * 1024 * 1024;
const CLAUDE_BIN = process.env.CLAUDE_CLI_PATH || process.env.UX_REVIEWER_CLAUDE_BIN || 'claude';

const PLANNER_PROMPT_FALLBACK = `# Foundry Planner Prompt

You are the Foundry planner. Emit one JSON object and nothing else.

Return this shape:
{
  "name": "<project-slug-kebab>",
  "prompt": "<the prompt, verbatim>",
  "modules": [
    {
      "key": "<kebab>",
      "name": "<human name>",
      "kind": "service|library|ui|job|data|contracts",
      "purpose": "<1-2 sentences>",
      "provides": [{ "type": "http|fn|event|cli|data|ui", "name": "...", "summary": "...", "schema": "contracts/..." }],
      "requires": [{ "module": "<key>", "interface": "<fn:name|http:...>" }],
      "acceptance": ["<checkable by script or curl>"],
      "depends_on": ["<key>"]
    }
  ],
  "wiring": [{ "from": "<key>", "requires": "<interface>", "to": "<key>" }],
  "integration": { "test": "<real command>", "docs": "README.md" },
  "run": { "command": "<real command>", "preview_url": "" },
  "assumptions": ["<explicit assumption>"]
}

Rules:
- Prefer 3-9 modules, each buildable by one worker in a 30-minute lease.
- If modules share schemas/types, create a contracts module first.
- Acceptance criteria must be checkable by script or curl.
- depends_on is build-order only; interface callers can build in parallel from contracts.
- No dependency cycles.
- Every requires entry must have exactly one wiring row to the module that provides it.
- Prefer boring, portable stacks unless the prompt says otherwise.
`;

function readPlannerPromptTemplate(): string {
  const filePath = path.join(getFoundrySkillDir(), 'templates', 'planner-prompt.md');
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return PLANNER_PROMPT_FALLBACK;
  }
}

function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function dependencyKeys(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}

function summarizePackageJson(repoPath: string): string | null {
  const json = safeReadJson(path.join(repoPath, 'package.json'));
  if (!json) return null;
  const deps = [
    ...dependencyKeys(json.dependencies),
    ...dependencyKeys(json.devDependencies).map((name) => `${name} (dev)`),
  ];
  return [
    'package.json:',
    `  name: ${typeof json.name === 'string' && json.name.trim() ? json.name.trim() : '(none)'}`,
    `  dependencies: ${deps.length ? deps.join(', ') : '(none)'}`,
  ].join('\n');
}

function summarizeComposerJson(repoPath: string): string | null {
  const json = safeReadJson(path.join(repoPath, 'composer.json'));
  if (!json) return null;
  const deps = [
    ...dependencyKeys(json.require),
    ...dependencyKeys(json['require-dev']).map((name) => `${name} (dev)`),
  ];
  return [
    'composer.json:',
    `  name: ${typeof json.name === 'string' && json.name.trim() ? json.name.trim() : '(none)'}`,
    `  dependencies: ${deps.length ? deps.join(', ') : '(none)'}`,
  ].join('\n');
}

function summarizePyproject(repoPath: string): string | null {
  const filePath = path.join(repoPath, 'pyproject.toml');
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const name = raw.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1] ?? '(none)';
  const deps = new Set<string>();
  const arrayBlock = raw.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)^\s*\]/m);
  if (arrayBlock) {
    for (const match of arrayBlock[1].matchAll(/["']([^"']+)["']/g)) deps.add(match[1]);
  }
  const poetryBlock = raw.match(/^\[tool\.poetry\.dependencies\]([\s\S]*?)(?:^\[|$)/m);
  if (poetryBlock) {
    for (const match of poetryBlock[1].matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gm)) {
      if (match[1] !== 'python') deps.add(match[1]);
    }
  }
  return [
    'pyproject.toml:',
    `  name: ${name}`,
    `  dependencies: ${deps.size ? [...deps].sort().join(', ') : '(none)'}`,
  ].join('\n');
}

function repoSnapshot(repoPath: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(repoPath);
  } catch {
    return '';
  }
  if (!stat.isDirectory()) return '';

  const entries = fs.readdirSync(repoPath, { withFileTypes: true })
    .map((entry) => `${entry.isDirectory() ? 'dir ' : 'file'} ${entry.name}`)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 80);

  const manifests = [
    summarizePackageJson(repoPath),
    summarizeComposerJson(repoPath),
    summarizePyproject(repoPath),
  ].filter((item): item is string => !!item);

  return [
    '=== REPO SNAPSHOT ===',
    `path: ${repoPath}`,
    'top-level ls:',
    ...(entries.length ? entries.map((entry) => `- ${entry}`) : ['- (empty)']),
    '',
    ...(manifests.length ? manifests : ['No package.json, composer.json, or pyproject.toml found at repo root.']),
    '=== END REPO SNAPSHOT ===',
  ].join('\n');
}

function buildPlannerPrompt(args: {
  template: string;
  project: ReturnType<typeof getProjectRow>;
  snapshot: string;
}): string {
  if (!args.project) throw new Error('project not found');
  return [
    args.template,
    '',
    '=== FOUNDRY PROJECT ===',
    `Project id: ${args.project.id}`,
    `Project name: ${args.project.name}`,
    `Base branch: ${args.project.base_branch}`,
    `Repo path: ${args.project.repo_path}`,
    '',
    'Original prompt, verbatim:',
    args.project.prompt,
    '=== END FOUNDRY PROJECT ===',
    '',
    args.snapshot,
    '',
    'Return ONLY the JSON object. Do not include markdown fences unless unavoidable.',
  ].filter(Boolean).join('\n');
}

function runClaudePlanner(prompt: string, model: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const child = spawn(
      CLAUDE_BIN,
      ['--print', '-', '--output-format', 'json', '--model', model],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;

    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      fail(`claude planner timed out after ${PLANNER_TIMEOUT_MS}ms`);
    }, PLANNER_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_CLAUDE_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        fail('claude planner output exceeded 16MB');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      fail(`claude planner failed to start: ${err.message}`);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`claude planner exited ${code}: ${stderr.trim().slice(0, 1000) || '(no stderr)'}`));
        return;
      }
      let envelope: { result?: unknown };
      try {
        envelope = JSON.parse(stdout.trim()) as { result?: unknown };
      } catch {
        reject(new Error('claude planner did not return a JSON envelope'));
        return;
      }
      if (typeof envelope.result !== 'string') {
        reject(new Error('claude planner envelope did not contain a string result'));
        return;
      }
      resolve(envelope.result);
    });

    child.stdin.end(prompt);
  });
}

function stripCodeFences(raw: string): string {
  let text = raw.trim();
  const fullFence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fullFence) return fullFence[1].trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '');
    text = text.replace(/\s*```$/i, '');
  }
  return text.trim();
}

function failureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function notifyPlannerFailure(id: string, name: string, message: string): void {
  createNotification({
    severity: 'warning',
    title: `Foundry planner failed: ${name}`,
    body: message.slice(0, 1000),
    source: 'foundry',
    link: `/foundry?project=${encodeURIComponent(id)}`,
  });
}

/** Runs the one-shot planner for a project the caller has ALREADY moved to
 *  'planning' via markProjectPlanning (single-flight guard lives there). */
export async function planProject(id: string, modelArg?: string | null): Promise<void> {
  const project = getProjectRow(id);
  if (!project) throw new Error(`Foundry project '${id}' not found`);
  if (project.status !== 'planning') throw new Error(`Foundry project '${id}' is not in planning state (${project.status})`);
  const model = modelArg?.trim() || project.planner_model?.trim() || getFoundryModelSetting('planner', 'claude-opus-5');

  try {
    const prompt = buildPlannerPrompt({
      template: readPlannerPromptTemplate(),
      project,
      snapshot: repoSnapshot(project.repo_path),
    });
    const raw = await runClaudePlanner(prompt, model);
    const parsed = JSON.parse(stripCodeFences(raw)) as unknown;
    const validation = validateBlueprint(parsed);
    if (!validation.ok) throw new Error(`planner returned an invalid blueprint: ${validation.errors.join('; ')}`);
    setBlueprint(id, parsed, { onlyWhilePlanning: true });
  } catch (err) {
    const message = failureMessage(err);
    markProjectPlannerFailed(id, message);
    notifyPlannerFailure(id, project.name, message);
  }
}
