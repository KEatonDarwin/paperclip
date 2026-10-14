#!/usr/bin/env node
// Betterment change ledger — every engine change the betterment lane makes is
// recorded here with the metric it promises to move, so report.mjs can judge it
// before/after and every change stays reversible (revert = stamp reverted_at;
// the row is never deleted).
//
//   node ledger.mjs add --title "Trim worker prompt" --kind flag --flag worker_prompt_v2 \
//        --ref hopper/x@abc123 --metric tokens_per_turn_worker --direction down \
//        [--promise 15] [--applied-at 2026-10-14] [--notes "..."]
//   node ledger.mjs revert <id> [--at 2026-10-20]
//   node ledger.mjs list [--json]
import { METRICS, openBettermentDb, parseArgs, BETTERMENT_DB } from './lib.mjs';

function die(msg) {
  console.error(`ledger: ${msg}`);
  process.exit(2);
}

const nowUtc = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function normaliseAt(v) {
  if (!v || v === true) return nowUtc();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v} 00:00:00`;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) die(`not a date: ${v}`);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const db = openBettermentDb();

if (cmd === 'add') {
  const { title, kind, flag, ref, metric, direction, promise, notes } = args;
  if (!title || title === true) die('--title is required');
  if (kind !== 'flag' && kind !== 'code') die("--kind must be 'flag' or 'code'");
  if (!METRICS[metric]) die(`--metric must be one of: ${Object.keys(METRICS).join(', ')}`);
  if (direction !== 'down' && direction !== 'up') die("--direction must be 'down' or 'up'");
  if (kind === 'flag' && (!flag || flag === true)) die('--flag <name> is required for kind=flag');
  let promised = null;
  if (promise !== undefined) {
    promised = Number(promise);
    if (!Number.isFinite(promised) || promised <= 0) die('--promise must be a positive percent');
  }
  const info = db.prepare(`
    INSERT INTO changes (title, kind, flag_name, branch_or_commit, metric, direction, promised_delta_pct, applied_at, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, kind, flag === true ? null : flag ?? null, ref === true ? null : ref ?? null,
    metric, direction, promised, normaliseAt(args['applied-at']), notes === true ? null : notes ?? null);
  console.log(JSON.stringify(db.prepare('SELECT * FROM changes WHERE id = ?').get(info.lastInsertRowid)));
} else if (cmd === 'revert') {
  const id = Number(args._[1]);
  if (!Number.isInteger(id)) die('usage: revert <id>');
  const row = db.prepare('SELECT * FROM changes WHERE id = ?').get(id);
  if (!row) die(`no change #${id}`);
  if (row.reverted_at) die(`change #${id} already reverted at ${row.reverted_at}`);
  db.prepare('UPDATE changes SET reverted_at = ? WHERE id = ?').run(normaliseAt(args.at), id);
  console.log(JSON.stringify(db.prepare('SELECT * FROM changes WHERE id = ?').get(id)));
} else if (cmd === 'list') {
  const rows = db.prepare('SELECT * FROM changes ORDER BY id').all();
  if (args.json) console.log(JSON.stringify(rows, null, 2));
  else if (!rows.length) console.log(`(ledger empty — ${BETTERMENT_DB})`);
  else for (const r of rows) {
    const state = r.reverted_at ? `REVERTED ${r.reverted_at}` : 'live';
    const promise = r.promised_delta_pct != null ? ` promise ${r.promised_delta_pct}%` : '';
    console.log(`#${r.id} [${r.kind}${r.flag_name ? `:${r.flag_name}` : ''}] ${r.title} — ${r.metric} ${r.direction}${promise} · applied ${r.applied_at} · ${state}`);
  }
} else {
  die('usage: ledger.mjs add|revert <id>|list  (see header comment)');
}
db.close();
