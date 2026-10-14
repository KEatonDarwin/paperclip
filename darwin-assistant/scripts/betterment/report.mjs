#!/usr/bin/env node
// Betterment before/after report — judges every live (non-reverted) ledger
// change against the metric it promised to move. Model-free.
//
//   node report.mjs            → JSON on stdout + report.json + report.html in BETTERMENT_DIR
//
// Per change:
//   baseline  = mean of the metric over the 14 days BEFORE the applied day
//   live      = mean from the applied day on (needs >= 3 days, else status 'warming')
//   delta_pct = (live - baseline) / |baseline| * 100   (null when baseline is 0)
//   verdict   = 'green' when the metric moved the promised direction AND, if
//               promised_delta_pct is set, by at least that much; else 'red'.
//   guard     = 'ALERT' when the most recent 3+ live days in a row were each on
//               the wrong side of the baseline (direction only — a regression,
//               not merely an under-delivered promise); else 'ok'.
import fs from 'node:fs';
import path from 'node:path';
import { BETTERMENT_DIR, BETTERMENT_DB, METRICS, addDays, openBettermentDb } from './lib.mjs';

const BASELINE_DAYS = 14;
const MIN_LIVE_DAYS = 3;
const ALERT_STREAK = 3;

const db = openBettermentDb();
const changes = db.prepare('SELECT * FROM changes ORDER BY id').all();
const seriesStmt = db.prepare('SELECT day, value FROM metrics_daily WHERE metric = ? AND day >= ? AND day < ? ORDER BY day');
const mean = (rows) => (rows.length ? rows.reduce((s, r) => s + r.value, 0) / rows.length : null);
const round = (v, p = 4) => (v == null ? null : Math.round(v * 10 ** p) / 10 ** p);

function judge(c) {
  const appliedDay = c.applied_at.slice(0, 10);
  const base = seriesStmt.all(c.metric, addDays(appliedDay, -BASELINE_DAYS), appliedDay);
  const live = seriesStmt.all(c.metric, appliedDay, '9999-12-31');
  const baseline = mean(base);
  const liveMean = mean(live);
  const worse = (v) => (c.direction === 'down' ? v > baseline : v < baseline);
  const r = {
    id: c.id, title: c.title, kind: c.kind, flag_name: c.flag_name, branch_or_commit: c.branch_or_commit,
    metric: c.metric, metric_label: METRICS[c.metric]?.label ?? c.metric, direction: c.direction,
    promised_delta_pct: c.promised_delta_pct, applied_at: c.applied_at, notes: c.notes,
    baseline_days: base.length, live_days: live.length,
    baseline: round(baseline), live: round(liveMean), delta_pct: null, improvement_pct: null,
    status: 'judged', verdict: null, promise: null, guard: 'ok', red_streak_days: 0,
  };
  if (baseline == null) { r.status = 'no_baseline'; return r; }
  if (liveMean != null && baseline !== 0) {
    r.delta_pct = round(((liveMean - baseline) / Math.abs(baseline)) * 100, 2);
    r.improvement_pct = c.direction === 'down' ? -r.delta_pct : r.delta_pct;
  }
  // Trailing run of wrong-side days (most recent first).
  for (let i = live.length - 1; i >= 0 && worse(live[i].value); i--) r.red_streak_days++;
  if (r.red_streak_days >= ALERT_STREAK) r.guard = 'ALERT';
  if (live.length < MIN_LIVE_DAYS) { r.status = 'warming'; return r; }
  const movedRight = c.direction === 'down' ? liveMean < baseline : liveMean > baseline;
  if (c.promised_delta_pct != null) {
    r.promise = r.improvement_pct != null && r.improvement_pct >= c.promised_delta_pct ? 'met' : 'missed';
  }
  r.verdict = movedRight && r.promise !== 'missed' ? 'green' : 'red';
  return r;
}

const live = changes.filter((c) => !c.reverted_at).map(judge);
const reverted = changes.filter((c) => c.reverted_at).map((c) => ({ id: c.id, title: c.title, metric: c.metric, applied_at: c.applied_at, reverted_at: c.reverted_at }));
const latest = {};
for (const m of Object.keys(METRICS)) {
  const row = db.prepare('SELECT day, value FROM metrics_daily WHERE metric = ? ORDER BY day DESC LIMIT 1').get(m);
  if (row) latest[m] = { day: row.day, value: round(row.value) };
}
db.close();

const report = {
  generated_at: new Date().toISOString(),
  betterment_db: BETTERMENT_DB,
  summary: {
    live_changes: live.length,
    green: live.filter((r) => r.verdict === 'green').length,
    red: live.filter((r) => r.verdict === 'red').length,
    warming: live.filter((r) => r.status === 'warming').length,
    alerts: live.filter((r) => r.guard === 'ALERT').length,
    reverted: reverted.length,
  },
  changes: live,
  reverted,
  latest_metrics: latest,
};

// ── HTML (layman-first: plain sentences up top, numbers behind a click) ─────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const fmt = (v) => (Math.abs(v) < 10 ? String(Math.round(v * 10) / 10) : Math.round(v).toLocaleString('en-US'));
const isRatio = (m) => m.startsWith('cache_ratio');
const val = (m, v) => (v == null ? '—' : isRatio(m) ? `${(v * 100).toFixed(1)}%` : fmt(v));

function sentences(r) {
  const goal = r.direction === 'down' ? 'bring down' : 'push up';
  const s = [`<b>${esc(r.title)}</b> went live ${esc(r.applied_at.slice(0, 10))} to ${goal} <i>${esc(r.metric_label.toLowerCase())}</i>.`];
  if (r.status === 'no_baseline') s.push('There is no data from the two weeks before it, so there is nothing to compare against yet.');
  else if (r.status === 'warming') s.push(`It has only ${r.live_days} day${r.live_days === 1 ? '' : 's'} of data since — give it at least ${MIN_LIVE_DAYS} before judging.`);
  else {
    const moved = r.delta_pct == null ? '' : ` — ${Math.abs(r.delta_pct).toFixed(1)}% ${r.delta_pct < 0 ? 'lower' : 'higher'}`;
    s.push(`Before, it averaged ${val(r.metric, r.baseline)}; since, ${val(r.metric, r.live)}${moved}.`);
    if (r.verdict === 'green') s.push(r.promise === 'met' ? `That is better, and meets the ${r.promised_delta_pct}% promised.` : 'That is the better direction.');
    else s.push(r.promise === 'missed' && r.improvement_pct > 0 ? `Better, but short of the ${r.promised_delta_pct}% promised.` : 'That is the wrong direction.');
  }
  if (r.guard === 'ALERT') s.push(`<b>Alert:</b> it has been worse than before ${r.red_streak_days} days running — consider <code>ledger.mjs revert ${r.id}</code>.`);
  return s.join(' ');
}

const badge = (r) => (r.guard === 'ALERT' ? 'alert' : r.verdict ?? r.status);
const cards = live.map((r) => `
  <section class="card ${esc(badge(r))}">
    <div class="tag">${esc(badge(r).toUpperCase())}</div>
    <p>${sentences(r)}</p>
    <details><summary>Details</summary><table>
      ${[['Change #', r.id], ['Kind', r.kind + (r.flag_name ? ` (flag ${r.flag_name})` : '')], ['Branch / commit', r.branch_or_commit],
        ['Metric', r.metric], ['Direction wanted', r.direction], ['Promised', r.promised_delta_pct == null ? '—' : `${r.promised_delta_pct}%`],
        ['Baseline (mean)', `${val(r.metric, r.baseline)} over ${r.baseline_days} days`], ['Live (mean)', `${val(r.metric, r.live)} over ${r.live_days} days`],
        ['Change', r.delta_pct == null ? '—' : `${r.delta_pct}%`], ['Wrong-side streak', `${r.red_streak_days} day(s)`], ['Notes', r.notes]]
        .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v ?? '—')}</td></tr>`).join('')}
    </table></details>
  </section>`).join('');
const s = report.summary;
const headline = live.length
  ? `${s.live_changes} change${s.live_changes === 1 ? '' : 's'} being watched: ${s.green} getting better, ${s.red} not, ${s.warming} still warming up.${s.alerts ? ` <b>${s.alerts} need${s.alerts === 1 ? 's' : ''} attention.</b>` : ''}`
  : 'No changes are being watched yet. The numbers below are the current baseline every future change will be judged against.';
const metricRows = Object.entries(latest).map(([m, x]) => `<tr><th>${esc(METRICS[m].label)}</th><td>${esc(val(m, x.value))}</td><td>${esc(x.day)}</td></tr>`).join('');
const html = `<!doctype html><html><head><meta charset="utf-8"><title>JARVIS betterment report</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:820px;margin:2em auto;padding:0 1em;color:#222}
.card{border:1px solid #ddd;border-left:6px solid #999;border-radius:6px;padding:.6em 1em;margin:1em 0}
.card.green{border-left-color:#2a9d4a}.card.red,.card.alert{border-left-color:#d33}.card.warming{border-left-color:#e0a800}
.tag{font-size:12px;font-weight:600;color:#666}table{border-collapse:collapse}th,td{text-align:left;padding:2px 10px 2px 0;vertical-align:top}
th{font-weight:500;color:#555}small{color:#888}</style></head><body>
<h1>Is JARVIS getting better?</h1><p>${headline}</p>${cards}
${reverted.length ? `<p><small>${reverted.length} change(s) were reverted and are no longer judged: ${reverted.map((r) => `#${r.id} ${esc(r.title)}`).join(', ')}.</small></p>` : ''}
<details><summary>Latest daily numbers</summary><table>${metricRows || '<tr><td>No metrics collected yet — run collect.mjs.</td></tr>'}</table></details>
<p><small>Generated ${esc(report.generated_at)} from ${esc(BETTERMENT_DB)}.</small></p></body></html>`;

fs.mkdirSync(BETTERMENT_DIR, { recursive: true });
fs.writeFileSync(path.join(BETTERMENT_DIR, 'report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(BETTERMENT_DIR, 'report.html'), html);
console.log(JSON.stringify(report, null, 2));
