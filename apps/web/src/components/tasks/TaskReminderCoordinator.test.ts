import type { Task } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { dueTaskReminders } from "./TaskReminderCoordinator";

const AT = "2026-11-13T12:00:00.000Z";
const task = (id: string, extra: Partial<Task>): Task =>
  ({ id, title: id, status: "todo", createdAt: AT, updatedAt: AT, ...extra }) as Task;

describe("dueTaskReminders", () => {
  const tasks = [
    task("due", { home: { kind: "date", date: "2026-11-13", reminderTime: "09:00" } }),
    task("later", { home: { kind: "date", date: "2026-11-13", reminderTime: "15:00" } }),
    task("tomorrow", { home: { kind: "date", date: "2026-11-14", reminderTime: "09:00" } }),
    task("done", {
      status: "completed",
      home: { kind: "date", date: "2026-11-13", reminderTime: "09:00" },
    }),
    task("proposed", {
      home: { kind: "date", date: "2026-11-13", reminderTime: "09:00" },
      proposal: { projectId: "p", threadId: "c", proposedAt: AT } as never,
    }),
  ];

  it("returns open, added tasks whose reminder time has arrived today, once", () => {
    expect(dueTaskReminders(tasks, "2026-11-13", "09:05", new Set()).map((t) => t.id)).toEqual([
      "due",
    ]);
    expect(
      dueTaskReminders(tasks, "2026-11-13", "09:05", new Set(["due@2026-11-13T09:00"])),
    ).toEqual([]);
  });
});
