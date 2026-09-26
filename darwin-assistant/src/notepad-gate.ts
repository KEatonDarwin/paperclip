import { execFile } from 'node:child_process';
import { getSetting } from './conversation-db.js';
import { getNotepadDay, normalizeLineText, unscannedLines } from './notepad.js';
import { parseNotepadBlocks } from './notepad-blocks.js';
import { isScratchEnv, scratchReason } from './sim-guard.js';
import { extractJsonObject } from './tools/ux-reviewer/vision-critique.js';

// The cheap gate (docs/notepad/LINE-IDENTITY.md §5, node #61's "settle-and-
// reread pass" / "the cheap gate: did a complete thought just land?").
// Node #942 moved this from a per-LINE judgement to a per-BLOCK one, per
// Kevin's own note-taking format (docs/notepad/BLOCKS.md): "never look at
// the line on its own, look at the entire block." This module owns the
// DETERMINISTIC half only — disposing of BLOCKS that are obviously not
// worth a model's attention (every member line blank, a markdown marker
// with no words, a bare URL, too short to be a thought) before anything
// gets near a claude spawn, plus the guard the NEXT node (the model call
// itself) must call before it dares spawn one.
//
// This node spawns NO model. It answers only "which blocks touching
// unscannedLines(day)'s candidates are even worth a second look" -- it
// makes no judgement about importance, urgency, or what kind of block
// something is. Per BLOCKS.md's binding design decision, storage/line-
// identity/the ledger/carry-forward all stay PER-LINE — unscannedLines()
// itself is untouched; this module only groups its output by block.

const DEFAULT_MIN_CHARS = 12;

/** Why a member line was disposable before ever reaching a model. */
export type GateSkipReason = 'blank' | 'marker_only' | 'url_only' | 'too_short' | 'not_a_candidate';

/**
 * A block that survived the deterministic prefilter -- worth a second look.
 * `block_id` is the block's identity for gate purposes: the headline's
 * line_id, or (for a headline:null lead-in block) its first member's
 * line_id -- there is always at least one member, so this is always defined.
 */
export interface GateBlockCandidate {
  block_id: number;
  headline_line_id: number | null;
  headline: string | null;
  member_line_ids: number[];
  text: string; // the block rendered verbatim, one "[line_id N] " line per member
}

export interface PrefilterResult {
  candidates: GateBlockCandidate[];
  disposed: Array<{
    block_id: number;
    headline_line_id: number | null;
    headline: string | null;
    member_line_ids: number[];
    /** classifyGateSkip's verdict for each member, same order as member_line_ids -- every entry is non-null, since a block only disposes when EVERY member is disposable. */
    member_reasons: GateSkipReason[];
  }>;
  passed_count: number;
  disposed_count: number;
}

// A markdown header (#, ##, ...), an underline/thematic-break rule (--- or
// ===, three or more), or a bare bullet/ordinal marker with nothing after
// it. Matched against the ALREADY-NORMALIZED text (bullet already stripped
// by normalizeLineText for the plain "-"/"*"/"•" case), so this only needs
// to additionally catch headers, rules, and bare ordinals ("1.", "2)").
const MARKER_ONLY_RE = /^(#{1,6}|-{3,}|={3,}|\d+[.)])$/;

// The whole trimmed line is a single URL and nothing else.
const URL_ONLY_RE = /^(https?:\/\/|www\.)\S+$/i;

function minCharsSetting(): number {
  const raw = getSetting('notepad_gate_min_chars');
  const parsed = raw === null ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIN_CHARS;
}

/**
 * Classify one candidate's normalized text as disposable, or return null if
 * it should pass through to the model. Exported separately from the batch
 * function so a check script can exercise the classification directly
 * without needing a populated unscannedLines() ledger.
 */
export function classifyGateSkip(text: string, minChars: number): GateSkipReason | null {
  // Marker detection runs against the trimmed-but-NOT-bullet-stripped text.
  // normalizeLineText() strips a single leading bullet character
  // ('-'/'*'/'•') before anything else -- for a genuine thematic-break
  // line ("---") that eats the first dash and leaves "--", which no longer
  // matches the {3,} marker pattern. Testing the trimmed text here (no
  // interior whitespace is ever valid inside a bare marker anyway, so
  // trim-only is exactly as strict as the fully-normalized string for this
  // check) keeps "---"/"===" recognized as marker_only as documented above.
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'blank';
  if (MARKER_ONLY_RE.test(trimmed)) return 'marker_only';
  const normalized = normalizeLineText(text);
  if (normalized.length === 0) return 'blank';
  if (URL_ONLY_RE.test(normalized)) return 'url_only';
  if (normalized.length < minChars) return 'too_short';
  return null;
}

/**
 * Is `lineId` actually one of `day`'s current candidates (per
 * unscannedLines(day) -- the ONLY source, per LINE-IDENTITY.md)? Returns
 * null when it is a real candidate, or 'not_a_candidate' when it is not --
 * exported separately (rather than folded invisibly into
 * prefilterGateCandidates, which by construction only ever iterates real
 * candidates) so a check script can prove the disposal path directly: hand
 * it an arbitrary/stale line id and assert it comes back disposed, not
 * silently accepted.
 */
export function classifyCandidateOrigin(day: string, lineId: number): GateSkipReason | null {
  const isCandidate = unscannedLines(day).some((line) => line.line_id === lineId);
  return isCandidate ? null : 'not_a_candidate';
}

/**
 * Deterministic prefilter, now over BLOCKS rather than individual lines.
 *
 * unscannedLines(day) is still the ONLY source of "what's a candidate at
 * all" (per LINE-IDENTITY.md, the ledger's contract is untouched) -- a block
 * only enters consideration here if at least one of its member lines
 * surfaces via unscannedLines(day). Once a block qualifies, EVERY member
 * line of that block (not just the surfaced ones -- the model needs the
 * whole topic, including lines it already judged) is classified with
 * classifyGateSkip. The block is disposed only if every single member is
 * disposable; if even one member carries real content, the WHOLE block goes
 * to the model, junk members and all, because Kevin's own rule is "never
 * look at the line on its own."
 *
 * Zero model calls, zero network, no randomness -- reads the DB and the
 * settings-KV min-chars threshold (re-read on every call, never cached, so a
 * settings change takes effect without a restart) and nothing else.
 */
export function prefilterGateCandidates(day: string): PrefilterResult {
  const minChars = minCharsSetting();
  const { lines: allLines } = getNotepadDay(day);
  const blocks = parseNotepadBlocks(allLines);
  const textById = new Map(allLines.map((l) => [l.id, l.text]));
  const surfacedLineIds = new Set(unscannedLines(day).map((l) => l.line_id));

  const candidates: GateBlockCandidate[] = [];
  const disposed: PrefilterResult['disposed'] = [];

  for (const block of blocks) {
    if (!block.member_line_ids.some((id) => surfacedLineIds.has(id))) continue; // not a candidate block

    const blockId = block.headline_line_id ?? block.member_line_ids[0];
    const memberReasons = block.member_line_ids.map((id) => classifyGateSkip(textById.get(id) ?? '', minChars));

    if (memberReasons.every((r): r is GateSkipReason => r !== null)) {
      disposed.push({
        block_id: blockId,
        headline_line_id: block.headline_line_id,
        headline: block.headline,
        member_line_ids: block.member_line_ids,
        member_reasons: memberReasons as GateSkipReason[],
      });
      continue;
    }

    candidates.push({
      block_id: blockId,
      headline_line_id: block.headline_line_id,
      headline: block.headline,
      member_line_ids: block.member_line_ids,
      text: block.text,
    });
  }

  return {
    candidates,
    disposed,
    passed_count: candidates.length,
    disposed_count: disposed.length,
  };
}

/**
 * Call immediately before spawning a model CLI for a notepad-gate judgement.
 * Throws loudly (naming the offending JARVIS_DB_PATH/JARVIS_SIM value) when
 * running in a scratch environment, mirroring sim-guard.ts's
 * refuseModelTurnInScratch contract but as a hard assertion rather than a
 * boolean check -- this call site is meant to make spawning impossible from
 * a sim, not merely discouraged.
 */
export function assertModelSpawnAllowed(): void {
  if (!isScratchEnv()) return;
  throw new Error(
    `[notepad-gate] refused to spawn a model for notepad judgement: running in a scratch ` +
      `environment (${scratchReason()}). A sim must stub the model call rather than reaching ` +
      `this function with a real spawn. Set JARVIS_SIM=0 and point JARVIS_DB_PATH at the live ` +
      `jarvis.db only if you genuinely intend to spend tokens.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// The model half of the gate (§5's node #61 "cheap gate" continued): for
// each BLOCK that survived the deterministic prefilter above, answer
// EXACTLY one question -- did a complete TOPIC just land in this block?
// Nothing about importance, urgency, or what kind of block it is -- that
// judgement belongs to node #62, not here.
// ─────────────────────────────────────────────────────────────────────────

const CLAUDE_BIN = process.env.UX_REVIEWER_CLAUDE_BIN || 'claude';
const DEFAULT_GATE_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_GATE_TIMEOUT_MS = 20 * 1000;

/** Why a gate verdict has the value it does. */
export type GateVerdictReason = 'model' | 'prefilter' | 'fallback';

/** One block's gate verdict: did a complete topic just land here? */
export interface GateVerdict {
  block_id: number;
  headline_line_id: number | null;
  member_line_ids: number[];
  complete_thought: boolean;
  reason: GateVerdictReason;
}

function gateModelSetting(): string {
  const raw = getSetting('notepad_gate_model');
  return raw && raw.trim() ? raw.trim() : DEFAULT_GATE_MODEL;
}

/**
 * The real CLI spawn -- NO API KEYS (deletes ANTHROPIC_API_KEY from the
 * child env), same `claude -p <prompt> --output-format json --model <id>`
 * shape as jarvis-brief.ts/smart-todos-decompose.ts/workbench.ts. Re-asserts
 * the guard defensively at the actual spawn site (belt-and-suspenders --
 * runNotepadGate below is what actually gates whether this function is ever
 * reached at all, since that check has to happen OUTSIDE its own try/catch
 * to propagate loudly rather than becoming a per-line fallback).
 */
function defaultRunOneShot(prompt: string): Promise<string> {
  assertModelSpawnAllowed();
  const model = gateModelSetting();
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return new Promise((resolve, reject) => {
    execFile(
      CLAUDE_BIN,
      ['-p', prompt, '--output-format', 'json', '--model', model],
      { timeout: DEFAULT_GATE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error(`notepad gate call failed: ${err.message}${stderr ? ` | ${stderr.slice(0, 300)}` : ''}`));
          return;
        }
        try {
          const envelope = JSON.parse(stdout.trim()) as { result?: string };
          resolve(typeof envelope.result === 'string' ? envelope.result : stdout);
        } catch {
          resolve(stdout);
        }
      },
    );
  });
}

/** Reject `promise` with a timeout error after `ms`, without leaking the timer. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`notepad gate call timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function buildGatePrompt(candidates: GateBlockCandidate[]): string {
  const blocks = candidates
    .map((c) => {
      const headlineLine = c.headline !== null ? JSON.stringify(c.headline) : '(none -- a leading fragment, no headline yet)';
      return `- block_id ${c.block_id} -- headline: ${headlineLine}\n${c.text}`;
    })
    .join('\n\n');
  return [
    'You are a fast, cheap filter for a notepad app. Kevin writes in topic BLOCKS,',
    'not isolated lines: a headline on its own line, with everything he wrote under',
    'it indented beneath it. For each block below, answer EXACTLY ONE question: is',
    'there a COMPLETE TOPIC here, as opposed to a fragment that is still being typed',
    'or trails off mid-thought? Judge the WHOLE block, never a single line in it.',
    '',
    'This is NOT a judgement of importance, urgency, or what kind of block it is --',
    'a grocery list block and a business-critical decision block both count as',
    'complete if they read as a finished thought, even a short one. A block that',
    'trails off ("and then we should" with nothing more, or a bare headline with',
    'nothing useful under it yet) is NOT complete.',
    '',
    '=== BLOCKS ===',
    blocks,
    '=== END BLOCKS ===',
    '',
    'Return ONLY a JSON object -- no markdown fences, no prose before or after --',
    'with EXACTLY this shape, one entry per block_id above, in any order:',
    '{"verdicts": [{"block_id": 123, "complete_thought": true}, {"block_id": 456, "complete_thought": false}]}',
  ].join('\n');
}

/**
 * Parse the model's raw response into a map of block_id -> complete_thought.
 * Defensive by construction: an unparseable response, a non-object/non-array
 * shape, a malformed entry, or an entry whose block_id was never one of the
 * candidates we actually asked about all get SKIPPED rather than trusted --
 * they simply leave that block_id absent from the returned map. The caller
 * (runNotepadGate) treats "absent from the map" as reason:'fallback' for
 * that one block, which is what makes both "the whole response was garbage"
 * and "the response omitted one block" fail the exact same safe way.
 */
function parseGateResponse(raw: string, candidates: GateBlockCandidate[]): Map<number, boolean> {
  const map = new Map<number, boolean>();
  const validIds = new Set(candidates.map((c) => c.block_id));
  const parsed = extractJsonObject(raw) as { verdicts?: unknown } | null;
  const verdicts = parsed && Array.isArray(parsed.verdicts) ? parsed.verdicts : null;
  if (!verdicts) return map;
  for (const entry of verdicts) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const blockId = typeof e.block_id === 'number' ? e.block_id : NaN;
    const completeThought = typeof e.complete_thought === 'boolean' ? e.complete_thought : null;
    if (!Number.isFinite(blockId) || completeThought === null) continue; // malformed entry -- ignored
    if (!validIds.has(blockId)) continue; // an id we never asked about -- ignored, never trusted
    map.set(blockId, completeThought);
  }
  return map;
}

/**
 * Run the model half of the gate for `day`: prefilter first (disposed lines
 * never reach the model -- returned here as complete_thought:false,
 * reason:'prefilter' so a caller sees the full picture in one place rather
 * than having to cross-reference prefilterGateCandidates separately), then
 * ONE batched model call over every surviving candidate.
 *
 * Fails toward SILENCE, never noise: any failure mode on the model call --
 * spawn error, timeout, non-JSON, wrong shape, an omitted block_id -- resolves
 * that block to complete_thought:false, reason:'fallback'. It never throws
 * for a model-call failure. A missed thought costs Kevin one block he can
 * re-type; a false yes wakes the whole re-read-and-act chain on a fragment
 * and trains him to ignore it, which is the worse failure by far.
 *
 * The ONE exception to "never throws": opts.runOneShot is the injection seam
 * a caller (a sim) uses to stub the model call entirely, so it never touches
 * the real CLI and never needs assertModelSpawnAllowed() to pass. Without a
 * stub, this function calls assertModelSpawnAllowed() itself -- deliberately
 * BEFORE the try/catch below, not merely inside defaultRunOneShot -- so that
 * under a scratch DB it throws loudly and synchronously OUT of this
 * function, rather than being caught and silently downgraded to an
 * all-fallback verdict that would read as a passing sim. A sim that forgot
 * to stub this seam must fail loudly, not quietly.
 */
export async function runNotepadGate(
  day: string,
  opts?: { runOneShot?: (prompt: string) => Promise<string>; timeoutMs?: number },
): Promise<GateVerdict[]> {
  const { candidates, disposed } = prefilterGateCandidates(day);
  const verdicts: GateVerdict[] = disposed.map((d) => ({
    block_id: d.block_id,
    headline_line_id: d.headline_line_id,
    member_line_ids: d.member_line_ids,
    complete_thought: false,
    reason: 'prefilter' as const,
  }));

  if (candidates.length === 0) return verdicts;

  const usingDefaultSpawn = !opts?.runOneShot;
  if (usingDefaultSpawn) {
    // Outside the try/catch on purpose -- see the doc comment above.
    assertModelSpawnAllowed();
  }
  const runOneShot = opts?.runOneShot ?? defaultRunOneShot;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const prompt = buildGatePrompt(candidates);

  let modelVerdicts: Map<number, boolean>;
  try {
    const raw = await withTimeout(runOneShot(prompt), timeoutMs);
    modelVerdicts = parseGateResponse(raw, candidates);
  } catch {
    // Spawn failure, non-zero exit, or a timeout -- every candidate in this
    // batch falls back below.
    modelVerdicts = new Map();
  }

  for (const c of candidates) {
    const verdict = modelVerdicts.get(c.block_id);
    verdicts.push(
      verdict === undefined
        ? { block_id: c.block_id, headline_line_id: c.headline_line_id, member_line_ids: c.member_line_ids, complete_thought: false, reason: 'fallback' }
        : { block_id: c.block_id, headline_line_id: c.headline_line_id, member_line_ids: c.member_line_ids, complete_thought: verdict, reason: 'model' },
    );
  }

  return verdicts;
}
