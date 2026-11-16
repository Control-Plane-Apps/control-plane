import type { Task } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { taskRowMeta } from "./taskRowMeta";

const TODAY = "2026-11-16";
const task = (home: Task["home"], extra: Partial<Task> = {}) => ({ home, ...extra }) as Task;

describe("taskRowMeta in Upcoming", () => {
  it("drops the day label a row already sits under", () => {
    const gym = task({ kind: "date", date: "2026-11-18" });
    expect(taskRowMeta(gym, TODAY, true)).not.toBeNull();
    expect(taskRowMeta(gym, TODAY, true, true)).toBeNull();
  });

  it("keeps the reminder time, which the section does not say", () => {
    const timed = task({ kind: "date", date: "2026-11-18", reminderTime: "07:00" });
    expect(taskRowMeta(timed, TODAY, true, true)).not.toBeNull();
  });

  it("keeps what the section does not say, like a repeat", () => {
    const monthly = task(
      { kind: "date", date: "2026-11-19" },
      { recurrence: { frequency: "monthly", interval: 1 } },
    );
    expect(taskRowMeta(monthly, TODAY, true, true)).toBe("Monthly");
  });
});
