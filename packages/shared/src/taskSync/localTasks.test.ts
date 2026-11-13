import { TaskId, type Task } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createLocalTask, patchLocalTask } from "./localTasks.ts";

const AT = "2026-11-13T12:00:00.000Z";
const LATER = "2026-11-13T13:00:00.000Z";
const newId = () => TaskId.make("next");

describe("local task edits", () => {
  it("creates a trimmed todo", () => {
    const task = createLocalTask(
      { id: TaskId.make("a"), title: " Ship ", notes: "  ", home: { kind: "backlog" } },
      AT,
    );
    expect(task).toEqual({
      id: "a",
      title: "Ship",
      status: "todo",
      home: { kind: "backlog" },
      createdAt: AT,
      updatedAt: AT,
    });
  });

  it("completes and reopens, keeping Control Plane-only fields", () => {
    const stored: Task = {
      ...createLocalTask({ id: TaskId.make("a"), title: "Ship", home: { kind: "backlog" } }, AT),
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
    const [moved] = patchLocalTask(stored, { home: { kind: "backlog" } }, LATER, newId);
    expect(moved!.recurrence).toBeUndefined();
  });
});
