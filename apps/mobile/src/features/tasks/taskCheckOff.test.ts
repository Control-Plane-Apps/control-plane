import type { Task } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withLingeringTasks } from "./taskCheckOff";

const task = (id: string, status: Task["status"]) => ({ id, status }) as unknown as Task;

describe("withLingeringTasks", () => {
  it("leaves the list alone when nothing lingers", () => {
    const tasks = [task("a", "completed")];
    expect(withLingeringTasks(tasks, new Set())).toBe(tasks);
  });

  it("keeps a just-completed task open for the linger window", () => {
    const shown = withLingeringTasks(
      [task("a", "completed"), task("b", "completed"), task("c", "todo")],
      new Set(["a", "c"]),
    );
    expect(shown.map((t) => t.status)).toEqual(["todo", "completed", "todo"]);
  });

  it("does not reopen a lingering task that was cancelled meanwhile", () => {
    const shown = withLingeringTasks([task("a", "cancelled")], new Set(["a"]));
    expect(shown[0]?.status).toBe("cancelled");
  });
});
