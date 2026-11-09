import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  applyStatusReplyTag,
  mergeStatusReplyState,
  restoreStatusReplyPrompts,
  useStatusReplyStore,
} from "./statusReplyStore";

describe("statusReplyStore", () => {
  beforeEach(() => useStatusReplyStore.setState({ tagsByThreadKey: {} }));

  it("keeps one Re: tag per thread and clears only that thread's", () => {
    const store = useStatusReplyStore.getState();
    store.setTag("env:coordinator-a", "Payouts");
    store.setTag("env:coordinator-b", "Navigation copy");
    store.setTag("env:coordinator-a", "Report PDF export");
    useStatusReplyStore.getState().clearTag("env:coordinator-a");
    expect(useStatusReplyStore.getState().tagsByThreadKey).toEqual({
      "env:coordinator-b": "Navigation copy",
    });
  });

  it("restores a persisted tag after reload and drops malformed entries", () => {
    const merged = mergeStatusReplyState(
      {
        tagsByThreadKey: { "env:a": "Payouts", "env:b": 4, "env:c": "  " },
      },
      useStatusReplyStore.getState(),
    );
    expect(merged.tagsByThreadKey).toEqual({ "env:a": "Payouts" });
    expect(
      mergeStatusReplyState("garbage", useStatusReplyStore.getState()).tagsByThreadKey,
    ).toEqual({});
  });

  it("prefixes the composer text only while a tag is set", () => {
    expect(applyStatusReplyTag("Pilot with three.", null)).toBe("Pilot with three.");
    expect(applyStatusReplyTag("Pilot with three.", "Payouts")).toBe(
      "Re: Payouts\n\nPilot with three.",
    );
  });

  it("turns a restored queued reply back into a tag instead of a second header", () => {
    expect(
      restoreStatusReplyPrompts(["Re: Payouts\n\nPilot with three.", "And ship it."], null),
    ).toEqual({ prompts: ["Pilot with three.", "And ship it."], tag: "Payouts" });
    // A live tag stays; the restored body joins without its header.
    expect(
      restoreStatusReplyPrompts(["Re: Payouts\n\nPilot with three."], "Navigation copy"),
    ).toEqual({ prompts: ["Pilot with three."], tag: null });
    expect(restoreStatusReplyPrompts(["Plain text."], null)).toEqual({
      prompts: ["Plain text."],
      tag: null,
    });
  });
});
