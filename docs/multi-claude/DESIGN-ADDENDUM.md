# Multi-Claude — DESIGN ADDENDUM (Kevin, 2026-09-16)

## PRIMARY MODE = PARALLEL ACROSS BOTH ACCOUNTS (not serial failover)

Kevin bought a SECOND real Claude subscription specifically to run MORE overnight work.
The goal is THROUGHPUT, not just a longer runway. Build for concurrent use of both accounts.

- `selectActiveClaudeAccount(ceiling)` must **spread load**: among enabled accounts with 5h < ceiling,
  pick the **LEAST-used** one (lowest 5h utilization), NOT "first with headroom". So when two workers
  dispatch close together, worker 1 lands on A, A's usage ticks up, worker 2 lands on B -> both run at once.
- The governor concurrency cap should allow enough concurrent claude workers to actually USE both
  accounts; each account is independently gated by its own 5h/weekly ceiling. Do not let a single global
  cap of 1-2 bottleneck two accounts down to one account's worth of work.
- The 5h-exhaustion swap (run A to its wall -> continue on B) is the FALLBACK that falls out of the same
  selector for free -- it is NOT the primary mode. Both must work.

## Login is ONE-TIME PER ACCOUNT
Persistent OAuth token on disk per config dir. `CLAUDE_CONFIG_DIR=/home/kevin/.claude-b claude login` runs
ONCE. No per-run login. The setup script prints that command; it does not automate the login itself.
