// JARVIS UX Reviewer — compare runner CLI (DAR-685, slice 4 prerequisite).
//
// Diffs two critique runs (before-fix vs after-fix) and prints a verdict plus a
// per-finding resolved / persisting / introduced breakdown, then writes
// compare.json beside the CURRENT findings for the loop to consume.
//
// Usage:
//   tsx src/tools/ux-reviewer/run-compare.ts [baseline] [current]
//     - 0 args: two newest findings.json under /tmp/ux-reviewer/** ,
//               newest = current (after), second-newest = baseline (before).
//     - 2 args: explicit baseline then current (findings.json path or a dir
//               containing one).
//   UX_REVIEWER_COMPARE_OUT   override the compare.json output path
//
// The 0-arg default is the loop ergonomic: capture+critique BEFORE a fix,
// JARVIS fixes, capture+critique AFTER, then run-compare with no args diffs the
// two newest automatically.

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CritiqueReport } from './vision-critique.js';
import { compareReports, summarizeCompare, type FindingDelta } from './compare-runs.js';

async function findFindings(root = '/tmp/ux-reviewer'): Promise<{ path: string; mtime: number }[]> {
  const found: { path: string; mtime: number }[] = [];
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
      else if (name === 'findings.json') found.push({ path: p, mtime: st.mtimeMs });
    }
  }
  await walk(root, 0);
  return found.sort((a, b) => b.mtime - a.mtime); // newest first
}

async function resolveArg(arg: string): Promise<string> {
  try {
    const st = await stat(arg);
    if (st.isDirectory()) return join(arg, 'findings.json');
    return arg;
  } catch {
    return arg;
  }
}

function line(d: FindingDelta): string {
  const sev = d.kind === 'defect' ? `[${d.severity}] ` : '';
  const trend =
    d.status === 'persisting' && d.severityTrend && d.severityTrend !== 'same'
      ? ` (severity ${d.baselineSeverity}→${d.severity}, ${d.severityTrend})`
      : '';
  return `    ${d.screen} · ${sev}${d.title}${trend}`;
}

async function main() {
  const argv = process.argv.slice(2);
  let baselinePath: string | undefined;
  let currentPath: string | undefined;

  if (argv.length >= 2) {
    baselinePath = await resolveArg(argv[0]);
    currentPath = await resolveArg(argv[1]);
  } else if (argv.length === 0) {
    const all = await findFindings();
    if (all.length < 2) {
      console.error(
        `[ux-reviewer] need two findings.json to compare — found ${all.length} under /tmp/ux-reviewer. ` +
          `Run capture+critique before AND after the fix, or pass two paths explicitly.`,
      );
      process.exit(2);
    }
    currentPath = all[0].path; // newest = after
    baselinePath = all[1].path; // second newest = before
  } else {
    console.error('[ux-reviewer] pass 0 args (auto two-newest) or exactly 2 (baseline current)');
    process.exit(2);
  }

  const baseline = JSON.parse(await readFile(baselinePath!, 'utf8')) as CritiqueReport;
  const current = JSON.parse(await readFile(currentPath!, 'utf8')) as CritiqueReport;

  const cmp = compareReports(baseline, current);

  console.log(`[ux-reviewer] compare ${cmp.project}`);
  console.log(`  baseline (before): ${cmp.baselineRunId}  ←  ${baselinePath}`);
  console.log(`  current  (after):  ${cmp.currentRunId}  ←  ${currentPath}`);
  console.log(`  VERDICT: ${summarizeCompare(cmp)}`);

  if (cmp.resolved.length) {
    console.log(`  ✅ resolved (${cmp.resolved.length}):`);
    for (const d of cmp.resolved) console.log(line(d));
  }
  if (cmp.introduced.length) {
    console.log(`  ⛔ introduced / regressions (${cmp.introduced.length}):`);
    for (const d of cmp.introduced) console.log(line(d));
  }
  const worsened = cmp.persisting.filter((d) => d.severityTrend === 'worse');
  if (worsened.length) {
    console.log(`  ⚠️  persisting but WORSE (${worsened.length}):`);
    for (const d of worsened) console.log(line(d));
  }
  if (cmp.persisting.length) {
    console.log(`  ↔️  persisting (${cmp.persisting.length} total, unfixed)`);
  }

  const outFile = process.env.UX_REVIEWER_COMPARE_OUT || join(dirname(currentPath!), 'compare.json');
  await writeFile(outFile, JSON.stringify(cmp, null, 2));
  console.log(`[ux-reviewer] compare.json → ${outFile}`);

  // Exit code encodes the verdict so a shell loop can branch without parsing:
  //   0 improved/unchanged (safe to accept) · 1 regressed/mixed (needs another pass)
  process.exit(cmp.verdict === 'regressed' || cmp.verdict === 'mixed' ? 1 : 0);
}

main().catch((err) => {
  console.error('[ux-reviewer] fatal', err);
  process.exit(2);
});
