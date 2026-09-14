#!/usr/bin/env node
// gov-overrides-review.mjs — adversarial drift + footgun harness for the
// per-provider governor overrides (node #195 review, 2026-09-14).
//
// Loads a BASE governor build (pre-override, default = the live checkout's
// dist/) and the NEW build (this worktree's dist/) against the SAME scratch
// DB + usage files and asserts:
//   A) with no override KV set, every verdict is byte-identical to BASE minus
//      the new `override` field, across a 48-state usage/kevin-active matrix
//      for all four providers (+ governorStatus() default);
//   B) footgun KV values never reach on/off ('ON', 'On', 'on ', ' on', 'true',
//      '1', 'yes', 'OFF', 'off\n', 'Off', 'enabled');
//   C) an env var GOV_OVERRIDE_CLAUDE=on is IGNORED (KV-only, no env fallback);
//   D) exact 'on'/'off' take effect on the very next call, per-provider isolated.
//
// Run (after `npx tsc -p .` in this worktree):
//   node scripts/gov-overrides-review.mjs
//   GOV_BASE_DIST=/path/to/pre-change/dist node scripts/gov-overrides-review.mjs
// Never touches the live jarvis.db — it mkdtemps its own scratch root.
// governor modules against the SAME scratch DB + usage files, and asserts:
//   A) with no override KV set, every verdict is identical minus the new `override` field
//      across a matrix of usage/kevin-active states, for all 4 providers.
//   B) footgun values never reach on/off: 'ON', 'On', 'on ', ' on', 'true', '1', 'yes', 'OFF', 'off\n'
//   C) env GOV_OVERRIDE_CLAUDE=on is IGNORED (no env fallback).
//   D) exact 'on'/'off' do take effect, and take effect on the very next call (uncached).
import fs from 'node:fs';
import path from 'node:path';
const scratch = fs.mkdtempSync('/tmp/gov-review-');
const DB = path.join(scratch, 'jarvis.db');
const live = path.resolve('/home/kevin/paperclip/darwin-assistant/jarvis.db');
if (path.resolve(DB) === live) throw new Error('refusing live db');
process.env.JARVIS_DB_PATH = DB;
process.env.CLAUDE_USAGE_FILE = path.join(scratch, 'c.json');
process.env.CODEX_USAGE_FILE = path.join(scratch, 'x.json');
process.env.AUGGIE_USAGE_FILE = path.join(scratch, 'a.json');
process.env.DATABASE_URL = 'postgresql://scratch:scratch@127.0.0.1:1/never';
delete process.env.SLACK_BOT_TOKEN; delete process.env.SLACK_APP_TOKEN;
process.env.GOV_OVERRIDE_CLAUDE = 'on';   // (C) must be ignored by NEW
process.env.HOPPER_GOV_ENABLED = '1';

// Both modules share conversation-db via different module paths → two separate
// sqlite handles on the same file. Fine for reads; we write via NEW's db handle.
const here = path.dirname(new URL(import.meta.url).pathname);
const NEW_DIST = path.resolve(here, '..', 'dist');
const BASE_DIST = process.env.GOV_BASE_DIST ?? '/home/kevin/paperclip/darwin-assistant/dist';
if (!fs.existsSync(path.join(NEW_DIST, 'hopper-governor.js'))) throw new Error(`build first: ${NEW_DIST}/hopper-governor.js missing (npx tsc -p .)`);
console.log(`[gov-overrides-review] BASE=${BASE_DIST} NEW=${NEW_DIST} scratch=${scratch}`);
const BASE = await import(path.join(BASE_DIST, 'hopper-governor.js'));
const NEW  = await import(path.join(NEW_DIST, 'hopper-governor.js'));
const db   = await import(path.join(NEW_DIST, 'conversation-db.js'));

function writeJson(file, v) { fs.writeFileSync(file, JSON.stringify(v, null, 2) + '\n'); }
function setUsage({ c5h, wk, codex, auggie }) {
  writeJson(process.env.CLAUDE_USAGE_FILE, { five_hour: { utilization: c5h }, seven_day: { utilization: wk } });
  writeJson(process.env.CODEX_USAGE_FILE, { windows: [{ label: '7-day', used_percentage: codex }] });
  writeJson(process.env.AUGGIE_USAGE_FILE, { windows: [{ label: 'Credits', used_percentage: auggie }] });
}
let fails = 0, passes = 0;
function check(name, ok, extra='') { if (ok) { passes++; console.log('PASS', name); } else { fails++; console.log('FAIL', name, extra); } }
const strip = v => { const { override, ...rest } = v; return rest; };

// kevin-active: insert a real non-worker user turn like the sim does.
function markKevinActive(active) {
  db.sqliteDb.exec("DELETE FROM turns; DELETE FROM conversations;");
  if (!active) return;
  const conv = db.getOrCreateConversation('cockpit:review-kevin-active');
  db.addTurn(conv.id, 'user', 'simulated Kevin activity');
}

// Clear any override rows.
db.sqliteDb.exec("DELETE FROM settings WHERE key LIKE 'gov_override_%'");

// (A) drift matrix
const providers = ['claude','codex','auggie','devin'];
const matrix = [];
for (const c5h of [10, 55, 95]) for (const wk of [5, 35]) for (const active of [false,true]) for (const codex of [5, 95]) for (const auggie of [5, 90])
  matrix.push({ c5h, wk, active, codex, auggie });
let drift = 0;
for (const m of matrix) {
  setUsage(m); markKevinActive(m.active);
  for (const p of providers) {
    const b = BASE.governorCheck(p); const n = NEW.governorCheck(p);
    if (!('override' in n) || n.override !== 'auto') { drift++; console.log('  override field missing/not auto', p, m, n.override); }
    const bs = JSON.stringify(strip(b)), ns = JSON.stringify(strip(n));
    if (bs !== ns) { drift++; console.log('  DRIFT', p, JSON.stringify(m), '\n   base:', bs, '\n   new :', ns); }
  }
  // also governorStatus() default (no adapter) + governorStatusAll
  const bd = JSON.stringify(strip(BASE.governorStatus())), nd = JSON.stringify(strip(NEW.governorStatus()));
  if (bd !== nd) { drift++; console.log('  DRIFT status()', m); }
}
check(`A: auto path identical to base across ${matrix.length} states x 4 providers (+status())`, drift === 0, `drift=${drift}`);
// Sanity that the matrix actually exercised holds (not all 'ok'):
setUsage({ c5h:95, wk:5, codex:5, auggie:5 }); markKevinActive(false);
check('A-sanity: 5h=95 → five_hour_ceiling on NEW', NEW.governorCheck('claude').reason === 'five_hour_ceiling', NEW.governorCheck('claude').reason);
setUsage({ c5h:60, wk:5, codex:5, auggie:5 }); markKevinActive(true);
check('A-sanity: active+5h=60 → kevin_active on NEW', NEW.governorCheck('claude').reason === 'kevin_active', NEW.governorCheck('claude').reason);
setUsage({ c5h:10, wk:5, codex:95, auggie:5 }); markKevinActive(false);
check('A-sanity: codex=95 → provider_ceiling on NEW', NEW.governorCheck('codex').reason === 'provider_ceiling', NEW.governorCheck('codex').reason);

// (C) env override ignored
setUsage({ c5h:95, wk:5, codex:5, auggie:5 }); markKevinActive(true);
{ const n = NEW.governorCheck('claude'); check('C: env GOV_OVERRIDE_CLAUDE=on is ignored (still five_hour_ceiling, override=auto)', n.reason==='five_hour_ceiling' && n.override==='auto', JSON.stringify(n).slice(0,200)); }

// (B) footguns via KV
for (const bad of ['ON','On','on ',' on','true','1','yes','OFF','off\n','Off','enabled']) {
  db.setSetting('gov_override_claude', bad);
  const n = NEW.governorCheck('claude');
  check(`B: KV ${JSON.stringify(bad)} → auto (reason stays five_hour_ceiling)`, n.override==='auto' && n.reason==='five_hour_ceiling', `${n.override}/${n.reason}`);
}
// (D) exact values work, immediately, per-provider isolated
db.setSetting('gov_override_claude', 'on');
{ const n = NEW.governorCheck('claude'); check('D1: exact "on" → override_on allow=true despite 5h=95+active', n.allow===true && n.reason==='override_on' && n.override==='on'); }
{ const n = NEW.governorCheck('codex'); check('D2: codex untouched by claude override', n.override==='auto' && n.reason==='ok', `${n.override}/${n.reason}`); }
db.setSetting('gov_override_claude', 'off'); setUsage({ c5h:10, wk:5, codex:5, auggie:5 }); markKevinActive(false);
{ const n = NEW.governorCheck('claude'); check('D3: exact "off" → override_off allow=false even under low usage', n.allow===false && n.reason==='override_off'); }
db.setSetting('gov_override_claude', 'auto');
{ const n = NEW.governorCheck('claude'); check('D4: "auto" literal → normal ok', n.allow===true && n.reason==='ok' && n.override==='auto'); }
db.sqliteDb.exec("DELETE FROM settings WHERE key='gov_override_claude'");
{ const n = NEW.governorCheck('claude'); check('D5: unset → auto', n.override==='auto'); }
{ const all = NEW.governorStatusAll(); check('D6: governorStatusAll carries override on all 4', providers.every(p => all[p].override==='auto')); }

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
