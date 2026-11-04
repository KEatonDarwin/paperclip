// GOALS AUTOPILOT — the REVIEW GATE (CONTRACT.md §15.3, tree-a2a9e6b2 node #538;
// split into four nodes by GOAL #18 node #400 / tree-8ef5a09f).
//
// Every autopilot plan gets a FOUR-node review gate appended by the server,
// instead of the single verifier it used to be:
//   1. REVIEW (opus)  — on `config.verify_model`, reviews the build diff
//      base..HEAD ONLY (read-only, no test suite), writes a findings file.
//   2. REVIEW (codex) — on the codex tier, same read-only diff review, writes
//      its own findings file. Nodes 1 and 2 run in PARALLEL (no dep between
//      them); both depend on every build node.
//   3. FIX            — depends on BOTH reviews; applies the real findings from
//      both on the SAME build branch. A review never fixes — the fix is its own
//      node (a tester that patches is a builder).
//   4. VERIFY (recheck + merge) — depends on the fix; re-checks the flagged
//      items ("both reviews must pass"), independently confirms the done_means,
//      finalises, and finishes with a result whose FIRST line is
//      `VERDICT: PASS|FAIL` (parsed by src/goals-autopilot.ts). This terminal
//      node is the verifier of record: `plan.verify_index`/`verify_hopper_node_id`
//      point at it, and its title stays `VERIFY: …` so `planNamesOwnVerifier`
//      keeps recognising the gate.
//
// The terminal (recheck+merge) template text lives in the wiki
// (skills/goals/templates/autopilot-verify.md, `{{…}}` substituted here); the
// embedded copy below is the byte-identical fallback so a scratch machine /
// missing vault still plants a correct verifier. The two review templates and
// the fix template are embedded constants (they emit findings/fixes, not a
// VERDICT, so they are not wiki-loadable). `{{tree_id}}` is NOT known until the
// tree is planted — approvePlan substitutes it on EVERY review-gate node's spec
// right after createHopperTree.

import fs from 'node:fs';
import path from 'node:path';
import type { GoalRow, GoalNodeDbRow, PlanJson, PlanJsonNode, AutopilotConfig } from './goals.js';

export const VAULT_ROOT = process.env.GOALS_VAULT_ROOT?.trim() || '/home/kevin/obsidian/paperclip-wiki';
export const VERIFY_TEMPLATE_REL = 'skills/goals/templates/autopilot-verify.md';

// The codex tier for the parallel read-only review (node 2). Matches the hopper
// engine's default codex worker model (src/hopper-engine.ts). Runs on Kevin's
// ChatGPT/Codex login via the `codex` CLI — NO API KEY (codex-catalog.ts).
export const REVIEW_CODEX_MODEL = process.env.GOALS_REVIEW_CODEX_MODEL?.trim() || 'gpt-5.6-sol';

// Shared, tree-scoped findings directory. Both reviews write here; the fix and
// the recheck read from here. `{{tree_id}}` is substituted at plant time by
// approvePlan (same mechanism as the verifier spec), so all four nodes resolve
// to the same real directory even though each runs in its own worktree.
export const REVIEW_FINDINGS_ROOT =
  process.env.GOALS_REVIEW_FINDINGS_ROOT?.trim() || '/home/kevin/.jarvis-review-findings';
const FINDINGS_DIR = `${REVIEW_FINDINGS_ROOT}/{{tree_id}}`;
const FINDINGS_OPUS = `${FINDINGS_DIR}/review-opus.md`;
const FINDINGS_CODEX = `${FINDINGS_DIR}/review-codex.md`;

// Node 1 & 2 — the two read-only reviews. One template, rendered twice with
// `{{reviewer}}` = opus | codex and `{{findings_file}}` = that reviewer's file.
export const REVIEW_TEMPLATE_FALLBACK = `You are a REVIEWER ({{reviewer}}) for one goal node's build. You REVIEW ONLY — you never fix, never edit, never commit, and you NEVER run a test suite (reviews are read-only + diff-read; if a test would be needed to be sure, record that as a gap). There is nobody awake to ask — never end on a question.

Goal: {{goal.title}} — done means: {{goal.done_means}}
Node #{{node.id}}: {{node.title}}
DONE MEANS (the win condition, verbatim): {{node.done_means}}
Notes / instructions the builders were given: {{node.notes}}
Plan: {{plan.what}} — deliverable: {{plan.deliverable}}
Build nodes in this tree (read each one's \`result\` + the branch/worktree it names via GET /hopper-trees/{{tree_id}} or the tree overlay; they finished before you started):
{{#each build_nodes}}- #{{index}} {{title}}
{{/each}}

Do this, in order — HARD ~8 MINUTE CAP (if you approach it, write what you have and stop):
1. From the build results, find the shared build branch + its base. Review ONLY the diff base..HEAD — \`git -C <worktree> diff <base>..HEAD\` and \`git -C <worktree> log --stat <base>..HEAD\`, then read the changed files. Do NOT review the whole repo and do NOT run any test suite.
2. Check the diff against the DONE MEANS, and for correctness/safety defects a merge would regret.
3. Write your findings to \`{{findings_file}}\` (\`mkdir -p\` its directory first). One finding per bullet line: \`- <file>:<line> — <problem> — <concrete fix>\`. If the diff fully meets the done_means and is safe to merge, write exactly \`- none\`.
4. NEVER edit, commit, or fix anything. Finish with outcome \`done\` and a \`result\` = a 2-3 line summary plus the path \`{{findings_file}}\`.`;

// Node 3 — the single fix, depends on BOTH reviews.
export const FIX_TEMPLATE_FALLBACK = `You are the FIX node for one goal node's build. Two reviewers (opus and codex) reviewed the build diff and wrote findings files; apply the real fixes so BOTH reviews are satisfied. You never run a test suite and you never merge.

Goal: {{goal.title}} — done means: {{goal.done_means}}
Node #{{node.id}}: {{node.title}}
DONE MEANS (verbatim): {{node.done_means}}
Build tree: {{tree_id}} (read the build nodes' \`result\`/specs for the shared branch + worktree via GET /hopper-trees/{{tree_id}}).

Do this, in order:
1. Read BOTH findings files: \`${FINDINGS_OPUS}\` and \`${FINDINGS_CODEX}\`.
2. If BOTH say \`- none\`, change nothing — record "no fixes needed — both reviews clean" and stop.
3. Otherwise, on the SAME build branch + worktree the build nodes used (name it from their specs — do NOT cut a new branch), fix every REAL finding from BOTH reviews. Verify each with \`php -l\` / \`node --check\` / \`npm run build\` / reading — NEVER a test suite (if a finding genuinely needs a test run, leave it and say so). If a finding is a false positive, say why instead of changing code.
4. Commit the fixes on that branch. Finish with outcome \`done\` and a \`result\` that lists what you changed per finding (or "no fixes needed — both reviews clean"). NEVER merge. If a finding can only be resolved by Kevin, finish \`blocked_question\`.`;

// Node 4 — the terminal recheck + merge (the verifier of record). Wiki-overridable.
export const VERIFY_TEMPLATE_FALLBACK = `You are the VERIFIER of record (recheck + merge) for one goal node. The two reviews (opus ∥ codex) and the fix have already run; you confirm BOTH reviews are satisfied, confirm the done_means, and finalise. You test by reading/inspecting — you NEVER run a test suite, you never write new features, and a tester that patches is a builder: if something is still wrong, say so precisely and stop.

Goal: {{goal.title}} — done means: {{goal.done_means}}
Node #{{node.id}}: {{node.title}}
DONE MEANS (the win condition you are checking, verbatim): {{node.done_means}}
Notes / instructions the builders were given: {{node.notes}}
Plan: {{plan.what}} — deliverable: {{plan.deliverable}}
Build nodes in this tree (read each one's \`result\` via GET /hopper-trees/{{tree_id}} or the tree overlay; they finished before you started):
{{#each build_nodes}}- #{{index}} {{title}}
{{/each}}

Do this, in order:
1. Read BOTH review findings files — \`${FINDINGS_OPUS}\` and \`${FINDINGS_CODEX}\` — and the FIX node's \`result\`.
2. Re-check ONLY the items the two reviews flagged: confirm each real finding was fixed (read the code / \`php -l\` / \`node --check\` / \`npm run build\` / \`git diff\` — NEVER a test suite). BOTH reviews must be satisfied: any real finding left unaddressed is a gap.
3. Independently confirm the DONE MEANS is met over the final diff — go look, do not trust a "done".
4. Finalise (merge) the review gate: confirm the build branch is in its intended final state. If the plan carries an integration/merge-back block, confirm that merge landed. Do NOT merge anything into \`main\` and do NOT run a test suite. If step 2 or 3 fails, do not finalise.
5. NEVER edit, commit, or "quick fix" anything. NEVER ask a question — there is nobody awake. If you cannot check something, that is a gap.

PROVENANCE GATE (hard check — a test edited to go green without a review is a FAIL): the test gate around this build is TEST → FIX → TEST_REVIEW → TEST. FIX edits ONLY production code and never a test; the TEST_REVIEW node (a second opinion on a different model) is the ONLY node allowed to change a test file, and only when its result first line is \`VERDICT: CONFIRMED\`, listing the test file(s) under \`test_files_changed:\`. List every TEST FILE changed in the final diff (\`git diff <base>..HEAD\` — spec/test/Test/__tests__/*.test.*/*_test.* and the repo's test dirs). For each, confirm a \`VERDICT: CONFIRMED\` TEST_REVIEW node in this tree names it (read that node's result via GET /hopper-trees/{{tree_id}} or the tree overlay). A test file changed with NO CONFIRMED TEST_REVIEW behind it → VERDICT: FAIL. A CONFIRMED test-only edit is in scope, not a gap.

Finish with outcome \`done\` and a \`result\` whose FIRST line is exactly \`VERDICT: PASS\` or \`VERDICT: FAIL\`, then:
evidence:
- <what you ran / looked at, and what it showed>
test_provenance:
- <each test file changed in the final diff → the CONFIRMED TEST_REVIEW authorising it, or \`UNAUTHORISED\` (which forces FAIL); write \`- none\` if no test file changed>
gaps:
- <one per line; write \`- none\` when PASS>
`;

// ── LIGHT review gate (small plans) ──────────────────────────────────────────
// For a SMALL planned node (plan-size verdict `big=false`) the server appends a
// THREE-node gate — ONE cross-vendor review (codex) → FIX → VERIFY — instead of
// the full REVIEW(opus) ∥ REVIEW(codex) → FIX → VERIFY. The cross-vendor review
// (codex vs the claude builder) and the opus verifier of record are KEPT; only
// the redundant same-vendor opus REVIEW node is dropped. These templates are the
// codex-only wording for FIX and VERIFY so they never reference a non-existent
// opus findings file. The full-gate templates above are untouched.
export const FIX_TEMPLATE_LIGHT = `You are the FIX node for one goal node's build. ONE cross-vendor reviewer (codex) reviewed the build diff and wrote a findings file; apply the real fixes so the review is satisfied. You never run a test suite and you never merge.

Goal: {{goal.title}} — done means: {{goal.done_means}}
Node #{{node.id}}: {{node.title}}
DONE MEANS (verbatim): {{node.done_means}}
Build tree: {{tree_id}} (read the build nodes' \`result\`/specs for the shared branch + worktree via GET /hopper-trees/{{tree_id}}).

Do this, in order:
1. Read the findings file: \`${FINDINGS_CODEX}\`.
2. If it says \`- none\`, change nothing — record "no fixes needed — review clean" and stop.
3. Otherwise, on the SAME build branch + worktree the build nodes used (name it from their specs — do NOT cut a new branch), fix every REAL finding. Verify each with \`php -l\` / \`node --check\` / \`npm run build\` / reading — NEVER a test suite (if a finding genuinely needs a test run, leave it and say so). If a finding is a false positive, say why instead of changing code.
4. Commit the fixes on that branch. Finish with outcome \`done\` and a \`result\` that lists what you changed per finding (or "no fixes needed — review clean"). NEVER merge. If a finding can only be resolved by Kevin, finish \`blocked_question\`.`;

export const VERIFY_TEMPLATE_LIGHT = `You are the VERIFIER of record (recheck + merge) for one goal node. ONE cross-vendor review (codex) and the fix have already run; you confirm the review is satisfied, confirm the done_means, and finalise. You test by reading/inspecting — you NEVER run a test suite, you never write new features, and a tester that patches is a builder: if something is still wrong, say so precisely and stop.

Goal: {{goal.title}} — done means: {{goal.done_means}}
Node #{{node.id}}: {{node.title}}
DONE MEANS (the win condition you are checking, verbatim): {{node.done_means}}
Notes / instructions the builders were given: {{node.notes}}
Plan: {{plan.what}} — deliverable: {{plan.deliverable}}
Build nodes in this tree (read each one's \`result\` via GET /hopper-trees/{{tree_id}} or the tree overlay; they finished before you started):
{{#each build_nodes}}- #{{index}} {{title}}
{{/each}}

Do this, in order:
1. Read the review findings file — \`${FINDINGS_CODEX}\` — and the FIX node's \`result\`.
2. Re-check ONLY the items the review flagged: confirm each real finding was fixed (read the code / \`php -l\` / \`node --check\` / \`npm run build\` / \`git diff\` — NEVER a test suite). Any real finding left unaddressed is a gap.
3. Independently confirm the DONE MEANS is met over the final diff — go look, do not trust a "done".
4. Finalise (merge) the review gate: confirm the build branch is in its intended final state. If the plan carries an integration/merge-back block, confirm that merge landed. Do NOT merge anything into \`main\` and do NOT run a test suite. If step 2 or 3 fails, do not finalise.
5. NEVER edit, commit, or "quick fix" anything. NEVER ask a question — there is nobody awake. If you cannot check something, that is a gap.

PROVENANCE GATE (hard check — a test edited to go green without a review is a FAIL): the test gate around this build is TEST → FIX → TEST_REVIEW → TEST. FIX edits ONLY production code and never a test; the TEST_REVIEW node (a second opinion on a different model) is the ONLY node allowed to change a test file, and only when its result first line is \`VERDICT: CONFIRMED\`, listing the test file(s) under \`test_files_changed:\`. List every TEST FILE changed in the final diff (\`git diff <base>..HEAD\` — spec/test/Test/__tests__/*.test.*/*_test.* and the repo's test dirs). For each, confirm a \`VERDICT: CONFIRMED\` TEST_REVIEW node in this tree names it (read that node's result via GET /hopper-trees/{{tree_id}} or the tree overlay). A test file changed with NO CONFIRMED TEST_REVIEW behind it → VERDICT: FAIL. A CONFIRMED test-only edit is in scope, not a gap.

Finish with outcome \`done\` and a \`result\` whose FIRST line is exactly \`VERDICT: PASS\` or \`VERDICT: FAIL\`, then:
evidence:
- <what you ran / looked at, and what it showed>
test_provenance:
- <each test file changed in the final diff → the CONFIRMED TEST_REVIEW authorising it, or \`UNAUTHORISED\` (which forces FAIL); write \`- none\` if no test file changed>
gaps:
- <one per line; write \`- none\` when PASS>
`;

let cachedTemplate: { text: string; mtimeMs: number } | null = null;

/** The terminal (recheck+merge) template text: the wiki file when readable
 *  (re-read when its mtime changes), else the embedded fallback. Never throws. */
export function loadVerifyTemplate(): string {
  const file = path.join(VAULT_ROOT, VERIFY_TEMPLATE_REL);
  try {
    const st = fs.statSync(file);
    if (cachedTemplate && cachedTemplate.mtimeMs === st.mtimeMs) return cachedTemplate.text;
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('VERDICT: PASS') && text.includes('{{node.done_means}}')) {
      cachedTemplate = { text, mtimeMs: st.mtimeMs };
      return text;
    }
  } catch {
    /* fall through to the embedded copy */
  }
  return VERIFY_TEMPLATE_FALLBACK;
}

export interface VerifyTemplateInput {
  goal: Pick<GoalRow, 'title' | 'done_means'>;
  node: Pick<GoalNodeDbRow, 'id' | 'title' | 'done_means' | 'notes'>;
  plan: Pick<PlanJson, 'what' | 'deliverable' | 'nodes'>;
  /** Left as the literal `{{tree_id}}` when omitted — approvePlan fills it in after planting. */
  tree_id?: string | null;
}

/** Pure: substitute `{{…}}` + the `{{#each build_nodes}}` block. `extra` carries
 *  per-node vars (e.g. `reviewer`, `findings_file`) for the review templates.
 *  Any `{{tree_id}}` inside an inserted value survives (String.replace does not
 *  rescan replacement text), so it stays literal for approvePlan. */
export function renderVerifyTemplate(
  template: string,
  input: VerifyTemplateInput,
  extra: Record<string, string> = {},
): string {
  const vars: Record<string, string> = {
    'goal.title': input.goal.title ?? '',
    'goal.done_means': input.goal.done_means ?? '(not set)',
    'node.id': String(input.node.id),
    'node.title': input.node.title ?? '',
    'node.done_means': input.node.done_means ?? '(not set)',
    'node.notes': input.node.notes?.trim() ? input.node.notes.trim() : '(none)',
    'plan.what': input.plan.what ?? '',
    'plan.deliverable': input.plan.deliverable ?? '',
    tree_id: input.tree_id ?? '{{tree_id}}',
    ...extra,
  };
  let out = template.replace(/\{\{#each build_nodes\}\}([\s\S]*?)\{\{\/each\}\}/g, (_m, block: string) =>
    input.plan.nodes
      .map((n, i) => block.replace(/\{\{index\}\}/g, String(i)).replace(/\{\{title\}\}/g, n.title))
      .join(''),
  );
  out = out.replace(/\{\{([a-z_.]+)\}\}/g, (m, key: string) => (key in vars ? vars[key] : m));
  return out;
}

/** Map an explicit autopilot model id to its worker adapter. Autopilot configs
 *  carry real model ids (e.g. `claude-opus-5`, `gpt-5.6-sol`), not ambiguous
 *  harness shelf names, so a direct substring map is safe here. Mirrors
 *  agent.ts `adapterFromModel`, kept local to this leaf module to avoid a
 *  goals↔agent import cycle (same reason throttle.ts keeps its own providerFor
 *  copy). Returns null for an unrecognized id so callers can reject it. */
export function workerAdapterForModel(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes('claude')) return 'claude';
  if (m.includes('gpt') || m.includes('codex') || m.includes('openai') || m.includes('o4')) return 'codex';
  if (m.includes('augment') || m.includes('auggie')) return 'auggie';
  return null;
}

/** The four PlanJsonNodes the server appends (§15.3 shape, split by #400):
 *  [0] REVIEW(opus) [1] REVIEW(codex) [2] FIX [3] VERIFY(recheck+merge).
 *  Indexes are relative to the appended block; the caller splices them after
 *  the build nodes and offsets the depends_on accordingly. Returned here with
 *  depends_on_indexes ALREADY in whole-plan coordinates (build nodes = 0..B-1).
 *  - REVIEW(opus) @ B      deps 0..B-1        (all build nodes)
 *  - REVIEW(codex) @ B+1   deps 0..B-1        (all build nodes; NOT opus — parallel)
 *  - FIX @ B+2             deps [B, B+1]       (BOTH reviews)
 *  - VERIFY @ B+3          deps [B+2]          (the fix) — the verifier of record
 */
export function buildReviewGateNodes(args: {
  goal: GoalRow;
  node: GoalNodeDbRow;
  plan: PlanJson;
  cfg: Pick<AutopilotConfig, 'build_model' | 'verify_model'>;
  /** LIGHT gate for a SMALL plan (plan-size `big=false`): drop the same-vendor
   *  REVIEW(opus) node and run ONE cross-vendor review (codex) → FIX → VERIFY.
   *  Keeps ≥1 cross-vendor review + the opus verifier of record. */
  light?: boolean;
}): PlanJsonNode[] {
  const { goal, node, plan, cfg, light } = args;
  const B = plan.nodes.length;
  const buildIdxs = plan.nodes.map((_n, i) => i); // 0..B-1
  const common = { goal, node, plan };
  const verifyAdapter = workerAdapterForModel(cfg.verify_model) ?? 'claude';
  const fixAdapter = workerAdapterForModel(cfg.build_model) ?? 'claude';

  if (light) {
    // 3-node gate: REVIEW(codex) @ B  →  FIX @ B+1  →  VERIFY @ B+2.
    const reviewCodexL: PlanJsonNode = {
      title: `REVIEW (codex): ${node.title}`.slice(0, 300),
      spec: renderVerifyTemplate(REVIEW_TEMPLATE_FALLBACK, common, { reviewer: 'codex', findings_file: FINDINGS_CODEX }),
      adapter: 'codex',
      model: REVIEW_CODEX_MODEL,
      depends_on_indexes: buildIdxs,
      priority: 0,
    };
    const fixL: PlanJsonNode = {
      title: `FIX review findings: ${node.title}`.slice(0, 300),
      spec: renderVerifyTemplate(FIX_TEMPLATE_LIGHT, common),
      adapter: fixAdapter,
      model: cfg.build_model,
      depends_on_indexes: [B], // the single review
      priority: 0,
    };
    const verifyL: PlanJsonNode = {
      title: `VERIFY: ${node.title}`.slice(0, 300),
      spec: renderVerifyTemplate(VERIFY_TEMPLATE_LIGHT, common),
      adapter: verifyAdapter,
      model: cfg.verify_model,
      depends_on_indexes: [B + 1], // the fix
      priority: 0,
    };
    return [reviewCodexL, fixL, verifyL];
  }

  const reviewOpus: PlanJsonNode = {
    title: `REVIEW (opus): ${node.title}`.slice(0, 300),
    spec: renderVerifyTemplate(REVIEW_TEMPLATE_FALLBACK, common, { reviewer: 'opus', findings_file: FINDINGS_OPUS }),
    adapter: verifyAdapter,
    model: cfg.verify_model,
    depends_on_indexes: buildIdxs,
    priority: 0,
  };
  const reviewCodex: PlanJsonNode = {
    title: `REVIEW (codex): ${node.title}`.slice(0, 300),
    spec: renderVerifyTemplate(REVIEW_TEMPLATE_FALLBACK, common, { reviewer: 'codex', findings_file: FINDINGS_CODEX }),
    adapter: 'codex',
    model: REVIEW_CODEX_MODEL,
    depends_on_indexes: buildIdxs, // parallel with opus — deliberately no dep on B
    priority: 0,
  };
  const fix: PlanJsonNode = {
    title: `FIX review findings: ${node.title}`.slice(0, 300),
    spec: renderVerifyTemplate(FIX_TEMPLATE_FALLBACK, common),
    adapter: fixAdapter,
    model: cfg.build_model,
    depends_on_indexes: [B, B + 1], // BOTH reviews
    priority: 0,
  };
  const verify: PlanJsonNode = {
    title: `VERIFY: ${node.title}`.slice(0, 300),
    spec: renderVerifyTemplate(loadVerifyTemplate(), common),
    adapter: verifyAdapter,
    model: cfg.verify_model,
    depends_on_indexes: [B + 2], // the fix
    priority: 0,
  };
  return [reviewOpus, reviewCodex, fix, verify];
}

/** The number of nodes the server appends as the review gate (used by callers
 *  to compute `verify_index` without hardcoding the shape). */
export const REVIEW_GATE_NODE_COUNT = 4;
