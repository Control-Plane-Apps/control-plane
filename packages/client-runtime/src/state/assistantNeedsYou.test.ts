import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type AssistantNeedsYouEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { assistantNeedsYouKey, mergeAssistantNeedsYou } from "./assistantHome.ts";
import type { EnvironmentProject } from "./models.ts";

const AT = "2026-11-23T12:00:00.000Z";
const MACBOOK = EnvironmentId.make("macbook");
const MINI = EnvironmentId.make("mini");
const SERVER_ONLY = EnvironmentId.make("server-only");

function entry(
  environmentId: EnvironmentId,
  projectId = "project",
  statusId = "question",
): AssistantNeedsYouEntry {
  return {
    environmentId,
    machineLabel: environmentId,
    projectId: ProjectId.make(projectId),
    projectTitle: projectId,
    coordinatorThreadId: ThreadId.make(`${projectId}-coordinator`),
    stale: false,
    status: {
      id: statusId,
      title: statusId,
      state: "needs-you",
      summary: "Waiting on an answer",
      updatedAt: AT,
      decision: { question: "Continue?", recommendation: "Continue", openedAt: AT },
    },
  };
}

function project(item: AssistantNeedsYouEntry, statuses = [item.status]): EnvironmentProject {
  return {
    id: item.projectId,
    environmentId: item.environmentId,
    title: item.projectTitle,
    workspaceRoot: `/tmp/${item.projectId}`,
    assistant: { coordinatorThreadId: item.coordinatorThreadId, statuses },
  } as unknown as EnvironmentProject;
}

const merge = (
  projects: ReadonlyArray<EnvironmentProject>,
  aggregateItems: ReadonlyArray<AssistantNeedsYouEntry> | null,
  liveEnvironmentIds: ReadonlySet<EnvironmentId> = new Set([MACBOOK]),
  reach: ReadonlyArray<string> | null = null,
) => mergeAssistantNeedsYou({ projects, aggregateItems, liveEnvironmentIds, reach });

describe("mergeAssistantNeedsYou", () => {
  it("includes a server-only question and scopes identical ids by environment", () => {
    const local = entry(MACBOOK);
    const remote = entry(SERVER_ONLY);
    const items = merge([project(local)], [local, remote]);
    expect(items.map(assistantNeedsYouKey)).toEqual([
      assistantNeedsYouKey(local),
      assistantNeedsYouKey(remote),
    ]);
    expect(items).toHaveLength(2);
    expect(items.filter((item) => item.environmentId === MACBOOK)).toHaveLength(1);
  });

  it("uses fresh live shells instead of stale aggregate questions for that entire environment", () => {
    const answered = entry(MACBOOK, "answered");
    const dismissed = entry(MACBOOK, "dismissed");
    const cached = entry(SERVER_ONLY);
    const updated = { ...cached, status: { ...cached.status, title: "New question title" } };
    const projects = [
      project(answered, [
        { ...answered.status, decision: { ...answered.status.decision, answeredAt: AT } },
      ]),
      project(dismissed, [{ ...dismissed.status, dismissedAt: AT }]),
      project(cached),
    ];
    expect(merge(projects, [answered, dismissed, updated])).toEqual([updated]);
  });

  it("clears questions from a live environment even when its Project list is empty", () => {
    const remote = { ...entry(SERVER_ONLY), stale: true };
    expect(merge([], [entry(MACBOOK), remote])).toEqual([remote]);
  });

  it("does not replace server answers with disconnected cached shell questions", () => {
    expect(merge([project(entry(MINI))], [], new Set())).toEqual([]);
    const cached = merge([project(entry(MINI))], null, new Set());
    expect(cached).toHaveLength(1);
    expect(cached[0]!.stale).toBe(true);
  });

  it("applies the home reach to both aggregate and client shell questions", () => {
    const local = entry(MACBOOK, "local");
    const remote = entry(SERVER_ONLY, "remote");
    expect(merge([project(local)], [local, remote], new Set([MACBOOK]), ["remote"])).toEqual([
      remote,
    ]);
    expect(merge([project(local)], [local, remote], new Set([MACBOOK]), [])).toEqual([]);
  });

  it("deduplicates aggregate entries and prefers a fresh copy", () => {
    const fresh = entry(SERVER_ONLY);
    const stale = { ...fresh, stale: true };
    expect(merge([], [stale, fresh, stale])).toEqual([fresh]);
  });

  it("sorts deadlines first, then newest questions, then scoped identity for ties", () => {
    const older = entry(SERVER_ONLY, "older");
    const newer = entry(MINI, "newer");
    const due = entry(MINI, "due");
    const tied = entry(MACBOOK, "tied");
    const newest = {
      ...newer,
      status: {
        ...newer.status,
        decision: { ...newer.status.decision, openedAt: "2026-11-23T13:00:00.000Z" },
      },
    };
    const deadline = {
      ...due,
      status: {
        ...due.status,
        decision: { ...due.status.decision, deadline: "2026-11-24T00:00:00.000Z" },
      },
    };
    const items = [older, newest, deadline, tied];
    const forward = merge([], items, new Set());
    expect(forward.map((item) => item.projectId)).toEqual(["due", "newer", "tied", "older"]);
    expect(merge([], items.toReversed(), new Set())).toEqual(forward);
  });

  it("uses connected machine labels without creating replacement Project shells", () => {
    const local = entry(MACBOOK);
    const items = mergeAssistantNeedsYou({
      projects: [project(local)],
      aggregateItems: [],
      liveEnvironmentIds: new Set([MACBOOK]),
      reach: null,
      machineLabels: new Map([[MACBOOK, "MacBook"]]),
    });
    expect(items[0]!.machineLabel).toBe("MacBook");
    expect(items[0]!.stale).toBe(false);
  });
});
