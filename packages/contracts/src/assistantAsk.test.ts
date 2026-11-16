import { describe, expect, it } from "vite-plus/test";

import { ASSISTANT_ASK_TITLE_MAX, assistantAskTitle } from "./assistantAsk.ts";

describe("assistantAskTitle", () => {
  it("uses the Assistant's own title, without paths or URLs", () => {
    expect(assistantAskTitle("anything", "Collapsible Assistant panel")).toBe(
      "Collapsible Assistant panel",
    );
    expect(assistantAskTitle("anything", "Review /Users/n/a.png now")).toBe("Review now");
  });

  it("falls back to the question's subject, never a file path", () => {
    const title = assistantAskTitle(
      "From Nick, with a screenshot at /Users/nickrroberts/.t3/userdata/attachments/9491.png: I should be able to collapse the status panel. More detail.",
    );
    expect(title).not.toContain("/");
    expect(title.startsWith("I should be able to collapse")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(ASSISTANT_ASK_TITLE_MAX);
    expect(assistantAskTitle("Is https://x.dev/a ready? Then ship.")).toBe("Is ready?");
    expect(assistantAskTitle("Ship apps/web/src/Foo.tsx today")).toBe("Ship today");
    expect(assistantAskTitle("How close is the release?")).toBe("How close is the release?");
  });

  it("never returns an empty title", () => {
    expect(assistantAskTitle("/Users/n/a.png")).toBe("Question");
    expect(assistantAskTitle("q", "  ")).toBe("Q");
  });
});
