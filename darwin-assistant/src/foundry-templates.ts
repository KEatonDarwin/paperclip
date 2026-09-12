import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_SKILL_DIR = '/home/kevin/obsidian/paperclip-wiki/skills/foundry';

const FALLBACK_TEMPLATES: Record<string, string> = {
  build: `# FOUNDRY BUILD - {{project}} / {{key}}

Build one module: {{name}} ({{kind}}).
Purpose: {{purpose}}

GUARD:
- Work only in the module worktree. Never edit live JARVIS/cockpit trees.
- No production systems, no destructive git, no merges to main, no external sends.
- No API keys for model calls.
- Touch only modules/{{key}}/{{#if kind==contracts}} and contracts/{{/if}}.

Worktree:
git -C {{repo}} worktree add {{worktrees}}/{{project}}-{{key}} -b foundry/{{project}}/{{key}} {{base_ref}}
cd {{worktrees}}/{{project}}-{{key}}

Provides:
{{provides}}

Requires:
{{requires}}

Acceptance:
{{acceptance}}

Contract Resolution Rule:
- The contracts module is authoritative. If there is no contracts module, the blueprint declared provides/requires are authoritative.
- The deviating module conforms to the contract. Tests that contradict the contract are corrected, never the contract.
- Every resolution is appended to DECISIONS.md with the date, module, conflict, and rule applied.
- blocked_question is reserved only when the contract is silent AND the choice changes user-visible behavior with no sane default.
- Interface/shape/error-code/naming/test-vs-contract conflicts resolve toward the contract + DECISIONS.md, never a question for Kevin.

Create module.json, src/, tests/, and README.md. Run the module test command green.
Finish by POSTing to hopper node {{node_id}} with one outcome:
- done: commit sha, files, provides implemented, and test result.
- split: only if it genuinely needs more than one worker.
- blocked_question: ONLY when the contract is silent AND the choice changes user-visible behavior with no sane default.
- blocked: missing access or a broken dependency, stated precisely.
`,
  test: `# FOUNDRY TEST - {{project}} / {{key}}

Independently verify {{name}}. Do not read the build worker thread.

GUARD:
- Work only in {{worktrees}}/{{project}}-{{key}} on foundry/{{project}}/{{key}}.
- No production systems, no API keys, no merges to main.

Provides:
{{provides}}

Requires:
{{requires}}

Acceptance:
{{acceptance}}

Contract Resolution Rule:
- The contracts module is authoritative. If there is no contracts module, the blueprint declared provides/requires are authoritative.
- The deviating module conforms to the contract. Tests that contradict the contract are corrected, never the contract.
- Every resolution is appended to DECISIONS.md with the date, module, conflict, and rule applied.
- blocked_question is reserved only when the contract is silent AND the choice changes user-visible behavior with no sane default.
- Interface/shape/error-code/naming/test-vs-contract conflicts resolve toward the contract + DECISIONS.md, never a question for Kevin.

Run commands.test, add/refine tests that try to refute the acceptance criteria, run:
node {{skill_dir}}/templates/foundry-validate.mjs --module modules/{{key}}
Write modules/{{key}}/VERIFY.md, commit, and push.
Finish by POSTing to hopper node {{node_id}} with one outcome:
- done: verdict and evidence.
- blocked: missing/impossible contract, missing access, or broken dependency.
- blocked_question: ONLY when the contract is silent AND the choice changes user-visible behavior with no sane default.
`,
  doc: `# FOUNDRY DOC - {{project}} / {{key}}

Document {{name}} from real artifacts: module.json, tests, diff, and VERIFY.md.

GUARD:
- Touch only modules/{{key}}/README.md.
- No production systems, no API keys, no merges to main.

Worktree:
cd {{worktrees}}/{{project}}-{{key}}

Fill What it does, Interface, How to run, How to test, Evidence, Limitations, and Depends on.
Commit and push. Finish by POSTing to hopper node {{node_id}} with the docs commit sha.
`,
  'integrate-merge': `# FOUNDRY INTEGRATE MERGE - {{project}}

Create foundry/{{project}}/integration from {{base_ref}}, merge {{remote_prefix}}foundry/{{project}}/<key> branches, apply wiring, and run {{integration_test}}.

Repository: {{repo}}
Worktree: {{worktrees}}/{{project}}-integration

Modules:
{{modules}}

Wiring:
{{wiring}}

GUARD: no production systems, no API keys, no merges to main, no external sends.

Contract Resolution Rule:
- The contracts module is authoritative. If there is no contracts module, the blueprint declared provides/requires are authoritative.
- The deviating module conforms to the contract. Tests that contradict the contract are corrected, never the contract.
- Every resolution is appended to DECISIONS.md with the date, module/integration node, conflict, and rule applied.
- blocked_question is reserved only when the contract is silent AND the choice changes user-visible behavior with no sane default.
- Interface/shape/error-code/naming/test-vs-contract conflicts resolve toward the contract + DECISIONS.md, never a question for Kevin.

Finish by POSTing to hopper node {{node_id}} with one outcome:
- done: integration commit sha and green test evidence.
- blocked: missing/impossible contract, missing access, or broken dependency.
- blocked_question: ONLY when the contract is silent AND the choice changes user-visible behavior with no sane default.
`,
  'integrate-review': `# FOUNDRY INTEGRATE REVIEW - {{project}}

Adversarially review the integrated whole against the original prompt:
{{prompt}}

Worktree: {{worktrees}}/{{project}}-integration
Integration test: {{integration_test}}

Modules:
{{modules}}

Acceptance:
{{acceptance_all}}

GUARD: review only; no production systems, no API keys, no merges to main.
Finish by POSTing to hopper node {{node_id}} with verdict, seams tested, and risks.
`,
  'integrate-docs': `# FOUNDRY INTEGRATE DOCS - {{project}}

Write root README.md and ARCHITECTURE.md from foundry.json and module READMEs.

Original prompt:
{{prompt}}

Worktree:
cd {{worktrees}}/{{project}}-integration
for m in {{modules}}; do cat modules/$m/README.md; done

GUARD: touch only README.md and ARCHITECTURE.md. No production systems, no API keys, no merges to main.
Finish by POSTing to hopper node {{node_id}} with the docs commit sha.
`,
};

export function getFoundrySkillDir(): string {
  return process.env.FOUNDRY_SKILL_DIR?.trim() || DEFAULT_SKILL_DIR;
}

function normalizeTemplateName(name: string): string {
  return name.trim().replace(/\.md$/i, '');
}

function stringifyValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

function loadTemplate(name: string): string {
  const normalized = normalizeTemplateName(name);
  const filePath = path.join(getFoundrySkillDir(), 'templates', `${normalized}.md`);
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    const fallback = FALLBACK_TEMPLATES[normalized];
    if (fallback != null) return fallback;
    throw new Error(`Foundry template '${normalized}' could not be loaded from ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function renderTemplate(name: string, vars: Record<string, unknown>): string {
  const normalized = normalizeTemplateName(name);
  const rendered = loadTemplate(normalized).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (placeholder, keyRaw: string) => {
    const key = keyRaw.trim();
    if (Object.prototype.hasOwnProperty.call(vars, key)) return stringifyValue(vars[key]);
    console.warn(`[foundry-template] unknown placeholder ${placeholder} in ${normalized}`);
    return placeholder;
  });
  if (rendered.includes('{{')) {
    console.warn(`[foundry-template] leftover placeholder marker in ${normalized}`);
  }
  return rendered;
}
