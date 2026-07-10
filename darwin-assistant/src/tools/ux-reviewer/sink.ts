// JARVIS UX Reviewer — sink layer (DAR-685, slice 3).
//
// Slice 2 (vision-critique.ts) produced a CritiqueReport (findings.json): per
// captured cell, a list of objective DEFECTS + subjective SUGGESTIONS. This slice
// is the SINK: it turns those raw per-cell findings into a normalized, deduped
// finding list and hands them to one or more FindingSink implementations.
//
// The FindingSink interface is the pluggable seam. The keystone remote sink — the
// JARVIS-owned Universal Bug-Intake API — is a sibling build not yet stood up; it
// will implement this same interface (submit(findings, report)). Until then the
// reviewer is already end-to-end useful via local sinks (HtmlReportSink) that
// need no remote dependency. Swapping in the remote API later is a one-line change
// at the call site, not a rewrite.
//
// Two jobs here:
//  1. normalizeReport(): flatten the per-cell CritiqueReport into flat findings,
//     each carrying its origin cell (screen/state/viewport + screenshot path).
//  2. dedupeFindings(): collapse the SAME finding seen across viewports/states of
//     one screen into a single finding with a `seenIn` provenance list. The vision
//     pass runs per cell and independently re-reports viewport-invariant issues
//     (e.g. low-contrast metadata) on mobile + tablet + desktop; a downstream bug
//     tracker should see that once, not three times.

import type { CritiqueReport, Severity } from './vision-critique.js';

export type FindingKind = 'defect' | 'suggestion';

// Where a finding was observed — one entry per cell it appeared in.
export interface FindingOrigin {
  screen: string;
  state: string;
  viewport: string;
  file?: string; // absolute screenshot path for that cell
}

// A normalized, possibly-deduped finding ready for any sink.
export interface NormalizedFinding {
  id: string; // stable dedup key (screen|kind|slug(title))
  kind: FindingKind;
  severity: Severity; // suggestions are always 'low'; defects keep their graded severity
  title: string;
  detail: string;
  region: string;
  rubric?: number | null; // objective rubric item violated, if any (defects only)
  screen: string;
  seenIn: FindingOrigin[]; // every cell this finding was observed in (>=1)
}

export interface SinkResult {
  sink: string; // implementation name
  submitted: number; // findings accepted
  refs: string[]; // opaque handles the sink produced (file path, issue id, url, ...)
  error?: string;
}

// The pluggable seam. The remote Universal Bug-Intake API will implement this.
export interface FindingSink {
  readonly name: string;
  submit(findings: NormalizedFinding[], report: CritiqueReport): Promise<SinkResult>;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

/** Stable slug for dedup + ids: lowercase alphanumerics, collapsed. */
export function slug(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Flatten a CritiqueReport into per-observation findings (before dedup). */
export function normalizeReport(report: CritiqueReport): NormalizedFinding[] {
  const out: NormalizedFinding[] = [];
  for (const cell of report.cells) {
    if (!cell.ok) continue;
    const origin: FindingOrigin = {
      screen: cell.screen,
      state: cell.state,
      viewport: cell.viewport,
      file: cell.file,
    };
    for (const d of cell.defects) {
      out.push({
        id: `${slug(cell.screen)}|defect|${slug(d.title)}`,
        kind: 'defect',
        severity: d.severity,
        title: d.title,
        detail: d.detail,
        region: d.region,
        rubric: d.rubric ?? null,
        screen: cell.screen,
        seenIn: [origin],
      });
    }
    for (const s of cell.suggestions) {
      out.push({
        id: `${slug(cell.screen)}|suggestion|${slug(s.title)}`,
        kind: 'suggestion',
        severity: 'low',
        title: s.title,
        detail: s.detail,
        region: s.region,
        rubric: null,
        screen: cell.screen,
        seenIn: [origin],
      });
    }
  }
  return out;
}

/**
 * Collapse findings that share an id (same screen + kind + title slug) across
 * viewports/states into one. Keeps the highest severity observed, the longest
 * detail (most informative), the first rubric hit, and unions every origin cell.
 * Order is preserved by first appearance; within that, defects sort ahead of
 * suggestions and higher severity first.
 */
export function dedupeFindings(findings: NormalizedFinding[]): NormalizedFinding[] {
  const byId = new Map<string, NormalizedFinding>();
  const order: string[] = [];
  for (const f of findings) {
    const existing = byId.get(f.id);
    if (!existing) {
      byId.set(f.id, { ...f, seenIn: [...f.seenIn] });
      order.push(f.id);
      continue;
    }
    // merge
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[existing.severity]) existing.severity = f.severity;
    if (f.detail.length > existing.detail.length) existing.detail = f.detail;
    if (existing.rubric == null && f.rubric != null) existing.rubric = f.rubric;
    for (const o of f.seenIn) {
      if (!existing.seenIn.some((e) => e.screen === o.screen && e.state === o.state && e.viewport === o.viewport)) {
        existing.seenIn.push(o);
      }
    }
  }
  const merged = order.map((id) => byId.get(id)!);
  merged.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'defect' ? -1 : 1;
    return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  });
  return merged;
}

/** Convenience: normalize + dedupe in one call. */
export function findingsFromReport(report: CritiqueReport): NormalizedFinding[] {
  return dedupeFindings(normalizeReport(report));
}
