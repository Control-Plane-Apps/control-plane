import { parseStatusReply, type ProjectStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyStatusReplyTag,
  describeDecisionDeadline,
  formatStatusAge,
  groupProjectStatuses,
  isRecommendationPending,
  recommendationKey,
  recommendationReplyText,
  statusReplyPlacement,
  statusReplyTagFor,
} from "./projectStatus.logic";

const NOW = Date.parse("2026-11-13T18:00:00.000Z");
const OPENED = "2026-11-13T17:00:00.000Z";

function status(overrides: Partial<ProjectStatus> & Pick<ProjectStatus, "id" | "state">) {
  return {
    title: overrides.id,
    summary: "Summary.",
    updatedAt: "2026-11-13T17:50:00.000Z",
    ...overrides,
  } as ProjectStatus;
}

const decision = {
  question: "Retry 3 times?",
  recommendation: "Retry declined cards 3 times over 5 days.",
  answer: "Retry 3 times",
  openedAt: OPENED,
};

describe("groupProjectStatuses", () => {
  it("orders Needs you, In progress, Queued, Done and moves answered questions to In progress", () => {
    const groups = groupProjectStatuses([
      status({ id: "done", state: "done" }),
      status({ id: "checked", state: "done", dismissedAt: OPENED }),
      status({ id: "queued", state: "queued" }),
      status({ id: "answered", state: "needs-you", decision: { ...decision, answeredAt: OPENED } }),
      status({ id: "ask", state: "needs-you", decision }),
      status({ id: "work", state: "working" }),
    ]);
    expect(groups.map((g) => [g.group, g.statuses.map((s) => s.id)])).toEqual([
      ["needs-you", ["ask"]],
      ["in-progress", ["answered", "work"]],
      ["queued", ["queued"]],
      ["done", ["done"]],
    ]);
  });
});

describe("one-tap answer", () => {
  it("sends the recommendation with the workstream and question version", () => {
    const row = status({ id: "payments", title: "Payments retry", state: "needs-you", decision });
    const text = recommendationReplyText(row, decision);
    expect(parseStatusReply(text)).toMatchObject({
      title: "Payments retry",
      statusId: "payments",
      revision: Date.parse(OPENED),
    });
    expect(isRecommendationPending({ status: row, queuedTexts: [text], sentKeys: new Set() })).toBe(
      true,
    );
    expect(
      isRecommendationPending({
        status: row,
        queuedTexts: [],
        sentKeys: new Set([recommendationKey(row, decision)]),
      }),
    ).toBe(true);
    expect(isRecommendationPending({ status: row, queuedTexts: [], sentKeys: new Set() })).toBe(
      false,
    );
  });
});

describe("replies", () => {
  it("tags a question reply with its version and a header reply with the workstream only", () => {
    const row = status({ id: "pdf", title: "Report PDF export", state: "needs-you", decision });
    expect(statusReplyTagFor(row, true)).toEqual({
      title: "Report PDF export",
      statusId: "pdf",
      openedAt: OPENED,
    });
    expect(statusReplyTagFor(row, false)).toEqual({ title: "Report PDF export", statusId: "pdf" });
    expect(applyStatusReplyTag("Keep them together.", statusReplyTagFor(row, false))).toBe(
      "Re: Report PDF export [status:pdf]\n\nKeep them together.",
    );
    expect(applyStatusReplyTag("Plain.", null)).toBe("Plain.");
  });

  it("places Reply beside a question, an answered question, or in the header", () => {
    expect(statusReplyPlacement(status({ id: "a", state: "needs-you", decision }))).toBe(
      "question",
    );
    expect(
      statusReplyPlacement(
        status({ id: "b", state: "needs-you", decision: { ...decision, answeredAt: OPENED } }),
      ),
    ).toBe("answered");
    expect(statusReplyPlacement(status({ id: "c", state: "working" }))).toBe("header");
  });
});

describe("time labels", () => {
  it("reads ages and an upcoming deadline", () => {
    expect(formatStatusAge("2026-11-13T17:52:00.000Z", NOW)).toBe("8m ago");
    expect(formatStatusAge("2026-11-13T17:59:30.000Z", NOW)).toBe("just now");
    const soon = describeDecisionDeadline(
      { ...decision, deadline: new Date(NOW + 3 * 60 * 60 * 1000).toISOString() },
      NOW,
      "en-US",
    );
    expect(soon?.tone).toBe("pending");
    expect(soon?.text.startsWith("Decide by ")).toBe(true);
    expect(
      describeDecisionDeadline({ ...decision, deadline: "2026-11-13T17:30:00.000Z" }, NOW)?.tone,
    ).toBe("overdue");
  });
});
