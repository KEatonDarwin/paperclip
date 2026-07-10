// JARVIS UX Reviewer — capture runner CLI (DAR-685, slice 1).
//
// Runs a capture pass and prints a compact manifest summary. This is the
// "eyes" stage entrypoint; the vision-critique + bug-intake stages consume the
// manifest it writes. Trigger surfaces (post-deploy / on-demand / scheduled)
// call captureTarget() directly or shell this runner.
//
// Usage:
//   tsx src/tools/ux-reviewer/run-capture.ts [baseUrl] [convId]
// Env:
//   UX_REVIEWER_CHROMIUM  path to chromium (default /usr/bin/chromium)

import { captureTarget } from './capture-harness.js';
import { jarvisObsUiConfig } from './configs.js';

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

async function main() {
  const baseUrl = process.argv[2] || 'http://127.0.0.1:3201';
  let convId = process.argv[3] || undefined;
  if (!convId) convId = await discoverConvId(baseUrl);

  console.log(`[ux-reviewer] capturing ${baseUrl}${convId ? ` (thread ${convId})` : ''}`);
  const manifest = await captureTarget(jarvisObsUiConfig({ baseUrl, convId }));

  console.log(`[ux-reviewer] ${manifest.okCells}/${manifest.totalCells} cells ok → ${manifest.outDir}`);
  for (const c of manifest.cells) {
    const tag = c.ok ? 'OK ' : 'ERR';
    const detail = c.ok
      ? `${String(c.bytes).padStart(7)}B ${String(c.captureMs).padStart(5)}ms  ${c.relFile}`
      : `${c.error}`;
    const flags: string[] = [];
    if (c.consoleErrors.length) flags.push(`console:${c.consoleErrors.length}`);
    if (c.failedRequests.length) flags.push(`netfail:${c.failedRequests.length}`);
    console.log(`  ${tag} ${c.screen}/${c.state}/${c.viewport}  ${detail}${flags.length ? '  [' + flags.join(' ') + ']' : ''}`);
  }
  process.exit(manifest.okCells === manifest.totalCells ? 0 : 1);
}

main().catch((err) => {
  console.error('[ux-reviewer] fatal', err);
  process.exit(2);
});
