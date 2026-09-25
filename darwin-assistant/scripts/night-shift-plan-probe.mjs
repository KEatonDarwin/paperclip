// Phase-A probe for scripts/night-shift-sim.mjs: runs planNight TWICE against a
// read-only .backup() COPY of the live jarvis.db in its own process (so the
// sim's own scratch DB is never involved) and prints the plan + the goal
// ranking as JSON on stdout. Zero model calls, zero writes to the live file.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, '..', 'dist');
const copy = process.argv[2];
if (!copy) { console.error('usage: night-shift-plan-probe.mjs <db-copy>'); process.exit(2); }
process.env.JARVIS_DB_PATH = copy;
process.env.NIGHT_SHIFT_DRIVER = '0';
process.env.GOALS_AUTOPILOT_DRIVER = '0';
process.env.GOAL_GUARD_POLLER = '0';
process.env.HOPPER_GOV_ENABLED = '0';

const night = await import(path.join(distDir, 'night-shift.js'));
const { sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));

// SHIFTS v1 — NORMALISE THE THROWAWAY COPY.
//
// `planNight` 409s while a run is planned/running/paused, and the live DB very
// often HAS one (that is the point of the feature). The probe then failed with
// `night_run_active` and every downstream check cascaded — a suite that goes
// red because Kevin happened to start a shift is not testing anything. This is
// a `.backup()` COPY on the home disk; closing its runs touches nothing real.
const stale = sqliteDb
  .prepare("SELECT id FROM night_runs WHERE status IN ('planned','running','paused')")
  .all();
if (stale.length) {
  sqliteDb
    .prepare("UPDATE night_runs SET status = 'stopped', ended_at = datetime('now'), stop_reason = 'kevin' WHERE status IN ('planned','running','paused')")
    .run();
  console.error(`[plan-probe] normalised ${stale.length} live run(s) on the copy → stopped`);
}

const shape = (items) => items.map((i) => ({
  position: i.position, kind: i.kind, goal_id: i.goal_id, node_id: i.node_id,
  title: i.title, est_minutes: i.est_minutes, why: i.why, eta: i.eta_at,
}));

const a = night.planNight({ mode: 'until_stop' });
const b = night.planNight({ mode: 'until_stop' });
const sa = shape(a.items);
const sb = shape(b.items);
// planNight anchors ETAs at the top of the current minute, so back-to-back
// plans are normally byte-identical. If the two calls straddle a minute
// boundary every eta shifts by exactly that boundary — compare eta OFFSETS
// from each plan's own earliest eta in that case, which still proves the
// lane sim is deterministic.
const strictIdentical = JSON.stringify(sa) === JSON.stringify(sb);
const offsets = (s) => {
  const anchor = Math.min(...s.filter((i) => i.eta).map((i) => Date.parse(i.eta)));
  return s.map((i) => ({ ...i, eta: i.eta ? Date.parse(i.eta) - anchor : null }));
};
const identical = strictIdentical || JSON.stringify(offsets(sa)) === JSON.stringify(offsets(sb));

// Re-derive the per-goal score components from the persisted run for the report.
const ranking = b.run.goal_ids.map((gid, idx) => {
  const g = sqliteDb.prepare('SELECT title FROM goals WHERE id = ?').get(gid);
  const first = b.items.find((i) => i.goal_id === gid);
  const m = first ? /goal_score ([\d.]+) \(rank (\d+)\/\d+; momentum ([\d.]+) · closeness ([\d.]+) · fresh ([\d.]+)/.exec(first.why) : null;
  return {
    goal_id: gid, title: g?.title ?? '(gone)', rank: m ? Number(m[2]) : idx + 1,
    score: m ? Number(m[1]) : 0, momentum: m ? Number(m[3]) : 0,
    closeness: m ? Number(m[4]) : 0, freshness: m ? Number(m[5]) : 0,
    items: b.items.filter((i) => i.goal_id === gid).length,
  };
});

process.stdout.write(JSON.stringify({ identical, items: sb, eta_end: b.eta_end, ranking }, null, 0));
