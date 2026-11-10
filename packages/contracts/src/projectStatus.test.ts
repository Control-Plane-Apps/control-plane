import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectStatusUpdatedPayload } from "./orchestration.ts";

import {
  countStatusesNeedingUser,
  parseStatusReply,
  sortProjectStatuses,
  statusReminderMessageId,
  statusReplyText,
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
