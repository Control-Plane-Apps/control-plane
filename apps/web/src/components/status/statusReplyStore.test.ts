import { parseStatusReply } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  applyStatusReplyTag,
  mergeStatusReplyState,
  restoreStatusReplyPrompts,
  statusReplyTagChanged,
  statusReplyTagFor,
  useStatusReplyStore,
} from "./statusReplyStore";

const OPENED = "2026-11-11T11:00:00.000Z";
const payouts = {
  id: "payouts",
  title: "Payouts",
  decision: { question: "Pilot?", recommendation: "pilot", openedAt: OPENED },
};

describe("statusReplyStore", () => {
  beforeEach(() => useStatusReplyStore.setState({ tagsByThreadKey: {} }));

  it("keeps one Re: tag per thread and clears only that thread's", () => {
    const store = useStatusReplyStore.getState();
    store.setTag("env:coordinator-a", { title: "Payouts", statusId: "payouts" });
    store.setTag("env:coordinator-b", { title: "Navigation copy", statusId: "nav" });
    store.setTag("env:coordinator-a", { title: "Report PDF export", statusId: "pdf" });
    useStatusReplyStore.getState().clearTag("env:coordinator-a");
    expect(useStatusReplyStore.getState().tagsByThreadKey).toEqual({
      "env:coordinator-b": { title: "Navigation copy", statusId: "nav" },
    });
  });

  it("starts a reply with the workstream id and, for a question, its version", () => {
    expect(statusReplyTagFor(payouts)).toEqual({
      title: "Payouts",
      statusId: "payouts",
      openedAt: OPENED,
    });
    expect(statusReplyTagFor({ id: "pdf", title: "Report PDF export" })).toEqual({
      title: "Report PDF export",
      statusId: "pdf",
    });
  });

  it("restores persisted tags, keeps older title-only ones and drops malformed entries", () => {
    const merged = mergeStatusReplyState(
      {
        tagsByThreadKey: {
          "env:a": { title: "Payouts", statusId: "payouts", openedAt: OPENED },
          "env:old": "Navigation copy",
          "env:b": 4,
          "env:c": "  ",
          "env:d": { statusId: "x" },
          "env:e": { title: "PDF", statusId: "pdf", openedAt: "not a date" },
        },
      },
      useStatusReplyStore.getState(),
    );
    expect(merged.tagsByThreadKey).toEqual({
      "env:a": { title: "Payouts", statusId: "payouts", openedAt: OPENED },
      "env:old": { title: "Navigation copy" },
      "env:e": { title: "PDF", statusId: "pdf" },
    });
    expect(
      mergeStatusReplyState("garbage", useStatusReplyStore.getState()).tagsByThreadKey,
    ).toEqual({});
  });

  it("prefixes the composer text with the reference only while a tag is set", () => {
    expect(applyStatusReplyTag("Pilot with three.", null)).toBe("Pilot with three.");
    expect(applyStatusReplyTag("Pilot with three.", { title: "Payouts" })).toBe(
      "Re: Payouts\n\nPilot with three.",
    );
    const text = applyStatusReplyTag("Pilot with three.", statusReplyTagFor(payouts));
    expect(text).toBe(`Re: Payouts [status:payouts@${Date.parse(OPENED)}]\n\nPilot with three.`);
    expect(parseStatusReply(text)).toMatchObject({
      title: "Payouts",
      statusId: "payouts",
      revision: Date.parse(OPENED),
      body: "Pilot with three.",
    });
  });

  it("turns a restored queued reply back into the same tag instead of a second header", () => {
    const queued = applyStatusReplyTag("Pilot with three.", statusReplyTagFor(payouts));
    const restored = restoreStatusReplyPrompts([queued, "And ship it."], null);
    expect(restored).toEqual({
      prompts: ["Pilot with three.", "And ship it."],
      tag: { title: "Payouts", statusId: "payouts", openedAt: OPENED },
    });
    // The rebuilt tag sends exactly what was queued.
    expect(applyStatusReplyTag("Pilot with three.", restored.tag)).toBe(queued);
    // A live tag stays; the restored body joins without its header.
    expect(restoreStatusReplyPrompts([queued], { title: "Navigation copy" })).toEqual({
      prompts: ["Pilot with three."],
      tag: null,
    });
    expect(restoreStatusReplyPrompts(["Re: Payouts\n\nOld style."], null).tag).toEqual({
      title: "Payouts",
    });
    expect(restoreStatusReplyPrompts(["Plain text."], null)).toEqual({
      prompts: ["Plain text."],
      tag: null,
    });
  });

  it("flags a tag whose question has since changed", () => {
    const tag = statusReplyTagFor(payouts);
    expect(statusReplyTagChanged(tag, [payouts])).toBe(false);
    const reworded = {
      ...payouts,
      decision: { ...payouts.decision, openedAt: "2026-11-11T11:30:00.000Z" },
    };
    expect(statusReplyTagChanged(tag, [reworded])).toBe(true);
    expect(statusReplyTagChanged(tag, [{ id: "payouts" }])).toBe(true);
    // No version to compare, or the workstream is gone: nothing to say.
    expect(statusReplyTagChanged({ title: "Payouts", statusId: "payouts" }, [reworded])).toBe(
      false,
    );
    expect(statusReplyTagChanged(tag, [])).toBe(false);
  });
});
