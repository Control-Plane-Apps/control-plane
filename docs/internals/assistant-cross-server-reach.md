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
rollover contract with Lucive). So exactly one server is the **task authority**:

- **Rule** (`reach/taskAuthority.ts`, `decideTaskAuthority`): the server that hosts the user's
  live Assistant. With no Assistant on any linked machine, a server is its own authority (one
  machine, as before). If two linked servers both host one, the lower environment id wins, and both
  sides compute the same answer.
- **Knowledge** (`reach/TaskAuthorityLive.ts`): each server asks its linked machines `describe`
  every 5 minutes and stores who hosts an Assistant in `reach-assistants.json`. The decision is
  made from that file at startup, before clients connect, and a machine that does not answer keeps
  its stored answer, so the MacBook keeps deferring while the mini sleeps or after a restart.
- **Rollover** (`TaskCommitmentRollover.ts`): a server that is not the authority never rolls, with
  or without Task Sync. Rollover is the only automatic task write; Task Sync's own pull and push and
  writes a person or agent asks for (coordinator proposals, push-notification actions) still run.
- **Clients:** a deferring server reports `capabilities.tasks: false` in its descriptor. The web
  client's `resolveTaskEnvironmentId` and the mobile `useTaskEnvironmentId` (first server with the
  tasks capability) both skip it, so every client uses the Assistant's server for Tasks. A phone
  paired only with the MacBook falls back to its own cloud copy, as when the Mac is unreachable.
  Clients read the descriptor when they connect, so a change of authority shows after reconnect.

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

**Links.** Assistant to Projects needs the Assistant's server to link the Project server.
Coordinators to the Assistant needs the reverse link. The target setup links both ways
(Settings > Connections > Agent machines on each). Every linked machine is in reach; the
Assistant's per-Project reach setting still filters.

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

Pull, so a sleeping caller or callee loses nothing and no reverse link is needed for answers:

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

- Only bearer sessions with `orchestration:operate` reach the route; those come only from pairing
  this server (Nick's own clients and linked servers). That token can already dispatch any client
  command, so reach adds no new power; it only adds server-only writes the tools already allow
  the Assistant locally (Status, schedules, held messages).
- The caller identity in the body is a claim made by a holder of that token, used for labels and
  `remoteActor`. A callee refuses calls whose `caller.environmentId` is its own.
- Remote writes keep the local checks: a target Project must be live, marked and non-global; the
  Assistant's reach setting is checked on the Assistant's server before any call.
- Messages from another machine are labelled agent messages, never user instructions.

## Loops and duplicates

- Each op carries a fresh `requestId` that the callee builds its command ids from. The caller
  never retries an op itself: a failure goes back to the agent as an error, so one call lands at
  most once.
- Answers are pushes with no `replyTo`, so an answer never owes an answer.
- Thread sends and notes carry no `replyTo`; nothing chains across machines.
- The bridge appends with the callee's push id, so a repeated poll never doubles an answer.

## Decisions (defaults taken; say if you want otherwise)

1. **Pull, not push, for answers.** Works with a one-way link and survives either machine
   sleeping. Costs a 5 second poll only while asks are open.
2. **Explicit errors, no queued sends** when a machine is offline. Queued cross-machine sends can
   fire hours later out of context; the Assistant can retry, and schedules rerun.
3. **Coordinator `cp_assistant_ping` becomes a note to the Assistant,** not a direct user ping.
   The Assistant stays the only thing that pings the user.
4. **Every linked machine is in reach.** The per-Project reach setting filters. The reach picker
   in Settings lists only this server's Projects; `null` (all) includes remote ones.
5. **Tasks are not proxied.** Task Sync is the way to share one task list, and only the task
   authority (the Assistant's server) rolls commitments or serves Tasks to clients.

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

### Moving it (`assistant.move`, RPC on the current home)

1. **Freeze the source.** The current home archives its Assistant marker (`archivedAt`). That
   stops its schedules (ScheduleHost skips archived Projects), holds results for it (the reactor
   holds archived assistants), and makes `describe` report no Assistant. From here there are zero
   Assistants, never two.
2. **Bundle.** Assistant settings (`ServerSettings.assistant`: reach, workspaces, task access,
   new tasks, messaging, check-in, brief), the Assistant Project's schedules and prompts, the
   home folder's `MEMORY.md`, recent conversation (last 200 messages), and open asks from
   `reach-requests.json`.
3. **Adopt on the target** (new reach op `assistant.adopt`): `ensureAssistant`, apply the
   settings, recreate schedules with the same enabled state, write `MEMORY.md`, import the
   conversation with `thread.history.import` (shows in the thread; the new provider session
   starts with a one-line note that the conversation moved), and take over the open asks (the
   target polls the same machines).
4. **Commit or roll back.** On success the source keeps its archived Assistant as read-only
   history. On any failure the target deletes what it made and the source unarchives, so the user
   is back where they started. The move is idempotent by move id, so a retry finishes a partial
   move.
5. **Everything follows:** task authority (both sides re-`describe` right after the move),
   reach (the new home calls the same linked machines; it needs links both ways, checked before
   step 1), and clients (descriptor and shell updates point them at the new home).

Preconditions checked before step 1, each with a clear message: target linked and online, target
links back to this server (else offer "Link back" below), target runs a build with reach, and no
Assistant turn is running (or "Move after this turn").

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
