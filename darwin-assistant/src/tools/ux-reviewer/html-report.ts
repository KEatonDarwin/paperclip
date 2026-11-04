// JARVIS UX Reviewer — HTML report sink (DAR-685, slice 3).
//
// The first, dependency-free FindingSink: renders the normalized/deduped findings
// into a single standalone report.html the human (or JARVIS) can eyeball — each
// finding anchored to the screenshot it was found in. This makes the reviewer
// end-to-end useful now, before the remote Universal Bug-Intake API exists; that
// API will implement the same FindingSink interface and slot in alongside this.
//
// Screenshots are referenced by RELATIVE filename (basename), because the report
// is written into the capture outDir, right next to the PNGs — so opening
// report.html locally resolves the images with no copying or base64 bloat (full
// -page shots can be many MB each).

import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { CritiqueReport, Severity } from './vision-critique.js';
import { findingsFromReport, type FindingSink, type NormalizedFinding, type SinkResult } from './sink.js';

const SEV_COLOR: Record<Severity, string> = { high: '#e5484d', medium: '#f5a623', low: '#8a91a0' };

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Unique screenshots referenced by a finding's origins, most-severe screen first. */
function findingThumbs(f: NormalizedFinding): { label: string; src: string }[] {
  const seen = new Set<string>();
  const thumbs: { label: string; src: string }[] = [];
  for (const o of f.seenIn) {
    if (!o.file || seen.has(o.file)) continue;
    seen.add(o.file);
    thumbs.push({ label: `${o.state} · ${o.viewport}`, src: basename(o.file) });
  }
  return thumbs;
}

function findingCard(f: NormalizedFinding): string {
  const color = SEV_COLOR[f.severity];
  const kindTag =
    f.kind === 'defect'
      ? `<span class="tag" style="background:${color}">${esc(f.severity)}</span>`
      : `<span class="tag suggestion">suggestion</span>`;
  const rubric = f.rubric ? `<span class="rubric">rubric #${f.rubric}</span>` : '';
  const viewports = Array.from(new Set(f.seenIn.map((o) => o.viewport)));
  const seenBadges = viewports.map((v) => `<span class="vp">${esc(v)}</span>`).join('');
  const thumbs = findingThumbs(f)
    .map(
      (t) =>
        `<a class="thumb" href="${esc(t.src)}" target="_blank" title="${esc(t.label)}">` +
        `<img loading="lazy" src="${esc(t.src)}" alt="${esc(t.label)}"><span>${esc(t.label)}</span></a>`,
    )
    .join('');
  return [
    `<div class="card" style="border-left-color:${color}">`,
    `  <div class="card-head">${kindTag}<span class="title">${esc(f.title)}</span>${rubric}</div>`,
    `  <div class="meta"><span class="screen">${esc(f.screen)}</span><span class="region">${esc(f.region)}</span>${seenBadges}</div>`,
    `  <p class="detail">${esc(f.detail)}</p>`,
    thumbs ? `  <div class="thumbs">${thumbs}</div>` : '',
    `</div>`,
  ].join('\n');
}

export function renderHtmlReport(report: CritiqueReport, findings: NormalizedFinding[]): string {
  const defects = findings.filter((f) => f.kind === 'defect');
  const suggestions = findings.filter((f) => f.kind === 'suggestion');
  const sev = (s: Severity) => defects.filter((d) => d.severity === s).length;
  const errCells = report.cells.filter((c) => !c.ok);

  const section = (heading: string, items: NormalizedFinding[]) =>
    items.length
      ? `<section><h2>${esc(heading)} <span class="count">${items.length}</span></h2>${items.map(findingCard).join('\n')}</section>`
      : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UX Review — ${esc(report.project)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; background: #0f1115; color: #e7e9ee; }
  header { padding: 24px 28px; border-bottom: 1px solid #23262e; background: #161922; }
  header h1 { margin: 0 0 6px; font-size: 20px; }
  header .sub { color: #9aa0ac; font-size: 13px; }
  .stats { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
  .stat { background: #1c2029; border: 1px solid #2a2f3a; border-radius: 8px; padding: 8px 12px; font-size: 13px; }
  .stat b { font-size: 18px; display: block; }
  main { padding: 20px 28px 60px; max-width: 1100px; margin: 0 auto; }
  section { margin-top: 26px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .04em; color: #b7bdc9; border-bottom: 1px solid #23262e; padding-bottom: 8px; }
  h2 .count { color: #6a7182; font-weight: normal; }
  .card { background: #161922; border: 1px solid #23262e; border-left: 4px solid #8a91a0; border-radius: 8px; padding: 14px 16px; margin: 12px 0; }
  .card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .title { font-weight: 600; }
  .tag { color: #fff; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 2px 8px; border-radius: 999px; letter-spacing: .03em; }
  .tag.suggestion { background: #2a3346; color: #9db2d8; }
  .rubric { font-size: 11px; color: #7f93b8; background: #1b2436; padding: 2px 8px; border-radius: 999px; }
  .meta { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; font-size: 12px; color: #9aa0ac; align-items: center; }
  .meta .screen { background: #22283a; color: #b9c4de; padding: 2px 8px; border-radius: 6px; font-weight: 600; }
  .meta .region { font-style: italic; }
  .vp { background: #1c2029; border: 1px solid #2a2f3a; padding: 1px 7px; border-radius: 999px; font-size: 11px; }
  .detail { margin: 6px 0 0; color: #d6d9e0; }
  .thumbs { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
  .thumb { display: block; text-decoration: none; color: #9aa0ac; font-size: 11px; text-align: center; }
  .thumb img { display: block; width: 150px; height: 100px; object-fit: cover; object-position: top; border: 1px solid #2a2f3a; border-radius: 6px; background: #0a0c10; }
  .thumb span { display: block; margin-top: 4px; }
  .empty { color: #6a7182; font-style: italic; padding: 20px 0; }
</style></head>
<body>
<header>
  <h1>UX Review — ${esc(report.project)}</h1>
  <div class="sub">${esc(report.baseUrl)} · run ${esc(report.manifestRunId)} · model ${esc(report.model)} · ${esc(report.finishedAt)}</div>
  <div class="stats">
    <div class="stat"><b style="color:${SEV_COLOR.high}">${sev('high')}</b>high</div>
    <div class="stat"><b style="color:${SEV_COLOR.medium}">${sev('medium')}</b>medium</div>
    <div class="stat"><b style="color:${SEV_COLOR.low}">${sev('low')}</b>low</div>
    <div class="stat"><b>${suggestions.length}</b>suggestions</div>
    <div class="stat"><b>${report.critiquedCells}/${report.totalCells}</b>cells</div>
    <div class="stat"><b>$${report.totalCostUsd.toFixed(2)}</b>vision cost</div>
  </div>
</header>
<main>
  ${defects.length || suggestions.length ? '' : '<p class="empty">No findings — the reviewer saw nothing to flag.</p>'}
  ${section('Defects', defects)}
  ${section('Suggestions', suggestions)}
  ${errCells.length ? `<section><h2>Uncritiqued cells <span class="count">${errCells.length}</span></h2>${errCells.map((c) => `<div class="card"><div class="card-head"><span class="tag" style="background:#6a7182">error</span><span class="title">${esc(c.screen)}/${esc(c.state)}/${esc(c.viewport)}</span></div><p class="detail">${esc(c.error ?? 'unknown error')}</p></div>`).join('')}</section>` : ''}
</main>
</body></html>`;
}

export interface HtmlReportSinkOptions {
  outFile?: string; // default <report.outDir>/report.html
}

/** FindingSink that writes a standalone HTML report next to the screenshots. */
export class HtmlReportSink implements FindingSink {
  readonly name = 'html-report';
  constructor(private readonly opts: HtmlReportSinkOptions = {}) {}

  async submit(findings: NormalizedFinding[], report: CritiqueReport): Promise<SinkResult> {
    const outFile = this.opts.outFile ?? join(report.outDir, 'report.html');
    try {
      const html = renderHtmlReport(report, findings);
      await writeFile(outFile, html, 'utf8');
      return { sink: this.name, submitted: findings.length, refs: [outFile] };
    } catch (err) {
      return {
        sink: this.name,
        submitted: 0,
        refs: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/** Convenience: build findings from a report and write the HTML in one call. */
export async function writeHtmlReport(report: CritiqueReport, opts: HtmlReportSinkOptions = {}): Promise<SinkResult> {
  return new HtmlReportSink(opts).submit(findingsFromReport(report), report);
}
