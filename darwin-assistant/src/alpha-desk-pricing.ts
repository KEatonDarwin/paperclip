// ALPHA DESK — API-EQUIVALENT PRICING
//
// We pay Anthropic by SUBSCRIPTION, so none of this is a bill. It exists to give
// Kevin a sense of scale for what Alpha's delegating costs: "this chat moved about
// $12 of tokens" is a number he can reason about, where "58 million cache reads"
// is not.
//
// Prices are transcribed from Anthropic's own pricing page (PRICE_SOURCE below) on
// PRICE_AS_OF, per million tokens. Three things on that page shape this file:
//
//  1. CACHE READS ARE THEIR OWN RATE, ~10-25x cheaper than base input. They are
//     also the overwhelming majority of the volume on a long chat (Alpha's own
//     chat: 58M cache reads vs 768 input tokens), so pricing them as input would
//     overstate the cost by more than an order of magnitude.
//  2. The 1M-token context window is STANDARD PRICED on Claude 4.6 and later, so
//     the engine's `[1m]` model-id suffix is a context flag, not a price tier —
//     it is stripped, not priced. (Haiku 5.5 is the documented exception.)
//  3. Claude Haiku 5.5 alone is priced BY PROMPT LENGTH: a request whose prompt
//     exceeds 100k tokens pays ~5x, and the page is explicit that the prompt
//     length "counts all of its input tokens, including cache reads and cache
//     writes", priced per request. So that tier is decided per TURN, not per chat.
//
// What we cannot know from the DB: whether a cache write used the 5-minute or the
// 1-hour TTL (they differ, 1h being 1.6x). `costUsd` returns BOTH — `usd` on the
// 5-minute rate (the default TTL) and `usd_max` on the 1-hour rate — so the page
// can show the honest figure and its ceiling instead of picking one silently.

export const PRICE_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
export const PRICE_AS_OF = '2026-10-15';
/** Haiku 5.5's per-request prompt-length tier boundary, in tokens. */
export const HAIKU_LONG_PROMPT_TOKENS = 100_000;

/** USD per MILLION tokens. */
export interface ModelPrice {
  label: string;
  input: number;
  output: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
}

/**
 * Keyed by the model id with the `claude-` prefix stripped. Verbatim from the
 * pricing page — do not "round" these; a wrong rate here is a wrong number on
 * Kevin's screen with no way to tell from the page that it is wrong.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'fable-5-1':  { label: 'Fable 5.1',  input: 10, output: 50, cache_write_5m: 12.5, cache_write_1h: 20, cache_read: 0.25 },
  'fable-5':    { label: 'Fable 5',    input: 10, output: 50, cache_write_5m: 12.5, cache_write_1h: 20, cache_read: 1 },
  'mythos-5-1': { label: 'Mythos 5.1', input: 10, output: 50, cache_write_5m: 12.5, cache_write_1h: 20, cache_read: 0.25 },
  'mythos-5':   { label: 'Mythos 5',   input: 10, output: 50, cache_write_5m: 12.5, cache_write_1h: 20, cache_read: 1 },

  'opus-5-5': { label: 'Opus 5.5', input: 4, output: 20, cache_write_5m: 5,    cache_write_1h: 8,  cache_read: 0.20 },
  'opus-5':   { label: 'Opus 5',   input: 5, output: 25, cache_write_5m: 6.25, cache_write_1h: 10, cache_read: 0.50 },
  'opus-4-8': { label: 'Opus 4.8', input: 5, output: 25, cache_write_5m: 6.25, cache_write_1h: 10, cache_read: 0.50 },
  'opus-4-7': { label: 'Opus 4.7', input: 5, output: 25, cache_write_5m: 6.25, cache_write_1h: 10, cache_read: 0.50 },
  'opus-4-6': { label: 'Opus 4.6', input: 5, output: 25, cache_write_5m: 6.25, cache_write_1h: 10, cache_read: 0.50 },
  'opus-4-5': { label: 'Opus 4.5', input: 5, output: 25, cache_write_5m: 6.25, cache_write_1h: 10, cache_read: 0.50 },

  'sonnet-5-5': { label: 'Sonnet 5.5', input: 2, output: 10, cache_write_5m: 2.5,  cache_write_1h: 4, cache_read: 0.10 },
  'sonnet-5':   { label: 'Sonnet 5',   input: 2, output: 10, cache_write_5m: 2.5,  cache_write_1h: 4, cache_read: 0.20 },
  'sonnet-4-6': { label: 'Sonnet 4.6', input: 3, output: 15, cache_write_5m: 3.75, cache_write_1h: 6, cache_read: 0.30 },
  'sonnet-4-5': { label: 'Sonnet 4.5', input: 3, output: 15, cache_write_5m: 3.75, cache_write_1h: 6, cache_read: 0.30 },

  // Haiku 5.5's SHORT-prompt tier. Prompts over 100k use the long tier below.
  'haiku-5-5': { label: 'Haiku 5.5', input: 0.10, output: 0.50, cache_write_5m: 0.125, cache_write_1h: 0.20, cache_read: 0.01 },
  'haiku-4-5': { label: 'Haiku 4.5', input: 1, output: 5, cache_write_5m: 1.25, cache_write_1h: 2, cache_read: 0.10 },
};

/** Haiku 5.5, for a request whose prompt exceeded HAIKU_LONG_PROMPT_TOKENS. */
export const HAIKU_55_LONG: ModelPrice = {
  label: 'Haiku 5.5 (prompt over 100k)',
  input: 0.50, output: 2.50, cache_write_5m: 0.625, cache_write_1h: 1, cache_read: 0.05,
};

/**
 * Model id as recorded in `turns.model` → the key in MODEL_PRICES.
 * Handles the three shapes the live DB actually contains:
 *   claude-opus-5-5              → opus-5-5
 *   claude-opus-5[1m]            → opus-5     (1M context is standard priced)
 *   claude-haiku-4-5-20251001    → haiku-4-5  (dated snapshot id)
 */
export function priceSlug(model: string | null | undefined): string | null {
  if (!model) return null;
  let s = String(model).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/\[[^\]]*\]/g, '');          // [1m] and any other bracketed flag
  s = s.replace(/^claude-/, '');
  s = s.replace(/-\d{8}$/, '');              // -20251001 snapshot date
  s = s.replace(/-(latest|preview)$/, '');
  s = s.replace(/-+$/, '');
  return s || null;
}

export interface TurnTokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

/** Does one turn's prompt cross Haiku 5.5's tier boundary? */
export function isLongPrompt(t: TurnTokens): boolean {
  return t.input_tokens + t.cache_read_tokens + t.cache_write_tokens > HAIKU_LONG_PROMPT_TOKENS;
}

/**
 * Prices ONE turn, or a GROUP of turns that share a model and a tier. Returns
 * null when the model is unknown to the table — the caller must surface that as
 * unpriced rather than quietly adding $0, or the headline silently understates
 * by however much that model cost.
 *
 * `longPrompt` only matters for Haiku 5.5, whose tier is per request. Pass it
 * explicitly when pricing an AGGREGATE: summed tokens cannot tell you whether
 * they came from one 200k request or forty 5k ones, so a group of turns must
 * carry the tier it was grouped by. Omitted, it is derived from `t`, which is
 * correct for a single turn and only for a single turn.
 */
export function priceFor(
  model: string | null | undefined,
  t: TurnTokens,
  longPrompt?: boolean,
): ModelPrice | null {
  const slug = priceSlug(model);
  if (!slug) return null;
  if (slug === 'haiku-5-5') {
    return (longPrompt ?? isLongPrompt(t)) ? HAIKU_55_LONG : MODEL_PRICES['haiku-5-5'];
  }
  return MODEL_PRICES[slug] ?? null;
}

export interface TurnCost {
  /** 5-minute cache-write rate — the default TTL, and the headline figure. */
  usd: number;
  /** Same tokens with 1-hour cache writes: the ceiling, since the TTL is not recorded. */
  usd_max: number;
}

const ZERO: TurnCost = { usd: 0, usd_max: 0 };

/** Cost of a turn's (or a same-model, same-tier group's) tokens; null if unpriced. */
export function costOf(
  model: string | null | undefined,
  t: TurnTokens,
  longPrompt?: boolean,
): TurnCost | null {
  const p = priceFor(model, t, longPrompt);
  if (!p) return null;
  const base =
    (t.input_tokens * p.input + t.output_tokens * p.output + t.cache_read_tokens * p.cache_read) / 1_000_000;
  return {
    usd: base + (t.cache_write_tokens * p.cache_write_5m) / 1_000_000,
    usd_max: base + (t.cache_write_tokens * p.cache_write_1h) / 1_000_000,
  };
}

export function addCost(a: TurnCost, b: TurnCost): TurnCost {
  return { usd: a.usd + b.usd, usd_max: a.usd_max + b.usd_max };
}

export function zeroCost(): TurnCost {
  return { ...ZERO };
}
