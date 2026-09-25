# Notepad — the topic dossier contract (goal 6, node #107)

This document defines, precisely enough for a stranger to implement without a
follow-up conversation, what a **topic dossier** is, its structural guarantee
against hallucination, the shape of its TypeScript interface, how confidence
levels are assigned, and the evidence sources it draws from. Node **#863**
(topic resolver + evidence gathering) and node **#107** (dossier assembly with
anti-hallucination validation) together implement exactly this contract. Node
**#108** (the marker click consumer) is the primary consumer this contract
exists to make safe.

---

## 1. What a topic dossier is, and the bar it must clear

A **topic dossier** is the context bundle JARVIS opens the moment Kevin clicks
a notepad marker — the ready-made briefing that appears in a new conversation
thread. It exists to answer the question "what is this line about, and what do
we already know about it?" *before* the conversation even starts typing. A user
reading it should never need to follow up with "what do you mean?" — the
dossier either has oriented them already, or has honestly admitted it can't yet.

**The bar this contract enforces:**

1. **No hallucination.** Every `repo`, `branch`, `goal`, and `prior_work`
   entry must be provably drawn from evidence the system already holds. A dossier
   must never invent a branch name, a repo, or a node reference just because
   the text looks like it *might* refer to something similar. When in doubt,
   omit it.

2. **Confidence is meaningful.** A dossier signals its own certainty via a
   three-tier confidence level: `none` (no context at all), `weak` (some context,
   but gaps), or `strong` (goal/tree linked AND repo/branch identified). A
   consumer can trust that `strong` means both dimensions of context are known,
   and `weak` means JARVIS is aware of the topic but lacks complete context.

3. **Honesty about what isn't known yet.** The dossier includes an
   `unresolved_reason` field when a model call failed or was rejected; a consumer
   can see whether "JARVIS needs to think about this" is "still processing" or
   "the evidence contradicted the model's draft."

4. **Deterministic fallback if the model invents.** The one permitted model
   call (for narrative prose and an open question) is validated against the
   evidence corpus; if it cites any branch, repo, or node reference that
   isn't literally present in the evidence, the entire model output is discarded
   and the dossier falls back to a pure-evidence deterministic render. A rejected
   model call never produces a dossier worse than the deterministic floor.

---

## 2. The TopicDossier shape (field-by-field)

```typescript
interface TopicDossier {
  line_id: number | null;
  text: string;
  topic: string | null;
  confidence: DossierConfidence; // 'none' | 'weak' | 'strong'
  repo: string | null;
  branch: string | null;
  goal: { goal_id: number; node_id: number | null; title: string } | null;
  prior_work: string[];
  open_question: string | null;
  evidence: DossierEvidence[];
  availability: SourceAvailability[];
  rendered: string;
  unresolved_reason: string | null;
}
```

**Field descriptions:**

- **`line_id`** — the `notepad_lines.id` this dossier was built for, or null if
  built from raw text. Used to correlate markers and actions back to their
  source line.

- **`text`** — the notepad line text (trimmed) that triggered this dossier.
  Preserved so the consumer can verify "this dossier is actually about the line
  I clicked."

- **`topic`** — the resolved topic (a non-empty string) if the line's tokens
  matched anything in the goals/trees/threads corpus, or null if the line is
  too generic or novel. See §3 for resolution logic.

- **`confidence`** — one of `'none'`, `'weak'`, or `'strong'`. Assigned per §3;
  reflects whether JARVIS has located both structural context (goal/tree) and
  implementation context (repo/branch), or only one, or neither.

- **`repo`** — the repository name (e.g. `'darwin-assistant'`) if evidence
  explicitly named one, or null. Extracted only from evidence text; never
  guessed. Taken from the highest-scored evidence row that named a repo.

- **`branch`** — the branch name (e.g. `'hopper/notepad'`) if evidence explicitly
  named one, or null. Extracted only from evidence text; never guessed. Taken
  from the highest-scored evidence row that named a branch.

- **`goal`** — an object with `goal_id`, optional `node_id`, and `title` if
  evidence found a goal or a hopper tree node, or null if neither. A tree
  reference resolves to the tree's most-recent node's goal context (via
  `goal_nodes.tree_id` → `goal_nodes.goal_id`). If the evidence contains a goal
  row directly (from goals, goals_members), `node_id` is null. If the evidence
  contains a tree row, `node_id` is populated from the tree's latest node.

- **`prior_work`** — an array of up to 5 short descriptions (title + first 160
  chars of snippet) of what's already known, in evidence score order. Includes
  goal rows, tree rows, and thread_summary rows *only* — orientations are
  reference material, not "work that happened," so they are excluded. Empty if
  no evidence of these kinds exists. This is the "here's what we've been
  tracking" summary for the marker click.

- **`open_question`** — a single, well-formed question (or null) that the model
  drafted based on the evidence, if the model call succeeded and passed
  validation (§4). If the model was never called, failed, or rejected, this is
  null. The question is scoped to what the evidence alone can meaningfully ask.

- **`evidence`** — the array of `DossierEvidence` rows that were gathered (up to
  12, scored and sorted). See §4 for the shape.

- **`availability`** — the array of `SourceAvailability` rows, one per source
  kind ('goal', 'tree', 'thread_summary', 'orientation', 'recall'), indicating
  whether each source was reachable and why it may have failed (if it did). Used
  for observability and debugging when a dossier comes back empty or thin.

- **`rendered`** — the plain-text rendering of the dossier, ready to display to
  a user (or post as a thread briefing). See §5 for the rendering logic.

- **`unresolved_reason`** — null if the model call succeeded and its output was
  accepted, or a short string explaining why it was rejected (e.g. `"model
  output rejected: cited unknown branch 'sandbox/typo'"` or `"model call
  failed: timeout after 25s"`). Used by a consumer to understand whether the
  dossier is "complete as-is" or "still processing."

---

## 3. Confidence levels

Confidence is assigned based on what the deterministic evidence actually proves:

- **`'none'`** — `topic` is null (the line is too generic or novel). No
  evidence-gathering is even attempted. `repo`, `branch`, `goal`, and
  `prior_work` are all null/empty. A `'none'` dossier is honest: "I have no
  idea what this is about yet."

- **`'weak'`** — `topic` is not null, and at least one source (goal, tree,
  thread_summary, orientation, or recall) returned evidence. But the evidence
  either lacks a linked goal/tree OR lacks a repo/branch name. Examples:
  - Evidence found a goal but no repo/branch was mentioned in any of its
    context rows.
  - Evidence found a tree (which implies a goal), but the tree's context
    didn't mention a repo or branch.
  - Evidence found thread_summary or orientation rows mentioning the topic,
    but no goal/tree context and no repo/branch.
  A `'weak'` dossier is saying: "I know what this is *about*, but not where
  the work is happening, or I know the work location but lack the structural
  goal context."

- **`'strong'`** — evidence found *both* a goal or tree (structural context)
  *and* a repo or branch (implementation context). This is the highest
  confidence: JARVIS has oriented the marker click to a real, specific piece of
  work happening in a specific place.

The confidence level is computed as:
```
foundGoalOrTree = evidence.some(e => e.kind === 'goal' || e.kind === 'tree')
foundRepoOrBranch = repo !== null || branch !== null
confidence = foundGoalOrTree && foundRepoOrBranch ? 'strong' : 'weak'
```

(And `'none'` is set independently when `topic` is null.)

---

## 4. Evidence sources and availability

The evidence-gathering phase queries five sources, each with its own contract:

| Source | Kind | What it provides | When available | Failure mode |
|---|---|---|---|---|
| **Goals** | `'goal'` | Goals the line's tokens match (via goals.title tokens) | Always attempted | No matching goals exist (returns empty) |
| **Goal trees** | `'tree'` | Hopper trees linked to goals (via goal_nodes.tree_id) | Always attempted | No active trees exist (returns empty) |
| **Thread summaries** | `'thread_summary'` | Recent thread_summary rows where the line's tokens appear in the summary text | Always attempted | No recent threads (returns empty) |
| **Orientations** | `'orientation'` | Orientation docs from the knowledge base (fetched via MCP, cached) | Attempted if MCP is reachable | MCP unavailable → reason: "orientation source unavailable: …" |
| **Recall (memory)** | `'recall'` | Prior user notes or structured memory (future implementation) | Attempted if reachable | Not yet wired (returns empty, reason: "recall not yet implemented") |

Each source kind appears in the `availability` array exactly once, with:
- **`kind`** — one of `'goal'`, `'tree'`, `'thread_summary'`, `'orientation'`, `'recall'`
- **`available`** — true if the source returned results or was successfully queried,
  false if it failed or was unreachable
- **`reason`** — if `available` is false, a short explanation (e.g.,
  `"orientations unavailable: MCP call timed out"`)

The evidence gathering always attempts the deterministic sources (goals, trees,
threads). Orientation and recall sources are optional; if they fail, the
dossier proceeds with whatever evidence the deterministic sources found.

---

## 5. The anti-hallucination rule

**The one model call this contract permits** produces exactly two fields:
`narrative` (1-3 sentences of context prose) and `open_question` (a single
clarifying question, or null). Before accepting these fields into the dossier,
they are validated against the evidence corpus using this rule:

**Every branch name, repository name, and node reference (`#<digits>`) that
appears anywhere in the model's narrative or open_question must be one that
appears literally in the evidence text the model was shown.** If even one
invented token is found, the entire model output is discarded and the dossier
falls back to the deterministic renderer.

**Why this matters:** A model output like `"You're working on a fix for the
perclickity/feature-x branch"` is accepted only if the evidence text (the goal
title, the tree snippet, the thread summary, etc.) actually contains the string
`"perclickity/feature-x"`. If the evidence only mentions `"perclickity"` and
the model invents the `/feature-x` suffix based on its training data's
plausibility, the entire output is rejected.

**Validation steps:**

1. Extract every `repo-shape-token` (one of the known repo names) from the
   model's combined narrative + open_question text.
2. Extract every `branch-shape-token` (e.g. `hopper/notepad`, matching the
   pattern `/\b(?:hopper|sandbox|perclickity|mbi|bi)\/[a-z0-9][a-z0-9._-]*/i`)
   from the model's text.
3. Extract every `#<digits>` reference from the model's text.
4. For each extracted token, verify it is literally present in the evidence
   corpus (every `DossierEvidence` row's `ref`, `title`, and `snippet`, plus
   any evidence the goal referenced by the dossier itself).
5. If any token is not found, return `{ ok: false, reason: "model output
   rejected: cited unknown branch 'X'" }` and fall back to the deterministic
   renderer.
6. If all tokens validate, accept the model output and include it in the
   rendered dossier.

The `unresolved_reason` field captures the validation failure if one occurs.

---

## 6. Rendering

A dossier is rendered into the `rendered` field as plain text, ready for
display. The rendering flow is:

1. **If `topic` is null:** render the `renderNoneConfidence` template:
   ```
   JARVIS has no context on this line yet -- "the line text here" doesn't
   match anything in goals, trees, or recent threads. Starting cold; nothing
   prior to draw on.
   ```

2. **If `topic` is not null:** render a deterministic template with:
   - Topic name
   - Goal info (if `goal` is not null): `Goal #<id>: <title>` or
     `Goal #<id>, node #<node_id>: <title>`
   - Repo/branch (if either is not null): `Repo/branch: <repo> @ <branch>`
   - Prior work (if `prior_work` is not empty): a bullet list of up to 5
     work items
   - Narrative (if `narrative` is not null): the model's prose (accepted after
     validation)
   - Confidence caveat (if `confidence` is `'weak'`): "JARVIS does not know:
     <list of missing dimensions>"
   - Open question (if `open_question` is not null): `Open question: <text>`

The rendering is deterministic: the same `TopicDossier` input always produces
the same `rendered` output. The order is: topic, goal, repo/branch, prior work,
narrative, caveat, open question.

---

## 7. Examples

### Example 1: Strong confidence with model narrative

**Input line:** `"refactor perclickity/dossier logic to handle cross-pool scenarios"`

**Gathered evidence:**
- Goal #127 "Perclickity media-buy rollout" (score 8.5)
- Tree tree-6ecf478c "Governor cross-pool diversion" (score 7.2)
- Thread summary about diversion logic (score 6.1)

**Evidence repo/branch:** `perclickity/dossier` extracted from line text itself

**Model call accepted:**
- Narrative: "The media-buy system needs to route requests to idle pools when
  the primary pool hits a ceiling. This refactor covers the routing logic that
  decides pool assignment."
- Open question: "Should the fallback pool selection prefer oldest-idle or
  best-latency?"

**Rendered output:**
```
Topic: perclickity media buy pool routing
Goal #127: Perclickity media-buy rollout
Repo/branch: perclickity @ dossier
Prior work:
- Media-buy system pool management and fallback logic (score 7.2)
The media-buy system needs to route requests to idle pools when the primary
pool hits a ceiling. This refactor covers the routing logic that decides pool
assignment.
Open question: Should the fallback pool selection prefer oldest-idle or
best-latency?
```

**Dossier fields:**
```json
{
  "line_id": 42,
  "text": "refactor perclickity/dossier logic to handle cross-pool scenarios",
  "topic": "perclickity media buy pool routing",
  "confidence": "strong",
  "repo": "perclickity",
  "branch": "dossier",
  "goal": { "goal_id": 127, "node_id": null, "title": "Perclickity media-buy rollout" },
  "prior_work": [
    "Media-buy system pool management and fallback logic (score 7.2)"
  ],
  "open_question": "Should the fallback pool selection prefer oldest-idle or best-latency?",
  "evidence": [ /* 3 rows */ ],
  "availability": [
    { "kind": "goal", "available": true },
    { "kind": "tree", "available": true },
    { "kind": "thread_summary", "available": true },
    { "kind": "orientation", "available": false, "reason": "orientation cache miss, skipping for now" },
    { "kind": "recall", "available": false, "reason": "recall not yet implemented" }
  ],
  "rendered": "Topic: perclickity media buy pool routing\n...",
  "unresolved_reason": null
}
```

### Example 2: Weak confidence, no model output

**Input line:** `"look at the jarvis setup"`

**Gathered evidence:**
- Goal #5 "JARVIS ntfy alert channel" (score 6.8)
- Thread summary about JARVIS deployment (score 5.2)

**Evidence repo/branch:** None (neither goal nor thread named a specific repo)

**Model call rejected:**
- Model narrative: "The setup for JARVIS's ntfy integration needs to be wired
  into the live hopper/foundry branch so alerts fire on deploy."
- Validation failed: "model output rejected: cited unknown branch 'hopper/foundry'"
  (evidence only mentioned `hopper` in commit hashes, not as a branch)

**Rendered output:**
```
Topic: jarvis ntfy alert channel setup
Goal #5: JARVIS ntfy alert channel
No prior work found in goals, trees, or recent threads.
JARVIS does not know: no repo or branch named in the evidence.
```

**Dossier fields:**
```json
{
  "line_id": 58,
  "text": "look at the jarvis setup",
  "topic": "jarvis ntfy alert channel setup",
  "confidence": "weak",
  "repo": null,
  "branch": null,
  "goal": { "goal_id": 5, "node_id": null, "title": "JARVIS ntfy alert channel" },
  "prior_work": [],
  "open_question": null,
  "evidence": [ /* 2 rows */ ],
  "availability": [ /* 5 rows, all available: true */ ],
  "rendered": "Topic: jarvis ntfy alert channel setup\n...",
  "unresolved_reason": "model output rejected: cited unknown branch 'hopper/foundry'"
}
```

### Example 3: No confidence (no topic)

**Input line:** `"remember to call Mike tomorrow"`

**Gathered evidence:** None (the line's tokens are all stopwords: "remember",
"call", "tomorrow", "mike" — "mike" is a name, not a goal/tree token)

**Rendered output:**
```
JARVIS has no context on this line yet -- "remember to call Mike tomorrow"
doesn't match anything in goals, trees, or recent threads. Starting cold;
nothing prior to draw on.
```

**Dossier fields:**
```json
{
  "line_id": 99,
  "text": "remember to call Mike tomorrow",
  "topic": null,
  "confidence": "none",
  "repo": null,
  "branch": null,
  "goal": null,
  "prior_work": [],
  "open_question": null,
  "evidence": [],
  "availability": [
    { "kind": "goal", "available": true },
    { "kind": "tree", "available": true },
    { "kind": "thread_summary", "available": true },
    { "kind": "orientation", "available": true },
    { "kind": "recall", "available": true }
  ],
  "rendered": "JARVIS has no context on this line yet ...",
  "unresolved_reason": null
}
```

---

## 8. Integration — how node #108 consumes a dossier

Node #108 (the marker click handler) receives a `TopicDossier` and uses it to:

1. **Pre-populate the new thread's context** by feeding the `rendered` field
   into the opening message/briefing so the conversation starts already
   oriented.

2. **Check `confidence`** to decide whether to signal to Kevin that JARVIS
   "is only partly sure" (`weak`) or "has a full picture" (`strong`).

3. **Use `goal.goal_id` and `goal.node_id`** (if present) to link the thread
   back to the goal system, so work can be reconciled against the original goal
   if it's acted upon.

4. **Check `unresolved_reason`** to surface warnings to Kevin if the model
   couldn't draft a narrative ("still thinking" vs. "I found evidence but the
   model made something up").

5. **Use `evidence` and `availability` for observability:** if a dossier is
   unexpectedly thin, the availability array shows which sources failed and why.

6. **Store the `line_id` and `text`** in the thread's own state (or markers
   table) so later reconciliation can match actions back to the original line.

The dossier is a read-only briefing; node #108 does not modify it.

---

## 9. Out of scope here

This document defines the dossier shape, confidence levels, evidence sources,
the anti-hallucination rule, and the rendering contract. It deliberately does
**not** define:

- **Topic resolution details** — how tokens are extracted from a line, how
  stopwords are filtered, and how the registry is queried. That is node **#863**.
- **Evidence gathering details** — how to fetch and cache orientations, how to
  score evidence, how to extract repo/branch tokens from arbitrary text. Also
  node **#863**.
- **The model call itself** — what prompt is used, what tone is requested, how
  the model is invoked (CLI vs. API), what model version is configured. That
  is node **#107**'s implementation.
- **The marker click flow** — how a marker is rendered, how it responds to
  clicks, how the thread is created and the dossier is posted into it. That is
  node **#108**.

Implementing any of those here would be scope creep on a node whose job is the
contract, not the implementation details.
