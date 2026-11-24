import { describe, expect, it } from "vite-plus/test";

import { extractAgentNotificationDeepLink } from "../agent-awareness/notificationPayload";
import { controlPlanePushData, routeForPushResponse } from "./notificationRouting";
import { notificationRequestData } from "./notificationRequestData";

// What expo-notifications hands JS for a remote push on iOS: `content.data` is
// the payload's `body` key (absent for our pushes, so null) and the full APNs
// payload sits on the push trigger.
function remoteRequest(payload: Record<string, unknown>) {
  return {
    identifier: "remote-1",
    content: { title: "Hometrace: task 1 fix sync", data: null },
    trigger: { type: "push", payload },
  };
}

const SERVER_AGENT_FINISHED = {
  aps: {
    alert: { title: "Hometrace: task 1 fix sync", body: "Finished · Hometrace" },
    sound: "default",
    category: "cp.agent",
    "thread-id": "thread:thread-1",
    "interruption-level": "active",
  },
  cp: {
    cp: 1,
    kind: "agent-finished",
    environmentId: "env-1",
    deepLink: "/threads/env-1/thread-1",
    threadId: "thread-1",
  },
};

describe("notificationRequestData", () => {
  it("reads a server push from the trigger payload when content.data is empty", () => {
    const data = controlPlanePushData(
      notificationRequestData(remoteRequest(SERVER_AGENT_FINISHED)),
    );
    expect(data?.threadId).toBe("thread-1");
    expect(routeForPushResponse(data!, "expo.modules.notifications.actions.DEFAULT")).toEqual({
      kind: "link",
      path: "/threads/env-1/thread-1",
    });
  });

  it("reads a relay agent push's top-level deep link from the trigger payload", () => {
    const response = {
      notification: {
        request: remoteRequest({
          aps: { alert: { title: "Agent", body: "Done" } },
          environmentId: "env-1",
          threadId: "thread-2",
          deepLink: "/threads/env-1/thread-2",
        }),
      },
    };
    expect(extractAgentNotificationDeepLink(response)).toBe("/threads/env-1/thread-2");
  });

  it("does not route a server push twice through the relay handler", () => {
    const response = { notification: { request: remoteRequest(SERVER_AGENT_FINISHED) } };
    expect(extractAgentNotificationDeepLink(response)).toBeNull();
  });

  it("keeps a local notification's content.data", () => {
    const request = {
      content: { data: { cp: SERVER_AGENT_FINISHED.cp } },
      trigger: { type: "timeInterval", seconds: 3600 },
    };
    expect(notificationRequestData(request)).toEqual({ cp: SERVER_AGENT_FINISHED.cp });
  });

  it("returns null when neither place has data", () => {
    expect(notificationRequestData({ content: { data: {} }, trigger: null })).toBeNull();
    expect(notificationRequestData(null)).toBeNull();
  });
});
