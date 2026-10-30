# The Tree Steward classifier — decision table

> Source of truth: `src/tree-steward.ts` (the pure function `classifyBlockedQuestion`).
> This doc describes what is **actually implemented there** as of the `feat/tree-steward` branch,
> so the later chunks (#380–#384, which wire the classifier into the engine) and Kevin can both
> trust it without re-reading the code.

## What the steward decides — and what it deliberately never decides

The Tree Steward looks at **one stuck node that is in status `blocked_question`** — a worker that
stopped to ask a question it could not settle itself — and makes exactly one of three calls:
**`auto_answer`** it (hand the node a decision so the tree keeps moving), **`park_card`** it (post
it for Kevin and wait), or **`noop`** (not the steward's to touch). It only ever *auto-answers by
adopting a recommendation the worker already wrote down* — it never invents an opinion of its own,
and it parks anything that touches Kevin's escalation bar, his test/DB fence, or that is a real
product call with no worker recommendation to lean on. It is a **pure, synchronous, side-effect-free
classifier**: given the node's fields in, it returns a decision out. It does **not** decide whether a
node is *stuck* in the first place (the engine does that), it does **not** touch a plain `blocked`
node (that is the Smart Unblocker's job), and it does **not** itself answer, park, log, or post
anything — a later node (#381) carries out whatever the steward decided.

## The decision table

Rules are evaluated **top to bottom; the first that fires wins.** `category` is the machine tag the
decision carries (used by the demo, the tests, and #384). "Where this rule comes from" cites the real
origin of each rule.

| # | Trigger (plain words) | Result | `category` | Where this rule comes from |
|---|---|---|---|---|
| **1** | The node's status is **not** `blocked_question` (e.g. a plain `blocked`, or `done`). | `noop` | `not_a_question` | The posture it replaces — `src/tree-cue.ts` (~119–140), which punts every blocked_question to Kevin: *"Next: this is a blocked_question — Kevin's call, not yours. Surface it to him and answer the node only once he has decided."* The steward keeps the hands-off stance for everything that is **not** a question. |
| **2** | It is a `blocked_question` but the question text is empty / whitespace only. | `noop` | `empty_question` | Nothing to classify — a safety gate (`hasQuestionText`). |
| **3** | The question or result text hits JARVIS's **fixed escalation bar** (live production; destructive/irreversible ops; merge to main; external-facing sends; non-trivial money). | `park_card` | `escalation_production` · `escalation_destructive` · `escalation_merge_main` · `escalation_external` · `escalation_money` (whichever fired; checked a→e, first hit wins) | JARVIS's fixed escalation bar / hard limiter — the dial-independent "always escalate to Kevin" list. These are never the steward's to answer, recommendation or not. |
| **4** | The question is **test- or database-related beyond a pure read** (run a test suite, a migration/seed, an `INSERT`/`UPDATE ... SET`, a `GRANT`, a write to the DB). | `park_card` | `fence_test_or_db` | Kevin's standing fence of **2026-10-28**: *tests are never run and the DB is never written without his say-so.* Outranks the adopt-recommendation rule below — a worker that offers a recommendation **and** asks to run the suite is still parked. |
| **(cap)** | `priorAutoAnswers >= DEFAULT_AUTO_ANSWER_CAP` (default **3**) for this run. Evaluated **5th**, after rule 4 and before rule 5 — it overrides rules 5–6. | `park_card` | `cap_reached` | A bounded-run guard: one tree must not drive an unbounded run of auto-answers. The cap value is read from settings by a later node and handed in via `priorAutoAnswers`; `DEFAULT_AUTO_ANSWER_CAP` is only the fallback threshold. *(Code quirk: the branch's `reason` string labels itself "Rule 7 (cap)", but it is the 5th branch evaluated — see "Open calls" below.)* |
| **5** | A real product/spec question, nothing above fired, **and the worker stated its own recommendation** (`RECOMMENDATION:` / `RECOMMEND:` / `MY RECOMMENDATION:` → *high* confidence; `Default:` / `Proposed default:` / `I recommend` / `I would recommend` / `My recommendation is` / `I suggest` → *low* confidence). | `auto_answer` | `has_recommendation` | The `case 'unblock':` block in `src/goals-autopilot.ts` (line ~617), which codifies the answer-it-or-park-it judgement: *"If it is a `blocked_question` you can answer from the goal/notes/repo → answer it … Never answer a question only Kevin can answer — park it."* The steward **adopts** the worker's recommendation (`answer = "Go with your recommendation: <text>"`, trimmed to 2 sentences / 400 chars); it never writes a new opinion. |
| **6** | A real product/spec question with **no** worker recommendation to adopt. | `park_card` | `no_recommendation` | Same `goals-autopilot.ts` judgement, the other half: *"Never answer a question only Kevin can answer — park it."* With nothing of the worker's own to adopt, the steward defers to Kevin rather than guessing. |

**Rule count:** `src/tree-steward.ts` implements **7 decision branches** (6 numbered rules + the cap
branch). This table has **7 rows** — one per branch, in evaluation order. (Rules 1 and 2 are the two
gates; rule 3 fans out into 5 escalation categories but is a single rule/branch.)

## What this function cannot do

`classifyBlockedQuestion` is pure by contract (`src/tree-steward.ts` has **no imports at all**). It
therefore:

- **never re-queues or re-pends a node** — it only returns an `action`; acting on it is #381's job;
- **never writes a `log_decision`, a commitment, or any DB row**;
- **never posts a card or any message to a thread** — "park" is a *verdict*, not an action here;
- **never reads settings, the clock, the network, or a file** — if it needs the live cap value, the
  node row, or anything stateful, the **caller** reads it and hands it in via `StewardInput`;
- **never touches a plain `blocked` node** — that is the Smart Unblocker's territory; the steward
  `noop`s it (rule 1).

This is deliberate: it keeps the one decision that governs auto-answering trivially testable and
impossible to quietly turn into something that touches production.

## How to see it work without a test runner

A model-free demo harness drives the classifier over the shared fixtures and prints one line per
case. It is **a plain script, not a test suite** — it touches no DB, network, or model, and always
exits 0.

```
cd /home/kevin/paperclip-worktrees/tree-steward/darwin-assistant && npx tsx tools/tree-steward-demo.ts
```

Current output (captured 2026-10-29):

```
PASS      01-dst-boundary-strong-recommendation  expected=auto_answer/has_recommendation/high  got=auto_answer/has_recommendation  conf=high  answer=Go with your recommendation: treat it as 24 absolute hours - simpler and matches
PASS      02-dst-boundary-soft-recommendation  expected=auto_answer/has_recommendation/low  got=auto_answer/has_recommendation  conf=low  answer=Go with your recommendation: I suggest we treat it as 24 absolute hours - it's t
PASS      03-grouping-no-recommendation  expected=park_card/no_recommendation/high  got=park_card/no_recommendation  conf=high  answer=
PASS      04-restart-jarvis-service  expected=park_card/escalation_production/high  got=park_card/escalation_production  conf=high  answer=
PASS      05-merge-to-main  expected=park_card/escalation_merge_main/high  got=park_card/escalation_merge_main  conf=high  answer=
PASS      06-run-test-suite-even-with-recommendation  expected=park_card/fence_test_or_db/high  got=park_card/fence_test_or_db  conf=high  answer=
PASS      07-write-rows-to-database  expected=park_card/fence_test_or_db/high  got=park_card/fence_test_or_db  conf=high  answer=
PASS      08-dm-mike-on-slack  expected=park_card/escalation_external/high  got=park_card/escalation_external  conf=high  answer=
PASS      09-subscribe-paid-plan  expected=park_card/escalation_money/high  got=park_card/escalation_money  conf=high  answer=
PASS      10-delete-branch-force-push  expected=park_card/escalation_destructive/high  got=park_card/escalation_destructive  conf=high  answer=
PASS      11-plain-blocked-not-a-question  expected=noop/not_a_question/high  got=noop/not_a_question  conf=high  answer=
PASS      12-blocked-question-empty-text  expected=noop/empty_question/high  got=noop/empty_question  conf=high  answer=
PASS      13-cap-reached-despite-perfect-recommendation  expected=park_card/cap_reached/high  got=park_card/cap_reached  conf=high  answer=

13 cases, 13 matched, 0 mismatched
```

Add `--json` (`npx tsx tools/tree-steward-demo.ts --json`) to get the raw decisions, which is how
#384 will capture evidence programmatically.

## Open calls for Kevin

These are judgement calls the earlier nodes left for you — none block the build, but they shape how
aggressive the steward is:

1. **Soft recommendations still auto-answer.** A worker that writes `I suggest …` or `Default: …`
   gets its question auto-answered at **low** confidence (rule 5, fixture `02`). Confidence is
   *recorded* but does not change the action — low and high both auto-answer. Do you want low-confidence
   recommendations to **park** instead (so only explicit `RECOMMENDATION:` lines auto-answer)? This is a
   one-line change in #381/#384's handling of the decision, not in the classifier.
2. **The classifier is deliberately trigger-happy about parking.** The escalation (rule 3) and fence
   (rule 4) detectors are keyword/regex matches over the question+result text, tuned so a **false park
   is safe and a false auto-answer is not**. Consequence: any question that merely *mentions* deploy,
   Slack, email, buy/spend/`$`, a migration, etc. parks even if the ask itself is benign. If you find
   it over-parking real questions in practice, the keyword lists in `src/tree-steward.ts`
   (`detectEscalation`, `isTestOrDbBeyondRead`) are where to loosen them.
3. **The auto-answer cap default is 3** (`DEFAULT_AUTO_ANSWER_CAP`). A later node will make the live
   value settings-driven; confirm 3 per run is the ceiling you want.
4. **Cosmetic: the cap branch's `reason` text says "Rule 7 (cap)"** while it is actually the 5th
   branch evaluated. Harmless (the `category` tag `cap_reached` is what everything keys on), but worth a
   one-character cleanup if you want the reason strings to read in order.

## For Kevin: the test we wrote and did not run

- **File:** `src/__tests__/tree-steward.test.ts` (committed on `feat/tree-steward`, **never executed** by a worker — per your 2026-10-28 standing order).
- **Run it yourself with:**

```
cd /home/kevin/paperclip-worktrees/tree-steward/darwin-assistant && npx vitest run src/__tests__/tree-steward.test.ts
```

(The repo has no test runner installed yet, so `npx vitest` fetches vitest on first run — or `npm i -D vitest` once. Test files are excluded from `tsconfig.json`, so this file never enters `npx tsc --noEmit` or `npm run build`.)

A **pass** proves the pure classifier maps every fixture case to the right action + category + confidence, that each `auto_answer` adopts the worker's own recommendation (the answer contains it, and the text is a substring of what the worker wrote — never invented), and that `src/tree-steward.ts` contains no I/O (no `fs`/`fetch`/`process.env`/`better-sqlite3`, no clock). It does **not** prove anything about the engine wiring around the classifier (#381/#384) or any live data — it exercises the pure function only.
