import type { Task } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addAllProposalsLabel,
  anchorTaskProposalBlocks,
  decodeTaskHighlight,
  groupTaskProposeCalls,
  proposedTasksForView,
  proposedTasksOnDate,
  resolveTaskProposalBlock,
  summarizeTaskProposalBlock,
  taskProposalBlocksFromActivities,
  taskProposeCallOf,
  taskViewForHome,
} from "./taskProposals.ts";

const TODAY = "2026-11-13"; // a Friday; its week starts Monday Nov 9
const AT = "2026-11-13T12:00:00.000Z";
const THREAD = "thread-1";

const task = (id: string, extra: Partial<Task> = {}): Task =>
  ({
    id,
    title: id,
    status: "todo",
    home: { kind: "date", date: TODAY },
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  }) as Task;

const proposal = (id: string, extra: Partial<Task> = {}, acceptedAt?: string): Task =>
  task(id, {
    proposal: {
      projectId: "p1",
      threadId: THREAD,
      proposedAt: AT,
      ...(acceptedAt !== undefined ? { acceptedAt } : {}),
    } as Task["proposal"],
    ...extra,
  });

const week = { kind: "period", horizon: "week", startsOn: "2026-11-09", endsOn: "2026-11-15" };

describe("proposals by home", () => {
  it("maps each home to the range it lives in", () => {
    expect(taskViewForHome({ kind: "date", date: "2026-11-10" }, TODAY)).toBe("today");
    expect(taskViewForHome({ kind: "date", date: TODAY }, TODAY)).toBe("today");
    expect(taskViewForHome({ kind: "date", date: "2026-11-14" }, TODAY)).toBe("upcoming");
    expect(taskViewForHome({ kind: "date", date: "2026-11-20" }, TODAY)).toBe("upcoming");
    expect(taskViewForHome({ kind: "date", date: "2026-11-21" }, TODAY)).toBe("all");
    expect(taskViewForHome(week as Task["home"], TODAY)).toBe("week");
    expect(
      taskViewForHome(
        { kind: "period", horizon: "week", startsOn: "2026-11-16", endsOn: "2026-11-22" },
        TODAY,
      ),
    ).toBe("all");
    expect(
      taskViewForHome(
        { kind: "period", horizon: "month", startsOn: "2026-11-01", endsOn: "2026-11-30" },
        TODAY,
      ),
    ).toBe("month");
    expect(taskViewForHome({ kind: "backlog", horizon: null }, TODAY)).toBe("all");
  });

  const tasks = [
    proposal("today"),
    proposal("overdue", { home: { kind: "date", date: "2026-11-11" } }),
    proposal("week", { home: week as Task["home"] }),
    proposal("tomorrow", { home: { kind: "date", date: "2026-11-14" } }),
    proposal("someday", { home: { kind: "backlog", horizon: null } }),
    proposal("month-backlog", { home: { kind: "backlog", horizon: "month" } }),
    proposal("accepted", {}, AT),
    task("mine"),
  ];

  it("shows a proposal only in the range it is homed in", () => {
    const ids = (view: Parameters<typeof proposedTasksForView>[1], filter?: never) =>
      proposedTasksForView(tasks, view, TODAY, filter).map((entry) => entry.id);
    expect(ids("today")).toEqual(["today", "overdue"]);
    expect(ids("week")).toEqual(["week"]);
    expect(ids("month")).toEqual([]);
    expect(ids("upcoming")).toEqual(["tomorrow"]);
    expect(ids("all")).toEqual(["someday", "month-backlog"]);
    expect(proposedTasksForView(tasks, "all", TODAY, "month").map((t) => t.id)).toEqual([
      "month-backlog",
    ]);
    expect(proposedTasksForView(tasks, "all", TODAY, "recurring")).toEqual([]);
    expect(proposedTasksOnDate(tasks, "2026-11-14").map((t) => t.id)).toEqual(["tomorrow"]);
  });

  it("labels the add-all action", () => {
    expect(addAllProposalsLabel(2)).toBe("Add both");
    expect(addAllProposalsLabel(3)).toBe("Add all");
  });
});

const codexCall = (id: string, turnId: string | null, title: string, result?: string) => ({
  id,
  turnId,
  createdAt: AT,
  toolCallId: `call-${id}`,
  toolLifecycleStatus: result === undefined ? "inProgress" : "completed",
  toolData: {
    type: "mcpToolCall",
    server: "cplane",
    tool: "cp_task_propose",
    arguments: { title, when: "this-week" },
    ...(result !== undefined ? { result: { content: result } } : {}),
  },
});

describe("cp_task_propose calls", () => {
  it("reads the task id from a result cut short", () => {
    const call = taskProposeCallOf(
      codexCall("a", "t1", "Ship it", '{"task":{"id":"task-a","title":"Ship it","status":"to…'),
    );
    expect(call).toEqual({
      callId: "call-a",
      taskId: "task-a",
      title: "Ship it",
      createdAt: AT,
      status: "completed",
    });
  });

  it("reads Claude's tool name and input", () => {
    const call = taskProposeCallOf({
      id: "c",
      createdAt: AT,
      toolLifecycleStatus: "completed",
      toolData: {
        toolName: "mcp__cplane__cp_task_propose",
        input: { title: "Call Dana" },
        result: { content: '{"task":{"id":"task-c","title":"Call Dana"' },
      },
    });
    expect(call?.taskId).toBe("task-c");
    expect(call?.title).toBe("Call Dana");
  });

  it("ignores other tools", () => {
    expect(
      taskProposeCallOf({
        id: "x",
        createdAt: AT,
        toolData: { server: "cplane", tool: "cp_task_list", arguments: {} },
      }),
    ).toBeNull();
  });

  it("groups a turn's calls into one block and merges lifecycle updates", () => {
    const blocks = groupTaskProposeCalls([
      codexCall("a", "t1", "One"),
      { id: "other", createdAt: AT, turnId: "t1", label: "Ran a command" },
      codexCall("b", "t1", "Two", '{"task":{"id":"task-b"'),
      { ...codexCall("a", "t1", "One", '{"task":{"id":"task-a"'), id: "a-done" },
      codexCall("c", "t2", "Three", '{"task":{"id":"task-c"'),
    ]);
    expect(blocks.map((block) => block.id)).toEqual(["a", "c"]);
    expect(blocks[0]!.calls.map((call) => [call.taskId, call.status])).toEqual([
      ["task-a", "completed"],
      ["task-b", "completed"],
    ]);
  });
});

describe("a block's live state", () => {
  const call = (taskId: string | null, title: string, status = "completed") => ({
    callId: title,
    taskId,
    title,
    createdAt: AT,
    status: status as "completed",
  });

  it("matches by id, else by this thread's proposal with the same title", () => {
    const tasks = [
      proposal("a", { home: week as Task["home"] }),
      proposal("b", { title: "By title", home: week as Task["home"] }),
      proposal("c", {
        title: "Elsewhere",
        proposal: { ...proposal("c").proposal!, threadId: "other" as never },
      }),
    ];
    const resolved = resolveTaskProposalBlock(
      {
        calls: [call("a", "a"), call(null, "By title"), call(null, "Elsewhere"), call("gone", "x")],
      },
      tasks,
      THREAD,
    );
    expect(resolved.tasks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(resolved.dismissed).toBe(2);
  });

  it("sums up waiting, added and dismissed", () => {
    const tasks = [
      proposal("a", { title: "Draft the memo", home: week as Task["home"] }),
      proposal("b", { title: "Book flights", home: week as Task["home"] }, AT),
      proposal("c", { title: "Review deck", home: week as Task["home"] }),
      proposal("d", { title: "Email Sam", home: week as Task["home"] }, AT),
    ];
    const calls = ["a", "b", "c", "d", "e", "f"].map((id) => call(id, id));
    const summary = summarizeTaskProposalBlock(
      resolveTaskProposalBlock({ calls }, tasks, THREAD),
      TODAY,
    );
    expect(summary.headline).toBe("Added 2 of 6 tasks · This week");
    expect(summary.items.map((item) => item.title)).toEqual([
      "Draft the memo",
      "Book flights",
      "Review deck",
    ]);
    expect(summary.moreCount).toBe(1);
    expect(summary.status).toBe("2 waiting · 2 dismissed");
    expect(summary.view).toBe("week");
    expect(summary.highlightIds).toEqual(["a", "b", "c", "d"]);
  });

  it("reads all added, all dismissed, and mixed ranges", () => {
    const added = summarizeTaskProposalBlock(
      resolveTaskProposalBlock({ calls: [call("a", "a")] }, [proposal("a", {}, AT)], THREAD),
      TODAY,
    );
    expect(added.headline).toBe("Added 1 task · Today");
    expect(added.status).toBe("");

    const gone = summarizeTaskProposalBlock(
      resolveTaskProposalBlock({ calls: [call("a", "a"), call("b", "b")] }, [], THREAD),
      TODAY,
    );
    expect(gone.headline).toBe("Proposed 2 tasks");
    expect(gone.status).toBe("All dismissed");
    expect(gone.view).toBeNull();

    const mixed = summarizeTaskProposalBlock(
      resolveTaskProposalBlock(
        { calls: [call("a", "a"), call("b", "b"), call("c", "c")] },
        [
          proposal("a", { home: week as Task["home"] }),
          proposal("b", { home: week as Task["home"] }),
          proposal("c", { home: { kind: "backlog", horizon: null } }),
        ],
        THREAD,
      ),
      TODAY,
    );
    expect(mixed.headline).toBe("Proposed 3 tasks · across ranges");
    expect(mixed.status).toBe("3 waiting");
    expect(mixed.view).toBe("week");
  });

  it("says Added when the Assistant added directly", () => {
    const summary = summarizeTaskProposalBlock(
      resolveTaskProposalBlock({ calls: [call("a", "a")] }, [task("a")], THREAD),
      TODAY,
    );
    expect(summary.headline).toBe("Added 1 task · Today");
    expect(summary.status).toBe("");
  });

  it("says Added N of M with what is waiting or dismissed", () => {
    const calls = [call("a", "a"), call("b", "b"), call("c", "c")];
    const waiting = summarizeTaskProposalBlock(
      resolveTaskProposalBlock(
        { calls },
        [proposal("a", {}, AT), proposal("b", {}, AT), proposal("c", {})],
        THREAD,
      ),
      TODAY,
    );
    expect(waiting.headline).toBe("Added 2 of 3 tasks · Today");
    expect(waiting.status).toBe("1 waiting");

    const dismissed = summarizeTaskProposalBlock(
      resolveTaskProposalBlock({ calls }, [proposal("a", {}, AT), proposal("b", {}, AT)], THREAD),
      TODAY,
    );
    expect(dismissed.headline).toBe("Added 2 of 3 tasks · Today");
    expect(dismissed.status).toBe("1 dismissed");

    const both = summarizeTaskProposalBlock(
      resolveTaskProposalBlock({ calls }, [proposal("a", {}, AT), proposal("b", {})], THREAD),
      TODAY,
    );
    expect(both.headline).toBe("Added 1 of 3 tasks · Today");
    expect(both.status).toBe("1 waiting · 1 dismissed");
  });

  it("keeps Proposed while all wait, some dismissed", () => {
    const summary = summarizeTaskProposalBlock(
      resolveTaskProposalBlock(
        { calls: [call("a", "a"), call("b", "b")] },
        [proposal("a", {})],
        THREAD,
      ),
      TODAY,
    );
    expect(summary.headline).toBe("Proposed 2 tasks · Today");
    expect(summary.status).toBe("1 waiting · 1 dismissed");
  });

  it("says Added for several accepted tasks, no All added label", () => {
    const summary = summarizeTaskProposalBlock(
      resolveTaskProposalBlock(
        { calls: [call("a", "a"), call("b", "b")] },
        [proposal("a", {}, AT), proposal("b", {}, AT)],
        THREAD,
      ),
      TODAY,
    );
    expect(summary.headline).toBe("Added 2 tasks · Today");
    expect(summary.status).toBe("");
  });

  it("reports calls that failed", () => {
    const summary = summarizeTaskProposalBlock(
      resolveTaskProposalBlock({ calls: [call(null, "x", "failed")] }, [], THREAD),
      TODAY,
    );
    expect(summary.headline).toBe("Could not propose 1 task");
    expect(summary.status).toBe("");
  });

  it("decodes highlight ids", () => {
    expect(decodeTaskHighlight("a, b,,c")).toEqual(["a", "b", "c"]);
    expect(decodeTaskHighlight(undefined)).toEqual([]);
  });
});

describe("proposal blocks from activities", () => {
  const activity = (
    id: string,
    kind: string,
    turnId: string,
    extra: Record<string, unknown> = {},
    createdAt = AT,
  ) => ({
    id,
    kind,
    createdAt,
    summary: "cplane · cp_task_propose",
    turnId,
    payload: {
      itemType: "mcp_tool_call",
      toolCallId: `call-${id.slice(0, 1)}`,
      data: {
        toolName: "mcp__cplane__cp_task_propose",
        input: { title: `Task ${id.slice(0, 1)}` },
        ...extra,
      },
    },
  });

  it("groups by turn and folds each call's updates", () => {
    const blocks = taskProposalBlocksFromActivities([
      activity("a1", "tool.updated", "t1"),
      activity("a2", "tool.completed", "t1", { result: { content: '{"task":{"id":"ta"' } }),
      activity("b1", "tool.completed", "t1", { result: { content: '{"task":{"id":"tb"' } }),
      { ...activity("x", "tool.completed", "t1"), summary: "Ran ls", payload: {} },
      activity("c1", "tool.completed", "t2"),
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.calls.map((call) => [call.taskId, call.status])).toEqual([
      ["ta", "completed"],
      ["tb", "completed"],
    ]);
  });

  it("anchors under the turn's last reply, else the newest row", () => {
    const feed = [
      {
        id: "u1",
        type: "message",
        createdAt: "2026-11-13T11:00:00.000Z",
        message: { role: "user" },
      },
      {
        id: "r1",
        type: "message",
        createdAt: "2026-11-13T12:00:01.000Z",
        message: { role: "assistant" },
      },
      {
        id: "r2",
        type: "message",
        createdAt: "2026-11-13T12:00:02.000Z",
        message: { role: "assistant" },
      },
      {
        id: "u2",
        type: "message",
        createdAt: "2026-11-13T12:01:00.000Z",
        message: { role: "user" },
      },
      {
        id: "r3",
        type: "message",
        createdAt: "2026-11-13T12:02:00.000Z",
        message: { role: "assistant" },
      },
      { id: "work", type: "activity-group", createdAt: "2026-11-13T12:05:00.000Z" },
    ];
    const anchored = anchorTaskProposalBlocks(feed, [
      { id: "b1", createdAt: AT },
      { id: "b2", createdAt: "2026-11-13T12:04:00.000Z" },
    ]);
    expect(anchored.get("r2")?.map((block) => block.id)).toEqual(["b1"]);
    expect(anchored.get("work")?.map((block) => block.id)).toEqual(["b2"]);
  });
});
