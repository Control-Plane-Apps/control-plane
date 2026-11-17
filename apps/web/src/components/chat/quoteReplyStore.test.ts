import {
  parseQuoteReply,
  parseStatusReply,
  QUOTE_REPLY_ASSISTANT_LABEL,
  QUOTE_REPLY_SELF_LABEL,
  quoteReplyText,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyStatusReplyTag } from "../status/statusReplyStore";
import {
  applyQuoteReply,
  mergeQuoteReplyState,
  quoteReplyDisplayLabelFromStored,
  quoteReplyDraftFor,
  restoreQuoteReplyPrompts,
  useQuoteReplyStore,
} from "./quoteReplyStore";

describe("quote reply drafts", () => {
  it("quotes an assistant message's first line", () => {
    const draft = quoteReplyDraftFor({
      messageId: "assistant-1",
      messageText: "## Three thoughts\n\n1. Ship it\n2. Wait",
      author: { kind: "assistant", displayLabel: "Coordinator" },
    });
    expect(draft).toEqual({
      messageId: "assistant-1",
      label: QUOTE_REPLY_ASSISTANT_LABEL,
      displayLabel: "Coordinator",
      text: "Three thoughts",
      excerpt: false,
    });
  });

  it("quotes a selected excerpt instead of the first line", () => {
    const draft = quoteReplyDraftFor({
      messageId: "assistant-1",
      messageText: "First line\nSecond thought here",
      author: { kind: "assistant", displayLabel: "Assistant" },
      excerpt: "  Second thought  ",
    });
    expect(draft?.text).toBe("Second thought");
    expect(draft?.excerpt).toBe(true);
  });

  it("quotes the user's own message body, not its reply headers", () => {
    const own = applyStatusReplyTag(
      quoteReplyText({ messageId: "a", label: QUOTE_REPLY_ASSISTANT_LABEL, text: "x" }, "My point"),
      { title: "Payouts", statusId: "payouts" },
    );
    const draft = quoteReplyDraftFor({
      messageId: "user-1",
      messageText: own,
      author: { kind: "self" },
    });
    expect(draft).toMatchObject({
      label: QUOTE_REPLY_SELF_LABEL,
      displayLabel: "You",
      text: "My point",
    });
  });

  it("names an agent's message", () => {
    const draft = quoteReplyDraftFor({
      messageId: "agent-1",
      messageText: "Done with the migration.",
      author: { kind: "agent", name: "Ada" },
    });
    expect(draft).toMatchObject({ label: "Ada's message", displayLabel: "Ada" });
    expect(quoteReplyDisplayLabelFromStored("Ada's message", "Assistant")).toBe("Ada");
    expect(quoteReplyDisplayLabelFromStored(QUOTE_REPLY_SELF_LABEL, "Assistant")).toBe("You");
    expect(quoteReplyDisplayLabelFromStored(QUOTE_REPLY_ASSISTANT_LABEL, "Coordinator")).toBe(
      "Coordinator",
    );
  });

  it("returns null when there is nothing to quote", () => {
    expect(
      quoteReplyDraftFor({ messageId: "a", messageText: "  \n ", author: { kind: "self" } }),
    ).toBeNull();
  });
});

describe("composing a reply", () => {
  const draft = {
    messageId: "assistant-9",
    label: QUOTE_REPLY_ASSISTANT_LABEL,
    displayLabel: "Coordinator",
    text: "Pick a payout schedule",
    excerpt: false,
  };

  it("leaves text alone without a draft", () => {
    expect(applyQuoteReply("hello", null)).toBe("hello");
  });

  it("puts the Status Re: header outermost so Status parsing is unchanged", () => {
    const text = applyStatusReplyTag(applyQuoteReply("Weekly.", draft), {
      title: "Payouts",
      statusId: "payouts",
      openedAt: "2026-11-01T00:00:00.000Z",
    });
    const status = parseStatusReply(text);
    expect(status).toMatchObject({ title: "Payouts", statusId: "payouts" });
    expect(parseQuoteReply(status!.body)).toMatchObject({
      messageId: "assistant-9",
      text: "Pick a payout schedule",
      body: "Weekly.",
    });
  });

  it("gives a queued reply's quote back as the chip and strips matching headers", () => {
    const queued = [applyQuoteReply("one", draft), applyQuoteReply("two", draft), "three"];
    const restored = restoreQuoteReplyPrompts(queued, null, () => "Coordinator");
    expect(restored.prompts).toEqual(["one", "two", "three"]);
    expect(restored.draft).toMatchObject({ messageId: "assistant-9", displayLabel: "Coordinator" });
  });

  it("keeps a different quote in the text when a reply is already live", () => {
    const other = applyQuoteReply("two", { ...draft, messageId: "assistant-10" });
    const restored = restoreQuoteReplyPrompts(
      [applyQuoteReply("one", draft), other],
      draft,
      () => "Coordinator",
    );
    expect(restored.prompts).toEqual(["one", other]);
    expect(restored.draft).toBeNull();
  });
});

describe("quote reply store", () => {
  it("sets and clears per thread", () => {
    const store = useQuoteReplyStore.getState();
    const draft = {
      messageId: "m",
      label: QUOTE_REPLY_SELF_LABEL,
      displayLabel: "You",
      text: "x",
      excerpt: false,
    };
    store.setDraft("thread-a", draft);
    expect(useQuoteReplyStore.getState().draftsByThreadKey["thread-a"]).toEqual(draft);
    useQuoteReplyStore.getState().clearDraft("thread-a");
    expect(useQuoteReplyStore.getState().draftsByThreadKey["thread-a"]).toBeUndefined();
  });

  it("drops malformed persisted drafts", () => {
    const merged = mergeQuoteReplyState(
      {
        draftsByThreadKey: {
          good: { messageId: "m", label: "l", displayLabel: "d", text: "t", excerpt: true },
          bad: { messageId: 4 },
          worse: "nope",
        },
      },
      useQuoteReplyStore.getState(),
    );
    expect(Object.keys(merged.draftsByThreadKey)).toEqual(["good"]);
  });
});
