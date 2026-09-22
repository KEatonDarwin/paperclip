// GOALS AUTOPILOT — the VERIFY node (CONTRACT.md §15.3, tree-a2a9e6b2 node #538).
//
// Every autopilot plan gets ONE verifier appended by the server: a hopper node
// on `config.verify_model` that depends on every build node, reads the node's
// done_means verbatim + the builders' results, independently checks the win
// condition, and finishes with a result whose FIRST line is `VERDICT: PASS|FAIL`
// (parsed by src/goals-autopilot.ts). A tester that patches is a builder — the
// template forbids fixes.
//
// The template text lives in the wiki (skills/goals/templates/autopilot-verify.md,
// `{{…}}` substituted here); the embedded copy below is the byte-identical
// fallback so a scratch machine / missing vault still plants a correct verifier.
// `{{tree_id}}` is NOT known until the tree is planted — approvePlan substitutes
// it on the hopper node's spec right after createHopperTree.

import fs from 'node:fs';
import path from 'node:path';
import type { GoalRow, GoalNodeDbRow, PlanJson, PlanJsonNode } from './goals.js';

export const VAULT_ROOT = process.env.GOALS_VAULT_ROOT?.trim() || '/home/kevin/obsidian/paperclip-wiki';
export const VERIFY_TEMPLATE_REL = 'skills/goals/templates/autopilot-verify.md';

export const VERIFY_TEMPLATE_FALLBACK = `You are the VERIFIER for one goal node. You test; you never fix. A tester that patches is a builder — if the work is wrong, say so precisely and stop.

Goal: {{goal.title}} — done means: {{goal.done_means}}
Node #{{node.id}}: {{node.title}}
DONE MEANS (the win condition you are checking, verbatim): {{node.done_means}}
Notes / instructions the builders were given: {{node.notes}}
Plan: {{plan.what}} — deliverable: {{plan.deliverable}}
Build nodes in this tree (read each one's \`result\` via GET /hopper-trees/{{tree_id}} or the tree overlay; they finished before you started):
{{#each build_nodes}}- #{{index}} {{title}}
{{/each}}

Do this, in order:
1. Read the build results + the repo/branch/doc/endpoint they name. Do not trust a result that says "done" — go look.
2. Independently check the DONE MEANS. Run the tests, hit the endpoint, query the table, open the file — whatever a stranger would need to be convinced. Record commands + outputs as evidence.
3. If the DONE MEANS is only partly met, list every gap as one concrete line a builder can act on (file, command, expected vs actual).
4. NEVER edit, commit, or "quick fix" anything. NEVER ask a question — there is nobody awake. If you cannot check something, that is a gap.

Finish with outcome \`done\` and a \`result\` whose FIRST line is exactly \`VERDICT: PASS\` or \`VERDICT: FAIL\`, then:
evidence:
- <what you ran / looked at, and what it showed>
gaps:
- <one per line; write \`- none\` when PASS>
`;

let cachedTemplate: { text: string; mtimeMs: number } | null = null;

/** The template text: the wiki file when readable (re-read when its mtime
 *  changes), else the embedded fallback. Never throws. */
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

/** Pure: substitute `{{…}}` + the `{{#each build_nodes}}` block. */
export function renderVerifyTemplate(template: string, input: VerifyTemplateInput): string {
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
  };
  let out = template.replace(/\{\{#each build_nodes\}\}([\s\S]*?)\{\{\/each\}\}/g, (_m, block: string) =>
    input.plan.nodes
      .map((n, i) => block.replace(/\{\{index\}\}/g, String(i)).replace(/\{\{title\}\}/g, n.title))
      .join(''),
  );
  out = out.replace(/\{\{([a-z_.]+)\}\}/g, (m, key: string) => (key in vars ? vars[key] : m));
  return out;
}

/** The PlanJsonNode the server appends (§15.3 shape). */
export function buildVerifyPlanNode(args: {
  goal: GoalRow;
  node: GoalNodeDbRow;
  plan: PlanJson;
  verify_model: string;
}): PlanJsonNode {
  const spec = renderVerifyTemplate(loadVerifyTemplate(), { goal: args.goal, node: args.node, plan: args.plan });
  return {
    title: `VERIFY: ${args.node.title}`.slice(0, 300),
    spec,
    adapter: 'claude',
    model: args.verify_model,
    depends_on_indexes: args.plan.nodes.map((_n, i) => i),
    priority: 0,
  };
}
