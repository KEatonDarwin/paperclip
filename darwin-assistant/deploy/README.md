# deploy/

Systemd units for darwin-assistant support jobs that run OUT OF the main
`jarvis.service` process. Workers never install these — JARVIS installs them
by hand at deploy time, after review.

## jarvis-summary-refresh (SHARED CONTEXT v0 §3)

Keeps `thread_summaries` fresh so the Shared Now digest (§1) and `recall`
(§2) don't go stale. Runs `scripts/refresh-thread-summaries.ts`, which reads
staleness from the live `jarvis.db` and POSTs `/threads/:ext/summarize` on
the already-running `jarvis.service` for each stale thread (the model call
happens inside that live process via the local `claude` CLI — this timer
never spawns a model itself).

Install:

```bash
sudo cp deploy/jarvis-summary-refresh.service deploy/jarvis-summary-refresh.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jarvis-summary-refresh.timer
```

Check it:

```bash
systemctl status jarvis-summary-refresh.timer
systemctl list-timers jarvis-summary-refresh.timer
journalctl -u jarvis-summary-refresh.service -n 50 --no-pager
```

Manual dry run (safe — never posts, never touches the live jarvis.db unless
you point it there):

```bash
cd /home/kevin/paperclip/darwin-assistant
npm run build
npx tsx scripts/refresh-thread-summaries.ts --dry-run
```

Tunable via settings-KV (see `docs/shared-context/CONTRACT.md` §3): `summary_refresh_min_turns`
(default 6), `summary_refresh_batch` (default 15), `summary_refresh_model`
(default `claude-haiku-4-5`).
