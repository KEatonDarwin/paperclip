import { randomUUID } from 'node:crypto';
import './spawn-tasks.js'; // side-effect: guarantees the spawn_tasks DDL ran before we prepare against it
import { sqliteDb, getOrCreateConversation, renameConversation, setThreadModelOverride } from './conversation-db.js';
import { sseBus, type HopperNodeEvent } from './sse-bus.js';
import { createNotification } from './notifications.js';
import { governorCheck } from './hopper-governor.js';

// HOPPER ENGINE — the autonomous work-tree executor (designed 2026-09-06 with
// Kevin; worker-model details hashed out in cockpit:worker-engine-design-2026-09-06).
//
// Two-table architecture, deliberately:
//   • hopper_trees / hopper_nodes  = the durable WORK TREE (server-owned state)
//   • spawn_tasks                  = execution ATTEMPTS against a node
// One node → zero-or-many worker runs. "Server owns state, model owns story."
//
// Dispatch is EVENT-DRIVEN PLAIN CODE — dispatchTick() runs after every node
// state write plus a slow safety interval. Zero model calls at rest; seconds
// (not heartbeat-minutes) between a node finishing and its dependents starting.
// Workers are EPHEMERAL cockpit threads: born with one leaf + injected context,
// they report back through the finish endpoint and die. The queue IS the inbox.
//
// Recovery is lease-based and non-destructive (same rules as the watchdog):
// an expired lease re-queues the node, max MAX_ATTEMPTS ever, then it parks
// `blocked` with a notification — never a silent stall, never a hot retry loop.

export type HopperNodeStatus =
  | 'draft'            // authored during the breakdown/confirm loop; never dispatches
  | 'pending'          // agreed + waiting for deps/slot
  | 'running'          // claimed by a worker under lease
  | 'done'
  | 'split'            // worker decomposed it into children (terminal for this node)
  | 'blocked'          // recovery exhausted or worker hit a wall — needs a human
  | 'blocked_question'; // worker needs ONE answer from Kevin; resumes on /answer

export interface HopperTreeRow {
  id: string;
  topic: string;
  origin_thread_ext: string | null;
  status: 'draft' | 'active' | 'done' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface HopperNodeRow {
  id: number;
  tree_id: string;
  parent_id: number | null;
  title: string;
  spec: string | null;
  status: HopperNodeStatus;
  depends_on: string | null;      // JSON array of sibling/other node ids
  priority: number;
  attempts: number;
  question: string | null;
  answer: string | null;
  result: string | null;
  worker_thread_ext: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

const MAX_SLOTS = Math.max(1, parseInt(process.env.HOPPER_ENGINE_SLOTS ?? '2', 10) || 2);
const LEASE_MINUTES = Math.max(5, parseInt(process.env.HOPPER_ENGINE_LEASE_MIN ?? '30', 10) || 30);
const MAX_ATTEMPTS = 2;
// Pin worker threads to a specific adapter/model so an expensive global model
// (Fable) doesn't silently become the overnight fleet's engine. Unset = inherit.
const WORKER_ADAPTER = process.env.HOPPER_WORKER_ADAPTER ?? 'claude';
const WORKER_MODEL = process.env.HOPPER_WORKER_MODEL || null;

sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS hopper_trees (
    id                TEXT PRIMARY KEY,
    topic             TEXT NOT NULL,
    origin_thread_ext TEXT,
    status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','done','archived')),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS hopper_nodes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    tree_id          TEXT NOT NULL REFERENCES hopper_trees(id),
    parent_id        INTEGER REFERENCES hopper_nodes(id),
    title            TEXT NOT NULL,
    spec             TEXT,
    status           TEXT NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','pending','running','done','split','blocked','blocked_question')),
    depends_on       TEXT,
    priority         INTEGER NOT NULL DEFAULT 0,
    attempts         INTEGER NOT NULL DEFAULT 0,
    question         TEXT,
    answer           TEXT,
    result           TEXT,
    worker_thread_ext TEXT,
    lease_expires_at TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_hopper_nodes_tree ON hopper_nodes(tree_id, id);
  CREATE INDEX IF NOT EXISTS idx_hopper_nodes_status ON hopper_nodes(status, priority DESC, id);
`);

const getTreeStmt = sqliteDb.prepare<[string], HopperTreeRow>(`SELECT * FROM hopper_trees WHERE id = ?`);
const listTreesStmt = sqliteDb.prepare<[], HopperTreeRow>(`SELECT * FROM hopper_trees ORDER BY created_at DESC LIMIT 100`);
const getNodeStmt = sqliteDb.prepare<[number], HopperNodeRow>(`SELECT * FROM hopper_nodes WHERE id = ?`);
const treeNodesStmt = sqliteDb.prepare<[string], HopperNodeRow>(`SELECT * FROM hopper_nodes WHERE tree_id = ? ORDER BY id`);
const childrenStmt = sqliteDb.prepare<[number], HopperNodeRow>(`SELECT * FROM hopper_nodes WHERE parent_id = ? ORDER BY id`);
const runningCountStmt = sqliteDb.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM hopper_nodes WHERE status = 'running'`);

// A node is DISPATCHABLE only if it's a pending LEAF (no children) in an active
// tree — parents are containers that auto-complete off their children.
const readyLeavesStmt = sqliteDb.prepare<[], HopperNodeRow>(`
  SELECT n.* FROM hopper_nodes n
  JOIN hopper_trees t ON t.id = n.tree_id AND t.status = 'active'
  WHERE n.status = 'pending'
    AND NOT EXISTS (SELECT 1 FROM hopper_nodes c WHERE c.parent_id = n.id)
  ORDER BY n.priority DESC, n.id ASC
`);

const claimStmt = sqliteDb.prepare<[string, string, number]>(`
  UPDATE hopper_nodes
  SET status = 'running', attempts = attempts + 1, worker_thread_ext = ?,
      lease_expires_at = datetime('now', ?), updated_at = datetime('now')
  WHERE id = ? AND status = 'pending'
`);

const expiredLeasesStmt = sqliteDb.prepare<[], HopperNodeRow>(`
  SELECT * FROM hopper_nodes WHERE status = 'running' AND lease_expires_at < datetime('now')
`);

function emitNode(action: HopperNodeEvent['action'], node: HopperNodeRow): void {
  sseBus.emit('sse', { type: 'hopper_node', action, node } satisfies HopperNodeEvent);
}

function setNode(id: number, fields: Partial<Record<keyof HopperNodeRow, unknown>>): HopperNodeRow | null {
  const keys = Object.keys(fields);
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    sqliteDb
      .prepare(`UPDATE hopper_nodes SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
      .run(...keys.map((k) => (fields as Record<string, unknown>)[k]), id);
  }
  const row = getNodeStmt.get(id) ?? null;
  if (row) emitNode('updated', row);
  return row;
}

export function getHopperTree(id: string): HopperTreeRow | null {
  return getTreeStmt.get(id) ?? null;
}
export function listHopperTrees(): HopperTreeRow[] {
  return listTreesStmt.all();
}
export function getHopperNode(id: number): HopperNodeRow | null {
  return getNodeStmt.get(id) ?? null;
}
export function listTreeNodes(treeId: string): HopperNodeRow[] {
  return treeNodesStmt.all(treeId);
}

export interface NewNodeInput {
  title: string;
  spec?: string | null;
  parent_index?: number | null;      // index into the same input array
  depends_on_indexes?: number[];     // indexes into the same input array
  priority?: number;
}

/** Create a tree + its draft nodes in one shot (the breakdown chat calls this). */
export function createHopperTree(topic: string, originThreadExt: string | null, nodes: NewNodeInput[]): {
  tree: HopperTreeRow;
  nodes: HopperNodeRow[];
} {
  const treeId = `tree-${randomUUID().slice(0, 8)}`;
  sqliteDb
    .prepare(`INSERT INTO hopper_trees (id, topic, origin_thread_ext) VALUES (?, ?, ?)`)
    .run(treeId, topic.slice(0, 300), originThreadExt);
  const ids: number[] = [];
  const insert = sqliteDb.prepare(
    `INSERT INTO hopper_nodes (tree_id, parent_id, title, spec, priority) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const n of nodes) {
    const parentId =
      n.parent_index != null && n.parent_index >= 0 && n.parent_index < ids.length ? ids[n.parent_index] : null;
    const info = insert.run(treeId, parentId, n.title.slice(0, 300), n.spec ?? null, n.priority ?? 0);
    ids.push(Number(info.lastInsertRowid));
  }
  // Second pass: map depends_on indexes → real ids (forward refs allowed).
  const setDeps = sqliteDb.prepare(`UPDATE hopper_nodes SET depends_on = ? WHERE id = ?`);
  nodes.forEach((n, i) => {
    const deps = (n.depends_on_indexes ?? []).filter((d) => d >= 0 && d < ids.length && d !== i).map((d) => ids[d]);
    if (deps.length) setDeps.run(JSON.stringify(deps), ids[i]);
  });
  const created = listTreeNodes(treeId);
  created.forEach((n) => emitNode('created', n));
  return { tree: getHopperTree(treeId)!, nodes: created };
}

/** Kevin's "yep that looks good" — flips the whole tree live and starts dispatch. */
export function agreeHopperTree(treeId: string): HopperTreeRow | null {
  const tree = getHopperTree(treeId);
  if (!tree) return null;
  sqliteDb.prepare(`UPDATE hopper_trees SET status = 'active', updated_at = datetime('now') WHERE id = ?`).run(treeId);
  sqliteDb
    .prepare(`UPDATE hopper_nodes SET status = 'pending', updated_at = datetime('now') WHERE tree_id = ? AND status = 'draft'`)
    .run(treeId);
  listTreeNodes(treeId).forEach((n) => emitNode('updated', n));
  queueMicrotask(() => void dispatchTick('tree_agreed'));
  return getHopperTree(treeId);
}

function depsSatisfied(node: HopperNodeRow): boolean {
  if (!node.depends_on) return true;
  try {
    const deps = JSON.parse(node.depends_on) as number[];
    return deps.every((d) => {
      const dep = getNodeStmt.get(d);
      return !dep || dep.status === 'done' || dep.status === 'split';
    });
  } catch {
    return true;
  }
}

function depResults(node: HopperNodeRow): Array<{ title: string; result: string }> {
  if (!node.depends_on) return [];
  try {
    const deps = JSON.parse(node.depends_on) as number[];
    return deps
      .map((d) => getNodeStmt.get(d))
      .filter((d): d is HopperNodeRow => !!d && !!d.result)
      .map((d) => ({ title: d.title, result: d.result! }));
  } catch {
    return [];
  }
}

/** The one prompt a worker is born with: guardrails + the leaf + the finish contract. */
function composeWorkerPrompt(node: HopperNodeRow, tree: HopperTreeRow): string {
  const deps = depResults(node);
  const lines: string[] = [
    `You are a SPAWNED HOPPER-ENGINE WORKER — an ephemeral JARVIS instance born to complete ONE task, report the result, and stop. You are not a conversation; nobody will reply to your messages. Kevin sees your work through the tree, not this thread.`,
    '',
    `**Project (tree ${tree.id}):** ${tree.topic}`,
    `**Your task (node #${node.id}):** ${node.title}`,
  ];
  if (node.spec) lines.push('', '**Spec:**', node.spec);
  if (node.answer) lines.push('', `**Kevin answered a previous blocking question on this task:**`, `Q: ${node.question ?? '(see spec)'}`, `A: ${node.answer}`);
  if (deps.length) {
    lines.push('', '**Results from tasks this one depends on:**');
    for (const d of deps) lines.push(`- ${d.title}: ${d.result.slice(0, 1500)}`);
  }
  lines.push(
    '',
    '**Guardrails (hard):** no touching live production systems/databases, no merging to main, no external sends (Slack/email/PRs) under Kevin\'s identity, no new spend, and NO API KEYS for model calls — subscription CLI binaries only.',
    '',
    '**FINISH CONTRACT — mandatory.** Your final act MUST be exactly one curl to the hopper engine (bearer key = JARVIS_COCKPIT_KEY in /home/kevin/paperclip/jarvis-command-center/.env). Ending your turn without calling it counts as a failed attempt.',
    '```',
    `KEY=$(grep -E '^JARVIS_COCKPIT_KEY=' /home/kevin/paperclip/jarvis-command-center/.env | head -1 | cut -d= -f2)`,
    `curl -s -X POST http://localhost:3201/api/v1/hopper-nodes/${node.id}/finish -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '<PAYLOAD>'`,
    '```',
    'Pick ONE payload:',
    `- Task complete → {"outcome":"done","result":"<what you did + artifacts/paths/commits, concise but complete — dependents read this>"}`,
    `- Task too big for one worker → {"outcome":"split","children":[{"title":"...","spec":"...","depends_on_prev":false}, ...]} — make NO changes yourself; you exited as a planner. Set depends_on_prev true on a child that must wait for the one before it.`,
    `- You need ONE decision only Kevin can make → {"outcome":"blocked_question","question":"<the single question, with enough context to answer cold>"} — then stop; a fresh worker resumes with his answer.`,
    `- Genuinely stuck (missing access, broken dependency) → {"outcome":"blocked","result":"<why, precisely>"}`,
    '',
    'Work efficiently, verify what you build, and do not gold-plate. Begin now.',
  );
  return lines.join('\n');
}

let processMessageRef: ((input: string, conversationId: string, messageId?: string) => Promise<string>) | null = null;

/** index.ts hands us processMessage at startup — avoids a circular import with agent.ts. */
export function startHopperEngine(processMessage: (input: string, conversationId: string, messageId?: string) => Promise<string>): void {
  processMessageRef = processMessage;
  setInterval(() => void dispatchTick('interval'), 60_000).unref?.();
  queueMicrotask(() => void dispatchTick('startup'));
  console.log(`[hopper-engine] started · slots=${MAX_SLOTS} lease=${LEASE_MINUTES}m maxAttempts=${MAX_ATTEMPTS}`);
}

const spawnTaskInsert = sqliteDb.prepare(`
  INSERT OR IGNORE INTO spawn_tasks (thread_ext, conversation_id, parent_thread_ext, label, task_prompt, status)
  VALUES (?, ?, ?, ?, ?, 'running')
`);

async function spawnWorker(node: HopperNodeRow, tree: HopperTreeRow): Promise<void> {
  if (!processMessageRef) return;
  const ext = node.worker_thread_ext!;
  const conv = getOrCreateConversation(ext);
  renameConversation(conv.id, `⚙️ ${node.title.slice(0, 100)}`);
  if (WORKER_MODEL) setThreadModelOverride(conv.id, WORKER_ADAPTER, WORKER_MODEL);
  const prompt = composeWorkerPrompt(node, tree);
  spawnTaskInsert.run(ext, conv.id, tree.origin_thread_ext, `hopper #${node.id}: ${node.title.slice(0, 80)}`, prompt.slice(0, 2000));
  try {
    await processMessageRef(prompt, ext, `turn:${conv.id}:0`);
  } catch (err) {
    // Spawn itself failed (busy/adapter error) — release the claim so the node
    // re-dispatches rather than burning its lease doing nothing.
    console.error(`[hopper-engine] spawn failed for node ${node.id}:`, err);
    setNode(node.id, { status: 'pending', worker_thread_ext: null, lease_expires_at: null });
  }
}

/** Bubble completion up the tree: a parent with all children settled flips done. */
function settleAncestors(node: HopperNodeRow): void {
  if (node.parent_id == null) {
    maybeFinishTree(node.tree_id);
    return;
  }
  const parent = getNodeStmt.get(node.parent_id);
  if (!parent || parent.status === 'done') return;
  const kids = childrenStmt.all(parent.id);
  const allSettled = kids.every((k) => k.status === 'done' || k.status === 'split');
  if (allSettled) {
    const updated = setNode(parent.id, {
      status: 'done',
      result: kids.map((k) => `[${k.title}] ${k.result ?? '(split into subtasks)'}`).join('\n').slice(0, 8000),
    });
    if (updated) settleAncestors(updated);
  } else {
    maybeFinishTree(node.tree_id);
  }
}

function maybeFinishTree(treeId: string): void {
  const tree = getHopperTree(treeId);
  if (!tree || tree.status !== 'active') return;
  const nodes = listTreeNodes(treeId);
  if (nodes.length && nodes.every((n) => n.status === 'done' || n.status === 'split')) {
    sqliteDb.prepare(`UPDATE hopper_trees SET status = 'done', updated_at = datetime('now') WHERE id = ?`).run(treeId);
    createNotification({
      severity: 'success',
      title: `🌳 Hopper tree complete: ${tree.topic.slice(0, 120)}`,
      body: `All ${nodes.length} tasks are done. Tree ${treeId}.`,
      source: 'hopper-engine',
    });
  }
}

/** Worker report-back — the ONE place execution writes tree state. */
export function finishHopperNode(
  id: number,
  outcome: 'done' | 'split' | 'blocked_question' | 'blocked',
  payload: { result?: string; question?: string; children?: Array<{ title: string; spec?: string; depends_on_prev?: boolean }> },
): HopperNodeRow | null {
  const node = getNodeStmt.get(id);
  if (!node || node.status !== 'running') return node ?? null;
  const tree = getHopperTree(node.tree_id);

  if (outcome === 'done') {
    const updated = setNode(id, { status: 'done', result: payload.result ?? '(no result text)', lease_expires_at: null });
    if (updated) settleAncestors(updated);
  } else if (outcome === 'split' && payload.children?.length) {
    const insert = sqliteDb.prepare(
      `INSERT INTO hopper_nodes (tree_id, parent_id, title, spec, status, depends_on) VALUES (?, ?, ?, ?, 'pending', ?)`,
    );
    let prevId: number | null = null;
    for (const c of payload.children.slice(0, 12)) {
      const deps = c.depends_on_prev && prevId != null ? JSON.stringify([prevId]) : null;
      const info = insert.run(node.tree_id, node.id, c.title.slice(0, 300), c.spec ?? null, deps);
      prevId = Number(info.lastInsertRowid);
      const created = getNodeStmt.get(prevId);
      if (created) emitNode('created', created);
    }
    setNode(id, { status: 'split', lease_expires_at: null });
  } else if (outcome === 'blocked_question') {
    setNode(id, { status: 'blocked_question', question: payload.question ?? '(no question text)', lease_expires_at: null });
    createNotification({
      severity: 'warning',
      title: `❓ Hopper worker needs your call: ${node.title.slice(0, 100)}`,
      body: `${payload.question ?? ''}\n\n(Answer from any JARVIS chat: "answer hopper node ${id}: <your answer>" — a fresh worker resumes with it.)`,
      source: 'hopper-engine',
    });
  } else {
    setNode(id, { status: 'blocked', result: payload.result ?? null, lease_expires_at: null });
    createNotification({
      severity: 'error',
      title: `🚧 Hopper task blocked: ${node.title.slice(0, 100)}`,
      body: `${payload.result ?? 'No reason given.'}\nNode ${id}, tree ${node.tree_id}.`,
      source: 'hopper-engine',
    });
  }
  queueMicrotask(() => void dispatchTick('node_finished'));
  return getNodeStmt.get(id) ?? null;
}

/** Kevin answers a blocking question → node re-queues with the answer injected. */
export function answerHopperNode(id: number, answer: string): HopperNodeRow | null {
  const node = getNodeStmt.get(id);
  if (!node || node.status !== 'blocked_question') return node ?? null;
  const updated = setNode(id, { status: 'pending', answer, worker_thread_ext: null });
  queueMicrotask(() => void dispatchTick('question_answered'));
  return updated;
}

let ticking = false;

/** The dispatcher. Plain code, no model calls: requeue expired leases, then fill free slots. */
export async function dispatchTick(reason: string): Promise<void> {
  if (ticking || !processMessageRef) return; // no re-entrancy; engine not started = no-op
  ticking = true;
  try {
    // 1) Expired leases → non-destructive recovery (max MAX_ATTEMPTS, then park).
    for (const node of expiredLeasesStmt.all()) {
      if (node.attempts >= MAX_ATTEMPTS) {
        setNode(node.id, { status: 'blocked', lease_expires_at: null });
        createNotification({
          severity: 'error',
          title: `🚧 Hopper task exhausted retries: ${node.title.slice(0, 100)}`,
          body: `${node.attempts} attempts, lease expired without a finish report. Node ${node.id}, tree ${node.tree_id}. Needs a human.`,
          source: 'hopper-engine',
        });
      } else {
        setNode(node.id, { status: 'pending', worker_thread_ext: null, lease_expires_at: null });
      }
    }

    // 2) The governor gates every NEW claim (lease recovery above always runs;
    //    running workers are never interrupted). Held = wait for the next tick.
    if (!governorCheck().allow) return;

    // 3) Fill free slots with ready leaves (deps satisfied), priority order.
    let free = MAX_SLOTS - (runningCountStmt.get()?.n ?? 0);
    if (free <= 0) return;
    for (const node of readyLeavesStmt.all()) {
      if (free <= 0) break;
      if (!depsSatisfied(node)) continue;
      const ext = `cockpit:hopper-node-${node.id}-${randomUUID().slice(0, 8)}`;
      const claimed = claimStmt.run(ext, `+${LEASE_MINUTES} minutes`, node.id);
      if (claimed.changes !== 1) continue; // raced — someone else claimed it
      const fresh = getNodeStmt.get(node.id)!;
      emitNode('updated', fresh);
      const tree = getHopperTree(node.tree_id)!;
      free -= 1;
      console.log(`[hopper-engine] dispatch node ${node.id} (${reason}) → ${ext}`);
      void spawnWorker(fresh, tree);
    }
  } finally {
    ticking = false;
  }
}
