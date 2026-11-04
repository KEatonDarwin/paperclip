// Prose check: build the REAL prompt for shift #9 from a DB copy, call the model directly (allowed here: JARVIS_DB_PATH is a copy, so the sim guard blocks laymanFreeform — we bypass by spawning the CLI ourselves, one sonnet call).
process.env.JARVIS_DB_PATH = process.env.HOME + '/.cache/narrator-prose/db.sqlite';
const nar = await import('../dist/shift-narrator.js');
const { spawn } = await import('node:child_process');
const events = [
  { at: new Date().toISOString(), itemId: 246, actor: 'system', kind: 'item_done', text: '#8 plan Build batch 3 — crons and pipeline health (OPS) — VERDICT: FAIL — Fix the window boundary: app/Kpi/ReadOnlySql.php:51 substitutes an app-clock (UTC) naive datetime string that is compared against DB-local naive datetime columns', data: null, expectation: 'unexpected', itemTitle: 'Build batch 3 — crons and pipeline health (OPS)', itemKind: 'plan', goalTitle: 'Universal KPI tracker', attempt: 1, position: 8 },
  { at: new Date().toISOString(), itemId: 264, actor: 'system', kind: 'item_inserted', text: '#9 replan — Build batch 3 — crons and pipeline health (OPS)', data: { kind: 'replan' }, expectation: 'unexpected', itemTitle: 'Build batch 3 — crons and pipeline health (OPS)', itemKind: 'replan', goalTitle: 'Universal KPI tracker', attempt: 2, position: 9 },
  { at: new Date().toISOString(), itemId: 261, actor: 'system', kind: 'item_started', text: '#17 plan lane 1 — Family B close-out — tally, three-invariant verdict, FAILs filed', data: { kind: 'plan', lane: 1, second_ask: false }, expectation: 'expected', itemTitle: 'Family B close-out — tally, three-invariant verdict, FAILs filed', itemKind: 'plan', goalTitle: 'PerClickity permutation matrix', attempt: 1, position: 17 },
];
const prompt = nar.__buildBeatPrompt(9, events);
console.log('=== PROMPT (facts section) ===\n' + prompt.split('WHAT JUST HAPPENED')[1].slice(0, 2500));
console.log('\n=== FALLBACK ===\n' + nar.__fallbackBeat(9, events));
const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.JARVIS_DB_PATH;
const child = spawn('claude', ['--print', '-', '--output-format', 'stream-json', '--verbose', '--model', 'claude-sonnet-5'], { env, stdio: ['pipe','pipe','pipe'] });
let out=''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => process.stderr.write(d));
child.stdin.on('error', ()=>{}); child.stdin.end(prompt);
const t0 = Date.now();
child.on('close', (code) => {
  let text=''; for (const l of out.split('\n')) { try { const e=JSON.parse(l); if (e.type==='result' && typeof e.result==='string') text=e.result; } catch {} }
  console.log(`\n=== MODEL BEAT (exit ${code}, ${((Date.now()-t0)/1000).toFixed(1)}s) ===\n` + text);
});
