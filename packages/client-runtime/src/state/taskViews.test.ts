import type { ProjectStatus, Task } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  allTasks,
  committedTasks,
  formatTaskHome,
  formatTaskRange,
  homeForMove,
  parseQuickAdd,
  proposedTasks,
  taskAgentState,
  todayTasks,
  upcomingTasks,
} from "./taskViews.ts";

const TODAY = "2026-11-13";
const AT = "2026-11-13T12:00:00.000Z";

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

describe("task views", () => {
  const tasks = [
    task("overdue", { home: { kind: "date", date: "2026-11-12" } }),
    task("today", { orderKey: "m" }),
    task("tomorrow", { home: { kind: "date", date: "2026-11-14" } }),
    task("week", {
      home: { kind: "period", horizon: "week", startsOn: "2026-11-09", endsOn: "2026-11-15" },
    }),
    task("month-backlog", { home: { kind: "backlog", horizon: "month" } }),
    task("proposed", {
      proposal: { projectId: "p", threadId: "c", proposedAt: AT } as never,
    }),
    task("done", { status: "completed", completedAt: AT }),
    task("weekly", { recurrence: { frequency: "weekly", interval: 1 } }),
  ];

  it("splits Today, commitments, upcoming, backlog and proposals", () => {
    expect(todayTasks(tasks, TODAY).map((t) => t.id)).toEqual(["today", "overdue", "weekly"]);
    expect(committedTasks(tasks, "week", TODAY).map((t) => t.id)).toEqual(["week"]);
    expect(upcomingTasks(tasks, TODAY)[0]).toMatchObject({ date: "2026-11-14" });
    expect(upcomingTasks(tasks, TODAY)[0]!.tasks.map((t) => t.id)).toEqual(["tomorrow"]);
    expect(proposedTasks(tasks).map((t) => t.id)).toEqual(["proposed"]);
    const all = allTasks(tasks, "month");
    expect(all.open.map((t) => t.id)).toEqual(["month-backlog"]);
    expect(allTasks(tasks, "all").recurring.map((t) => t.id)).toEqual(["weekly"]);
    expect(allTasks(tasks, "all").completed).toBe(1);
  });

  it("labels homes relative to today", () => {
    expect(formatTaskHome({ kind: "date", date: "2026-11-12" }, TODAY)).toBe("Yesterday");
    expect(formatTaskHome({ kind: "date", date: "2026-11-15" }, TODAY)).toBe("Sun");
    expect(formatTaskHome({ kind: "date", date: "2026-12-10" }, TODAY)).toBe("Dec 10");
    expect(
      formatTaskHome(
        { kind: "period", horizon: "week", startsOn: "2026-11-09", endsOn: "2026-11-15" },
        TODAY,
      ),
    ).toBe("This week");
    expect(formatTaskHome({ kind: "backlog", horizon: null }, TODAY)).toBe("General backlog");
    expect(formatTaskRange("2026-11-09", "2026-11-15")).toBe("Nov 9 to 15");
  });

  it("parses a trailing when-phrase in quick add", () => {
    expect(parseQuickAdd("Ask Dana for Q1 pricing numbers tomorrow 9am", TODAY)).toEqual({
      title: "Ask Dana for Q1 pricing numbers",
      home: { kind: "date", date: "2026-11-14", reminderTime: "09:00" },
      phrase: "tomorrow 9am",
    });
    expect(parseQuickAdd("Inspector outreach, 10 calls this week", TODAY).home).toEqual({
      kind: "period",
      horizon: "week",
      startsOn: "2026-11-09",
      endsOn: "2026-11-15",
    });
    expect(parseQuickAdd("Call county monday", TODAY).home).toEqual({
      kind: "date",
      date: "2026-11-16",
    });
    expect(parseQuickAdd("Reread Shape Up", TODAY).home).toBeNull();
    expect(parseQuickAdd("tomorrow", TODAY).home).toBeNull();
  });

  it("moves keep a day's reminder", () => {
    expect(
      homeForMove(
        { kind: "tomorrow" },
        { kind: "date", date: TODAY, reminderTime: "15:00" },
        TODAY,
      ),
    ).toEqual({ kind: "date", date: "2026-11-14", reminderTime: "15:00" });
    expect(
      homeForMove({ kind: "commit", horizon: "month" }, { kind: "backlog", horizon: null }, TODAY),
    ).toEqual({ kind: "period", horizon: "month", startsOn: "2026-11-01", endsOn: "2026-11-30" });
  });

  it("follows a handed-off task through its workstream", () => {
    const status = (state: ProjectStatus["state"], extra: Partial<ProjectStatus> = {}) =>
      ({
        id: "pay",
        title: "Payments",
        state,
        summary: "s",
        updatedAt: AT,
        ...extra,
      }) as ProjectStatus;
    const handed = task("t", {
      links: { projectId: "p", threadId: "a", statusId: "pay" } as never,
      handoff: { kind: "agent", threadId: "a", at: AT } as never,
    });
    const projects = (s: ProjectStatus) => [{ id: "p", assistant: { statuses: [s] } }];
    const idle = [{ id: "a", session: { status: "ready" } }];
    const running = [{ id: "a", session: { status: "running" } }];
    expect(taskAgentState(handed, idle, projects(status("working"))).kind).toBe("handed-off");
    expect(taskAgentState(handed, running, projects(status("working"))).kind).toBe("agent-working");
    expect(
      taskAgentState(
        handed,
        running,
        projects(
          status("needs-you", { decision: { question: "q", recommendation: "r", openedAt: AT } }),
        ),
      ).kind,
    ).toBe("needs-you");
    expect(taskAgentState(handed, idle, projects(status("done"))).kind).toBe("workstream-done");
    // "Not yet" hides the prompt until the workstream is written again.
    const notYet = { ...handed, completionPromptDismissedAt: "2026-11-13T13:00:00.000Z" };
    expect(taskAgentState(notYet, idle, projects(status("done"))).kind).toBe("handed-off");
    expect(
      taskAgentState(
        notYet,
        idle,
        projects(status("done", { updatedAt: "2026-11-13T14:00:00.000Z" })),
      ).kind,
    ).toBe("workstream-done");
    expect(taskAgentState({ ...handed, status: "completed" }, idle, []).kind).toBe("completed");
  });
});
