// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  ASSISTANT_HOME_DIR,
  AssistantEnsureError,
  type AssistantEnsureInput,
  type AssistantEnsureResult,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  findGlobalAssistantProject,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Semaphore from "effect/Semaphore";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

// Fork-owned. The `server.assistantEnsure` RPC: the cross-Project Assistant is
// an ordinary Project whose marker has `scope: "global"`, homed in
// `<stateDir>/assistant`, so it reuses the coordinator stack (provider
// session, schedules, results, MEMORY.md). Created on first open, once.

const STARTER_MEMORY = `# Assistant memory

Preferences and standing facts the Assistant keeps across conversations. Edit freely.
`;

/** Serializes ensures, so two clients opening the Assistant at once make one. */
const lock = Semaphore.makeUnsafe(1);

export const ensureAssistant = Effect.fnUntraced(function* (input: {
  readonly stateDir: string;
  readonly request: AssistantEnsureInput;
  readonly engine: OrchestrationEngineShape;
  readonly snapshots: ProjectionSnapshotQueryShape;
}) {
  const fail = (detail: string) => (cause: unknown) =>
    new AssistantEnsureError({
      detail: `${detail}${cause instanceof Error ? `: ${cause.message}` : ""}`,
    });
  return yield* lock.withPermits(1)(
    Effect.gen(function* () {
      const snapshot = yield* input.snapshots
        .getShellSnapshot()
        .pipe(Effect.mapError(fail("Could not read Projects")));
      const existing = findGlobalAssistantProject(snapshot.projects);
      if (existing?.assistant != null) {
        return {
          projectId: existing.id,
          threadId: existing.assistant.coordinatorThreadId,
          created: false,
        } satisfies AssistantEnsureResult;
      }

      const fs = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
      const home = NodePath.join(input.stateDir, ASSISTANT_HOME_DIR);
      yield* fs
        .makeDirectory(home, { recursive: true })
        .pipe(Effect.mapError(fail(`Could not create ${home}`)));
      const memoryPath = NodePath.join(home, "MEMORY.md");
      if (!(yield* fs.exists(memoryPath).pipe(Effect.orElseSucceed(() => false)))) {
        yield* fs
          .writeFileString(memoryPath, STARTER_MEMORY)
          .pipe(Effect.mapError(fail(`Could not write ${memoryPath}`)));
      }

      const projectId = ProjectId.make(yield* uuid);
      const threadId = ThreadId.make(yield* uuid);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const dispatch = (command: Parameters<OrchestrationEngineShape["dispatch"]>[0]) =>
        input.engine
          .dispatch(command)
          .pipe(Effect.mapError(fail("Could not create the Assistant")));
      yield* dispatch({
        type: "project.create",
        commandId: CommandId.make(`assistant-ensure:project:${projectId}`),
        projectId,
        title: "Assistant",
        workspaceRoot: home,
        createWorkspaceRootIfMissing: true,
        createdAt,
      });
      yield* dispatch({
        type: "thread.create",
        commandId: CommandId.make(`assistant-ensure:thread:${threadId}`),
        threadId,
        projectId,
        title: "Assistant",
        modelSelection: input.request.modelSelection,
        runtimeMode: input.request.runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt,
      });
      yield* dispatch({
        type: "project.meta.update",
        commandId: CommandId.make(`assistant-ensure:marker:${projectId}`),
        projectId,
        defaultModelSelection: input.request.modelSelection,
        assistant: { coordinatorThreadId: threadId, scope: "global" },
      });
      return { projectId, threadId, created: true } satisfies AssistantEnsureResult;
    }),
  );
});
