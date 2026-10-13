Kevin gets the missing wake-back loop: when a registered commitment actually crosses from open to breached, JARVIS can now post back into the originating chat and ask for a one-line status report. The feature is gated by a flag file, capped to three wake-backs per watchdog run, and old already-breached rows stay inert so deploy does not wake historical noise.

## How it works

- `WATCHDOG_DB` and `WATCHDOG_COCKPIT` override the watchdog DB and cockpit API base, with the old live defaults unchanged.
- On an open commitment becoming breached, the watchdog still sends the normal notification. If `thread_ext` is set and `/home/kevin/.jarvis/wake-back.enabled` exists, it also posts to `/threads/<thread_ext>/messages`.
- The wake text quotes the subject, due time, and detail, and ends: `check this and report status in one line.`
- Wake-backs are terminal because breached rows are no longer selected on later runs. Successful wakes append `woke=<ts>` to `notes`.
- `chat_report` commitments are satisfied when the origin thread contains `[report:<child_external_id>]` after the commitment row's `created_at`.
- Pre-flight auth proof: `/threads/:external_id/messages` calls `findConversationForCaller`, which delegates ownership to `callerOwnsExternalId`; `api-keys.ts` makes `admin` and `cockpit` scopes own every thread, so the cockpit key path can post cross-thread without using the tree-cue workaround.

## Files changed

- `darwin-assistant/scripts/jarvis-watchdog.py`
- `darwin-assistant/scripts/watchdog-wake-back-check.py`

## Checks

Run from `darwin-assistant`:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/watchdog-wake-back-check.py
npx tsc -p .
```

The Python check covers env overrides, one wake on breach, no duplicate wake on a second run, flag-off notify behavior, missing `thread_ext`, the three-wake cap, `chat_report` satisfied and breached paths, already-breached inert rows, and the read-only source-code pre-flight auth proof.

In this sandbox, Python could not bind a localhost socket, so the check attempted the random-port HTTP stub and fell back to an in-process HTTP stub. The recorded POST paths and payloads are the same, and it will use the real stub server where socket binding is allowed.

## Deploy steps

1. Pre-flip count measured from a sqlite `.backup` copy:

   ```sql
   SELECT count(*) FROM watch_commitments WHERE status='open' AND due_at < datetime('now');
   -- 0
   ```

   That is how many wake-backs should fire immediately after the flag is enabled.

2. Merge the watchdog branch.
3. Enable wake-back:

   ```sh
   touch ~/.jarvis/wake-back.enabled
   ```

## Rollback

```sh
rm ~/.jarvis/wake-back.enabled
```

The deployed script remains in place but inert for chat wake-backs.

## Known gaps

- Required outbox target `/home/kevin/obsidian/paperclip-wiki/outbox/overnight-2026-10-12/watchdog-wake-back.md` was not writable from this sandbox, so this committed report carries the same content.
- The acceptance check has a socket fallback because this build sandbox denies localhost bind. Reviewer machines with normal socket permission exercise the real local HTTP stub.
- If a wake-back POST itself fails, the commitment still becomes terminal breached and the normal `notify()` path still fires; `notes` only records `woke=<ts>` after a successful POST.
