#!/usr/bin/env npx tsx
// Backfill Hopper tree handoff cards from historical node results.
//
// Default mode is dry-run. Use --apply to POST cards through the public
// /api/v1/hopper-trees/:id/handoff route. This script never reopens or reruns
// Hopper work; it only writes hopper_trees.handoff for done/archived trees that
// do not already have one.

import '../src/hopper-engine.js'; // side-effect: hopper_trees DDL + additive column migrations
import { sqliteDb } from '../src/conversation-db.js';
import fs from 'node:fs';

const API_BASE = (process.env.JARVIS_API_BASE ?? 'http://localhost:3201/api/v1').replace(/\/+$/, '');
const APPLY = process.argv.includes('--apply');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  if (idx === -1) return null;
  const n = parseInt(process.argv[idx + 1] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
})();

interface TreeRow {
  id: string;
  topic: string;
  status: 'done' | 'archived';
}

interface NodeRow {
  id: number;
  tree_id: string;
  title: string;
  result: string | null;
  updated_at: string;
}

const treeRows = sqliteDb
  .prepare<[], TreeRow>(
    `SELECT id, topic, status
     FROM hopper_trees
     WHERE status IN ('done', 'archived')
       AND (handoff IS NULL OR trim(handoff) = '')
     ORDER BY updated_at DESC`,
  )
  .all();

const nodesForTree = sqliteDb.prepare<[string], NodeRow>(
  `SELECT id, tree_id, title, result, updated_at
   FROM hopper_nodes
   WHERE tree_id = ?
   ORDER BY id`,
);

function readApiKey(): string | null {
  if (process.env.JARVIS_COCKPIT_KEY?.trim()) return process.env.JARVIS_COCKPIT_KEY.trim();
  const envPath = '/home/kevin/paperclip/jarvis-command-center/.env';
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    const line = raw.split(/\r?\n/).find((l) => /^JARVIS_COCKPIT_KEY=/.test(l));
    return line?.split('=').slice(1).join('=').trim() || null;
  } catch {
    return null;
  }
}

function resultText(node: NodeRow | null | undefined): string {
  return node?.result?.trim() || '';
}

function sanitizeBackfillText(text: string): string {
  return text
    .replaceAll('/home/kevin/obsidian/paperclip-wiki/', '')
    .replace(/\/home\/kevin\/paperclip-worktrees\/([^/\s`'")]+)\//g, 'worktree $1: ');
}

function allResultText(nodes: NodeRow[]): string {
  return sanitizeBackfillText(nodes.map((n) => resultText(n)).filter(Boolean).join('\n\n'));
}

function scoreDocsNode(node: NodeRow): number {
  const title = node.title.toLowerCase();
  const result = resultText(node).toLowerCase();
  let score = 0;
  if (/\b(doc|docs|documentation|push|report|handoff)\b/.test(title)) score += 4;
  if (/\boutbox\//.test(result)) score += 5;
  if (/\bbranches?\b/.test(result)) score += 2;
  if (/\bdeferred\b/.test(result)) score += 1;
  return score;
}

function findDocsNode(nodes: NodeRow[]): NodeRow | null {
  const scored = nodes
    .filter((n) => resultText(n))
    .map((n) => ({ node: n, score: scoreDocsNode(n) }))
    .sort((a, b) => b.score - a.score || b.node.id - a.node.id);
  return scored[0]?.node ?? nodes.filter((n) => resultText(n)).sort((a, b) => b.id - a.id)[0] ?? null;
}

function extractOutboxPath(text: string): string | null {
  const match = text.match(/\boutbox\/[A-Za-z0-9._/-]+\.md\b/);
  return match?.[0] ?? null;
}

function extractExistingBranchTable(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!/^\|/.test(line)) continue;
    if (!/Order/i.test(line) || !/Repo/i.test(line) || !/Branch/i.test(line) || !/Head/i.test(line) || !/Notes/i.test(line)) continue;
    const table: string[] = [];
    for (let j = i; j < lines.length; j++) {
      const row = lines[j].trim();
      if (!row.startsWith('|')) break;
      table.push(row);
    }
    if (table.length >= 2) return table.join('\n');
  }
  return null;
}

function looksLikeBranchToken(value: string): boolean {
  if (!value.includes('/')) return false;
  if (value.includes('://')) return false;
  if (value.startsWith('/') || value.startsWith('outbox/') || value.startsWith('api/')) return false;
  if (/\.md$/i.test(value)) return false;
  if (/\s/.test(value)) return false;
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

function cleanBranchToken(value: string): string | null {
  const branch = value.trim().replace(/[.,;:)]+$/g, '');
  return looksLikeBranchToken(branch) ? branch : null;
}

function extractBranchTokens(text: string): string[] {
  const branches = new Set<string>();
  const codeSpanRe = /`([^`]+)`/g;
  let match: RegExpExecArray | null;
  while ((match = codeSpanRe.exec(text))) {
    const branch = cleanBranchToken(match[1]);
    if (branch) branches.add(branch);
  }
  const namedBranchRe = /\b(?:branch|on)\s+([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)/gi;
  while ((match = namedBranchRe.exec(text))) {
    const branch = cleanBranchToken(match[1]);
    if (branch) branches.add(branch);
  }
  const hopperBranchRe = /\bhopper\/[\w./-]+/g;
  while ((match = hopperBranchRe.exec(text))) {
    const branch = cleanBranchToken(match[0]);
    if (branch) branches.add(branch);
  }
  return Array.from(branches).slice(0, 8);
}

function extractHead(text: string): string {
  const match = text.match(/\b(?:head|commit|sha)\s*:?\s*`?([0-9a-f]{7,40})`?/i);
  return match?.[1]?.slice(0, 12) ?? 'unknown';
}

function branchTable(text: string): string {
  const existing = extractExistingBranchTable(text);
  if (existing) return existing;
  const branches = extractBranchTokens(text);
  const head = extractHead(text);
  if (!branches.length) {
    return [
      '| Order | Repo | Branch | Head | Notes |',
      '| --- | --- | --- | --- | --- |',
      `| 1 | unknown | unknown | ${head} | not recoverable from node results - read the full report |`,
    ].join('\n');
  }
  return [
    '| Order | Repo | Branch | Head | Notes |',
    '| --- | --- | --- | --- | --- |',
    ...branches.map((branch, i) =>
      `| ${i + 1} | unknown | \`${branch}\` | ${head} | _backfilled from node results_; verify repo and deploy step before use. |`,
    ),
  ].join('\n');
}

function summaryBullets(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith('|'))
    .filter((l) => !/^#+\s/.test(l))
    .filter((l) => !/^Full report:/i.test(l))
    .filter((l) => !/^Branches:/i.test(l))
    .filter((l) => !/^Deferred:/i.test(l))
    .slice(0, 4);
  if (!lines.length) {
    return ['- Completed historical Hopper tree; no concise docs-node summary was available.'];
  }
  return lines.map((l) => {
    const clean = l.replace(/^[-*]\s+/, '').slice(0, 220);
    return `- ${clean}`;
  });
}

function deferredBullets(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^Deferred:/i.test(l.trim()) || /^##\s+Next steps \/ deferred/i.test(l.trim()));
  if (start === -1) return ['- None found in historical node results.'];
  const found: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (found.length) break;
      continue;
    }
    if (/^##\s+/.test(trimmed)) break;
    if (trimmed.startsWith('|')) continue;
    found.push(trimmed.startsWith('-') ? trimmed : `- ${trimmed}`);
    if (found.length >= 6) break;
  }
  return found.length ? found : ['- None found in historical node results.'];
}

function buildHandoff(tree: TreeRow, nodes: NodeRow[], docsNode: NodeRow | null): string {
  const docsText = sanitizeBackfillText(resultText(docsNode));
  const allText = allResultText(nodes);
  const outboxPath = extractOutboxPath(allText);
  return [
    `# ${tree.topic} handoff`,
    '',
    `Tree: \`${tree.id}\``,
    'Status: final',
    'Backfilled: yes',
    '_backfilled from node results_',
    '',
    '## What was built',
    '',
    ...summaryBullets(docsText),
    '',
    '## Branches & how to install',
    '',
    branchTable(allText),
    '',
    '## How to use it',
    '',
    '1. Review this best-effort handoff and the full report or historical tree detail.',
    '2. Pull, deploy, or intentionally ignore the listed branches/artifacts in order after verifying the notes.',
    '',
    '## Next steps / deferred',
    '',
    '- _backfilled from node results_; verify against the full report before deploy.',
    ...deferredBullets(docsText),
    '',
    '## Full report',
    '',
    outboxPath
      ? `- Full report: \`${outboxPath}\``
      : '- Full report: not found in historical node results',
  ].join('\n').slice(0, 20_000);
}

async function postHandoff(treeId: string, handoff: string, key: string): Promise<void> {
  const res = await fetch(`${API_BASE}/hopper-trees/${encodeURIComponent(treeId)}/handoff`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ handoff, force: false }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
}

async function main(): Promise<void> {
  const trees = LIMIT ? treeRows.slice(0, LIMIT) : treeRows;
  const key = APPLY ? readApiKey() : null;
  if (APPLY && !key) throw new Error('JARVIS_COCKPIT_KEY is required for --apply');

  console.log(`[backfill-tree-handoffs] ${APPLY ? 'apply' : 'dry-run'} - ${trees.length} tree(s)`);
  let written = 0;
  let failed = 0;
  for (const tree of trees) {
    const nodes = nodesForTree.all(tree.id);
    const docsNode = findDocsNode(nodes);
    const allText = allResultText(nodes);
    const handoff = buildHandoff(tree, nodes, docsNode);
    const report = extractOutboxPath(allText) ?? 'no report path';
    console.log(`- ${tree.id} ${tree.status} - ${tree.topic} - docs node ${docsNode?.id ?? 'none'} - ${report}`);
    if (!APPLY) continue;
    try {
      await postHandoff(tree.id, handoff, key!);
      written++;
    } catch (err) {
      failed++;
      console.error(`  FAILED ${tree.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (APPLY) console.log(`[backfill-tree-handoffs] wrote ${written}, failed ${failed}`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[backfill-tree-handoffs] fatal:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
