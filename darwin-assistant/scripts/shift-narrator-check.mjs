process.env.JARVIS_DB_PATH = '/tmp/narrator-check.db';
process.env.JARVIS_SIM = '1';
const cdb = await import('../dist/conversation-db.js');
const ns = await import('../dist/night-shift.js');
const nar = await import('../dist/shift-narrator.js');
const { sqliteDb, setSetting, getConversation, getTurnsLean } = cdb;
ns.ensureNightShiftTables?.();
setSetting('night_narrator_debounce_ms', '600');
// fixture: goal + run + items
sqliteDb.prepare(`INSERT INTO goals (id, title, status) VALUES (8, 'PerClickity permutation matrix', 'set')`).run();
sqliteDb.prepare(`INSERT INTO night_runs (id, status, mode, config, goal_ids, prior_autopilot, thread_ext, label) VALUES (9,'running','until_stop','{"lanes":3}','[8]','{}','cockpit:shift-9','PerClickity matrix')`).run();
const ins = sqliteDb.prepare(`INSERT INTO night_items (id, run_id, position, goal_id, node_id, kind, title, why, status, lane, attempt, tree_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
ins.run(1, 9, 1, 8, 101, 'plan', 'Run the three settle_verdict rows live', 'goal_score 0.6 — next runnable machine leaf', 'done', null, 1, null);
ins.run(2, 9, 2, 8, 102, 'replan', 'Run the three settle_verdict rows live', 'attempt 2 of 2 after VERDICT: FAIL — undecided row never settled', 'running', 1, 2, null);
ins.run(3, 9, 3, 8, 103, 'plan', 'Fix impossible_geo, redeploy to sandbox, re-run green', 'added by jarvis — node is set', 'queued', null, 1, null);
// classification
const c = nar.classifyShiftEvent;
const item2 = { id:2, position:2, goal_id:8, node_id:102, kind:'replan', title:'x', why:'', status:'running', lane:1, attempt:2, tree_id:null, result_summary:null, est_minutes:60 };
const checks = [
  ['item_done PASS → expected', c('item_done','#1 plan … — VERIFY: PASS', null, null) === 'expected'],
  ['item_done FAIL → unexpected', c('item_done','#1 plan … — VERDICT: FAIL — gap', null, null) === 'unexpected'],
  ['item_started attempt 2 → unexpected', c('item_started','', {}, item2) === 'unexpected'],
  ['item_started fresh → expected', c('item_started','', {}, {...item2, attempt:1, kind:'plan'}) === 'expected'],
  ['second_ask → unexpected', c('item_started','', {second_ask:true}, {...item2, attempt:1, kind:'plan'}) === 'unexpected'],
  ['hold_clear → good_news', c('hold_clear','', null, null) === 'good_news'],
  ['run_stopped → milestone', c('run_stopped','', null, null) === 'milestone'],
];
// a burst: done(FAIL) + inserted replan + started replan → ONE beat (fallback, model blocked by sim guard)
const before = sqliteDb.prepare(`SELECT COUNT(*) n FROM night_events WHERE kind='narration'`).get().n;
ns.insertNightEvent(9, 1, 'system', 'item_done', '#1 plan Run the three settle_verdict rows live — VERDICT: FAIL — undecided row never settled');
ns.insertNightEvent(9, 2, 'system', 'item_inserted', '#2 replan — Run the three settle_verdict rows live', { kind: 'replan' });
ns.insertNightEvent(9, 2, 'system', 'item_started', '#2 replan lane 1 — Run the three settle_verdict rows live', { kind: 'replan', lane: 1, second_ask: false });
ns.insertNightEvent(9, null, 'jarvis', 'orchestrator_log', 'this must NOT be narrated');
await new Promise(r => setTimeout(r, 2500));
const beats = sqliteDb.prepare(`SELECT text, data FROM night_events WHERE kind='narration' ORDER BY id`).all();
const conv = getConversation('cockpit:shift-9');
const turns = conv ? getTurnsLean(conv.id) : [];
checks.push(['exactly ONE beat for a 3-event burst', beats.length - before === 1]);
checks.push(['beat source = fallback (sim guard blocked the model)', beats.length && JSON.parse(beats[0].data).source === 'fallback']);
checks.push(['beat posted as assistant turn with 🎙 mark', turns.length === 1 && turns[0].role === 'assistant' && turns[0].content.startsWith('🎙 ')]);
checks.push(['narration itself not re-narrated', sqliteDb.prepare(`SELECT COUNT(*) n FROM night_events WHERE kind='narration'`).get().n === 1]);
// disable knob
setSetting('night_narrator_enabled', '0');
ns.insertNightEvent(9, 3, 'system', 'item_started', '#3 plan lane 2 — Fix impossible_geo');
await new Promise(r => setTimeout(r, 1200));
checks.push(['night_narrator_enabled=0 → no beat', sqliteDb.prepare(`SELECT COUNT(*) n FROM night_events WHERE kind='narration'`).get().n === 1]);
let fail = 0;
for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) fail++; }
console.log('\n--- fallback beat text ---\n' + (turns[0]?.content ?? '(none)'));
console.log(`\n${checks.length - fail}/${checks.length} passed`);
process.exit(fail ? 1 : 0);
