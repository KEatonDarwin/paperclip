// ADVERSARIAL REVIEW PROBES (node #190) for Foundry GO v2 run slots.
// Drives dist/foundry.js directly against a scratch DB + scratch ports
// 48410-48412 (never the live jarvis.db or 4310-4312). Each block is one
// attack from DECISIONS.md; a [BUG] line means the attack landed. Re-run
// after fixing: `npm run build && node scripts/runslots-review-attacks.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';

const DB = '/tmp/runslots-attack/attack.db';
fs.rmSync(DB, { force: true });
process.env.JARVIS_DB_PATH = DB;
process.env.FOUNDRY_RUN_PORTS = '48410,48411,48412';
process.env.FOUNDRY_PREVIEW_HOST = '127.0.0.1';
import { fileURLToPath } from 'node:url';
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const convDb = await import(path.join(DIST, 'conversation-db.js'));
const foundry = await import(path.join(DIST, 'foundry.js'));
const { sqliteDb } = convDb;
foundry.ensureRunSlots();

const REPO = '/tmp/runslots-attack/repos';
fs.rmSync(REPO, { recursive: true, force: true });
const ins = sqliteDb.prepare(`INSERT INTO foundry_projects (id, name, prompt, repo_path, base_branch, status, run_command) VALUES (?, ?, 'x', ?, 'main', 'ready', ?)`);
let seq = 0;
function seed(cmd) { seq++; const id = `atk-${seq}`; const rp = path.join(REPO, id); fs.mkdirSync(rp, { recursive: true }); ins.run(id, `Atk ${seq}`, rp, cmd); return id; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function portBound(port) { return new Promise((res) => { const s = net.connect({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); }); }
const slots = () => foundry.listRunSlots('127.0.0.1');
const report = [];
function finding(id, verdict, detail) { report.push({ id, verdict, detail }); console.log(`\n[${verdict}] ${id}: ${detail}`); }

// ---------------------------------------------------------------------------
// D — relaunch: GO on a project after stopping its slot
// ---------------------------------------------------------------------------
{
  const p = seed('python3 -m http.server {{port}}');
  const r = foundry.goProject(p, { host: '127.0.0.1' });
  await sleep(600);
  assert.equal(await portBound(r.slot.port), true);
  foundry.stopRunSlot(r.slot.slot_no, { host: '127.0.0.1' });
  await sleep(50);
  try {
    foundry.goProject(p, { host: '127.0.0.1' });
    finding('D-relaunch', 'OK', 'GO after stop succeeded');
  } catch (e) {
    finding('D-relaunch', 'BUG', `GO after Stop -> ${e.status} ${e.code}: ${e.message} (project is status=${sqliteDb.prepare('SELECT status FROM foundry_projects WHERE id=?').get(p).status}; no path back to ready)`);
  }
}

// ---------------------------------------------------------------------------
// B — health tick stale snapshot vs replace-GO
// slot1: accepts TCP but never answers HTTP -> probe takes ~2s. During that
// window, replace slot 2. Tick then sees the stale slot-2 row (old pid dead).
// ---------------------------------------------------------------------------
{
  const silent = seed(`python3 -c "import socket,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); s.bind(('127.0.0.1',{{port}})); s.listen(5)\nwhile True:\n  c,_=s.accept(); time.sleep(30)"`);
  const rA = foundry.goProject(silent, { host: '127.0.0.1' });   // slot 1
  const pB = seed('python3 -m http.server {{port}}');
  const rB = foundry.goProject(pB, { host: '127.0.0.1' });       // slot 2
  await sleep(700);
  const tick = foundry.runSlotHealthTick('127.0.0.1');            // snapshot taken now
  await sleep(300);                                                // tick is awaiting slot-1 probe
  const pC = seed('python3 -m http.server {{port}}');
  const rC = foundry.goProject(pC, { slot_no: 2, replace: true, host: '127.0.0.1' }); // replaces slot 2 (sync, ~1.6s)
  await tick;
  await sleep(50);
  const s2 = slots().find((s) => s.slot_no === 2);
  const newPidAlive = alive(rC.slot.pid);
  if (s2.status === 'dead' && newPidAlive) {
    finding('B-tick-race', 'BUG', `after replace during a health tick, slot 2 is marked '${s2.status}' pid=${s2.pid} while the NEW occupant pid ${rC.slot.pid} is alive and serving (port bound=${await portBound(rC.slot.port)}) — pid lost, process now unstoppable via UI, slot reclaimable -> next GO collides on the port`);
  } else {
    finding('B-tick-race', 'OK', `slot 2 status=${s2.status} pid=${s2.pid}, new pid alive=${newPidAlive}`);
  }
  // cleanup
  for (const n of [1, 2]) foundry.stopRunSlot(n, { host: '127.0.0.1' });
  try { process.kill(-rC.slot.pid, 'SIGKILL'); } catch {}
  try { process.kill(-rA.slot.pid, 'SIGKILL'); } catch {}
  try { process.kill(-rB.slot.pid, 'SIGKILL'); } catch {}
  void rB;
}

// ---------------------------------------------------------------------------
// C — pid reuse: an unrelated process now owns the recorded pid
// ---------------------------------------------------------------------------
{
  const dummy = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' }); dummy.unref();
  await sleep(100);
  sqliteDb.prepare(`UPDATE foundry_run_slots SET status='running', pid=?, project_id='atk-1', run_command='python3 -m http.server 48412', started_at=datetime('now','-1 day') WHERE slot_no=3`).run(dummy.pid);
  foundry.reconcileRunSlotsAtBoot('127.0.0.1');
  const s3 = slots().find((s) => s.slot_no === 3);
  const stillRunning = s3.status === 'running';
  foundry.stopRunSlot(3, { host: '127.0.0.1' });
  await sleep(50);
  const dummyDead = !alive(dummy.pid);
  if (stillRunning || dummyDead) {
    finding('C-pid-reuse', 'BUG', `recorded pid reused by an unrelated process ('sleep 300', pid ${dummy.pid}, no FOUNDRY_SLOT env, cmd mismatch): boot reconcile kept slot 3 status='${s3.status}' (board shows the old project as running), and Stop SIGTERM/SIGKILLed the unrelated process (dead=${dummyDead}). No start-time/cmdline/environ identity check.`);
  } else {
    finding('C-pid-reuse', 'OK', 'identity check present');
  }
  try { process.kill(dummy.pid, 'SIGKILL'); } catch {}
}

// ---------------------------------------------------------------------------
// E — GO into a slot whose port is already bound by something else
// ---------------------------------------------------------------------------
{
  const squatter = spawn('python3', ['-m', 'http.server', '48410', '--bind', '127.0.0.1'], { detached: true, stdio: 'ignore' }); squatter.unref();
  await sleep(600);
  assert.equal(await portBound(48410), true);
  const p = seed('python3 -m http.server {{port}}');
  let r;
  try {
    r = foundry.goProject(p, { slot_no: 1, host: '127.0.0.1' });
    await sleep(800);
    const s1 = slots().find((s) => s.slot_no === 1);
    const pidAlive = alive(r.slot.pid);
    finding('E-port-squat', 'BUG', `port 48410 already bound by an external process: GO returned 202 launched=true preview=${r.preview_url}; ${pidAlive ? 'child pid still alive' : 'child already died (EADDRINUSE)'} but slot 1 status='${s1.status}' — no preflight port check, the board says running until the 10s tick; the preview link actually opens the SQUATTER's server. Log: ${fs.readFileSync(r.slot.log_path,'utf8').trim().split('\n').slice(-1)[0]}`);
  } catch (e) {
    finding('E-port-squat', 'OK', `GO refused: ${e.code}`);
  }
  try { process.kill(squatter.pid, 'SIGKILL'); } catch {}
  foundry.stopRunSlot(1, { host: '127.0.0.1' });
}

// ---------------------------------------------------------------------------
// F — stop timing: does every stop pay the full 1.6s (F-1 in SIM-RESULTS)?
// ---------------------------------------------------------------------------
{
  const p = seed('python3 -m http.server {{port}}');
  const r = foundry.goProject(p, { host: '127.0.0.1' });
  await sleep(500);
  const t = Date.now();
  foundry.stopRunSlot(r.slot.slot_no, { host: '127.0.0.1' });
  finding('F-stop-blocking', 'NOTE', `stop of a SIGTERM-friendly python server blocked the event loop ${Date.now() - t}ms (sync Atomics.wait loop; zombie can't be reaped while blocked so it always maxes out)`);
}

// ---------------------------------------------------------------------------
// G — daemonizing run.command: shell exits, server lives -> board says dead
// ---------------------------------------------------------------------------
{
  const p = seed('nohup python3 -m http.server {{port}} >/dev/null 2>&1 &');
  const r = foundry.goProject(p, { host: '127.0.0.1' });
  await sleep(800);
  const s = slots().find((x) => x.slot_no === r.slot.slot_no);
  const bound = await portBound(r.slot.port);
  await foundry.runSlotHealthTick('127.0.0.1');
  const s2 = slots().find((x) => x.slot_no === r.slot.slot_no);
  finding('G-daemonize', s2.status !== 'running' && bound ? 'BUG' : 'OK', `run.command that backgrounds itself: port bound=${bound}, slot status before tick='${s.status}' after tick='${s2.status}' — pid-only liveness marks a live server dead; slot becomes reclaimable while the port is held (blueprint run.command is model-generated, so '&'/nohup/pm2 shapes are plausible)`);
  try { execSync(`pkill -f "^python3 .*http.server ${r.slot.port}"`, { stdio: 'ignore' }); } catch {}
}

console.log('\n=== SUMMARY ===');
for (const r of report) console.log(`${r.verdict.padEnd(4)} ${r.id}`);
try { execSync('pkill -f "^python3 .*http.server 4841"', { stdio: 'ignore' }); } catch {}
try { execSync('pkill -f "^python3 .*s.listen(5)"', { stdio: 'ignore' }); } catch {}
process.exit(0);
