# WORKBENCH — decisions & deferred items

Append-only. Each entry: what came up, what was decided, why.

---

## R1 — `src/smart-todos.ts` may grow additively (review node #444, 2026-09-18)

**Came up:** Kevin's hard constraint says `/tree`, `/api/v1/smart-todos/*` and the
`smart_todos` tool stay byte-for-byte unchanged. The build modifies `src/smart-todos.ts`.

**Decided:** keep it. SPEC.md's "Data decision" explicitly authorises additive nullable
columns on the shared table, and every edit is strictly additive (3 columns, one `export`
keyword, one new function + statement). No existing statement, signature, return shape or
route changed. `/tree`'s only observable delta is 3 extra nullable keys on `GET /smart-todos`,
which its client mapper ignores. The three named surfaces — the `/tree` route file, the
`/smart-todos/*` handlers, the `smart_todos` tool — **are** byte-for-byte unchanged.

**Escape hatch if Kevin disagrees:** the SPEC already names it — a separate `workbench_nodes`
table + copy script. Cost: the Workbench stops being *his* tree and becomes a divergent copy,
which is the thing the spec was written to avoid. Flag it to him in one line; don't re-litigate.

---

## D1 — DEFERRED: zooming eagerly creates a thread (and a group) for that node

**What:** `/workbench`'s docked-chat effect calls `POST /workbench/:id/open-chat` on **every**
zoom change. So merely *browsing* the tree — clicking node to node to read it — mints a real
cockpit conversation per node visited, and a cockpit group per root branch touched. Ten
exploratory clicks = ten threads in Kevin's sidebar.

**Why it's built that way:** the docked bar renders a live `Timeline`, which needs a thread to
exist before it can show anything. Lazy binding would need an empty-state bar that
materialises the thread on first send.

**Not fixed here because:** it's a structural change to the bar's lifecycle, not a small safe
fix, and the current behaviour is *correct* (find-or-create, never a duplicate) — just noisy.

**Remediation when picked up:** render the composer with no thread bound; call
`openWorkbenchNodeChat` inside `handleSend` on first message (and on "Open chat"); keep the
`chatBindingKeyRef` stale-guard. Alternatively bind eagerly only if the node already has a
`linkedThreadExt`, else lazily. ~30 min.

---

## D2 — DEFERRED / KNOWN: the scope guard is advisory, because `smart_todos` sits next to it

**What:** the `workbench` tool's subtree scope guard is genuinely load-bearing and correct
(both target *and* destination checked, scope derived server-side from the thread binding,
unspoofable from arguments). But the **`smart_todos` tool is registered globally in
`ALL_TOOLS`**, so the same scoped chat also holds an *unrestricted* tool that can move, edit
or delete any node in the tree. A model that hits the scope refusal can route around it.

**Why it's not fixed:** narrowing `smart_todos`' exposure means changing the `smart_todos`
tool — Kevin's #1 constraint forbids exactly that in this build.

**Judgement:** acceptable for v1. This is a *correctness railing for a cooperative model*, not
a security boundary — every one of these chats is Kevin's own, and the pre-existing
`smart_todos` exposure is unchanged from today. The seed text explicitly tells the model to
report a refusal rather than work around it, which is the real mitigation.

**Remediation when picked up:** a per-conversation tool allowlist (omit `smart_todos` from
threads that have a `linked_thread_ext` binding), which is a harness change, not a
`smart_todos` change — so it does not violate the constraint.

---

## D3 — MINOR: a pre-existing `/tree` chat never receives the Workbench contract

**What:** `/workbench/:id/open-chat` returns `reused: true, seed_text: null` when the node
already has a live thread. For a node whose chat Kevin first opened from `/tree`, that thread
was seeded with the plain `/tree` text and will never be told it is scoped, never told about
`read_up`, never told to write auto-notes. It still *behaves* correctly (server-side scope
resolution is independent of the seed) — it just won't volunteer the Workbench behaviours.

**Decided:** leave it. Re-seeding a live conversation mid-history is worse than the gap, and
the population is small (nodes chatted from `/tree` before this ships).

**Remediation if it bites:** on `reused`, return a short one-paragraph "you're now a Workbench
chat" addendum the UI posts once, guarded by a flag on the node so it never repeats.

---

## D4 — MINOR: `match_key` is read but never written

`buildShortlist` scores a `match_key` hit at 100, but nothing in the backend, the tool, or the
UI ever *sets* `match_key`. The column is currently inert; placement runs on title substring +
token overlap only. Harmless (dead weight, not a wrong answer). Wire it when there's a reason
to — e.g. an `update` op field, or auto-slugging root branch titles.

---

## D5 — MINOR: placement one-shots always use Claude account A

`runClaudeOneShot` in `workbench.ts` does not set `CLAUDE_CONFIG_DIR`, so the placement call
bypasses the least-used account selector and always burns account A. Consistent with the
pre-existing `smart-todos-decompose.ts` / `briefing.ts` / `jarvis-brief.ts` one-shots, so this
is parity, not a regression. Worth folding all four onto the account selector in one pass.
