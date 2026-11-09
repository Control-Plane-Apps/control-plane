import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  applyStatusReplyTag,
  mergeStatusReplyState,
  useStatusReplyStore,
} from "./statusReplyStore";

describe("statusReplyStore", () => {
  beforeEach(() => useStatusReplyStore.setState({ tagsByThreadKey: {}, pendingDecisions: [] }));

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

  it("holds a recommendation click once until the server marks it answered", () => {
    const store = useStatusReplyStore.getState();
    store.markDecisionPending("env:coordinator-a", "payouts@1");
    store.markDecisionPending("env:coordinator-a", "payouts@1");
    expect(useStatusReplyStore.getState().pendingDecisions).toEqual([
      "env:coordinator-a|payouts@1",
    ]);
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
});
