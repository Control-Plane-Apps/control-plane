import { parseStatusReply } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  applyStatusReplyTag,
  mergeStatusReplyState,
  restoreStatusReplyPrompts,
  statusReplyTagDrift,
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

  const nav = {
    id: "nav",
    title: "Navigation copy",
    decision: { question: "Rename?", recommendation: "keep", openedAt: "2026-11-11T10:00:00.000Z" },
  };

  it("turns a restored queued reply back into the same tag instead of a second header", () => {
    const queued = applyStatusReplyTag("Pilot with three.", statusReplyTagFor(payouts));
    const restored = restoreStatusReplyPrompts([queued], null, true);
    expect(restored).toEqual({
      prompts: ["Pilot with three."],
      tag: { title: "Payouts", statusId: "payouts", openedAt: OPENED },
    });
    // The rebuilt tag sends exactly what was queued.
    expect(applyStatusReplyTag("Pilot with three.", restored.tag)).toBe(queued);
    expect(restoreStatusReplyPrompts(["Re: Payouts\n\nOld style."], null, true).tag).toEqual({
      title: "Payouts",
    });
  });

  it("strips only the header the live tag already carries", () => {
    const payoutsReply = applyStatusReplyTag("Pilot with three.", statusReplyTagFor(payouts));
    const navReply = applyStatusReplyTag("Keep it.", statusReplyTagFor(nav));
    expect(
      restoreStatusReplyPrompts([payoutsReply, navReply], statusReplyTagFor(payouts), true),
    ).toEqual({ prompts: ["Pilot with three.", navReply], tag: null });
  });

  it("adopts no tag when restored replies are mixed or a draft is already there", () => {
    const payoutsReply = applyStatusReplyTag("Pilot with three.", statusReplyTagFor(payouts));
    const navReply = applyStatusReplyTag("Keep it.", statusReplyTagFor(nav));
    // Two workstreams: each keeps its own header.
    expect(restoreStatusReplyPrompts([payoutsReply, navReply], null, true)).toEqual({
      prompts: [payoutsReply, navReply],
      tag: null,
    });
    // A tagged reply next to plain text would pull that text under the tag.
    expect(restoreStatusReplyPrompts([payoutsReply, "Also ship it."], null, true)).toEqual({
      prompts: [payoutsReply, "Also ship it."],
      tag: null,
    });
    // An untagged draft in the composer must not end up under a restored tag.
    expect(restoreStatusReplyPrompts([payoutsReply], null, false)).toEqual({
      prompts: [payoutsReply],
      tag: null,
    });
    // The same question twice is still one tag.
    expect(
      restoreStatusReplyPrompts(
        [payoutsReply, applyStatusReplyTag("And go.", statusReplyTagFor(payouts))],
        null,
        true,
      ),
    ).toEqual({
      prompts: ["Pilot with three.", "And go."],
      tag: { title: "Payouts", statusId: "payouts", openedAt: OPENED },
    });
    expect(restoreStatusReplyPrompts(["Plain text."], null, true)).toEqual({
      prompts: ["Plain text."],
      tag: null,
    });
  });

  it("says when a tag's workstream left the board or its question changed", () => {
    const tag = statusReplyTagFor(payouts);
    expect(statusReplyTagDrift(tag, [payouts])).toBeNull();
    // Same instant written differently is the same version.
    expect(
      statusReplyTagDrift(tag, [
        { ...payouts, decision: { ...payouts.decision, openedAt: "2026-11-11T11:00:00Z" } },
      ]),
    ).toBeNull();
    const reworded = {
      ...payouts,
      decision: { ...payouts.decision, openedAt: "2026-11-11T11:30:00.000Z" },
    };
    expect(statusReplyTagDrift(tag, [reworded])).toBe("changed");
    expect(statusReplyTagDrift(tag, [{ id: "payouts" }])).toBe("changed");
    expect(statusReplyTagDrift(tag, [nav])).toBe("removed");
    expect(statusReplyTagDrift({ title: "Payouts", statusId: "payouts" }, [reworded])).toBeNull();
    expect(statusReplyTagDrift({ title: "Payouts" }, [])).toBeNull();
  });
});
