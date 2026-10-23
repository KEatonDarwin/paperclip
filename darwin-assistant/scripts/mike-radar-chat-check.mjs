#!/usr/bin/env node
// MIKE RADAR CHAT + CUE CHECK (tree-49d228a8, node #1342) — the two halves of
// the chat-bootstrap node, on a SCRATCH sqlite DB with a fixture archive:
//
//   A) the per-turn `<mike_project>` context block (src/mike-radar-chat.ts) and
//      its wiring into agent.ts's per-turn prompt prefix, and
//   B) the daily report cue into Kevin's oversight thread + the bell
//      (src/mike-radar-cue.ts), including dedupe, the busy-thread path, the
//      quiet-day path and turn admission.
//
// NO model call and NO API KEYS: dist/agent.js's dynamic import from
// mike-radar-cue.js is swapped for a recording stub by
// scripts/mike-radar-chat-check.hooks.mjs. Nothing of Mike's is read or touched
// — the archive is a fixture under /tmp.
//
//   npm run mike-radar:chat-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');

const raw = process.env.JARVIS_DB_PATH;
if (!raw || !/\/tmp\//.test(raw)) {
  console.error('FATAL: JARVIS_DB_PATH must be a scratch path under /tmp.');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
if (DB_PATH === path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db')) {
  console.error('FATAL: refusing to run against the live jarvis.db.');
  process.exit(1);
}
for (const p of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) fs.rmSync(p, { force: true });

process.env.JARVIS_SIM = '1';
process.env.MIKE_RADAR_DRIVER = '0';
process.env.CLAUDE_USAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mike-chat-usage-'));
delete process.env.ANTHROPIC_API_KEY;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mike-chat-'));
const archive = path.join(work, 'archive');
fs.mkdirSync(archive, { recursive: true });
process.env.MIKE_RADAR_ARCHIVE_DIR = archive;
process.env.MIKE_RADAR_OUTBOX_DIR = path.join(work, 'outbox');

register(pathToFileURL(path.join(__dirname, 'mike-radar-chat-check.hooks.mjs')), import.meta.url);

// ── fixture archive: two projects, one busy day ─────────────────────────────
const PA = '816a7a7c-bb38-406a-8207-ea8dfe3b1db4'; // PerClickity (key, known supabase ref)
const PB = 'c58c6323-1111-4222-8333-ea8dfe3b1db4'; // Command Center (key)
const DAY = '2026-10-04';
const TU = (name, data) =>
  `<lov-tool-use id="x" name="${name}" integration-id="code" data="${data}">\n</lov-tool-use>`;

const rows = (pid, msgs) => msgs.map((r) => `${JSON.stringify({ project_id: pid, ...r })}\n`).join('');

fs.writeFileSync(path.join(archive, `${PA}.jsonl`), rows(PA, [
  { captured_at: '2026-10-04T23:00:00Z', message_id: 'a1', role: 'user',
    created_at: '2026-10-04T15:00:00Z', text: 'the clearing verdict is firing at 108s', commit_sha: null, diff: null },
  { captured_at: '2026-10-04T23:00:00Z', message_id: 'a2', role: 'assistant',
    created_at: '2026-10-04T15:01:00Z',
    text: `${TU('code--line_replace', '{\\"file_path\\": \\"src/clearing/verdict.ts\\"}')}\n\nTightened the verdict window to 90s.`,
    commit_sha: 'deadbeefcafe', diff: '--- a/src/clearing/verdict.ts\n+++ b/src/clearing/verdict.ts\n@@ -1 +1 @@\n-const HOLD = 108;\n+const HOLD = 90;\n' },
  { captured_at: '2026-10-04T23:00:00Z', message_id: 'a3', role: 'assistant',
    created_at: '2026-10-04T16:20:00Z',
    text: `${TU('supabase--migration', '{\\"name\\": \\"add_v2_score\\"}')}\n\nAdded the v2_score column.`,
    commit_sha: null, diff: null },
]), 'utf8');

fs.writeFileSync(path.join(archive, `${PB}.jsonl`), rows(PB, [
  { captured_at: '2026-10-04T23:00:00Z', message_id: 'b1', role: 'assistant',
    created_at: '2026-10-04T17:00:00Z',
    text: `${TU('code--write', '{\\"file_path\\": \\"src/pages/Chips.tsx\\"}')}\n\nNew chips page.`,
    commit_sha: null, diff: null },
]), 'utf8');

// ── load the real modules ──────────────────────────────────────────────────
const convDb = await import(path.join(distDir, 'conversation-db.js'));
const radar = await import(path.join(distDir, 'mike-radar.js'));
const chat = await import(path.join(distDir, 'mike-radar-chat.js'));
const cue = await import(path.join(distDir, 'mike-radar-cue.js'));
const admission = await import(path.join(distDir, 'turn-admission.js'));
const queue = await import(path.join(distDir, 'thread-message-queue.js'));
const notifications = await import(path.join(distDir, 'notifications.js'));
const ingest = await import(path.join(distDir, 'mike-radar-ingest.js'));

ingest.runMikeIngest();

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};
const eq = (name, a, b) => t(name, a === b, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const has = (name, hay, needle) => t(name, String(hay).includes(needle), `missing ${JSON.stringify(needle)}`);
const hasnt = (name, hay, needle) => t(name, !String(hay).includes(needle), `unexpectedly contains ${JSON.stringify(needle)}`);

const cueCalls = () => globalThis.__mikeCueCalls ?? [];
async function settle(ms = 300) { await new Promise((r) => setTimeout(r, ms)); }

// ===========================================================================
console.log('\n── A1. thread-id parsing ───────────────────────────────────');
// ===========================================================================
eq('cockpit:mike-816a7a7c → short id', chat.mikeShortIdFromThread('cockpit:mike-816a7a7c'), '816a7a7c');
eq('uppercase short id is normalised', chat.mikeShortIdFromThread('cockpit:mike-816A7A7C'), '816a7a7c');
eq('a goal thread is not a project chat', chat.mikeShortIdFromThread('cockpit:goal-6'), null);
eq('a bare prefix is not a project chat', chat.mikeShortIdFromThread('cockpit:mike-'), null);
// The guard that matters: a future `cockpit:mike-radar-*` thread (a worker, a
// page-level chat) must NEVER be mistaken for a per-project chat.
eq('cockpit:mike-radar-worker-3 is NOT a project chat', chat.mikeShortIdFromThread('cockpit:mike-radar-worker-3'), null);
eq('non-hex suffix is rejected', chat.mikeShortIdFromThread('cockpit:mike-zzzzzzzz'), null);

// ===========================================================================
console.log('\n── A2. the per-turn <mike_project> block ───────────────────');
// ===========================================================================
eq('non-mike thread gets NO block', chat.buildMikeThreadContext('cockpit:goal-6'), '');
eq('unknown project gets NO block', chat.buildMikeThreadContext('cockpit:mike-deadbeef'), '');

radar.applyMikeProjectName(PA, 'PerClickity', 'Mike\'s live clearing + link app', 'kevin');
const block = chat.buildMikeThreadContext('cockpit:mike-816a7a7c');
t('project chat gets a block', block.length > 400, `len=${block.length}`);
has('opens <mike_project', block, '<mike_project ');
has('closes </mike_project>', block, '</mike_project>');
has('carries the short id attr', block, 'short_id="816a7a7c"');
has('carries the full project uuid', block, PA);
has('carries the display name', block, 'name="PerClickity"');
// The known-ref table (spec) must reach the chat without a Lovable round-trip.
has('carries the known Supabase ref', block, 'supabase="onxbfneqvjapberusidr"');
has('names the archive JSONL path', block, `${archive}/${PA}.jsonl`);
has('names the outbox report path', block, path.join(work, 'outbox'));
has('names the per-date report API', block, '/api/v1/mike-radar/reports/816a7a7c/');
has('names the Lovable workspace', block, 'K6cBsTKUF3zPecLp51dx');
has('states the read-only hard rule', block, 'READ-ONLY, HARD RULE');
has('names an allowed read tool', block, 'read_file');
has('names the forbidden write tool', block, 'send_message');
has('names the forbidden deploy tool', block, 'deploy_project');
// Without this a chat told "use read_file" reports the tool as missing.
has('explains the mcp_call convention', block, 'mcp_call');
has('bans the lovable_send_message wrapper', block, 'lovable_send_message');
has('lists the recent code changes', block, 'code-changing messages');
has('shows the real headline', block, 'Tightened the verdict window');
has('shows the commit sha', block, 'deadbeef');
t('lists BOTH changing messages', (block.match(/\n- \d\d-\d\d /g) ?? []).length === 2,
  `got ${(block.match(/\n- \d\d-\d\d /g) ?? []).length}`);
hasnt('excludes the non-changing user message', block, 'the clearing verdict is firing at 108s');
has('says no report exists yet', block, 'No daily report has been written');

// ===========================================================================
console.log('\n── A3. agent.ts actually injects it ────────────────────────');
// ===========================================================================
// The block is worthless if nothing prefixes it onto the turn. Assert the real
// wiring rather than trusting the edit: agent.js is loaded for real here (the
// loader hook only swaps the copy mike-radar-cue.js imports).
const agentSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'agent.ts'), 'utf8');
t('agent.ts imports buildMikeThreadContext', /import \{ buildMikeThreadContext \} from '\.\/mike-radar-chat\.js';/.test(agentSrc));
t('agent.ts builds the block from the thread ext',
  /const mikeContextBlock = buildMikeThreadContext\(conv\.external_id\)/.test(agentSrc));
t('agent.ts concatenates it into perTurnContextPrefix',
  /const perTurnContextPrefix = .*\+ mikeContextBlock \+/.test(agentSrc));

// ===========================================================================
console.log('\n── A4. the find-or-create seed still agrees with the block ─');
// ===========================================================================
const projA = radar.getMikeProjectByRef('816a7a7c');
const thread = radar.getOrCreateMikeThread(projA);
eq('thread ext shape', thread.external_id, 'cockpit:mike-816a7a7c');
eq('first call reports created', thread.created, true);
has('seed states the hard rule', thread.seed_text, 'READ-ONLY, HARD RULE');
has('seed points at the per-turn snapshot', thread.seed_text, '<mike_project>');
has('seed carries the mcp_call convention', thread.seed_text, 'mcp_call');
// Live counts belong to the snapshot, not the seed — a seed that quoted them
// would be wrong the next time Mike touched the project.
hasnt('seed does NOT hard-code a message count', thread.seed_text, 'archived messages');
const again = radar.getOrCreateMikeThread(radar.getMikeProjectByRef('816a7a7c'));
eq('second call does not re-seed', again.created, false);
eq('second call returns no seed text', again.seed_text, null);
t('block survives a bound thread', chat.buildMikeThreadContext(thread.external_id).includes('<mike_project '));

// ===========================================================================
console.log('\n── B1. turn admission knows the cue ───────────────────────');
// ===========================================================================
t('mike-report: is an AUTOMATED turn',
  admission.isAutomatedTurn('cockpit:2571a43a-5311-417b-8835-d23b74f3bfc3', `mike-report:${DAY}`));
t("Kevin's own turn in the same thread is NOT gated",
  !admission.isAutomatedTurn('cockpit:2571a43a-5311-417b-8835-d23b74f3bfc3', undefined));

// ===========================================================================
console.log('\n── B2. quiet day → no cue at all ──────────────────────────');
// ===========================================================================
cue.fireMikeReportCue('2026-01-01');
await settle(120);
eq('a day with no reports posts nothing', cueCalls().length, 0);
eq('…and burns no dedupe guard', convDb.getSetting('mike_report_cue:2026-01-01'), null);

// ===========================================================================
console.log('\n── B3. the real cue ───────────────────────────────────────');
// ===========================================================================
// Write the two reports the generator would have written (the generator itself
// is covered by mike-radar-report-check; here the subject is the cue).
const seedReport = (pid, day, summary, flags) => {
  radar.requeueMikeReport(pid, day, { msg_count: 3, change_count: 2 });
  radar.updateMikeReport(pid, day, {
    status: 'done', summary, markdown: `# ${summary}`, model: 'claude-sonnet-5',
    msg_count: 3, change_count: 2, risk_flags: flags, finished_at: new Date().toISOString(),
  });
};
seedReport(PA, DAY, 'Mike tightened the clearing verdict hold from 108s to 90s and added a v2_score column.', ['migration']);
seedReport(PB, DAY, 'Mike built a new chips page in the Command Center.', []);

const digest = cue.buildMikeCueDigest(DAY);
eq('digest counts both projects', digest.projects, 2);
eq('digest sums the changes', digest.changes, 4);
t('digest unions the risk flags', digest.risk_flags.includes('migration'), JSON.stringify(digest.risk_flags));

const OVERSIGHT = 'cockpit:2571a43a-5311-417b-8835-d23b74f3bfc3';
eq('default cue thread is the oversight chat', cue.mikeOversightThreadExt(), OVERSIGHT);
const conv = convDb.getOrCreateConversation(OVERSIGHT);
const notesBefore = notifications.listNotifications(50).length;

cue.fireMikeReportCue(DAY);
await settle(400);

eq('exactly ONE cue for the day', cueCalls().length, 1);
const posted = cueCalls()[0];
eq('posts into the oversight thread', posted.externalId, OVERSIGHT);
eq('correlation key shape', posted.correlationKey, `mike-report:${DAY}`);
has('fixed greppable header', posted.text, `[mike radar — daily report ${DAY}:`);
has('header counts the projects', posted.text, '2 projects');
has('names the first project', posted.text, 'PerClickity');
has('names the second project', posted.text, 'c58c6323');
has('carries the per-project summary', posted.text, 'tightened the clearing verdict hold');
has('flags the migration', posted.text, 'migration');
has('links the page', posted.text, `/mike-radar?date=${DAY}`);
has('links the outbox roll-up', posted.text, `${DAY}.md`);
has('tells JARVIS what to do next', posted.text, 'Next:');
has('re-states read-only in the cue', posted.text, 'READ-ONLY');
hasnt('does not invite a message to Mike', posted.text, 'send_message to Mike');

const notes = notifications.listNotifications(50);
t('raised one notification', notes.length === notesBefore + 1, `${notesBefore} → ${notes.length}`);
const note = notes[0];
has('notification titled for the day', note.title, DAY);
eq('notification sourced to mike-radar', note.source, 'mike-radar');
eq('notification links the day', note.link, `/mike-radar?date=${DAY}`);
eq('clean day is info severity', note.severity, 'info');

// ===========================================================================
console.log('\n── B4. dedupe ─────────────────────────────────────────────');
// ===========================================================================
t('guard was written', !!convDb.getSetting(`mike_report_cue:${DAY}`));
cue.fireMikeReportCue(DAY);
await settle(250);
eq('a second pass for the same day does NOT re-cue', cueCalls().length, 1);

// ===========================================================================
console.log('\n── B5. busy thread → queued, never dropped ────────────────');
// ===========================================================================
const DAY2 = '2026-10-05';
seedReport(PA, DAY2, 'Mike wired the sandbox clearing links.', []);
globalThis.__mikeInFlight = 'in-flight-msg';
const queuedBefore = queue.listQueuedMessages(conv.id).length;
cue.fireMikeReportCue(DAY2);
await settle(400);
globalThis.__mikeInFlight = undefined;
eq('no direct post while a turn is in flight', cueCalls().length, 1);
const queued = queue.listQueuedMessages(conv.id);
eq('the cue was QUEUED instead of dropped', queued.length, queuedBefore + 1);
has('the queued text is the real cue', queued[queued.length - 1].content, `[mike radar — daily report ${DAY2}:`);

// ===========================================================================
console.log('\n── B6. a failed report is reported, not hidden ─────────────');
// ===========================================================================
const DAY3 = '2026-10-06';
radar.requeueMikeReport(PB, DAY3, { msg_count: 2, change_count: 1 });
radar.updateMikeReport(PB, DAY3, { status: 'failed', error: 'claude one-shot returned nothing', finished_at: new Date().toISOString() });
const d3 = cue.buildMikeCueDigest(DAY3);
eq('digest sees the failure', d3.failed.length, 1);
eq('…and counts no written projects', d3.projects, 0);
const text3 = cue.composeMikeReportCue(d3);
has('cue names the hole in the day', text3, 'FAILED to write');
cue.fireMikeReportCue(DAY3);
await settle(300);
const noteFail = notifications.listNotifications(5)[0];
eq('a failed day escalates the bell to warning', noteFail.severity, 'warning');

// ===========================================================================
console.log('\n── B7. kill switch + thread override ──────────────────────');
// ===========================================================================
const DAY4 = '2026-10-07';
seedReport(PA, DAY4, 'Mike refactored the hub2 relay.', []);
convDb.setSetting('mike_report_cue', 'off');
const before4 = cueCalls().length;
cue.fireMikeReportCue(DAY4);
await settle(200);
eq('mike_report_cue=off silences the cue', cueCalls().length, before4);
eq('…and burns no guard', convDb.getSetting(`mike_report_cue:${DAY4}`), null);
convDb.setSetting('mike_report_cue', 'on');
convDb.setSetting('mike_report_cue_thread', 'cockpit:some-other-thread');
eq('thread override is honoured', cue.mikeOversightThreadExt(), 'cockpit:some-other-thread');
convDb.setSetting('mike_report_cue_thread', '');
eq('empty override falls back to the oversight chat', cue.mikeOversightThreadExt(), OVERSIGHT);

// ===========================================================================
console.log('\n── B8. missing conversation → bell only, no crash ─────────');
// ===========================================================================
convDb.setSetting('mike_report_cue_thread', 'cockpit:does-not-exist-anywhere');
const DAY5 = '2026-10-08';
seedReport(PA, DAY5, 'Mike touched the suppression builder.', []);
const before5 = cueCalls().length;
const notes5 = notifications.listNotifications(50).length;
cue.fireMikeReportCue(DAY5);
await settle(250);
eq('no thread post when the conversation is gone', cueCalls().length, before5);
t('the bell still fired', notifications.listNotifications(50).length === notes5 + 1);
convDb.setSetting('mike_report_cue_thread', '');

// ===========================================================================
console.log('\n── C. the report pass fires the cue ───────────────────────');
// ===========================================================================
const reportMod = fs.readFileSync(path.join(__dirname, '..', 'src', 'mike-radar-report.ts'), 'utf8');
t('runMikeReportPass imports the cue', /import \{ fireMikeReportCue \} from '\.\/mike-radar-cue\.js';/.test(reportMod));
t('…and calls it after the roll-up', /writeMikeDailyRollup\(date\);[\s\S]{0,400}fireMikeReportCue\(date\)/.test(reportMod));
t('…inside a try/catch so a cue throw cannot kill the pass',
  /try \{\s*fireMikeReportCue\(date\);\s*\} catch/.test(reportMod));
// The single-report regenerate route must NOT cue (Kevin is on the page when he
// clicks Regenerate). Exactly ONE call site in the whole module proves it: the
// import binding carries no `(`, so a second match could only be a real call.
t('exactly ONE cue call site — generateMikeReport does NOT cue',
  (reportMod.match(/fireMikeReportCue\(/g) ?? []).length === 1,
  `found ${(reportMod.match(/fireMikeReportCue\(/g) ?? []).length}`);

// ===========================================================================
console.log('\n── D. no API keys / no model calls were involved ───────────');
// ===========================================================================
t('ANTHROPIC_API_KEY never set', !process.env.ANTHROPIC_API_KEY);
t('OPENAI_API_KEY never set', !process.env.OPENAI_API_KEY);

console.log('\n─────────────────────────────────────────────');
console.log(`${fail === 0 ? '✅' : '❌'} mike-radar chat+cue check: ${pass} passed, ${fail} failed`);
console.log(`   scratch DB: ${DB_PATH}`);
console.log(`   fixture:    ${work}`);
fs.rmSync(work, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
