# Tree Steward — the evidence, before you deploy (#384)

*Rewritten by node #1732 on branch `feat/tree-steward`, after the escalation detector was changed from mention-matching to intent-matching. Every number below was observed by re-running `tools/tree-steward-demo.ts` and `tools/tree-steward-proof.ts` in this node — nothing is quoted from an earlier run.*

---

## 1. What this proves, in four plain sentences

This proves the Tree Steward's decision engine — and the exact words and records it would write — run against two real blocked-question texts pulled verbatim from the live system. On today's code it now does the right thing on **both**: it **auto-answers** the real case where the worker stated its own recommendation (#1705), and it **parks** the real case where the worker needs a fact only you have (#284) — and the auto-answer artifacts (the answer, the full decision payload, the one-line origin post) come straight out of the real `classify → executeAutoAnswer` path, not a bypass. The escalation bar that guards your "always my call" line was tightened so it fires on an **intent to act** on a sensitive thing, not on the mere mention of one, and that change was proven in **both** directions with two source mutations (loosen it one way and the narrative cases wrongly park; loosen it the other and a real park case changes category). The one thing no test on this branch can show is the live engine round-trip — that is exactly what the deploy step reveals.

---

## 2. The two real cases

Both cases are the **originally-specified nodes** (1705 and 284); neither is a substitute. Both question texts were harvested read-only from the live system (`harvestedVia = sqlite-ro`) and are used **verbatim** — not reworded, not trimmed, not bent to make the steward look good.

### Case A — the auto-answer case · node **#1705**, tree **tree-6afc7590**
- **Real question (5,925 chars), opening verbatim:**
  > "GUEST MESSAGING REVIEW GATE (tree-6afc7590 node #1705) — both reviewers agree on every fact; one item left is a product call only you can make.
  >
  > BOTH VERDICTS: FAIL, on this single open item. reviews/guest-messages-opus.md and reviews/guest-messages-openai.md are committed on feat/guest-messages …"
- **What it should do:** auto-answer. The worker stated its own recommendation ("*My recommendation: (B) with a deliberately long reclaim window …*"), so the steward can adopt it instead of bothering you.
- **What the steward actually did:** ✅ **AUTO-ANSWERED it, from the primary path.**
  - action = `auto_answer`
  - category = `has_recommendation`
  - confidence = high
  - reason = *"Rule 5: the worker stated its own explicit recommendation and no escalation/fence fired — adopting it rather than offering an opinion of my own."*
  - `executeAutoAnswer` return = `answered=true decisionWritten=true linePosted=true`; ordered call log = `[answerNode -> recordDecision -> postOriginLine]`
  - Verdict line from the run: `[3] PASS  auto-answer-case  expected=auto_answer got=auto_answer`

  Previously this case PARKED, because its narrative prose tripped three bare keyword matches — `\bproduction\b` ("…while **production** would store 21:00:37", describing a bug), `\bdrop\b` ("(A) **DROP** THE RELEASE", a code step not a DB drop), and the fence keyword `migrat` ("**migrations** are sound"). None of those is a request to touch prod, drop data, or run a migration. Under intent-matching they no longer fire (see §5), so Rule 5 is now reached and the worker's own recommendation is adopted.

### Case B — the park case · node **#284**, tree **tree-752a55a1**
- **Real question (2,757 chars), opening verbatim:**
  > "Node #284 (Ongage webhook durable logging): WHERE is the Ongage event receiver? It is NOT in any checked-in repo. Exhaustively searched TheDarwinAgency/Hub @ perclickity/sandbox-link-environment (= live checkout), TheDarwinAgency/HubCron, and DarwinIntakeSystem …"
- **What it should do:** park. No recommendation offered; the worker asks you for a fact only you have (the Ongage webhook URL / uncommitted `quantum_oop` path).
- **What the steward actually did:** ✅ **PARKED it** — the right outcome, and now for the right reason.
  - action = `park_card`
  - category = `no_recommendation`
  - confidence = high
  - reason = *"Rule 6: a real product/spec decision with no worker recommendation to adopt — parking for Kevin rather than answering on his behalf."*
  - Verdict line from the run: `[3] PASS  park-case  expected=park_card got=park_card`
  - ✅ **Honest reason, corrected:** on the old code this parked on an escalation keyword ("= live checkout"). Under intent-matching "live checkout" is a *mention* with no act-intent, so escalation no longer fires; the case now parks on the **honest** rule — **Rule 6, no recommendation was offered** — which is the actual reason only you can answer it. The card is the same; the stated reason is now the true one (this addresses the verifier's minor note on the prior proof).

**Run summary (observed):** `2 cases, 2 matched, 0 mismatched`.

The hand-written demo fixture — 13 original cases plus 9 added here (3 must-still-park positives incl. a mutation demonstrator, 6 must-no-longer-park narrative negatives) — ran clean too: **`22 cases, 22 matched, 0 mismatched`** (`npx tsx tools/tree-steward-demo.ts`).

---

## 3. The three artifacts, verbatim — from the primary path

Unlike the prior proof, these did **not** come from a diagnostic bypass (that bypass was deleted; `grep -c DIAGNOSTIC tools/tree-steward-proof.ts` = **0**). The classifier routed #1705 to `auto_answer`, and the proof then ran the **real** `executeAutoAnswer` with **recording fakes** (no DB, no model, no network) on that primary branch. So these artifacts are what the steward composes on the path it actually takes.

Observed before the artifacts:
- `executeAutoAnswer` return → `answered=true decisionWritten=true linePosted=true`
- ordered call log → `[answerNode -> recordDecision -> postOriginLine]`

### Artifact (a) — the answer handed to `answerNode`
```
nodeId: 1705
answer: "Go with your recommendation: (B) with a deliberately long reclaim window (e.g."
```
*(The answer is clamped to the recommendation's first sentence by the existing `clampToSentences`; "(e.g." is where "e.g." ends the first sentence. That clamp is pre-existing behaviour, unchanged by this patch.)*

### Artifact (b) — the decision payload handed to `recordDecision`, field by field
```
nodeId   : 1705
treeId   : "tree-6afc7590"
question : "GUEST MESSAGING REVIEW GATE (tree-6afc7590 node #1705) — both reviewers agree on every fact; one item left is a product call only you can make.\n\nBOTH VERDICTS: FAIL, on this single open item. reviews/…" [5,925 chars total]
decision : "Go with your recommendation: (B) with a deliberately long reclaim window (e.g."
rationale: "Tree Steward auto-answer — classifier rule \"Rule 5: the worker stated its own explicit recommendation and no escalation/fence fired — adopting it rather than offering an opinion of my own.\" fired (category: has_recommendation); adopted the worker's own recommendation."
category : "has_recommendation"
(decided_by is hard-set to "jarvis" INSIDE realStewardEffects.recordDecision, not observed by the fake.)
```

### Artifact (c) — the one-line origin-thread post handed to `postOriginLine`
```
treeId: "tree-6afc7590"
line  : "🌿 steward: auto-answered #1705 on tree-6afc7590 — has_recommendation — adopted the worker's own recommendation: Go with your recommendation: (B) with a deliberately long reclaim window (e.g."
single-line (no embedded newline)? true
```

### The park case's empty call log (positive evidence of *no* effects)
For Case B (#284, parked), `executeAutoAnswer` was **not** invoked and nothing was written:
```
recording-fake call log (positive evidence of no effects) = []  length=0
answerNode calls     = 0
recordDecision calls = 0
postOriginLine calls = 0
```

---

## 4. The regression proof — both directions

The whole point of this patch is that loosening the escalation bar did not open a hole. Two source mutations, each applied by hand to the single `categoryFires` function and then **restored by hand** (never `git checkout`), prove it is load-bearing in both directions:

- **Mutation (a) — remove the act-intent requirement (match on the object alone).** Every new narrative negative must break.
  `npx tsx tools/tree-steward-demo.ts` → **`22 cases, 9 matched, 13 mismatched`**. All six negatives flipped from `auto_answer` to `park_card` — e.g. `17-narrative-production-mention … got=park_card/escalation_production`, `22-narrative-dollar-mention … got=park_card/escalation_destructive`. The object-only guard parks bug reports that merely *name* production / a row / email / a migration / a dollar figure. Restored.
- **Mutation (b) — remove the sensitive-object requirement (match on the verb alone).** At least one positive must change.
  `npx tsx tools/tree-steward-demo.ts` → **`22 cases, 20 matched, 2 mismatched`**. Positive **`14-run-migration-mentions-drop`** changed category `fence_test_or_db → escalation_destructive`: with the object dropped, the bare `drop` in "It will **drop** and recreate the temp index" fires destructive instead of letting the real intent ("run the migration") be read as the fence. (Negative `18` also broke, extra evidence.) Restored.

After both restores: `22 cases, 22 matched, 0 mismatched`; proof `2 cases, 2 matched, 0 mismatched`.

---

## 5. 🔴 Honest limits — what this does NOT prove, and what the loosening trades away

Read this section twice.

1. **The escalation detector was loosened from mention-matching to intent-matching.** It used to park on the mere appearance of a word (`\bproduction\b`, `\bdrop\b`, `\bdeploy\b`, `\bemail\b`, `\$\d`, `migrat…`). It now parks only when a single clause contains **both** a sensitive object **and** that category's own action verb in action form (base/imperative, not the `-s`/`-ed` narrative forms, and not preceded by "the/was/cannot/not…"). **What this buys:** nearly every bug report at Darwin mentions "email", "production" or a dollar figure; those no longer jam the steward. **What it trades away:** a request that expresses intent using a verb the list does not recognise, next to a sensitive object, could slip past the bar — and if the worker also stated a recommendation, be auto-answered rather than parked. This is a real loosening of a guard that protects your "always my call" line, which is why it is proven in both directions (§4) and why the safe fallbacks below exist.
2. **The safe direction still holds.** A tiny, deliberate **always-escalate allowlist** still parks on *mention alone*, no verb needed: the live production DB identifiers `tdhmike_dhub` and `kuojrvfdjjqhqyvkuiam`, and `force-push`. And anything with no recommendation to adopt still parks via Rule 6. So the failure mode of the loosening is narrow, and never touches the named prod databases or a force-push.
3. **The effects ran against recording fakes — so this proves the *decision* and the exact *artifacts*, not a live engine round-trip.** We have not proven that, wired to the real engine, the node's status actually flips, the decision lands in `jarvis.db`, and the line appears in the origin thread.
4. **The per-tree cap, the lane, the never-answer-twice memory (#382) and the morning rollup (#383) were proven in those nodes, not re-exercised here.**
5. **The steward ships in card-only (shadow) mode** until you set `steward_mode` to exactly `live`.
6. **The one thing no branch-side proof can establish is the real engine round-trip** — a genuine blocked_question flowing through the running engine into the steward and back out. That is precisely what the deploy will show.

---

## 6. What was NOT touched

- **Live `jarvis.db` was never opened by this proof.** It is DB-isolated by construction: an import-hazard guard redirects every DB open to a throwaway `/tmp` file (this run's header named `/tmp/steward-proof-scratch-2347513.db`). The live DB (`/home/kevin/paperclip/darwin-assistant/jarvis.db`) read **675,762,176 bytes** both before this node's work (mtime `Oct 29 22:02`) and after (mtime `Oct 29 22:13`) — **size identical**; the mtime advances on its own because the running engine writes it every second, independent of this node. The real guarantee it was untouched is the scratch redirect, which is stronger than a before/after on a file a live process owns.
- **No real node was answered or re-queued.** The only `answerNode`/`recordDecision`/`postOriginLine` calls in the whole run were against **recording fakes**. No `hopper_nodes` row changed; no decision row was written to the live ledger; no origin thread received a post.
- **No test suite was run and no database was connected** — per Kevin's standing rule. Verification was `npx tsc --noEmit` (0 errors, same as the pre-edit baseline), plus the two `tsx` demo/proof scripts, plus reading.
- **Nothing was deployed, `jarvis.service` was not restarted, and nothing was merged.** Work is committed to `feat/tree-steward` only.
- **The live `/home/kevin/paperclip` checkout was never modified.** `git status --porcelain | wc -l` = **10** before this node and **10** after. All edits are inside the separate worktree.

---

## 7. Your next step

Deploy, in this order:
1. **Build `dist`** from `feat/tree-steward` (compiled output, no source edits).
2. **Restart via a transient unit** (a one-shot `systemd-run` transient service), not a hand restart of the live `jarvis.service`.
3. **Watch in card-only (shadow) mode** — leave `steward_mode` unset/≠`live` and confirm real blocked_questions produce steward cards with sane verdicts.
4. **Flip to live** by setting `steward_mode` to exactly `live` once the shadow cards look right.

**Known double-bell (not a blocker, unchanged by this patch):** the engine raises its own generic ❓ bell for every blocked_question (`src/hopper-engine.ts` ~L1472) and the steward card raises its own, so a parked question rings twice. The one-line fix is left for your review because that engine file is owned by another tree.

---

**Read this first:** the steward's judgment and the exact records it writes are proven on real text; it now auto-answers the real recommendation case from the primary path and parks the real "need a fact from Kevin" case for the honest reason. The escalation bar was loosened from mention-matching to intent-matching — a real trade-off, proven in both directions, with a tiny always-escalate allowlist and the no-recommendation park as the safe floor. Let the deploy's live round-trip be the thing that finally proves the end-to-end path.
