// Companion process for scripts/shared-context-sim.ts, CONTRACT.md §5 item 7.
//
// recall.ts's FTS5-vs-LIKE decision (`ensureTurnsFts`) is cached in a
// module-level variable the FIRST time it runs, which happens automatically
// at module load (`try { ensureTurnsFts(); } catch {}` at the bottom of
// src/recall.ts). That means once the sim's own process has imported
// dist/recall.js (directly or transitively via dist/handlers/api-v1.js), the
// mode is permanently locked for the rest of that process — setting
// JARVIS_RECALL_FORCE_LIKE=1 afterwards would have no effect. To genuinely
// exercise the LIKE fallback path (not just assert a flag), this runs in its
// own child process with JARVIS_RECALL_FORCE_LIKE=1 already set before
// dist/recall.js is ever imported.
//
// argv: [distDir, query]
// env:  JARVIS_DB_PATH (same scratch db as the parent), JARVIS_RECALL_FORCE_LIKE=1,
//       JARVIS_AUTO_MEMORY_DIR (same temp dir as the parent, optional)
// stdout: one JSON line — { query, mode, hits } (the recall() return value)
// No model calls anywhere in this file.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const distDir = process.argv[2];
const query = process.argv[3] ?? 'MBI';

if (!distDir) {
  console.error('usage: shared-context-like-check.mjs <distDir> <query>');
  process.exit(2);
}

const { recall } = await import(pathToFileURL(path.join(distDir, 'recall.js')).href);
const result = recall(query);
process.stdout.write(JSON.stringify(result));
