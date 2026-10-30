# Tree Steward — the evidence, before you deploy (#384)

*Written by node #1730 on branch `feat/tree-steward`. Every number below was observed by re-running `tools/tree-steward-proof.ts` in this node — nothing is quoted from an earlier run.*

---

## 1. What this proves, in four plain sentences

This proves the Tree Steward's decision engine, and the exact words and records it would write, run against two real blocked-question texts pulled verbatim from the live system. On today's code it is cautious to a fault: it parked **both** real cases for your call — including one a person would have let it auto-answer — so deploying it now can only ever card a question for you, never answer one wrongly. The piece that actually composes and files an auto-answer was then proven correct on its own, against that same real text, so the machinery is sound — what is holding auto-answer back is one over-eager keyword check, not the answer logic. The one thing no test on this branch can show is what happens when the real engine runs the steward live, and that is exactly what your next step — the deploy — will reveal.

---

## 2. The two real cases

Both cases are the **originally-specified nodes** (1705 and 284); neither is a substitute. Both question texts were harvested read-only from the live system (`harvestedVia = sqlite-ro`) and are used **verbatim** — not reworded, not trimmed, not bent to make the steward look good.

### Case A — the auto-answer case · node **#1705**, tree **tree-6afc7590**
- **Real question (5,925 chars), opening verbatim:**
  > "GUEST MESSAGING REVIEW GATE (tree-6afc7590 node #1705) — both reviewers agree on every fact; one item left is a product call only you can make.
  >
  > BOTH VERDICTS: FAIL, on this single open item. reviews/guest-messages-opus.md and reviews/guest-messages-openai.md are committed on feat/guest-messages …"
- **What it should do:** auto-answer. The worker stated its own recommendation ("*My recommendation: (B) with a deliberately long reclaim window …*"), so the steward can adopt it instead of bothering you.
- **What the steward actually did:** 🔴 **PARKED it.**
  - action = `park_card`
  - category = `escalation_production`
  - confidence = high
  - reason = *"Rule 3: the question touches the escalation bar (escalation_production) — only Kevin may decide this."*
  - Verdict line from the run: `[3] FAIL  auto-answer-case  expected=auto_answer got=park_card`

### Case B — the park case · node **#284**, tree **tree-752a55a1**
- **Real question (2,757 chars), opening verbatim:**
  > "Node #284 (Ongage webhook durable logging): WHERE is the Ongage event receiver? It is NOT in any checked-in repo. Exhaustively searched TheDarwinAgency/Hub @ perclickity/sandbox-link-environment (= live checkout), TheDarwinAgency/HubCron, and DarwinIntakeSystem …"
- **What it should do:** park. No recommendation offered; the worker asks you for a fact only you have (the Ongage webhook URL / uncommitted `quantum_oop` path).
- **What the steward actually did:** ✅ **PARKED it** — the right outcome.
  - action = `park_card`
  - category = `escalation_production`
  - confidence = high
  - reason = *"Rule 3: the question touches the escalation bar (escalation_production) — only Kevin may decide this."*
  - Verdict line from the run: `[3] PASS  park-case  expected=park_card got=park_card`
  - ⚠️ **Honest caveat:** this case parks for the *right outcome* but arguably the *wrong reason*. It parks on the escalation keyword (Rule 3), not on the intended "no recommendation was offered" path. The card is correct; the stated reason is coarser than the real one.

**Run summary (observed):** `2 cases, 1 matched, 1 mismatched`.

---

## 3. The three artifacts, verbatim

A caution you must read before trusting these: because the classifier **parked** Case A (section 2), these three artifacts did **not** come out of the normal classify→act path. They were captured by a separate **diagnostic** in the proof that calls the *real* `extractRecommendation` and the *real* `executeAutoAnswer` directly on #1705's real text — i.e. it answers the question "*if* the classifier had routed this to auto-answer, exactly what would it have written?" So these artifacts prove the **answer machinery and the exact payloads are correct**; they do **not** prove the classifier would ever reach them on today's code (it does not — see section 5).

Observed before the artifacts:
- `extractRecommendation` on the real #1705 text → `{"strong":true,"text":"(B) with a deliberately long reclaim window (e.g."}`
- `executeAutoAnswer` return → `answered=true decisionWritten=true linePosted=true`
- ordered call log → `[answerNode -> recordDecision -> postOriginLine]`

### Artifact (a) — the answer handed to `answerNode`
```
nodeId: 1705
answer: "Go with your recommendation: (B) with a deliberately long reclaim window (e.g."
```

### Artifact (b) — the decision payload handed to `recordDecision`, field by field
```
nodeId   : 1705
treeId   : "tree-6afc7590"
question : "GUEST MESSAGING REVIEW GATE (tree-6afc7590 node #1705) — both reviewers agree on every fact; one item left is a product call only you can make.\n\nBOTH VERDICTS: FAIL, on this single open item. reviews/" …[5925 chars total]
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
For Case B (and, on today's code, Case A as well — both parked), `executeAutoAnswer` was **not** invoked and nothing was written:
```
recording-fake call log (positive evidence of no effects) = []  length=0
answerNode calls     = 0
recordDecision calls = 0
postOriginLine calls = 0
```

---

## 4. What was NOT touched

- **Live `jarvis.db` was never opened by this proof.** The proof is DB-isolated by construction: an import-hazard guard redirects every DB open to a throwaway `/tmp` file (this run: `/tmp/steward-proof-scratch-2318705.db`, named in the proof's own header). The live DB (`/home/kevin/paperclip/darwin-assistant/jarvis.db`, 673,509,376 bytes, mtime `2026-10-29 21:49:06 -0500`) is owned by the running engine; its mtime advances on its own from live traffic, independent of this proof. The guarantee it was untouched is the scratch redirect, which is stronger than a before/after on a file a live process writes every second.
- **No real node was answered or re-queued.** The only `answerNode`/`recordDecision`/`postOriginLine` calls in the whole run were against **recording fakes** in the diagnostic (section 3) — counts above. No `hopper_nodes` row changed status; no decision row was written to the live ledger; no origin thread received a post.
- **Nothing was deployed, and `jarvis.service` was never restarted.** This node wrote documentation and ran one existing script.
- **The live `/home/kevin/paperclip` checkout was never modified.** `git status --porcelain | wc -l` = **10** before this node, and this node touches nothing under `/home/kevin/paperclip` (it writes to the wiki outbox and commits one doc inside the separate worktree). It will read **10** again at the end.

---

## 5. 🔴 Honest limits — what this does NOT prove

Read this section twice; it is the most useful part of the document.

1. **The effects ran against recording fakes — so this proves the *decision* and the exact *artifacts*, not a live engine round-trip.** `executeAutoAnswer` was handed stand-in `answerNode`/`recordDecision`/`postOriginLine` functions that only record what they were called with. We have proven *what the steward decides and the exact payloads it composes*. We have **not** proven that, wired to the real engine, the node's status actually flips, the decision actually lands in `jarvis.db`, and the line actually appears in the origin thread.
2. **On today's branch code, the end-to-end classifier does NOT auto-answer the real auto-answer case — it parks it.** This is the single most important caveat. Node #1705's real text trips three independent keyword false-positives before the "has_recommendation" rule ever runs: `\bproduction\b` ("…while production would store…", describing a bug), `\bdrop\b` ("(A) DROP THE RELEASE", a code step not a DB drop), and the test/DB fence keyword `migrat` ("migrations are sound"). Rule 3 (escalation) short-circuits and returns `park_card`. So the three auto-answer artifacts in section 3 describe a path the classifier currently never reaches. **Net effect for you: a deploy today is safe but conservative — it will card/park, and will not auto-answer #1705-style cases until this over-eager matching is tightened.** The fixture was not bent and the question was not reworded to hide this.
3. **The per-tree cap, the lane, and the never-answer-twice memory were proven in #382, not here.** This end-to-end run did not re-exercise them.
4. **The morning rollup was proven in #383, not here.**
5. **The steward ships in card-only (shadow) mode.** On the first live run it will raise a park/shadow card showing what it *would* have replied, rather than answering — until you flip the setting `steward_mode` to the exact string `live`.
6. **The one thing no branch-side proof can establish is the real engine round-trip** — a genuine blocked_question flowing through the running engine into the steward and back out as a real answer + real ledger row + real origin post. That is precisely what the #385 deploy will show.

---

## 6. Your next step

Deploy node **#385**, in this order:
1. **Build `dist`** from `feat/tree-steward` (compiled output, no source edits).
2. **Restart via a transient unit** (a one-shot `systemd-run` transient service), not a hand restart of the live `jarvis.service`.
3. **Watch in card-only mode for a shadow run** — leave `steward_mode` unset/≠`live` and confirm real blocked_questions produce steward cards with sane verdicts (and that the over-eager parking in limit #2 is acceptable or gets its keyword fix first).
4. **Flip to live** by setting `steward_mode` to exactly `live` once the shadow cards look right.

**Known double-bell (not a blocker):** the engine already raises its own generic ❓ "needs your call" bell for *every* blocked_question (`src/hopper-engine.ts` ~L1472), and the steward card raises its own — so a parked question currently rings **twice**. The one-line fix is left for your review because that engine file is owned by another tree tonight: either set `steward_card_suppresses_engine_bell` to `on` (today this only *labels* the generic bell as redundant in the card body — it does not silence it), or add a one-line guard at `hopper-engine.ts ~L1472` to skip the generic bell when a steward card was raised for that node. Your call which.

---

**Read this first:** the steward's judgment and the exact records it writes are proven on real text and it is safe to deploy — but on today's code it parks the real auto-answer case rather than answering it, so expect a conservative, card-only shadow run first, and let #385's live round-trip be the thing that finally proves the end-to-end path.
