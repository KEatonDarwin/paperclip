#!/usr/bin/env npx tsx
// INTEL DESK RUNNER — daily (or manual) pull across all five lanes.
//
// Entry point for both the systemd timer and a manual "Pull now":
//   npx tsx scripts/intel-pull.ts --lanes all
//   npx tsx scripts/intel-pull.ts --lanes providers,harvest
//
// Sequential by lane (v0, per contract) — slower, but avoids surprise
// subscription burn and keeps failures easy to read. A future HTTP "Pull now"
// route should call the same lane-running code (runLane in
// scripts/intel-pull/claude-lane.ts) rather than shelling out to this file.
//
// NO API KEYS: every model call goes through the local `claude` CLI on
// subscription/login auth (see scripts/intel-pull/claude-lane.ts).

import fs from 'node:fs';
import { runLane } from './intel-pull/claude-lane.js';
import { hostFactsLine } from './intel-pull/lanes.js';
import { getIntelStore, INTEL_LANES, type IntelLane } from './intel-pull/store.js';

const TZ = 'America/Chicago';
const YOUTUBE_SEED_PATH = '/home/kevin/obsidian/paperclip-wiki/wiki/ai-youtube-creators-source-index.md';
const YOUTUBE_SEED_MAX_CHARS = 6000;
const RUN_SUMMARY_MAX_CHARS = 4000;

function todayRunDate(): string {
  // en-CA formats as YYYY-MM-DD, which matches the contract's run_date shape.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function loadYoutubeSeed(): string | undefined {
  try {
    const raw = fs.readFileSync(YOUTUBE_SEED_PATH, 'utf8');
    return raw.length > YOUTUBE_SEED_MAX_CHARS ? raw.slice(0, YOUTUBE_SEED_MAX_CHARS) : raw;
  } catch {
    return undefined; // Optional enrichment — a missing/unreadable file is not fatal.
  }
}

function parseLanesArg(argv: string[]): IntelLane[] {
  const idx = argv.indexOf('--lanes');
  if (idx === -1) return INTEL_LANES;
  const rest = argv.slice(idx + 1).filter((a) => !a.startsWith('--'));
  if (rest.length === 0 || rest.includes('all')) return INTEL_LANES;
  const requested = rest.join(',').split(',').map((s) => s.trim()).filter(Boolean);
  const valid = requested.filter((l): l is IntelLane => (INTEL_LANES as string[]).includes(l));
  return valid.length ? valid : INTEL_LANES;
}

async function main(): Promise<void> {
  const lanes = parseLanesArg(process.argv.slice(2));
  const store = await getIntelStore();

  const runDate = todayRunDate();
  const run = store.createIntelRun(runDate);
  console.log(`[intel-pull] run #${run.id} for ${runDate} — lanes: ${lanes.join(', ')}`);
  store.updateIntelRunStatus(run.id, 'running', { started_at: new Date().toISOString() });

  const hostFacts = hostFactsLine();
  const youtubeSeed = loadYoutubeSeed();

  const digests: string[] = [];
  const errors: string[] = [];
  let anyOk = false;

  for (const lane of lanes) {
    console.log(`[intel-pull] lane "${lane}" starting…`);
    const result = await runLane(lane, {
      hostFacts,
      youtubeSeed: lane === 'social' ? youtubeSeed : undefined,
    });
    digests.push(`${lane}: ${result.digest}`);

    if (result.ok) {
      anyOk = true;
      if (result.items.length) {
        store.createIntelItems(run.id, result.items);
      }
      console.log(`[intel-pull] lane "${lane}" ok — ${result.items.length} item(s).`);
    } else {
      errors.push(`${lane}: ${result.error ?? 'unknown error'}`);
      console.error(`[intel-pull] lane "${lane}" FAILED — ${result.error}`);
    }
  }

  const summary = digests.join(' | ').slice(0, RUN_SUMMARY_MAX_CHARS);
  const finishedAt = new Date().toISOString();

  if (anyOk) {
    store.updateIntelRunStatus(run.id, 'done', { finished_at: finishedAt, summary });
    console.log(`[intel-pull] run #${run.id} done.`);
  } else {
    const errorText = errors.join(' | ').slice(0, RUN_SUMMARY_MAX_CHARS);
    store.updateIntelRunStatus(run.id, 'failed', { finished_at: finishedAt, summary, error: errorText });
    console.error(`[intel-pull] run #${run.id} failed — every lane errored.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[intel-pull] fatal:', err);
  process.exitCode = 1;
});
