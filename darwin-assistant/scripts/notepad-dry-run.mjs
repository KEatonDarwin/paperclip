#!/usr/bin/env node
// NOTEPAD DRY RUN — run the whole notepad brain over a real day of notes and
// report what it WOULD do, creating nothing.
//
// The chain is the production one, and since node #943 every judging stage in
// it reads Kevin's topic BLOCKS rather than isolated lines (docs/notepad/
// BLOCKS.md): the gate (did a complete topic land in this block?) -> the
// whole-note review -> the move decision under its real per-BLOCK noise
// budget -> the topic dossier for the whole block -> the deterministic block
// routing rule. It stops one step short of dispatchNotepadBlock(), the only function
// that creates hopper cards / ghost goal nodes / workstreams / threads and the
// only one that writes the line-state ledger. Nothing here writes anything but
// the report.
//
// It runs against a COPY of the database, never the live one, so a day of real
// notes can be evaluated without the day-open path carrying lines forward or
// the ledger being stamped. Because the copy is a "scratch" path, the sim guard
// (notepad-gate.ts assertModelSpawnAllowed) refuses to spawn models -- so this
// script passes its OWN runOneShot through the documented injection seam. The
// model calls are real, deliberate, and made through the subscription CLI. No
// API keys.
//
//   cp <live jarvis.db> /tmp/notepad-dry-run.db
//   JARVIS_DB_PATH=/tmp/notepad-dry-run.db node scripts/notepad-dry-run.mjs \
//     --day 2026-09-25 --out /home/kevin/obsidian/paperclip-wiki/outbox/notepad-dry-run-2026-09-25.md
//
// Flags: --day <YYYY-MM-DD> (default: latest day with lines) · --out <path>
//        --budget <n> (override notepad_moves_max_per_day on the COPY, to show
//        what later days would pick up) · --no-dossier (skip dossier building)

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIVE_DB = '/home/kevin/paperclip/darwin-assistant/jarvis.db';

const argv = process.argv.slice(2);
function flag(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
}
const hasFlag = (name) => argv.includes(`--${name}`);

const raw = process.env.JARVIS_DB_PATH;
if (!raw || !raw.trim()) {
  console.error('FATAL: JARVIS_DB_PATH must point at a COPY of the database.');
  process.exit(1);
}
const DB_PATH = path.resolve(raw);
if (DB_PATH === path.resolve(LIVE_DB)) {
  console.error('FATAL: refusing to run against the live jarvis.db — copy it first.');
  process.exit(1);
}
if (!fs.existsSync(DB_PATH)) {
  console.error(`FATAL: ${DB_PATH} does not exist. Copy the live DB there first.`);
  process.exit(1);
}

const distDir = path.join(__dirname, '..', 'dist');
const { getNotepadDay } = await import(path.join(distDir, 'notepad.js'));
const { buildNotepadReviewContext } = await import(path.join(distDir, 'notepad-review.js'));
const { runNotepadGate } = await import(path.join(distDir, 'notepad-gate.js'));
const { decideNotepadMoves } = await import(path.join(distDir, 'notepad-moves.js'));
const { buildTopicDossier } = await import(path.join(distDir, 'notepad-dossier.js'));
const { routeNotepadBlock } = await import(path.join(distDir, 'notepad-route-rule.js'));
const { parseNotepadBlocks, notepadBlockId } = await import(path.join(distDir, 'notepad-blocks.js'));
const { sqliteDb } = await import(path.join(distDir, 'conversation-db.js'));

// ── which day ───────────────────────────────────────────────────────────────
const DAY =
  flag('day') ??
  sqliteDb.prepare(`SELECT day FROM notepad_lines GROUP BY day ORDER BY day DESC LIMIT 1`).get()?.day;
if (!DAY) {
  console.error('FATAL: no notepad_lines rows in this database — nothing to dry-run.');
  process.exit(1);
}

// ── the noise budget (on the COPY only) ─────────────────────────────────────
const budget = flag('budget');
if (budget) {
  sqliteDb
    .prepare(`INSERT INTO settings (key, value) VALUES ('notepad_moves_max_per_day', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(String(budget));
}

// ── the model seam: the real CLI, no API keys ───────────────────────────────
const CLAUDE_BIN = process.env.UX_REVIEWER_CLAUDE_BIN || 'claude';
let spawnCount = 0;
function oneShot(model, timeoutMs) {
  return (prompt) => {
    spawnCount += 1;
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    return new Promise((resolve, reject) => {
      execFile(
        CLAUDE_BIN,
        ['-p', prompt, '--output-format', 'json', '--model', model],
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env },
        (err, stdout, stderr) => {
          if (err && !stdout) {
            reject(new Error(`${model} call failed: ${err.message}${stderr ? ` | ${stderr.slice(0, 300)}` : ''}`));
            return;
          }
          try {
            const envelope = JSON.parse(stdout.trim());
            resolve(typeof envelope.result === 'string' ? envelope.result : stdout);
          } catch {
            resolve(stdout);
          }
        },
      );
    });
  };
}
const gateOneShot = oneShot(process.env.NOTEPAD_GATE_MODEL || 'claude-haiku-4-5-20251001', 600_000);
const judgeOneShot = oneShot(process.env.NOTEPAD_JUDGE_MODEL || 'claude-sonnet-5', 1_200_000);

// ── the chain ───────────────────────────────────────────────────────────────
const started = Date.now();
console.error(`[notepad-dry-run] day=${DAY} db=${DB_PATH}`);

const day = getNotepadDay(DAY);
const review = buildNotepadReviewContext(DAY);
const surfaced = review.lines.filter((l) => l.surfaced);
console.error(`[notepad-dry-run] ${day.lines.length} lines, ${surfaced.length} surfaced to the scanner`);

console.error('[notepad-dry-run] gate…');
// Node #942: the gate now judges Kevin's topic BLOCKS, not individual lines
// (docs/notepad/BLOCKS.md) -- each GateVerdict covers a block's whole
// member_line_ids, not one line_id. This report is still line-oriented, so
// every block verdict is flattened back out over its members: every line in
// a "complete" block counts as complete, every line in a rejected block
// shares that block's rejection reason.
const gate = await runNotepadGate(DAY, { runOneShot: gateOneShot, timeoutMs: 540_000 });
const completeIds = new Set(gate.filter((v) => v.complete_thought).flatMap((v) => v.member_line_ids));
console.error(`[notepad-dry-run] gate: ${gate.length} block(s) judged, ${completeIds.size} line(s) in a complete-thought block`);

// A 'fallback' verdict means the model call FAILED (usually a timeout). The gate
// then reports every block as not-a-complete-thought, which reads exactly like a
// confident "nothing here." Publishing that as a dry-run result would be worse
// than publishing nothing, so refuse.
const fellBackBlocks = gate.filter((v) => v.reason === 'fallback');
if (fellBackBlocks.length > 0 && !hasFlag('allow-fallback')) {
  const fellBackLines = fellBackBlocks.reduce((n, v) => n + v.member_line_ids.length, 0);
  console.error(
    `FATAL: ${fellBackBlocks.length} gate block verdict(s) (${fellBackLines} line(s)) came back 'fallback' --` +
      ` the model call failed, so those blocks are being reported as incomplete without ever having been` +
      ` judged. Raise the timeout, or pass --allow-fallback to publish anyway.`,
  );
  process.exit(1);
}

console.error('[notepad-dry-run] move decision…');
const movesResult = await decideNotepadMoves(DAY, { review, runOneShot: judgeOneShot, timeoutMs: 1_140_000 });
console.error(`[notepad-dry-run] ${movesResult.moves.length} move(s), outcome=${movesResult.outcome}`);
if (movesResult.outcome === 'fallback' && !hasFlag('allow-fallback')) {
  console.error(
    'FATAL: the move-decision model call failed, so moves was forced empty. An empty move list is a' +
      ' legitimate answer when the model actually RAN -- publishing one it never produced is not.',
  );
  process.exit(1);
}

const allLines = day.lines.map((l) => ({ line_id: l.id, idx: l.idx, text: l.text }));
const byId = new Map(allLines.map((l) => [l.line_id, l]));

// Kevin's topic blocks over the same lines -- the unit every judgement below
// is made about. Keyed by block_id (the headline's line id) so a move can be
// resolved straight back to the block it was decided about.
const blocksById = new Map(
  parseNotepadBlocks(day.lines.map((l) => ({ id: l.id, idx: l.idx, text: l.text }))).map((b) => {
    const block_id = notepadBlockId(b);
    return [
      block_id,
      {
        block_id,
        headline_line_id: b.headline_line_id,
        headline: b.headline,
        lines: b.member_line_ids.map((id) => byId.get(id)).filter(Boolean),
      },
    ];
  }),
);
console.error(`[notepad-dry-run] ${blocksById.size} topic block(s) across ${day.lines.length} lines`);

const plans = [];
for (const move of movesResult.moves) {
  const block = blocksById.get(move.block_id);
  if (!block) continue;
  let dossier = null;
  if (!hasFlag('no-dossier') && move.kind === 'take_it') {
    console.error(`[notepad-dry-run] dossier for block ${move.block_id}…`);
    try {
      dossier = await buildTopicDossier(
        { block: { block_id: block.block_id, headline_line_id: block.headline_line_id, headline: block.headline, lines: block.lines.map((l) => ({ line_id: l.line_id, text: l.text })) } },
        { runOneShot: judgeOneShot, timeoutMs: 1_140_000 },
      );
    } catch (e) {
      dossier = { error: String(e?.message ?? e) };
    }
  }
  const decision = routeNotepadBlock({
    block,
    move: { kind: move.kind, reason: move.reason },
    dossier: dossier && !dossier.error ? { confidence: dossier.confidence } : null,
  });
  plans.push({ move, block, decision, dossier });
}

// ── the report ──────────────────────────────────────────────────────────────
const WOULD_CREATE = {
  goal_proposal: 'a GHOST node under an existing goal — awaiting your ✓, never a new goal',
  hopper: 'a pending candidate card at /hopper — awaiting Yes / Yes-but / Dismiss',
  workstream: 'a Flight Deck workstream, turn=jarvis, with a next_action',
  thread: 'a cockpit thread for the line, seeded with its dossier',
};

const out = [];
out.push(`# Notepad dry run — ${DAY}`);
out.push('');
out.push(`_Generated ${new Date().toISOString()} · **nothing was created**. The chain ran through the`);
out.push(`routing decision and stopped before dispatch. Read against a copy of the database; your live`);
out.push(`notepad and its ledger were never touched._`);
out.push('');
out.push('## The shape of the day');
out.push('');
out.push(`| | |`);
out.push(`|---|---|`);
out.push(`| lines in the notepad | ${day.lines.length} (${day.lines.filter((l) => l.text.trim()).length} with text) |`);
out.push(`| topic blocks | ${blocksById.size} |`);
out.push(`| surfaced to the scanner | ${surfaced.length} line(s) |`);
out.push(`| gate says a complete topic landed | ${gate.filter((v) => v.complete_thought).length} block(s) / ${completeIds.size} line(s) |`);
out.push(`| moves proposed | ${movesResult.moves.length} of ${movesResult.candidate_count} candidate block(s) (budget ${budget ?? 5} blocks/day, outcome \`${movesResult.outcome}\`) |`);
out.push(`| model calls spent | ${spawnCount} |`);
out.push('');

out.push('## What it would do');
out.push('');
function blockTitleOf(p) {
  if (p.block.headline !== null && p.block.headline.trim()) return p.block.headline.trim();
  const first = p.block.lines.find((l) => l.text.trim());
  return (first?.text ?? '').trim();
}

if (plans.length === 0) {
  out.push('_Nothing. Every topic was judged either incomplete, already handled, or not worth a move._');
} else {
  out.push('| topic | lines | move | sink | what that creates | why |');
  out.push('|---|---|---|---|---|---|');
  for (const p of plans) {
    const title = blockTitleOf(p).replace(/\|/g, '\\|');
    out.push(
      `| ${title} | ${p.block.lines.length} | \`${p.move.kind}\` | **${p.decision.sink}** (${p.decision.confidence}) | ${
        WOULD_CREATE[p.decision.sink]
      } | ${p.decision.why.replace(/\|/g, '\\|')} |`,
    );
  }
  out.push('');
  out.push('### Its reasoning, topic by topic');
  out.push('');
  for (const p of plans) {
    out.push(`**${blockTitleOf(p)}**`);
    out.push('');
    out.push('```');
    for (const l of p.block.lines) out.push(l.text);
    out.push('```');
    out.push('');
    out.push(`- move: \`${p.move.kind}\` — ${p.move.reason}`);
    out.push(`- sink: \`${p.decision.sink}\` (${p.decision.confidence} confidence) — ${p.decision.why}`);
    if (p.dossier?.error) out.push(`- dossier: FAILED — ${p.dossier.error}`);
    else if (p.dossier) {
      out.push(`- dossier confidence: \`${p.dossier.confidence}\`${p.dossier.goal ? ` · goal: #${p.dossier.goal.goal_id} ${p.dossier.goal.title}` : ''}`);
      if (p.dossier.unresolved_reason) out.push(`- dossier note: ${p.dossier.unresolved_reason}`);
    }
    out.push('');
  }
}
out.push('');

out.push('## What it would stay silent about');
out.push('');
const movedLineIds = new Set(plans.flatMap((p) => p.block.lines.map((l) => l.line_id)));
const silentComplete = [...completeIds].filter((id) => !movedLineIds.has(id));
out.push(
  `${silentComplete.length} line(s), inside topics the gate judged complete, that the move decision still left alone:`,
);
out.push('');
for (const id of silentComplete) {
  const l = byId.get(id);
  if (l && l.text.trim()) out.push(`- ${l.idx + 1}. ${l.text.trim()}`);
}
out.push('');
const rejected = gate.filter((v) => !v.complete_thought);
const byReason = {};
for (const v of rejected) (byReason[v.reason] ??= []).push(...v.member_line_ids);
out.push('## What the gate filtered out before any judgement');
out.push('');
for (const [reason, ids] of Object.entries(byReason)) {
  out.push(`- \`${reason}\` — ${ids.length} line(s) across ${rejected.filter((v) => v.reason === reason).length} block(s)`);
}
out.push('');
out.push(`_Wall time ${(Date.now() - started) / 1000}s._`);

const report = out.join('\n');
const outPath = flag('out');
if (outPath) {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outPath), report);
  console.error(`[notepad-dry-run] wrote ${outPath}`);
} else {
  process.stdout.write(`${report}\n`);
}
