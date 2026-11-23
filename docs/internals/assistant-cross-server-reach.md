# Assistant reach across servers

The user's Assistant runs on one server (the Mac mini) while Projects and their coordinators run
on another (the MacBook). Before this, every `cp_assistant_*`, `cp_status_*`, `cp_thread_send`,
`cp_task_handoff` and `cp_schedule_*` call read only its own server, so the Assistant saw no
Projects and coordinators could not reach the Assistant. Code: `apps/server/src/reach/`.

## Model

- **The server that owns a Project is authoritative for it:** its event log, Status board,
  schedules (they fire on that machine's ScheduleHost) and coordinator. Nothing about a Project is
  copied to another server.
- **The Assistant's server is authoritative for the Assistant:** its thread, its reach settings
  (`ServerSettings.assistant`), its asks and their answers, and the task list it edits.
- **Tasks** stay where they are. The Assistant edits its own server's task list; with Task Sync
  signed in on both servers that list is the same everywhere. A handoff of a task to a remote
  coordinator records the handoff on the Assistant's server and delivers the handoff message to
  the coordinator on its server.

## Task authority

With Task Sync on for one account on both servers, both would run commitment rollover
(`taskRolloverToCurrentPeriod`). A rollover retires the old membership and creates one with a new
random id, so two servers rolling the same commitment can leave duplicate memberships (see the
rollover contract with Lucive). So exactly one server is the **task authority**: it holds the
user's real list, rolls commitments and serves Tasks to clients.

- **Rule** (`reach/taskAuthority.ts`, `decideTaskAuthority`): **Task Sync decides first.** Among
  the servers signed in and synced to this server's account, the one that hosts the Assistant wins
  (lower environment id if two do), else the lowest environment id. A server that is not signed
  in defers to any synced linked server (reason `unsynced`): its local list is not the user's, so
  authority never follows the Assistant onto an unsynced machine. With no synced server anywhere,
  the old rule applies: the Assistant's server, else every server is its own authority. A server
  counts as synced once it is signed in, past its first merge and its subscription is not inactive
  (`TaskSyncEngine.syncedAccount`). Servers compare a hash of the account email, never the address.
- **Why (2026-11-23):** after the Assistant moved to a mini that had never signed in to Task Sync,
  the mini became authority with an empty list, the synced MacBook deferred, and nobody rolled.
  The Assistant's `cp_task_*` answered `{"tasks":[],"total":0}` from the empty list.
- **Knowledge** (`reach/TaskAuthorityLive.ts`): each server asks its linked machines `describe`
  every 5 minutes. `describe` now carries `tasks: { account, rolls, rollover }`. Answers are stored
  in `reach-assistants.json` (the `task` field per machine), so the decision survives restarts and
  a sleeping machine keeps its last answer for three days. A server whose own Task Sync account or
  Assistant changes sends `authority.poke` (read-only, rate limited) so linked machines look again
  at once instead of within 5 minutes.
- **Rollover** (`TaskCommitmentRollover.ts`, `rolloverPermit`): a server rolls only when all hold:
  it is the authority; the **account-wide** setting is on; its view of linked machines is under 6
  minutes old (else it refreshes first, so a machine waking from sleep never rolls on old
  knowledge); and no linked machine said within the last 15 minutes that it rolls. During a
  handover the new authority waits until the old one has stepped down, so the two never roll at
  once; since rollover is a catch-up, that only delays moves by minutes and never skips one. The
  residual race (both decide at the same instant on stale facts) is backstopped by the cloud's
  one-live-commitment tie-break (rollover contract, section 4).
- **Setting follows authority:** `taskRolloverToCurrentPeriod` is stamped with
  `taskRolloverSetAt` whenever it is set. The effective value is the latest choice on this server
  or any linked server synced to the same account; a tie (both unstamped, as before this change)
  goes to on. So the MacBook's ON carries to the mini when the mini takes over, with no copy step.
- **Gap check:** each server tracks how long the setting has been on with nobody rolling. Past 20
  minutes it logs a warning and Task Sync status reports `authority.rolloverGap`, shown in
  Settings > Task Sync.
- **Task tools:** on a server that is not signed in while a linked server is
  (`taskListElsewhere`), every `cp_task_*` fails with "This server is not signed in to Task Sync
  ... The user's tasks are on <machine>", for reads and writes. Tasks are not proxied.
- **Clients:** a deferring server keeps `capabilities.tasks: true` and adds `tasksDeferred: true`.
  The web `resolveTaskEnvironmentId` and mobile `useTaskEnvironmentId` prefer a Tasks server that
  does not defer. The descriptor is now pushed live (`environmentUpdated` config-stream event,
  opt-in `environmentUpdates`), so a change of authority reaches connected clients without a
  reconnect.
- **Settings > Task Sync** lists every connected Tasks server with its sync state and role
  (holds your tasks, runs the Assistant, rolls commitments, needs sign-in). The card signs in the
  chosen server, defaulting to the Assistant's server when it needs a sign-in, so any client
  connected to it can sign it in. Each server does its own device sign-in; credentials are never
  copied. The rollover switch writes to the authority's settings and shows the account-wide value.
- **Moving the Assistant** (Runs on): the confirmation says whether tasks follow (target synced)
  or stay put until the target signs in.
- **Mixed builds:** an older linked build does not report `tasks`. If it hosts the Assistant it
  still wins (it rolls by the old rule, so the synced server here defers and only one rolls);
  otherwise it is ignored. Update all linked servers together.
- **Handover pulls first:** a server that becomes allowed to roll (a handover, or its first pass
  after start) runs a full sync before it rolls, so what the previous authority already rolled is
  seen and not rolled again.
- **Coordinators keep their tools:** only the Assistant's `cp_task_*` calls refuse on an unsynced
  server; a coordinator there keeps working with that machine's own task list.
- **Known limits (deferred):**
  - If the reach link between two synced servers is down for more than 3 days, each stops counting
    the other and both may roll; the cloud's one-live-commitment tie-break keeps the result to one
    commitment. A fix needs a lease in the cloud.
  - `rolls` in `describe` is the permit, not "a roll is running": a server that loses authority in
    the middle of a pass reports `rolls: false` while that pass finishes, so the new authority can
    start within that window. Passes take milliseconds and the new authority pulls first.

## Transport

Reuses the linked-machine link from [multi-machine agents](./multi-machine-agents.md): the peer's
`baseUrl`, its bearer token (`orchestration:read orchestration:operate`, kept in
`ServerSecretStore`), descriptor identity pinning, private-network URL validation, no redirects,
3 second timeouts (8 for reach calls). T3 Connect stays off.

One new route on every server: `POST /api/reach`, bearer token with `orchestration:operate`.
Body `{ op, requestId, caller: { environmentId, label, threadId, threadTitle }, input }`. The
callee runs the op against its own state and answers JSON `{ ok: true, result }` or
`{ ok: false, error }`. Ops act only locally; a callee never forwards an op, so there are no
forwarding loops.

**Links.** Every write across machines needs the two machines **linked both ways**: the receiver
confirms each write with the sender over its own link (see Security). A one-way link is enough
only for reads (overview, status list, schedule list, thread lookup). Agent machines' Add machine
links both ways in one step ("Let that machine reach this one too", on by default). Every linked
machine is in reach; the Assistant's per-Project reach setting still filters.

## Ops and tools

| Tool (caller)                                      | Op on the owning server     | Behaviour                                                                                                                                                                    |
| -------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cp_assistant_overview` (Assistant)                | `overview`                  | Local Projects plus each linked machine's, tagged `machine`. A new `machines` list says which machines answered and which are offline.                                       |
| `cp_assistant_ask` (Assistant)                     | `ask`                       | Held request in the remote coordinator (`cp-send:<coord>:ask:<askId>:reach:<uuid>`, `replyTo` the remote Assistant). The answer comes back to the Assistant's ask card.      |
| `cp_status_list` / `cp_status_set` (Assistant)     | `status.list`, `status.set` | Run on the owning server. `project.status.set` gains `remoteActor`, which the decider accepts in place of a local actor. The coordinator note is sent there.                 |
| `cp_thread_send` (Assistant to a remote thread)    | `thread.send`               | Resolves the thread there by id or exact title; starts it if idle, else holds it like a busy local send. No result, as for a local cross-Project send.                       |
| `cp_task_handoff` to a remote coordinator or agent | `task.deliver`              | Task records the handoff locally (thread id of the remote target); the handoff message is delivered as a held send on the owning server.                                     |
| `cp_schedule_*` with `projectId` (Assistant)       | `schedule.*`                | The Assistant manages another Project's schedules; they live and fire on the owning server. `project.schedule.agent-change` gains `remoteActor`.                             |
| `cp_thread_send` to the Assistant (coordinator)    | `thread.send`               | `threadTitle: "Assistant"` (or its thread id) resolves to the Assistant on a linked machine when this server has none.                                                       |
| `cp_assistant_ping` (coordinator)                  | `assistant.note`            | A coordinator's ping becomes a held note in the Assistant's thread naming the Project and machine; the Assistant decides whether to ping the user. Also works on one server. |

## How answers come back

Pull, so a sleeping caller or callee loses nothing (the asking itself is a write, so the machines
are linked both ways; the answers are collected by the asking server, which only reads):

1. The callee's `AgentCompletionReactor` treats a request whose id carries `:reach:` as owed to a
   remote thread. Instead of appending into a local recipient it records the formatted result as an
   activity on the coordinator, with the push id `cp-push:<coord>:<requestId>` as its id. That
   receipt is the ledger: it is written once, survives restarts, and shows "Answer sent to the
   Assistant on <machine>" in the coordinator's thread.
2. The caller keeps open asks in `reach-requests.json` (state dir, atomic writes). `ReachBridge`
   polls each machine with open asks every 5 seconds (`op: results`), appends each answer into the
   Assistant with the same push id (idempotent by receipt) and enqueues the reactor, then drops the
   record. Ask cards match it like a local answer (`:ask:<askId>:` and `source.threadId`).

## Offline (the MacBook sleeps)

- **Overview:** the machine is listed in `machines` as `offline` (or `needs-relink`) with when it
  was last seen, and its Projects from the last good read (kept in `reach-overviews.json`, so they
  survive a restart of the Assistant's server) are listed with `coordinatorPhase: "offline"` and
  `stale: true`. Never silently empty.
- **Ask, status, thread send, handoff, schedules:** fail fast with an explicit per-target error
  ("MacBook is offline, last seen 10:42. Try again when it is awake."). For `cp_assistant_ask` the
  offline Projects land in `skipped` with that reason; the online ones are still asked.
- **Answers in flight** wait: the bridge backs off and resumes when the machine answers. After 24
  hours an open ask gets one "no answer, <machine> unreachable" result under its own id.
- **Assistant's server offline** (coordinator side): `cp_thread_send` / `cp_assistant_ping` to
  the Assistant fail with an explicit error naming the machine ("No Assistant here, and Mac mini
  is offline, last seen ..."), never a bare "no thread matched".

## Details

- **Names.** A callee calls the caller what the user named it when linking (the label in its own
  Agent machines settings), so messages read "Assistant (on Mac mini)" even when both hosts
  report the same hostname.
- **Turning a schedule on** still needs the Assistant's turn to be started by the user's own
  message. The Assistant's server checks its own turn and sends `userTurn`; the owning server
  refuses `enabled: true` without it.
- **Task handoff** records the handoff on the Assistant's task list with `handoff.machine`, and the
  coordinator's message says where the task list lives.

## Security

- **Bearer only.** `/api/reach` authenticates by the `Authorization: Bearer` token alone and
  drops cookies before checking it: every localhost port is the same site for `SameSite=Lax`, so a
  browser session cookie would let any local page send ops. The token needs
  `orchestration:operate`, which only pairing this server issues.
- **Caller identity is verified, not claimed.** The body names the caller, but before any op that
  acts for it (ask, status writes, thread sends, notes, task handoffs, schedule writes, and in
  phase 2 the move ops and `assistant.yield`) the callee asks that machine over the callee's own link, whose identity is
  pinned by descriptor, whether it sent this exact request (`confirm` op, `reach/reachSent.ts`):
  the same request id, op and input hash, sent to this receiver, within five minutes. So a machine
  that received a real request cannot replay it to another machine, or with another op or input,
  and each request id is accepted once. The confirmation never reuses a recent "offline" verdict
  for the caller. Writes therefore need the machines linked both ways; reads (describe, overview,
  results, status list, thread find, schedule list) do not. A callee also refuses calls whose
  `caller.environmentId` is its own.
- Remote writes keep the local checks: a target Project must be live, marked and non-global; the
  Assistant's reach setting is checked on the Assistant's server before any call.
- Messages from another machine are labelled agent messages, never user instructions.
- **Honest errors.** Only a transport failure reads as "offline". A machine that answered with an
  error (for example 413 for a body over the op's limit) is reported with what it said, and a
  timeout says the machine may still finish what was asked.

## Loops and duplicates

- Each op carries a fresh `requestId` that the callee builds its command ids from. The caller
  never retries an op itself: a failure goes back to the agent as an error, so one call lands at
  most once.
- Answers are pushes with no `replyTo`, so an answer never owes an answer.
- Thread sends and notes carry no `replyTo`; nothing chains across machines.
- The bridge appends with the callee's push id, so a repeated poll never doubles an answer.

## Decisions (defaults taken; say if you want otherwise)

1. **Pull, not push, for answers.** Survives either machine sleeping, and the answering machine
   never has to call out. Costs a 5 second poll only while asks are open.
2. **Explicit errors, no queued sends** when a machine is offline. Queued cross-machine sends can
   fire hours later out of context; the Assistant can retry, and schedules rerun.
3. **Coordinator `cp_assistant_ping` becomes a note to the Assistant,** not a direct user ping.
   The Assistant stays the only thing that pings the user.
4. **Every linked machine is in reach.** The per-Project reach setting filters. The reach picker
   in Settings lists only this server's Projects; `null` (all) includes remote ones.
5. **Tasks are not proxied.** Task Sync is the way to share one task list, and only the task
   authority (the synced server that runs the Assistant) rolls commitments or serves Tasks to
   clients. An unsynced server's task tools refuse with a pointer to the synced one.

## Phase 2: choosing the Assistant's machine (general feature)

Phase 1 (above, PR #129) is the server mechanism. Phase 2 makes it a product feature any user
can set up from the UI: pick which of their servers runs the Assistant, move it cleanly, and link
servers both ways with the normal pairing flow.

### Where the Assistant lives

- **One home.** The Assistant's home is the server that holds the live global Assistant Project.
  There is no separate "home" setting to drift out of sync: the marker is the truth, and every
  server learns the others' answer through `describe` (already stored in
  `reach-assistants.json`). Task authority already follows this rule.
- **Clients find it wherever it is.** Today web (`useGlobalAssistantProject`, `useOpenAssistant`)
  and mobile (`useAssistantEntry`) look only on the primary environment and create one there on
  first open. Phase 2: look across every connected environment for a live global Assistant and
  open that one; create only when none exists anywhere, on the machine the user picks.
- **Two at once is a conflict, not a state.** If two linked servers each hold one (created before
  they were linked), task authority already picks one (lower environment id). Settings shows
  "Your Assistant exists on two machines" with "Keep the one on X" (moves the other in, below).

### Moving it (`server.assistantHome` move, run by the current home)

Two phases, journaled on both sides in `assistant-moves.json` (`reach/assistantMoves.ts`), so a
timeout or crash never leaves two Assistants, and an interrupted move finishes or undoes itself:

1. **Check** the target: linked, online, linked back, no Assistant of its own, no Assistant turn
   running here.
2. **Pause here.** Journal `adopting`, then archive the Assistant marker here (stops its
   schedules, holds results, `describe` reports no Assistant).
3. **Adopt** (`assistant.adopt`, body limit 64 MB, 60 second timeout). The target first journals
   `preparing` with the ids it is about to use and what it will overwrite (settings, memory,
   whether it creates the Project), then builds a copy that is **paused from its first command**
   (the Assistant marker is written already archived), and journals `adopted` once it is whole.
   A crash in between leaves a `preparing` entry naming everything made: reconcile on restart, an
   abort, or a retried adopt with the same id removes it first. The copy holds: settings, schedules with prompts, `MEMORY.md`, the last 200 messages, open
   asks kept for later. It is idempotent by move id: a retry returns the same copy. A target that
   already holds an archived Assistant (the A to B to A case) reuses that Project and its home
   folder, with a fresh coordinator thread for the imported conversation; otherwise it creates one.
4. **Commit** (`assistant.commit`): only from the machine named in the target's journal entry
   (commit and abort from any other linked machine are refused). The target puts its copy live and starts polling the asks.
   Only the source sends a commit, and only after a successful adopt, so the target's copy can
   never be live while the source's is.
   **Whole conversation (#134):** the adopt carries the first page; the rest follows as
   `assistant.history` pages (200 messages or 4 MB), every attachment as `assistant.attachment`
   chunks (6 MB, sha256-checked, renamed for the new thread), then `assistant.verify` compares the
   message count, a digest of (role, time, text) and the attachment count. The target refuses to
   commit until verified; the source rolls back if the check fails. Message ids are kept, so a resent
   page adds nothing twice. Tool-call activity rows stay behind.
   **Nothing left behind (#134):** on commit the source marks its paused copy `retiredAt`: a hidden
   rollback snapshot listed nowhere (not the sidebar, not Archived), kept 7 days
   (`RETIRED_GRACE_MS`) and then deleted by reconcile, but only while a linked machine said within
   the last hour (`HOST_CONFIRM_FRESH_MS`) that it runs the Assistant (or it runs here again): a
   copy is never removed while the machine it moved to may be gone. Taking the Assistant back
   within that time revives it. A move back onto a machine holding a retired copy deletes it and
   builds a fresh Project in the same home folder, so no "(previous)" thread exists. The source
   pauses its copy before it reads the conversation, so nothing said during the move stays behind.
   **A copy is deleted only when its coordinator is all it holds.** Expiry, a move back and "Remove
   the old copy" check only the coordinator's conversation, so a copy whose Project has any other
   thread with messages (a previous coordinator a reuse archived, an agent) is kept: expiry and a
   move back un-retire it (archived, listed as an older copy), Remove refuses. A cancelled move
   onto a reused older copy puts it back archived and not retired, and removes the attachment files
   (finished or `.part`) it wrote for its new thread. A copy an older build left
   (archived, not retired, possibly holding history the mover lacks) is still reused as below until
   the one-time history backfill.
   **History backfill (#134):** while the Assistant runs here, Settings, Assistant lists older copies
   on online linked machines ("Older conversation on <machine>"). "Bring it here" pulls that copy's
   conversation (read ops `assistant.legacy.list/page/attachment`, verified and only for the machine
   that runs the Assistant; the old machine only serves files that belong to that copy and still
   exist) and imports the messages not already here, matched by (role, time, text), into the live
   thread. A message here with the same key but fewer attachments (older builds moved words only)
   keeps its id and words and gains the missing attachments (`thread.history.import` with `backfill: true`: allowed on a thread
   with turns but not while one runs, settle state untouched). "Remove the old copy" runs only on the
   user's click, only when every message and every attachment is here, and the old machine deletes it only for the
   machine that runs the Assistant and only if the copy's digest is unchanged
   (`assistant.legacy.remove`, a verified write).
   When the copy reused an archived Project (A to B to A), the coordinator swap leaves the old
   coordinator pinned as "Assistant (previous)"; on commit the target unpins and archives it
   (`retirePreviousThread`), and reconcile does the same for moves committed by older builds. Only
   abort needs that thread, and a committed move is never aborted.
5. **Outcomes on the source:**
   - Adopt failed or timed out: send `assistant.abort` and resume here. Resuming is safe even if
     the abort cannot be delivered, because the target's copy stays paused without a commit; the
     journal keeps `abort-pending` and keeps telling the target.
   - Commit answered: done (asks dropped here, task authority refreshed).
   - Commit refused: abort and resume here.
   - Commit unanswered (timeout, asleep): stay paused here (zero live, never two) and show "Moving
     to <machine>" in Settings. The reconcile loop asks the target (`assistant.moveStatus`):
     committed means done, a paused copy gets the commit again, anything else resumes here.
6. **Abort on the target** puts back the settings and `MEMORY.md` it overwrote (removing the moved
   `MEMORY.md` when there was none) and deletes the
   Project it created (force delete, which frees the home folder), or, when it reused an archived
   one, points it back at its old coordinator. An abort for an unknown move id is recorded, so a
   late adopt with that id is refused.
7. **Reconcile** runs at startup and every minute, so a source that crashed mid-move resumes its
   own copy (from `adopting`) or finishes (from `committing`) once the target answers, and a target
   removes a `preparing` copy a crash left.
8. **Fail closed.** A journal that exists but cannot be read or parsed fails every move call and
   reconcile instead of reading as empty: rolling back without knowing whether the target went live
   could leave two Assistants. Settings shows the error until the file is fixed or removed.

### When the Assistant's machine is gone

- **Opening the Assistant** is refused while any linked machine last said it runs the Assistant,
  however long ago, unless that machine answers now that it runs none; one that cannot be reached
  gets a pointer to taking it back. A machine that holds the archived copy (it moved away from
  here) brings that copy back instead of creating a second, and only after every linked machine
  that might run one says so now.
- **"Take the Assistant back to this machine"** (Settings, Assistant, shown while the machine that
  runs it cannot be reached): after a confirm that warns that anything learned there since stays
  there, this machine revives its archived copy (or lets the client create one) and journals a
  `reclaim` entry owing that machine a yield. Reconcile sends `assistant.yield` until it answers;
  the old home pauses its copy only if the caller runs a live Assistant when asked, so a stray yield
  can never leave none, and stops a turn already running. Refused while that machine answers and
  still runs it (move it instead).
- **No double run after a wake.** Before any Assistant schedule runs (the OS fire, catch-up after
  sleep, or Run now), the machine asks every linked machine whether it runs the Assistant. If one
  says yes, or one cannot be reached and its last answer was not a clear no, or one answers with an
  error (an older build without reach, a token to relink) while its last answer was yes, the run is skipped and
  recorded `missed: not-home` ("Skipped · your Assistant may run on another machine"). A yes is
  reused for a minute. An always-on home with a sleeping laptop still runs on time, because the
  laptop's last answer was no. What is left: a home that slept while the other machine took the
  Assistant back, then wakes while that machine is also unreachable, runs until either the yield
  arrives or that machine answers.

Schedules aimed at other threads of the Assistant's Project cannot exist on the target: they move
aimed at the Assistant, paused, and the move result lists each one (shown in the success toast).

Move ops and `assistant.yield` are verified like every write: the target confirms the request
with the source over its own link. `link.back` is the one write that cannot be checked first when
the link is new, since the link it would ask over does not exist yet. It is checked in two steps:
the server behind the pairing link must report the environment id of the machine asking, and right
after the link is saved this machine asks the asker over it (the same `confirm`, single-use id)
whether it sent this exact request. If it says no or cannot answer, the new link is removed and
nothing else happened. When the link already exists, it is confirmed before redeeming, like any
write. What an attacker with a stolen bearer token could still do: make this machine hold a link to
the genuine asking machine for the moment before the confirm fails.

### Linking both ways from the normal pairing UI

- **Settings > Connections > Agent machines, "Add machine"** stays the entry point (pairing
  link). After linking A to B, A offers **"Let <B> reach this machine too"**: A mints a pairing
  credential for itself and sends it, with A's address as B should use it (tailnet name
  prefilled, editable), over the new link; B runs its own `link`. One action, both directions.
- **Adding a remote environment in a client** (the client-side pairing Nick used) ends with a
  prompt when both servers have Projects or an Assistant: "Link these servers so your Assistant
  and coordinators can reach each other?" which runs the same two-way link.
- Each machine row shows both directions: "Reaches it / It reaches this machine", with
  needs-relink and token expiry.

### Settings and onboarding UX

- **Settings > Assistant, "Runs on"**: a picker of this machine plus linked machines (online
  state, "always on" hint for machines that report a desktop or server kind). Changing it runs the
  move with a confirmation sheet ("Moves your Assistant, its schedules, memory and settings to
  <B>. <A> keeps a read-only copy.") and a progress row. Disabled with the reason when a
  precondition fails.
- **First open of the Assistant** with linked machines present: "Where should your Assistant
  run?" (this machine, or a linked one), recommending an always-on machine. With no linked
  machines it is created here as today, no question.
- **Reach**: the per-Project picker lists Projects on every machine, grouped by machine, with
  each machine's state. `null` (all Projects) stays the default.
- **Offline states**:
  - Assistant thread header: "MacBook offline since 10:42. Its 2 Projects show their last known
    state." Ask cards mark targets on an offline machine as "Not sent: MacBook offline".
  - When the Assistant's own machine is offline, clients show "Your Assistant runs on Mac mini,
    which is offline (last seen 10:42)" instead of offering to create a new one (the key guard
    against two Assistants).
  - Coordinators' tools already return explicit offline errors (phase 1).
- **Mobile**: opens the Assistant on whichever paired server hosts it and shows the same
  offline line; picker and move live in desktop/web Settings only at first. Any iPhone UI change
  ships with simulator screenshots per AGENTS.md.

### Built (phase 2 PR)

Deferred and noted in the PR: the phone's task hand-off sheet (`useMobileTasks.ts`) lists only
the Projects of the machine that holds Tasks, not every linked machine's.

- **Server:** `reach/AssistantHome.ts` (status, move, adopt, handoff, link back, ensure guard),
  RPC `server.assistantHome` (status, move), `server.agentMachines` gains `linkBack`, reach ops
  `assistant.adopt`, `assistant.handoff`, `link.back`, and `describe` reports the machines a
  server has linked. `server.assistantEnsure` refuses to create an Assistant while a linked
  machine runs one, which also covers the mobile app.
- **Move back:** choosing "This machine" on a server without the Assistant asks the current home
  to run the move (`assistant.handoff`), so the home always runs it.
- **Web:** Settings, Assistant has "Runs on" (picker, machine rows with state, confirmation,
  conflict and offline lines) and "Projects on <machine>" rows in Reach. When the Assistant runs on
  a machine this client is not connected to, the page says its settings live there instead of
  showing stale ones. Agent machines' "Add machine" links both ways in one step (switch on by
  default, this machine's address prefilled), and each machine's menu has "Let <machine> reach this
  machine". `useGlobalAssistantProject` finds the Assistant on any connected environment.
- **Mobile:** unchanged. It already picks the environment that hosts the Assistant, and the server
  guard stops a second one.
- **Not built yet:** the prompt after client-side environment pairing (linking from Agent
  machines covers both directions), and a first-open "where should it run" question (first open
  creates it here; Runs on moves it).

### Estimate

Phase 1 (this PR) is done. Phase 2 adds about **5 to 7 working days**:

| Piece                                                              | Days     |
| ------------------------------------------------------------------ | -------- |
| Move: bundle, adopt op, rollback, idempotence, tests               | 1.5 to 2 |
| Clients find the Assistant on any environment; no-create when away | 0.5 to 1 |
| Two-way link from Agent machines and from client pairing           | 1        |
| Settings: Runs on picker, move sheet, conflict, reach by machine   | 1.5      |
| Offline banners, ask-card states, mobile open-remote and line      | 1        |
| Two-server and simulator verification                              | 0.5      |

Suggested split: review and merge phase 1 first (server-only, no UI change, no effect for a user
without linked machines), then phase 2 as two PRs: (a) move and client discovery, (b) linking and
settings UX.
