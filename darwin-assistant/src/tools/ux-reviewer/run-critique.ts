// JARVIS UX Reviewer — critique runner CLI (DAR-685, slice 2).
//
// Reads a capture manifest (from run-capture.ts / captureTarget) and runs the
// vision-critique stage over its cells, printing a compact findings summary and
// writing findings.json alongside the manifest. This is the "taste" stage
// entrypoint; the bug-intake sink + fixer loop consume the findings.json it
// writes.
//
// Usage:
//   tsx src/tools/ux-reviewer/run-critique.ts [manifest.json | outDir]
//     - no arg: uses the newest manifest under /tmp/ux-reviewer/**
//     - a manifest.json path, or a dir containing one
// Env:
//   UX_REVIEWER_CLAUDE_BIN     claude binary (default "claude")
//   UX_REVIEWER_VISION_MODEL   model id (default: CLI default; must see images)
//   UX_REVIEWER_CONCURRENCY    parallel cells (default 3)
//   UX_REVIEWER_NO_REPORT      set to skip auto-emitting report.html (findings.json only)

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { critiqueManifestFile, type CellCritique } from './vision-critique.js';
import { writeHtmlReport } from './html-report.js';

async function newestManifest(root = '/tmp/ux-reviewer'): Promise<string | undefined> {
  let best: { path: string; mtime: number } | undefined;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try {
        st = await stat(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) await walk(p, depth + 1);
      else if (name === 'manifest.json') {
        const m = st.mtimeMs;
        if (!best || m > best.mtime) best = { path: p, mtime: m };
      }
    }
  }
  await walk(root, 0);
  return best?.path;
}

async function resolveManifest(arg?: string): Promise<string | undefined> {
  if (!arg) return newestManifest();
  try {
    const st = await stat(arg);
    if (st.isDirectory()) return join(arg, 'manifest.json');
    return arg;
  } catch {
    return arg; // let downstream error surface the bad path
  }
}

function fmtCell(c: CellCritique): string {
  const head = `${c.screen}/${c.state}/${c.viewport}`;
  if (!c.ok) return `  ERR ${head}  ${c.error ?? 'unknown error'}`;
  const d = c.defects.length;
  const s = c.suggestions.length;
  const cost = typeof c.costUsd === 'number' ? ` $${c.costUsd.toFixed(3)}` : '';
  const ms = typeof c.critiqueMs === 'number' ? ` ${c.critiqueMs}ms` : '';
  return `  OK  ${head}  defects:${d} suggestions:${s}${ms}${cost}`;
}

async function main() {
  const manifestPath = await resolveManifest(process.argv[2]);
  if (!manifestPath) {
    console.error('[ux-reviewer] no manifest found under /tmp/ux-reviewer — run run-capture.ts first');
    process.exit(2);
  }
  const concurrency = process.env.UX_REVIEWER_CONCURRENCY ? Number(process.env.UX_REVIEWER_CONCURRENCY) : undefined;
  console.log(`[ux-reviewer] critiquing ${manifestPath}${concurrency ? ` (concurrency ${concurrency})` : ''}`);

  const report = await critiqueManifestFile(manifestPath, concurrency ? { concurrency } : {});

  console.log(
    `[ux-reviewer] ${report.critiquedCells}/${report.totalCells} cells critiqued · ` +
      `${report.defectCount} defects (H:${report.bySeverity.high} M:${report.bySeverity.medium} L:${report.bySeverity.low}) · ` +
      `${report.suggestionCount} suggestions · $${report.totalCostUsd.toFixed(3)} · ${report.model}`,
  );
  for (const c of report.cells) console.log(fmtCell(c));

  // Surface the high-severity defects inline — these are what the fixer loop acts on first.
  const highs = report.cells.flatMap((c) =>
    c.defects.filter((d) => d.severity === 'high').map((d) => ({ head: `${c.screen}/${c.state}/${c.viewport}`, d })),
  );
  if (highs.length) {
    console.log(`\n[ux-reviewer] HIGH-severity defects:`);
    for (const { head, d } of highs) {
      console.log(`  • [${head}] ${d.title} — ${d.detail} (${d.region}${d.rubric ? `, rubric #${d.rubric}` : ''})`);
    }
  }
  console.log(`\n[ux-reviewer] findings.json → ${join(report.outDir, 'findings.json')}`);

  // Auto-emit the human-consumable HTML report so capture → critique → report is
  // one command. Free (no vision cost) — it just dedupes + renders the findings we
  // already have. Opt out with UX_REVIEWER_NO_REPORT for findings.json-only runs.
  if (!process.env.UX_REVIEWER_NO_REPORT) {
    const res = await writeHtmlReport(report);
    if (res.error) console.error(`[ux-reviewer] report.html skipped — ${res.error}`);
    else console.log(`[ux-reviewer] report.html → ${res.refs[0]}`);
  }

  process.exit(report.critiquedCells === report.totalCells ? 0 : 1);
}

main().catch((err) => {
  console.error('[ux-reviewer] fatal', err);
  process.exit(2);
});
