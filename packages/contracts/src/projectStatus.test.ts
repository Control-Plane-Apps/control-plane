import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectStatusUpdatedPayload } from "./orchestration.ts";

import {
  answeredLabel,
  countStatusesNeedingUser,
  isStatusMessageId,
  isStatusNeedingUser,
  parseStatusReply,
  PROJECT_STATUS_STALL_MINUTES_DEFAULT,
  recommendedAnswerLabel,
  sortProjectStatuses,
  type StatusAgentShell,
  statusReminderMessageId,
  statusReplyText,
  statusStallMessageId,
  statusStallMinutesOf,
  statusStallOf,
} from "./projectStatus.ts";

describe("project status helpers", () => {
  it("round-trips a composer reply and leaves ordinary messages alone", () => {
    const text = statusReplyText("Payouts", "Pilot, but only three inspectors.\n\nHold 1099s.");
    expect(parseStatusReply(text)).toEqual({
      title: "Payouts",
      body: "Pilot, but only three inspectors.\n\nHold 1099s.",
    });
    expect(parseStatusReply(`Ultrathink:\n${text}`)?.title).toBe("Payouts");
    expect(parseStatusReply("Re: the email from Friday, can you check?")).toBeNull();
    const tagged = statusReplyText("Payouts", "Pilot.", {
      statusId: "payouts",
      openedAt: "2026-10-28T12:00:00.000Z",
    });
    expect(tagged.split("\n")[0]).toBe("Re: Payouts [status:payouts@1793188800000]");
    expect(parseStatusReply(tagged)).toEqual({
      title: "Payouts",
      body: "Pilot.",
      statusId: "payouts",
      revision: 1793188800000,
    });
    expect(
      parseStatusReply(statusReplyText("PDF export", "Any update?", { statusId: "pdf" })),
    ).toEqual({ title: "PDF export", body: "Any update?", statusId: "pdf" });
    expect(parseStatusReply("Where are we on payouts?")).toBeNull();
  });

  it("puts waiting-on-you first and counts it, keeping order otherwise", () => {
    const statuses = [
      { id: "a", state: "done" as const },
      { id: "b", state: "needs-you" as const },
      { id: "c", state: "working" as const },
      { id: "d", state: "queued" as const },
      { id: "e", state: "needs-you" as const },
    ];
    expect(sortProjectStatuses(statuses).map((status) => status.id)).toEqual([
      "b",
      "e",
      "c",
      "d",
      "a",
    ]);
    expect(countStatusesNeedingUser(statuses)).toBe(2);
    expect(
      countStatusesNeedingUser([
        ...statuses,
        { state: "needs-you" as const, decision: { answeredAt: "2026-11-09T00:00:00.000Z" } },
      ]),
    ).toBe(2);
    expect(countStatusesNeedingUser(undefined)).toBe(0);
  });

  it("needs the user only for an unanswered, visible needs-you record", () => {
    const at = "2026-11-16T14:30:12.858Z";
    expect(isStatusNeedingUser({ state: "needs-you", decision: {} })).toBe(true);
    expect(isStatusNeedingUser({ state: "needs-you" })).toBe(true);
    expect(isStatusNeedingUser({ state: "needs-you", decision: { answeredAt: at } })).toBe(false);
    expect(isStatusNeedingUser({ state: "needs-you", dismissedAt: at })).toBe(false);
    expect(isStatusNeedingUser({ state: "working", decision: {} })).toBe(false);
    expect(isStatusNeedingUser({ state: "done", decision: {} })).toBe(false);
  });

  it("names one reminder per decision version", () => {
    expect(statusReminderMessageId("p", "payouts", "2026-10-28T12:00:00.000Z")).toBe(
      "cp-status:p:payouts:1793188800000",
    );
  });
});

describe("older status events", () => {
  it("still decode on replay: long lines and no answer label", () => {
    const payload = {
      projectId: "p",
      statusId: "release",
      status: {
        id: "release",
        title: "Release 18.6",
        state: "needs-you",
        summary: "x".repeat(200),
        decision: {
          question: "y".repeat(200),
          recommendation: "Ship once green",
          openedAt: "2026-11-09T12:00:00.000Z",
        },
        updatedAt: "2026-11-09T12:00:00.000Z",
      },
    };
    const decoded = Schema.decodeUnknownSync(ProjectStatusUpdatedPayload)(payload);
    expect(decoded.status?.summary).toHaveLength(200);
    expect(decoded.status?.decision?.answer).toBeUndefined();
  });
});

describe("statusStallOf", () => {
  const NOW_MS = Date.parse("2026-11-16T12:00:00.000Z");
  const ago = (minutes: number) => new Date(NOW_MS - minutes * 60_000).toISOString();
  const idleAgent = (completedMinutesAgo: number): StatusAgentShell => ({
    archivedAt: null,
    settledAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    backgroundLiveness: null,
    session: { status: "ready", updatedAt: ago(completedMinutesAgo) },
    latestTurn: {
      requestedAt: ago(completedMinutesAgo + 30),
      startedAt: ago(completedMinutesAgo + 30),
      completedAt: ago(completedMinutesAgo),
    },
  });
  const working = (updatedMinutesAgo: number, agents?: ReadonlyArray<string>) => ({
    state: "working" as const,
    updatedAt: ago(updatedMinutesAgo),
    ...(agents !== undefined ? { agents } : {}),
  });

  it("stalls a working row once its agents have all stopped for the threshold", () => {
    const row = working(180, ["agent-a"]);
    expect(statusStallOf(row, [idleAgent(14)], NOW_MS, 15)).toBeNull();
    expect(statusStallOf(row, [idleAgent(15)], NOW_MS, 15)).toEqual({
      kind: "agents-stopped",
      sinceMs: NOW_MS - 15 * 60_000,
      reason: "No agent running for 15m",
    });
    expect(statusStallOf(row, [idleAgent(120)], NOW_MS, 15)?.reason).toBe(
      "No agent running for 2h",
    );
  });

  it("never stalls while any linked agent is live, or waits on the user", () => {
    const row = working(180, ["a", "b"]);
    const running = { ...idleAgent(60), session: { status: "running", updatedAt: ago(60) } };
    expect(statusStallOf(row, [idleAgent(60), running], NOW_MS, 15)).toBeNull();
    const asking = { ...idleAgent(60), hasPendingApprovals: true };
    expect(statusStallOf(row, [asking], NOW_MS, 15)).toBeNull();
    const background = { ...idleAgent(60), backgroundLiveness: "working" as const };
    expect(statusStallOf(row, [background], NOW_MS, 15)).toBeNull();
  });

  it("counts failed, settled, archived and deleted agents as not running", () => {
    const row = working(180, ["a"]);
    const failed = { ...idleAgent(60), session: { status: "error", updatedAt: ago(60) } };
    expect(statusStallOf(row, [failed], NOW_MS, 15)?.kind).toBe("agents-stopped");
    expect(statusStallOf(row, [{ ...idleAgent(60), archivedAt: ago(60) }], NOW_MS, 15)).not.toBe(
      null,
    );
    // A deleted agent is null: the clock runs from the row's own update.
    expect(statusStallOf(row, [null], NOW_MS, 15)?.sinceMs).toBe(NOW_MS - 180 * 60_000);
  });

  it("restarts the clock from a newer row update", () => {
    expect(statusStallOf(working(5, ["a"]), [idleAgent(120)], NOW_MS, 15)).toBeNull();
    expect(statusStallOf(working(20, ["a"]), [idleAgent(120)], NOW_MS, 15)?.reason).toBe(
      "No agent running for 20m",
    );
  });

  it("uses time since the last update for a working row with no agents", () => {
    expect(statusStallOf(working(14), [], NOW_MS, 15)).toBeNull();
    expect(statusStallOf(working(45), [], NOW_MS, 15)).toEqual({
      kind: "no-agents",
      sinceMs: NOW_MS - 45 * 60_000,
      reason: "No update for 45m",
    });
  });

  it("stalls a queued row only when it has agents, and never done, needs-you or checked-off rows", () => {
    const queued = { state: "queued" as const, updatedAt: ago(600) };
    expect(statusStallOf(queued, [], NOW_MS, 15)).toBeNull();
    expect(statusStallOf({ ...queued, agents: ["a"] }, [idleAgent(60)], NOW_MS, 15)).not.toBeNull();
    for (const state of ["done", "needs-you"] as const) {
      expect(statusStallOf({ state, updatedAt: ago(600) }, [], NOW_MS, 15)).toBeNull();
    }
    expect(statusStallOf({ ...working(600), dismissedAt: ago(1) }, [], NOW_MS, 15)).toBeNull();
  });

  it("is off at 0 minutes, and the setting falls back to the default", () => {
    expect(statusStallOf(working(600), [], NOW_MS, 0)).toBeNull();
    expect(statusStallMinutesOf(undefined)).toBe(PROJECT_STATUS_STALL_MINUTES_DEFAULT);
    expect(statusStallMinutesOf(-3)).toBe(PROJECT_STATUS_STALL_MINUTES_DEFAULT);
    expect(statusStallMinutesOf(0)).toBe(0);
    expect(statusStallMinutesOf(30)).toBe(30);
  });

  it("keys one nudge per row and stall start", () => {
    expect(statusStallMessageId("p", "payouts", 1_700_000_000_000)).toBe(
      "cp-status:p:payouts:stalled:1700000000000",
    );
    expect(isStatusMessageId(statusStallMessageId("p", "payouts", 1))).toBe(true);
  });
});

describe("answer labels", () => {
  it("labels the open question's button as an action, never a done state", () => {
    expect(recommendedAnswerLabel({ answer: "Sent it" })).toBe("Answer: Sent it");
    expect(recommendedAnswerLabel({})).toBe("Go with recommendation");
  });

  it("shows an answered state only once the user actually answered", () => {
    expect(answeredLabel({ answer: "Sent it" })).toBeNull();
    expect(
      answeredLabel({
        answer: "Sent it",
        answeredAt: "2026-11-16T12:00:00.000Z",
        answeredWith: "recommendation",
      }),
    ).toBe("You answered: Sent it");
    expect(
      answeredLabel({
        answer: "Sent it",
        answeredAt: "2026-11-16T12:00:00.000Z",
        answeredWith: "reply",
      }),
    ).toBe("You replied");
    // Answers recorded before answeredWith existed.
    expect(answeredLabel({ answeredAt: "2026-11-16T12:00:00.000Z" })).toBe("You replied");
  });
});
