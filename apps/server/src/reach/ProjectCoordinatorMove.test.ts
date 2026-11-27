// @effect-diagnostics nodeBuiltinImport:off - two disposable Git repositories and SQLite databases.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
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
import { layerConfig } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import * as ScheduleRunner from "../schedules/ScheduleRunner.ts";
import { HostTimeZoneSource } from "../schedules/hostZone.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectCoordinatorMove, ProjectCoordinatorMoveLive } from "./ProjectCoordinatorMove.ts";
import { Reach, ReachError, unlinkedReach } from "./Reach.ts";
import { ProjectMoveStep } from "./projectMoveProtocol.ts";

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeStep = Schema.decodeUnknownEffect(ProjectMoveStep);

it("recovers each lost ownership acknowledgement across restarts and returns destination writes", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "project-move-pair-"));
  const sourceRoot = NodePath.join(root, "source-checkout"),
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
    targetId = ProjectId.make("target-project"),
    threadId = ThreadId.make("synthetic-coordinator");
  let send: (input: ProjectMoveStep) => Promise<unknown>;
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
                const reply = yield* Effect.tryPromise({ try: () => send(step), catch: String });
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
  send = async (input) => {
    if (input.action === "reverse" && beforeReverse) {
      const mutate = beforeReverse;
      beforeReverse = undefined;
      await mutate();
    }
    return dest.runPromise(Effect.flatMap(ProjectCoordinatorMove, (s) => s.step("origin", input)));
  };
  shell = () =>
    dest.runPromise(Effect.flatMap(ProjectionSnapshotQuery, (q) => q.getShellSnapshot()));
  const command = (c: OrchestrationCommand) =>
    Effect.flatMap(OrchestrationEngineService, (e) => e.dispatch(c));
  let nextId = 0;
  const cid = () => CommandId.make("fixture-command-" + ++nextId);
  let approvalDigest: string | undefined;
  const request = (operation: "preflight" | "move" | "retry" | "rollback" | "status") =>
    source.runPromise(
      Effect.flatMap(ProjectCoordinatorMove, (s) =>
        s.manage({
          action: "coordinatorMove",
          operation,
          projectId: sourceId,
          destinationId: "destination",
          moveId: "synthetic-move",
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
  try {
    await NodeFSP.mkdir(sourceRoot);
    const git = (cwd: string, ...args: string[]) =>
      NodeChildProcess.execFileSync("git", args, { cwd, stdio: "pipe" });
    git(sourceRoot, "init", "-b", "main");
    await NodeFSP.writeFile(NodePath.join(sourceRoot, "MEMORY.md"), "Synthetic memory");
    git(sourceRoot, "add", ".");
    git(
      sourceRoot,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    git(root, "clone", "--local", sourceRoot, targetRoot);
    git(sourceRoot, "remote", "add", "origin", "https://example.invalid/demo/project.git");
    git(targetRoot, "remote", "set-url", "origin", "https://example.invalid/demo/project.git");
    for (const [runtime, id, cwd] of [
      [source, sourceId, sourceRoot],
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
    const reviewed = (await request("preflight")).coordinatorMove;
    expect(reviewed?.ready).toBe(true);
    await expect(request("move")).rejects.toThrow("proposal changed");
    approvalDigest = reviewed?.approvalDigest;
    drop = "stage";
    await expect(request("move")).rejects.toThrow("Lost acknowledgement");
    await restart();
    drop = "activate";
    await expect(request("retry")).rejects.toThrow("Lost acknowledgement");
    await restart();
    expect((await request("retry")).coordinatorMove?.phase).toBe("active");
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
    // A writer can win the interval between proposal and fence acquisition.
    // The destination releases the tentative fence if recapture fails.
    beforeReverse = () => setWorktree(NodePath.join(root, "new-worktree"));
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
    // Recovery releases the tentative fence before returning a new proposal.
    // A failed return preflight leaves this destination writable.
    await NodeFSP.writeFile(drift, "Changed after hard exit");
    await expect(request("retry")).rejects.toThrow("workspace contents differ");
    expect((await request("status")).coordinatorMove).toMatchObject({
      phase: "active",
      ownerId: "destination",
    });
    await NodeFSP.unlink(drift);
    await setWorktree(null);
    await NodeFSP.writeFile(NodePath.join(targetRoot, "MEMORY.md"), "Destination memory");
    drop = "reverse";
    await expect(request("rollback")).rejects.toThrow("Lost acknowledgement");
    await restart();
    drop = "finishRollback";
    await expect(request("retry")).rejects.toThrow("Lost acknowledgement");
    await restart();
    expect((await request("retry")).coordinatorMove?.phase).toBe("rolled-back");
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
    expect((await shell()).projects.find((p) => p.id === targetId)?.assistant).toBeFalsy();
  } finally {
    await source.dispose();
    await dest.dispose();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}, 60000);
