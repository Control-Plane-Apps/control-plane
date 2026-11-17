import { describe, expect, it } from "vite-plus/test";

import {
  parseStatusReply,
  statusReplyText,
  STATUS_RECOMMENDATION_BODY_PREFIX,
} from "./projectStatus.ts";
import {
  parseQuoteReply,
  QUOTE_REPLY_ASSISTANT_LABEL,
  QUOTE_REPLY_EXCERPT_MAX_CHARS,
  QUOTE_REPLY_SELF_LABEL,
  quoteReplyFirstLine,
  quoteReplyForProvider,
  quoteReplyText,
  stripQuoteReplyHeader,
} from "./quoteReply.ts";

const ref = {
  messageId: "assistant:item-42",
  label: QUOTE_REPLY_ASSISTANT_LABEL,
  text: "Ship the migration first.",
};

describe("quote reply", () => {
  it("round-trips a reply header and body", () => {
    const text = quoteReplyText(ref, "Agreed, but after the backup.\n\nThen tell me.");
    expect(text).toBe(
      "> Replying to your earlier message [reply:assistant:item-42]\n> Ship the migration first.\n\nAgreed, but after the backup.\n\nThen tell me.",
    );
    expect(parseQuoteReply(text)).toEqual({
      ...ref,
      body: "Agreed, but after the backup.\n\nThen tell me.",
    });
  });

  it("keeps a multi-line excerpt and a body that is itself a blockquote", () => {
    const text = quoteReplyText(
      { ...ref, label: QUOTE_REPLY_SELF_LABEL, text: "line one\n\n\nline two" },
      "> not part of the quote",
    );
    expect(parseQuoteReply(text)).toEqual({
      messageId: ref.messageId,
      label: QUOTE_REPLY_SELF_LABEL,
      text: "line one\nline two",
      body: "> not part of the quote",
    });
  });

  it("leaves ordinary messages and hand-typed quotes alone", () => {
    expect(parseQuoteReply("hello")).toBeNull();
    expect(parseQuoteReply("> Replying to you\n> x\n\nbody")).toBeNull();
    expect(quoteReplyForProvider("plain [reply text]")).toBe("plain [reply text]");
  });

  it("tolerates a leading Ultrathink line and keeps it on the body", () => {
    const parsed = parseQuoteReply(`Ultrathink:\n${quoteReplyText(ref, "Think hard.")}`);
    expect(parsed?.messageId).toBe(ref.messageId);
    expect(parsed?.body).toBe("Ultrathink:\nThink hard.");
  });

  it("caps excerpts and sanitizes labels", () => {
    const long = "x".repeat(QUOTE_REPLY_EXCERPT_MAX_CHARS + 50);
    const parsed = parseQuoteReply(
      quoteReplyText({ ...ref, label: "Agent [beta]\nname", text: long }, "ok"),
    );
    expect(parsed?.label).toBe("Agent (beta) name");
    expect(parsed?.text.length).toBe(QUOTE_REPLY_EXCERPT_MAX_CHARS);
    expect(parsed?.text.endsWith("…")).toBe(true);
  });

  it("refuses a message id that would break the tag", () => {
    expect(quoteReplyText({ ...ref, messageId: "bad id]" }, "body")).toBe("body");
  });

  it("takes the first meaningful line of a message", () => {
    expect(quoteReplyFirstLine("\n\n## **Plan** for today\nmore")).toBe("Plan for today");
    expect(quoteReplyFirstLine("```\ncode\n```")).toBe("code");
    expect(quoteReplyFirstLine("- `first` item")).toBe("first item");
  });

  it("gives providers the quote without the id tag", () => {
    const text = quoteReplyText(ref, "Do it.");
    expect(quoteReplyForProvider(text)).toBe(
      "> Replying to your earlier message:\n> Ship the migration first.\n\nDo it.",
    );
    expect(stripQuoteReplyHeader(text)).toBe("Do it.");
  });

  it("nests under a Status Re: header without changing Status parsing", () => {
    const text = statusReplyText("Payouts", quoteReplyText(ref, "Pilot it."), {
      statusId: "payouts",
      openedAt: "2026-11-01T00:00:00.000Z",
    });
    const status = parseStatusReply(text);
    expect(status?.title).toBe("Payouts");
    expect(status?.statusId).toBe("payouts");
    expect(status?.body.startsWith(STATUS_RECOMMENDATION_BODY_PREFIX)).toBe(false);
    expect(parseQuoteReply(status!.body)).toEqual({ ...ref, body: "Pilot it." });
    // The provider still sees the Status header first, untouched.
    expect(quoteReplyForProvider(text).startsWith("Re: Payouts [status:payouts@")).toBe(true);
    expect(quoteReplyForProvider(text)).toContain("> Replying to your earlier message:\n");
  });
});
