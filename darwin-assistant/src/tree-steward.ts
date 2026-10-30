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

// ---------------------------------------------------------------------------
// Sentence-scoped intent matching (shared by the escalation bar and the fence)
// ---------------------------------------------------------------------------
//
// WHY: a worker question that merely DESCRIBES a bug ("production would store
// the wrong time", "this code path deletes the draft row", "the email template
// renders twice", "the invoice shows $1,240") must NOT park — it is narrative,
// not a request to act. Only an INTENT to act on a sensitive thing is Kevin's
// call. So we (1) split the text into sentences, and (2) within ONE sentence
// require BOTH a sensitive OBJECT of a category AND an act-intent: one of that
// category's action verbs used in ACTION FORM, or a first-person permission
// frame. Narrative prose in other sentences can no longer trip the bar.
// Deterministic string work only — no NLP, no clock, no locale surprises.

/** Split into clauses on sentence terminators (. ! ?), newlines, semicolons and
 *  spaced dashes. A terminator only ends a clause when followed by whitespace or
 *  end-of-text, so intra-token dots like "jarvis.service", "routes/console.php"
 *  and "PHP 8.4" are kept whole (splitting them would hide the very objects the
 *  bar must see); the semicolon/dash splits keep a narrative clause ("… — the
 *  second UPDATE re-evaluates … the committed row") from being bundled with an
 *  unrelated object elsewhere in a long sentence. Simple + deterministic. */
export function splitSentences(text: string): string[] {
  return (text ?? '')
    .split(/(?<=[.!?])\s+|\n+|\s*;\s*|\s+[—–]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Words that, immediately before an action verb, mark it as NARRATION rather
 *  than intent: determiners ("the delete button"), copulas/auxiliaries ("was
 *  run", "is deleted"), and inability/negation ("cannot run", "not run").
 *  Deliberately EXCLUDES will/would/should/shall/can/could/may — those read as
 *  intent, and the permission frames key on should/can/may + I/we. */
const NARRATION_BEFORE =
  /\b(?:the|a|an|this|that|these|those|its|their|our|my|your|his|her|no|any|each|every|another|other|two|one|some|was|were|is|are|be|been|being|am|has|have|had|not|never|cannot|can't|couldn't|won't|wouldn't|didn't|doesn't|don't|shouldn't|already)\s*$/i;

/** True when `verb` occurs in `sentence` in ACTION FORM — the match is not
 *  immediately preceded by a narration marker. The verb regexes below match
 *  only base/imperative forms (`\bdelete\b`, never "deletes"/"deleted"), so the
 *  third-person-s and past-tense narration forms already fall out; this guard
 *  additionally rejects "was run" / "the delete" / "cannot run". */
function hasActionVerb(sentence: string, verb: RegExp): boolean {
  const re = new RegExp(verb.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence)) !== null) {
    if (!NARRATION_BEFORE.test(sentence.slice(0, m.index))) return true;
    if (m.index === re.lastIndex) re.lastIndex++; // zero-width safety
  }
  return false;
}

/** A category fires on a sentence when it names a sensitive OBJECT of that
 *  category AND one of the category's own ACTION VERBS appears in action form in
 *  the SAME sentence. Both halves must be of the matching category: this is what
 *  keeps a worker's own permission frame ("should I run the migration to add the
 *  column") from mis-attributing a sentence to the wrong category on a bare
 *  object word ("column") — the category verb, not a generic frame, is the
 *  binding intent signal, and that is also the tighter (safer) guard. A real
 *  "should I <verb> <object>" escalation always carries the category's verb
 *  (restart jarvis.service / merge to main / DM Mike on Slack / subscribe …),
 *  so requiring it loses no genuine park case. */
function categoryFires(sentence: string, objects: RegExp[], verbs: RegExp[]): boolean {
  if (!objects.some((re) => re.test(sentence))) return false;
  return verbs.some((re) => hasActionVerb(sentence, re));
}

/** INTENTIONAL always-escalate allowlist — the only things that park on their
 *  MENTION, with no verb required, because naming them at all deserves Kevin:
 *  the two live production database identifiers and a force-push (there is no
 *  benign force-push). Everything else must show intent. Keep this list tiny. */
const ALWAYS_ESCALATE: { re: RegExp; category: EscalationCategory }[] = [
  { re: /tdhmike_dhub/i, category: 'escalation_production' },
  { re: /kuojrvfdjjqhqyvkuiam/i, category: 'escalation_production' },
  { re: /\bforce[-\s]?push\b/i, category: 'escalation_destructive' },
];

/**
 * Detect, over the combined question+result text, whether the question shows an
 * INTENT to act that touches the fixed escalation bar. Returns the specific
 * category, or null. The always-escalate allowlist is checked first; then the
 * five categories in the spec's priority order (a→e), so `category` names the
 * most serious matched concern. Intent-matched, sentence-scoped: a bare mention
 * ("production would store the wrong time") no longer fires — only a request to
 * act on it ("should I write the production rows") does.
 */
export function detectEscalation(text: string): EscalationCategory | null {
  const raw = text ?? '';
  if (!raw.trim()) return null;

  // Always-escalate allowlist: naming these needs no verb (see ALWAYS_ESCALATE).
  for (const a of ALWAYS_ESCALATE) {
    if (a.re.test(raw)) return a.category;
  }

  const sentences = splitSentences(raw);

  // (a) live production servers, files or databases.
  const prodObjects: RegExp[] = [
    /\bproduction\b/i,
    /\bprod\s+(?:db|database|server|checkout|hub|data|site)\b/i,
    /\blive\s+(?:production|server|checkout|hub|database|db|data|site)\b/i,
    /\bthe\s+live\s+hub\b/i,
    /\bjarvis\.service\b/i,
    /\bthe\s+daemon\b/i,
  ];
  const prodVerbs: RegExp[] = [
    /\brestart\b/, /\breboot\b/, /\breload\b/,
    /\bdeploy\b/, /\bredeploy\b/, /\bpush\b/,
  ];

  // (b) destructive / irreversible operations.
  const destructiveObjects: RegExp[] = [
    /\bbranch\b/i, /\bdatabase\b/i, /\bdb\b/i, /\btable\b/i, /\bschema\b/i,
    /\brows?\b/i, /\brecords?\b/i, /\bcolumn\b/i,
  ];
  const destructiveVerbs: RegExp[] = [
    /\bdrop\b/, /\bdelete\b/, /\btruncate\b/, /\bwipe\b/, /\bpurge\b/, /\brevoke\b/,
  ];

  // (c) merging to main/master.
  const mergeObjects: RegExp[] = [/\b(?:main|master)\b/i];
  const mergeVerbs: RegExp[] = [/\bmerge\b/];

  // (d) external-facing action under Kevin's identity.
  const externalObjects: RegExp[] = [
    /\bslack\b/i, /\bemail\b/i, /\bmike\b/i,
    /\bpublic\s+(?:pr|pull\s+request|post)\b/i, /\bpull\s+request\b/i,
    /\btwitter\b/i, /\blinkedin\b/i,
  ];
  const externalVerbs: RegExp[] = [
    /\bdm\b/, /\bemail\b/, /\bslack\b/, /\bmessage\b/, /\bnotify\b/,
    /\bping\b/, /\bpost\b/, /\bpublish\b/, /\bsend\b/, /\btweet\b/,
  ];

  // (e) money.
  const moneyObjects: RegExp[] = [
    /\$\s?\d/, /\bsubscription\b/i, /\bpaid\s+plan\b/i, /\bcontract\b/i,
    /\bpayment\b/i, /\binvoice\b/i, /\bcost\b/i, /\bfee\b/i, /\bprice\b/i,
    /\b\d+\s?\/\s?(?:month|mo|year|yr)\b/i, /\b\d+\s?(?:usd|dollars?)\b/i,
  ];
  const moneyVerbs: RegExp[] = [
    /\bbuy\b/, /\bpurchase\b/, /\bsubscribe\b/, /\bpay\b/, /\bspend\b/,
    /\bcharge\b/, /\brenew\b/,
  ];

  const categories: { name: EscalationCategory; objects: RegExp[]; verbs: RegExp[] }[] = [
    { name: 'escalation_production', objects: prodObjects, verbs: prodVerbs },
    { name: 'escalation_destructive', objects: destructiveObjects, verbs: destructiveVerbs },
    { name: 'escalation_merge_main', objects: mergeObjects, verbs: mergeVerbs },
    { name: 'escalation_external', objects: externalObjects, verbs: externalVerbs },
    { name: 'escalation_money', objects: moneyObjects, verbs: moneyVerbs },
  ];

  // Priority order (a→e): the most serious matched concern names the category.
  for (const cat of categories) {
    if (sentences.some((s) => categoryFires(s, cat.objects, cat.verbs))) {
      return cat.name;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 4 — Kevin's standing test/DB fence (anything beyond a pure read)
// ---------------------------------------------------------------------------

/**
 * True when the question shows an INTENT to do something test- or database-
 * related beyond a pure read: running a test suite, a migration, a seed, a
 * write/insert/update against any database, or granting a privilege. Destructive
 * DB verbs (drop/delete/truncate) are caught upstream by the escalation bar;
 * this covers the rest of the fence. Intent-matched and sentence-scoped on the
 * same rule as the escalation bar, so "the migration that added this column"
 * (narrative) no longer parks while "should I run the migration" still does.
 */
export function isTestOrDbBeyondRead(text: string): boolean {
  const raw = text ?? '';
  if (!raw.trim()) return false;

  // SQL-shaped / tool-invocation patterns carry object + verb in one token and
  // are self-evidently an intent to run a test or mutate data; match directly.
  const standalone: RegExp[] = [
    /\binsert\s+into\b/i,
    /\bupdate\b[^.\n]{0,40}\bset\b/i,
    /\bdelete\s+from\b/i,
    /\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?test\b/i,
    /\bcomposer\s+test\b/i,
    /\bartisan\s+(?:test|migrate|db:)/i,
    /\bphpunit\b/i, /\bvitest\b/i, /\bpest\b/i, /\bjest\b/i, /\bmocha\b/i,
    /\bdb:(?:seed|wipe|migrate|fresh)\b/i,
  ];
  if (standalone.some((re) => re.test(raw))) return true;

  // Otherwise require, within ONE sentence, a fence OBJECT plus act-intent (a
  // fence verb in action form OR a first-person permission frame).
  const objects: RegExp[] = [
    /\btest\s+suite\b/i, /\bsuite\b/i, /\btests?\b/i, /\bunit\s+tests?\b/i,
    /\bmigration\b/i, /\bseed\b/i,
    /\bdatabase\b/i, /\bdb\b/i, /\bschema\b/i, /\btable\b/i,
    /\bprivileges?\b/i,
  ];
  const verbs: RegExp[] = [
    /\brun\b/, /\brerun\b/, /\bwrite\b/, /\binsert\b/, /\bupdate\b/,
    /\bseed\b/, /\bmigrate\b/, /\bgrant\b/, /\bexecute\b/,
  ];
  return splitSentences(raw).some((s) => categoryFires(s, objects, verbs));
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
