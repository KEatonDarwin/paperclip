// WORKBENCH — the idea tree as the place Kevin works.
//
// Duplicate of /tree at a new endpoint (per Kevin's hard constraint: /tree,
// /api/v1/smart-todos/*, and the smart_todos tool stay byte-for-byte unchanged —
// this is additive-only). Reads and writes the SAME `smart_todo_nodes` table via
// additive nullable columns; see docs/workbench/SPEC.md ("Data decision") and
// docs/workbench/RECON.md §3 for why that's safe.
//
// This file covers spec §1 (Zoom), §5 (Placement — match-or-create on jot), and
// (as of this node) the scope-resolution + seed-text plumbing that §2-4 (docked
// scoped chat / chats write to the tree / context rules) need. The `workbench`
// tool itself (add_child/split/update/set_status/move/write_context/read_up)
// lives in src/tools/workbench-tool.ts and calls back into this file.

import { execFile } from 'node:child_process';
import { sqliteDb, getConversation } from './conversation-db.js';
import { getLatestThreadSummary } from './thread-summaries.js';
import {
  getSmartTodoNode,
  listSmartTodoNodes,
  createSmartTodoNode,
  insertSmartTodoTree,
  getSmartTodoByThread,
  subtreeIds,
  type SmartTodoNodeRow,
} from './smart-todos.js';
import { decomposeNote } from './smart-todos-decompose.js';
import { extractJsonObject } from './tools/ux-reviewer/vision-critique.js';

// ---------------------------------------------------------------------------
// §1. Zoom — GET /workbench/scope/:id
// ---------------------------------------------------------------------------

export interface WorkbenchScope {
  /** The focused node, or null for the whole-tree (root) scope. */
  node: SmartTodoNodeRow | null;
  /** Root → ... → parent, excluding the focused node itself. Empty for root scope. */
  ancestors: SmartTodoNodeRow[];
  /** The focused node + all descendants (or the whole tree, for root scope). */
  subtree: SmartTodoNodeRow[];
}

/** Walk parent_id upward from a node, returning ancestors root-first (excludes the node itself). */
function ancestorChain(node: SmartTodoNodeRow): SmartTodoNodeRow[] {
  const chain: SmartTodoNodeRow[] = [];
  let cur = node;
  while (cur.parent_id !== null) {
    const parent = getSmartTodoNode(cur.parent_id);
    if (!parent) break;
    chain.unshift(parent);
    cur = parent;
  }
  return chain;
}

/** `null` (or the caller's "root"/0 sentinel, resolved before calling) = the whole tree. */
export function getWorkbenchScope(nodeId: number | null): WorkbenchScope | null {
  if (nodeId === null) {
    return { node: null, ancestors: [], subtree: listSmartTodoNodes() };
  }
  const node = getSmartTodoNode(nodeId);
  if (!node) return null;
  const ancestors = ancestorChain(node);
  const ids = new Set(subtreeIds(nodeId));
  const subtree = listSmartTodoNodes().filter((n) => ids.has(n.id));
  return { node, ancestors, subtree };
}

// ---------------------------------------------------------------------------
// §5. Placement — match-or-create on jot
// ---------------------------------------------------------------------------

export interface DecompositionItem {
  title: string;
  notes?: string | null;
  children?: DecompositionItem[];
}

export interface WorkbenchJotResult {
  parent_id: number | null;
  confidence: number;
  reason: string;
  /** true = this landed at the root because we were NOT confident enough to put
   *  it under a candidate (spec §5 step 4 — "lands at root flagged unsorted,
   *  never a confident wrong guess"). The UI badges this differently from a
   *  deliberate new top-level branch. */
  unsorted: boolean;
  /** Top-level nodes created by this jot (usually one). */
  created: SmartTodoNodeRow[];
  /** created[0], for convenience — the primary "landed here" node. */
  node: SmartTodoNodeRow | null;
  /** Full tree post-insert, mirrors POST /smart-todos/jot's response shape. */
  nodes: SmartTodoNodeRow[];
}

const CLAUDE_BIN = process.env.UX_REVIEWER_CLAUDE_BIN || 'claude';
const CLAUDE_TIMEOUT_MS = 60 * 1000;
const PLACEMENT_MODEL = process.env.WORKBENCH_PLACEMENT_MODEL || 'claude-sonnet-5';
const SHORTLIST_LIMIT = 12;
const CONFIDENCE_THRESHOLD = 0.55;

function runClaudeOneShot(prompt: string): Promise<string> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return new Promise((resolve, reject) => {
    execFile(
      CLAUDE_BIN,
      ['-p', prompt, '--output-format', 'json', '--model', PLACEMENT_MODEL],
      { timeout: CLAUDE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error(`claude placement call failed: ${err.message}${stderr ? ` | ${stderr.slice(0, 300)}` : ''}`));
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

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
}

interface Candidate {
  node: SmartTodoNodeRow;
  ancestors: string[]; // titles, root-first
}

/** Deterministic (zero-model-cost) shortlist: match_key hit, title substring, token overlap. */
function buildShortlist(note: string, limit = SHORTLIST_LIMIT): Candidate[] {
  const noteLower = note.toLowerCase();
  const noteTokens = new Set(tokenize(note));
  const scored: { node: SmartTodoNodeRow; score: number }[] = [];

  for (const node of listSmartTodoNodes()) {
    if (node.status === 'done') continue; // don't land new work under something already finished
    let score = 0;
    if (node.match_key && noteLower.includes(node.match_key.toLowerCase())) score += 100;
    const titleLower = node.title.toLowerCase();
    if (titleLower && (noteLower.includes(titleLower) || titleLower.includes(noteLower))) score += 50;
    const titleOverlap = tokenize(node.title).filter((t) => noteTokens.has(t)).length;
    score += titleOverlap * 10;
    if (node.notes) {
      const notesOverlap = tokenize(node.notes).filter((t) => noteTokens.has(t)).length;
      score += notesOverlap * 3;
    }
    if (score > 0) scored.push({ node, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ node }) => ({ node, ancestors: ancestorChain(node).map((a) => a.title) }));
}

interface PlacementDecision {
  parent_id: number | null;
  confidence: number;
  reason: string;
  decomposition: DecompositionItem[];
}

function sanitizeItem(raw: unknown, depth = 0): DecompositionItem | null {
  if (depth > 12 || !raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  if (!title) return null;
  const notes = typeof r.notes === 'string' && r.notes.trim() ? r.notes.trim() : null;
  const rawChildren = Array.isArray(r.children) ? r.children : [];
  const children = rawChildren
    .map((c) => sanitizeItem(c, depth + 1))
    .filter((c): c is DecompositionItem => c !== null);
  return { title: title.slice(0, 500), notes, children };
}

function sanitizeDecision(raw: unknown, shortlist: Candidate[]): PlacementDecision | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const candidateIds = new Set(shortlist.map((c) => c.node.id));
  const rawParentId = typeof r.parent_id === 'number' ? r.parent_id : null;
  const parent_id = rawParentId !== null && candidateIds.has(rawParentId) ? rawParentId : null;
  const confidence =
    typeof r.confidence === 'number' && Number.isFinite(r.confidence) ? Math.max(0, Math.min(1, r.confidence)) : 0;
  const reason = typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim().slice(0, 300) : '';
  const rawItems = Array.isArray(r.decomposition) ? r.decomposition : [];
  const decomposition = rawItems.map((it) => sanitizeItem(it)).filter((it): it is DecompositionItem => it !== null);
  if (!decomposition.length) return null;
  return { parent_id, confidence, reason, decomposition };
}

function buildPlacementPrompt(note: string, shortlist: Candidate[]): string {
  const candidateLines = shortlist.length
    ? shortlist
        .map((c) => {
          const path = c.ancestors.length ? `${c.ancestors.join(' > ')} > ` : '';
          const notesHint = c.node.notes ? ` — notes: ${c.node.notes.slice(0, 200)}` : '';
          return `- id ${c.node.id}: ${path}${c.node.title}${notesHint}`;
        })
        .join('\n')
    : '(no existing candidates found — this will be a new top-level item)';

  return [
    "You are placing a jotted note into Kevin's existing idea tree (his Workbench).",
    '',
    'He typed the note below. Decide whether it belongs under one of the EXISTING candidate',
    'items listed (because it is clearly part of / related to that existing item), or whether',
    'it is genuinely new and should become a fresh top-level item.',
    '',
    'Rules:',
    '- Only choose an existing candidate id if you are genuinely confident the note belongs',
    '  there — a real thematic/topical match, not just loose word overlap. When in doubt, set',
    '  parent_id to null; a confident wrong guess is worse than filing it as a new top-level item.',
    '- confidence is a number from 0 to 1 for how sure you are about the parent_id choice (whether',
    "  that's an existing id or null).",
    '- decomposition is the list of items to actually create. If the note is one simple actionable',
    '  thing, return ONE item with no children. If it has several distinct parts, break it into',
    '  multiple items / nested children. Do not invent scope beyond what the note actually says.',
    '- Keep every title short and action/outcome shaped (a few words), not a full sentence.',
    "- Put real detail that doesn't fit a title into that item's optional \"notes\" field.",
    '',
    '=== EXISTING CANDIDATES (closest matches already in the tree) ===',
    candidateLines,
    '=== END CANDIDATES ===',
    '',
    "=== KEVIN'S NOTE ===",
    note,
    '=== END NOTE ===',
    '',
    'Return ONLY a JSON object — no markdown fences, no prose before or after — with EXACTLY',
    'this shape:',
    '{',
    '  "parent_id": <one of the candidate ids above, or null>,',
    '  "confidence": 0.0,',
    '  "reason": "one short sentence explaining the placement",',
    '  "decomposition": [',
    '    { "title": "item", "notes": "optional", "children": [ { "title": "subitem" } ] }',
    '  ]',
    '}',
    'decomposition must have at least one item. Every item MUST have a non-empty "title".',
  ].join('\n');
}

/** Runs the shortlist + one claude one-shot to decide placement. Returns null on any
 *  failure (parse/spawn/empty) so the caller can fall back — a jot must never be lost. */
async function decidePlacement(note: string, shortlist: Candidate[]): Promise<PlacementDecision | null> {
  try {
    const raw = await runClaudeOneShot(buildPlacementPrompt(note, shortlist));
    const parsed = extractJsonObject(raw);
    return sanitizeDecision(parsed, shortlist);
  } catch {
    return null;
  }
}

/** Insert a decomposed item as a NEW CHILD of an existing parent (recursively for its
 *  children) — the "attach under an existing node" path insertSmartTodoTree can't do,
 *  since that function always creates a fresh root (see RECON.md §6 trap #4).
 *  Exported for the `workbench` tool's `split` op (see src/tools/workbench-tool.ts). */
export function insertUnderParent(
  parentId: number,
  item: DecompositionItem,
  opts: { group_id?: number | null } = {},
): SmartTodoNodeRow {
  const created = createSmartTodoNode({
    parent_id: parentId,
    title: item.title,
    notes: item.notes ?? null,
    origin: 'decompose',
    group_id: opts.group_id,
  });
  for (const child of item.children ?? []) {
    insertUnderParent(created.id, child, opts);
  }
  return created;
}

function fallbackItem(note: string): DecompositionItem {
  const trimmed = note.trim();
  return {
    title: trimmed.slice(0, 120) || 'Untitled',
    notes: trimmed.length > 120 ? trimmed : null,
    children: [],
  };
}

/** POST /workbench/jot's brain. If `focusId` is given, Kevin already scoped the jot bar
 *  to that node — it's the parent, no matching needed, just decompose-and-attach. Otherwise
 *  runs the deterministic shortlist + one claude one-shot to decide placement AND get the
 *  decomposition in the same call. */
export async function matchOrCreatePlacement(
  note: string,
  opts: { focusId?: number | null; groupId?: number | null } = {},
): Promise<WorkbenchJotResult> {
  const focusId = opts.focusId ?? null;
  const groupId = opts.groupId ?? null;

  if (focusId !== null) {
    const tree = await decomposeNote(note);
    const created = insertUnderParent(focusId, tree, { group_id: groupId });
    return {
      parent_id: focusId,
      confidence: 1,
      reason: 'Placed under the item you were zoomed into.',
      unsorted: false,
      created: [created],
      node: created,
      nodes: listSmartTodoNodes(),
    };
  }

  const shortlist = buildShortlist(note);
  const decision = await decidePlacement(note, shortlist);

  let parentId: number | null = decision?.parent_id ?? null;
  let confidence = decision?.confidence ?? 0;
  let reason = decision?.reason || 'No strong match found; filed as a new top-level item.';
  const items: DecompositionItem[] =
    decision && decision.decomposition.length ? decision.decomposition : [fallbackItem(note)];

  let unsorted = false;
  if (parentId !== null && confidence < CONFIDENCE_THRESHOLD) {
    reason = `${reason} (low confidence; filed at root instead of guessing)`;
    parentId = null;
    unsorted = true;
  }
  // A parent that vanished between the shortlist build and here (deleted mid-flight) — refuse
  // the write, fall back to root rather than throwing.
  if (parentId !== null && !getSmartTodoNode(parentId)) {
    parentId = null;
    unsorted = true;
  }

  const created: SmartTodoNodeRow[] = items.map((item) =>
    parentId === null ? insertSmartTodoTree(note, item, { group_id: groupId }) : insertUnderParent(parentId, item, { group_id: groupId }),
  );

  return {
    parent_id: parentId,
    confidence,
    reason,
    unsorted,
    created,
    node: created[0] ?? null,
    nodes: listSmartTodoNodes(),
  };
}

// ---------------------------------------------------------------------------
// §3/§4. Scope resolution for the `workbench` tool + the docked scoped chat's
// seed text. See src/tools/workbench-tool.ts for the tool that consumes these.
// ---------------------------------------------------------------------------

export interface WorkbenchToolScope {
  /** The node id this chat is bound to via linked_thread_ext, or null = root/
   *  whole-tree scope (no smart_todo_nodes row is bound to this thread — the
   *  root sentinel chat, or any thread that was never opened through a
   *  workbench zoom). Root scope is intentionally unrestricted. */
  focusId: number | null;
  /** ids the tool may write to (includes focusId itself). null when focusId is
   *  null — root scope has no restriction. */
  allowedIds: Set<number> | null;
  /** The automatic context payload — same shape GET /workbench/scope/:id returns. */
  scope: WorkbenchScope;
}

/** Resolve which node (if any) a conversation is scoped to, purely from the
 *  existing `linked_thread_ext` binding — the SAME field `/tree`'s open-chat
 *  uses, so a node opened from either surface always resolves to one thread.
 *  No external_id match = root/whole-tree scope (by design — see spec §2's
 *  "Root/whole-tree scope gets its own thread too" and RECON.md §4). */
export function resolveWorkbenchToolScope(externalId: string | null | undefined): WorkbenchToolScope {
  const node = externalId ? getSmartTodoByThread(externalId) : null;
  if (!node) {
    return {
      focusId: null,
      allowedIds: null,
      scope: { node: null, ancestors: [], subtree: listSmartTodoNodes() },
    };
  }
  const scope = getWorkbenchScope(node.id) ?? { node, ancestors: ancestorChain(node), subtree: [node] };
  return { focusId: node.id, allowedIds: new Set(scope.subtree.map((n) => n.id)), scope };
}

/** The load-bearing scope guard: is `targetId` something this chat may write to?
 *  Root scope (allowedIds === null) is unrestricted. A scoped chat may only
 *  touch its own focus node + descendants — never a sibling branch, never an
 *  ancestor, never an unrelated part of the tree. */
export function assertWorkbenchScope(
  toolScope: WorkbenchToolScope,
  targetId: number,
): { ok: true } | { ok: false; error: string } {
  if (toolScope.allowedIds === null) return { ok: true };
  if (toolScope.allowedIds.has(targetId)) return { ok: true };
  const label = toolScope.scope.node ? `"${toolScope.scope.node.title}" (node ${toolScope.focusId})` : 'the root';
  return {
    ok: false,
    error:
      `Node ${targetId} is outside your scope — you're scoped to ${label} and its subtree. ` +
      'Tell Kevin what you wanted to change and where, instead of reaching across the tree.',
  };
}

const touchActivityStmt = sqliteDb.prepare<[number]>(
  `UPDATE smart_todo_nodes SET last_activity_at = datetime('now') WHERE id = ?`,
);

/** Stamp last_activity_at on a node the workbench tool just wrote to. A raw,
 *  isolated write (not routed through smart-todos.ts's shared statements) —
 *  see docs/workbench/RECON.md §3, option (a). */
export function touchWorkbenchActivity(id: number): void {
  touchActivityStmt.run(id);
}

/** Read an ancestor's linked-thread SUMMARY (never its transcript) — the
 *  on-demand half of spec §4. Returns null if the ancestor has no chat of its
 *  own yet, or no summary has been generated for it yet. */
export function readAncestorSummary(
  ancestorId: number,
): { node: SmartTodoNodeRow; summary: { content: string; created_at: string } | null; note?: string } | null {
  const ancestor = getSmartTodoNode(ancestorId);
  if (!ancestor) return null;
  if (!ancestor.linked_thread_ext) {
    return { node: ancestor, summary: null, note: 'That branch has no chat of its own yet, so there is no summary to read.' };
  }
  const conv = getConversation(ancestor.linked_thread_ext);
  if (!conv) {
    return { node: ancestor, summary: null, note: 'That branch\'s chat no longer exists.' };
  }
  const latest = getLatestThreadSummary(conv.id);
  if (!latest) {
    return { node: ancestor, summary: null, note: 'That branch has a chat, but no summary has been generated for it yet.' };
  }
  return { node: ancestor, summary: { content: latest.content, created_at: latest.created_at } };
}

/** Build the seed text a scoped Workbench chat is booted with (spec §2/§4) —
 *  the automatic context (focus node + full subtree + ancestor titles/notes)
 *  plus the explicit scope statement and the auto-notes instruction that makes
 *  the tree carry memory instead of the transcript. Pure/side-effect-free —
 *  callers post the result as the thread's first message, same convention as
 *  the existing /smart-todos/:id/open-chat seed. */
export function buildWorkbenchSeedText(scope: WorkbenchScope): string {
  const lines: string[] = [];

  if (scope.node) {
    lines.push(
      `You are scoped to node ${scope.node.id}: "${scope.node.title}". Kevin is talking to THIS branch — ` +
        'he should never have to tell you which project he means.',
    );
  } else {
    lines.push('You are scoped to the ROOT — the whole idea tree. Kevin can talk about anything on the board here.');
  }
  lines.push('');

  if (scope.ancestors.length) {
    lines.push("Ancestor chain (root → here), for orientation only — you don't own these, you can only look:");
    for (const a of scope.ancestors) {
      lines.push(`- ${a.title}${a.notes ? ` — ${a.notes.slice(0, 160)}` : ''}`);
    }
    lines.push('');
  }

  lines.push('Everything in this branch (automatic — you always have this, no need to ask for it):');
  const byParent = new Map<number | null, SmartTodoNodeRow[]>();
  for (const n of scope.subtree) {
    const key = n.parent_id;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(n);
  }
  const renderNode = (n: SmartTodoNodeRow, depth: number): void => {
    const indent = '  '.repeat(depth);
    lines.push(`${indent}- [${n.status}] ${n.title} (id ${n.id})`);
    if (n.notes) lines.push(`${indent}  notes: ${n.notes.slice(0, 200)}`);
    if (n.context_notes) lines.push(`${indent}  context: ${n.context_notes.slice(0, 300)}`);
    const children = (byParent.get(n.id) ?? []).slice().sort((a, b) => a.sort_order - b.sort_order);
    for (const c of children) renderNode(c, depth + 1);
  };
  const roots = scope.node ? [scope.node] : (byParent.get(null) ?? []).slice().sort((a, b) => a.sort_order - b.sort_order);
  if (roots.length) {
    for (const r of roots) renderNode(r, 0);
  } else {
    lines.push('(nothing here yet)');
  }
  lines.push('');

  lines.push(
    'How to work in this chat:',
    '- Use the `workbench` tool to create/read/update items — list_scope, add_child, split, update, ' +
      'set_status, move, write_context, read_up. Writes outside this branch are refused; if that happens, ' +
      'just tell Kevin plainly what you wanted to change and where, instead of trying to route around it.',
    "- `read_up` is ON DEMAND ONLY — call it with an ancestor's node id when you genuinely need context from " +
      "above this branch. It returns that ancestor's chat SUMMARY, never its transcript, and only when you ask.",
    '- AUTO-NOTES (do this every turn something real happens): before you finish responding, if you decided ' +
      'something, changed something, or figured out a next step, call `workbench` `write_context` on this node ' +
      '(or whichever node it applies to) with a 1-3 line outcome. This is what lets the tree itself carry the ' +
      'memory forward — a future chat should be able to understand where things stand from the tree alone, ' +
      'without ever reading this transcript.',
  );

  return lines.join('\n');
}
