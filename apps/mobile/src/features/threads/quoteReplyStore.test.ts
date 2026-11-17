import { QUOTE_REPLY_SELF_LABEL } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { clearQuoteReply, readQuoteReply, setQuoteReply } from "./quoteReplyStore";

describe("quoteReplyStore", () => {
  it("holds one quote per thread and clears it", () => {
    const quote = {
      messageId: "msg-9",
      label: QUOTE_REPLY_SELF_LABEL,
      text: "my earlier point",
      displayLabel: "You",
    };
    expect(readQuoteReply("env:a")).toBeNull();
    setQuoteReply("env:a", quote);
    expect(readQuoteReply("env:a")).toEqual(quote);
    expect(readQuoteReply("env:b")).toBeNull();

    const replaced = { ...quote, messageId: "msg-10" };
    setQuoteReply("env:a", replaced);
    expect(readQuoteReply("env:a")).toBe(replaced);

    clearQuoteReply("env:a");
    expect(readQuoteReply("env:a")).toBeNull();
    clearQuoteReply("env:a");
    expect(readQuoteReply("env:a")).toBeNull();
  });
});
