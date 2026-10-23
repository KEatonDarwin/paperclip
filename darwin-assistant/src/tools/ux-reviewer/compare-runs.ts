// JARVIS UX Reviewer — run-to-run diff (DAR-685, slice 4 prerequisite).
//
// Slices 1–3 give a single-pass verdict on a running app: capture → vision
// critique → normalized/deduped findings. That answers "what is wrong right
// now." The autonomous loop needs the OTHER half: after JARVIS applies a fix,
// "did the fix actually resolve the finding — and did it break anything else?"
//
// This module compares two CritiqueReports (a BASELINE = before the fix, and a
// CURRENT = after the fix) by their stable finding ids and classifies every
// finding as:
//   - resolved   : present in baseline, gone in current  (the fix worked)
//   - persisting : present in both                        (fix didn't land / partial)
//   - introduced : present in current, absent in baseline (a regression)
//
// The finding id from sink.ts is `screen|kind|slug(title)` — it deliberately
// ignores runId/viewport/state, so the same defect matches across runs. That is
// exactly the join key a before/after diff needs; no new identity scheme here.
//
// Pure + deterministic: no I/O, no vision cost. It only re-reads findings the
// critique pass already produced. This is what lets the reviewer CONFIRM a fix
// without a human eyeballing before/after — the "reviewer re-checks" step of the
// DAR-685 loop.

import type { CritiqueReport, Severity } from './vision-critique.js';
import { findingsFromReport, type NormalizedFinding } from './sink.js';

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export type DeltaStatus = 'resolved' | 'persisting' | 'introduced';
export type SeverityTrend = 'worse' | 'better' | 'same';

// A single finding's fate across the two runs.
export interface FindingDelta {
  id: string;
  status: DeltaStatus;
  kind: NormalizedFinding['kind'];
  screen: string;
  title: string;
  // The representative finding: the CURRENT-run version for persisting/introduced,
  // the BASELINE version for resolved (current has none).
  finding: NormalizedFinding;
  severity: Severity; // current severity for persisting/introduced; baseline for resolved
  baselineSeverity?: Severity; // set for persisting; lets the loop see worsened defects
  severityTrend?: SeverityTrend; // persisting only
}

export interface CompareCounts {
  resolved: number;
  persisting: number;
  introduced: number;
  baselineTotal: number;
  currentTotal: number;
  // defect-only slice — the loop's primary signal (suggestions are advisory)
  resolvedDefects: number;
  persistingDefects: number;
  introducedDefects: number;
}

export type Verdict = 'improved' | 'regressed' | 'mixed' | 'unchanged';

export interface CompareReport {
  project: string;
  baseUrl: string;
  baselineRunId: string;
  currentRunId: string;
  baselineModel: string;
  currentModel: string;
  verdict: Verdict;
  counts: CompareCounts;
  resolved: FindingDelta[];
  persisting: FindingDelta[];
  introduced: FindingDelta[];
}

function severityTrend(baseline: Severity, current: Severity): SeverityTrend {
  const d = SEVERITY_RANK[current] - SEVERITY_RANK[baseline];
  if (d > 0) return 'worse';
  if (d < 0) return 'better';
  return 'same';
}

/**
 * Verdict is graded on DEFECTS only — suggestions are subjective/advisory and
 * shouldn't flip a fix from "pass" to "fail". A persisting defect whose severity
 * got WORSE counts as a regression signal (mixed at best), since the fix made
 * something objectively worse even if no brand-new finding appeared.
 */
function computeVerdict(deltas: FindingDelta[]): Verdict {
  const resolvedDefects = deltas.filter((d) => d.status === 'resolved' && d.kind === 'defect').length;
  const introducedDefects = deltas.filter((d) => d.status === 'introduced' && d.kind === 'defect').length;
  const worsenedDefects = deltas.filter(
    (d) => d.status === 'persisting' && d.kind === 'defect' && d.severityTrend === 'worse',
  ).length;

  const gained = resolvedDefects > 0;
  const lost = introducedDefects > 0 || worsenedDefects > 0;

  if (gained && lost) return 'mixed';
  if (gained) return 'improved';
  if (lost) return 'regressed';
  return 'unchanged';
}

/**
 * Diff two critique reports. `baseline` is the state BEFORE a fix, `current` is
 * the state AFTER. Both are normalized+deduped first so we compare stable,
 * cross-viewport findings, not raw per-cell rows.
 */
export function compareReports(baseline: CritiqueReport, current: CritiqueReport): CompareReport {
  const base = findingsFromReport(baseline);
  const curr = findingsFromReport(current);

  const baseById = new Map(base.map((f) => [f.id, f]));
  const currById = new Map(curr.map((f) => [f.id, f]));

  const resolved: FindingDelta[] = [];
  const persisting: FindingDelta[] = [];
  const introduced: FindingDelta[] = [];

  // resolved + persisting: walk baseline
  for (const b of base) {
    const c = currById.get(b.id);
    if (!c) {
      resolved.push({
        id: b.id,
        status: 'resolved',
        kind: b.kind,
        screen: b.screen,
        title: b.title,
        finding: b,
        severity: b.severity,
      });
    } else {
      persisting.push({
        id: c.id,
        status: 'persisting',
        kind: c.kind,
        screen: c.screen,
        title: c.title,
        finding: c,
        severity: c.severity,
        baselineSeverity: b.severity,
        severityTrend: severityTrend(b.severity, c.severity),
      });
    }
  }

  // introduced: current findings with no baseline match
  for (const c of curr) {
    if (!baseById.has(c.id)) {
      introduced.push({
        id: c.id,
        status: 'introduced',
        kind: c.kind,
        screen: c.screen,
        title: c.title,
        finding: c,
        severity: c.severity,
      });
    }
  }

  const isDefect = (d: FindingDelta) => d.kind === 'defect';
  const counts: CompareCounts = {
    resolved: resolved.length,
    persisting: persisting.length,
    introduced: introduced.length,
    baselineTotal: base.length,
    currentTotal: curr.length,
    resolvedDefects: resolved.filter(isDefect).length,
    persistingDefects: persisting.filter(isDefect).length,
    introducedDefects: introduced.filter(isDefect).length,
  };

  const all = [...resolved, ...persisting, ...introduced];

  return {
    project: current.project,
    baseUrl: current.baseUrl,
    baselineRunId: baseline.manifestRunId,
    currentRunId: current.manifestRunId,
    baselineModel: baseline.model,
    currentModel: current.model,
    verdict: computeVerdict(all),
    counts,
    resolved,
    persisting,
    introduced,
  };
}

/** One-line human summary for logs / the loop's decision point. */
export function summarizeCompare(cmp: CompareReport): string {
  const c = cmp.counts;
  return (
    `${cmp.verdict.toUpperCase()} · ` +
    `resolved ${c.resolved} (${c.resolvedDefects} defect${c.resolvedDefects === 1 ? '' : 's'}), ` +
    `persisting ${c.persisting}, ` +
    `introduced ${c.introduced} (${c.introducedDefects} defect${c.introducedDefects === 1 ? '' : 's'})`
  );
}
