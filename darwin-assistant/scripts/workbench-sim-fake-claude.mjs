#!/usr/bin/env node
// Fake `claude` CLI for the Workbench sim (hopper node #443). Reads a JSON
// control file (path from WORKBENCH_SIM_CONTROL) written by the sim driver
// before each call, and either echoes a claude-shaped {result:...} envelope
// or exits 1 with no stdout (to exercise the one-shot-failure fallback path).
// Drains stdin defensively even though workbench.ts/smart-todos-decompose.ts
// pass the prompt via -p, not stdin.
import fs from 'node:fs';

process.stdin.resume();
process.stdin.on('data', () => {});

const controlPath = process.env.WORKBENCH_SIM_CONTROL;
if (!controlPath || !fs.existsSync(controlPath)) {
  process.stdout.write('{"result":"{}"}\n');
  process.exit(0);
}

const control = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
if (control.mode === 'fail') {
  process.exit(1);
}
process.stdout.write(JSON.stringify({ type: 'result', result: JSON.stringify(control.payload) }) + '\n');
process.exit(0);
