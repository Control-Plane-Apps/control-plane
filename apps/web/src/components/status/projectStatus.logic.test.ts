import {
  PROJECT_STATUS_STALE_MS,
  parseStatusReply,
  sortProjectStatuses,
  type OrchestrationThreadShell,
  type ProjectStatusDecision,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canToggleAutoAccept,
  decisionKey,
  describeDecisionDeadline,
  describeLiveAgent,
  formatDeadlineShort,
  isRecommendationQueued,
  formatStatusAge,
  isStatusStale,
  recommendationReplyText,
  statusCountLine,
} from "./projectStatus.logic";

// A Wednesday at noon, local time, so day arithmetic does not depend on the runner's zone.
const NOW = new Date(2026, 10, 11, 12, 0, 0).getTime();
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const HOUR = 60 * 60 * 1000;

describe("statusCountLine", () => {
  it("counts workstreams and the ones waiting on the user", () => {
    expect(statusCountLine([])).toBe("0 workstreams");
    expect(statusCountLine([{ state: "working" }])).toBe("1 workstream");
    expect(
      statusCountLine([{ state: "needs-you" }, { state: "done" }, { state: "needs-you" }]),
    ).toBe("3 workstreams · 2 need you");
    expect(statusCountLine([{ state: "needs-you" }, { state: "queued" }])).toBe(
      "2 workstreams · 1 needs you",
    );
  });
});

describe("sortProjectStatuses", () => {
  it("puts decisions first and keeps the coordinator's order otherwise", () => {
    const sorted = sortProjectStatuses([
      { id: "a", state: "done" },
      { id: "b", state: "working" },
      { id: "c", state: "needs-you" },
      { id: "d", state: "queued" },
      { id: "e", state: "working" },
      { id: "f", state: "needs-you" },
    ] as const);
    expect(sorted.map((status) => status.id)).toEqual(["c", "f", "b", "e", "d", "a"]);
  });
});

describe("age and staleness", () => {
  it("reads minutes, hours and days", () => {
    expect(formatStatusAge(at(-20_000), NOW)).toBe("just now");
    expect(formatStatusAge(at(-12 * 60_000), NOW)).toBe("12m ago");
    expect(formatStatusAge(at(-3 * HOUR), NOW)).toBe("3h ago");
    expect(formatStatusAge(at(-50 * HOUR), NOW)).toBe("2d ago");
  });

  it("marks a record stale once it is a day old", () => {
    expect(isStatusStale(at(-PROJECT_STATUS_STALE_MS + 60_000), NOW)).toBe(false);
    expect(isStatusStale(at(-PROJECT_STATUS_STALE_MS), NOW)).toBe(true);
    expect(isStatusStale("not a date", NOW)).toBe(false);
  });
});

describe("decision deadlines", () => {
  it("names the day the way a person would", () => {
    expect(formatDeadlineShort(at(1 * HOUR), NOW, "en-US")).toBe("1:00 PM");
    expect(formatDeadlineShort(at(24 * HOUR), NOW, "en-US")).toBe("tomorrow");
    expect(formatDeadlineShort(at(2 * 24 * HOUR), NOW, "en-US")).toBe("Fri");
    expect(formatDeadlineShort(at(10 * 24 * HOUR), NOW, "en-US")).toBe("Nov 21");
  });

  const decision = (overrides: Partial<ProjectStatusDecision> = {}): ProjectStatusDecision => ({
    question: "Pilot or release to every inspector?",
    recommendation: "pilot with 5 inspectors",
    openedAt: at(-HOUR),
    deadline: at(2 * 24 * HOUR),
    ...overrides,
  });

  it("reminds by default, and goes with the recommendation only on the user's opt-in", () => {
    expect(describeDecisionDeadline(decision({ deadline: undefined }), NOW)).toBeNull();
    expect(describeDecisionDeadline(decision(), NOW, "en-US")).toEqual({
      text: "No reply by Fri: I'll remind you and keep waiting.",
      tone: "pending",
    });
    const armed = decision({ autoAccept: { openedAt: at(-HOUR), enabledAt: at(-60_000) } });
    expect(describeDecisionDeadline(armed, NOW, "en-US")).toEqual({
      text: "No reply by Fri: I'll go with the recommendation.",
      tone: "pending",
    });
  });

  it("drops an opt-in made for an earlier version of the decision", () => {
    const stale = decision({ autoAccept: { openedAt: at(-2 * HOUR), enabledAt: at(-2 * HOUR) } });
    expect(describeDecisionDeadline(stale, NOW, "en-US")?.text).toBe(
      "No reply by Fri: I'll remind you and keep waiting.",
    );
  });

  it("says how a passed deadline was handled, and nothing once the user replied", () => {
    expect(
      describeDecisionDeadline(
        decision({ deadline: at(-HOUR), deadlineHandled: { at: at(-HOUR), outcome: "reminded" } }),
        NOW,
      ),
    ).toEqual({ text: "Deadline passed, still waiting on you.", tone: "overdue" });
    expect(describeDecisionDeadline(decision({ deadline: at(-60_000) }), NOW)?.tone).toBe(
      "overdue",
    );
    expect(
      describeDecisionDeadline(
        decision({ deadline: at(-HOUR), deadlineHandled: { at: at(-HOUR), outcome: "accepted" } }),
        NOW,
      ),
    ).toEqual({ text: "Recommendation sent at the deadline.", tone: "handled" });
    expect(describeDecisionDeadline(decision({ answeredAt: at(-60_000) }), NOW)).toBeNull();
  });

  it("says the recommendation is going out when an armed deadline passes before the sweep", () => {
    const armedPast = decision({
      deadline: at(-60_000),
      autoAccept: { openedAt: at(-HOUR), enabledAt: at(-HOUR) },
    });
    expect(describeDecisionDeadline(armedPast, NOW)).toEqual({
      text: "Sending the recommendation now.",
      tone: "handled",
    });
  });

  it("offers the opt-in only while the deadline is still ahead and unanswered", () => {
    expect(canToggleAutoAccept(decision(), NOW)).toBe(true);
    expect(canToggleAutoAccept(decision({ deadline: undefined }), NOW)).toBe(false);
    expect(canToggleAutoAccept(decision({ deadline: at(-60_000) }), NOW)).toBe(false);
    expect(canToggleAutoAccept(decision({ answeredAt: at(-60_000) }), NOW)).toBe(false);
    expect(
      canToggleAutoAccept(
        decision({ deadlineHandled: { at: at(-60_000), outcome: "reminded" } }),
        NOW,
      ),
    ).toBe(false);
  });
});

type Shell = Parameters<typeof describeLiveAgent>[0];
const shell = (overrides: Partial<NonNullable<Shell>> = {}): NonNullable<Shell> => ({
  title: "PDF agent",
  archivedAt: null,
  settledAt: null,
  latestTurn: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  session: null,
  backgroundLiveness: null,
  ...overrides,
});
const runningSession = { status: "running" } as unknown as OrchestrationThreadShell["session"];
const runningTurn = (startedAt: string) =>
  ({
    turnId: "turn-1",
    state: "running",
    requestedAt: startedAt,
    startedAt,
    completedAt: null,
    assistantMessageId: null,
  }) as unknown as OrchestrationThreadShell["latestTurn"];

describe("describeLiveAgent", () => {
  it("reports only what the thread is really doing", () => {
    expect(describeLiveAgent(null, NOW)).toBeNull();
    expect(describeLiveAgent(shell({ archivedAt: at(-HOUR) }), NOW)).toBeNull();
    expect(
      describeLiveAgent(
        shell({ session: runningSession, latestTurn: runningTurn(at(-14 * 60_000)) }),
        NOW,
      ),
    ).toEqual({ label: "PDF agent · working 14m", tone: "working" });
    expect(describeLiveAgent(shell({ hasPendingApprovals: true }), NOW)).toEqual({
      label: "PDF agent · needs approval",
      tone: "attention",
    });
    expect(describeLiveAgent(shell(), NOW)).toEqual({ label: "PDF agent · idle", tone: "idle" });
    expect(describeLiveAgent(shell({ settledAt: at(-HOUR) }), NOW)).toEqual({
      label: "PDF agent · settled",
      tone: "idle",
    });
  });
});

describe("replies", () => {
  const payouts = {
    id: "payouts",
    title: "Payouts",
    decision: {
      question: "Pilot?",
      recommendation: "pilot with 5 inspectors",
      openedAt: "2026-11-11T11:00:00.000Z",
    },
  };

  it("sends the recommendation naming the workstream and the question's version", () => {
    const text = recommendationReplyText(payouts, payouts.decision);
    const revision = Date.parse(payouts.decision.openedAt);
    expect(text).toBe(
      `Re: Payouts [status:payouts@${revision}]\n\nGo with your recommendation: pilot with 5 inspectors`,
    );
    expect(parseStatusReply(text)).toEqual({
      title: "Payouts",
      body: "Go with your recommendation: pilot with 5 inspectors",
      statusId: "payouts",
      revision,
    });
  });

  it("reads Go with recommendation as in flight only while its message is queued", () => {
    const go = { prompt: recommendationReplyText(payouts, payouts.decision) };
    expect(isRecommendationQueued([go], payouts)).toBe(true);
    // Removed, restored to the composer or sent: the queue no longer holds it.
    expect(isRecommendationQueued([{ prompt: "something else" }], payouts)).toBe(false);
    expect(isRecommendationQueued([], payouts)).toBe(false);
    expect(
      isRecommendationQueued([go], {
        ...payouts,
        decision: { ...payouts.decision, answeredAt: at(-60_000) },
      }),
    ).toBe(false);
    // A newer version of the question is a different message.
    expect(
      isRecommendationQueued([go], {
        ...payouts,
        decision: { ...payouts.decision, openedAt: "2026-11-11T11:30:00.000Z" },
      }),
    ).toBe(false);
  });

  it("keys a decision by its version", () => {
    expect(decisionKey({ id: "payouts" }, { openedAt: "2026-11-09T10:00:00.000Z" })).toBe(
      "payouts@2026-11-09T10:00:00.000Z",
    );
  });
});
