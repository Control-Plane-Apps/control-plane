# Project coordinator move (Stage B design)

The move applies to one Project. The Project owner selects a linked destination, reviews the preflight and explicitly approves cutover after readiness is verified.

1. Resolve both environment identities and the unambiguous destination checkout. Verify repository identity, branch, commit, clean worktree or an explicitly transferred workspace, provider access and the Project's required integrations. Configuration presence is only preliminary evidence. Verify the destination can perform the required operations with authorized read-only checks. Keep credentials local to each machine.
2. Inventory coordinator history, active state, attachments, Project memory files, schedules and their last execution receipts. Identify agents with pending work and their original workspace. Refuse cutover while a turn, schedule or delivery can still write without participating in the move.
3. Acquire a durable Project move lock and fence new turns, agent deliveries and schedule claims on the source. Save the source snapshot, event watermark, ownership record and checksums. Import using a repeatable move ID into a destination with execution disabled. Resolve identity collisions before activating anything.
4. Compare message IDs and counts, attachment hashes, last-turn state, memory checksums, schedule definitions, time zones, next due times and execution receipts. Verify the destination sees existing agents and can route a scoped response. Stop on any discrepancy.
5. Switch the authoritative coordinator once. Enable destination execution only after confirming the source fence. Verify a coordinator read and message, one scheduled claim in a synthetic rehearsal, memory retrieval and the absence of duplicate execution. Keep a durable move receipt and source recovery copy.
6. Before activation, rollback releases the source fence after abandoning the staged import. After activation, fence the destination first. Reconcile every write and schedule receipt since the cutover watermark back to the source and verify parity before restoring source ownership. If either fence or reconciliation cannot be proved, leave execution paused for operator recovery.

Stage B requires a two-environment rehearsal covering a crash at each ownership transition and rollback after a destination write. Moving the top-level Assistant does not demonstrate per-Project coordinator recovery.

## Recovery and scope

Open the source Project settings and choose a linked environment under **Coordinator runs on**. If the coordinator lives in a separate Project folder, choose the registered checkout to use for repository verification. Project memory and role files are read from the coordinator’s existing folder and restored there on rollback. The selected source checkout keeps its own threads and files. On the linked machine, select an empty registered Project for the same repository. An existing Project with threads is ineligible. Choosing a different destination preserves those threads. Review the checkout and access checks before selecting **Move coordinator**. After an interrupted request, reopen those settings and refresh the receipt. Retry continues the recorded move. Rollback fences the destination and verifies the returned state before enabling the source.

The move keeps each machine’s original Project ID and checkout path. Coordinator and agent thread IDs remain stable. The source retains its history and a durable recovery copy while its write fence is held. A live thread using a separate worktree must be detached before a move. Retained history can still name that worktree. Rollback checks the returning snapshot and checkout while the destination is still active, then checks them again under its fence. Root MEMORY.md, root AGENTS.md and supported immediate role directories return with the Project. An unrelated file difference must be reconciled while the destination is still active.

During rollback, the original source checks whether any returned history ID belongs to an unrelated thread. A conflict leaves the destination running and the unrelated history intact. Once validation succeeds, the source reserves the identities until it installs the return. If cleanup is interrupted, the destination checks the authenticated request against its persisted return digest before it resumes. If cleanup finishes but the reply is lost, retry uses the original completion receipt, even if another coordinator has since moved into the destination.

### Agents on linked machines

An idle placed agent keeps its thread ID, execution Project and checkout on its worker machine. Both coordinators need reciprocal links to that worker. Preflight checks the worker's original placement prompt, execution Project and idle state over those links. Its peer messages continue to reach its original home. That machine matches the worker environment, execution Project and thread to a move receipt. The receiving coordinator verifies current ownership and its agent association before accepting the reply. If the former home sleeps or goes offline, those inherited workers cannot deliver replies until it is reachable again. The active destination can still run its local coordinator and schedules. Workers placed by the destination can reply directly to it while the former home is asleep, provided their execution machine and return link are reachable. After rollback those workers continue to use the destination as their original home, even when its checkout hosts another Project. Their return path remains bound to the original worker and Project. Competing local associations and ambiguous receipts block delivery.

Finish pending agent turns, deliveries, holds and handoffs before moving. A worker running inside the proposed destination Project makes that Project ineligible as an empty destination. A Project hosting another coordinator's agent or an agent whose return path already requires a second forwarding hop also needs its placement reconciled before another move.

## What readiness establishes

Preflight checks the registered repository identity, branch, HEAD, index and workspace fingerprint. Schedules require the same host time zone. The destination refreshes the selected provider instance, checks its installed, enabled and authenticated status, and looks up the coordinator model in the returned catalog. This check exercises provider discovery. A successful model turn requires separate evidence.

The move probes integrations required by either Project's placement settings, using destination credentials. An integration omitted from both settings receives no probe.

| Integration  | Read performed on the destination                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub       | Read repository metadata and compare the returned owner and repository to the checkout identity.                                                         |
| Vercel       | Inspect the Project linked by the checkout's Vercel organization and Project IDs.                                                                        |
| EAS          | Read the configured Expo app by ID and compare its returned ID. The ID comes from app.json or the destination environment.                               |
| Sentry       | List releases in the organization and Project named by the destination environment. An empty successful list passes.                                     |
| PostHog      | Read the Project named by the destination configuration and compare the returned numeric ID.                                                             |
| Read replica | Connect using the configured read-only URL and require PostgreSQL to return `on` for `SHOW transaction_read_only`.                                       |
| MCP          | Compare the enabled workspace server definitions with the machine definitions, then verify each has a live Codex connection and a nonempty tool catalog. |

These reads establish access to the resources selected on the destination. For identifiers supplied by its environment, an operator must independently match them to the intended Project. In particular, transaction read-only mode does not identify a database, and an MCP catalog does not exercise an individual tool. The synthetic rehearsal supplies no evidence about mini credentials or Hometrace resource identity. A Hometrace move requires mini readiness for the intended resources and Nick's explicit go.

### Interrupted writer recovery

A paused move identifies the unfinished operation, kind, host and server PID. Retry after a live owner completes. For a terminated owner on this host, Retry automatically reclaims in-process file, schedule and Status writes. Normal busy checks, fresh inventory and verification still run. Linux compares the boot ID and process start tick. macOS compares the process start time. A reused PID with a different generation proves the original process exited. When the generation is unavailable, retry requires the PID to disappear. A host rename requires restoring the recorded hostname on the original machine before recovery. An ambiguous identity leaves the writer in place.

Every terminal records its thread, canonical working directory and optional worktree before spawn, including terminals opened before Project registration. Every server using the state directory must run a version that records terminal ownership. Close terminals from older servers and restart those servers before the first move. Updated runtimes consult the shared records when acquiring a fence. A restart keeps the old shell's reservation until it exits, and the replacement gets its own reservation. Closing a terminal window or requesting a kill does not release the reservation. The exit callback releases it, or a living owner can verify the recorded process generation has ended. If the owner crashed, reconcile the external result. The recovery command refuses a live or unverifiable recorded PTY.

Git commands, terminal launches, provider calls and peer deliveries can continue outside the server. Inspect the original checkout and its child processes for Git or terminal work. For provider or peer writes, check the provider session or the receiving environment and match the outcome to its durable turn or delivery receipt. If the outcome or quiescence is uncertain, leave the writer paused. Once the owner has exited and an operator has verified that the external work has finished, run the following on the original host with the exact Project and operation IDs from the pause reason.

```sh
node apps/server/scripts/reconcile-project-writer.ts "$DATABASE" "$PROJECT_ID" "$OPERATION_ID" "$VERIFIED_OUTCOME_AND_EVIDENCE_REFERENCE"
```

The command records the evidence and removes only that abandoned writer in one transaction. Repeating the same command returns the existing receipt. Retry the move to recheck its fence, activity and inventories.
