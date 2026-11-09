import { describe, expect, it } from "vite-plus/test";

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
    expect(parseStatusReply("Re: the email from Friday, can you check?")).toBeNull();
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
    expect(countStatusesNeedingUser(undefined)).toBe(0);
  });

  it("names one reminder per decision version", () => {
    expect(statusReminderMessageId("p", "payouts", "2026-10-28T12:00:00.000Z")).toBe(
      "cp-status:p:payouts:1793188800000",
    );
  });
});
