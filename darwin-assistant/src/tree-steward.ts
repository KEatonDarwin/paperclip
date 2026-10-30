// tree-steward.ts — the Tree Steward's pure decision core.
//
// PURE BY CONTRACT. This module takes a single plain-data `StewardInput` and
// returns a `StewardDecision`. It is deliberately:
//   - synchronous (no Promises, no async),
//   - importless of any I/O — no `fs`, `path`, `better-sqlite3`, `node-fetch`,
//     no `./db`, no `fetch(`, no `process.env`, no `console.*`, and nothing
//     whose behaviour depends on `Date.now()` or any ambient clock,
//   - safe to call from anywhere (a worker, a cue, a test, the engine).
//
// WHY the purity matters: this is the single place that decides whether a stuck
// tree's `blocked_question` may be auto-answered or must be parked for Kevin. It
// mirrors the `case 'unblock':` rule in goals-autopilot.ts (answer only what the
// worker itself already recommended; park everything that is Kevin's call) and
// must be trivially testable and side-effect-free so a future edit cannot
// quietly turn a decision function into something that touches the DB or the
// network. If you need live state (settings, the cap value, the node row), read
// it in the CALLER and hand it in through `StewardInput` — do NOT reach for it
// here.

export type StewardAction = 'auto_answer' | 'park_card' | 'noop';

export interface StewardInput {
  nodeId: number;
  treeId: string | null;
  status: string;
  title: string;
  question: string | null;
  result: string | null;
  goalTitle?: string | null;
  nodeNotes?: string | null;
  /** How many auto-answers this run has already produced; see CAP below. */
  priorAutoAnswers?: number;
}

export interface StewardDecision {
  action: StewardAction;
  /** The decision sentence handed to the node's /answer endpoint. Non-null
   *  only for `auto_answer`; always null for `park_card` / `noop`. */
  answer: string | null;
  /** Human-readable reason naming the rule that fired. Always set. */
  reason: string;
  /** Machine tag for the rule/branch that fired (see the categories below). */
  category: string;
  /** The recommendation text the steward adopted, trimmed; null unless an
   *  `auto_answer` adopted one. */
  recommendation: string | null;
  confidence: 'high' | 'low';
}

/**
 * The auto-answer cap. One tree must not be able to drive an unbounded run of
 * auto-answers; past this many prior auto-answers in a run the steward parks
 * regardless of the recommendation. The live value is read from settings by a
 * later node and handed in via `priorAutoAnswers`; this constant is only the
 * default threshold the function honours when nothing else is said.
 */
export const DEFAULT_AUTO_ANSWER_CAP = 3;

// ---------------------------------------------------------------------------
// Rule 1 & 2 — gates
// ---------------------------------------------------------------------------

/** Rule 1: the steward only ever touches a `blocked_question`. A plain
 *  `blocked` node is the Smart Unblocker's job, never the steward's. */
export function isBlockedQuestion(status: string): boolean {
  return (status ?? '').trim() === 'blocked_question';
}

/** Rule 2: there must be an actual question to classify. */
export function hasQuestionText(question: string | null): boolean {
  return typeof question === 'string' && question.trim().length > 0;
}

// ---------------------------------------------------------------------------
// Rule 3 — the escalation bar (hard limiter; always Kevin's call)
// ---------------------------------------------------------------------------

export type EscalationCategory =
  | 'escalation_production'
  | 'escalation_destructive'
  | 'escalation_merge_main'
  | 'escalation_external'
  | 'escalation_money';

/**
 * Detect, case-insensitively over the combined question+result text, whether
 * the question touches the fixed escalation bar. Returns the specific category
 * that fired, or null. Groups are checked in the spec's order (a→e); the first
 * hit wins so `category` names the most serious matched concern.
 */
export function detectEscalation(text: string): EscalationCategory | null {
  const h = (text ?? '').toLowerCase();
  if (!h.trim()) return null;

  // (a) live production servers, files or databases
  const production: RegExp[] = [
    /\bproduction\b/,
    /\bprod\s+(db|database|server|checkout|hub|data)\b/,
    /\blive\s+(production|server|checkout|hub|database|db|data|site)\b/,
    /\bthe\s+live\s+hub\b/,
    /tdhmike_dhub/,
    /kuojrvfdjjqhqyvkuiam/,
    /jarvis\.service/,
    /\brestart\b[^.\n]{0,24}\b(jarvis|service)\b/,
    /\bdeploy(ing|ment)?\b/,
  ];
  if (production.some((re) => re.test(h))) return 'escalation_production';

  // (b) destructive / irreversible operations
  const destructive: RegExp[] = [
    /\bdrop\b/,
    /\bdelete\b/,
    /\btruncate\b/,
    /\bwipe\b/,
    /\bforce[-\s]?push\b/,
    /\brevoke\b/,
    /\bdelete\s+(the\s+|a\s+)?branch\b/,
  ];
  if (destructive.some((re) => re.test(h))) return 'escalation_destructive';

  // (c) merging to main/master
  if (/\bmerg(e|ing)\b[^.\n]{0,40}\b(main|master)\b/.test(h) || /\bmerge\s+to\s+(main|master)\b/.test(h)) {
    return 'escalation_merge_main';
  }

  // (d) external-facing action under Kevin's identity
  const external: RegExp[] = [
    /\bslack\b/,
    /\bemail\b/,
    /\bpublic\s+(pr|pull\s+request|post)\b/,
    /\bpull\s+request\s+(to|against)\b/,
    /\b(to|message|notify|ping|dm)\s+mike\b/,
    /\bmike\s+or\s+anyone\b/,
    /\bpublish\b/,
    /\bpost\s+(to|publicly|on)\b/,
  ];
  if (external.some((re) => re.test(h))) return 'escalation_external';

  // (e) money
  const money: RegExp[] = [
    /\bsubscri(be|ption)\b/,
    /\bcontract\b/,
    /\bpurchas(e|ing)\b/,
    /\bspend\b/,
    /\bbuy\b/,
    /\bpaid\s+plan\b/,
    /\bpayment\b/,
    /\$\s?\d/,
  ];
  if (money.some((re) => re.test(h))) return 'escalation_money';

  return null;
}

// ---------------------------------------------------------------------------
// Rule 4 — Kevin's standing test/DB fence (anything beyond a pure read)
// ---------------------------------------------------------------------------

/**
 * True when the question is test- or database-related beyond a pure read:
 * running any test suite, a migration, a seed, a write/update/insert/delete
 * against any database, or granting a privilege. Destructive DB verbs
 * (drop/delete/truncate) are already caught upstream by the escalation bar;
 * this covers the rest of the fence.
 */
export function isTestOrDbBeyondRead(text: string): boolean {
  const h = (text ?? '').toLowerCase();
  if (!h.trim()) return false;
  const patterns: RegExp[] = [
    /\btest\s+suite\b/,
    /\brun\s+(the\s+)?(unit\s+|integration\s+)?tests?\b/,
    /\b(npm|yarn|pnpm|bun)\s+(run\s+)?test\b/,
    /\bcomposer\s+test\b/,
    /\bphpunit\b/,
    /\bpest\b/,
    /\bvitest\b/,
    /\bjest\b/,
    /\bmocha\b/,
    /\bartisan\s+(test|migrate|db:)/,
    /\bmigrat(e|ion|ions)\b/,
    /\bdb:(seed|wipe|migrate)\b/,
    /\bseed(ing|ed)?\s+(the\s+)?(db|database|data)\b/,
    /\binsert\s+into\b/,
    /\bupdate\b[^.\n]{0,40}\bset\b/,
    /\bgrant\b[^.\n]{0,24}\b(privilege|privileges|on|to)\b/,
    /\bwrit(e|ing)\s+(to\s+)?(the\s+)?(db|database)\b/,
  ];
  return patterns.some((re) => re.test(h));
}

// ---------------------------------------------------------------------------
// Rule 5 — adopt the worker's own recommendation
// ---------------------------------------------------------------------------

/** Trim text to its first `maxSentences` sentences or `maxChars`, whichever is
 *  shorter. Pure string work; no clock, no locale surprises. */
export function clampToSentences(text: string, maxSentences = 2, maxChars = 400): string {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return '';
  const sentences = trimmed.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
  let out = trimmed;
  if (sentences && sentences.length > maxSentences) {
    out = sentences.slice(0, maxSentences).join('').trim();
  }
  if (out.length > maxChars) out = out.slice(0, maxChars).trim();
  return out;
}

/**
 * Pull the worker's own recommendation out of its text, if any. Recognises the
 * shapes workers actually write:
 *   - a line labelled RECOMMENDATION: / RECOMMEND: / MY RECOMMENDATION:
 *     (case-insensitive, optional leading markdown bullet `*`, `-` or `#`),
 *   - the softer `Default:` / `Proposed default:` labels,
 *   - a sentence opening `I recommend` / `I would recommend` /
 *     `My recommendation is` / `I suggest`.
 * Returns the recommendation text (clamped to 2 sentences / 400 chars) plus
 * whether it came from a strong, explicit RECOMMENDATION-style label (→ high
 * confidence) or a softer match (→ low confidence). Returns null when none
 * matched.
 */
export function extractRecommendation(text: string): { text: string; strong: boolean } | null {
  const raw = text ?? '';
  if (!raw.trim()) return null;

  // Strong: an explicit RECOMMENDATION-style label at the start of a line.
  const strongLabel = raw.match(
    /^[ \t]*[-*#>]*[ \t]*(?:my[ \t]+recommendation|recommendation|recommend)[ \t]*:[ \t]*(.+)$/im,
  );
  if (strongLabel && strongLabel[1].trim()) {
    return { text: clampToSentences(strongLabel[1]), strong: true };
  }

  // Soft: a `Default:` / `Proposed default:` label at the start of a line.
  const defaultLabel = raw.match(/^[ \t]*[-*#>]*[ \t]*(?:proposed[ \t]+)?default[ \t]*:[ \t]*(.+)$/im);
  if (defaultLabel && defaultLabel[1].trim()) {
    return { text: clampToSentences(defaultLabel[1]), strong: false };
  }

  // Soft: a recommendation sentence. Capture from the opener to end of text,
  // then clamp to the first couple of sentences.
  const sentence = raw.match(/(?:^|[.!?\n]\s*)((?:i[ \t]+would[ \t]+recommend|i[ \t]+recommend|my[ \t]+recommendation[ \t]+is|i[ \t]+suggest)\b[\s\S]*)/i);
  if (sentence && sentence[1].trim()) {
    return { text: clampToSentences(sentence[1]), strong: false };
  }

  return null;
}

// ---------------------------------------------------------------------------
// The decision table
// ---------------------------------------------------------------------------

/**
 * Classify a stuck node's `blocked_question`. Rules are evaluated in the exact
 * order below; the first that fires decides.
 *
 *  1. noop            — not a blocked_question (steward never touches it).
 *  2. noop            — empty question (nothing to classify).
 *  3. park_card       — touches the escalation bar (category names which one).
 *  4. park_card       — test/DB beyond a pure read (fence_test_or_db).
 *  (cap)              — >= DEFAULT_AUTO_ANSWER_CAP prior auto-answers this run
 *                       forces park_card (cap_reached), overriding rules 5-6.
 *  5. auto_answer     — the worker stated its own recommendation; adopt it.
 *  6. park_card       — a real product/spec call with no recommendation.
 */
export function classifyBlockedQuestion(input: StewardInput): StewardDecision {
  const question = input.question ?? '';
  const result = input.result ?? '';
  const haystack = `${question}\n${result}`;

  // Rule 1 — only blocked_question is ours.
  if (!isBlockedQuestion(input.status)) {
    return {
      action: 'noop',
      answer: null,
      reason: `Rule 1: status is "${input.status}", not blocked_question — the steward only classifies questions; a plain blocked node is the Smart Unblocker's job.`,
      category: 'not_a_question',
      recommendation: null,
      confidence: 'high',
    };
  }

  // Rule 2 — there must be a question to classify.
  if (!hasQuestionText(input.question)) {
    return {
      action: 'noop',
      answer: null,
      reason: 'Rule 2: blocked_question has no question text to classify.',
      category: 'empty_question',
      recommendation: null,
      confidence: 'high',
    };
  }

  // Rule 3 — escalation bar. Always Kevin's call.
  const esc = detectEscalation(haystack);
  if (esc) {
    return {
      action: 'park_card',
      answer: null,
      reason: `Rule 3: the question touches the escalation bar (${esc}) — only Kevin may decide this.`,
      category: esc,
      recommendation: null,
      confidence: 'high',
    };
  }

  // Rule 4 — Kevin's standing test/DB fence.
  if (isTestOrDbBeyondRead(haystack)) {
    return {
      action: 'park_card',
      answer: null,
      reason: "Rule 4: the question is test- or database-related beyond a pure read — Kevin's standing fence requires his sign-off.",
      category: 'fence_test_or_db',
      recommendation: null,
      confidence: 'high',
    };
  }

  // Cap — honour the number handed in; never run auto-answers unbounded.
  if (typeof input.priorAutoAnswers === 'number' && input.priorAutoAnswers >= DEFAULT_AUTO_ANSWER_CAP) {
    return {
      action: 'park_card',
      answer: null,
      reason: `Rule 7 (cap): ${input.priorAutoAnswers} prior auto-answers this run reached the cap of ${DEFAULT_AUTO_ANSWER_CAP} — parking regardless of any recommendation so one tree cannot drive an unbounded run.`,
      category: 'cap_reached',
      recommendation: null,
      confidence: 'high',
    };
  }

  // Rule 5 — adopt the worker's own recommendation, never invent one.
  const rec = extractRecommendation(haystack);
  if (rec) {
    return {
      action: 'auto_answer',
      answer: `Go with your recommendation: ${rec.text}`,
      reason: `Rule 5: the worker stated its own ${rec.strong ? 'explicit' : 'soft'} recommendation and no escalation/fence fired — adopting it rather than offering an opinion of my own.`,
      category: 'has_recommendation',
      recommendation: rec.text,
      confidence: rec.strong ? 'high' : 'low',
    };
  }

  // Rule 6 — a real call with nothing to adopt. Kevin's.
  return {
    action: 'park_card',
    answer: null,
    reason: 'Rule 6: a real product/spec decision with no worker recommendation to adopt — parking for Kevin rather than answering on his behalf.',
    category: 'no_recommendation',
    recommendation: null,
    confidence: 'high',
  };
}
