import {
  ASSISTANT_ASK_ACTIVITY_KIND,
  ASSISTANT_PING_ACTIVITY_KIND,
  assistantAskIdOf,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadActivity,
  type ProjectStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  askAnswerMessageIds,
  collectAskCards,
  collectMoving,
  collectNeedsYou,
  collectPings,
  withoutGlobalAssistant,
} from "./assistantHome.ts";

const AT = "2026-11-13T09:00:00.000Z";

function project(
  id: string,
  statuses: ProjectStatus[],
  scope?: "global",
): OrchestrationProjectShell {
  return {
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: `/tmp/${id}`,
    assistant: {
      coordinatorThreadId: ThreadId.make(`${id}-coord`),
      ...(scope ? { scope } : {}),
      statuses,
    },
  } as unknown as OrchestrationProjectShell;
}

const question = (id: string, openedAt: string, deadline?: string): ProjectStatus => ({
  id,
  title: id,
  state: "needs-you",
  summary: "s",
  updatedAt: openedAt,
  decision: {
    question: `${id}?`,
    recommendation: "do it",
    openedAt,
    ...(deadline ? { deadline } : {}),
  },
});

describe("collectNeedsYou", () => {
  it("lists open questions across Projects, deadlines first, skipping the Assistant", () => {
    const projects = [
      project("a", [question("late", "2026-11-13T08:00:00.000Z")]),
      project("b", [question("due", "2026-11-12T08:00:00.000Z", "2026-11-14T00:00:00.000Z")]),
      project("assistant", [question("own", AT)], "global"),
    ];
    expect(collectNeedsYou(projects).map((item) => item.status.id)).toEqual(["due", "late"]);
    expect(collectNeedsYou(projects, ["a"]).map((item) => item.status.id)).toEqual(["late"]);
  });

  it("skips answered questions and lists working workstreams separately", () => {
    const answered = question("answered", AT);
    const working: ProjectStatus = {
      id: "w",
      title: "w",
      state: "working",
      summary: "s",
      updatedAt: AT,
    };
    const projects = [
      project("a", [{ ...answered, decision: { ...answered.decision!, answeredAt: AT } }, working]),
    ];
    expect(collectNeedsYou(projects)).toEqual([]);
    expect(collectMoving(projects).map((item) => item.status.id)).toEqual(["w"]);
  });

  it("drops the Assistant from Projects lists", () => {
    expect(
      withoutGlobalAssistant([project("a", []), project("x", [], "global")]).map((p) => p.id),
    ).toEqual(["a"]);
  });
});

describe("collectAskCards", () => {
  const askId = "abc123def456";
  const activity = (kind: string, payload: unknown, id: string): OrchestrationThreadActivity => ({
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: "s",
    payload,
    turnId: null,
    createdAt: AT,
  });
  const activities = [
    activity(
      ASSISTANT_ASK_ACTIVITY_KIND,
      {
        askId,
        question: "What shipped?",
        targets: [
          { projectId: "a", title: "A", coordinatorThreadId: "a-coord" },
          { projectId: "b", title: "B", coordinatorThreadId: "b-coord" },
        ],
      },
      "act-ask",
    ),
    activity(
      ASSISTANT_PING_ACTIVITY_KIND,
      { pingId: "p1", title: "Limit", actions: [{ label: "Pause", reply: "pause" }] },
      "act-ping",
    ),
  ];
  const pushId = `cp-push:a-coord:cp-send:a-coord:ask:${askId}:uuid`;
  const messages = [
    {
      id: MessageId.make(pushId),
      role: "user" as const,
      text: 'Result from agent "A" (threadId a-coord): completed\n\nE-sign shipped.',
      createdAt: AT,
      source: { kind: "agent" as const, threadId: ThreadId.make("a-coord") },
    },
  ];

  it("folds answers into the ask that requested them", () => {
    const [card] = collectAskCards(activities, messages);
    expect(card?.answeredCount).toBe(1);
    expect(card?.targets[0]?.answer?.text).toBe("E-sign shipped.");
    expect(card?.targets[1]?.answer).toBeNull();
    expect([...askAnswerMessageIds([card!])]).toEqual([pushId]);
    expect(assistantAskIdOf(pushId)).toBe(askId);
  });

  it("reads pings", () => {
    expect(collectPings(activities).map((ping) => ping.title)).toEqual(["Limit"]);
  });
});
