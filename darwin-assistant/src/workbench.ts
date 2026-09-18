// WORKBENCH — the idea tree as the place Kevin works.
//
// Duplicate of /tree at a new endpoint (per Kevin's hard constraint: /tree,
// /api/v1/smart-todos/*, and the smart_todos tool stay byte-for-byte unchanged —
// this is additive-only). Reads and writes the SAME `smart_todo_nodes` table via
// additive nullable columns; see docs/workbench/SPEC.md ("Data decision") and
// docs/workbench/RECON.md §3 for why that's safe.
//
// This file covers spec §1 (Zoom) and §5 (Placement — match-or-create on jot).
// Scoped chat writes / read_up / auto-notes (§2-4) live in a separate tool file
// (a later node) and are NOT implemented here.

import { execFile } from 'node:child_process';
import {
  getSmartTodoNode,
  listSmartTodoNodes,
  createSmartTodoNode,
  insertSmartTodoTree,
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
 *  since that function always creates a fresh root (see RECON.md §6 trap #4). */
function insertUnderParent(
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

  if (parentId !== null && confidence < CONFIDENCE_THRESHOLD) {
    reason = `${reason} (low confidence; filed at root instead of guessing)`;
    parentId = null;
  }
  // A parent that vanished between the shortlist build and here (deleted mid-flight) — refuse
  // the write, fall back to root rather than throwing.
  if (parentId !== null && !getSmartTodoNode(parentId)) {
    parentId = null;
  }

  const created: SmartTodoNodeRow[] = items.map((item) =>
    parentId === null ? insertSmartTodoTree(note, item, { group_id: groupId }) : insertUnderParent(parentId, item, { group_id: groupId }),
  );

  return {
    parent_id: parentId,
    confidence,
    reason,
    created,
    node: created[0] ?? null,
    nodes: listSmartTodoNodes(),
  };
}
