import type { AssistantAskCard } from "@t3tools/client-runtime/state/assistant-home";
import { EnvironmentId, parseStatusReply } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  anchorAskCards,
  latestAssistantBrief,
  needsYouAnswerLabel,
  needsYouKey,
  needsYouPillText,
  pickAssistantEnvironment,
  recommendationReplyText,
  statusReplyDraft,
  withoutAnsweredMessages,
  withoutAskActivities,
} from "./assistantScreen.logic";

const status = { id: "payments-retry", title: "Payments retry" };
const decision = {
  recommendation: "Retry declined cards 3 times over 5 days.",
  openedAt: "2026-11-13T09:00:00.000Z",
};

describe("needsYouAnswerLabel", () => {
  it("uses the short answer, else the generic label", () => {
    expect(needsYouAnswerLabel({ answer: "Retry 3 times" })).toBe("Retry 3 times");
    expect(needsYouAnswerLabel({})).toBe("Go with recommendation");
  });
});

describe("recommendationReplyText", () => {
  it("sends the web's tagged Re: header with the recommendation", () => {
    const text = recommendationReplyText(status, decision);
    expect(text).toBe(
      `Re: Payments retry [status:payments-retry@${Date.parse(decision.openedAt)}]\n\nGo with your recommendation: Retry declined cards 3 times over 5 days.`,
    );
    expect(parseStatusReply(text)).toMatchObject({
      title: "Payments retry",
      statusId: "payments-retry",
      revision: Date.parse(decision.openedAt),
    });
  });

  it("starts a Reply draft with the same header and no body", () => {
    const draft = statusReplyDraft(status, decision);
    expect(parseStatusReply(draft)).toMatchObject({ statusId: "payments-retry", body: "" });
  });

  it("keys one version of one question", () => {
    expect(needsYouKey(status, decision)).toBe(`payments-retry@${Date.parse(decision.openedAt)}`);
  });
});

describe("needsYouPillText", () => {
  const item = (title: string) =>
    ({ project: {}, status: { title } }) as unknown as Parameters<
      typeof needsYouPillText
    >[0][number];

  it("counts and lists the titles", () => {
    expect(needsYouPillText([item("Payments retry"), item("PDF export")])).toEqual({
      count: "2 need you",
      titles: "Payments retry, PDF export",
    });
    expect(needsYouPillText([item("Flaky tests")]).count).toBe("1 needs you");
  });
});

describe("latestAssistantBrief", () => {
  const projectId = "assistant-project";
  const prompt = (id: string) => ({
    id,
    role: "user",
    text: "Write my morning brief.",
    createdAt: "2026-11-13T07:00:00.000Z",
  });

  it("reads the first line of the reply to the newest brief prompt", () => {
    const brief = latestAssistantBrief(
      [
        prompt(`cp-schedule:${projectId}:morning-brief:2026-11-12T07:00:00.000Z`),
        { id: "a1", role: "assistant", text: "Old brief", createdAt: "2026-11-12T07:01:00.000Z" },
        { id: "u1", role: "user", text: "Thanks", createdAt: "2026-11-12T08:00:00.000Z" },
        prompt(`cp-schedule:${projectId}:morning-brief:2026-11-13T07:00:00.000Z`),
        {
          id: "a2",
          role: "assistant",
          text: "\n2 calls for you, Expo merged, 4 tasks today\n- Payments retry needs you",
          createdAt: "2026-11-13T07:02:00.000Z",
        },
      ],
      projectId,
    );
    expect(brief).toEqual({
      messageId: "a2",
      firstLine: "2 calls for you, Expo merged, 4 tasks today",
      text: "2 calls for you, Expo merged, 4 tasks today\n- Payments retry needs you",
      createdAt: "2026-11-13T07:02:00.000Z",
    });
  });

  it("ignores other schedules and other Projects", () => {
    expect(
      latestAssistantBrief(
        [
          prompt(`cp-schedule:${projectId}:check-in:2026-11-13T09:00:00.000Z`),
          prompt(`cp-schedule:other:morning-brief:2026-11-13T07:00:00.000Z`),
          { id: "a1", role: "assistant", text: "Nothing new.", createdAt: "x" },
        ],
        projectId,
      ),
    ).toBeNull();
  });

  it("is null while the newest brief has no reply yet", () => {
    expect(
      latestAssistantBrief(
        [prompt(`cp-schedule:${projectId}:morning-brief:2026-11-13T07:00:00.000Z`)],
        projectId,
      ),
    ).toBeNull();
  });
});

describe("anchorAskCards", () => {
  const card = (askId: string, createdAt: string) =>
    ({ askId, createdAt, targets: [], answeredCount: 0 }) as unknown as AssistantAskCard;
  const feed = [
    { id: "u1", type: "message", createdAt: "2026-11-13T09:00:00Z", message: { role: "user" } },
    {
      id: "a1",
      type: "message",
      createdAt: "2026-11-13T09:00:30Z",
      message: { role: "assistant" },
    },
    { id: "w1", type: "activity-group", createdAt: "2026-11-13T09:05:00Z" },
  ];

  it("puts a card under the first assistant reply at or after the ask", () => {
    const anchored = anchorAskCards(feed, [card("ask1", "2026-11-13T09:00:10Z")]);
    expect(anchored.get("a1")?.map((entry) => entry.askId)).toEqual(["ask1"]);
  });

  it("puts a card with no reply yet under the latest reply, never an activity row", () => {
    const anchored = anchorAskCards(feed, [card("ask2", "2026-11-13T09:04:00Z")]);
    expect(anchored.get("a1")?.map((entry) => entry.askId)).toEqual(["ask2"]);
  });

  it("anchors nothing in an empty feed", () => {
    expect(anchorAskCards([], [card("ask1", "x")]).size).toBe(0);
  });
});

describe("withoutAnsweredMessages", () => {
  const feed = [
    { id: "m1", type: "message", message: { id: "m1" } },
    { id: "m2", type: "message", message: { id: "cp-push:x" } },
    { id: "g1", type: "activity-group" },
  ];

  it("hides answers shown in a card and keeps identity when nothing is hidden", () => {
    expect(withoutAnsweredMessages(feed, new Set(["cp-push:x"])).map((entry) => entry.id)).toEqual([
      "m1",
      "g1",
    ]);
    expect(withoutAnsweredMessages(feed, new Set())).toBe(feed);
    expect(withoutAnsweredMessages(feed, new Set(["other"]))).toBe(feed);
  });
});

describe("pickAssistantEnvironment", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const assistantProject = {
    id: "p1",
    environmentId: remote,
    assistant: { coordinatorThreadId: "t1", scope: "global" },
  } as unknown as Parameters<typeof pickAssistantEnvironment>[1][number];

  it("prefers the environment that already hosts the Assistant", () => {
    expect(
      pickAssistantEnvironment(
        [
          { environmentId: local, connected: true, supportsAssistants: true },
          { environmentId: remote, connected: true, supportsAssistants: true },
        ],
        [assistantProject],
      ),
    ).toEqual({ environmentId: remote, project: assistantProject });
  });

  it("falls back to the first connected environment with Projects", () => {
    expect(
      pickAssistantEnvironment(
        [
          { environmentId: local, connected: false, supportsAssistants: true },
          { environmentId: remote, connected: true, supportsAssistants: true },
        ],
        [],
      ),
    ).toEqual({ environmentId: remote, project: null });
  });

  it("is null without a usable environment", () => {
    expect(
      pickAssistantEnvironment(
        [{ environmentId: local, connected: true, supportsAssistants: false }],
        [],
      ),
    ).toBeNull();
  });
});

describe("withoutAskActivities", () => {
  it("drops ask activities, alone or in a group, and empty groups", () => {
    const feed = [
      { id: "x", type: "activity", activity: { id: "ask-act" } },
      { id: "g1", type: "activity-group", activities: [{ id: "ask-act" }, { id: "tool" }] },
      { id: "g2", type: "activity-group", activities: [{ id: "ask-act" }] },
      { id: "m", type: "message" },
    ];
    const kept = withoutAskActivities(feed, new Set(["ask-act"]));
    expect(kept.map((entry) => entry.id)).toEqual(["g1", "m"]);
    expect(kept[0]?.activities?.map((activity) => activity.id)).toEqual(["tool"]);
  });
});
