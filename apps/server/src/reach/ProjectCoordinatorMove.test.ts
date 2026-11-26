// @effect-diagnostics nodeBuiltinImport:off - two disposable Git repositories and SQLite databases.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  ServerProvider,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ManagedRuntime from "effect/ManagedRuntime";
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
import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectCoordinatorMove, ProjectCoordinatorMoveLive } from "./ProjectCoordinatorMove.ts";
import { Reach, ReachError, unlinkedReach } from "./Reach.ts";
import { ProjectMoveStep } from "./projectMoveProtocol.ts";

it("recovers each lost ownership acknowledgement across restarts and returns destination writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-move-pair-"));
  const sourceRoot = join(root, "source-checkout"),
    targetRoot = join(root, "target-checkout");
  const at = "2026-01-01T00:00:00Z";
  const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
  const provider = Schema.decodeUnknownSync(ServerProvider)({
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
      Layer.provideMerge(ServerConfig.layerTest(cwd, join(root, id))),
      Layer.provideMerge(NodeServices.layer),
    );
    return ManagedRuntime.make(
      ProjectCoordinatorMoveLive.pipe(
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
              Effect.tryPromise({
                try: async () => {
                  const step = await Effect.runPromise(
                    Schema.decodeUnknownEffect(ProjectMoveStep)(input),
                  );
                  const reply = await send(step);
                  if (step.action === drop) {
                    drop = null;
                    throw new Error("Lost acknowledgement.");
                  }
                  return await Effect.runPromise(Schema.decodeUnknownEffect(result)(reply));
                },
                catch: (e) =>
                  new ReachError({
                    kind: "timeout",
                    machineId: machine.id,
                    machineLabel: machine.label,
                    detail: String(e),
                  }),
              }),
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
  send = (input) =>
    dest.runPromise(Effect.flatMap(ProjectCoordinatorMove, (s) => s.step("origin", input)));
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
    await mkdir(sourceRoot);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe" });
    git(sourceRoot, "init", "-b", "main");
    await writeFile(join(sourceRoot, "MEMORY.md"), "Synthetic memory");
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
    const write = (id: ProjectId) =>
      command({
        type: "project.schedule.record",
        projectId: id,
        commandId: cid(),
        scheduleId: "sample",
        createdAt: at,
        run: { at, slot: at, trigger: "cron", outcome: "sent" },
      });
    await expect(source.runPromise(write(sourceId))).rejects.toThrow();
    await dest.runPromise(write(targetId));
    await writeFile(join(targetRoot, "MEMORY.md"), "Destination memory");
    drop = "reverse";
    await expect(request("rollback")).rejects.toThrow("Lost acknowledgement");
    await restart();
    drop = "finishRollback";
    await expect(request("retry")).rejects.toThrow("Lost acknowledgement");
    await restart();
    expect((await request("retry")).coordinatorMove?.phase).toBe("rolled-back");
    expect(await readFile(join(sourceRoot, "MEMORY.md"), "utf8")).toBe("Destination memory");
    const restored = await source.runPromise(
      Effect.flatMap(ProjectionSnapshotQuery, (s) => s.getShellSnapshot()),
    );
    expect(
      restored.projects.find((p) => p.id === sourceId)?.assistant?.scheduleRuns?.sample?.slot,
    ).toBe(at);
    expect((await shell()).projects.find((p) => p.id === targetId)?.assistant).toBeFalsy();
  } finally {
    await source.dispose();
    await dest.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
