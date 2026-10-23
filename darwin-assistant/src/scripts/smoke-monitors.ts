import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tempDir = mkdtempSync(path.join(tmpdir(), 'jarvis-monitor-smoke-'));
process.env.JARVIS_DB_PATH = path.join(tempDir, 'jarvis.db');

try {
  const {
    createMonitor,
    claimDueMonitorRuns,
    recordMonitorRunOutcome,
    patchMonitor,
    expireCompletedMonitors,
    getMonitor,
    listMonitorRuns,
  } = await import('../monitors.js');

  const now = new Date();
  const future = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const monitor = createMonitor({
    name: 'Smoke monitor',
    prompt: 'Return fail for smoke-test proof.',
    cadence_minutes: 5,
    expires_at: future,
  });
  assert.equal(monitor.name, 'Smoke monitor');
  assert.equal(monitor.status, 'active');
  assert.equal(monitor.monitor_thread_ext, `cockpit:monitor-${monitor.id}`);

  const claimed = claimDueMonitorRuns(now, 1);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]?.monitor_id, monitor.id);
  assert.equal(claimed[0]?.outcome, null);

  const afterClaim = getMonitor(monitor.id);
  assert.ok(afterClaim?.last_run_at, 'claim sets last_run_at to block double ticks');
  assert.equal(claimDueMonitorRuns(now, 1).length, 0, 'same monitor is not double-claimed');

  const run = recordMonitorRunOutcome(claimed[0]!.id, {
    outcome: 'fail',
    summary: 'Smoke detected the expected fail state',
    detail: 'The smoke records a fail to prove consecutive_fail tracking.',
    raw: '{"status":"fail","summary":"Smoke detected the expected fail state","detail":"ok"}',
  });
  assert.equal(run.outcome, 'fail');
  assert.equal(getMonitor(monitor.id)?.consecutive_fails, 1);
  assert.equal(listMonitorRuns(monitor.id, 10).length, 1);

  const past = new Date(now.getTime() - 60_000).toISOString();
  patchMonitor(monitor.id, { expires_at: past });
  const expired = expireCompletedMonitors(now);
  assert.equal(expired.length, 1);
  assert.equal(expired[0]?.status, 'completed');
  assert.equal(getMonitor(monitor.id)?.status, 'completed');
  assert.equal(claimDueMonitorRuns(now, 1).length, 0, 'completed monitors no longer claim due runs');

  console.log(JSON.stringify({
    ok: true,
    monitor_id: monitor.id,
    run_id: run.id,
    lifecycle: ['create', 'due-claim', 'record-run', 'expiry'],
  }));
} finally {
  const { sqliteDb } = await import('../conversation-db.js');
  sqliteDb.close();
  rmSync(tempDir, { recursive: true, force: true });
}
