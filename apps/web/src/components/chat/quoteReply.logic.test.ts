import { TurnId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  flashTimelineRow,
  latestReplyableAssistantMessage,
  resolveQuoteJumpTarget,
} from "./quoteReply.logic";

const message = (id: string, extra: Record<string, unknown> = {}) => ({
  kind: "message",
  message: { id, role: "assistant", text: `text ${id}`, ...extra },
});

describe("scroll to the original", () => {
  const rows = [
    { id: "row-a", kind: "message", message: { id: "a" } },
    { id: "row-fold", kind: "turn-fold" },
    { id: "row-c", kind: "message", message: { id: "c" } },
  ];
  const entries = [
    message("a"),
    message("b", { turnId: TurnId.make("turn-2") }),
    message("c"),
    message("orphan-in-no-turn"),
  ];

  it("targets the painted row", () => {
    expect(resolveQuoteJumpTarget(rows, entries, "c")).toEqual({
      kind: "row",
      index: 2,
      rowId: "row-c",
    });
  });

  it("opens a folded turn first", () => {
    expect(resolveQuoteJumpTarget(rows, entries, "b")).toEqual({
      kind: "folded",
      turnId: "turn-2",
    });
  });

  it("reports a removed original as missing", () => {
    expect(resolveQuoteJumpTarget(rows, entries, "gone")).toEqual({ kind: "missing" });
    expect(resolveQuoteJumpTarget(rows, entries, "orphan-in-no-turn")).toEqual({
      kind: "missing",
    });
  });

  it("flashes the row's highlight target", () => {
    const target = { animate: vi.fn() };
    const element = { querySelector: vi.fn(() => target), animate: vi.fn() };
    flashTimelineRow(element as unknown as HTMLElement);
    expect(element.querySelector).toHaveBeenCalledWith("[data-quote-reply-flash-target]");
    expect(target.animate).toHaveBeenCalledOnce();
    expect(element.animate).not.toHaveBeenCalled();
  });
});

describe("keyboard reply", () => {
  it("picks the newest finished assistant message", () => {
    const entries = [
      message("old"),
      { kind: "message", message: { id: "u", role: "user", text: "hi" } },
      message("new"),
      message("streaming", { streaming: true }),
      message("blank", { text: "  " }),
      { kind: "work" },
    ];
    const latest = latestReplyableAssistantMessage(entries);
    expect(latest !== null && "message" in latest ? latest.message.id : null).toBe("new");
    expect(latestReplyableAssistantMessage([{ kind: "work" }])).toBeNull();
  });
});
