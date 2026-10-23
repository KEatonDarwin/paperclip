// JARVIS UX Reviewer — loop orchestrator CLI (DAR-685, slice 4).
//
// The single entrypoint that ties the four stages together into the actual
// review→(fix)→re-review loop. Two modes, selected by whether a fixer command
// is configured:
//
//   GATE mode (no fixer)  — capture → critique → report, then exit-code the run
//     on a severity threshold. This is the post-deploy / scheduled guard: run it
//     after a deploy and it fails (exit 1) if the live UI has UX defects at or
//     above UX_REVIEWER_GATE_SEVERITY, so a deploy pipeline can block/alert.
//
//   FIX-LOOP mode (fixer) — capture+critique BEFORE, run the fixer command,
//     capture+critique AFTER, then compareReports(before, after) → compare.json
//     + a defect-graded verdict, exit-coded so a shell can accept/retry. This is
//     the "JARVIS applies a fix and the reviewer confirms it" self-healing loop.
//
// The compare + critique + capture + report engines are all reused verbatim —
// this file is pure orchestration, no new review logic.
//
// Usage:
//   tsx src/tools/ux-reviewer/run-loop.ts [baseUrl] [convId]
//
// Env:
//   UX_REVIEWER_CHROMIUM        chromium path (default /usr/bin/chromium)
//   UX_REVIEWER_FIXER_CMD       shell command that applies a fix between the
//                               before/after passes. Its presence switches GATE
//                               → FIX-LOOP. Receives UX_REVIEWER_BASELINE_FINDINGS
//                               (path to before-fix findings.json) in its env so
//                               the fixer knows what to act on. Non-zero exit from
//                               the fixer aborts the loop (exit 3).
//   UX_REVIEWER_GATE_SEVERITY   GATE-mode threshold: high|medium|low|any|none
//                               (default "high"). "none" always passes (report-only).
//   UX_REVIEWER_CONCURRENCY     parallel cells for critique (default 3)
//   UX_REVIEWER_NO_REPORT       set to skip report.html emission
//   (plus the UX_REVIEWER_CLAUDE_BIN / UX_REVIEWER_VISION_MODEL that critique reads)
//
// Exit codes:
//   0  clean — GATE: below threshold · FIX-LOOP: improved/unchanged (accept)
//   1  actionable — GATE: at/above threshold · FIX-LOOP: regressed/mixed (retry)
//   2  no cells / setup failure
//   3  fixer command failed

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureTarget, type CaptureManifest } from './capture-harness.js';
import { jarvisObsUiConfig } from './configs.js';
import { critiqueManifest, type CritiqueReport, type Severity } from './vision-critique.js';
import { writeHtmlReport } from './html-report.js';
import { compareReports, summarizeCompare } from './compare-runs.js';

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

async function discoverConvId(baseUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/conversations`);
    if (!res.ok) return undefined;
    const body: any = await res.json();
    const arr = Array.isArray(body) ? body : body.conversations ?? body.items ?? [];
    const first = arr[0];
    const id = first && (first.id ?? first.conversationId);
    return id != null ? String(id) : undefined;
  } catch {
    return undefined;
  }
}

/** Capture + critique + (optionally) report a single pass. Returns the report. */
async function reviewPass(
  label: string,
  baseUrl: string,
  convId: string | undefined,
  concurrency: number | undefined,
): Promise<CritiqueReport> {
  console.log(`[ux-reviewer] [${label}] capturing ${baseUrl}${convId ? ` (thread ${convId})` : ''}`);
  const manifest: CaptureManifest = await captureTarget(jarvisObsUiConfig({ baseUrl, convId }));
  console.log(`[ux-reviewer] [${label}] ${manifest.okCells}/${manifest.totalCells} cells captured → ${manifest.outDir}`);
  if (manifest.okCells === 0) {
    throw new Error(`no cells captured for ${label} — is ${baseUrl} reachable?`);
  }

  const report = await critiqueManifest(manifest, concurrency ? { concurrency } : {});
  console.log(
    `[ux-reviewer] [${label}] ${report.critiquedCells}/${report.totalCells} critiqued · ` +
      `${report.defectCount} defects (H:${report.bySeverity.high} M:${report.bySeverity.medium} L:${report.bySeverity.low}) · ` +
      `$${report.totalCostUsd.toFixed(3)}`,
  );

  if (!process.env.UX_REVIEWER_NO_REPORT) {
    const res = await writeHtmlReport(report);
    if (res.error) console.error(`[ux-reviewer] [${label}] report.html skipped — ${res.error}`);
    else console.log(`[ux-reviewer] [${label}] report.html → ${res.refs[0]}`);
  }
  return report;
}

/** Run the configured fixer command, passing the baseline findings path in env. */
function runFixer(cmd: string, baselineFindings: string): Promise<number> {
  console.log(`[ux-reviewer] running fixer: ${cmd}`);
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      stdio: 'inherit',
      env: { ...process.env, UX_REVIEWER_BASELINE_FINDINGS: baselineFindings },
    });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      console.error(`[ux-reviewer] fixer spawn error — ${err.message}`);
      resolve(1);
    });
  });
}

/** GATE-mode: does this report trip the configured severity threshold? */
function gateTripped(report: CritiqueReport): { tripped: boolean; threshold: string; reason: string } {
  const threshold = (process.env.UX_REVIEWER_GATE_SEVERITY || 'high').toLowerCase();
  if (threshold === 'none') return { tripped: false, threshold, reason: 'gate disabled (none)' };

  const bs = report.bySeverity;
  if (threshold === 'any') {
    const n = report.defectCount;
    return { tripped: n > 0, threshold, reason: `${n} defect(s)` };
  }
  const min = SEVERITY_RANK[threshold as Severity];
  if (!min) {
    // Unknown threshold string — fail safe by treating it as "high".
    return { tripped: bs.high > 0, threshold: 'high (fallback)', reason: `${bs.high} high-severity defect(s)` };
  }
  const atOrAbove = (['high', 'medium', 'low'] as Severity[])
    .filter((s) => SEVERITY_RANK[s] >= min)
    .reduce((sum, s) => sum + bs[s], 0);
  return { tripped: atOrAbove > 0, threshold, reason: `${atOrAbove} defect(s) at ≥${threshold}` };
}

async function main() {
  const baseUrl = process.argv[2] || 'http://127.0.0.1:3201';
  let convId = process.argv[3] || undefined;
  if (!convId) convId = await discoverConvId(baseUrl);
  const concurrency = process.env.UX_REVIEWER_CONCURRENCY ? Number(process.env.UX_REVIEWER_CONCURRENCY) : undefined;
  const fixerCmd = process.env.UX_REVIEWER_FIXER_CMD?.trim();

  // ---- Baseline pass (always) ----
  const before = await reviewPass('before', baseUrl, convId, concurrency);
  const baselineFindings = join(before.outDir, 'findings.json');

  // ---- GATE mode: no fixer → threshold-gate the single pass ----
  if (!fixerCmd) {
    const gate = gateTripped(before);
    console.log(`\n[ux-reviewer] GATE (${gate.threshold}): ${gate.tripped ? '⛔ FAIL' : '✅ PASS'} — ${gate.reason}`);
    process.exit(gate.tripped ? 1 : 0);
  }

  // ---- FIX-LOOP mode: fix, re-review, diff ----
  const fixCode = await runFixer(fixerCmd, baselineFindings);
  if (fixCode !== 0) {
    console.error(`[ux-reviewer] fixer exited ${fixCode} — aborting loop (no after-pass)`);
    process.exit(3);
  }

  const after = await reviewPass('after', baseUrl, convId, concurrency);

  const cmp = compareReports(before, after);
  const outFile = join(after.outDir, 'compare.json');
  await writeFile(outFile, JSON.stringify(cmp, null, 2));

  console.log(`\n[ux-reviewer] LOOP VERDICT: ${summarizeCompare(cmp)}`);
  console.log(
    `  resolved:${cmp.resolved.length} persisting:${cmp.persisting.length} introduced:${cmp.introduced.length}`,
  );
  console.log(`[ux-reviewer] compare.json → ${outFile}`);

  // 0 accept (improved/unchanged) · 1 retry (regressed/mixed) — same contract as run-compare.
  process.exit(cmp.verdict === 'regressed' || cmp.verdict === 'mixed' ? 1 : 0);
}

main().catch((err) => {
  console.error('[ux-reviewer] fatal', err);
  process.exit(2);
});
