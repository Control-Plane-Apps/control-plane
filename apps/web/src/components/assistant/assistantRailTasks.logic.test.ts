import type { Task } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { railTodayTasks } from "./assistantRailTasks.logic";

const TODAY = "2026-11-16";
const task = (id: string, date: string, extra: Partial<Task> = {}): Task =>
  ({
    id,
    title: id,
    status: "todo",
    home: { kind: "date", date },
    orderKey: id,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...extra,
  }) as unknown as Task;

describe("railTodayTasks", () => {
  it("lists overdue first, then today, and leaves later and finished tasks out", () => {
    const { shown, total, more } = railTodayTasks(
      [
        task("a", TODAY),
        task("b", "2026-11-14"),
        task("c", "2026-11-20"),
        task("d", TODAY, { status: "completed" } as Partial<Task>),
        task("e", "2026-11-15"),
      ],
      TODAY,
    );
    expect(shown.map((t) => t.id)).toEqual(["b", "e", "a"]);
    expect(total).toBe(3);
    expect(more).toBe(0);
  });

  it("caps the list and counts the rest", () => {
    const tasks = Array.from({ length: 11 }, (_, i) =>
      task(`t${String(i).padStart(2, "0")}`, TODAY),
    );
    const { shown, more, total } = railTodayTasks(tasks, TODAY);
    expect(shown).toHaveLength(8);
    expect(more).toBe(3);
    expect(total).toBe(11);
  });
});
