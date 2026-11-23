import { describe, expect, it } from "@effect/vitest";

import {
  attachmentFileThreadSegment,
  historyDigest,
  legacyCoverage,
  movedAttachmentId,
  orderHistory,
  paginateHistory,
  type MovingMessage,
} from "./assistantHistory.ts";

const message = (index: number, text = `m${index}`): MovingMessage => ({
  messageId: `msg-${String(index).padStart(5, "0")}`,
  role: index % 2 === 0 ? "user" : "assistant",
  text,
  createdAt: `2026-01-01T${String(Math.floor(index / 3600)).padStart(2, "0")}:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
});

describe("assistantHistory", () => {
  it("moves every message, in pages by count and by size", () => {
    const all = Array.from({ length: 2142 }, (_, index) => message(index));
    const pages = paginateHistory(all);
    expect(pages.map((page) => page.length)).toEqual([...Array(10).fill(200), 142]);
    expect(pages.flat()).toEqual(all);
    const big = [message(0, "x".repeat(300)), message(1, "y".repeat(300)), message(2)];
    expect(paginateHistory(big, { count: 200, bytes: 900 }).map((page) => page.length)).toEqual([
      1, 2,
    ]);
  });

  it("digests the conversation regardless of ids and arrival order", () => {
    const all = [message(0), message(1), message(2)];
    const renamed = all.map((entry) => ({ ...entry, messageId: `other-${entry.messageId}` }));
    expect(historyDigest(all)).toBe(historyDigest(renamed.toReversed()));
    expect(historyDigest(all)).not.toBe(historyDigest(all.slice(0, 2)));
    expect(orderHistory(all.toReversed())).toEqual(all);
  });

  it("renames an attachment for the new thread, stably per move", () => {
    const original = "old_thread-0b1e8d2a-1234-4abc-9def-0123456789ab-png";
    const first = movedAttachmentId({
      moveId: "m1",
      threadId: "new-thread",
      attachmentId: original,
    });
    expect(first).toMatch(/^new-thread-[0-9a-f-]{36}-png$/);
    expect(
      movedAttachmentId({ moveId: "m1", threadId: "new-thread", attachmentId: original }),
    ).toBe(first);
    expect(
      movedAttachmentId({ moveId: "m2", threadId: "new-thread", attachmentId: original }),
    ).not.toBe(first);
    expect(movedAttachmentId({ moveId: "m1", threadId: "new-thread", attachmentId: "../x" })).toBe(
      null,
    );
  });

  it("counts a message with the same words but fewer attachments as not yet here", () => {
    const at = "2025-01-01T00:00:00.000Z";
    const file = { type: "image", id: "t-0b1e8d2a-1234-4abc-9def-0123456789ab-png" };
    const local = [
      { messageId: "moved:a:0", role: "user", createdAt: at, text: "look", attachmentCount: 0 },
      {
        messageId: "moved:a:1",
        role: "assistant",
        createdAt: at,
        text: "nice",
        attachmentCount: 0,
      },
    ];
    const remote: MovingMessage[] = [
      { messageId: "r1", role: "user", createdAt: at, text: "look", attachments: [file] },
      { messageId: "r2", role: "assistant", createdAt: at, text: "nice" },
      { messageId: "r3", role: "user", createdAt: at, text: "new" },
    ];
    const coverage = legacyCoverage(local, remote);
    expect(coverage.missing.map((entry) => entry.messageId)).toEqual(["r3"]);
    expect(coverage.thin.map((entry) => [entry.message.messageId, entry.local.messageId])).toEqual([
      ["r1", "moved:a:0"],
    ]);
    // Once the local message holds the attachment, it is covered.
    const filled = legacyCoverage(
      [{ ...local[0]!, attachmentCount: 1 }, local[1]!],
      remote.slice(0, 2),
    );
    expect(filled).toEqual({ missing: [], thin: [] });
  });

  it("reads the thread segment of a stored attachment file, finished or partial", () => {
    const parse = (id: string) => (id.startsWith("seg-") ? "seg" : null);
    expect(attachmentFileThreadSegment("seg-abc-png.png", parse)).toBe("seg");
    expect(attachmentFileThreadSegment("seg-abc-png.png.part", parse)).toBe("seg");
    expect(attachmentFileThreadSegment("other-abc.png", parse)).toBeNull();
  });
});
