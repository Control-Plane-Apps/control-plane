import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  ProviderInstanceId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { workspaceFingerprint } from "../agentMachines/workspaceFingerprint.ts";
import { cleanWorkspace } from "../agentMachines/workspaceResume.ts";
import { resolveAgentModel } from "../mcp/toolkits/agents/agentScope.ts";
import { isThreadBusy } from "../agentMachines/remoteAgentState.ts";
import { threadHasQueuedTurnStart } from "./ThreadSettlementPolicy.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { makeProjectReadiness } from "../agentMachines/projectReadiness.ts";
import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import { cleanupFailedUploadedAttachments, normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

function withHttpAgentMessageSource(command: OrchestrationCommand): OrchestrationCommand {
  if (command.type !== "thread.turn.start" || command.message.source !== undefined) {
    return command;
  }
  return {
    ...command,
    message: {
      ...command.message,
      source: { kind: "agent" },
    },
  };
}

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectCloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;

    const projectReadiness = yield* makeProjectReadiness;
    const providers = yield* ProviderRegistry;
    const turns = yield* ProjectionTurnRepository;
    const git = yield* GitVcsDriver;
    const fs = yield* FileSystem.FileSystem;
    return handlers
      .handle(
        "agentWorkspace",
        Effect.fn("environment.orchestration.agentWorkspace")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const { projectId, threadId } = args.params;
          const project = Option.getOrUndefined(
            yield* projectionSnapshotQuery
              .getProjectShellById(projectId)
              .pipe(
                Effect.catch((cause) =>
                  failEnvironmentInternal("orchestration_snapshot_failed", cause),
                ),
              ),
          );
          const thread = Option.getOrUndefined(
            yield* projectionSnapshotQuery
              .getThreadShellById(threadId)
              .pipe(
                Effect.catch((cause) =>
                  failEnvironmentInternal("orchestration_snapshot_failed", cause),
                ),
              ),
          );
          if (
            !project ||
            !thread ||
            thread.projectId !== projectId ||
            project.assistant?.archivedAt != null ||
            thread.archivedAt !== null ||
            thread.settledAt !== null
          ) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          const pending = yield* turns
            .getPendingTurnStartByThreadId({ threadId })
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
          const idle =
            Option.isNone(pending) &&
            !isThreadBusy(thread) &&
            thread.backgroundLiveness == null &&
            thread.latestTurn?.state !== "running" &&
            !threadHasQueuedTurnStart(thread, now);
          const workspace = yield* Effect.gen(function* () {
            const root = yield* fs.realPath(thread.worktreePath ?? project.workspaceRoot);
            const result = yield* git.execute({
              operation: "agent.workspace",
              cwd: root,
              args: [
                "--no-optional-locks",
                "status",
                "--porcelain=v2",
                "--branch",
                "--untracked-files=normal",
                "--ignore-submodules=none",
              ],
              timeoutMs: 2000,
              maxOutputBytes: 4096,
            });
            const position = cleanWorkspace(root, result.stdout, true);
            if (!position || (thread.branch && thread.branch !== position.branch))
              return { workspace: null, position: null };
            return {
              workspace: result.stdoutTruncated ? null : cleanWorkspace(root, result.stdout),
              position,
            };
          }).pipe(Effect.orElseSucceed(() => ({ workspace: null, position: null })));
          return { ...workspace, idle };
        }),
      )
      .handle(
        "handoffWorkspace",
        Effect.fn("environment.orchestration.handoffWorkspace")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const project = Option.getOrNull(
            yield* projectionSnapshotQuery
              .getProjectShellById(args.params.projectId)
              .pipe(
                Effect.catch((cause) =>
                  failEnvironmentInternal("orchestration_snapshot_failed", cause),
                ),
              ),
          );
          if (!project?.repositoryIdentity || project.assistant?.archivedAt != null)
            return yield* failEnvironmentNotFound("project_not_found");
          let directory = project.workspaceRoot;
          if (args.payload.threadId) {
            const thread = Option.getOrNull(
              yield* projectionSnapshotQuery
                .getThreadShellById(args.payload.threadId)
                .pipe(
                  Effect.catch((cause) =>
                    failEnvironmentInternal("orchestration_snapshot_failed", cause),
                  ),
                ),
            );
            if (!thread || thread.projectId !== project.id)
              return yield* failEnvironmentNotFound("thread_not_found");
            directory = thread.worktreePath ?? directory;
          }
          return yield* Effect.tryPromise(() =>
            workspaceFingerprint(directory, project.repositoryIdentity ?? undefined),
          ).pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_snapshot_failed", cause),
            ),
          );
        }),
      )
      .handle(
        "projectReadiness",
        Effect.fn("environment.orchestration.projectReadiness")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const project = yield* projectionSnapshotQuery
            .getProjectShellById(args.params.projectId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(project)) return yield* failEnvironmentNotFound("project_not_found");
          const instances = yield* providers.getProviders;
          const { instanceId, model } = args.payload;
          const resolved =
            model &&
            resolveAgentModel({
              requested: model,
              base: { instanceId: ProviderInstanceId.make(instanceId), model },
              providers: instances,
            });
          const selection =
            resolved && resolved.kind === "resolved" ? resolved.modelSelection : undefined;
          const provider = instances.find(
            (entry) => entry.instanceId === (model ? selection?.instanceId : instanceId),
          );
          const readiness = yield* projectReadiness(project.value, provider);
          return {
            ...readiness,
            ...(selection && readiness.provider ? { modelSelection: selection } : {}),
          };
        }),
      )
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          // Serve the lightweight command read model (thread bodies empty)
          // instead of the fully hydrated snapshot. Hydrating every message
          // and activity payload in the database has OOM-killed servers, and
          // the route's only consumer (the project CLI) reads projects alone —
          // UI clients load the shell and per-thread snapshots instead.
          return yield* projectionSnapshotQuery
            .getCommandReadModel()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(
              args.params.threadId,
              args.payload.turnLimit === undefined
                ? undefined
                : {
                    turnLimit: args.payload.turnLimit,
                    ...(args.payload.beforeCursor !== undefined
                      ? { beforeCursor: args.payload.beforeCursor }
                      : {}),
                  },
            )
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(
            snapshot.value,
            args.payload.reasoningMessages === "true",
          );
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* ProjectCloneTracker.rejectCommandsDuringClone(
            projectCloneTracker,
            args.payload,
          ).pipe(
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
          const normalizedCommand = withHttpAgentMessageSource(
            yield* normalizeDispatchCommand(args.payload).pipe(
              Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
            ),
          );
          const result = yield* orchestrationEngine.dispatch(normalizedCommand).pipe(
            Effect.tapError(() =>
              cleanupFailedUploadedAttachments(args.payload, normalizedCommand),
            ),
            Effect.catch((cause) =>
              failEnvironmentInternal("orchestration_dispatch_failed", cause),
            ),
          );
          yield* ProjectCloneTracker.discardCloneForDeletedProject(
            projectCloneTracker,
            normalizedCommand,
          );
          return result;
        }),
      );
  }),
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
