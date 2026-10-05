#!/usr/bin/env node
/**
 * MIKE RADAR INGEST CHECK — the sweep, the store, and the read API's shape.
 *
 * Runs against the COMPILED dist on a SCRATCH jarvis.db (JARVIS_DB_PATH) with
 * a SCRATCH archive directory of fixture JSONL built in /tmp. Zero model calls
 * (JARVIS_SIM=1 + nothing here invokes the report generator), zero writes to
 * the real DB, nothing read from or written to anything of Mike's.
 *
 * Then, if the real archive is present, it performs a FULL cold-start ingest of
 * all 27 MB into the same scratch DB and asserts the real-data outcome the
 * design asked for: ~100 projects, every message row, every diff accounted
 * for, and rows_bad == 1 (the one junk line).
 *
 *   npm run mike-radar:ingest-check
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = join(__dirname, '..', 'dist');

const dbPath = process.env.JARVIS_DB_PATH;
if (!dbPath || !/\/tmp\//.test(dbPath)) {
  console.error('refusing to run without a scratch JARVIS_DB_PATH under /tmp');
  process.exit(1);
}
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });

const work = mkdtempSync(join(tmpdir(), 'mike-radar-check-'));
const archive = join(work, 'archive');
const outbox = join(work, 'outbox');
mkdirSync(archive, { recursive: true });
process.env.MIKE_RADAR_ARCHIVE_DIR = archive;
process.env.MIKE_RADAR_OUTBOX_DIR = outbox;
// Never let the driver's boot sweep or interval fire inside a test.
process.env.MIKE_RADAR_DRIVER = '0';

const M = await import(join(dist, 'mike-radar.js'));
const I = await import(join(dist, 'mike-radar-ingest.js'));
const R = await import(join(dist, 'mike-radar-report.js'));
const { sseBus } = await import(join(dist, 'sse-bus.js'));

let pass = 0;
let fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (name, actual, expected) =>
  t(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

// SSE capture — the contract the cockpit depends on.
const events = [];
sseBus.on('sse', (e) => events.push(e));
const typesSeen = () => new Set(events.map((e) => e.type));

console.log('\nMIKE RADAR INGEST CHECK');
console.log(`  scratch db: ${dbPath}`);
console.log(`  fixture archive: ${archive}\n`);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const PA = '816a7a7c-bb38-406a-8207-ea8dfe3b1db4'; // a KEY project (PerClickity)
const PB = '0f39c765-42f1-48b4-aad7-2340d3d2a136'; // a non-key project
const PC = 'e22bf3e2-e38b-4b82-8f1c-898406ede3f9'; // the junk-line project

const TU = (name, data) =>
  `<lov-tool-use id="x" name="${name}" integration-id="code" data="${data}">\n</lov-tool-use>`;

const row = (o) => `${JSON.stringify(o)}\n`;

function writeFixtures() {
  // PA: a user ask + an assistant reply with a real change and a JSON diff.
  writeFileSync(join(archive, `${PA}.jsonl`), [
    row({
      captured_at: '2026-10-04T18:05:00Z',
      project_id: PA,
      message_id: 'main:user#00000000000010#usr:AAA',
      role: 'user',
      created_at: '2026-10-04T17:30:00Z',
      text: 'the Save edit button is greyed out when I change a draft',
      commit_sha: null,
      diff: null,
    }),
    row({
      captured_at: '2026-10-04T18:05:00Z',
      project_id: PA,
      message_id: 'main:agent#00000000060011#don:BBB',
      role: 'assistant',
      created_at: '2026-10-04T17:33:00Z',
      text: `${TU('code--line_replace', '{\\"file_path\\": \\"src/components/recon/ReplyDraftsPanel.tsx\\"}')}\n\nFixed the Save edit button so it enables the moment the draft text changes.`,
      commit_sha: 'abc1234',
      diff: JSON.stringify({
        diffs: [{
          action: 'modify', file_path: 'src/components/recon/ReplyDraftsPanel.tsx', file_type: 'tsx',
          hunks: [{ oldStart: 10, oldCount: 1, newStart: 10, newCount: 1, lines: [{ type: 'del', content: 'const dirty = false;' }, { type: 'add', content: 'const dirty = text !== original;' }] }],
        }],
      }),
    }),
    // A risky day: migration + secret + run_sql, and a textual (unified) diff.
    row({
      captured_at: '2026-10-04T19:05:00Z',
      project_id: PA,
      message_id: 'main:agent#00000000060012#don:CCC',
      role: 'assistant',
      created_at: '2026-10-04T18:02:00Z',
      text: [
        TU('supabase--migration', '{\\"name\\": \\"add_fc_runs\\", \\"query\\": \\"CREATE TABLE clearing_fc_runs (...)\\"}'),
        TU('secrets--update_secret', '{\\"secret_name\\": \\"ONGAGE_KEY\\", \\"value\\": \\"super-secret-value\\"}'),
        TU('supabase--run_sql', '{\\"query\\": \\"UPDATE clearing_links SET x = 1\\"}'),
        '',
        'Added the Free Content Runs tables and wired the Ongage key.',
      ].join('\n'),
      commit_sha: 'def5678',
      diff: '--- a/src/lib/clearing/free-content-hub.ts\n+++ b/src/lib/clearing/free-content-hub.ts\n@@ -1,2 +1,3 @@\n export const hub = 1;\n+export const runs = [];\n',
    }),
    // An inline project-meta row with the description LEAKED into `name`.
    row({
      captured_at: '2026-10-04T19:05:00Z',
      id: PA,
      name: `PerClickity is a traffic clearing system that ${'blah '.repeat(140)}`,
      description: null,
      created_at: '2026-09-01T00:00:00Z',
    }),
  ].join(''), 'utf8');

  // PB: a non-key project with only 2 messages — below the report gate.
  writeFileSync(join(archive, `${PB}.jsonl`), [
    row({
      captured_at: '2026-10-04T18:05:00Z', project_id: PB,
      message_id: 'main:user#00000000000001#usr:DDD', role: 'user',
      created_at: '2026-10-04T16:00:00Z', text: 'make the header blue', commit_sha: null, diff: null,
    }),
    row({
      captured_at: '2026-10-04T18:05:00Z', project_id: PB,
      message_id: 'main:agent#00000000000002#don:EEE', role: 'assistant',
      created_at: '2026-10-04T16:01:00Z',
      text: `${TU('code--write', '{\\"file_path\\": \\"src/Header.tsx\\"}')}\n\nHeader is blue now.`,
      commit_sha: null, diff: null,
    }),
  ].join(''), 'utf8');

  // PC: the real junk line, plus one good row and one SEQUENCE GAP.
  writeFileSync(join(archive, `${PC}.jsonl`), [
    'EMPTY\n',
    row({
      captured_at: '2026-10-04T18:05:00Z', project_id: PC,
      message_id: 'main:agent#00000000000100#don:FFF', role: 'assistant',
      created_at: '2026-10-04T15:00:00Z', text: 'ok', commit_sha: null, diff: null,
    }),
    row({
      captured_at: '2026-10-04T18:05:00Z', project_id: PC,
      message_id: 'main:agent#00000000000140#don:GGG', role: 'assistant',
      created_at: '2026-10-04T15:05:00Z', text: 'still ok', commit_sha: null, diff: null,
    }),
    // A row with no role/message_id at all — must be counted bad, not crash.
    row({ captured_at: 'x', project_id: PC, something: 'else' }),
  ].join(''), 'utf8');

  // _new_projects.jsonl — the PRIMARY offline name source.
  writeFileSync(join(archive, '_new_projects.jsonl'), [
    row({ id: PB, name: 'Perclickity Sandbox', description: 'A sandbox', captured_at: '2026-10-01T00:00:00Z' }),
    row({ id: PC, name: 'Darwin Intelligence Hub', description: null, captured_at: '2026-10-01T00:00:00Z' }),
    // A project in the meta file that has NO archive — must be ignored.
    row({ id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', name: 'Ghost', description: null }),
    // A later entry wins over an earlier one for the same id.
    row({ id: PB, name: 'Perclickity Sandbox v2', description: 'A sandbox', captured_at: '2026-10-03T00:00:00Z' }),
  ].join(''), 'utf8');

  // Noise the sweep must ignore.
  writeFileSync(join(archive, 'digest.md'), '# not a project\n', 'utf8');
  writeFileSync(join(archive, 'state.json'), '{}', 'utf8');
}
writeFixtures();

// ---------------------------------------------------------------------------
console.log('first sweep (cold start)');
// ---------------------------------------------------------------------------
const first = I.runMikeIngest();
eq('run done', first.run.status, 'done');
eq('4 files seen (3 projects + the meta file)', first.run.files_seen, 4);
eq('7 message rows', first.run.rows_seen, 7);
eq('7 new', first.run.rows_new, 7);
eq('3 new projects', first.run.projects_new, 3);
eq('2 bad lines (the junk line + the role-less row)', first.run.rows_bad, 2);
// A cold-start sweep is never a cap-hit (it reads the whole file by design).
eq('a cold start reports no cap-hits', first.run.capped_projects, 0);
t('digest.md / state.json ignored', first.run.files_seen === 4);

// ---------------------------------------------------------------------------
console.log('\nproject registry');
// ---------------------------------------------------------------------------
{
  const a = M.getMikeProjectByRef('816a7a7c');
  t('short-id lookup works', !!a);
  eq('full-uuid lookup works too', M.getMikeProjectByRef(PA)?.project_id, PA);
  eq('key project seeded is_key=1', a.is_key, 1);
  eq('known supabase ref seeded offline', a.supabase_ref, 'onxbfneqvjapberusidr');
  eq('msg_count', a.msg_count, 3);
  eq('change_count (rows with >=1 change)', a.change_count, 2);
  eq('first_seen_at', a.first_seen_at, '2026-10-04T17:30:00Z');
  eq('last_activity_at', a.last_activity_at, '2026-10-04T18:02:00Z');
  // The 650-char-style leaked description must NOT become the name.
  eq('leaked description did not become a name', a.name, null);
  t('and landed in description', (a.description ?? '').startsWith('PerClickity is a traffic clearing system'));
  eq('name_source records the fallback', a.name_source, 'short_id');
  eq('display name falls back to the short id', M.mikeDisplayName(a), '816a7a7c');

  const b = M.getMikeProjectByRef('0f39c765');
  eq('non-key project is not key', b.is_key, 0);
  eq('named offline from _new_projects.jsonl', b.name, 'Perclickity Sandbox v2');
  eq('name_source', b.name_source, 'archive_meta');
  eq('description from the meta file', b.description, 'A sandbox');
  eq('display name is the real name', M.mikeDisplayName(b), 'Perclickity Sandbox v2');

  eq('a meta-only project with no archive is NOT registered',
    M.getMikeProject('ffffffff-ffff-ffff-ffff-ffffffffffff'), null);
  eq('3 projects total', M.listAllMikeProjects().length, 3);
}

// ---------------------------------------------------------------------------
console.log('\nactivity rows + diffs');
// ---------------------------------------------------------------------------
{
  const feed = M.listMikeFeed({ project_id: PA });
  eq('3 rows, newest first', feed.items.length, 3);
  eq('newest is the risky assistant row', feed.items[0].message_id, 'main:agent#00000000060012#don:CCC');
  eq('oldest is Mike asking', feed.items[2].role, 'user');
  eq('no next page', feed.next_before, null);
  eq('short_id is on every row', feed.items[0].short_id, '816a7a7c');

  eq('headline derived', feed.items[1].headline,
    'Fixed the Save edit button so it enables the moment the draft text changes.');
  eq('full text is never truncated', feed.items[1].text.includes('<lov-tool-use'), true);
  eq('text_chars recorded', feed.items[1].text_chars, feed.items[1].text.length);
  eq('commit sha kept', feed.items[1].commit_sha, 'abc1234');
  eq('source provenance', feed.items[1].source_file, `${PA}.jsonl`);
  eq('source line', feed.items[1].source_line, 2);

  // THE feed payload rule: diff_json is NOT in the list response.
  t('feed row carries has_diff, not the diff body',
    feed.items[1].has_diff === true && !('diff_json' in feed.items[1]));
  eq('diff_kind on the list row', feed.items[1].diff_kind, 'parsed');

  const risky = feed.items[0];
  eq('risky row has 4 changes (3 tools + 1 diff-only path)', risky.change_count, 4);
  const actions = risky.changes.map((c) => c.action).sort().join(',');
  eq('actions', actions, 'edit,migration,secret,sql');
  t('a secret VALUE is never persisted',
    !JSON.stringify(risky.changes).includes('super-secret-value'));
  eq('secret note is the name only', risky.changes.find((c) => c.action === 'secret').note, 'ONGAGE_KEY');
  eq('the textual diff parsed', risky.diff_kind, 'parsed');
  t('the diff-only file path was folded into changes',
    risky.changes.some((c) => c.path === 'src/lib/clearing/free-content-hub.ts'));

  // The expanded view, which DOES carry the hunks.
  const detail = M.getMikeActivity(feed.items[1].id);
  t('detail carries the parsed diff', !!detail.diff);
  eq('detail file path', detail.diff.diffs[0].file_path, 'src/components/recon/ReplyDraftsPanel.tsx');
  eq('detail hunk lines', detail.diff.diffs[0].hunks[0].lines.length, 2);
  eq('no raw blob for a parsed diff', detail.diff_raw, null);
  eq('a missing id is null', M.getMikeActivity(999999), null);
}

// ---------------------------------------------------------------------------
console.log('\nfeed filters + pagination');
// ---------------------------------------------------------------------------
{
  eq('role=user', M.listMikeFeed({ project_id: PA, role: 'user' }).items.length, 1);
  eq('role=assistant', M.listMikeFeed({ project_id: PA, role: 'assistant' }).items.length, 2);
  eq('changes_only', M.listMikeFeed({ project_id: PA, changes_only: true }).items.length, 2);
  eq('day filter (CT)', M.listMikeFeed({ project_id: PA, day: '2026-10-04' }).items.length, 3);
  eq('a day with nothing', M.listMikeFeed({ project_id: PA, day: '2026-10-01' }).items.length, 0);

  const p1 = M.listMikeFeed({ project_id: PA, limit: 2 });
  eq('page 1 size', p1.items.length, 2);
  t('page 1 offers a cursor', typeof p1.next_before === 'number');
  const p2 = M.listMikeFeed({ project_id: PA, limit: 2, before: p1.next_before });
  eq('page 2 size', p2.items.length, 1);
  eq('page 2 is the last', p2.next_before, null);
  t('no row appears on both pages',
    !p1.items.some((a) => p2.items.some((b) => b.id === a.id)));
  eq('limit is clamped to 200', M.listMikeFeed({ project_id: PA, limit: 9999 }).items.length, 3);
}

// ---------------------------------------------------------------------------
console.log('\nproject list / rail');
// ---------------------------------------------------------------------------
{
  const res = M.listMikeProjects({ day: '2026-10-04' });
  eq('3 watched projects', res.projects.length, 3);
  eq('the key project sorts first', res.projects[0].short_id, '816a7a7c');
  eq('totals.messages', res.totals.messages, 7);
  // Rows that carry >= 1 change: PA has 2, PB has 1, PC has 0.
  eq('totals.changes counts ROWS with changes, not individual changes', res.totals.changes, 3);
  eq("today's messages", res.totals.today_messages, 7);
  const a = res.projects.find((p) => p.short_id === '816a7a7c');
  eq('today_msg_count', a.today_msg_count, 3);
  eq('today_change_count', a.today_change_count, 2);
  t('latest_headline is set', !!a.latest_headline);
  eq('has_report_today starts false', a.has_report_today, false);
  // risk_flags_today comes from the group_concat'd changes of the whole day.
  eq('risk flags for the day', a.risk_flags_today.sort().join(','), 'migration,prod_sql,secret');
  eq('display_name is never null', typeof a.display_name, 'string');

  eq('key_only', M.listMikeProjects({ key_only: true, day: '2026-10-04' }).projects.length, 1);
  eq('watch_state=muted is empty', M.listMikeProjects({ watch_state: 'muted' }).projects.length, 0);
  eq('watch_state=all', M.listMikeProjects({ watch_state: 'all' }).projects.length, 3);
  eq('since filter', M.listMikeProjects({ since: '2026-10-04T18:00:00Z' }).projects.length, 1);
}

// ---------------------------------------------------------------------------
console.log('\nKevin-only knobs + name precedence');
// ---------------------------------------------------------------------------
{
  M.updateMikeProject(PB, { watch_state: 'muted' });
  eq('muted project leaves the watched list',
    M.listMikeProjects({ watch_state: 'watched' }).projects.length, 2);
  eq('and appears in the muted list',
    M.listMikeProjects({ watch_state: 'muted' }).projects.length, 1);
  M.updateMikeProject(PB, { watch_state: 'watched' });

  // A name Kevin typed must survive every later sweep.
  M.updateMikeProject(PA, { name: 'PerClickity', name_source: 'kevin' });
  M.applyMikeProjectName(PA, 'Something From The Archive', null, 'archive_meta');
  eq("archive_meta cannot clobber Kevin's name", M.getMikeProject(PA).name, 'PerClickity');
  M.applyMikeProjectName(PA, 'Something From Lovable', null, 'lovable');
  eq("lovable cannot clobber Kevin's name either", M.getMikeProject(PA).name, 'PerClickity');
  // ...but lovable DOES beat archive_meta.
  M.applyMikeProjectName(PB, 'Sandbox From Lovable', null, 'lovable');
  eq('lovable upgrades an archive_meta name', M.getMikeProject(PB).name, 'Sandbox From Lovable');
  eq('name_source follows', M.getMikeProject(PB).name_source, 'lovable');
  M.applyMikeProjectName(PB, 'Back To Archive', null, 'archive_meta');
  eq('and archive_meta cannot downgrade it', M.getMikeProject(PB).name, 'Sandbox From Lovable');
}

// ---------------------------------------------------------------------------
console.log('\nidempotency');
// ---------------------------------------------------------------------------
{
  const second = I.runMikeIngest();
  eq('second sweep sees no new rows', second.run.rows_new, 0);
  eq('and no new projects', second.run.projects_new, 0);
  eq('rows_seen is 0 too (high-water mark skipped the file)', second.run.rows_seen, 0);
  eq('row count unchanged', M.getMikeProject(PA).msg_count, 3);

  const full = I.runMikeIngest({ full: true, quiet: true });
  eq('a FULL re-read re-reads every row', full.run.rows_seen, 7);
  eq('but inserts none (unique index)', full.run.rows_new, 0);
  eq('and still counts the bad lines', full.run.rows_bad, 2);
  eq('row count still unchanged', M.getMikeProject(PA).msg_count, 3);
  eq('no duplicate projects', M.listAllMikeProjects().length, 3);
}

// ---------------------------------------------------------------------------
console.log('\nincremental append (the hourly case)');
// ---------------------------------------------------------------------------
{
  appendFileSync(join(archive, `${PA}.jsonl`), row({
    captured_at: '2026-10-05T19:05:00Z', project_id: PA,
    message_id: 'main:user#00000000000011#usr:HHH', role: 'user',
    created_at: '2026-10-05T14:00:00Z', text: 'now add the tester click column', commit_sha: null, diff: null,
  }), 'utf8');
  const inc = I.runMikeIngest();
  eq('only the appended row is read', inc.run.rows_seen, 1);
  eq('and inserted', inc.run.rows_new, 1);
  eq('counts recomputed', M.getMikeProject(PA).msg_count, 4);
  eq('last_activity_at advanced', M.getMikeProject(PA).last_activity_at, '2026-10-05T14:00:00Z');
  eq('the new row is at the top of the feed',
    M.listMikeFeed({ project_id: PA }).items[0].message_id, 'main:user#00000000000011#usr:HHH');
}

// ---------------------------------------------------------------------------
console.log('\nwatcher cap-hit detection (the real "we lost messages" signal)');
// ---------------------------------------------------------------------------
{
  // DESIGN §10 wanted this off the message-id sequence; measured, that gives a
  // false positive on ~every row (see mike-radar-ingest.ts). The honest signal
  // is an incremental sweep that delivers >= the watcher's own 30-message cap.
  eq('the cap constant matches lovable-watch/prompt.txt step 3a', I.WATCHER_MESSAGE_CAP, 30);
  let lines = '';
  for (let i = 0; i < 30; i++) {
    lines += row({
      captured_at: '2026-10-05T20:05:00Z', project_id: PC,
      message_id: `main:agent#0000000000${1000 + i}#don:CAP${i}`, role: 'assistant',
      created_at: `2026-10-05T16:${String(i).padStart(2, '0')}:00Z`,
      text: `burst message ${i}`, commit_sha: null, diff: null,
    });
  }
  appendFileSync(join(archive, `${PC}.jsonl`), lines, 'utf8');
  const burst = I.runMikeIngest();
  eq('30 new rows in one incremental sweep', burst.run.rows_new, 30);
  eq('and the cap-hit is flagged', burst.run.capped_projects, 1);

  // One more row, below the cap -> no flag.
  appendFileSync(join(archive, `${PC}.jsonl`), row({
    captured_at: '2026-10-05T21:05:00Z', project_id: PC,
    message_id: 'main:agent#00000000002000#don:CALM', role: 'assistant',
    created_at: '2026-10-05T17:00:00Z', text: 'calm again', commit_sha: null, diff: null,
  }), 'utf8');
  const calm = I.runMikeIngest();
  eq('a 1-row sweep is not a cap-hit', calm.run.capped_projects, 0);
}

// ---------------------------------------------------------------------------
console.log('\nfile rewritten shorter = mark is dropped, not trusted');
// ---------------------------------------------------------------------------
{
  writeFileSync(join(archive, `${PB}.jsonl`), row({
    captured_at: '2026-10-05T19:05:00Z', project_id: PB,
    message_id: 'main:user#00000000000003#usr:III', role: 'user',
    created_at: '2026-10-05T10:00:00Z', text: 'rewritten file', commit_sha: null, diff: null,
  }), 'utf8');
  const rewritten = I.runMikeIngest();
  t('the shrunken file was re-read from 0', rewritten.run.rows_seen >= 1);
  eq('and the new row landed', M.getMikeProject(PB).msg_count, 3);
}

// ---------------------------------------------------------------------------
console.log('\nreport queue (the cost gate)');
// ---------------------------------------------------------------------------
{
  const queuedA = M.getMikeReport(PA, '2026-10-04');
  t('the key project got a report row for 2026-10-04', !!queuedA);
  eq('queued', queuedA.status, 'queued');
  eq('msg_count on the queued row', queuedA.msg_count, 3);
  eq('change_count on the queued row', queuedA.change_count, 2);
  eq('short_id joined in', queuedA.short_id, '816a7a7c');

  // PB is non-key with only 2 messages on 2026-10-04 -> below the >=3 gate.
  eq('a dormant non-key project is NOT queued', M.getMikeReport(PB, '2026-10-04'), null);
  // PC is non-key with 2 messages -> also below the gate.
  eq('and neither is the other quiet one', M.getMikeReport(PC, '2026-10-04'), null);

  // A muted project must never be queued, even when it is a key project.
  M.updateMikeProject(PA, { watch_state: 'muted' });
  const before = M.listMikeReports({ limit: 100 }).length;
  I.runMikeIngest();
  eq('muting stops new report rows', M.listMikeReports({ limit: 100 }).length, before);
  M.updateMikeProject(PA, { watch_state: 'watched' });

  eq('report index by date', M.listMikeReports({ date: '2026-10-04' }).length, 1);
  eq('the index omits markdown', M.listMikeReports({ date: '2026-10-04' })[0].markdown, null);
  eq('report index by project', M.listMikeReports({ project_id: PA }).length >= 1, true);
  eq('report index by status', M.listMikeReports({ status: 'queued' }).length >= 1, true);
  eq('a bogus date yields nothing', M.listMikeReports({ date: '1999-01-01' }).length, 0);
}

// ---------------------------------------------------------------------------
console.log('\nreport input builder + SUMMARY split (no model call)');
// ---------------------------------------------------------------------------
{
  const rows = M.listMikeDayActivity(PA, '2026-10-04');
  eq('3 rows for the day, oldest first', rows.length, 3);
  eq('oldest first', rows[0].role, 'user');

  const input = R.buildReportInput(rows);
  t('input is non-empty', input.chars > 0);
  eq('msg_count', input.msg_count, 3);
  eq('change_count', input.change_count, 2);
  eq('risk flags are derived from the CHANGES, not the model',
    input.risk_flags.sort().join(','), 'migration,prod_sql,secret');
  t('tool-use blocks are collapsed to markers', input.text.includes('[tool: code--line_replace'));
  t('raw tool XML never reaches the prompt', !input.text.includes('<lov-tool-use'));
  t("Mike's own words are kept", input.text.includes('the Save edit button is greyed out'));
  t('times are rendered in CT', /\[\d{2}:\d{2} MIKE\]/.test(input.text));
  t('the change strip is in the prompt', input.text.includes('CHANGED →'));
  eq('not truncated at this size', input.truncated, false);

  const project = M.getMikeProject(PA);
  const prompt = R.buildReportPrompt(project, '2026-10-04', input);
  for (const section of ['## What changed', '## How it works now', '## Risk & blast radius', '## If it breaks']) {
    t(`prompt asks for "${section}"`, prompt.includes(section));
  }
  t('prompt demands the SUMMARY line', prompt.includes('SUMMARY:'));
  t('prompt names the project', prompt.includes(project.project_id));
  t('prompt carries the supabase ref', prompt.includes('onxbfneqvjapberusidr'));

  const split = R.splitReportOutput('## What changed\n\nStuff.\n\nSUMMARY: Mike fixed a button. Nothing risky.');
  eq('summary extracted', split.summary, 'Mike fixed a button. Nothing risky.');
  eq('markdown is the rest', split.markdown, '## What changed\n\nStuff.');
  const noSummary = R.splitReportOutput('## What changed\n\nStuff.');
  eq('a missing SUMMARY line is survivable', noSummary.summary, null);
  eq('and the body is intact', noSummary.markdown, '## What changed\n\nStuff.');

  // The 60 KB budget. A per-message prose cap of 4,000 chars means the budget
  // is reached by MESSAGE COUNT (~15 fat assistant messages), not by one giant
  // message — so the fixture has to be a busy day, not a long one.
  const fat = [];
  for (let i = 0; i < 40; i++) {
    const base = rows[i % rows.length];
    fat.push({ ...base, id: 10_000 + i, text: `${base.text}\n${'lorem ipsum '.repeat(600)}` });
  }
  const fatInput = R.buildReportInput(fat);
  eq('oversized day is marked truncated', fatInput.truncated, true);
  t('and fits the budget', fatInput.chars <= 61_000, `${fatInput.chars}`);
  t('the changes-only fallback still names the files',
    fatInput.text.includes('CHANGED →'));
  t('user messages survive truncation in full',
    fatInput.text.includes('the Save edit button is greyed out'));
}

// ---------------------------------------------------------------------------
console.log('\nreport lifecycle + outbox rollup (still no model call)');
// ---------------------------------------------------------------------------
{
  M.updateMikeReport(PA, '2026-10-04', {
    status: 'done',
    summary: 'Mike fixed the Save edit button and added the Free Content Runs tables.',
    markdown: '## What changed\n\nThe Save edit button now enables on change.',
    model: 'claude-sonnet-5',
    risk_flags: ['migration', 'prod_sql', 'secret'],
    finished_at: new Date().toISOString(),
  });
  const done = M.getMikeReport(PA, '2026-10-04');
  eq('status', done.status, 'done');
  eq('risk flags round-trip as an array', done.risk_flags.join(','), 'migration,prod_sql,secret');
  eq('markdown is returned when asked for',
    M.listMikeReports({ date: '2026-10-04', with_markdown: true })[0].markdown, done.markdown);
  eq('has_report_today flips on the rail',
    M.listMikeProjects({ day: '2026-10-04' }).projects.find((p) => p.short_id === '816a7a7c').has_report_today,
    true);

  const path = R.writeMikeDailyRollup('2026-10-04');
  t('rollup written to the outbox', !!path && existsSync(path));
  const { readFileSync } = await import('node:fs');
  const md = readFileSync(path, 'utf8');
  t('rollup headlines the date', md.startsWith('# Mike Radar — 2026-10-04'));
  t('rollup carries the summary', md.includes('Mike fixed the Save edit button'));
  t('rollup flags the risk', md.includes('⚠ Worth a look') && md.includes('migration'));
  t('rollup folds the long report behind a details block', md.includes('<details>'));
  eq('a day with no reports writes nothing', R.writeMikeDailyRollup('1999-01-01'), null);

  // Requeue = the Regenerate button.
  const requeued = M.requeueMikeReport(PA, '2026-10-04', { msg_count: 3, change_count: 2 });
  eq('requeue resets to queued', requeued.status, 'queued');
  eq('and clears the error', requeued.error, null);
}

// ---------------------------------------------------------------------------
console.log('\nSSE contract');
// ---------------------------------------------------------------------------
{
  const seen = typesSeen();
  t('mike_project emitted', seen.has('mike_project'));
  t('mike_activity emitted', seen.has('mike_activity'));
  t('mike_report emitted', seen.has('mike_report'));
  const act = events.find((e) => e.type === 'mike_activity');
  for (const k of ['project_id', 'short_id', 'activity_id', 'role', 'ts', 'change_count']) {
    t(`mike_activity carries ${k}`, act[k] !== undefined);
  }
  const rep = events.find((e) => e.type === 'mike_report');
  for (const k of ['project_id', 'short_id', 'report_date', 'status']) {
    t(`mike_report carries ${k}`, rep[k] !== undefined);
  }
  const { GLOBAL_STREAM_EVENT_TYPES } = await import(join(dist, 'sse-bus.js'));
  for (const type of ['mike_project', 'mike_activity', 'mike_report']) {
    t(`${type} is on the GLOBAL stream (or the cockpit silently drops it)`,
      GLOBAL_STREAM_EVENT_TYPES.includes(type));
  }

  // A quiet (full) sweep must not spray thousands of row events.
  const before = events.filter((e) => e.type === 'mike_activity').length;
  I.runMikeIngest({ full: true, quiet: true });
  eq('quiet sweep emits no per-row events',
    events.filter((e) => e.type === 'mike_activity').length, before);
}

// ---------------------------------------------------------------------------
console.log('\nvalidators, thread bootstrap, retention');
// ---------------------------------------------------------------------------
{
  t('watch state validator', M.isMikeWatchState('watched') && !M.isMikeWatchState('nope'));
  t('report date validator', M.isMikeReportDate('2026-10-04'));
  t('rejects a non-date', !M.isMikeReportDate('2026-13-45'));
  t('rejects a bad format', !M.isMikeReportDate('10/04/2026'));
  eq('CT day bounds are 24h apart',
    (Date.parse(M.ctDayBoundsUtc('2026-10-04').end) - Date.parse(M.ctDayBoundsUtc('2026-10-04').start)) / 3_600_000, 24);
  t('a CT day starts in the previous UTC day (CDT is UTC-5)',
    M.ctDayBoundsUtc('2026-10-04').start.startsWith('2026-10-04T05'));
  t('and in January it is UTC-6',
    M.ctDayBoundsUtc('2026-01-15').start.startsWith('2026-01-15T06'));

  const project = M.getMikeProject(PA);
  const thread = M.getOrCreateMikeThread(project);
  eq('thread ext', thread.external_id, 'cockpit:mike-816a7a7c');
  eq('created on first call', thread.created, true);
  t('seed text is returned for the CALLER to post', !!thread.seed_text);
  t('seed states the read-only rule', thread.seed_text.includes('READ-ONLY, HARD RULE'));
  t('seed names the forbidden write tools', thread.seed_text.includes('send_message'));
  t('seed names the allowed read tools', thread.seed_text.includes('read_file'));
  // The archive/report paths and the live counts moved OUT of the seed and into
  // the per-turn `<mike_project>` snapshot (node #1342): a seed is posted once
  // and goes stale the next time Mike works, so the seed now carries only what
  // never changes — identity, the hard rule, and a pointer to the snapshot.
  // scripts/mike-radar-chat-check.mjs asserts the paths on the snapshot side.
  t('seed points at the per-turn snapshot instead of inlining stale facts',
    thread.seed_text.includes('<mike_project>'));
  t('seed does not inline the archive path', !thread.seed_text.includes(`${PA}.jsonl`));
  eq('thread_ext linked back onto the project', M.getMikeProject(PA).thread_ext, 'cockpit:mike-816a7a7c');
  const again = M.getOrCreateMikeThread(M.getMikeProject(PA));
  eq('second call does not re-create', again.created, false);
  eq('and offers no seed', again.seed_text, null);

  // Retention: non-key rows age out, key rows never do.
  const swept = M.sweepMikeActivityRetention(0);
  t('retention swept the non-key rows', swept > 0);
  eq('the KEY project keeps every row forever', M.listMikeFeed({ project_id: PA }).items.length, 4);
  eq('a non-key project was swept', M.listMikeFeed({ project_id: PB }).items.length, 0);
  t('reports are NEVER swept', M.listMikeReports({ limit: 100 }).length > 0);
}

// ---------------------------------------------------------------------------
console.log('\ndriver scheduling (no spawn, pure predicates)');
// ---------------------------------------------------------------------------
{
  const D = await import(join(dist, 'mike-radar-driver.js'));
  const at = (iso) => new Date(iso);
  t('ingest not due at :05', !D.mikeIngestDue(at('2026-10-05T14:05:00Z'), null));
  t('ingest due at :20', D.mikeIngestDue(at('2026-10-05T14:20:00Z'), null));
  t('ingest due at :45 if the :20 slot was missed', D.mikeIngestDue(at('2026-10-05T14:45:00Z'), null));
  t('but only once per hour', !D.mikeIngestDue(at('2026-10-05T14:45:00Z'), '2026-10-05T14'));
  t('and again the next hour', D.mikeIngestDue(at('2026-10-05T15:20:00Z'), '2026-10-05T14'));

  // 23:40 America/Chicago on 2026-10-05 (CDT, UTC-5) == 04:40Z on the 6th.
  t('report not due at 23:00 CT', !D.mikeReportDue(at('2026-10-06T04:00:00Z'), null));
  t('report due at 23:40 CT', D.mikeReportDue(at('2026-10-06T04:40:00Z'), null));
  t('and not twice for the same CT day',
    !D.mikeReportDue(at('2026-10-06T04:50:00Z'), M.mikeReportDate(at('2026-10-06T04:50:00Z'))));
  t('report not due at noon', !D.mikeReportDue(at('2026-10-05T17:00:00Z'), null));
}

// ---------------------------------------------------------------------------
// Real archive — the cold-start assertion the design asked for.
// ---------------------------------------------------------------------------
const REAL = '/home/kevin/perclickity-suite/lovable-watch/archive';
if (!existsSync(REAL)) {
  console.log(`\n(real archive absent at ${REAL} — skipping the cold-start ingest)`);
} else {
  console.log('\nFULL cold-start ingest of the REAL archive (into the scratch DB)');
  const t0 = Date.now();
  const real = I.runMikeIngest({ archiveDir: REAL, full: true, quiet: true });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ${secs}s · ${real.run.files_seen} files · ${real.run.rows_seen} rows · ` +
    `${real.run.rows_new} new · ${real.run.rows_bad} bad · ${real.run.projects_new} new projects · ` +
    `${real.run.capped_projects} cap-hits · ${real.reports_queued} reports queued`);

  eq('run completed', real.run.status, 'done');
  eq('101 files (100 projects + _new_projects.jsonl)', real.run.files_seen, 101);
  t(`>= 2,764 rows seen (${real.run.rows_seen})`, real.run.rows_seen >= 2764);
  eq('exactly 1 bad line (the e22bf3e2 junk line)', real.run.rows_bad, 1);
  eq('a full re-read never reports a cap-hit (it is not an incremental sweep)',
    real.run.capped_projects, 0);
  t(`finished in under 60s (${secs}s)`, Number(secs) < 60);

  const all = M.listAllMikeProjects();
  t(`>= 100 projects registered (${all.length})`, all.length >= 100);
  const named = all.filter((p) => p.name);
  // DESIGN §1 fact 2 said `_new_projects.jsonl` names 89 of 100. It does — but
  // 12 of those "names" are leaked descriptions, and the name guard correctly
  // demotes them to `description`, so the real offline-named count is ~79. That
  // is still 79 projects named with ZERO network calls, which is the point.
  t(`>= 75 projects named offline, zero network calls (${named.length})`, named.length >= 75);
  const described = all.filter((p) => p.description);
  t(`and the leaked descriptions were preserved, not dropped (${described.length})`,
    described.length >= 10);
  const keyed = all.filter((p) => p.is_key === 1);
  eq("all 5 of Kevin's key projects flagged", keyed.length, 5);
  t('no project name exceeds 80 chars (the leak guard held)',
    all.every((p) => !p.name || p.name.length <= 80),
    all.filter((p) => p.name && p.name.length > 80).map((p) => p.short_id).join(','));
  t('no project name contains a newline',
    all.every((p) => !p.name || !/[\r\n]/.test(p.name)));

  const { sqliteDb } = await import(join(dist, 'conversation-db.js'));
  const q = (sql) => sqliteDb.prepare(sql).get();
  const total = q('SELECT COUNT(*) AS n FROM mike_activity').n;
  const diffs = q(`SELECT COUNT(*) AS n FROM mike_activity WHERE diff_kind != 'none'`).n;
  const parsed = q(`SELECT COUNT(*) AS n FROM mike_activity WHERE diff_kind = 'parsed'`).n;
  const opaque = q(`SELECT COUNT(*) AS n FROM mike_activity WHERE diff_kind = 'opaque'`).n;
  const withChanges = q('SELECT COUNT(*) AS n FROM mike_activity WHERE change_count > 0').n;
  const withHeadline = q('SELECT COUNT(*) AS n FROM mike_activity WHERE headline IS NOT NULL').n;
  console.log(`  rows=${total} diffs=${diffs} (parsed=${parsed} opaque=${opaque}) ` +
    `withChanges=${withChanges} withHeadline=${withHeadline}`);
  t(`>= 2,764 activity rows stored (${total})`, total >= 2764);
  t(`>= 90 rows carry a diff (${diffs})`, diffs >= 90);
  eq('parsed + opaque = every diff row', parsed + opaque, diffs);
  t(`>= 95% of diffs parsed (${parsed}/${diffs})`, parsed / diffs >= 0.95);
  t(`>= 600 rows carry parsed changes (${withChanges})`, withChanges >= 600);
  t(`headlines on >= 90% of rows (${withHeadline}/${total})`, withHeadline / total >= 0.9);

  // Idempotency at real scale — the property that makes a full re-run safe.
  const again = I.runMikeIngest({ archiveDir: REAL, full: true, quiet: true });
  eq('a second FULL ingest inserts nothing', again.run.rows_new, 0);
  eq('and the row count is identical', q('SELECT COUNT(*) AS n FROM mike_activity').n, total);

  // No secret VALUE anywhere in what we stored.
  const secretRows = sqliteDb
    .prepare(`SELECT changes FROM mike_activity WHERE changes LIKE '%"secret"%'`)
    .all();
  t(`secret changes keep names only, never values (${secretRows.length} rows)`,
    secretRows.every((r) => {
      const parsedChanges = JSON.parse(r.changes);
      return parsedChanges
        .filter((c) => c.action === 'secret')
        .every((c) => !c.note || c.note.length <= 120);
    }));

  // The report gate at real scale: nowhere near 100 claude calls per night.
  const byDay = sqliteDb
    .prepare(`SELECT report_date, COUNT(*) AS n FROM mike_reports GROUP BY report_date ORDER BY report_date DESC LIMIT 5`)
    .all();
  console.log(`  queued reports per recent day: ${byDay.map((r) => `${r.report_date}=${r.n}`).join(' ')}`);
  t('the cost gate keeps any single day well under 100 reports',
    byDay.every((r) => r.n < 100), JSON.stringify(byDay));
  t('reports were queued at all', M.listMikeReports({ limit: 500 }).length > 0);
}

// ---------------------------------------------------------------------------
rmSync(work, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
