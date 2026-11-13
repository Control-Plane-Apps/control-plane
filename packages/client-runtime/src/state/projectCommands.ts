import { type EnvironmentId, type ProjectReadFileResult, WS_METHODS } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import {
  type AutomateProjectStatusInput,
  type DismissProjectStatusInput,
  type CreateTaskInput,
  type UpdateTaskInput,
  type DeleteTaskInput,
  type RespondToTaskProposalInput,
  type HandOffTaskInput,
  type SetTaskIntentInput,
  createTask,
  updateTask,
  deleteTask,
  respondToTaskProposal,
  handOffTask,
  setTaskIntent,
  type CreateProjectInput,
  type DeleteProjectInput,
  type ReorderProjectInput,
  type UpdateProjectInput,
  automateProjectStatus,
  dismissProjectStatus,
  createProject,
  deleteProject,
  reorderProject,
  updateProject,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  CreateTaskInput,
  UpdateTaskInput,
  DeleteTaskInput,
  RespondToTaskProposalInput,
  HandOffTaskInput,
  SetTaskIntentInput,
  CreateProjectInput,
  DeleteProjectInput,
  UpdateProjectInput,
} from "../operations/commands.ts";

export interface OptimisticProjectFile {
  readonly data: ProjectReadFileResult;
  readonly confirmedAgainst: object | null | undefined;
}

export interface OptimisticProjectFileTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

function optimisticProjectFileKey(target: OptimisticProjectFileTarget): string {
  return JSON.stringify([target.environmentId, target.cwd, target.relativePath]);
}

export function createProjectEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const projectScheduler = createAtomCommandScheduler();
  const fileScheduler = createAtomCommandScheduler();
  const optimisticFileFamily = Atom.family((key: string) =>
    Atom.make<OptimisticProjectFile | null>(null).pipe(
      Atom.withLabel(`environment-data:projects:optimistic-file:${key}`),
    ),
  );
  const projectConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { projectId: string } }) =>
      JSON.stringify([environmentId, input.projectId]),
  };
  const taskScheduler = createAtomCommandScheduler();
  const taskConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: object }) =>
      JSON.stringify([environmentId, (input as { readonly taskId?: string }).taskId ?? "intent"]),
  };
  const taskCommand = <I extends object>(
    name: string,
    execute: (input: I) => ReturnType<typeof createTask>,
  ) =>
    createEnvironmentCommand(runtime, {
      label: `environment-data:commands:task:${name}`,
      execute,
      scheduler: taskScheduler,
      concurrency: taskConcurrency,
    });
  return {
    createTask: taskCommand("create", (input: CreateTaskInput) => createTask(input)),
    updateTask: taskCommand("update", (input: UpdateTaskInput) => updateTask(input)),
    deleteTask: taskCommand("delete", (input: DeleteTaskInput) => deleteTask(input)),
    respondToTaskProposal: taskCommand("proposal-respond", (input: RespondToTaskProposalInput) =>
      respondToTaskProposal(input),
    ),
    handOffTask: taskCommand("handoff", (input: HandOffTaskInput) => handOffTask(input)),
    setTaskIntent: taskCommand("intent", (input: SetTaskIntentInput) => setTaskIntent(input)),
    searchEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:search-entries",
      tag: WS_METHODS.projectsSearchEntries,
      staleTimeMs: 15_000,
    }),
    listEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:list-entries",
      tag: WS_METHODS.projectsListEntries,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    readFile: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:read-file",
      tag: WS_METHODS.projectsReadFile,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    optimisticFile: (target: OptimisticProjectFileTarget) =>
      optimisticFileFamily(optimisticProjectFileKey(target)),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:create",
      execute: (input: CreateProjectInput) => createProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:update",
      execute: (input: UpdateProjectInput) => updateProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    reorder: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:reorder",
      execute: (input: ReorderProjectInput) => reorderProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:delete",
      execute: (input: DeleteProjectInput) => deleteProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    /** The user's deadline opt-in on one Status decision. */
    automateStatus: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:status-automate",
      execute: (input: AutomateProjectStatusInput) => automateProjectStatus(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    /** The user's check-off (or undo) of one finished Status row. */
    dismissStatus: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:status-dismiss",
      execute: (input: DismissProjectStatusInput) => dismissProjectStatus(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    /** Host status, prompts and held runs of one Project's schedules. */
    schedulesStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:schedules-status",
      tag: WS_METHODS.schedulesStatus,
      staleTimeMs: 15_000,
    }),
    /** Task Sync: the Control Plane account the Mac server syncs tasks with. */
    taskSyncStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:task-sync:status",
      tag: WS_METHODS.taskSyncStatus,
    }),
    taskSyncRequestCode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:task-sync:request-code",
      tag: WS_METHODS.taskSyncRequestCode,
    }),
    taskSyncVerify: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:task-sync:verify",
      tag: WS_METHODS.taskSyncVerify,
    }),
    taskSyncSignOut: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:task-sync:sign-out",
      tag: WS_METHODS.taskSyncSignOut,
    }),
    taskSyncCheckout: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:task-sync:checkout",
      tag: WS_METHODS.taskSyncCheckout,
    }),
    taskSyncPortal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:task-sync:portal",
      tag: WS_METHODS.taskSyncPortal,
    }),
    taskSyncNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:task-sync:now",
      tag: WS_METHODS.taskSyncNow,
    }),
    taskSyncSetPreview: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:task-sync:set-preview",
      tag: WS_METHODS.taskSyncSetPreview,
    }),
    schedulesRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:schedules-run",
      tag: WS_METHODS.schedulesRun,
    }),
    writeFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:write-file",
      tag: WS_METHODS.projectsWriteFile,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
    }),
  };
}
