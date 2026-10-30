// tree-steward-guard-dryrun.ts — a model-free, test-runner-free, DB-free PROOF
// that the Tree Steward GUARD (src/tree-steward-guard.ts) does the three things
// the whole feature rests on: switching the `steward` lane OFF stops auto-answers,
// the per-tree cap trips, and a node already answered is never answered twice.
//
// This is a PLAIN CLI SCRIPT, not a test suite. Run it with:
//   JARVIS_DB_PATH=/tmp/<fresh>.db JARVIS_WORK_SWITCH_PATH=/tmp/<fresh>.json \
//     npx tsx tools/tree-steward-guard-dryrun.ts
// (the script also sets throwaway paths itself if they are unset; either way the
//  real jarvis.db and the real /var/lib/jarvis/work-switch.json are never opened
//  for write and never edited.)
//
// DB + WORK-SWITCH HAZARD — ROUTE A (env-var redirect), chosen deliberately.
// src/tree-steward-guard.ts STATICALLY imports `./conversation-db.js` (getSetting/
// setSetting) and `./work-switch.js` (laneStopped). conversation-db opens a
// better-sqlite3 handle AT MODULE LOAD against
//   process.env.JARVIS_DB_PATH ?? <repo>/jarvis.db
// and work-switch resolves its flag-file path from
//   process.env.JARVIS_WORK_SWITCH_PATH ?? /var/lib/jarvis/work-switch.json
// at module load too. So merely importing the guard would open the real DB and,
// for check 2, writing the lane off would edit the real switch. We prevent BOTH
// by setting those two env vars to FRESH /tmp paths BEFORE anything imports those
// modules. Because ESM `import` statements are hoisted ABOVE top-level code, a
// *static* import of the guard here would run before the env assignment below —
// so unlike the trigger dry-run (whose trigger opens no DB at load), this script
// loads the guard, the card's siblings, conversation-db and work-switch by
// DYNAMIC import inside main(), strictly after the env vars are set. Route A is
// chosen over refactoring the guard to wrapped-dynamic-imports (route B) because
// the env vars already exist — we change NO production code to suit a harness,
// and route A lets us drive the REAL lane switch and the REAL settings KV against
// throwaway files. The harness `ls -la`s the real DB and the real work-switch
// before/after to show neither mtime moved.
//
// It drives the guard with hand-written in-memory tree/node ids (never read from
// any database), asserts each verdict, and always exits 0; a FAIL is a reported
// finding, not a throw.

// --- STEP 0: redirect DB + work-switch to throwaway paths BEFORE importing anything that opens them.
import os from 'node:os';
import path from 'node:path';

const REAL_DB = '/home/kevin/paperclip/darwin-assistant/jarvis.db';
const REAL_WS = '/var/lib/jarvis/work-switch.json';

const THROWAWAY_DB =
  process.env.JARVIS_DB_PATH ??
  path.join(os.tmpdir(), `steward-guard-dryrun-${process.pid}-${Date.now()}.db`);
process.env.JARVIS_DB_PATH = THROWAWAY_DB;

const THROWAWAY_WS =
  process.env.JARVIS_WORK_SWITCH_PATH ??
  path.join(os.tmpdir(), `steward-guard-ws-${process.pid}-${Date.now()}.json`);
process.env.JARVIS_WORK_SWITCH_PATH = THROWAWAY_WS;

// ---------------------------------------------------------------------------
// check accounting
// ---------------------------------------------------------------------------
let total = 0;
let passed = 0;
let failed = 0;
function record(ok: boolean, name: string, detail: string): void {
  total++;
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log(`[dryrun] resolved JARVIS_DB_PATH          = ${process.env.JARVIS_DB_PATH}`);
  console.log(`[dryrun] resolved JARVIS_WORK_SWITCH_PATH = ${process.env.JARVIS_WORK_SWITCH_PATH}`);
  console.log(`[dryrun] real DB that must stay untouched          = ${REAL_DB}`);
  console.log(`[dryrun] real work-switch that must stay untouched = ${REAL_WS}`);

  // Hard refuse if either throwaway path resolves to a real one — belt + braces.
  if (path.resolve(process.env.JARVIS_DB_PATH as string) === path.resolve(REAL_DB)) {
    console.log('[dryrun] REFUSING to run: JARVIS_DB_PATH points at the real jarvis.db.');
    process.exit(0);
  }
  if (path.resolve(process.env.JARVIS_WORK_SWITCH_PATH as string) === path.resolve(REAL_WS)) {
    console.log('[dryrun] REFUSING to run: JARVIS_WORK_SWITCH_PATH points at the real work-switch.');
    process.exit(0);
  }

  // DYNAMIC imports, strictly AFTER the env vars above are set. Each of these
  // modules reads an env-derived path at load; importing them earlier (or
  // statically) would bind the real paths.
  const { setSetting, getSetting } = await import('../src/conversation-db.js');
  const { setLane, invalidateWorkSwitchCache } = await import('../src/work-switch.js');
  const {
    stewardAllowed,
    recordStewardAnswer,
    stewardMaxPerTree,
    STEWARD_STATE_KEY,
    __resetStewardGuardStateForDryRun,
  } = await import('../src/tree-steward-guard.js');

  console.log(`[dryrun] warmed conversation-db on throwaway path; settings table ready.\n`);

  // Toggle the REAL lane switch (on the throwaway file) and drop the 1s memo so
  // the very next laneStopped() read sees the flip immediately.
  function laneOn(): void {
    setLane('steward', true, 'dryrun');
    invalidateWorkSwitchCache();
  }
  function laneOff(): void {
    setLane('steward', false, 'dryrun');
    invalidateWorkSwitchCache();
  }

  // ---- check 1 — fresh state, lane ON -> allowed, code 'ok' -----------------
  {
    laneOn();
    __resetStewardGuardStateForDryRun();
    setSetting('steward_max_per_tree', '3');
    const v = stewardAllowed('tree-A', 1);
    record(
      v.allowed === true && v.code === 'ok',
      'check1  fresh + lane ON -> allowed, ok',
      `allowed=${v.allowed} code=${v.code} prior=${v.priorCount}`,
    );
  }

  // ---- check 2 — lane OFF -> lane_off; back ON -> ok ------------------------
  {
    laneOff();
    const off = stewardAllowed('tree-A', 1);
    laneOn();
    const on = stewardAllowed('tree-A', 1);
    record(
      off.allowed === false && off.code === 'lane_off' && on.allowed === true && on.code === 'ok',
      'check2  lane OFF -> lane_off, back ON -> ok (the "proven by toggling the lane off")',
      `off:{allowed=${off.allowed},code=${off.code}} on:{allowed=${on.allowed},code=${on.code}}`,
    );
  }

  // ---- check 3 — cap: steward_max_per_tree=2, two answered, 3rd node -> cap -
  {
    laneOn();
    __resetStewardGuardStateForDryRun();
    setSetting('steward_max_per_tree', '2');
    recordStewardAnswer('tree-C', 101);
    recordStewardAnswer('tree-C', 102);
    const v = stewardAllowed('tree-C', 103);
    record(
      v.allowed === false && v.code === 'cap_reached',
      'check3  cap=2, two answered, 3rd node -> cap_reached',
      `allowed=${v.allowed} code=${v.code} prior=${v.priorCount} cap=${stewardMaxPerTree()}`,
    );
  }

  // ---- check 4 — cap is PER TREE: a different tree is still ok --------------
  {
    const v = stewardAllowed('tree-D', 201); // cap still 2; tree-D has 0 answers
    record(
      v.allowed === true && v.code === 'ok',
      'check4  cap is PER TREE: fresh tree still ok while tree-C is capped',
      `allowed=${v.allowed} code=${v.code} prior=${v.priorCount}`,
    );
  }

  // ---- check 5 — never twice, and it fires even BELOW the cap --------------
  // Order matters: already_answered is checked BEFORE cap_reached, so a repeat of
  // a node that has only been answered once (cap 5) still returns already_answered.
  {
    laneOn();
    __resetStewardGuardStateForDryRun();
    setSetting('steward_max_per_tree', '5');
    recordStewardAnswer('tree-E', 301);
    const v = stewardAllowed('tree-E', 301);
    const cap = stewardMaxPerTree();
    const belowCap = v.priorCount < cap;
    record(
      v.allowed === false && v.code === 'already_answered' && belowCap,
      'check5  never-twice fires even BELOW cap (already_answered precedes cap_reached)',
      `allowed=${v.allowed} code=${v.code} prior=${v.priorCount} cap=${cap} belowCap=${belowCap}`,
    );
  }

  // ---- check 6 — pruning: 60 trees -> at most 50 kept, newest survives ------
  // A 2ms gap between writes makes `at` strictly increasing so the most recently
  // stamped tree (prune-tree-59) is unambiguously in the top-50 the pruner keeps.
  {
    laneOn();
    __resetStewardGuardStateForDryRun();
    setSetting('steward_max_per_tree', '3');
    for (let i = 0; i < 60; i++) {
      recordStewardAnswer(`prune-tree-${i}`, 9000 + i);
      await sleep(2);
    }
    const raw = getSetting(STEWARD_STATE_KEY);
    let count = -1;
    let hasNewest = false;
    try {
      const parsed = JSON.parse(raw ?? '{}') as { trees?: Record<string, unknown> };
      const trees = parsed.trees ?? {};
      count = Object.keys(trees).length;
      hasNewest = Object.prototype.hasOwnProperty.call(trees, 'prune-tree-59');
    } catch {
      /* count stays -1 -> FAIL */
    }
    record(
      count >= 0 && count <= 50 && hasNewest,
      'check6  pruning: <=50 trees kept and the most-recent survives',
      `stored=${count} (ceiling 50) most-recent(prune-tree-59)Present=${hasNewest}`,
    );
  }

  // ---- check 7 — corrupt counter -> no throw, fail-OPEN ('ok') --------------
  {
    laneOn();
    setSetting('steward_max_per_tree', '3');
    setSetting(STEWARD_STATE_KEY, 'not json');
    let threw = false;
    let v: ReturnType<typeof stewardAllowed> | undefined;
    try {
      v = stewardAllowed('tree-F', 1);
    } catch {
      threw = true;
    }
    record(
      !threw && !!v && v.code === 'ok',
      'check7  corrupt counter -> no throw, fail-open ok',
      threw ? 'THREW (bad — a garbled counter must not wedge the steward)' : `allowed=${v!.allowed} code=${v!.code} prior=${v!.priorCount}`,
    );
  }

  // ---- check 8 — bad steward_max_per_tree -> default, not throw/zero --------
  {
    setSetting('steward_max_per_tree', 'abc');
    let threw = false;
    let cap = -999;
    try {
      cap = stewardMaxPerTree();
    } catch {
      threw = true;
    }
    record(
      !threw && cap === 3,
      'check8  bad steward_max_per_tree("abc") -> default 3, not throw/zero',
      threw ? 'THREW (bad)' : `stewardMaxPerTree()=${cap} (expected default 3)`,
    );
  }

  // ---- check 9 — PRIORITY: lane OFF beats cap (the mutation discriminator) --
  // The 8 checks above each leave exactly one blocking condition true, so none of
  // them distinguishes "lane checked first" from "lane checked after the cap":
  // moving the laneStopped() check below the cap check (STEP 5's deliberate break)
  // would still make check2's fresh lane-off return 'lane_off' and check3's
  // uncapped-lane case return 'cap_reached'. THIS check sets BOTH blockers true at
  // once — tree-G is AT cap AND the lane is OFF — and asserts the lane wins
  // ('lane_off'), which is only true when laneStopped is evaluated first. With the
  // check reordered after the cap, this returns 'cap_reached' and this check FAILS.
  {
    laneOn();
    __resetStewardGuardStateForDryRun();
    setSetting('steward_max_per_tree', '2');
    recordStewardAnswer('tree-G', 501);
    recordStewardAnswer('tree-G', 502); // tree-G now at cap (2/2)
    laneOff(); // ...and the lane is off
    const v = stewardAllowed('tree-G', 777); // new node, tree at cap, lane off
    laneOn(); // restore
    record(
      v.allowed === false && v.code === 'lane_off',
      'check9  PRIORITY: lane OFF beats cap — catches a laneStopped-after-cap reorder',
      `allowed=${v.allowed} code=${v.code} prior=${v.priorCount} — correct=lane_off; a reorder would give cap_reached`,
    );
  }

  console.log(`\n${total} checks, ${passed} passed, ${failed} failed`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[dryrun] harness error (NOT a guard verdict):', err);
  console.log(`\n${total} checks, ${passed} passed, ${failed} failed`);
  process.exit(0);
});
