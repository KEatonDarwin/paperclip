// SHARED CONTEXT v0 §3 (docs/shared-context/CONTRACT.md) — keeps
// `thread_summaries` fresh so the §1 Shared Now digest and §2 recall's
// thread_summary hits aren't stuck at whenever someone last hand-clicked
// "Summarize". Entry point for both the systemd timer
// (deploy/jarvis-summary-refresh.timer) and a manual run:
//
//   npx tsx scripts/refresh-thread-summaries.ts --dry-run
//   npx tsx scripts/refresh-thread-summaries.ts --batch 5 --min-turns 4
//
// NO API KEYS: this script only READS the DB directly (via the compiled
// src/summary-refresh.js against JARVIS_DB_PATH, defaulting to the repo's
// live jarvis.db — same file the running jarvis.service already reads/writes
// idempotently on every startup). The actual model call never happens here —
// it POSTs to the LIVE service's `/threads/:ext/summarize`, which runs the
// local `claude` CLI one-shot inside the already-running process (so the
// `thread_summary` SSE event fires in the cockpit exactly like a manual
// click). This script never spawns claude/codex/auggie/devin itself.
//
// Requires `npm run build` first (imports dist/summary-refresh.js).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function parseFlag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}
function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function readEnvFileValue(envPath: string, key: string): string | undefined {
  try {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(new RegExp(`^${key}=(.*)$`));
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // fall through
  }
  return undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, 'dry-run');
  const allowModel = hasFlag(argv, 'allow-model');
  const batchFlag = parseFlag(argv, 'batch');
  const minTurnsFlag = parseFlag(argv, 'min-turns');

  // JARVIS_DB_PATH must be set BEFORE importing anything that touches
  // conversation-db.js, which opens the sqlite handle at import time.
  const defaultDbPath = path.join(repoRoot, 'jarvis.db');
  const dbPathWasOverridden = !!process.env.JARVIS_DB_PATH;
  const dbPath = dbPathWasOverridden ? path.resolve(process.env.JARVIS_DB_PATH!) : defaultDbPath;
  process.env.JARVIS_DB_PATH = dbPath;
  // A scratch DB (anything other than the repo's own live jarvis.db, e.g. a
  // /tmp path used by a sim or a review check) must never trigger a real
  // model call — that would burn a live claude one-shot against test data.
  // --dry-run already skips every POST; --allow-model is the explicit
  // override for a deliberate scratch-DB smoke test.
  const isScratchDb = dbPathWasOverridden && dbPath !== defaultDbPath;

  const distDir = path.join(repoRoot, 'dist');
  const { selectStaleThreads } = await import(path.join(distDir, 'summary-refresh.js'));
  const { getSetting } = await import(path.join(distDir, 'conversation-db.js'));

  const minTurns = minTurnsFlag
    ? parseInt(minTurnsFlag, 10)
    : parseInt(getSetting('summary_refresh_min_turns') ?? '', 10) || 6;
  const batch = batchFlag
    ? parseInt(batchFlag, 10)
    : parseInt(getSetting('summary_refresh_batch') ?? '', 10) || 15;
  const model = getSetting('summary_refresh_model') || 'claude-haiku-4-5';

  const stale = selectStaleThreads({ minTurns, batch });

  if (stale.length === 0) {
    console.log('[refresh-thread-summaries] nothing stale — nothing to do.');
    return;
  }

  console.log(`[refresh-thread-summaries] ${stale.length} stale thread(s) (minTurns=${minTurns}, batch=${batch}, model=${model}):`);
  for (const t of stale) {
    console.log(
      `  - ${t.external_id}${t.title ? ` (${t.title})` : ''} — ${t.stale_turns} new turn(s) since ` +
        `${t.summary_at ?? 'never summarized'}`,
    );
  }

  if (dryRun) {
    console.log('[refresh-thread-summaries] --dry-run: no requests sent.');
    return;
  }

  if (isScratchDb && !allowModel) {
    console.error(
      `[refresh-thread-summaries] JARVIS_DB_PATH (${dbPath}) is not the live jarvis.db — refusing to trigger real model calls. ` +
        `Pass --dry-run to inspect, or --allow-model to deliberately override.`,
    );
    process.exitCode = 1;
    return;
  }

  const apiBase = process.env.JARVIS_API_BASE ?? 'http://localhost:3201/api/v1';
  const apiKey =
    process.env.JARVIS_COCKPIT_KEY ??
    readEnvFileValue('/home/kevin/paperclip/jarvis-command-center/.env', 'JARVIS_COCKPIT_KEY');
  if (!apiKey) {
    console.error('[refresh-thread-summaries] no JARVIS_COCKPIT_KEY (env or jarvis-command-center/.env) — cannot call the live API.');
    process.exitCode = 1;
    return;
  }

  for (const t of stale) {
    try {
      const res = await fetch(`${apiBase}/threads/${encodeURIComponent(t.external_id)}/summarize`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ adapter: 'claude', model }),
      });
      if (res.ok) {
        console.log(`[refresh-thread-summaries] queued ${t.external_id} (HTTP ${res.status})`);
      } else {
        console.error(`[refresh-thread-summaries] ${t.external_id} — HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      console.error(`[refresh-thread-summaries] ${t.external_id} — request failed:`, err);
    }
    // The route is async (202) — the live process fans the claude one-shots
    // out itself; this small stagger just avoids bursting N spawns at once.
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log('[refresh-thread-summaries] done.');
}

main().catch((err) => {
  console.error('[refresh-thread-summaries] fatal:', err);
  process.exitCode = 1;
});
