#!/usr/bin/env node
/**
 * MIKE RADAR REPORT CHECK — the daily report generator.
 *
 * TWO MODES.
 *
 * DEFAULT (free, hermetic): runs on a scratch JARVIS_DB_PATH with JARVIS_SIM=1,
 * ingests fixture activity, and asserts the generator's SAFETY behaviour —
 * `laymanFreeform` is sim-guarded, so the claude call is refused, which must
 * land as `status:'failed'` with an error and a notification, never a throw and
 * never a half-written report. That is the path that runs in CI.
 *
 * REAL MODE (`MIKE_RADAR_REAL_REPORT=1`, spends subscription tokens): ingests
 * the real archive into a WORKTREE-LOCAL jarvis.db and generates one genuine
 * report for a real project-day through the subscription claude CLI. Note the
 * DB path: sim-guard resolves "the live DB" relative to its own module, so a
 * `jarvis.db` sitting in THIS worktree is simultaneously (a) allowed to spend a
 * model turn and (b) not the production database. No API key is involved —
 * laymanFreeform spawns the `claude` binary with ANTHROPIC_API_KEY stripped.
 *
 *   npm run mike-radar:report-check                       # free
 *   MIKE_RADAR_REAL_REPORT=1 node scripts/mike-radar-report-check.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');
const REAL = process.env.MIKE_RADAR_REAL_REPORT === '1';
const PRODUCTION_DB = '/home/kevin/paperclip/darwin-assistant/jarvis.db';

const work = mkdtempSync(join(tmpdir(), 'mike-report-check-'));
const archive = join(work, 'archive');
mkdirSync(archive, { recursive: true });
process.env.MIKE_RADAR_OUTBOX_DIR = join(work, 'outbox');
process.env.MIKE_RADAR_DRIVER = '0';

if (REAL) {
  // Worktree-local DB: spendable per sim-guard, and NOT production.
  const localDb = resolve(join(__dirname, '..', 'jarvis.db'));
  if (resolve(localDb) === resolve(PRODUCTION_DB)) {
    console.error('refusing to run: this checkout IS the live one');
    process.exit(1);
  }
  rmSync(localDb, { force: true });
  rmSync(`${localDb}-wal`, { force: true });
  rmSync(`${localDb}-shm`, { force: true });
  delete process.env.JARVIS_DB_PATH;
  delete process.env.JARVIS_SIM;
  process.env.MIKE_RADAR_ARCHIVE_DIR = '/home/kevin/perclickity-suite/lovable-watch/archive';
  console.log(`\nMIKE RADAR REPORT CHECK — REAL MODE (spends subscription tokens)`);
  console.log(`  db:      ${localDb}  (worktree-local, NOT production)`);
  console.log(`  archive: ${process.env.MIKE_RADAR_ARCHIVE_DIR}  (read-only)\n`);
} else {
  const dbPath = process.env.JARVIS_DB_PATH;
  if (!dbPath || !/\/tmp\//.test(dbPath)) {
    console.error('refusing to run without a scratch JARVIS_DB_PATH under /tmp');
    process.exit(1);
  }
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  process.env.JARVIS_SIM = '1';
  process.env.MIKE_RADAR_ARCHIVE_DIR = archive;
  console.log(`\nMIKE RADAR REPORT CHECK — hermetic mode (no model call)`);
  console.log(`  scratch db: ${dbPath}\n`);
}

const M = await import(join(dist, 'mike-radar.js'));
const I = await import(join(dist, 'mike-radar-ingest.js'));
const R = await import(join(dist, 'mike-radar-report.js'));
const { listNotifications } = await import(join(dist, 'notifications.js'));

let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (name, actual, expected) =>
  t(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

if (!REAL) {
  // -------------------------------------------------------------------------
  // Hermetic: the refusal path.
  // -------------------------------------------------------------------------
  const P = '2f4075ae-1111-2222-3333-444455556666';
  const TU = (name, data) =>
    `<lov-tool-use id="x" name="${name}" integration-id="code" data="${data}">\n</lov-tool-use>`;
  writeFileSync(join(archive, `${P}.jsonl`), [
    JSON.stringify({
      captured_at: '2026-10-04T18:00:00Z', project_id: P,
      message_id: 'main:user#00000000000001#usr:A', role: 'user',
      created_at: '2026-10-04T15:00:00Z', text: 'add a leads index', commit_sha: null, diff: null,
    }),
    JSON.stringify({
      captured_at: '2026-10-04T18:00:00Z', project_id: P,
      message_id: 'main:agent#00000000000002#don:B', role: 'assistant',
      created_at: '2026-10-04T15:01:00Z',
      text: `${TU('supabase--migration', '{\\"name\\": \\"add_leads_idx\\", \\"query\\": \\"CREATE INDEX ...\\"}')}\n\nIndex added.`,
      commit_sha: 'aaa', diff: null,
    }),
    JSON.stringify({
      captured_at: '2026-10-04T18:00:00Z', project_id: P,
      message_id: 'main:user#00000000000003#usr:C', role: 'user',
      created_at: '2026-10-04T15:05:00Z', text: 'thanks', commit_sha: null, diff: null,
    }),
  ].map((l) => `${l}\n`).join(''), 'utf8');

  const sweep = I.runMikeIngest();
  eq('fixture ingested', sweep.run.rows_new, 3);
  // is_key is 0 for this id, but 3 messages clears the gate.
  t('a 3-message day clears the report gate', !!M.getMikeReport(P, '2026-10-04'));

  const before = listNotifications(50).length;
  const result = await R.generateMikeReport(P, '2026-10-04');
  t('the generator returned a row rather than throwing', !!result);
  eq('a sim-guard refusal becomes status=failed', result.status, 'failed');
  t('with an explanatory error', (result.error ?? '').length > 10);
  t('and no half-written report body', result.markdown === null);
  eq('the model it would have used is recorded', result.model, R.MIKE_REPORT_MODEL);
  t('input_chars records what it saw', result.input_chars > 0);
  eq('risk flags are still derived deterministically', result.risk_flags.join(','), 'migration');
  t('a warning notification was raised', listNotifications(50).length > before);
  const notif = listNotifications(50)[0];
  eq('notification severity', notif.severity, 'warning');
  t('notification names the project and date', notif.title.includes('2026-10-04'));

  // No auto-retry: the nightly pass must not re-run a failed day.
  const second = await R.runMikeReportPass('2026-10-04');
  eq('a failed day is NOT retried by the nightly pass', second.attempted, 0);
  // Regenerate (requeue) is the only retry.
  M.requeueMikeReport(P, '2026-10-04', { msg_count: 3, change_count: 1 });
  eq('requeue puts it back in the pass', M.getMikeReport(P, '2026-10-04').status, 'queued');
  const third = await R.runMikeReportPass('2026-10-04');
  eq('and the pass picks it up', third.attempted, 1);
  eq('failing again', third.failed, 1);

  // A day with no activity is 'skipped', not 'failed'.
  M.queueMikeReport(P, '2026-10-02', { msg_count: 0, change_count: 0 });
  const empty = await R.generateMikeReport(P, '2026-10-02');
  eq('an empty day is skipped, not failed', empty.status, 'skipped');
  t('and says so in plain words', (empty.summary ?? '').includes("didn't touch"));

  eq('a bogus project ref returns null', await R.generateMikeReport('nope', '2026-10-04'), null);
  eq('the report model is sonnet, not the haiku default', R.MIKE_REPORT_MODEL, 'claude-sonnet-5');
} else {
  // -------------------------------------------------------------------------
  // REAL: one genuine report through the subscription claude CLI.
  // -------------------------------------------------------------------------
  console.log('ingesting the real archive (read-only)…');
  const sweep = I.runMikeIngest({ full: true, quiet: true });
  eq('ingest done', sweep.run.status, 'done');
  console.log(`  ${sweep.run.rows_seen} rows, ${sweep.run.rows_bad} bad, ${sweep.reports_queued} reports queued`);

  // Pick the project-day with the most activity on one of Kevin's key projects
  // (prefer 2f4075ae, Darwin Intelligence Hub, per the design's verification).
  const days = M.listMikeActiveDays(30);
  const preferred = days.filter((d) => d.project_id.startsWith('2f4075ae'));
  const pool = preferred.length ? preferred : days.filter((d) => M.getMikeProject(d.project_id)?.is_key === 1);
  pool.sort((a, b) => b.msg_count - a.msg_count);
  const pick = pool[0];
  if (!pick) {
    console.error('no key-project day with activity found — cannot verify');
    process.exit(1);
  }
  const project = M.getMikeProject(pick.project_id);
  console.log(`\ngenerating a REAL report for ${M.mikeDisplayName(project)} (${project.short_id}) ` +
    `on ${pick.report_date} — ${pick.msg_count} messages, ${pick.change_count} with changes`);

  const rows = M.listMikeDayActivity(pick.project_id, pick.report_date);
  const input = R.buildReportInput(rows);
  console.log(`  prompt input: ${input.chars} chars (from ${rows.reduce((n, r) => n + r.text_chars, 0)} raw) ` +
    `· flags: ${input.risk_flags.join(',') || 'none'}`);
  t('the tool-use stripper shrank the input by >= 2x',
    rows.reduce((n, r) => n + r.text_chars, 0) > input.chars * 2);
  t('no raw tool XML in the prompt', !input.text.includes('<lov-tool-use'));

  const t0 = Date.now();
  const report = await R.generateMikeReport(pick.project_id, pick.report_date);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  claude took ${secs}s\n`);

  t('a report row came back', !!report);
  if (report?.status !== 'done') {
    console.error(`  report status=${report?.status} error=${report?.error}`);
  }
  eq('status done', report.status, 'done');
  eq('model recorded', report.model, R.MIKE_REPORT_MODEL);
  t('markdown body present', (report.markdown ?? '').length > 300);
  t('summary line extracted', !!report.summary);
  t('the SUMMARY marker was stripped out of the body',
    !(report.markdown ?? '').includes('SUMMARY:'));
  for (const section of ['What changed', 'How it works now', 'Risk & blast radius', 'If it breaks']) {
    t(`report contains "${section}"`, (report.markdown ?? '').includes(section));
  }
  eq('risk flags came from the parsed changes, not the prose',
    report.risk_flags.join(','), input.risk_flags.join(','));
  eq('msg_count matches the day', report.msg_count, rows.length);
  t('input_chars recorded', report.input_chars === input.chars);

  const path = R.writeMikeDailyRollup(pick.report_date);
  t('outbox rollup written', !!path && existsSync(path));
  t('rollup carries this project', readFileSync(path, 'utf8').includes(project.short_id));

  console.log('\n──────── SUMMARY ────────');
  console.log(report.summary);
  console.log('\n──────── REPORT ─────────');
  console.log(report.markdown.slice(0, 3_000));
  console.log('─────────────────────────\n');
}

rmSync(work, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
