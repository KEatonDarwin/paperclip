#!/usr/bin/env node
// SYSTEM TIMERS PARSER TESTS (tree-0dbc1aa9 node #1679).
//
//   npm run system-timers:test        (builds first)
//
// Every input is REAL captured bytes in test-fixtures/system-timers/ — the
// output of `systemctl list-timers --output=json`, `systemctl show`, and
// `systemd-analyze calendar` run on this box (capture time in capture.meta),
// plus one transient armed-but-never-fired timer captured separately because
// no real timer on the box is in that state. Nothing is hand-written, so the
// assertions can't just echo the parser's own assumptions. No model calls, no
// network, no DB, nothing live is touched.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from '../dist/system-timers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const F = path.join(here, '..', 'test-fixtures', 'system-timers');
const read = (n) => fs.readFileSync(path.join(F, n), 'utf8');
const CAPTURE_NOW = Number(/capture_epoch_ms=(\d+)/.exec(read('capture.meta'))[1]);
const DAY = 86_400_000;

const specs = read('calendar-specs.txt').trim().split('\n');
const gaps = T.parseAnalyzeCalendarGaps(read('analyze-calendar.txt'), specs.length);
const calendarGapMs = new Map(specs.map((s, i) => [s, gaps[i]]));
const agentKeys = new Set(['hub-error-triage', 'teams-radar']);

const build = (now, extra = {}) => T.buildSystemTimers({
  listTimersJson: read('list-timers.json'),
  timersShow: read('timers.show'),
  servicesShow: read('services.show'),
  calendarGapMs, agentKeys, now, ...extra,
});
const byUnit = (rows, u) => { const r = rows.find((x) => x.unit === u); assert.ok(r, `${u} missing`); return r; };
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };

// ── fixture sanity: the captured facts the cases below rely on ──────────────
ok('fixtures hold every timer, real shapes included', () => {
  const rows = build(CAPTURE_NOW);
  assert.equal(rows.length, T.parseListTimersJson(read('list-timers.json')).length);
  assert.ok(rows.length >= 40, `expected the full set, got ${rows.length}`);
  // The raw bytes the cases depend on, asserted against the fixture itself.
  assert.match(read('timers.show'), /Id=fstrim\.timer\n(?:.*\n)*?/);
  assert.match(read('services.show'), /Result=exit-code\n(?:.*\n)*?.*Id=alpha-trainer-distill\.service/);
});

// ── (a) a timer with no next run (not armed) ────────────────────────────────
ok('(a) fstrim: no next run, inactive -> not armed, flagged abnormal', () => {
  const r = byUnit(build(CAPTURE_NOW), 'fstrim.timer');
  assert.equal(r.next_run_at, null);
  assert.equal(r.armed, false);
  assert.equal(r.state, 'inactive/dead');
  assert.equal(r.enabled, true);
  assert.equal(r.abnormal, true);
  assert.deepEqual(r.reasons, ['never_fired']);
});
ok('(a) intel-pull: no next run BUT its service is running -> armed, NOT abnormal', () => {
  const r = byUnit(build(CAPTURE_NOW), 'intel-pull.timer');
  assert.equal(r.next_run_at, null);
  assert.equal(r.service_running, true);
  assert.equal(r.armed, true);
  assert.equal(r.abnormal, false);
});

// ── (b) a timer whose last result is non-zero ───────────────────────────────
ok('(b) exit 1 -> last_run_ok=false, failed (alpha-trainer-distill, model-watch)', () => {
  const rows = build(CAPTURE_NOW);
  for (const u of ['alpha-trainer-distill.timer', 'model-watch.timer']) {
    const r = byUnit(rows, u);
    assert.equal(r.last_run_ok, false, u);
    assert.equal(r.last_result, 'exit-code');
    assert.equal(r.last_exit_status, 1);
    assert.equal(r.armed, true, 'a failed timer is still armed — failure is what makes it abnormal');
    assert.equal(r.abnormal, true);
    assert.deepEqual(r.reasons, ['failed']);
  }
});
ok('(b) exit 203 (EXEC) is reported with its code (teams-radar)', () => {
  const r = byUnit(build(CAPTURE_NOW), 'teams-radar.timer');
  assert.equal(r.last_exit_status, 203);
  assert.equal(r.abnormal, true);
  assert.ok(r.reasons.includes('failed'));
});

// ── (c) a timer that has never fired ────────────────────────────────────────
const nf = (now) => T.buildSystemTimers({
  listTimersJson: read('never-fired.list-timers.json'),
  timersShow: read('never-fired.timer.show'),
  servicesShow: read('never-fired.service.show'),
  calendarGapMs, agentKeys, now,
})[0];
ok('(c) armed + never fired + next run still in the future -> waiting, NOT abnormal', () => {
  const r = nf(CAPTURE_NOW);
  assert.equal(r.last_trigger_at, null);
  assert.equal(r.armed, true);
  assert.equal(r.abnormal, false, 'a fresh yearly timer waiting for its first fire is normal');
});
ok('(c) same timer once its first run is overdue -> never_fired', () => {
  const next = Date.parse(nf(CAPTURE_NOW).next_run_at ?? '') || CAPTURE_NOW + 366 * DAY;
  const r = nf(next + 2 * DAY);
  assert.equal(r.last_trigger_at, null);
  assert.equal(r.abnormal, true);
  assert.deepEqual(r.reasons, ['never_fired']);
});

// ── overdue: 2x its own interval ────────────────────────────────────────────
ok('overdue: a 10-min timer healthy at capture, overdue 3h later', () => {
  assert.equal(byUnit(build(CAPTURE_NOW), 'hub-error-triage.timer').abnormal, false);
  const later = byUnit(build(CAPTURE_NOW + 3 * 3_600_000), 'hub-error-triage.timer');
  assert.equal(later.interval_ms, 600_000);
  assert.equal(later.overdue, true);
  assert.deepEqual(later.reasons, ['overdue']);
  assert.ok(later.overdue_by_ms > 2 * 3_600_000);
});
ok('overdue: not flagged within 2x (threshold is inclusive of slack)', () => {
  const t = byUnit(build(CAPTURE_NOW + 15 * 60_000), 'hub-error-triage.timer'); // 10-min timer, <=~25 min since fire
  assert.equal(t.overdue, false);
});
ok('weekday spec uses its real max gap (Fri->Mon = 3d), not 24h', () => {
  const r = byUnit(build(CAPTURE_NOW), 'alpha-debrief-cue.timer');
  assert.equal(r.interval_ms, 3 * DAY);
});

// ── the quiet-by-default property ───────────────────────────────────────────
ok('capture-time roll-up is exactly the four real problems, everything else silent', () => {
  const abn = build(CAPTURE_NOW).filter((r) => r.abnormal).map((r) => r.unit).sort();
  assert.deepEqual(abn, ['alpha-trainer-distill.timer', 'fstrim.timer', 'model-watch.timer', 'teams-radar.timer']);
});
ok('abnormal sorts first', () => {
  const rows = build(CAPTURE_NOW);
  const firstNormal = rows.findIndex((r) => !r.abnormal);
  assert.ok(rows.slice(0, firstNormal).every((r) => r.abnormal));
  assert.ok(rows.slice(firstNormal).every((r) => !r.abnormal));
});
ok('agent-stable tag follows the registry key', () => {
  const rows = build(CAPTURE_NOW);
  assert.equal(byUnit(rows, 'hub-error-triage.timer').agent_stable, true);
  assert.equal(byUnit(rows, 'hub-error-triage.timer').agent_key, 'hub-error-triage');
  assert.equal(byUnit(rows, 'logrotate.timer').agent_stable, false);
});

// ── small parsers ───────────────────────────────────────────────────────────
ok('timespan parser handles the shapes systemd prints', () => {
  assert.equal(T.parseTimespanMs('5min'), 300_000);
  assert.equal(T.parseTimespanMs('1min 30s'), 90_000);
  assert.equal(T.parseTimespanMs('4w 2d'), (28 + 2) * DAY);
  assert.equal(T.parseTimespanMs('nonsense'), null);
});
ok('analyze parser returns null (not a guess) when blocks do not line up', () => {
  assert.deepEqual(T.parseAnalyzeCalendarGaps(read('analyze-calendar.txt'), specs.length + 1).every((g) => g === null), true);
});
ok('every captured calendar spec got a real gap', () => {
  assert.ok(gaps.every((g) => typeof g === 'number' && g > 0), JSON.stringify(gaps));
});

// ── end to end through the impure wrapper, with the real bytes as the "system" ─
ok('systemTimersPayload end to end over fixture-backed commands', () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push(`${cmd} ${args[0]}`);
    if (cmd === 'systemd-analyze') {
      // Hand back the captured blocks in the order the caller ASKED for them
      // (the wrapper's spec order is a Set order, not the fixture's sorted order).
      const asked = args.filter((a) => !a.startsWith('-') && a !== 'calendar');
      const blocks = read('analyze-calendar.txt').trim().split(/\n\s*\n/);
      return asked.map((spec) => {
        const b = blocks.find((blk) => blk.startsWith(`Normalized form: ${spec}\n`));
        assert.ok(b, `no captured analyze block for ${spec}`);
        return b;
      }).join('\n\n');
    }
    if (args[0] === 'list-timers') return read('list-timers.json');
    if (args[0] === 'show' && args.includes('-p') && args.some((a) => a.endsWith('.timer'))) return read('timers.show');
    if (args[0] === 'show') return read('services.show');
    throw new Error(`unexpected ${cmd} ${args}`);
  };
  const p = T.systemTimersPayload({ run, now: CAPTURE_NOW, agentKeys });
  assert.equal(p.ok, true, p.error ?? '');
  assert.equal(p.counts.total, build(CAPTURE_NOW).length);
  assert.equal(p.counts.abnormal, 4);
  assert.equal(p.counts.agent_stable, 2);
  assert.equal(calls.filter((c) => c.startsWith('systemd-analyze')).length, 1, 'one batched analyze call');
  const again = T.systemTimersPayload({ run, now: CAPTURE_NOW, agentKeys });
  assert.equal(again.counts.abnormal, 4);
});
ok('systemctl unreachable -> ok:false with the error, never a throw', () => {
  const p = T.systemTimersPayload({ run: () => { throw new Error('bus down'); }, now: CAPTURE_NOW, agentKeys });
  assert.equal(p.ok, false);
  assert.match(p.error, /bus down/);
  assert.deepEqual(p.timers, []);
});

console.log(`\n${n} checks passed`);
