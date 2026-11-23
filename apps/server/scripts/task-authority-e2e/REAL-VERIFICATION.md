# Real verification on the Mac mini and MacBook (after release)

Read-only checks are marked (read). The only state change is Nick's own Task Sync sign-in on the
mini, done in the app. Never copy `~/.t3/userdata/task-sync` or secrets between machines.

## 0. Both machines on the new build

- MacBook and mini both show the release version in Settings > About.
- (read) `ssh mac-mini 'grep -o "task authority: [^\"]*" ~/.t3/userdata/logs/server.trace.ndjson | tail -1'`
  - expect: `this server is not signed in to Task Sync; tasks are held by MacBook`
- (read) on the MacBook: `grep -o "task authority: [^\"]*" ~/.t3/userdata/logs/server.trace.ndjson | tail -1`
  - expect: `this server is the task authority`

## 1. Before signing in the mini (the bug state, now safe)

- Ask the Assistant: "List my tasks with cp_task_list."
  - expect: an error naming the MacBook ("This server is not signed in to Task Sync ... The
    user's tasks are on MacBook"), never 0 tasks.
- Settings > Task Sync (from any client connected to both): a server list with
  - MacBook: "Holds your tasks", "Rolls commitments", "Signed in and synced"
  - Mac mini: "Runs the Assistant", "Needs sign-in", "Not signed in"
  - a warning: "Your Assistant runs on Mac mini, which isn't signed in to Task Sync ..."
  - the card below is already pointed at Mac mini.
- Rollover keeps running on the MacBook meanwhile (no gap).

## 2. Sign in the mini (Nick)

- In Settings > Task Sync, with Mac mini selected: enter the account email, Send code, enter the
  code, Sign in. This is the mini's own device sign-in.
- Within a minute:
  - Mac mini row: "Holds your tasks", "Runs the Assistant", "Signed in and synced".
  - MacBook row: "Signed in and synced", tasks held by Mac mini, no "Rolls commitments".
  - "Rolls commitments" moves to the mini within a few minutes (handover waits until the MacBook
    has stepped down, so the two never roll at once).
- (read) mini: `ls ~/.t3/userdata/task-sync/state.json` exists;
  `sqlite3 ~/.t3/userdata/state.sqlite "select count(*) from projection_tasks"` matches the
  MacBook's count.
- (read) both logs: the authority lines flip (mini "is the task authority", MacBook "tasks defer
  to Mac mini, the synced server that runs the Assistant").

## 3. Task tools on the mini

- Ask the Assistant: "List my tasks with cp_task_list." Expect Nick's real list.
- Ask it to propose a harmless task ("Test task from the Assistant, delete me"), confirm it shows
  on the phone and the MacBook, then delete it. (Only with Nick's OK: it touches his tasks.)

## 4. Rollover continuity

- Rollover setting: Settings > Task Sync > Commitments shows ON (carried from the MacBook's
  choice; no copy needed). Do not toggle it.
- (read) after the next period boundary or the next expired commitment: only the mini's log has
  `rolled synced commitments`; the MacBook has none after the handover time.
- (read) gap check: neither log shows `commitment rollover is on, but no linked server has rolled`.
