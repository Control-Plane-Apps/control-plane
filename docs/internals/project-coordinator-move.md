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

Open the source Project settings and choose a linked environment under **Coordinator runs on**. The destination needs a registered, empty workspace for the same repository. Review the checkout and access checks before selecting **Move coordinator**. After an interrupted request, reopen those settings and refresh the receipt. Retry continues the recorded move. Rollback fences the destination and verifies the returned state before enabling the source.

The move keeps each machine’s original Project ID and checkout path. Coordinator and agent thread IDs remain stable. The source retains its history and a durable recovery copy while its write fence is held. A different worktree or an agent whose responses still route through a third environment requires separate verified routing. The move stops during inventory in those cases.
