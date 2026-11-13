import { describe, expect, it, vi } from "vite-plus/test";

import type { SavedRemoteConnection } from "../../lib/connection";
import { controlPlanePushData, routeForPushResponse } from "./notificationRouting";
import {
  canRegisterPushWith,
  pushRegistrationBody,
  registerPushWithEnvironment,
} from "./pushRegistration";

const DEFAULT = "expo.modules.notifications.actions.DEFAULT";

const question = {
  cp: 1,
  kind: "status-question",
  environmentId: "env-1",
  threadId: "thread-coordinator",
  projectId: "project-1",
  statusId: "payments-retry",
  statusTitle: "Payments retry",
  openedAt: "2026-11-13T16:40:00.000Z",
  answerLabel: "Retry 3 times",
} as const;

const connection = {
  environmentId: "env-1",
  environmentLabel: "Mac",
  pairingUrl: "",
  displayUrl: "",
  httpBaseUrl: "http://mac.tailnet.ts.net:3773/",
  wsBaseUrl: "ws://mac.tailnet.ts.net:3773/",
  bearerToken: "session",
} as unknown as SavedRemoteConnection;

describe("Control Plane push routing", () => {
  it("reads our payload nested under cp, and ignores anything else", () => {
    expect(controlPlanePushData({ cp: question, aps: {} })?.statusId).toBe("payments-retry");
    expect(controlPlanePushData({ deepLink: "/threads/a/b" })).toBeNull();
    expect(controlPlanePushData({ cp: { ...question, kind: "other" } })).toBeNull();
  });

  it("Reply opens the coordinator composer with the Re: chip for that question version", () => {
    expect(routeForPushResponse(question, "cp.reply")).toEqual({
      kind: "reply",
      path: "/threads/env-1/thread-coordinator",
      environmentId: "env-1",
      threadId: "thread-coordinator",
      tag: {
        title: "Payments retry",
        statusId: "payments-retry",
        openedAt: "2026-11-13T16:40:00.000Z",
      },
    });
  });

  it("a tap on a question opens Status; background actions do nothing in JS", () => {
    expect(routeForPushResponse(question, DEFAULT)).toEqual({
      kind: "link",
      path: "/projects/env-1/project-1/status",
    });
    expect(routeForPushResponse(question, "cp.answer")).toEqual({ kind: "none" });
    expect(routeForPushResponse(question, "cp.snooze")).toEqual({ kind: "none" });
  });

  it("opens the thread for other notifications and Tasks for a reminder", () => {
    expect(
      routeForPushResponse(
        { cp: 1, kind: "agent-finished", environmentId: "env-1", threadId: "t-9" },
        DEFAULT,
      ),
    ).toEqual({ kind: "link", path: "/threads/env-1/t-9" });
    expect(
      routeForPushResponse(
        { cp: 1, kind: "task-reminder", environmentId: "env-1", taskId: "task-1" },
        DEFAULT,
      ),
    ).toEqual({ kind: "link", path: "/tasks" });
  });
});

describe("Control Plane push registration", () => {
  it("registers bearer connections with the URL the phone reaches the Mac at", () => {
    expect(canRegisterPushWith(connection)).toBe(true);
    expect(canRegisterPushWith({ ...connection, bearerToken: null })).toBe(false);
    expect(canRegisterPushWith({ ...connection, relayManaged: true })).toBe(false);
    expect(
      pushRegistrationBody(connection, {
        deviceId: "device-1",
        apnsToken: "ab".repeat(32),
        apsEnvironment: "production",
        bundleId: "app.lucive.controlplane",
        level: undefined,
      }),
    ).toEqual({
      deviceId: "device-1",
      apnsToken: "ab".repeat(32),
      apsEnvironment: "production",
      bundleId: "app.lucive.controlplane",
      serverUrl: "http://mac.tailnet.ts.net:3773",
      level: "needs-you",
      enabled: true,
    });
  });

  it("posts to the Mac with the session bearer", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const body = pushRegistrationBody(connection, {
      deviceId: "device-1",
      apnsToken: "ab".repeat(32),
      apsEnvironment: "sandbox",
      bundleId: "app.lucive.controlplane",
      level: "off",
    });
    expect(body.enabled).toBe(false);
    await expect(
      registerPushWithEnvironment(connection, body, fetchImpl as unknown as typeof fetch),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://mac.tailnet.ts.net:3773/api/push/devices",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer session" }),
      }),
    );
  });
});
