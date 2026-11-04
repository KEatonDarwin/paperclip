# 🛑 The Work Switch — how to stop everything

**Why it exists.** On 2026-09-25 a stuck review node re-dispatched itself over and
over. Kevin killed it by hand, repeatedly, and had no single way to stop the
whole system. Turning worker slots down to 0 and flipping provider overrides
"off" is a *fake* stop: it rewrites a pile of dials you then have to remember to
put back, and it does not stop the systemd timers that keep starting things.

This switch is a **real** stop. It changes **no other setting**. Stop it, resume
it, and every dial — slots, ceilings, claude mode, overrides — is exactly where
you left it.

## The button

Top-right of the cockpit, on **every** page (including the standalone thread and
group windows).

- Quiet grey = work is running.
- Amber "N lanes off" = some lanes are individually switched off.
- **Red pulsing "WORK STOPPED"** = nothing autonomous will start.

Click it for **STOP ALL WORK**, **+ kill** (also ends workers already running),
**Resume work**, and a toggle per lane.

## The terminal (works even when JARVIS is down)

```bash
jarvis-work                 # status: lanes, in-flight workers, retry-looping nodes
jarvis-work stop            # stop everything now
jarvis-work stop --kill     # ...and end in-flight model workers
jarvis-work stop --hard     # ...and stop in-flight timer services too
jarvis-work resume          # release the stop (per-lane off flags are kept)
jarvis-work resume --all-lanes   # full green light
jarvis-work off  intel bi   # independent lanes
jarvis-work on   intel
jarvis-work park-node 861   # park ONE runaway so it stops re-arming
jarvis-work kill-workers    # kill in-flight workers, leave the switch alone
```

This is the path to use when the service is crash-looping — the CLI needs neither
jarvis.service nor jarvis.db.

## The lanes

| Lane | Turning it off stops |
|---|---|
| `hopper` | spawning new tree/goal workers |
| `night` | the Shifts driver cueing the orchestrator |
| `autopilot` | per-goal autopilot drivers |
| `shepherd` | firing scheduled check-ins + the shepherd sweep |
| `watchdog` | dead-turn resume + stalled-job recovery ← *this is what revives a finished worker* |
| `spawn_reconcile` | reconciling/reviving spawned workers |
| `intel` | the daily Intel Desk pull |
| `bi` | the overnight BI sweep |
| `suppression` | suppression adherence checks |
| `kpi` | the scheduled Darwin KPI run |

Deliberately **not** lanes: the usage pollers, the cockpit healthcheck and DB
retention. They are meters and housekeeping — they never start a worker, and
killing them only blinds you while you are trying to work out what went wrong.

## How it actually holds (two independent layers)

1. **In-process lanes** (`hopper`, `night`, `autopilot`, `shepherd`) are checked at
   the *top* of their dispatch tick, before any side effect. For the hopper this
   includes lease recovery — the retry path sets nodes back to `pending`, which is
   itself work being born, and is exactly how node 861 kept re-arming.
2. **Timer lanes** are gated by `ExecCondition=/usr/local/bin/jarvis-work-gate <lane>`
   on each unit. A non-zero exit makes systemd **skip** the activation cleanly (a
   failed *condition*, not a unit failure). So a lane turns off with no sudo, no
   unit edit, and no disabled timer to remember to re-enable.

State lives in **`/var/lib/jarvis/work-switch.json`** — under `/var/lib`, not
`/tmp`, so a stop survives a reboot. (The 2026-09-25 crash loop survived a full
reboot; a stop that evaporates at boot is not a stop.)

## Rules baked in

- **Resume preserves your lane choices.** `resume` clears the global stop but
  leaves individually-switched-off lanes off. Use `resume --all-lanes` (or "All
  lanes on" in the UI) for the full green light.
- **A corrupt switch file fails SAFE** — every lane reads as stopped, loudly. A
  *missing* file means "never configured" and allows work, so the shop is never
  silently halted by an absent file.
- **Killing never kills the turn doing the killing.** The kill path walks process
  ancestry and skips its own, so running it from a JARVIS chat does not end that
  chat. It will still end *other* in-flight turns, including a chat you have open
  elsewhere — that is what "kill" means.
- **Nothing here interrupts a running worker** unless you ask for `--kill`. By
  default in-flight work finishes and nothing follows it.

## Regression suite

```bash
npm run work-switch:check    # 48 checks, no model calls, no live state touched
```
