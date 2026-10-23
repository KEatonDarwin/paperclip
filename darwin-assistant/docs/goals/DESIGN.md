# GOALS — goal-driven development surface (v0 design, JARVIS on Fable 5.1, 2026-09-19)

**Status:** designed + build tree planted 2026-09-19 (thread `cockpit:fff28b3e-f3ba-41ed-a2a7-da8824c72e1b`). This doc is the CONCEPT + VISUAL spec. `CONTRACT.md` (written by the tree's first node) is the binding data/API/tool contract. Build fresh — this is a NEW front end for the cockpit, NOT a reuse of Workbench / Smart Todo Tree / Flight Deck / thread-todos. The ONLY cockpit asset it may reuse is the thread chat pane (the conversation itself).

## Kevin's ask (verbatim, 2026-09-19)

> "Goal driven development. So instead of coming to you and saying 'I want you to do this specific thing' I think I want to start with a goal. Even if it's a big long term goal, starting with *one* point on a tree and then proceeding from there… the top of that tree would be that goal, and it would stay there. But we would continue to break down the tasks based on what we are supposed to do next to reach that goal… Each level is a new sub-goal on its way to the top goal… A family tree kind of thing."

> "If I say something to you initially to create these goals, you'd have access to look at the whole goal tree and basically be like 'well what you're asking seems to fit under here, this is what I'm suggesting' and would suggest a new branch/edit to a tree. Like physically show it to me on the tree, and I would either confirm it, or we'd talk about it a little bit more and watch it change a little more until I'm like 'Yep I'm good with this if you are' and then it would turn from something that's a lighter/gray/dotted/temporary color to something that's set in stone."

> "One thread per ultimate goal. Keep it simple. That thread boots up with links to the skills that you need… Then once we get to certain levels of building and I'm thinking I want to start working on it, I can tell you (or click a button next to) that I want to start working on this specific branch… you can spawn tree all of the ones that you think you can do. And each of them are color coded, like 'spawn tree - working…' and clicking on it would open the spawn tree itself… there should be an approval layer between us talking and it being put into the system for development."

> "I think one main big goal oriented chat, whose job it is to make sure it does every possible thing to help reach that goal, makes it simpler… overdoing it is what caused me to sour on the workbench v2 thing so quickly (a chat for everything…)"

> "Then I can start my day looking at the tree, picking which thing I want to work on by simply clicking on it, opens the chat that I'm working with you in with the full tree on the right in a widget… click on it so it's selected, and then I just type in the chat normally 'This thing here, I'm not too sure about. Let's talk it out' and based on what I have selected (a flag in the back end maybe) you would know what I've selected."

> "I like the idea of the UI being a split screen tree on the right, chat on the left. It should be a totally different view than this view we are in now. Like a whole different button opens the tree view, and selecting a goal slides the tree over to the right and the chat shows up on the left. And that's it. No multi chat choosing just yet… Let's roll with all of this, don't reuse anything we have. This is essentially a new front end for the cockpit itself… My brain goes to smiling if something is easy to navigate and has an intuitive feel. The whole goal here is to find something that makes us both very efficient with each other, but also keeps me pushing forward without losing my spot."

## The model (locked with Kevin 2026-09-19)

**Three objects, nothing else.**
- **Goal** — a root. Never a task. Has a `done_means` sentence (REQUIRED to become set; a goal without one stays a ghost). Owns exactly ONE chat thread, forever (`cockpit:goal-<id>`).
- **Node** — anything under a goal, any depth. Fields: `title`, `done_means` (one line, required to become set), optional `notes`, `state`, `leaf_kind`, children.
- **Focus** — a server-owned pointer (goal → one node, or none). Clicking a node sets focus. Focus is injected into every turn of the goal chat. **Pointing is not talking: click = zero model calls, zero thread creation.** Focus is what replaces sub-chats.

**Two approvals, and only two.**
1. **Shape.** Anything JARVIS adds / removes / rewords is a **ghost** (dashed, dimmed). Kevin: ✓ sets it, ✕ discards it, or keeps talking and it morphs. Batch ghosts get a "✓ all". Kevin's own typed nodes are NEVER ghosts — set on arrival (`authored_by=kevin`). JARVIS edits to a SET node render as a pending diff (old → new) until ✓. JARVIS removals render as a pending strike until ✓.
2. **Go.** A machine leaf gets a **ghost Plan card** from JARVIS (what gets built, deliverable, model tier, rough cost/time). Kevin approves → node flips `working` and a hopper tree is planted + linked. Click the working badge → the spawn tree opens in an overlay. Tree finishes → node flips `check` (NOT done). Verified against `done_means` (Kevin's ✓ or JARVIS's verify op) → `done`.

Nothing else asks Kevin for anything.

**One layer ahead, never two.** After a node is set, JARVIS proposes its children. Never grandchildren. Depth appears only when we walk into a branch. The tree grows exactly as fast as it's worked. (This is the anti-graveyard rule.)

**Two kinds of leaf.** A node stops splitting when it is one of:
- **machine** — JARVIS can write the spec with no questions → gets a Plan → spawn tree.
- **human** — only Kevin can do it (call someone, approve a merge, decide which table is truth). Amber. These ARE Kevin's day list.
If neither, it splits one more level. That's the entire decomposition rule. `leaf_kind` is a real column the system reasons about.

**Every node has a `done_means`.** Without it the tree is a nested todo list. With it, every level is a real sub-goal and completion is verifiable. Required at every level to become set.

**Promotion is the only escape hatch.** A branch that becomes its own world is PROMOTED to a Goal (its own chat, link back to the parent node). No sub-chats in v1.

**The tree is JARVIS's memory.** The goal chat boots from the goal + tree snapshot, never the transcript. Every turn JARVIS reads the tree + focus, so the chat can run long without drift.

**📌 PINNED (Kevin, not v1):** Kevin's own nodes being weigh-in-able by JARVIS ("I'd want you to see the good and the bad in it… maybe we both agree and it locks in"). Keep `authored_by` on every node so v1.1 can add a JARVIS take on Kevin-authored nodes. Do not build the weigh-in loop in v0.

## Node state machine

`ghost → set → (leaf only) planned → working → check → done` · plus `parked` from any set state · `discarded` from ghost.
- Non-leaf `set` nodes auto-flip to `check` when every child is `done` (server rule), then Kevin/JARVIS verify → `done`.
- Goal `status`: `ghost | set | done | parked`; goal `done` only when root's done_means is verified.
- `plan_state` on a machine leaf: `none | proposed | approved`. `tree_id` links the hopper tree once dispatched.
- Pending JARVIS edits: `pending_title` / `pending_done_means` / `pending_removal` on a set node until ✓/✕.

## The goal chat contract (→ `skills/goals/SKILL.md`, written by the build)
In order, in every goal chat: (1) clarify until the goal's `done_means` can be written in one sentence (bounded: ~3–5 questions); (2) propose the first layer as ghosts; (3) push back when a branch doesn't serve the root (devil's advocate is part of the job); (4) propose the next layer under whatever is FOCUSED, never deeper; (5) decide leaf kind when a node can't split; attach a ghost Plan to machine leaves; (6) after any tree finishes, verify against `done_means` before ✓; (7) the focus header is in every turn — "Talking about: <path>" — Kevin never has to say which node he means. JARVIS never writes a real node directly unless Kevin dictated it verbatim.

## The visual (own UI, own shell)

**Entry:** a NEW top-level cockpit button/route **`/goals`**. It opens its OWN shell — no left thread sidebar, no right todo panel, no provider-usage widget. Slim top bar: `◀ Cockpit` · "Goals" · (on a goal page) goal title + status pills (`N working · N need you · 62%`).

**Forest page (`/goals`):** one card per goal — title, done_means (muted), a thin progress ring, counts (working / need you / ghosts waiting), last activity. Ghost goals render dashed. `+ New goal` = a single title input; Enter creates a ghost goal and lands in its chat, where JARVIS's first message asks the clarify questions. Clicking a card **slides** the tree in from the right and the chat rises on the left (one motion, ~250ms).

**Goal page (`/goals/$goalId`):** split. Chat left (~55%), tree right (~45%), draggable divider, remembered per goal. The chat is the cockpit's normal thread conversation (reuse `ThreadPane`'s conversation rendering) for thread `cockpit:goal-<id>`, but rendered inside THIS shell.

**The tree panel:** a vertical outline drawn as a canvas — root goal pinned at top as a header card (title, done_means, progress ring). Below it, nodes as rows with depth indentation and connector lines. **Zoom = collapse:** everything folds except the path root → focused node + the focused node's children; sibling branches collapse to compact chips with a count badge. Click a chip to unfold. Smooth height animation, never a page reload.

**Node row anatomy:** state dot · title · (leaf-kind glyph) · done_means on a muted second line (truncate to one line, expand on focus) · right-side affordances that appear on hover/focus: ✓ / ✕ on ghosts, `Plan ▸` on machine leaves without a plan, `Approve` on a proposed plan, `Done` on human leaves, `Verified ✓` on `check`, `⋯` menu (park / promote to goal / edit). Ghost rows: dashed border, ~50% opacity, gray dot. A ghost BATCH shows a thin bracket with `✓ all` / `✕ all`.

**Colors (dark theme, match the cockpit's palette):** ghost = dashed gray · set = solid neutral · machine leaf = blue dot · human leaf = amber dot + amber left rail · working = blue **pulsing** ring + "spawn tree · working…" pill (click → spawn-tree overlay, never navigate away) · check = violet "check this" pill · done = green, row dims · parked = muted italic. Pending edit = old text struck, new text beside it, ✓/✕.

**Focus:** click a row → it highlights, the tree zooms to it, and a chip appears above the composer: `Talking about: Create monitoring ✕`. Esc clears focus. ↑/↓ move focus among visible rows. Enter zooms in, Backspace zooms out one level. Focus is POSTed to the server (server-owned), not just local state.

**Plan card (ghost):** rendered under the machine leaf as a dashed card — what / deliverable / model / est. Approve → `working` immediately (tree planted server-side), card becomes the working pill.

**Feel targets:** zero modal dialogs in the main loop; every approval is a single click on the row; the tree never shows more than ~15 rows at once (collapse rule); nothing on the page ever requires knowing an ID.

## Non-goals (v0)
Sub-chats · multi-goal cross-ranking by money · mobile layout · nudge/morning-brief integration · the Kevin-node weigh-in (pinned) · editing the hopper tree from inside Goals (overlay is read-only) · migrating anything from Workbench/Smart Todo Tree.

## Deferred scope (recorded, not built)
- Kevin-authored node weigh-in loop (pinned by Kevin).
- Morning brief leads with "amber leaves: N".
- Auto-verify `check` nodes via a cheap one-shot against done_means.
- Money-at-stake on goals + forest ranking.
