import {
  PROJECT_STATUS_STALE_MS,
  PROJECT_STATUS_SUMMARY_MAX,
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
  isRecommendationPending,
  isRecommendationQueued,
  recommendationKey,
  formatStatusAge,
  isStatusStale,
  recommendationReplyText,
  groupProjectStatuses,
  recommendationButtonLabel,
  sentRecommendationKeys,
  showsFullRecommendation,
  statusGroupOf,
  summaryNeedsExpansion,
} from "./projectStatus.logic";

// A Wednesday at noon, local time, so day arithmetic does not depend on the runner's zone.
const NOW = new Date(2026, 10, 11, 12, 0, 0).getTime();
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const HOUR = 60 * 60 * 1000;

describe("status groups", () => {
  const question = {
    question: "Pilot?",
    recommendation: "pilot with 5 inspectors",
    openedAt: "2026-11-11T11:00:00.000Z",
  };

  it("files each row where it reads truthfully", () => {
    expect(statusGroupOf({ state: "needs-you", decision: question })).toBe("needs-you");
    expect(statusGroupOf({ state: "needs-you" })).toBe("needs-you");
    // Answered: waiting on the coordinator, not on the user.
    expect(
      statusGroupOf({
        state: "needs-you",
        decision: { ...question, answeredAt: question.openedAt },
      }),
    ).toBe("in-progress");
    expect(statusGroupOf({ state: "working" })).toBe("in-progress");
    expect(statusGroupOf({ state: "queued" })).toBe("queued");
    expect(statusGroupOf({ state: "done" })).toBe("done");
  });

  it("orders groups, hides empty ones and keeps the coordinator's order inside", () => {
    const groups = groupProjectStatuses([
      { id: "a", state: "done" },
      { id: "b", state: "working" },
      { id: "c", state: "needs-you", decision: { ...question, answeredAt: question.openedAt } },
      { id: "d", state: "needs-you", decision: question },
      { id: "e", state: "done" },
    ] as const);
    expect(
      groups.map(({ group, statuses }) => [group, statuses.map((status) => status.id)]),
    ).toEqual([
      ["needs-you", ["d"]],
      ["in-progress", ["c", "b"]],
      ["done", ["a", "e"]],
    ]);
    expect(groupProjectStatuses([])).toEqual([]);
  });
});

describe("decision labels", () => {
  it("uses the short answer, and the old wording for records without one", () => {
    expect(recommendationButtonLabel({ answer: "Pilot 5" })).toBe("Pilot 5");
    expect(recommendationButtonLabel({})).toBe("Go with recommendation");
  });

  it("shows the full recommendation only when the button does not already say it", () => {
    expect(showsFullRecommendation({ recommendation: "pilot with 5 inspectors" })).toBe(true);
    expect(
      showsFullRecommendation({ answer: "Pilot 5", recommendation: "pilot with 5 inspectors" }),
    ).toBe(true);
    expect(showsFullRecommendation({ answer: "Keep it", recommendation: "Keep it" })).toBe(false);
  });

  it("expands a summary only past the one-line limit, never cutting the data", () => {
    expect(summaryNeedsExpansion("x".repeat(PROJECT_STATUS_SUMMARY_MAX))).toBe(false);
    expect(summaryNeedsExpansion("x".repeat(PROJECT_STATUS_SUMMARY_MAX + 1))).toBe(true);
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
      text: "reminds you Fri if no reply",
      tone: "pending",
    });
    const armed = decision({ autoAccept: { openedAt: at(-HOUR), enabledAt: at(-60_000) } });
    expect(describeDecisionDeadline(armed, NOW, "en-US")).toEqual({
      text: "goes ahead Fri if no reply",
      tone: "pending",
    });
  });

  it("drops an opt-in made for an earlier version of the decision", () => {
    const stale = decision({ autoAccept: { openedAt: at(-2 * HOUR), enabledAt: at(-2 * HOUR) } });
    expect(describeDecisionDeadline(stale, NOW, "en-US")?.text).toBe("reminds you Fri if no reply");
  });

  it("says how a passed deadline was handled, and nothing once the user replied", () => {
    expect(
      describeDecisionDeadline(
        decision({ deadline: at(-HOUR), deadlineHandled: { at: at(-HOUR), outcome: "reminded" } }),
        NOW,
      ),
    ).toEqual({ text: "deadline passed, still waiting on you", tone: "overdue" });
    expect(describeDecisionDeadline(decision({ deadline: at(-60_000) }), NOW)?.tone).toBe(
      "overdue",
    );
    expect(
      describeDecisionDeadline(
        decision({ deadline: at(-HOUR), deadlineHandled: { at: at(-HOUR), outcome: "accepted" } }),
        NOW,
      ),
    ).toEqual({ text: "recommendation sent at the deadline", tone: "handled" });
    expect(describeDecisionDeadline(decision({ answeredAt: at(-60_000) }), NOW)).toBeNull();
  });

  it("says the recommendation is going out when an armed deadline passes before the sweep", () => {
    const armedPast = decision({
      deadline: at(-60_000),
      autoAccept: { openedAt: at(-HOUR), enabledAt: at(-HOUR) },
    });
    expect(describeDecisionDeadline(armedPast, NOW)).toEqual({
      text: "sending the recommendation now",
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

  it("reads Go with recommendation as pending while it is queued or sent but not yet answered", () => {
    const go = { prompt: recommendationReplyText(payouts, payouts.decision) };
    const none = new Set<string>();
    expect(isRecommendationQueued([go], payouts)).toBe(true);
    // The model's effort line in front still matches by id and version.
    expect(isRecommendationQueued([{ prompt: `Ultrathink:\n${go.prompt}` }], payouts)).toBe(true);
    // Removed, restored or failed: the queue no longer holds it.
    expect(isRecommendationQueued([{ prompt: "something else" }], payouts)).toBe(false);
    // Another reply to the same question is not the recommendation.
    expect(
      isRecommendationQueued(
        [{ prompt: go.prompt.replace("Go with your recommendation: pilot", "Hold off") }],
        payouts,
      ),
    ).toBe(false);
    // A newer version of the question is a different message.
    const reworded = {
      ...payouts,
      decision: { ...payouts.decision, openedAt: "2026-11-11T11:30:00.000Z" },
    };
    expect(isRecommendationQueued([go], reworded)).toBe(false);

    const sent = sentRecommendationKeys([
      { role: "user", text: go.prompt },
      { role: "assistant", text: go.prompt },
    ]);
    expect([...sent]).toEqual([recommendationKey(payouts, payouts.decision)]);
    expect(isRecommendationPending({ status: payouts, queue: [], sentKeys: sent })).toBe(true);
    expect(isRecommendationPending({ status: payouts, queue: [], sentKeys: none })).toBe(false);
    expect(isRecommendationPending({ status: reworded, queue: [], sentKeys: sent })).toBe(false);
    expect(
      isRecommendationPending({
        status: { ...payouts, decision: { ...payouts.decision, answeredAt: at(-60_000) } },
        queue: [go],
        sentKeys: sent,
      }),
    ).toBe(false);
  });

  it("keys a decision by its version", () => {
    expect(decisionKey({ id: "payouts" }, { openedAt: "2026-11-09T10:00:00.000Z" })).toBe(
      "payouts@2026-11-09T10:00:00.000Z",
    );
  });
});
