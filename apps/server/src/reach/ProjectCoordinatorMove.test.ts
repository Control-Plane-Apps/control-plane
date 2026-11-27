// @effect-diagnostics nodeBuiltinImport:off - two disposable Git repositories and SQLite databases.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
  ServerProvider,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeAgentPushQueries } from "../orchestration/agentPushes.ts";
import { agentDeliveryStartId } from "../orchestration/agentProtocol.ts";
import { it, expect } from "vite-plus/test";
import { MemoryRemoteAgentStore } from "../agentMachines/testFixtures.ts";
import { AgentMachines } from "../agentMachines/AgentMachines.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { layerConfig, makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import * as ScheduleRunner from "../schedules/ScheduleRunner.ts";
import { HostTimeZoneSource } from "../schedules/hostZone.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectCoordinatorMove, ProjectCoordinatorMoveLive } from "./ProjectCoordinatorMove.ts";
import { Reach, ReachError, unlinkedReach } from "./Reach.ts";
import { withGitWorkspaceWriter } from "./projectWorkspaceWriter.ts";
import { ProjectMoveStep } from "./projectMoveProtocol.ts";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeStep = Schema.decodeUnknownEffect(ProjectMoveStep);

it("recovers a non-Git coordinator move using the selected registered checkout and returns destination writes", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "project-move-pair-"));
  const sourceRoot = NodePath.join(root, "coordinator-workspace"),
    verifyRoot = NodePath.join(root, "registered-checkout"),
    populatedRoot = NodePath.join(root, "populated-checkout"),
    wrongRoot = NodePath.join(root, "unrelated-repository"),
    targetRoot = NodePath.join(root, "target-checkout");
  const at = "2026-01-01T00:00:00Z";
  const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
  const provider = decodeProvider({
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    installed: true,
    version: "1",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: at,
    models: [{ slug: "gpt-5.4", name: "gpt-5.4", isCustom: false, capabilities: null }],
  });
  const sourceId = ProjectId.make("source-project"),
    verificationId = ProjectId.make("verification-project"),
    populatedId = ProjectId.make("populated-project"),
    wrongId = ProjectId.make("wrong-repository"),
    targetId = ProjectId.make("target-project"),
    threadId = ThreadId.make("synthetic-coordinator");
  let send: (peerId: string, input: ProjectMoveStep) => Promise<unknown>;
  const completions: Extract<ProjectMoveStep, { action: "finishRollback" }>[] = [];
  let interruptFinish = false;
  let beforeReverse: (() => Promise<unknown>) | undefined;
  let shell: () => Promise<OrchestrationShellSnapshot>;
  let drop: ProjectMoveStep["action"] | null = null;
  const peer = { id: "destination", label: "Destination" };
  const boot = (id: string, cwd: string) => {
    const engine = OrchestrationEngineLive.pipe(
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provideMerge(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provideMerge(layerConfig),
      Layer.provideMerge(ServerConfig.layerTest(cwd, NodePath.join(root, id))),
      Layer.provideMerge(NodeServices.layer),
    );
    // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Each machine must dispose and reopen independent services over its persistent database.
    return ManagedRuntime.make(
      Layer.merge(ProjectCoordinatorMoveLive, ScheduleRunner.layer).pipe(
        Layer.tap((services) => Context.get(services, ScheduleRunner.ScheduleRunner).start()),
        Layer.provide(
          Layer.succeed(HostTimeZoneSource, () => ({ zone: "UTC", processZone: "UTC" })),
        ),
        Layer.provideMerge(engine),
        Layer.provide(makeProviderRegistryLayer([provider])),
        Layer.provide(MemoryRemoteAgentStore),
        Layer.provide(Layer.mock(AgentMachines)({ shell: () => Effect.promise(shell) })),
        Layer.provide(
          Layer.succeed(Reach, {
            ...unlinkedReach,
            self: Effect.succeed({ environmentId: id, label: id }),
            machines: Effect.succeed([peer]),
            call: (machine, _op, input, _caller, result) =>
              Effect.gen(function* () {
                const step = yield* decodeStep(input);
                const reply = yield* Effect.tryPromise({
                  try: () => send(id, step),
                  catch: String,
                });
                if (step.action === drop) {
                  drop = null;
                  return yield* Effect.fail("Lost acknowledgement.");
                }
                return yield* Schema.decodeUnknownEffect(result)(reply);
              }).pipe(
                Effect.mapError(
                  (e) =>
                    new ReachError({
                      kind: "timeout",
                      machineId: machine.id,
                      machineLabel: machine.label,
                      detail: String(e),
                    }),
                ),
              ),
          }),
        ),
        Layer.provide(
          Layer.mock(ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              agentPlacement: {
                ...DEFAULT_SERVER_SETTINGS.agentPlacement,
                machines: {
                  destination: {
                    label: "Destination",
                    enabled: true,
                    baseUrl: "http://localhost",
                    preference: 50,
                  },
                },
              },
            }),
          }),
        ),
      ),
    );
  };
  let source = boot("origin", sourceRoot),
    dest = boot("destination", targetRoot);
  const secondRoot = NodePath.join(root, "second-source-checkout");
  const second = boot("second-origin", secondRoot);
  const peerStep = (peerId: string, input: ProjectMoveStep) =>
    dest.runPromise(Effect.flatMap(ProjectCoordinatorMove, (s) => s.step(peerId, input)));
  send = async (peerId, input) => {
    if (input.action === "finishRollback") completions.push(input);
    if (input.action === "finishRollback" && interruptFinish) {
      interruptFinish = false;
      // Prevent capture of the active destination after the returning digest
      // is recorded and before any cleanup projections or files can change.
      const memory = NodePath.join(targetRoot, "MEMORY.md");
      const saved = NodePath.join(root, "interrupted-memory");
      await NodeFSP.rename(memory, saved);
      await NodeFSP.mkdir(memory);
      try {
        return await peerStep(peerId, input);
      } finally {
        await NodeFSP.rmdir(memory);
        await NodeFSP.rename(saved, memory);
      }
    }
    if (input.action === "reverse" && beforeReverse) {
      const mutate = beforeReverse;
      beforeReverse = undefined;
      await mutate();
    }
    return peerStep(peerId, input);
  };
  shell = () =>
    dest.runPromise(Effect.flatMap(ProjectionSnapshotQuery, (q) => q.getShellSnapshot()));
  const command = (c: OrchestrationCommand) =>
    Effect.flatMap(OrchestrationEngineService, (e) => e.dispatch(c));
  let nextId = 0;
  const cid = () => CommandId.make("fixture-command-" + ++nextId);
  let approvalDigest: string | undefined;
  const request = (
    operation: "options" | "preflight" | "move" | "retry" | "rollback" | "status",
    moveId = "synthetic-move",
    selection: {
      sourceCheckoutProjectId?: ProjectId;
      destinationProjectId?: ProjectId;
    } = operation === "preflight" || operation === "move"
      ? { sourceCheckoutProjectId: verificationId, destinationProjectId: targetId }
      : {},
  ) =>
    source.runPromise(
      Effect.flatMap(ProjectCoordinatorMove, (s) =>
        s.manage({
          action: "coordinatorMove",
          operation,
          projectId: sourceId,
          destinationId: "destination",
          moveId,
          ...selection,
          ...(approvalDigest ? { approvalDigest } : {}),
        }),
      ),
    );
  const restart = async () => {
    await source.dispose();
    await dest.dispose();
    source = boot("origin", sourceRoot);
    dest = boot("destination", targetRoot);
  };
  const restoreState = (moveId: string) =>
    dest.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [state] = yield* sql<{
          phase: string;
          fence: string | null;
          digest: string;
          returned: number;
          sequence: number;
        }>`
      SELECT r.phase, f.move_id AS fence, r.digest, r.return_bundle IS NOT NULL AS returned,
        (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_events) AS sequence
      FROM project_move_receipts r LEFT JOIN project_move_fences f USING(project_id)
      WHERE r.project_id=${targetId} AND r.move_id=${moveId}`;
        return state;
      }),
    );
  try {
    await NodeFSP.mkdir(sourceRoot);
    const git = (cwd: string, ...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, { cwd, stdio: "pipe" });
    await NodeFSP.mkdir(verifyRoot);
    git(verifyRoot, "init", "-b", "main");
    const memoryAt = (cwd: string) => NodeFSP.readFile(NodePath.join(cwd, "MEMORY.md"), "utf8");
    const checkoutMemory = "Verification checkout memory";
    await NodeFSP.writeFile(NodePath.join(verifyRoot, "MEMORY.md"), checkoutMemory);
    await NodeFSP.writeFile(NodePath.join(sourceRoot, "MEMORY.md"), "Synthetic memory");
    git(verifyRoot, "add", ".");
    git(
      verifyRoot,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    for (const repo of [targetRoot, populatedRoot, wrongRoot])
      git(root, "clone", "--local", verifyRoot, repo);
    git(verifyRoot, "remote", "add", "origin", "https://example.invalid/demo/project.git");
    git(targetRoot, "remote", "set-url", "origin", "https://example.invalid/demo/project.git");
    git(populatedRoot, "remote", "set-url", "origin", "https://example.invalid/demo/project.git");
    git(wrongRoot, "remote", "set-url", "origin", "https://example.invalid/demo/other.git");
    const verificationRole = NodePath.join(verifyRoot, "reviewer", "AGENTS.md");
    const originalRole = "Keep the verification Project role";
    await NodeFSP.mkdir(NodePath.dirname(verificationRole));
    await NodeFSP.appendFile(
      NodePath.join(verifyRoot, ".git", "info", "exclude"),
      "\n/reviewer/AGENTS.md\n",
    );
    await NodeFSP.writeFile(verificationRole, originalRole);
    git(verifyRoot, "check-ignore", "--quiet", "reviewer/AGENTS.md");
    for (const [runtime, id, cwd] of [
      [source, sourceId, sourceRoot],
      [source, verificationId, verifyRoot],
      [dest, populatedId, populatedRoot],
      [dest, wrongId, wrongRoot],
      [dest, targetId, targetRoot],
    ] as const) {
      await runtime.runPromise(
        command({
          type: "project.create",
          commandId: cid(),
          projectId: id,
          title: "Sample",
          workspaceRoot: cwd,
          createdAt: at,
        }),
      );
    }
    await source.runPromise(
      command({
        type: "thread.create",
        threadId,
        projectId: sourceId,
        commandId: cid(),
        title: "Coordinator",
        modelSelection: model,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: at,
      }),
    );
    await source.runPromise(
      command({
        type: "project.meta.update",
        projectId: sourceId,
        commandId: cid(),
        assistant: {
          coordinatorThreadId: threadId,
          schedules: [
            {
              id: "sample",
              name: "Sample",
              cron: "0 8 * * *",
              enabled: true,
              prompt: "Check",
              target: "coordinator",
            },
          ],
        },
      }),
    );
    const untouchedThread = ThreadId.make("already-running-here");
    await dest.runPromise(
      command({
        type: "thread.create",
        commandId: cid(),
        projectId: populatedId,
        threadId: untouchedThread,
        title: "Existing destination history",
        modelSelection: model,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: at,
      }),
    );
    await dest.runPromise(
      command({
        type: "thread.message.user.append",
        commandId: cid(),
        threadId: untouchedThread,
        createdAt: at,
        message: {
          messageId: MessageId.make("untouched-message"),
          text: "Keep existing history",
          attachments: [],
        },
      }),
    );
    const options = (
      await request("options", "synthetic-move", { sourceCheckoutProjectId: verificationId })
    ).coordinatorMove;
    expect(options?.sourceCheckouts?.map((item) => item.projectId)).toContain(verificationId);
    expect(options?.destinationProjects?.map((item) => item.projectId)).toEqual(
      expect.arrayContaining([targetId, populatedId]),
    );
    expect(
      options?.destinationProjects?.find((item) => item.projectId === populatedId)?.blockedReason,
    ).toBeTruthy();
    const blockedSelection = (destinationProjectId: ProjectId) => ({
      sourceCheckoutProjectId: verificationId,
      destinationProjectId,
    });
    await expect(
      request("preflight", "synthetic-move", blockedSelection(wrongId)),
    ).rejects.toThrow();
    await expect(
      request("preflight", "synthetic-move", blockedSelection(populatedId)),
    ).rejects.toThrow();
    await expect(
      request("preflight", "synthetic-move", {
        sourceCheckoutProjectId: wrongId,
        destinationProjectId: targetId,
      }),
    ).rejects.toThrow();
    const reviewed = (await request("preflight")).coordinatorMove;
    expect(reviewed?.ready).toBe(true);
    await expect(request("move")).rejects.toThrow("proposal changed");
    approvalDigest = reviewed?.approvalDigest;
    // A linked server can host a shell for this Project using its own SQL connection.
    const sourceDb = (await source.runPromise(Effect.service(ServerConfig))).dbPath;
    await source.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const terminal = yield* TerminalManager.makeWithOptions({
          sql,
          logsDir: NodePath.join(root, "terminal-logs"),
          ptyAdapter: yield* NodePtyAdapter.make(),
          env: { PATH: process.env.PATH, HOME: root, SHELL: "/bin/sh" },
        });
        const session = { threadId, terminalId: "review" };
        const opened = yield* terminal.open({ ...session, cwd: sourceRoot, cols: 80, rows: 24 });
        expect(opened.status).toBe("running");
        const previousOwner = (yield* Effect.promise(() => request("status"))).coordinatorMove;
        yield* Effect.promise(() => expect(request("move")).rejects.toThrow("unfinished terminal"));
        expect((yield* Effect.promise(() => request("status"))).coordinatorMove).toEqual(
          previousOwner,
        );
        expect(previousOwner).toMatchObject({ ownerId: "local", phase: "idle" });
        expect(yield* Effect.promise(() => restoreState("synthetic-move"))).toBeUndefined();
        yield* terminal.write({ ...session, data: "exit\r" });
        yield* sql`SELECT 1 FROM project_move_writers WHERE kind = 'terminal'`.pipe(
          Effect.repeat({
            while: (rows) => rows.length > 0,
            schedule: Schedule.spaced("10 millis"),
          }),
          Effect.timeout("5 seconds"),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.merge(makeSqlitePersistenceLive(sourceDb), ProcessRunner.layer).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );
    // Even a valid approval for the selected empty Project cannot authorize a sibling.
    for (const rejected of [wrongId, populatedId])
      await expect(request("move", "synthetic-move", blockedSelection(rejected))).rejects.toThrow();
    expect((await request("status")).coordinatorMove).toMatchObject({
      ownerId: "local",
      phase: "idle",
    });
    const writeVerificationRef = () =>
      source.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          withGitWorkspaceWriter(
            sql,
            { cwd: verifyRoot },
            "update-ref",
            Effect.sync(() =>
              git(verifyRoot, "update-ref", "refs/heads/verification-probe", "HEAD"),
            ),
          ),
        ),
      );
    const assertVerificationPaused = () =>
      expect(writeVerificationRef()).rejects.toThrow(/paused|checkout.*move|verification.*move/i);
    const abortId = "abort-before-activation";
    drop = "stage";
    await expect(request("move", abortId)).rejects.toThrow("Lost acknowledgement");
    await assertVerificationPaused();
    // Fail the final receipt commit once. The stage was never active, so the
    // source has no returned digest to present when it resumes the cleanup.
    await dest.runPromise(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`
      CREATE TRIGGER interrupt_aborted_cleanup BEFORE UPDATE OF phase ON project_move_receipts
      WHEN NEW.phase='rolled-back' BEGIN SELECT RAISE(ABORT,'interrupted cleanup'); END`,
      ),
    );
    await expect(request("rollback", abortId)).rejects.toThrow();
    await restart();
    await dest.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`DROP TRIGGER interrupt_aborted_cleanup`),
    );
    const aborted = await restoreState(abortId);
    expect(aborted).toMatchObject({ phase: "restoring", fence: abortId, returned: 0 });
    expect(aborted?.digest).toBeTruthy();
    await expect(
      peerStep("origin", {
        action: "finishRollback",
        projectId: targetId,
        peerProjectId: sourceId,
        moveId: abortId,
        returnedDigest: aborted!.digest,
      }),
    ).rejects.toThrow("checksum");
    expect(await restoreState(abortId)).toEqual(aborted);
    expect((await request("retry", abortId)).coordinatorMove?.phase).toBe("rolled-back");
    await writeVerificationRef();
    approvalDigest = (await request("preflight")).coordinatorMove?.approvalDigest;
    drop = "stage";
    await expect(request("move")).rejects.toThrow("Lost acknowledgement");
    await restart();
    await assertVerificationPaused();
    drop = "activate";
    await expect(request("retry")).rejects.toThrow("Lost acknowledgement");
    await restart();
    await assertVerificationPaused();
    expect((await request("retry")).coordinatorMove?.phase).toBe("active");
    await writeVerificationRef();
    expect(await memoryAt(targetRoot)).toBe("Synthetic memory");
    expect(await memoryAt(verifyRoot)).toBe(checkoutMemory);
    // The runner receives the same OS fire on both machines, including after both restart.
    const tomorrow = DateTime.nowUnsafe().pipe(
      DateTime.startOf("day"),
      DateTime.add({ days: 1, hours: 8 }),
    );
    const nextSlot = DateTime.toDateUtc(tomorrow);
    const slot = nextSlot.toISOString();
    const fire = (runtime: typeof source, tick = nextSlot) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const runner = yield* ScheduleRunner.ScheduleRunner;
          yield* runner.drain;
          yield* runner.requestFire(tick);
          yield* runner.drain;
        }),
      );
    const deliveries = (runtime: typeof source, tick = nextSlot) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const query = yield* ProjectionSnapshotQuery;
          const detail = Option.getOrNull(yield* query.getThreadDetailById(threadId));
          const messageId = `cp-schedule:${sourceId}:sample:${tick.toISOString()}`;
          return (
            detail?.messages
              .filter((message) => message.id === messageId)
              .map((message) => message.text) ?? []
          );
        }),
      );
    await fire(source);
    await fire(dest);
    await fire(dest);
    expect(await deliveries(source)).toEqual([]);
    expect(await deliveries(dest)).toEqual(["Check"]);
    expect(
      (await shell()).projects.find((p) => p.id === targetId)?.assistant?.scheduleRuns?.sample,
    ).toMatchObject({ slot, trigger: "cron", outcome: "sent" });
    const held = () =>
      dest.runPromise(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          makeAgentPushQueries(sql).listDeliveries(targetId),
        ),
      );
    const pending = await held();
    expect(pending).toHaveLength(1);
    const delivery = pending[0]!;
    expect(delivery.messageId).toBe(`cp-schedule:${sourceId}:sample:${slot}`);
    await dest.runPromise(
      command({
        type: "thread.turn.start",
        commandId: CommandId.make(agentDeliveryStartId(delivery.messageId)),
        threadId: delivery.threadId,
        runtimeMode: delivery.runtimeMode,
        interactionMode: delivery.interactionMode,
        createdAt: slot,
        message: {
          messageId: delivery.messageId,
          text: delivery.text,
          role: "user",
          attachments: [],
          ...(delivery.source ? { source: delivery.source } : {}),
        },
      }),
    );
    // The synthetic provider completes the actual scheduled turn before the
    // coordinator is eligible for the reverse fence.
    for (const status of ["running", "ready"] as const) {
      await dest.runPromise(
        command({
          type: "thread.session.set",
          commandId: cid(),
          threadId,
          createdAt: slot,
          session: {
            threadId,
            status,
            providerName: "codex",
            providerInstanceId: model.instanceId,
            runtimeMode: "approval-required",
            activeTurnId: status === "running" ? TurnId.make("synthetic-cron-turn") : null,
            lastError: null,
            updatedAt: slot,
          },
        }),
      );
    }
    expect(await held()).toEqual([]);
    const worker = ThreadId.make("synthetic-worktree-agent");
    await dest.runPromise(
      command({
        type: "thread.create",
        commandId: cid(),
        threadId: worker,
        projectId: targetId,
        modelSelection: model,
        title: "Worktree agent",
        interactionMode: "default",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: at,
      }),
    );
    const setWorktree = (worktreePath: string | null) =>
      dest.runPromise(
        command({
          type: "thread.meta.update",
          commandId: cid(),
          threadId: worker,
          worktreePath,
        }),
      );
    // An unrelated source Project owns an ID added independently at the destination.
    // Refuse while the destination is still writable, then exercise the same race
    // through normal engine dispatch between verification and the reverse call.
    const outsiderProject = ProjectId.make("unrelated-project"),
      outsider = ThreadId.make("unrelated-thread");
    const otherCheckout = NodePath.join(root, "other-checkout");
    await NodeFSP.mkdir(otherCheckout);
    await source.runPromise(
      command({
        type: "project.create",
        projectId: outsiderProject,
        commandId: cid(),
        title: "Other",
        workspaceRoot: otherCheckout,
        createdAt: at,
      }),
    );
    const createOutsider = (thread: ThreadId) =>
      source.runPromise(
        command({
          type: "thread.create",
          projectId: outsiderProject,
          commandId: cid(),
          threadId: thread,
          title: "Other",
          modelSelection: model,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: at,
        }),
      );
    await createOutsider(outsider);
    const append = (
      runtime: typeof source,
      thread: ThreadId,
      messageId: string,
      commandId = cid(),
    ) =>
      runtime.runPromise(
        command({
          type: "thread.message.user.append",
          commandId,
          threadId: thread,
          createdAt: at,
          message: {
            messageId: MessageId.make(messageId),
            text: "Synthetic " + messageId,
            attachments: [],
          },
        }),
      );
    await append(source, outsider, "duplicate-message");
    await append(dest, threadId, "duplicate-message");
    await expect(request("rollback")).rejects.toThrow("message identity collides");
    expect((await request("status")).coordinatorMove?.phase).toBe("active");
    const reservedCommand = cid();
    await append(dest, threadId, "new-after-refusal", reservedCommand);
    await source.runPromise(
      command({ type: "thread.delete", threadId: outsider, commandId: cid() }),
    );
    // Recreating a deleted synthetic draft resets its old projection rows.
    const racingThread = outsider;
    await createOutsider(racingThread);
    await setWorktree(NodePath.join(root, "worktree"));
    await expect(request("rollback")).rejects.toThrow("worktree");
    expect((await request("status")).coordinatorMove?.phase).toBe("active");
    await setWorktree(null);
    // Transfer-owned files may change. Other repository changes require repair
    // while the destination coordinator is still able to run.
    const drift = NodePath.join(targetRoot, "unprepared.txt");
    await NodeFSP.writeFile(drift, "Destination checkout changed");
    await expect(request("rollback")).rejects.toThrow("workspace contents differ");
    expect((await request("status")).coordinatorMove?.phase).toBe("active");
    await NodeFSP.unlink(drift);
    await NodeFSP.writeFile(verificationRole, "Independent verification role changed");
    await expect(request("rollback")).rejects.toThrow(
      /Project files in the separate source verification checkout changed/,
    );
    expect((await request("status")).coordinatorMove).toMatchObject({
      phase: "active",
      ownerId: "destination",
    });
    expect(await NodeFSP.readFile(verificationRole, "utf8")).toBe(
      "Independent verification role changed",
    );
    await NodeFSP.writeFile(verificationRole, originalRole);
    const verificationDrift = NodePath.join(verifyRoot, "local-unprepared.txt");
    await NodeFSP.writeFile(verificationDrift, "Change only the registered source checkout");
    await expect(request("rollback")).rejects.toThrow("workspace contents differ");
    expect((await request("status")).coordinatorMove).toMatchObject({
      phase: "active",
      ownerId: "destination",
    });
    await writeVerificationRef();
    await NodeFSP.unlink(verificationDrift);
    // A writer can win the interval between proposal and fence acquisition.
    // The destination releases the tentative fence if recapture fails.
    beforeReverse = async () => {
      await expect(append(source, racingThread, "new-after-refusal")).rejects.toThrow();
      await expect(
        append(source, racingThread, "different-message", reservedCommand),
      ).rejects.toThrow();
      await expect(createOutsider(worker)).rejects.toThrow();
      await append(source, racingThread, "unrelated-allowed");
      await setWorktree(NodePath.join(root, "new-worktree"));
    };
    await expect(request("rollback")).rejects.toThrow("worktree");
    expect((await request("status")).coordinatorMove).toMatchObject({
      phase: "active",
      ownerId: "destination",
    });
    await setWorktree(null);
    const db = (await dest.runPromise(Effect.service(ServerConfig))).dbPath;
    let crashed = false;
    beforeReverse = async () => {
      const child = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--experimental-transform-types",
          NodeURL.fileURLToPath(new URL("./projectMoveCrash.fixture.ts", import.meta.url)),
          db,
          targetId,
          "synthetic-move",
        ],
        { timeout: 15_000, encoding: "utf8" },
      );
      if (child.signal !== "SIGKILL") throw new Error("Crash fixture failed: " + child.stderr);
      crashed = true;
      throw new Error("Destination process exited");
    };
    await expect(request("rollback")).rejects.toThrow("Destination process exited");
    expect(crashed).toBe(true);
    await restart();
    const outstandingClaims = () =>
      source.runPromise(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) =>
            sql`SELECT identity FROM project_move_history_claims WHERE project_id=${sourceId}`,
        ),
      );
    // Transport ambiguity keeps the original verified IDs reserved through restart.
    expect((await outstandingClaims()).length).toBeGreaterThan(0);
    // Recovery releases the tentative fence before returning a new proposal.
    // A failed return preflight leaves this destination writable.
    await NodeFSP.writeFile(drift, "Changed after hard exit");
    await expect(request("retry")).rejects.toThrow("workspace contents differ");
    expect(await outstandingClaims()).toHaveLength(0);
    expect((await request("status")).coordinatorMove).toMatchObject({
      phase: "active",
      ownerId: "destination",
    });
    await NodeFSP.unlink(drift);
    await setWorktree(null);
    await NodeFSP.writeFile(NodePath.join(targetRoot, "MEMORY.md"), "Destination memory");
    drop = "reverse";
    await expect(request("rollback")).rejects.toThrow("Lost acknowledgement");
    await assertVerificationPaused();
    await restart();
    await assertVerificationPaused();
    interruptFinish = true;
    await expect(request("retry")).rejects.toThrow();
    await restart();
    const restoring = await restoreState("synthetic-move");
    expect(restoring).toMatchObject({ phase: "restoring", fence: "synthetic-move", returned: 1 });
    expect(restoring?.digest).toEqual(completions.at(-1)?.returnedDigest);
    const finish = {
      action: "finishRollback" as const,
      projectId: targetId,
      peerProjectId: sourceId,
      moveId: "synthetic-move",
    };
    for (const invalid of [finish, { ...finish, returnedDigest: "wrong-digest" }]) {
      await expect(peerStep("origin", invalid)).rejects.toThrow("checksum");
      expect(await restoreState("synthetic-move")).toEqual(restoring);
      expect(
        (await shell()).projects.find((p) => p.id === targetId)?.assistant?.coordinatorThreadId,
      ).toBe(threadId);
      expect(await NodeFSP.readFile(NodePath.join(targetRoot, "MEMORY.md"), "utf8")).toBe(
        "Destination memory",
      );
    }
    drop = "finishRollback";
    await expect(request("retry")).rejects.toThrow("Lost acknowledgement");
    await restart();
    await assertVerificationPaused();
    expect(await memoryAt(targetRoot)).toBe(checkoutMemory);
    expect(await memoryAt(verifyRoot)).toBe(checkoutMemory);
    expect(await memoryAt(sourceRoot)).toBe("Destination memory");
    expect(await NodeFSP.readFile(verificationRole, "utf8")).toBe(originalRole);
    expect(await memoryAt(populatedRoot)).toBe(checkoutMemory);
    expect(await memoryAt(wrongRoot)).toBe(checkoutMemory);
    const untouched = await dest.runPromise(
      Effect.flatMap(ProjectionSnapshotQuery, (q) => q.getThreadDetailById(untouchedThread)),
    );
    expect(Option.getOrNull(untouched)?.messages.map((message) => message.text)).toEqual([
      "Keep existing history",
    ]);
    // A distinct origin reuses the checkout before the original source
    // receives its acknowledgement. Each origin has its own database and history.
    git(root, "clone", "--local", targetRoot, secondRoot);
    // Git clones preserve the executable bit. The readiness fingerprint also
    // compares ordinary permission bits and working bytes of the restored file.
    const targetMemory = NodePath.join(targetRoot, "MEMORY.md");
    const secondMemory = NodePath.join(secondRoot, "MEMORY.md");
    await NodeFSP.copyFile(targetMemory, secondMemory);
    await NodeFSP.chmod(secondMemory, (await NodeFSP.stat(targetMemory)).mode & 0o777);

    git(secondRoot, "remote", "set-url", "origin", "https://example.invalid/demo/project.git");
    const secondId = ProjectId.make("second-project");
    const secondCoordinator = ThreadId.make("second-coordinator");
    await second.runPromise(
      command({
        type: "project.create",
        commandId: cid(),
        projectId: secondId,
        title: "Second Project",
        workspaceRoot: secondRoot,
        createdAt: at,
      }),
    );
    await second.runPromise(
      command({
        type: "thread.create",
        commandId: cid(),
        projectId: secondId,
        threadId: secondCoordinator,
        title: "Second coordinator",
        modelSelection: model,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: at,
      }),
    );
    await second.runPromise(
      command({
        type: "project.meta.update",
        commandId: cid(),
        projectId: secondId,
        assistant: { coordinatorThreadId: secondCoordinator },
      }),
    );
    const appendToSecond = (text: string) =>
      command({
        type: "thread.message.user.append",
        commandId: cid(),
        threadId: secondCoordinator,
        createdAt: at,
        message: { messageId: MessageId.make(text), text, attachments: [] },
      });
    await second.runPromise(appendToSecond("distinct-source-history"));
    const secondRequest = (operation: "preflight" | "move", approved?: string) =>
      second.runPromise(
        Effect.flatMap(ProjectCoordinatorMove, (service) =>
          service.manage({
            action: "coordinatorMove",
            operation,
            projectId: secondId,
            destinationId: "destination",
            moveId: "next-move",
            destinationProjectId: targetId,
            ...(approved ? { approvalDigest: approved } : {}),
          }),
        ),
      );
    const secondReview = await secondRequest("preflight");
    expect(secondReview.coordinatorMove?.ready).toBe(true);
    expect(
      (await secondRequest("move", secondReview.coordinatorMove?.approvalDigest)).coordinatorMove
        ?.phase,
    ).toBe("active");
    await dest.runPromise(appendToSecond("before-old-ack"));
    const oldFinish = completions.at(-1)!;
    expect(oldFinish.returnedDigest).toBeTruthy();
    await expect(peerStep("second-origin", oldFinish)).rejects.toThrow("does not match");
    await expect(
      peerStep("origin", { ...oldFinish, peerProjectId: "different-project" }),
    ).rejects.toThrow("does not match");
    await expect(
      peerStep("origin", { ...oldFinish, returnedDigest: "different-digest" }),
    ).rejects.toThrow("does not match");
    await expect(peerStep("origin", { ...oldFinish, action: "reverse" })).rejects.toThrow(
      "superseded",
    );
    expect((await request("retry")).coordinatorMove?.phase).toBe("rolled-back");
    await writeVerificationRef();
    await dest.runPromise(appendToSecond("after-old-ack"));
    await expect(second.runPromise(appendToSecond("fenced-original"))).rejects.toThrow();
    const current = await dest.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const receipts =
          yield* sql`SELECT r.move_id, r.peer_id, r.peer_project_id, r.phase, f.move_id AS fence
        FROM project_move_receipts r LEFT JOIN project_move_fences f USING(project_id)
        WHERE r.project_id=${targetId} AND r.move_id='next-move'`;
        const query = yield* ProjectionSnapshotQuery;
        const detail = Option.getOrNull(yield* query.getThreadDetailById(secondCoordinator));
        return { receipts, messages: detail?.messages.map((message) => message.text) };
      }),
    );
    expect(current.receipts).toEqual([
      {
        move_id: "next-move",
        peer_id: "second-origin",
        peer_project_id: secondId,
        phase: "active",
        fence: null,
      },
    ]);
    expect(current.messages?.toSorted()).toEqual([
      "after-old-ack",
      "before-old-ack",
      "distinct-source-history",
    ]);
    expect(await NodeFSP.readFile(NodePath.join(sourceRoot, "MEMORY.md"), "utf8")).toBe(
      "Destination memory",
    );
    const restored = await source.runPromise(
      Effect.flatMap(ProjectionSnapshotQuery, (s) => s.getShellSnapshot()),
    );
    expect(
      restored.projects.find((p) => p.id === sourceId)?.assistant?.scheduleRuns?.sample?.slot,
    ).toBe(slot);
    await fire(dest);
    await fire(source);
    expect(await deliveries(source)).toEqual(["Check"]);
    expect(await deliveries(dest)).toEqual([]);
    const followingSlot = DateTime.toDateUtc(DateTime.add(tomorrow, { days: 1 }));
    await fire(dest, followingSlot);
    await fire(source, followingSlot);
    await fire(source, followingSlot);
    expect(await deliveries(source, followingSlot)).toEqual(["Check"]);
    expect(await deliveries(dest, followingSlot)).toEqual([]);
    expect(
      (await shell()).projects.find((p) => p.id === targetId)?.assistant?.coordinatorThreadId,
    ).toBe(secondCoordinator);
  } finally {
    await second.dispose();
    await source.dispose();
    await dest.dispose();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}, 60000);
