import { TaskId, type Task } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createLocalTask, deleteLocalTask, patchLocalTask } from "./localTasks.ts";

const AT = "2026-11-13T12:00:00.000Z";
const LATER = "2026-11-13T13:00:00.000Z";
const newId = () => TaskId.make("next");

describe("local task edits", () => {
  it("creates a trimmed todo", () => {
    const task = createLocalTask(
      {
        id: TaskId.make("a"),
        title: " Ship ",
        notes: "  ",
        home: { kind: "backlog", horizon: null },
      },
      AT,
    );
    expect(task).toEqual({
      id: "a",
      title: "Ship",
      status: "todo",
      home: { kind: "backlog", horizon: null },
      createdAt: AT,
      updatedAt: AT,
    });
  });

  it("completes and reopens, keeping Control Plane-only fields", () => {
    const stored: Task = {
      ...createLocalTask(
        { id: TaskId.make("a"), title: "Ship", home: { kind: "backlog", horizon: null } },
        AT,
      ),
      links: { threadId: "t" } as never,
    };
    const [done] = patchLocalTask(stored, { status: "completed" }, LATER, newId);
    expect(done).toMatchObject({
      status: "completed",
      completedAt: LATER,
      links: { threadId: "t" },
    });
    const [open] = patchLocalTask(done!, { status: "todo" }, LATER, newId);
    expect(open!.completedAt).toBeUndefined();
  });

  it("opens the next occurrence when a repeating task is completed", () => {
    const stored = createLocalTask(
      {
        id: TaskId.make("a"),
        title: "Standup",
        home: { kind: "date", date: "2026-11-13" },
        recurrence: { frequency: "daily", interval: 1 },
      },
      AT,
    );
    const [closed, following] = patchLocalTask(stored, { status: "completed" }, LATER, newId);
    expect(closed!.recurrence).toBeUndefined();
    expect(following).toMatchObject({
      id: "next",
      status: "todo",
      home: { kind: "date", date: "2026-11-14" },
      recurrence: { frequency: "daily", interval: 1 },
    });
  });

  it("drops the repeat when the task moves off its day", () => {
    const stored = createLocalTask(
      {
        id: TaskId.make("a"),
        title: "Standup",
        home: { kind: "date", date: "2026-11-13" },
        recurrence: { frequency: "daily", interval: 1 },
      },
      AT,
    );
    const [moved] = patchLocalTask(
      stored,
      { home: { kind: "backlog", horizon: null } },
      LATER,
      newId,
    );
    expect(moved!.recurrence).toBeUndefined();
  });
});

describe("local repeating tasks, like the server", () => {
  const repeating = (): Task =>
    createLocalTask(
      {
        id: TaskId.make("run"),
        title: "Run",
        home: { kind: "date", date: "2026-11-13" },
        recurrence: { frequency: "daily", interval: 1, endAfterCount: 2 },
      },
      AT,
    );

  it("counts occurrences and stops after the last", () => {
    const first = repeating();
    expect(first.recurrence?.occurrence).toBe(1);
    const [, second] = patchLocalTask(first, { status: "completed" }, LATER, newId);
    expect(second?.recurrence?.occurrence).toBe(2);
    expect(patchLocalTask(second!, { status: "completed" }, LATER, newId)).toHaveLength(1);
  });

  it("deletes one occurrence as a skip, or stops the series", () => {
    const first = repeating();
    const skip = deleteLocalTask(first, undefined, LATER, newId);
    expect(skip.map((write) => [write.id, write.task?.home])).toEqual([
      ["run", undefined],
      ["next", { kind: "date", date: "2026-11-14" }],
    ]);
    expect(skip[1]!.task?.recurrence?.occurrence).toBe(1);
    const stop = deleteLocalTask(first, "series", LATER, newId);
    expect(stop).toHaveLength(2);
    expect(stop[0]!.task?.recurrence).toBeUndefined();
    expect(stop[1]).toEqual({ id: "run", task: null });
    const plain = createLocalTask(
      { id: TaskId.make("p"), title: "P", home: { kind: "backlog", horizon: null } },
      AT,
    );
    expect(deleteLocalTask(plain, undefined, LATER, newId)).toEqual([{ id: "p", task: null }]);
  });
});
