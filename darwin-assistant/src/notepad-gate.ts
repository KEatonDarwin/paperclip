import { getSetting } from './conversation-db.js';
import { normalizeLineText, unscannedLines } from './notepad.js';
import { isScratchEnv, scratchReason } from './sim-guard.js';

// The cheap gate (docs/notepad/LINE-IDENTITY.md §5, node #61's "settle-and-
// reread pass" / "the cheap gate: did a complete thought just land?"). This
// module owns the DETERMINISTIC half only — disposing of lines that are
// obviously not worth a model's attention (blank, a markdown marker with no
// words, a bare URL, too short to be a thought) before anything gets near a
// claude spawn, plus the guard the NEXT node (the model call itself) must
// call before it dares spawn one.
//
// This node spawns NO model. It answers only "which of unscannedLines(day)'s
// candidates are even worth a second look" -- it makes no judgement about
// importance, urgency, or what kind of line something is.

const DEFAULT_MIN_CHARS = 12;

/** Why a candidate line was disposed of before ever reaching a model. */
export type GateSkipReason = 'blank' | 'marker_only' | 'url_only' | 'too_short' | 'not_a_candidate';

/** A line that survived the deterministic prefilter -- worth a second look. */
export interface GateCandidate {
  line_id: number;
  idx: number;
  text: string;
  kind: 'first_look' | 'reconcile';
  action_ref: string | null;
}

export interface PrefilterResult {
  candidates: GateCandidate[];
  disposed: Array<{ line_id: number | null; text: string; reason: GateSkipReason }>;
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
 * Deterministic prefilter over unscannedLines(day) -- the ONLY source of
 * candidates (per LINE-IDENTITY.md, this is the ledger's contract). A line
 * the ledger did not return is not a candidate at all: 'not_a_candidate' is
 * reserved for that case so a caller that hands in arbitrary text is
 * disposed of rather than silently treated as real ledger output.
 *
 * Zero model calls, zero network, no randomness -- reads the DB and the
 * settings-KV min-chars threshold (re-read on every call, never cached, so a
 * settings change takes effect without a restart) and nothing else.
 */
export function prefilterGateCandidates(day: string): PrefilterResult {
  const minChars = minCharsSetting();
  const lines = unscannedLines(day);

  const candidates: GateCandidate[] = [];
  const disposed: PrefilterResult['disposed'] = [];

  for (const line of lines) {
    const reason = classifyGateSkip(line.text, minChars);
    if (reason) {
      disposed.push({ line_id: line.line_id, text: line.text, reason });
      continue;
    }
    candidates.push({
      line_id: line.line_id,
      idx: line.idx,
      text: line.text,
      kind: line.kind,
      action_ref: line.action_ref,
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
