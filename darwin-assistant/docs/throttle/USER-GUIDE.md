# ⚡ Throttle — user guide

Where: `/settings/governor`, new **⚡ Throttle** section at the top (the existing governor
panel stays below it, unchanged). This is your manual control over how hard the autonomous
worker pool runs — not a smarter governor, just dials you turn yourself. Every change here
takes effect on the **next dispatch tick** — no restart, ever.

## The dials

**Presets** — four buttons across the top. Click one and it's applied immediately.

- **Turned up** — 6 workers, 2 per goal, ceilings wide open (5h 95%, weekly 85%, active-max
  95%), Claude runs Ordered A→B. Use this when you can see from your own usage meters that a
  window is about to reset with capacity going unused — "spend it."
- **Normal** — 2 workers, weekly protected at 30%. This is today's baseline behavior.
- **Conserve** — 1 worker, tight ceilings (5h 60%, weekly 15%). Use before a window you need
  to protect (e.g. saving weekly capacity for something specific later).
- **Overnight** — 4 workers, 2 per goal, Claude splits evenly across both subscriptions
  (A, B). Use when you're stepping away for a while and want both accounts to carry the load.

A preset only touches the dials it lists — anything it doesn't mention is left exactly as it
was. `Conserve` deliberately never touches which Claude account is in use.

**Slots** — total simultaneous workers, 1–12. Shown as `N running / M slots`, plus the
effective **admission cap** next to it. You'll never see slots go above 12 — it clamps, it
doesn't error.

**Per-goal / per-tree caps** — the max number of workers that can be running on one goal (or
one un-goaled tree) at once. `0` means unlimited — that's the default and matches today's
behavior. Raise the per-goal cap when one big goal is hogging every slot and you want other
work to get a turn too.

**Account mode** — how Claude worker/turn dispatch picks between your two subscriptions (A/B):

- **Auto** — least-used account wins. Today's behavior.
- **A only (holds when A is spent)** — everything stays on A. If A runs out, work HOLDS — it
  does **not** spill onto B. Pick this when you specifically want to protect B (e.g. it's
  mid-migration, or you're saving its weekly window for something else).
- **B only (holds when B is spent)** — same idea, mirrored.
- **Perfect split** — strictly alternates every real worker spawn between A and B (your own
  interactive chat turns still rank by least-used — split is about workers, not your
  sessions).
- **Ordered A→B (spills to B)** — prefers A, and when A is out of headroom, falls through to
  B automatically. This is the one to pick when you want "use A first, but don't stop just
  because A ran dry."

**The A-only/B-only-vs-Ordered distinction is the one gotcha worth remembering:** the "only"
modes are a deliberate wall — pick one when you want a hold, not a fallback. If you want a
fallback, pick Ordered.

**Stop-loss rows** — per provider (Claude 5h, Claude weekly, Codex, Auggie), current % vs
ceiling. Bar goes amber within 10 points of the line, red at/over. Editable inline, clamped
to 98% max — a ceiling can never reach 100%, because a window at 100% is a wall, not a
budget. If a provider shows a `PAUSED` or `OVERRIDE ON` pill, that's a separate manual
override (not settable from this panel) — it always wins over whatever the ceiling says.

**One status line at the bottom** — either "Dispatching" or the exact reason nothing is
running right now (e.g. "goal 6 has 2 of 2 workers — raise throttle_max_per_goal", or a
governor reason like weekly ceiling or a stale usage meter). This is meant to replace reading
server logs — if the pool looks idle, this line says why.

## The one gotcha: slots vs. admission

There are actually **two** ceilings on how many automated things can run at once: the
worker-slot count you see here, and a separate "admission" cap on automated model turns
(which also covers tree-done cues, autopilot ticks, and guard cues — not just workers).
Raising slots without raising admission is the worst failure mode: a worker claims a node,
starts its lease, and then just sits blocked waiting for a turn slot — burning time, doing
nothing.

**You don't have to manage this yourself.** Every time you change slots, the system
automatically raises admission to stay at least `slots + 2` headroom above it — it never
lowers admission on its own, only raises it. The admission number is shown right next to the
slot count so you can see it's keeping pace; an amber warning appears if it's ever
unsatisfied (only possible if the number was hand-edited outside this panel).

## What never changes

- **A running worker is never touched.** Turning any dial down doesn't kill or interrupt
  anything mid-flight — the pool just stops accepting *new* work and drains naturally as
  running workers finish.
- **The governor's real gates (staleness, weekly-hard-mode, account eligibility) always still
  run.** A preset raises ceilings; it never bypasses a genuine safety gate.
- **An `OVERRIDE ON`/`PAUSED` pill always wins**, regardless of what preset or dial is set.

## Quick reference

| Situation | What to do |
|---|---|
| "My usage meters show tons of headroom, use it" | Click **Turned up** |
| "One goal is eating every worker" | Raise the per-goal cap |
| "I want to protect account B specifically" | Set Claude mode to **A only** |
| "Use A but don't stall if A runs dry" | Set Claude mode to **Ordered A→B** |
| "Pool looks idle, why?" | Read the status line at the bottom of the panel |
| "I need the pool empty right now" | Not a dial — see the drain procedure below |

## If you need the pool empty *right now*

Turning slots to 0 isn't a thing (minimum is 1, deliberately — 0 slots would silently halt
the engine with no visible reason). If you genuinely need to stop new work immediately, the
supported path is the drain pattern: pause new claims for the provider (a separate override,
not this panel), wait for running workers to finish naturally, then flip it back. See
`scripts/throttle-slots-restart.sh` for the scripted version of this.
