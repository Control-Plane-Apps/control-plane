import {
  AssistantNeedsYouError,
  AssistantNeedsYouReplyResult,
  EnvironmentId,
  findGlobalAssistantProject,
  isProjectInAssistantReach,
  isStatusNeedingUser,
  ProjectId,
  ThreadId,
  type AssistantNeedsYouEntry,
  type AssistantNeedsYouMachine,
  type AssistantNeedsYouReplyInput,
  type AssistantNeedsYouResult,
  type OrchestrationProjectShell,
  type ProjectStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { StatusListResult } from "../mcp/toolkits/agents/tools.ts";
import { Reach } from "./Reach.ts";
import { makeStatusQuestionReply } from "./statusQuestionReply.ts";

export interface AssistantNeedsYouShape {
  readonly read: Effect.Effect<AssistantNeedsYouResult, AssistantNeedsYouError>;
  readonly reply: (
    input: AssistantNeedsYouReplyInput,
  ) => Effect.Effect<{ readonly queued: boolean }, AssistantNeedsYouError>;
}

const unavailable = Effect.fail(
  new AssistantNeedsYouError({
    detail: "Update the Assistant server to read or answer questions across machines.",
  }),
);
export const AssistantNeedsYou = Context.Reference<AssistantNeedsYouShape>(
  "t3/reach/AssistantNeedsYou",
  {
    defaultValue: () => ({ read: unavailable, reply: () => unavailable }),
  },
);

function isLiveProject(project: OrchestrationProjectShell) {
  return (
    project.assistant != null &&
    project.assistant.archivedAt == null &&
    project.assistant.scope !== "global"
  );
}

export function sortNeedsYou(items: ReadonlyArray<AssistantNeedsYouEntry>) {
  return [...items].sort((a, b) => {
    const left = a.status.decision.deadline;
    const right = b.status.decision.deadline;
    if (left !== undefined && right !== undefined && left !== right)
      return left.localeCompare(right);
    if (left !== undefined && right === undefined) return -1;
    if (right !== undefined && left === undefined) return 1;
    return (
      b.status.decision.openedAt.localeCompare(a.status.decision.openedAt) ||
      JSON.stringify([a.environmentId, a.projectId, a.status.id]).localeCompare(
        JSON.stringify([b.environmentId, b.projectId, b.status.id]),
      )
    );
  });
}

export const make = Effect.gen(function* () {
  const reach = yield* Reach;
  const snapshots = yield* ProjectionSnapshotQuery;
  const settings = yield* ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const replyLocally = yield* makeStatusQuestionReply;
  const legacyBoards = new Map<string, ReadonlyArray<ProjectStatus>>();
  const context = Effect.gen(function* () {
    const snapshot = yield* snapshots
      .getShellSnapshot()
      .pipe(
        Effect.mapError(
          () => new AssistantNeedsYouError({ detail: "Could not read the Assistant's Projects." }),
        ),
      );
    const home = findGlobalAssistantProject(snapshot.projects);
    if (home?.assistant == null)
      return yield* new AssistantNeedsYouError({
        detail: "This machine does not run the Assistant. Reopen the Assistant and try again.",
      });
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(
        () =>
          new AssistantNeedsYouError({ detail: "Could not read the Assistant's reach settings." }),
      ),
    );
    return {
      snapshot,
      settings: current.assistant,
      caller: { threadId: home.assistant.coordinatorThreadId, threadTitle: "Assistant" },
    };
  });
  const read = Effect.gen(function* () {
    const current = yield* context;
    const self = yield* environment.getDescriptor;
    const items: AssistantNeedsYouEntry[] = [];
    const machines: AssistantNeedsYouMachine[] = [
      { environmentId: self.environmentId, label: self.label, state: "online" },
    ];
    const seen = new Set<string>();
    const add = (
      source: Omit<AssistantNeedsYouEntry, "status">,
      statuses: ReadonlyArray<ProjectStatus>,
    ) => {
      for (const status of statuses) {
        if (status.decision === undefined || !isStatusNeedingUser(status)) continue;
        const key = JSON.stringify([source.environmentId, source.projectId, status.id]);
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ ...source, status: { ...status, decision: status.decision } });
      }
    };
    for (const project of current.snapshot.projects) {
      if (!isLiveProject(project) || !isProjectInAssistantReach(current.settings, project.id))
        continue;
      add(
        {
          environmentId: self.environmentId,
          machineLabel: self.label,
          projectId: project.id,
          projectTitle: project.title,
          coordinatorThreadId: project.assistant!.coordinatorThreadId,
          stale: false,
        },
        project.assistant!.statuses ?? [],
      );
    }
    const linked = [
      ...new Map((yield* reach.machines).map((machine) => [machine.id, machine])).values(),
    ].filter((machine) => machine.id !== self.environmentId);
    const remote = yield* Effect.forEach(
      linked,
      (machine) =>
        Effect.gen(function* () {
          const overview = yield* reach.overview(machine, current.caller).pipe(
            Effect.map(({ result }) => ({
              result,
              stale: false,
              problem: undefined as string | undefined,
            })),
            Effect.catch(({ error, lastKnown }) =>
              Effect.succeed({ result: lastKnown, stale: true, problem: error.detail }),
            ),
          );
          const entries: Array<{
            source: Omit<AssistantNeedsYouEntry, "status">;
            statuses: ReadonlyArray<ProjectStatus>;
          }> = [];
          let problem = overview.problem;
          for (const project of overview.result?.projects ?? []) {
            if (!isProjectInAssistantReach(current.settings, project.projectId)) continue;
            let projectStale = overview.stale;
            let statuses: ReadonlyArray<ProjectStatus> = project.needsYou.flatMap((entry) =>
              entry.status === undefined ? [] : [entry.status],
            );
            // Older peers already expose full boards through status.list. Do not invent a question revision.
            if (project.needsYou.some((entry) => entry.status === undefined)) {
              const boardKey = JSON.stringify([machine.id, project.projectId]);
              const result = yield* reach
                .call(
                  machine,
                  "status.list",
                  { projectId: project.projectId },
                  current.caller,
                  StatusListResult,
                )
                .pipe(
                  Effect.map((result) => ({
                    statuses: result.statuses,
                    error: undefined as string | undefined,
                  })),
                  Effect.catch((error) =>
                    Effect.succeed({
                      statuses: legacyBoards.get(boardKey) ?? statuses,
                      error: error.detail,
                    }),
                  ),
                );
              statuses = result.statuses;
              if (result.error === undefined) legacyBoards.set(boardKey, result.statuses);
              if (result.error !== undefined) {
                problem = result.error;
                projectStale = true;
              }
            }
            entries.push({
              source: {
                environmentId: EnvironmentId.make(machine.id),
                machineLabel: machine.label,
                projectId: ProjectId.make(project.projectId),
                projectTitle: project.title,
                coordinatorThreadId: ThreadId.make(project.coordinatorThreadId),
                stale: projectStale,
              },
              statuses,
            });
          }
          return {
            entries,
            machine: {
              environmentId: EnvironmentId.make(machine.id),
              label: machine.label,
              state: overview.stale
                ? ("offline" as const)
                : problem === undefined
                  ? ("online" as const)
                  : ("error" as const),
              ...(problem === undefined ? {} : { detail: problem }),
            },
          };
        }),
      { concurrency: 4 },
    );
    for (const result of remote) {
      machines.push(result.machine);
      for (const entry of result.entries) add(entry.source, entry.statuses);
    }
    return { items: sortNeedsYou(items), machines };
  });
  const reply: AssistantNeedsYouShape["reply"] = (input) =>
    Effect.gen(function* () {
      const current = yield* context;
      if (!isProjectInAssistantReach(current.settings, input.projectId))
        return yield* new AssistantNeedsYouError({
          detail: "This Project is outside the Assistant's reach.",
        });
      const self = yield* environment.getEnvironmentId;
      if (input.environmentId === self) return yield* replyLocally(input);
      const machine = (yield* reach.machines).find((entry) => entry.id === input.environmentId);
      if (machine === undefined)
        return yield* new AssistantNeedsYouError({
          detail: "This machine is no longer linked to the Assistant.",
        });
      // The callee validates its own environment, live Project, coordinator, question and revision atomically with the append.
      return yield* reach
        .call(machine, "status.reply", input, current.caller, AssistantNeedsYouReplyResult, {
          fresh: true,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new AssistantNeedsYouError({
                detail: `${error.detail} The answer was not confirmed; refresh before trying again.`,
              }),
          ),
        );
    });
  return { read, reply } satisfies AssistantNeedsYouShape;
});

export const AssistantNeedsYouLive = Layer.effect(AssistantNeedsYou, make).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
);
