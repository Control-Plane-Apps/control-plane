import { describe, expect, it } from "@effect/vitest";

import { issuePushActionToken, verifyPushActionToken } from "./actionToken.ts";
import { apnsKeyIdFromFileName } from "./apnsClient.ts";
import {
  apnsCollapseId,
  formatReminderTime,
  levelAllows,
  pushActionUrl,
  statusQuestionMessage,
  taskReminderMessage,
} from "./pushPayloads.ts";
import { dueTaskReminders, localClock } from "./taskReminders.ts";

const SECRET = new Uint8Array(32).fill(7);
const NOW = Date.parse("2026-11-13T16:41:00.000Z");

describe("push payloads", () => {
  it("builds the lock-screen question with an answer button and the Project line", () => {
    const message = statusQuestionMessage(
      {
        environmentId: "env-1",
        projectId: "project-1",
        projectTitle: "Hometrace",
        coordinatorThreadId: "thread-1",
        statusId: "payments-retry",
        statusTitle: "Payments retry",
        question: "Retry declined cards 3 times over 5 days, or stop after the first decline?",
        answerLabel: "Retry 3 times",
        openedAt: "2026-11-13T16:40:00.000Z",
      },
      { url: "http://mac.tailnet:3773/api/push/action", token: "tok" },
    );
    expect(message.payload.aps.alert).toEqual({
      title: "Payments retry needs you",
      body: "Retry declined cards 3 times over 5 days, or stop after the first decline?\nHometrace · Recommended: Retry 3 times",
    });
    expect(message.payload.aps.category).toBe("cp.status-question");
    expect(message.payload.aps["mutable-content"]).toBe(1);
    expect(message.payload.cp).toMatchObject({
      kind: "status-question",
      deepLink: "/threads/env-1/thread-1",
      answerLabel: "Retry 3 times",
      actionUrl: "http://mac.tailnet:3773/api/push/action",
      actionToken: "tok",
    });
  });

  it("lets needs-you through at the default level and agent finished only at all", () => {
    expect(levelAllows("needs-you", "status-question")).toBe(true);
    expect(levelAllows("needs-you", "task-reminder")).toBe(true);
    expect(levelAllows("needs-you", "agent-finished")).toBe(false);
    expect(levelAllows("all", "agent-finished")).toBe(true);
    expect(levelAllows("off", "status-question")).toBe(false);
  });

  it("keeps collapse ids within APNs's 64 bytes and joins action urls cleanly", () => {
    expect(apnsCollapseId("short")).toBe("short");
    expect(apnsCollapseId("x".repeat(100))).toHaveLength(64);
    expect(pushActionUrl("http://mac:3773/")).toBe("http://mac:3773/api/push/action");
  });

  it("reminds with Complete and Snooze wiring", () => {
    const message = taskReminderMessage(
      {
        environmentId: "env-1",
        taskId: "task-1",
        title: "Renew Apple developer account",
        detail: "Overdue since yesterday",
      },
      { url: "http://mac/api/push/action", token: "t" },
    );
    expect(message.payload.aps.category).toBe("cp.task-reminder");
    expect(message.payload.cp.taskId).toBe("task-1");
    expect(formatReminderTime("09:00")).toBe("9:00 AM");
    expect(formatReminderTime("13:05")).toBe("1:05 PM");
    expect(formatReminderTime("00:30")).toBe("12:30 AM");
  });

  it("reads the APNs key id from Apple's download name", () => {
    expect(apnsKeyIdFromFileName("AuthKey_ABCDE12345.p8")).toBe("ABCDE12345");
    expect(apnsKeyIdFromFileName("key.p8")).toBeNull();
  });
});

describe("action tokens", () => {
  it("verifies its own token and nothing else", () => {
    const token = issuePushActionToken(
      { kind: "push-status-answer", projectId: "p", statusId: "s", openedAt: "o" },
      SECRET,
      NOW,
    );
    expect(verifyPushActionToken(token, SECRET, NOW + 1000)).toMatchObject({
      kind: "push-status-answer",
      statusId: "s",
      openedAt: "o",
    });
    expect(verifyPushActionToken(token, new Uint8Array(32).fill(8), NOW)).toBeNull();
    expect(verifyPushActionToken(token, SECRET, NOW + 4 * 24 * 60 * 60 * 1000)).toBeNull();
    expect(verifyPushActionToken(`${token}.x`, SECRET, NOW)).toBeNull();
  });
});

describe("task reminders", () => {
  const clock = localClock(NOW);
  const task = (reminderTime: string, extra: Record<string, unknown> = {}) =>
    ({
      id: `task-${reminderTime}`,
      title: "Renew",
      status: "todo",
      home: { kind: "date", date: clock.date, reminderTime },
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      ...extra,
    }) as never;

  it("sends a reminder once its time arrives, within the grace window, once", () => {
    const [hours, minutes] = clock.time.split(":").map(Number) as [number, number];
    const at = (delta: number) => {
      const total = hours * 60 + minutes + delta;
      return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    };
    if (hours * 60 + minutes < 60 || hours >= 23) return; // keep the arithmetic inside one day
    const due = dueTaskReminders(
      [task(at(0)), task(at(-10)), task(at(5)), task(at(-45))],
      NOW,
      new Set(),
    );
    expect(due.map((entry: { id: string }) => entry.id)).toEqual([
      `task-${at(0)}`,
      `task-${at(-10)}`,
    ]);
    const sent = new Set([`task-${at(0)}@${clock.date}T${at(0)}`]);
    expect(dueTaskReminders([task(at(0))], NOW, sent)).toEqual([]);
    expect(dueTaskReminders([task(at(0), { status: "completed" })], NOW, new Set())).toEqual([]);
  });
});
