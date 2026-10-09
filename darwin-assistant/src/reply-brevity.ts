// Reply brevity dial (tree-c8e32ef9). See docs/reply-brevity/CONTRACT.md for
// the full design — this is the single source of truth for both axes
// (generation level + view preference), the wire format, and resolution.
//
// Two independent axes:
//   - reply_brevity_level (0-3): how terse the model's short version is.
//   - reply_brevity_view ('brief'|'full'): which half the cockpit shows
//     expanded by default. Pure UI, never changes what the model writes.
// Both are global settings-KV values with an optional per-thread override
// (conversations.brevity_level / brevity_view, NULL = inherit global).

import { getSetting, setSetting, getConversation } from './conversation-db.js';
import { memoryProfileForThread } from './prompt.js';

export type BrevityLevel = 0 | 1 | 2 | 3;
export type BrevityView = 'brief' | 'full';

/** HTML comment so it renders invisibly in markdown if a consumer forgets to
 *  strip it — a cosmetic miss, never a leak of scaffolding text. */
export const FULL_MARKER = '<!--JARVIS-FULL-->';

const LEVEL_SETTING_KEY = 'reply_brevity_level';
const VIEW_SETTING_KEY = 'reply_brevity_view';
const DEFAULT_LEVEL: BrevityLevel = 0;
const DEFAULT_VIEW: BrevityView = 'brief';

export function isBrevityLevel(v: unknown): v is BrevityLevel {
  return v === 0 || v === 1 || v === 2 || v === 3;
}

export function isBrevityView(v: unknown): v is BrevityView {
  return v === 'brief' || v === 'full';
}

function parseLevel(raw: string | null): BrevityLevel {
  if (raw == null) return DEFAULT_LEVEL;
  const n = Number(raw);
  return isBrevityLevel(n) ? n : DEFAULT_LEVEL;
}

function parseView(raw: string | null): BrevityView {
  return isBrevityView(raw) ? raw : DEFAULT_VIEW;
}

export function getGlobalBrevityLevel(): BrevityLevel {
  return parseLevel(getSetting(LEVEL_SETTING_KEY));
}

export function getGlobalBrevityView(): BrevityView {
  return parseView(getSetting(VIEW_SETTING_KEY));
}

/** Validates before writing; throws on a bad value — callers (the API route)
 *  must validate first and are expected to reject bad input with a 400
 *  rather than let this throw. */
export function setGlobalBrevityLevel(level: BrevityLevel): void {
  if (!isBrevityLevel(level)) throw new Error(`invalid brevity level: ${level}`);
  setSetting(LEVEL_SETTING_KEY, String(level));
}

export function setGlobalBrevityView(view: BrevityView): void {
  if (!isBrevityView(view)) throw new Error(`invalid brevity view: ${view}`);
  setSetting(VIEW_SETTING_KEY, view);
}

export interface ResolvedBrevity {
  level: BrevityLevel;
  view: BrevityView;
}

/**
 * Resolve the effective brevity settings for one thread: worker-thread hard
 * exclusion > per-thread override > global setting > default. Reuses
 * memoryProfileForThread (src/prompt.ts) for the worker-thread test so there
 * is exactly one place in the codebase that knows which threads are "worker"
 * threads — a hopper-node/unblocker worker's output is parsed by the finish
 * contract, which requires a VERDICT line to stay the first line of the
 * reply, so it must never get a prepended brief.
 */
export function resolveBrevity(externalId: string | null | undefined): ResolvedBrevity {
  if (memoryProfileForThread(externalId) === 'worker') {
    return { level: 0, view: DEFAULT_VIEW };
  }
  const conv = externalId ? getConversation(externalId) : undefined;
  const threadLevel = conv?.brevity_level;
  const threadView = conv?.brevity_view;
  const level = isBrevityLevel(threadLevel) ? threadLevel : getGlobalBrevityLevel();
  const view = isBrevityView(threadView) ? threadView : getGlobalBrevityView();
  return { level, view };
}

const BREVITY_SHAPES: Record<1 | 2 | 3, string> = {
  1: 'LIGHT: about 6-10 lines covering the outcome, what it means, and any asks.',
  2: 'TIGHT: 2-4 plain sentences, then a "## Need from you" list of what you need from Kevin (omit the heading only if there is truly nothing to ask).',
  3: 'HEADLINE: 1-2 sentences plus the asks, nothing else.',
};

/** '' at level 0 — the per-turn prefix is byte-for-byte unchanged when the
 *  dial is off. */
export function brevityPromptBlock(level: BrevityLevel): string {
  if (level === 0) return '';
  return (
    `<jarvis_reply_brevity level="${level}">\n` +
    `Write this reply in TWO parts: a short version FIRST, then the full reply.\n` +
    `1. Write the short version first. Shape: ${BREVITY_SHAPES[level]}\n` +
    `2. Immediately after it, on its own line with nothing else on that line, write exactly: ${FULL_MARKER}\n` +
    `3. After that line, write the FULL reply — this is NOT a rewrite or summary, it is the same complete reply you would have sent if this dial were off. Never put anything after the full reply.\n` +
    `The short version must stand alone: a reader who never expands the full reply must still know what happened and exactly what (if anything) you need from them. Never drop a "Need from you" item from the short version even when it also appears in the full reply.\n` +
    `</jarvis_reply_brevity>\n`
  );
}

export interface SplitBrevityReply {
  brief: string | null;
  full: string;
}

/** True when `line` is a markdown fence delimiter (``` or ~~~, optionally
 *  indented up to 3 spaces). */
function isFenceLine(line: string): boolean {
  return /^ {0,3}(```|~~~)/.test(line);
}

/** True when `line` is — ignoring surrounding whitespace — exactly the
 *  marker and nothing else. */
function isMarkerLine(line: string): boolean {
  return line.trim() === FULL_MARKER;
}

interface LineSpan {
  text: string;
  start: number;
  /** Offset of the start of the next line, i.e. past this line's terminator
   *  (or `text.length` for the last line, which has none). */
  end: number;
}

/** Scans `text` into lines without a fixed-width-terminator assumption, so
 *  CRLF (2-char) and LF/CR (1-char) line endings — and a final line with no
 *  terminator at all — all report correct offsets into the ORIGINAL string. */
function scanLines(text: string): LineSpan[] {
  const spans: LineSpan[] = [];
  const len = text.length;
  let start = 0;
  for (;;) {
    let idx = start;
    while (idx < len && text[idx] !== '\n' && text[idx] !== '\r') idx++;
    const content = text.slice(start, idx);
    let end = idx;
    if (idx < len) end = text[idx] === '\r' && text[idx + 1] === '\n' ? idx + 2 : idx + 1;
    spans.push({ text: content, start, end });
    if (idx >= len) break;
    start = end;
  }
  return spans;
}

/** Finds the first TOP-LEVEL marker line (one not inside a fenced code
 *  block). Fence-tracking is a simple open/close toggle on fence-delimiter
 *  lines — a nested or unbalanced fence can defeat it. That is a known,
 *  documented limitation (see CONTRACT.md), not a silent correctness claim. */
function findTopLevelMarkerLine(text: string): LineSpan | null {
  let inFence = false;
  for (const line of scanLines(text)) {
    if (isFenceLine(line.text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (isMarkerLine(line.text)) return line;
  }
  return null;
}

/**
 * Splits a reply into {brief, full} on the first top-level marker line.
 * Tolerates CRLF, trailing whitespace on the marker line, and blank lines on
 * either side. A brief that would be empty (marker on the very first line)
 * is reported as null, not an empty string.
 */
export function splitBrevityReply(text: string): SplitBrevityReply {
  const hit = findTopLevelMarkerLine(text);
  if (!hit) return { brief: null, full: text };
  const briefRaw = text.slice(0, hit.start).trimEnd();
  const fullRaw = text.slice(hit.end).replace(/^(\r\n|\r|\n)+/, '');
  return { brief: briefRaw.length ? briefRaw : null, full: fullRaw };
}

/** Removes exactly the first top-level marker LINE (same detection as
 *  splitBrevityReply), leaving everything else — both halves, concatenated —
 *  untouched. For consumers that want one flat reply. */
export function stripBrevityMarker(text: string): string {
  const hit = findTopLevelMarkerLine(text);
  if (!hit) return text;
  return text.slice(0, hit.start) + text.slice(hit.end);
}

/** The brief if there is one, else the whole original text untouched. */
export function briefOnly(text: string): string {
  const { brief } = splitBrevityReply(text);
  return brief ?? text;
}

/** The full half, discarding the brief (and the marker). A no-op when there
 *  is no marker. For consumers that must never see a partial/abbreviated
 *  reply — summarizers, cross-thread reads, exports, anything that feeds
 *  another model or is read without an expand affordance. */
export function fullOnly(text: string): string {
  return splitBrevityReply(text).full;
}
