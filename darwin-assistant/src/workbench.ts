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
import { randomUUID } from 'node:crypto';
import {
  sqliteDb,
  getConversation,
  getOrCreateConversation,
  renameConversation,
  getSetting,
  countTurns,
} from './conversation-db.js';
import { getSpawnTaskByThreadExt } from './spawn-tasks.js';
import { sseBus, type WorkbenchProposalEvent } from './sse-bus.js';
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
  let node = externalId ? getSmartTodoByThread(externalId) : null;
  // V2 dispatch workers (REVIEW-V2 fix #1): a `POST /workbench/nodes/:id/dispatch`
  // worker's thread is never a node's linked_thread_ext, so without this it
  // would resolve to ROOT scope and the "keep every write scoped to THIS node"
  // rule in its prompt would be prose only. The spawn_tasks row it was born
  // with stamps workbench_node_id — that is the mechanical binding.
  if (!node && externalId) {
    const spawn = getSpawnTaskByThreadExt(externalId);
    if (spawn?.workbench_node_id != null) {
      node = getSmartTodoNode(spawn.workbench_node_id);
      if (!node) {
        // Its node was deleted out from under it — a dead worker must NOT
        // widen to root; it gets an empty write scope instead.
        return { focusId: null, allowedIds: new Set<number>(), scope: { node: null, ancestors: [], subtree: [] } };
      }
    }
  }
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

/** Shared status/notes/context_notes-per-node, indented-by-depth digest of a
 *  scope's subtree. Factored out so buildWorkbenchSeedText (v1's per-node
 *  scoped chat) and the v2 brain session's focus snapshot (below) render the
 *  same shape instead of drifting. */
function renderSubtreeDigest(scope: WorkbenchScope): string {
  const lines: string[] = [];
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
  return lines.join('\n');
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
  lines.push(renderSubtreeDigest(scope));
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

/** Per-turn context block for a v1-style per-node Workbench chat (the "Open
 *  chat" deep-dive, thread ext `cockpit:workbench-<uuid>` bound via
 *  linked_thread_ext). REVIEW-V2 fix #6: v2 stopped auto-posting the seed on
 *  open (correct — nothing may "start to think" on a click), but the v2 UI then
 *  simply dropped the seed, leaving the deep-dive chat with no idea what branch
 *  it's scoped to until the tool refused it. Injecting the scope every turn —
 *  same shape as buildQuickChatContext — is the durable version: always
 *  current, no first-message coupling. Returns '' for every other thread
 *  (brain sessions carry their own seed via /workbench/say; dispatch workers
 *  carry theirs in the dispatch prompt; /tree's `cockpit:tree-*` chats are
 *  untouched). Capped so a big branch can't balloon the per-turn prefix. */
export function buildWorkbenchThreadContext(externalId: string): string {
  try {
    if (!externalId.includes(':workbench-')) return '';
    if (externalId.includes('workbench-brain-') || externalId.includes('workbench-worker-')) return '';
    const node = getSmartTodoByThread(externalId);
    if (!node) return '';
    const scope = getWorkbenchScope(node.id);
    if (!scope) return '';
    const body = buildWorkbenchSeedText(scope);
    const capped = body.length > 6000 ? `${body.slice(0, 6000)}\n… (branch digest truncated — use list_scope for the rest)` : body;
    return `<workbench_scope>\n${capped}\n</workbench_scope>\n`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// V2 §"Dispatch" — POST /workbench/nodes/:id/dispatch. Spawns ONE ephemeral
// cockpit worker attached to a single node (explicit-dispatch, never on
// click/zoom — see SPEC.md's "V2 — THE INTERACTION CORRECTION"). The worker is
// NOT bound to the node via linked_thread_ext (that field is the node's
// persistent opt-in chat from §2 — dispatch must never hijack it); instead the
// worker is told its target node id directly and always passes it explicitly
// to the `workbench` tool. Its scope is MECHANICAL, not prose: the spawn_tasks
// row stamps workbench_node_id and resolveWorkbenchToolScope binds the worker
// thread to that node's subtree (REVIEW-V2 fix #1), so a write outside the
// node it was dispatched for is refused. The route layer (api-v1.ts) owns spawning +
// the spawn_tasks row; this function only composes the one-shot prompt.
// ---------------------------------------------------------------------------

/** The one prompt a workbench dispatch worker is born with: node + ancestor
 *  context + Kevin's instructions + the finish contract (write_context, not a
 *  curl — there is no separate "finish" endpoint; the existing 5-minute
 *  spawn_tasks reconciler flips running -> done off server-owned run-state,
 *  same as every other spawned worker). */
export function composeDispatchPrompt(
  node: SmartTodoNodeRow,
  ancestors: SmartTodoNodeRow[],
  instructions: string | null,
): string {
  const lines: string[] = [
    'You are a SPAWNED WORKBENCH DISPATCH WORKER — an ephemeral JARVIS instance born to advance ONE item ' +
      "in Kevin's idea tree (the Workbench), report your outcome back into the tree, and stop. You are not " +
      'a conversation; nobody will reply to your messages. Kevin sees your work through the tree, not this thread.',
    '',
    `**Your node (id ${node.id}):** ${node.title}`,
  ];
  if (node.notes) lines.push('', `**Notes:** ${node.notes}`);
  if (node.context_notes) lines.push('', `**Prior context on this node:**`, node.context_notes);
  if (ancestors.length) {
    lines.push('', '**Ancestor chain (root → here), for orientation:**');
    for (const a of ancestors) lines.push(`- ${a.title}${a.notes ? ` — ${a.notes.slice(0, 200)}` : ''}`);
  }
  if (instructions) lines.push('', "**Kevin's instructions for this dispatch:**", instructions);
  lines.push(
    '',
    '**Guardrails (hard):** no touching live production systems/databases, no merging to main, no external ' +
      "sends (Slack/email/PRs) under Kevin's identity, no new spend, and NO API KEYS for model calls — " +
      'subscription CLI binaries only.',
    '',
    '**FINISH CONTRACT — mandatory, and it is a tool call, not a curl.** When you are done (or genuinely ' +
      `stuck), call the \`workbench\` tool with operation "write_context", node_id ${node.id}, and a concise ` +
      '1-3+ line outcome note (what you did, artifacts/paths/commits, or why you are stuck) — that note is ' +
      'how Kevin and any future chat learn what happened; keep every write scoped to THIS node id, never a ' +
      "sibling or ancestor. If the work is genuinely complete, also call `workbench` \"set_status\" on node " +
      `${node.id} with status "done". Do this before you stop responding — there is no separate finish ` +
      'endpoint for a dispatch worker; ending your turn without a write_context call means Kevin sees nothing.',
    '',
    'Work efficiently, verify what you build, and do not gold-plate. Begin now.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// V2 — Proposals (the ghost layer). See docs/workbench/SPEC.md "V2 — THE
// INTERACTION CORRECTION" + docs/workbench/RECON-V2.md §6 (contract table)
// and §7 traps #2/#5. Multi-node decompositions land here as PROPOSALS Kevin
// corrects (talk or click ✓/✕) BEFORE they become real smart_todo_nodes rows
// — the real tree stays pure until accept. A single explicitly-requested node
// may still be added directly via the `workbench` tool's existing `add_child`.
//
// Storage note (a deliberate refinement of RECON-V2 trap #2's "flat rows,
// parent_id may point at a real node OR another proposal in the same batch"
// resolution): rather than overload one `parent_id` column — which risks an
// id collision between the two tables — this uses two mutually-exclusive
// columns, `parent_node_id` (a real smart_todo_nodes.id, or null) and
// `parent_proposal_id` (another proposal row's id within the SAME batch, or
// null). Exactly one of the two is non-null for a nested item; both are null
// only for a batch's own top-level items when the batch itself has no real
// parent (i.e. new top-level branches). This removes the ambiguity trap #2
// flagged without changing the accept-time resolution algorithm it describes.
// ---------------------------------------------------------------------------

export interface WorkbenchProposalRow {
  id: number;
  batch_id: string;
  parent_node_id: number | null;
  parent_proposal_id: number | null;
  title: string;
  notes: string | null;
  sort_order: number;
  created_by_thread: string | null;
  /** The JARVIS turn (sourceMessageId) that proposed this batch — the
   *  mechanical half of "the brain never accepts a batch it just proposed":
   *  `accept_batch` from the SAME turn is refused (REVIEW-V2 fix #3). */
  created_by_message: string | null;
  created_at: string;
}

export interface WorkbenchProposalBatch {
  batch_id: string;
  created_at: string;
  created_by_thread: string | null;
  proposals: WorkbenchProposalRow[];
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS workbench_proposals (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id           TEXT NOT NULL,
    parent_node_id     INTEGER,
    parent_proposal_id INTEGER,
    title              TEXT NOT NULL,
    notes              TEXT,
    sort_order         INTEGER NOT NULL DEFAULT 0,
    created_by_thread  TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_workbench_proposals_batch ON workbench_proposals(batch_id, sort_order, id);
`);
// Lazy migration (same pattern as spawn_tasks' stamp columns).
try {
  sqliteDb.exec(`ALTER TABLE workbench_proposals ADD COLUMN created_by_message TEXT`);
} catch {
  /* column already exists */
}

const getProposalStmt = sqliteDb.prepare<[number], WorkbenchProposalRow>(
  `SELECT * FROM workbench_proposals WHERE id = ?`,
);
const listAllProposalsStmt = sqliteDb.prepare<[], WorkbenchProposalRow>(
  `SELECT * FROM workbench_proposals ORDER BY batch_id ASC, id ASC`,
);
const listBatchProposalsStmt = sqliteDb.prepare<[string], WorkbenchProposalRow>(
  `SELECT * FROM workbench_proposals WHERE batch_id = ? ORDER BY id ASC`,
);
const insertProposalStmt = sqliteDb.prepare<
  [string, number | null, number | null, string, string | null, number, string | null, string | null]
>(`
  INSERT INTO workbench_proposals
    (batch_id, parent_node_id, parent_proposal_id, title, notes, sort_order, created_by_thread, created_by_message)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const updProposalTitleStmt = sqliteDb.prepare<[string, number]>(
  `UPDATE workbench_proposals SET title = ? WHERE id = ?`,
);
const updProposalNotesStmt = sqliteDb.prepare<[string | null, number]>(
  `UPDATE workbench_proposals SET notes = ? WHERE id = ?`,
);

function emitProposal(action: WorkbenchProposalEvent['action'], batchId: string, proposal?: WorkbenchProposalRow): void {
  sseBus.emit('sse', { type: 'workbench_proposal', action, batch_id: batchId, proposal } satisfies WorkbenchProposalEvent);
}

export function getWorkbenchProposal(id: number): WorkbenchProposalRow | null {
  return getProposalStmt.get(id) ?? null;
}

export function listProposalsForBatch(batchId: string): WorkbenchProposalRow[] {
  return listBatchProposalsStmt.all(batchId);
}

/** GET /workbench/proposals — every pending proposal, grouped by batch. */
export function listPendingProposalBatches(): WorkbenchProposalBatch[] {
  const rows = listAllProposalsStmt.all();
  const byBatch = new Map<string, WorkbenchProposalRow[]>();
  for (const row of rows) {
    if (!byBatch.has(row.batch_id)) byBatch.set(row.batch_id, []);
    byBatch.get(row.batch_id)!.push(row);
  }
  // REVIEW-V2 fix #5: a batch whose real parent node was deleted after it was
  // proposed is an orphan — the UI renders ghosts under their parent row, so
  // it would be invisible yet still pending (and un-acceptable) forever.
  // smart-todos.ts is off-limits (byte-for-byte), so prune lazily here: drop
  // the whole batch, emit `rejected` so any open page refetches.
  for (const [batchId, proposals] of Array.from(byBatch.entries())) {
    const orphaned = proposals.some((p) => p.parent_node_id !== null && !getSmartTodoNode(p.parent_node_id));
    if (!orphaned) continue;
    deleteProposalRows(proposals.map((p) => p.id));
    byBatch.delete(batchId);
    emitProposal('rejected', batchId);
  }
  return Array.from(byBatch.entries()).map(([batch_id, proposals]) => ({
    batch_id,
    created_at: proposals[0]?.created_at ?? '',
    created_by_thread: proposals[0]?.created_by_thread ?? null,
    proposals,
  }));
}

/** Inserts `item` (and recursively, its children as nested ghosts) and pushes
 *  EVERY row created — the item itself plus all descendants — onto `acc`, so
 *  a caller processing a whole decomposition tree gets back every row it
 *  actually wrote, not just the top-level ones. Returns the item's own row. */
function insertProposalItem(
  batchId: string,
  item: DecompositionItem,
  opts: {
    parentNodeId: number | null;
    parentProposalId: number | null;
    sortOrder: number;
    createdByThread: string | null;
    createdByMessage: string | null;
  },
  acc: WorkbenchProposalRow[],
): WorkbenchProposalRow {
  const info = insertProposalStmt.run(
    batchId,
    opts.parentNodeId,
    opts.parentProposalId,
    item.title.slice(0, 500),
    item.notes ?? null,
    opts.sortOrder,
    opts.createdByThread,
    opts.createdByMessage,
  );
  const id = Number(info.lastInsertRowid);
  const row = getProposalStmt.get(id)!;
  acc.push(row);
  (item.children ?? []).forEach((child, idx) => {
    insertProposalItem(
      batchId,
      child,
      { parentNodeId: null, parentProposalId: id, sortOrder: idx, createdByThread: opts.createdByThread, createdByMessage: opts.createdByMessage },
      acc,
    );
  });
  return row;
}

/** The `workbench` tool's `propose_batch` op (and, in principle, any future
 *  caller): stage a multi-node decomposition as ghost rows under one batch id
 *  instead of writing real nodes. `parentNodeId` is the REAL node the whole
 *  batch's top-level items attach under (null = new top-level branch(es)) —
 *  this is the "single node" trust boundary: a lone item Kevin explicitly
 *  asked for goes straight to `add_child`, anything with >1 node (or any
 *  nesting) comes through here per SPEC.md's bulk rule. */
export function proposeBatch(
  items: DecompositionItem[],
  opts: { parentNodeId?: number | null; createdByThread?: string | null; createdByMessage?: string | null } = {},
): { batch_id: string; proposals: WorkbenchProposalRow[] } {
  if (!items.length) throw new Error('propose_batch needs at least one item');
  const batchId = randomUUID();
  const parentNodeId = opts.parentNodeId ?? null;
  const createdByThread = opts.createdByThread ?? null;
  const createdByMessage = opts.createdByMessage ?? null;
  if (parentNodeId !== null && !getSmartTodoNode(parentNodeId)) throw new Error(`parent node ${parentNodeId} not found`);
  const run = sqliteDb.transaction((): WorkbenchProposalRow[] => {
    const acc: WorkbenchProposalRow[] = [];
    items.forEach((item, idx) =>
      insertProposalItem(batchId, item, { parentNodeId, parentProposalId: null, sortOrder: idx, createdByThread, createdByMessage }, acc),
    );
    return acc;
  });
  const proposals = run();
  emitProposal('created', batchId);
  return { batch_id: batchId, proposals };
}

/** Edit a still-pending proposal's own title/notes (does not touch structure). */
export function updateWorkbenchProposal(id: number, patch: { title?: string; notes?: string | null }): WorkbenchProposalRow | null {
  const existing = getProposalStmt.get(id);
  if (!existing) return null;
  if (patch.title !== undefined && patch.title.trim()) updProposalTitleStmt.run(patch.title.trim().slice(0, 500), id);
  if (patch.notes !== undefined) updProposalNotesStmt.run(patch.notes, id);
  const updated = getProposalStmt.get(id) ?? null;
  if (updated) emitProposal('updated', updated.batch_id, updated);
  return updated;
}

/** ids of a proposal + all its nested proposal descendants WITHIN the same batch. */
function proposalDescendantIds(id: number, batchRows: WorkbenchProposalRow[]): number[] {
  const out = [id];
  for (const child of batchRows.filter((r) => r.parent_proposal_id === id)) {
    out.push(...proposalDescendantIds(child.id, batchRows));
  }
  return out;
}

/** ids from `id` up through its proposal ancestors within the batch (id-first,
 *  root-last) — a child can't be materialized without its parent existing
 *  somewhere real first, so accepting a nested proposal implicitly pulls in
 *  its whole ancestor chain (RECON-V2 §7 trap #2's locked-in accept rule). */
function proposalAncestorChainIds(id: number, batchRows: WorkbenchProposalRow[]): number[] {
  const byId = new Map(batchRows.map((r) => [r.id, r]));
  const out: number[] = [];
  let cur = byId.get(id);
  while (cur) {
    out.push(cur.id);
    cur = cur.parent_proposal_id !== null ? byId.get(cur.parent_proposal_id) : undefined;
  }
  return out;
}

function deleteProposalRows(ids: number[]): void {
  if (!ids.length) return;
  sqliteDb.prepare(`DELETE FROM workbench_proposals WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
}

/** Delete ONE proposal + its nested descendants (the `workbench` tool's
 *  `delete_proposal` op — a targeted reject of a single ghost, distinct from
 *  rejecting a whole batch). Returns how many rows were removed. */
export function deleteProposalCascade(id: number): number {
  const row = getProposalStmt.get(id);
  if (!row) return 0;
  const batchRows = listBatchProposalsStmt.all(row.batch_id);
  const ids = proposalDescendantIds(id, batchRows);
  deleteProposalRows(ids);
  emitProposal('rejected', row.batch_id);
  return ids.length;
}

/** POST /workbench/proposals/:batchId/accept — materialize proposals into real
 *  smart_todo_nodes via the existing createSmartTodoNode path (so real-tree
 *  writes stay on ONE code path whether Kevin clicks Accept or the brain calls
 *  `accept_batch` after he says "yes do that" — RECON-V2 §6). `ids` omitted =
 *  accept the whole batch; when given, each requested id implicitly pulls in
 *  its proposal ancestor chain (see proposalAncestorChainIds) so a child is
 *  never materialized before its parent. Rows are resolved in ascending id
 *  order, which is guaranteed topological: a parent proposal is always
 *  inserted (and thus gets a lower id) before its children in the same
 *  transaction (proposeBatch/insertProposalItem). Atomic — any failure rolls
 *  back the whole accept, never a half-materialized batch. */
export function acceptProposalBatch(batchId: string, ids?: number[]): { created: SmartTodoNodeRow[] } {
  const batchRows = listBatchProposalsStmt.all(batchId);
  if (!batchRows.length) throw new Error(`no pending proposals for batch ${batchId}`);

  let selected: Set<number>;
  if (ids && ids.length) {
    const batchIds = new Set(batchRows.map((r) => r.id));
    const expanded = new Set<number>();
    for (const id of ids) {
      if (!batchIds.has(id)) throw new Error(`proposal ${id} not found in batch ${batchId}`);
      for (const a of proposalAncestorChainIds(id, batchRows)) expanded.add(a);
    }
    selected = expanded;
  } else {
    selected = new Set(batchRows.map((r) => r.id));
  }

  const toMaterialize = batchRows.filter((r) => selected.has(r.id)).sort((a, b) => a.id - b.id);
  const proposalToReal = new Map<number, number>();
  const created: SmartTodoNodeRow[] = [];

  const run = sqliteDb.transaction((): SmartTodoNodeRow[] => {
    for (const row of toMaterialize) {
      let parentId: number | null;
      if (row.parent_proposal_id !== null) {
        const real = proposalToReal.get(row.parent_proposal_id);
        if (real === undefined) {
          throw new Error(`proposal ${row.id} depends on unresolved parent proposal ${row.parent_proposal_id}`);
        }
        parentId = real;
      } else {
        parentId = row.parent_node_id;
      }
      if (parentId !== null && !getSmartTodoNode(parentId)) {
        throw new Error(`parent node ${parentId} not found`);
      }
      const node = createSmartTodoNode({ parent_id: parentId, title: row.title, notes: row.notes, origin: 'workbench' });
      proposalToReal.set(row.id, node.id);
      created.push(node);
    }
    deleteProposalRows(toMaterialize.map((r) => r.id));
    return created;
  });

  const result = run();
  emitProposal('accepted', batchId);
  return { created: result };
}

/** POST /workbench/proposals/:batchId/reject — discard proposals without
 *  materializing them. `ids` omitted = reject the whole batch; when given,
 *  each requested id pulls in its nested descendants too (rejecting a row
 *  rejects everything nested under it in the batch — the other half of the
 *  accept rule above). */
export function rejectProposalBatch(batchId: string, ids?: number[]): { removed: number } {
  const batchRows = listBatchProposalsStmt.all(batchId);
  if (!batchRows.length) return { removed: 0 };

  let toRemove: Set<number>;
  if (ids && ids.length) {
    const batchIds = new Set(batchRows.map((r) => r.id));
    const expanded = new Set<number>();
    for (const id of ids) {
      if (!batchIds.has(id)) throw new Error(`proposal ${id} not found in batch ${batchId}`);
      for (const d of proposalDescendantIds(id, batchRows)) expanded.add(d);
    }
    toRemove = expanded;
  } else {
    toRemove = new Set(batchRows.map((r) => r.id));
  }

  deleteProposalRows(Array.from(toRemove));
  emitProposal('rejected', batchId);
  return { removed: toRemove.size };
}

// ---------------------------------------------------------------------------
// V2 §"Sessions" — POST /workbench/say. See docs/workbench/SPEC.md "V2 — THE
// INTERACTION CORRECTION" and docs/workbench/RECON-V2.md §1/§4/§6.
//
// v1 bound a thread PER NODE, eagerly, on every zoom (the removed defect —
// RECON-V2 §1). v2 replaces that with ONE ongoing "brain" conversation per
// sitting, fed by the docked bar; zooming only moves a silent focus pointer,
// it never creates or rebinds a thread. A "sitting" is PER-SITTING, not
// forever: idle for `workbench_session_idle_hours` (settings-KV, default 4h)
// and the next /workbench/say starts a fresh session. The TREE itself
// (titles/status/notes/context_notes) is the durable memory; the conversation
// stays disposable — same Persistence Principle as every other JARVIS worker.
// ---------------------------------------------------------------------------

export interface WorkbenchSessionRow {
  id: number;
  thread_ext: string;
  last_focus_id: number | null;
  started_at: string;
  last_activity_at: string;
  ended_at: string | null;
}

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS workbench_sessions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_ext       TEXT NOT NULL UNIQUE,
    last_focus_id    INTEGER,
    started_at       TEXT NOT NULL DEFAULT (datetime('now')),
    last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_workbench_sessions_open ON workbench_sessions(ended_at, last_activity_at);
`);

const DEFAULT_SESSION_IDLE_HOURS = 4;
const SESSION_IDLE_HOURS_SETTING = 'workbench_session_idle_hours';

function getSessionIdleHours(): number {
  const raw = getSetting(SESSION_IDLE_HOURS_SETTING);
  const parsed = raw !== null ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_IDLE_HOURS;
}

const findOpenSessionStmt = sqliteDb.prepare<[], WorkbenchSessionRow>(
  `SELECT * FROM workbench_sessions WHERE ended_at IS NULL ORDER BY last_activity_at DESC LIMIT 1`,
);
const endOpenSessionsStmt = sqliteDb.prepare<[]>(
  `UPDATE workbench_sessions SET ended_at = datetime('now') WHERE ended_at IS NULL`,
);
const insertSessionStmt = sqliteDb.prepare<[string]>(
  `INSERT INTO workbench_sessions (thread_ext) VALUES (?)`,
);
const getSessionByIdStmt = sqliteDb.prepare<[number], WorkbenchSessionRow>(
  `SELECT * FROM workbench_sessions WHERE id = ?`,
);
const touchSessionStmt = sqliteDb.prepare<[number | null, number]>(
  `UPDATE workbench_sessions SET last_focus_id = ?, last_activity_at = datetime('now') WHERE id = ?`,
);

/** sqlite `datetime('now')` (UTC, no 'Z') → a real Date. Same convention as
 *  monitors.ts's existing sqlite-timestamp parsing. */
function parseSqliteDatetime(raw: string): Date {
  return new Date(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
}

function isSessionFresh(session: WorkbenchSessionRow, idleHours: number): boolean {
  const last = parseSqliteDatetime(session.last_activity_at).getTime();
  if (Number.isNaN(last)) return false;
  return Date.now() - last <= idleHours * 60 * 60 * 1000;
}

/** Read-only: the currently-open session, if it's still within the idle
 *  window. Never touches last_activity_at — a page-load discovery poll must
 *  not itself extend a sitting. Powers `GET /workbench/session`, which closes
 *  the gap RECON-V2 §4 flagged (without it, a reload mid-sitting looks like a
 *  fresh session because there'd be nothing to resolve an ext from before the
 *  first send). */
export function peekOpenWorkbenchSession(): WorkbenchSessionRow | null {
  const open = findOpenSessionStmt.get();
  if (!open) return null;
  return isSessionFresh(open, getSessionIdleHours()) ? open : null;
}

/** Find-or-create the Workbench brain session. Reuses the open session if
 *  it's still within `workbench_session_idle_hours`; otherwise (idle expiry,
 *  or `forceNew` — the "New session" affordance) ends whatever's open and
 *  starts a fresh one, so at most one session is ever open at a time. */
export function findOrCreateWorkbenchSession(opts: { forceNew?: boolean } = {}): {
  session: WorkbenchSessionRow;
  isNew: boolean;
} {
  if (!opts.forceNew) {
    const fresh = peekOpenWorkbenchSession();
    if (fresh) return { session: fresh, isNew: false };
  }
  endOpenSessionsStmt.run();
  const threadExt = `cockpit:workbench-brain-${randomUUID()}`;
  const info = insertSessionStmt.run(threadExt);
  const created = getSessionByIdStmt.get(Number(info.lastInsertRowid));
  if (!created) throw new Error('Failed to load workbench session after insert');
  return { session: created, isNew: true };
}

/** Stamp last_activity_at + the focus pointer for next time — "Touching
 *  /workbench/say updates last_activity_at" (spec). */
export function touchWorkbenchSession(sessionId: number, focusId: number | null): void {
  touchSessionStmt.run(focusId, sessionId);
}

function renderRootDigest(): string {
  const roots = listSmartTodoNodes()
    .filter((n) => n.parent_id === null)
    .sort((a, b) => a.sort_order - b.sort_order);
  if (!roots.length) return '(the tree is empty — nothing jotted yet)';
  return roots
    .map((r) => {
      const rowLines = [`- [${r.status}] ${r.title} (id ${r.id})`];
      if (r.notes) rowLines.push(`  notes: ${r.notes.slice(0, 200)}`);
      if (r.context_notes) rowLines.push(`  context: ${r.context_notes.slice(0, 300)}`);
      return rowLines.join('\n');
    })
    .join('\n');
}

/** The tree digest a BRAND-NEW brain session is booted with — root branches
 *  only (status/notes/context_notes), never transcripts, plus the standing
 *  instructions for how the brain drives the tree. This (not Kevin) is what
 *  makes "he should never have to say which project he means" true from the
 *  first message of a sitting. */
function buildBrainSeedText(): string {
  const lines: string[] = [
    "You are JARVIS's Workbench brain — the ONE ongoing conversation behind Kevin's docked chat " +
      "bar on the Workbench idea tree. Unlike a normal thread you are not bound to a single branch; " +
      'you persist across whatever he talks about in this sitting. Every message he sends silently ' +
      'carries a FOCUS POINTER (whichever node — if any — he is currently zoomed into on the page). ' +
      'A message that opens with a `[focus: ...]` header is telling you the pointer just moved — ' +
      'that is what it is now pointed at. He should never have to tell you which project he means: ' +
      'the header (when present) plus the tree digest below are how you already know.',
    '',
    'Everything currently on the board (root branches — automatic, no need to ask for it):',
    renderRootDigest(),
    '',
    'How to work in this chat:',
    '- Use the `workbench` tool to read/create/update the tree: list_scope, add_child, split, update, ' +
      'set_status, move, write_context, read_up, propose_batch, update_proposal, delete_proposal, accept_batch.',
    '- Creating a node is not free the way talking is. If what Kevin describes breaks into MORE THAN ONE ' +
      'node, use `propose_batch` — that lands the breakdown as dashed "ghost" proposals he corrects ' +
      '(by talking or clicking ✓/✕) before anything becomes real. A single node he explicitly asked for ' +
      'may still go straight to `add_child`.',
    '- Only call `accept_batch` when Kevin has actually said yes/approved IN THIS CONVERSATION — his ' +
      'utterance is the gate. Never accept a batch you just proposed unprompted.',
    '- AUTO-NOTES: whenever you materially advance a node — a decision, a change, a next step — call ' +
      '`write_context` on that node with a 1-3 line outcome before you finish responding. The TREE is the ' +
      'long-term memory here, not this conversation; a future sitting (or a dispatched worker) should be ' +
      'able to pick up from the tree alone.',
    '- `read_up` is on demand only — an ancestor node id, when you genuinely need context above wherever ' +
      'the focus pointer currently is. It returns a SUMMARY, never a transcript.',
  ];
  return lines.join('\n');
}

/** `[focus: #43 "Design refresh strategy" — path: A > B]`, or the root
 *  sentinel when nothing is zoomed in. Only shown when the pointer changed
 *  since the session's last message (see composeBrainWrappedText) — not on
 *  every turn, so the bar doesn't repeat itself. */
function buildFocusHeader(focusId: number | null): string {
  if (focusId === null) return '[focus: root — the whole tree]';
  const node = getSmartTodoNode(focusId);
  if (!node) return '[focus: root — the whole tree (the previously focused node no longer exists)]';
  const ancestors = ancestorChain(node);
  const path = ancestors.length ? ` — path: ${ancestors.map((a) => a.title).join(' > ')}` : '';
  return `[focus: #${node.id} "${node.title}"${path}]`;
}

/** What the CLIENT actually posts to `/threads/:ext/messages` after a
 *  `/workbench/say` call (2-step pattern — this never posts the message
 *  itself). `focusChanged` gates the header + subtree snapshot so a run of
 *  messages at the same focus doesn't repeat context every turn; otherwise
 *  it's Kevin's text, verbatim. */
function composeBrainWrappedText(focusId: number | null, focusChanged: boolean, text: string): string {
  if (!focusChanged) return text;
  const header = buildFocusHeader(focusId);
  const scope = getWorkbenchScope(focusId) ?? { node: null, ancestors: [], subtree: listSmartTodoNodes() };
  const snapshot = renderSubtreeDigest(scope);
  return [header, '', snapshot, '', text].join('\n');
}

export interface WorkbenchSayResult {
  external_id: string;
  seed_text: string | null;
  wrapped_text: string;
}

/** POST /workbench/say's full brain: find-or-create the session (+ bind its
 *  backing conversation), compose what the client should post, and stamp
 *  last_activity_at/the focus pointer for next time. Owns the session +
 *  conversation side effects itself — same "the route stays thin, the module
 *  owns the writes" shape as matchOrCreatePlacement above — so the route
 *  handler is just validation + one call. Never posts to
 *  /threads/:ext/messages itself (do NOT dispatch server-side — the client
 *  does the actual send, same 2-step pattern as hopper promote). */
export function composeBrainSay(
  text: string,
  focusId: number | null,
  opts: { forceNew?: boolean } = {},
): WorkbenchSayResult {
  const { session, isNew } = findOrCreateWorkbenchSession(opts);

  // Bind the underlying conversation the first time this session's thread is
  // actually used — mirrors /workbench/:id/open-chat's own
  // getOrCreateConversation + renameConversation pairing.
  const conv = getOrCreateConversation(session.thread_ext);
  if (isNew) renameConversation(conv.id, 'Workbench — brain');

  // REVIEW-V2 fix #4: the seed is only DELIVERED when the client's follow-up
  // POST /threads/:ext/messages succeeds (2-step pattern). Keying "needs seed"
  // off the session row's birth alone meant one failed first send left the
  // whole sitting seedless forever (the brain never learns what the board is).
  // Key it off the conversation instead: no turns yet = nothing has ever
  // reached the model = seed again. Idempotent — once a turn exists it stops.
  const needsSeed = isNew || countTurns(conv.id) === 0;

  const focusChanged = needsSeed || focusId !== session.last_focus_id;
  const seedText = needsSeed ? buildBrainSeedText() : null;
  const wrappedText = composeBrainWrappedText(focusId, focusChanged, text);

  touchWorkbenchSession(session.id, focusId);

  return { external_id: session.thread_ext, seed_text: seedText, wrapped_text: wrappedText };
}
