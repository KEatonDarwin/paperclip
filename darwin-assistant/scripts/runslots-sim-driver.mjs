#!/usr/bin/env node
// Orchestrates the two-phase runslots-sim.mjs as two SEPARATE `node`
// process invocations (not a nested spawn from inside the server process —
// see runslots-sim.mjs's header comment for why that matters) and prints a
// merged pass/fail report. This driver process never imports dist/ itself
// and never touches the scratch DB directly.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sim = path.join(__dirname, 'runslots-sim.mjs');
const REPO_ROOT = '/tmp/runslots-sim-repos';

console.log('=== phase 1 ===');
const p1 = spawnSync(process.execPath, [sim], { stdio: 'inherit' });

console.log('\n=== phase 2 (fresh process, same scratch DB) ===');
const p2 = spawnSync(process.execPath, [sim], {
  stdio: 'inherit',
  env: { ...process.env, RUNSLOTS_SIM_PHASE2: '1' },
});

function readResults(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const r1 = readResults(path.join(REPO_ROOT, 'phase1-results.json'));
const r2 = readResults(path.join(REPO_ROOT, 'phase2-results.json'));

console.log('\n=== RUN-SLOTS SIM — MERGED RESULTS ===');
const all = [
  ...(r1 ?? [{ id: 'phase1', description: 'phase 1 process', pass: false, error: `phase 1 exited ${p1.status} without writing results` }]),
  ...(r2 ?? [{ id: 'phase2', description: 'phase 2 process', pass: false, error: `phase 2 exited ${p2.status} without writing results` }]),
];
let fail = 0;
for (const r of all) {
  if (r.pass) {
    console.log(`  [PASS] ${r.id}: ${r.description}`);
  } else {
    fail += 1;
    console.log(`  [FAIL] ${r.id}: ${r.description}\n         ${r.error}`);
  }
}
console.log(`\n${all.length - fail}/${all.length} checks passed.`);

process.exit(fail > 0 || p1.status !== 0 || p2.status !== 0 ? 1 : 0);
