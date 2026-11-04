# Advisory reviewer (Haiku 5.5, non-blocking)

A second pair of eyes beside the Opus gate. Never fails a node, never triggers a fix,
never blocks a merge. The Opus gate and its verdict parser are untouched.

- Trigger: `finishHopperNode` (outcome `done`) -> fire-and-forget `maybeRunAdvisoryReview(node, tree)`.
  Fires only for titles matching `ADVISORY_TRIGGER_RE` (`VERIFY:` autopilot/night, `ACCEPT:` sprint).
- Diff: tree.integration_branch (else node_branch) vs merge-base with origin/HEAD|main|master, via
  `runGit`, filtered of lockfiles, capped 24KB. No repo_path / no branch / empty diff => skip.
- Model: `claude -p -` (prompt on stdin), `ANTHROPIC_API_KEY` deleted, `CLAUDE_CONFIG_DIR=/home/kevin/.claude-b`.
- Output: ONLY `hopper_nodes.advisory_review` (new TEXT column, added at boot). Never `result`/`result_summary`
  (parseVerdict reads `result`; night-shift.ts / shift-narrator.ts regex `result_summary`). Any line starting
  with VERDICT is stripped; capped 4000 chars.
- Fail-safe: whole function in try/catch; spawn error / timeout / empty output / scratch env => stores nothing.
- Settings-KV: `advisory_reviewer_model` (unset=claude-haiku-5-5, `off`=disabled, else model id),
  `advisory_reviewer_timeout_ms` (default 120000).
- Served by: GET /hopper-trees/:id (raw rows) and the spawn-monitor tree endpoint (`src/spawn-monitor.ts`, explicit mapping).
- Cockpit card: repo jarvis-command-center, branch `cockpit/advisory-reviewer`.

Deploy (Alpha): copy src/advisory-reviewer.ts; patch (not checkout) hopper-engine.ts, hopper-git.ts (runGit export),
spawn-monitor.ts into live; `npm run build`; restart via transient unit. Column is added on boot.
