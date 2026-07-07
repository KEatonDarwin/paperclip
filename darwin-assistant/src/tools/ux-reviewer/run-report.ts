// JARVIS UX Reviewer — report runner CLI (DAR-685, slice 3).
//
// Reads a findings.json (from run-critique.ts / critiqueManifest), normalizes +
// dedupes the per-cell findings, and runs the HtmlReportSink to write a
// standalone report.html next to the screenshots. This is the local sink
// entrypoint; when the remote Universal Bug-Intake API exists it plugs in here as
// an additional FindingSink alongside the HTML report.
//
// Usage:
//   tsx src/tools/ux-reviewer/run-report.ts [findings.json | outDir]
//     - no arg: uses the newest findings.json under /tmp/ux-reviewer/**
//     - a findings.json path, or a dir containing one
//   UX_REVIEWER_REPORT_OUT   override the output html path

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CritiqueReport } from './vision-critique.js';
import { findingsFromReport, normalizeReport } from './sink.js';
import { HtmlReportSink } from './html-report.js';

async function newestFindings(root = '/tmp/ux-reviewer'): Promise<string | undefined> {
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
      else if (name === 'findings.json') {
        if (!best || st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs };
      }
    }
  }
  await walk(root, 0);
  return best?.path;
}

async function resolveFindings(arg?: string): Promise<string | undefined> {
  if (!arg) return newestFindings();
  try {
    const st = await stat(arg);
    if (st.isDirectory()) return join(arg, 'findings.json');
    return arg;
  } catch {
    return arg;
  }
}

async function main() {
  const path = await resolveFindings(process.argv[2]);
  if (!path) {
    console.error('[ux-reviewer] no findings.json under /tmp/ux-reviewer — run run-critique.ts first');
    process.exit(2);
  }
  const report = JSON.parse(await readFile(path, 'utf8')) as CritiqueReport;

  const raw = normalizeReport(report).length;
  const findings = findingsFromReport(report);
  const collapsed = raw - findings.length;

  const outFile = process.env.UX_REVIEWER_REPORT_OUT;
  const sink = new HtmlReportSink(outFile ? { outFile } : {});
  const res = await sink.submit(findings, report);

  if (res.error) {
    console.error(`[ux-reviewer] report sink failed: ${res.error}`);
    process.exit(1);
  }
  const defects = findings.filter((f) => f.kind === 'defect').length;
  const suggestions = findings.length - defects;
  console.log(
    `[ux-reviewer] ${findings.length} findings (${defects} defects, ${suggestions} suggestions) · ` +
      `${collapsed} cross-cell duplicate${collapsed === 1 ? '' : 's'} collapsed from ${raw} raw`,
  );
  console.log(`[ux-reviewer] report.html → ${res.refs[0]}`);
}

main().catch((err) => {
  console.error('[ux-reviewer] fatal', err);
  process.exit(2);
});
