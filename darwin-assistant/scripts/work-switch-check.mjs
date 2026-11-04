/**
 * work-switch-check — regression suite for the stop-all / per-lane work switch.
 * Runs against the COMPILED dist (same code the live service loads) on a scratch
 * switch file. Zero model calls, zero DB, no live state touched.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ws-check-'));
const file = join(dir, 'work-switch.json');
process.env['JARVIS_WORK_SWITCH_PATH'] = file;

const M = await import('../dist/work-switch.js');
let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};
// Every read goes through a 1s memo; tests must defeat it.
const fresh = () => M.invalidateWorkSwitchCache();

console.log('\nWORK SWITCH CHECK\n');

console.log('missing file = everything runs (never silently halt the shop)');
rmSync(file, { force: true }); fresh();
t('no file -> hopper running', M.laneRunning('hopper'));
t('no file -> no hold reason', M.laneHoldReason('intel') === null);

console.log('\nstop-all stops every lane');
M.stopAll('test', 'because'); fresh();
for (const k of M.LANE_KEYS) t(`stopAll blocks ${k}`, M.laneStopped(k));
t('hold reason names the stop', (M.laneHoldReason('hopper') || '').includes('ALL WORK STOPPED'));
t('hold reason carries the why', (M.laneHoldReason('hopper') || '').includes('because'));

console.log('\nresume releases every lane');
M.resumeAll('test'); fresh();
for (const k of M.LANE_KEYS) t(`resumeAll releases ${k}`, M.laneRunning(k));

console.log('\nper-lane independence');
M.setLane('intel', false, 'test'); fresh();
t('intel off', M.laneStopped('intel'));
t('bi unaffected', M.laneRunning('bi'));
t('hopper unaffected', M.laneRunning('hopper'));
t('intel hold reason is lane-scoped', (M.laneHoldReason('intel') || '').includes('switched off'));

console.log('\nstop-all does not erase lane choices (resume must not silently re-enable)');
M.stopAll('test'); fresh();
t('during stop-all intel still stopped', M.laneStopped('intel'));
M.resumeAll('test'); fresh();
t('after resume intel STAYS off', M.laneStopped('intel'), 'lane preference was lost');
t('after resume hopper runs', M.laneRunning('hopper'));

console.log('\nresetAllLanes = the full green light');
M.resetAllLanes('test'); fresh();
t('reset clears lane off', M.laneRunning('intel'));
t('reset clears all_stopped', !M.readWorkSwitch().all_stopped);

console.log('\ncorrupt file fails SAFE (stopped), not open');
writeFileSync(file, '{ this is not json'); fresh();
t('corrupt -> hopper stopped', M.laneStopped('hopper'));
t('corrupt -> flagged corrupt', M.readWorkSwitch().corrupt === true);
writeFileSync(file, ''); fresh();
t('empty -> stopped', M.laneStopped('night'));

console.log('\nunknown lane is rejected, not silently accepted');
M.resetAllLanes('test'); fresh();
let threw = false; try { M.setLane('nope', false, 'test'); } catch { threw = true; }
t('setLane rejects unknown lane', threw);

console.log('\naudit trail');
M.resetAllLanes('test'); M.stopAll('kevin', 'fire'); M.setLane('bi', false, 'jarvis'); fresh();
const evs = M.readWorkSwitch().events;
t('events recorded', evs.length >= 3);
t('event has actor', evs.some((e) => e.by === 'kevin'));
t('event has lane', evs.some((e) => e.lane === 'bi' && e.op === 'lane_off'));

console.log('\nview shape for the API/UI');
M.resetAllLanes('test'); M.setLane('intel', false, 'test'); fresh();
const v = M.workSwitchView();
t('view lists every lane', v.lanes.length === M.LANE_KEYS.length);
t('view marks intel stopped', v.lanes.find((l) => l.key === 'intel')?.stopped === true);
t('view marks hopper running', v.lanes.find((l) => l.key === 'hopper')?.stopped === false);
t('view any_stopped true', v.any_stopped === true);
t('every lane has a label + what', v.lanes.every((l) => l.label && l.what && l.kind));
t('timer lanes name their unit', v.lanes.filter((l) => l.kind === 'timer').every((l) => !!l.unit));

console.log('\natomic write leaves no partial file');
M.resetAllLanes('test'); fresh();
t('file parses after write', typeof M.readWorkSwitch().all_stopped === 'boolean');
t('no tmp files left', !(await import('node:fs')).readdirSync(dir).some((f) => f.includes('.tmp.')));

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'} work-switch-check: ${pass}/${pass + fail}\n`);
process.exit(fail === 0 ? 0 : 1);
