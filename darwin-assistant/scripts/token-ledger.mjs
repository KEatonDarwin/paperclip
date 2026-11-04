#!/usr/bin/env node
// token-ledger — "where did the tokens actually go?"
//
// Kevin's ask (2026-09-24, after an overnight run burned a week of Claude A on
// duplicate work): "count the tokens being used per 'thing' and turn it into a
// percentage… so in a post mortem I can say 'I can see all of these tokens going
// to this one specific thing, looks like there's a problem' rather than asking
// you and having you guess."
//
// No new instrumentation: every model turn already records input/output/cache
// tokens + model in `turns`. The only missing piece was ATTRIBUTION — turning a
// conversation's external_id into the piece of WORK it belongs to. That chain is
// deterministic and already in the DB:
//
//   cockpit:hopper-node-<nodeId>-<hex>  -> hopper_nodes -> tree -> goal_nodes -> goal
//   cockpit:goal-<g>[-node-<n>]         -> goal
//   everything else                     -> its own named bucket
//
// So a worker spawned three levels down still bills to the goal that caused it,
// which is what makes "this one specific thing" legible.
//
// Usage: node scripts/token-ledger.mjs [--hours 24] [--since 2026-09-23] [--json] [--limit 20]

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB = process.env.JARVIS_DB_PATH ?? path.join(HERE, '..', 'jarvis.db');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const hours = Number(flag('hours', '24'));
const since = flag('since', null);
const limit = Number(flag('limit', '20'));
const asJson = argv.includes('--json');

const db = new Database(DB, { readonly: true });
const cutoff = since ? `'${since}'` : `datetime('now','-${hours} hours')`;

// One row per model turn, already joined to its conversation.
const rows = db.prepare(`
  SELECT t.id, t.model, c.external_id,
         COALESCE(t.input_tokens,0)       AS inp,
         COALESCE(t.output_tokens,0)      AS outp,
         COALESCE(t.cache_read_tokens,0)  AS cread,
         COALESCE(t.cache_write_tokens,0) AS cwrite
  FROM turns t JOIN conversations c ON c.id = t.conversation_id
  WHERE t.created_at > ${cutoff} AND t.input_tokens IS NOT NULL
`).all();

// --- attribution lookups (built once) ---------------------------------------
const nodeToTree = new Map();
for (const r of db.prepare(`SELECT id, tree_id FROM hopper_nodes`).all()) nodeToTree.set(r.id, r.tree_id);

const treeToGoal = new Map();
// goal_nodes.tree_id only remembers a node's LATEST tree, so every tree from an
// earlier re-plan round loses its link and bills as an anonymous "tree …" row —
// which is exactly backwards, because a goal that re-planned nine times is the
// one you most need to see as a single number. goal_events keeps the full
// history (one `tree_planted` row per tree ever planted), so use it as the
// primary source and let goal_nodes fill any gap.
for (const r of db.prepare(`
  SELECT ge.data, ge.goal_id, g.title
  FROM goal_events ge JOIN goals g ON g.id = ge.goal_id
  WHERE ge.kind = 'tree_planted' AND ge.data IS NOT NULL
`).all()) {
  try {
    const treeId = JSON.parse(r.data)?.tree_id;
    if (treeId) treeToGoal.set(treeId, { id: r.goal_id, title: r.title });
  } catch { /* a malformed event must never break the ledger */ }
}
for (const r of db.prepare(`
  SELECT gn.tree_id, g.id AS goal_id, g.title
  FROM goal_nodes gn JOIN goals g ON g.id = gn.goal_id
  WHERE gn.tree_id IS NOT NULL
`).all()) if (!treeToGoal.has(r.tree_id)) treeToGoal.set(r.tree_id, { id: r.goal_id, title: r.title });

const goalTitle = new Map();
for (const r of db.prepare(`SELECT id, title FROM goals`).all()) goalTitle.set(r.id, r.title);

const treeTopic = new Map();
for (const r of db.prepare(`SELECT id, topic FROM hopper_trees`).all()) treeTopic.set(r.id, r.topic);

const short = (s, n = 44) => (!s ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s);
const goalLabel = (id) => `goal ${id} · ${short(goalTitle.get(id) ?? '?', 38)}`;

/** external_id -> { bucket, lane } . lane = how the tokens were spent. */
function attribute(ext) {
  let m;
  if ((m = /^cockpit:hopper-node-(\d+)-/.exec(ext))) {
    const treeId = nodeToTree.get(Number(m[1]));
    if (treeId) {
      const goal = treeToGoal.get(treeId);
      if (goal) return { bucket: goalLabel(goal.id), lane: 'tree worker' };
      return { bucket: `tree ${treeId} · ${short(treeTopic.get(treeId) ?? '?', 34)}`, lane: 'tree worker' };
    }
    return { bucket: 'hopper worker (orphaned node)', lane: 'tree worker' };
  }
  if ((m = /^cockpit:goal-(\d+)(?:-node-\d+)?$/.exec(ext))) {
    return { bucket: goalLabel(Number(m[1])), lane: m[0].includes('-node-') ? 'node chat' : 'goal chat' };
  }
  if (/^cockpit:workstream-/.test(ext))  return { bucket: 'flight deck · workstream chats', lane: 'chat' };
  if (/^cockpit:night-shift/.test(ext))  return { bucket: 'night shift orchestrator',       lane: 'chat' };
  if (/^cockpit:critic-loop/.test(ext))  return { bucket: 'critic loop design',              lane: 'chat' };
  if (/^cockpit:jarvis-nudges/.test(ext))return { bucket: 'jarvis nudges',                   lane: 'chat' };
  if (/^quick:/.test(ext))               return { bucket: 'quick chats',                     lane: 'chat' };
  if (/^slack:/.test(ext))               return { bucket: 'slack',                           lane: 'chat' };
  return { bucket: 'interactive cockpit chats', lane: 'chat' };
}

// --- aggregate ---------------------------------------------------------------
const buckets = new Map();
let grand = 0;
const byModel = new Map();
for (const r of rows) {
  const tot = r.inp + r.outp + r.cread + r.cwrite;
  grand += tot;
  const { bucket, lane } = attribute(r.external_id);
  const b = buckets.get(bucket) ?? { bucket, tot: 0, turns: 0, inp: 0, outp: 0, cache: 0, lanes: new Set() };
  b.tot += tot; b.turns += 1; b.inp += r.inp; b.outp += r.outp; b.cache += r.cread + r.cwrite;
  b.lanes.add(lane);
  buckets.set(bucket, b);
  const mk = r.model ?? 'unknown';
  byModel.set(mk, (byModel.get(mk) ?? 0) + tot);
}

const ranked = [...buckets.values()].sort((a, b) => b.tot - a.tot);
const pct = (v) => (grand ? (100 * v) / grand : 0);
const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n));

if (asJson) {
  console.log(JSON.stringify({
    window: since ? `since ${since}` : `last ${hours}h`,
    total_tokens: grand, turns: rows.length,
    buckets: ranked.map((b) => ({ thing: b.bucket, tokens: b.tot, pct: +pct(b.tot).toFixed(2), turns: b.turns,
      input: b.inp, output: b.outp, cache: b.cache, lanes: [...b.lanes] })),
    by_model: Object.fromEntries([...byModel.entries()].sort((a, b) => b[1] - a[1])),
  }, null, 2));
} else {
  const win = since ? `since ${since}` : `last ${hours}h`;
  console.log(`\n  TOKEN LEDGER — ${win}   ${fmt(grand)} tokens across ${rows.length} model turns\n`);
  console.log('  ' + 'WHERE THEY WENT'.padEnd(46) + 'TOKENS'.padStart(8) + '     %  ' + 'TURNS'.padStart(6) + '  HOW');
  console.log('  ' + '─'.repeat(46) + ' ' + '─'.repeat(7) + ' ' + '─'.repeat(6) + ' ' + '─'.repeat(6) + '  ' + '─'.repeat(18));
  for (const b of ranked.slice(0, limit)) {
    const p = pct(b.tot);
    const bar = '█'.repeat(Math.max(0, Math.round(p / 4)));
    console.log('  ' + short(b.bucket, 45).padEnd(46) + fmt(b.tot).padStart(7) + ' ' +
      (p.toFixed(1) + '%').padStart(6) + ' ' + String(b.turns).padStart(6) + '  ' + [...b.lanes].join('+').padEnd(12) + bar);
  }
  if (ranked.length > limit) console.log(`  … and ${ranked.length - limit} more`);
  const top = ranked[0];
  if (top) {
    console.log(`\n  Concentration: top item = ${pct(top.tot).toFixed(1)}%, top 3 = ` +
      ranked.slice(0, 3).reduce((s, b) => s + pct(b.tot), 0).toFixed(1) + '% of all tokens.');
    if (pct(top.tot) > 40) console.log(`  ⚠ "${short(top.bucket, 50)}" alone is over 40% — worth a look.`);
  }
  console.log('\n  By model: ' + [...byModel.entries()].sort((a, b) => b[1] - a[1])
    .map(([m, v]) => `${m} ${pct(v).toFixed(0)}%`).join(' · ') + '\n');
}
