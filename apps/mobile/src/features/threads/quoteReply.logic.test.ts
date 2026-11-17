import {
  parseQuoteReply,
  parseStatusReply,
  QUOTE_REPLY_ASSISTANT_LABEL,
  QUOTE_REPLY_SELF_LABEL,
  quoteReplyText,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  composeReplyText,
  findFeedMessage,
  findQuoteScrollTarget,
  messageTextWithoutReplyHeaders,
  quoteReplyAuthorOf,
  quoteReplyDisplayLabelFromLabel,
  quoteReplyLabelsFor,
  wholeMessageQuote,
  withoutQuoteReply,
  withQuoteReply,
  type QuoteReplyDraft,
} from "./quoteReply.logic";

const QUOTE: QuoteReplyDraft = {
  messageId: "msg-1",
  label: QUOTE_REPLY_ASSISTANT_LABEL,
  text: "Tests pass on main.",
  displayLabel: "Assistant",
};

describe("quoteReplyLabelsFor", () => {
  it("labels an assistant message for the model, and names Coordinator in a coordinator thread", () => {
    expect(quoteReplyLabelsFor({ kind: "assistant", coordinator: false })).toEqual({
      label: QUOTE_REPLY_ASSISTANT_LABEL,
      displayLabel: "Assistant",
    });
    expect(quoteReplyLabelsFor({ kind: "assistant", coordinator: true }).displayLabel).toBe(
      "Coordinator",
    );
  });

  it("labels an agent's message by name and the user's own as theirs", () => {
    expect(quoteReplyLabelsFor({ kind: "agent", name: "Payments" })).toEqual({
      label: "Payments's message",
      displayLabel: "Payments",
    });
    expect(quoteReplyLabelsFor({ kind: "self" })).toEqual({
      label: QUOTE_REPLY_SELF_LABEL,
      displayLabel: "You",
    });
  });
});

describe("quoteReplyDisplayLabelFromLabel", () => {
  it("maps stored labels back to an author when the original is not loaded", () => {
    expect(quoteReplyDisplayLabelFromLabel(QUOTE_REPLY_ASSISTANT_LABEL)).toBe("Assistant");
    expect(quoteReplyDisplayLabelFromLabel(QUOTE_REPLY_SELF_LABEL)).toBe("You");
    expect(quoteReplyDisplayLabelFromLabel("Ada's message")).toBe("Ada");
    expect(quoteReplyDisplayLabelFromLabel("something else")).toBe("something else");
  });

  it("round-trips the labels quoteReplyLabelsFor produces", () => {
    for (const author of [
      { kind: "assistant", coordinator: false },
      { kind: "agent", name: "Release notes" },
      { kind: "self" },
    ] as const) {
      const labels = quoteReplyLabelsFor(author);
      expect(quoteReplyDisplayLabelFromLabel(labels.label)).toBe(labels.displayLabel);
    }
  });
});

describe("quoteReplyAuthorOf", () => {
  const base = { agentName: null, coordinatorThread: false } as const;

  it("reads assistant messages as the assistant, or the coordinator", () => {
    expect(
      quoteReplyAuthorOf({ ...base, role: "assistant", presentation: { kind: "default" } }),
    ).toEqual({ kind: "assistant", coordinator: false });
    expect(
      quoteReplyAuthorOf({
        ...base,
        role: "assistant",
        presentation: { kind: "default" },
        coordinatorThread: true,
      }),
    ).toEqual({ kind: "assistant", coordinator: true });
  });

  it("names the agent for attributed, replied and other agent messages", () => {
    expect(
      quoteReplyAuthorOf({
        ...base,
        role: "user",
        presentation: { kind: "replied", displayName: "Payments" },
      }),
    ).toEqual({ kind: "agent", name: "Payments" });
    expect(
      quoteReplyAuthorOf({
        ...base,
        role: "user",
        presentation: { kind: "attributed-user", displayName: "Acme" },
      }),
    ).toEqual({ kind: "agent", name: "Acme" });
    expect(
      quoteReplyAuthorOf({
        ...base,
        role: "user",
        presentation: { kind: "default" },
        agentName: "Docs",
      }),
    ).toEqual({ kind: "agent", name: "Docs" });
  });

  it("reads the user's own and scheduled prompts as the user's", () => {
    expect(
      quoteReplyAuthorOf({ ...base, role: "user", presentation: { kind: "default" } }),
    ).toEqual({ kind: "self" });
    expect(
      quoteReplyAuthorOf({
        ...base,
        role: "user",
        presentation: { kind: "scheduled" },
        agentName: "Nightly",
      }),
    ).toEqual({ kind: "self" });
  });
});

describe("wholeMessageQuote", () => {
  it("quotes the first line of an assistant message", () => {
    expect(
      wholeMessageQuote({
        messageId: "msg-a",
        text: "## Summary\n\nAll **green** now.\nMore detail.",
        author: { kind: "assistant", coordinator: false },
      }),
    ).toEqual({
      messageId: "msg-a",
      text: "Summary",
      label: QUOTE_REPLY_ASSISTANT_LABEL,
      displayLabel: "Assistant",
    });
  });

  it("strips Status and quote headers from the user's own message first", () => {
    const sent = composeReplyText("Ship it today", QUOTE, { title: "Payments retry" });
    const quote = wholeMessageQuote({ messageId: "msg-u", text: sent, author: { kind: "self" } });
    expect(quote.text).toBe("Ship it today");
    expect(quote.label).toBe(QUOTE_REPLY_SELF_LABEL);
    expect(quote.displayLabel).toBe("You");
  });
});

describe("messageTextWithoutReplyHeaders", () => {
  it("leaves plain text alone and removes either header or both", () => {
    expect(messageTextWithoutReplyHeaders("hello")).toBe("hello");
    expect(messageTextWithoutReplyHeaders(quoteReplyText(QUOTE, "body"))).toBe("body");
    expect(
      messageTextWithoutReplyHeaders(composeReplyText("body", QUOTE, { title: "Workstream" })),
    ).toBe("body");
  });
});

describe("composeReplyText", () => {
  it("passes plain text through with neither tag", () => {
    expect(composeReplyText("hi", null, null)).toBe("hi");
  });

  it("wraps the body in the quote header", () => {
    const text = composeReplyText("Yes, do that.", QUOTE, null);
    expect(text).toBe(quoteReplyText(QUOTE, "Yes, do that."));
    expect(parseQuoteReply(text)).toEqual({
      messageId: "msg-1",
      label: QUOTE_REPLY_ASSISTANT_LABEL,
      text: "Tests pass on main.",
      body: "Yes, do that.",
    });
  });

  it("puts the Status header outermost, so Status parsing is unchanged", () => {
    const text = composeReplyText("Yes, do that.", QUOTE, {
      title: "Payments retry",
      statusId: "payments-retry",
    });
    expect(text.startsWith("Re: Payments retry [status:payments-retry]\n\n")).toBe(true);
    const status = parseStatusReply(text);
    expect(status?.title).toBe("Payments retry");
    expect(status?.statusId).toBe("payments-retry");
    expect(status?.body.startsWith("> Replying to your earlier message [reply:msg-1]")).toBe(true);
    expect(parseQuoteReply(status!.body)?.body).toBe("Yes, do that.");
  });

  it("matches a Status-only reply when no quote is set", () => {
    expect(composeReplyText("ok", null, { title: "Docs" })).toBe("Re: Docs\n\nok");
  });
});

describe("findQuoteScrollTarget", () => {
  const message = (id: string, turnId: string | null = null) => ({
    type: "message",
    id,
    message: { id, turnId },
  });
  const presented = [message("a"), { type: "turn-fold", id: "turn-fold:t1" }, message("c", "t1")];
  const full = [message("a"), message("b", "t1"), message("c", "t1")];

  it("finds a presented row by message id", () => {
    expect(
      findQuoteScrollTarget({ messageId: "c", presentedFeed: presented, fullFeed: full }),
    ).toEqual({ kind: "visible", index: 2 });
  });

  it("names the folded turn for a loaded but collapsed message", () => {
    expect(
      findQuoteScrollTarget({ messageId: "b", presentedFeed: presented, fullFeed: full }),
    ).toEqual({ kind: "folded", turnId: "t1" });
  });

  it("reports a message that is not loaded as missing", () => {
    expect(
      findQuoteScrollTarget({ messageId: "zz", presentedFeed: presented, fullFeed: full }),
    ).toEqual({ kind: "missing" });
    expect(
      findQuoteScrollTarget({
        messageId: "x",
        presentedFeed: [],
        fullFeed: [message("x", null)],
      }),
    ).toEqual({ kind: "missing" });
  });

  it("ignores non-message rows that share the id", () => {
    expect(
      findQuoteScrollTarget({
        messageId: "a",
        presentedFeed: [{ type: "activity-group", id: "a" }, message("a")],
        fullFeed: [],
      }),
    ).toEqual({ kind: "visible", index: 1 });
  });
});

describe("findFeedMessage", () => {
  it("returns the message of a message row, else null", () => {
    const feed = [
      { type: "activity-group", id: "m1" },
      { type: "message", id: "m1", message: { id: "m1", turnId: null } },
    ];
    expect(findFeedMessage(feed, "m1")).toEqual({ id: "m1", turnId: null });
    expect(findFeedMessage(feed, "nope")).toBeNull();
  });
});

describe("quote drafts", () => {
  it("sets and clears per thread without touching others", () => {
    const other = { ...QUOTE, messageId: "msg-2" };
    const set = withQuoteReply(withQuoteReply({}, "env:t1", QUOTE), "env:t2", other);
    expect(set).toEqual({ "env:t1": QUOTE, "env:t2": other });
    const cleared = withoutQuoteReply(set, "env:t1");
    expect(cleared).toEqual({ "env:t2": other });
  });

  it("returns the same record when clearing a thread without a quote", () => {
    const drafts = { "env:t1": QUOTE };
    expect(withoutQuoteReply(drafts, "env:none")).toBe(drafts);
  });
});
