import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import {
  presentDiscoveredMachine,
  presentSavedCloudEnvironmentConnection,
} from "./cloudEnvironmentConnectionPresentation";

function connection(
  phase: EnvironmentConnectionPresentation["phase"],
  error: string | null = null,
): EnvironmentConnectionPresentation {
  return { phase, error, traceId: null };
}

describe("saved cloud environment connection presentation", () => {
  it("only labels a live connection as connected", () => {
    expect(presentSavedCloudEnvironmentConnection(connection("connected"))).toEqual({
      buttonLabel: "Connected",
      statusText: "Connected",
      tone: "connected",
    });

    expect(presentSavedCloudEnvironmentConnection(connection("connecting"))).toEqual({
      buttonLabel: "Connecting…",
      statusText: "Connecting...",
      tone: "connecting",
    });
  });

  it("surfaces a failed attempt while the supervisor reconnects", () => {
    expect(
      presentSavedCloudEnvironmentConnection(
        connection("reconnecting", "Relay environment endpoint is unavailable."),
      ),
    ).toEqual({
      buttonLabel: "Reconnecting…",
      statusText:
        "Failed to connect. Reconnecting... Reason: Relay environment endpoint is unavailable.",
      tone: "connecting",
    });
  });

  it.each([
    ["error", "Connection failed", "Connection failed. Reason: Access denied.", "error"],
    ["unsupported", "Client not supported", "Client not supported", "idle"],
    ["offline", "Offline", "Offline", "idle"],
    ["available", "Not connected", "Available", "idle"],
  ] as const)(
    "presents %s without claiming the environment is connected",
    (phase, buttonLabel, statusText, tone) => {
      expect(
        presentSavedCloudEnvironmentConnection(
          connection(phase, phase === "error" ? "Access denied." : null),
        ),
      ).toEqual({ buttonLabel, statusText, tone });
    },
  );
});

describe("presentDiscoveredMachine", () => {
  const now = new Date("2026-11-16T20:00:00.000Z");
  const linkedAt = "2026-11-12T18:00:00.000Z";

  it("reports an online machine with when the relay saw it", () => {
    expect(
      presentDiscoveredMachine({
        availability: "online",
        checkedAt: "2026-11-16T19:55:00.000Z",
        linkedAt,
        now,
      }),
    ).toEqual({ reachability: "Online", lastSeen: "Seen 5m ago" });
    expect(
      presentDiscoveredMachine({
        availability: "online",
        checkedAt: "2026-11-16T19:59:50.000Z",
        linkedAt,
        now,
      }).lastSeen,
    ).toBe("Seen just now");
  });

  it("falls back to the link date when the machine is not reachable", () => {
    const offline = presentDiscoveredMachine({
      availability: "offline",
      checkedAt: "2026-11-16T19:55:00.000Z",
      linkedAt,
      now,
    });
    expect(offline.reachability).toBe("Offline");
    expect(offline.lastSeen).toMatch(/^Not seen recently · linked /);
    expect(
      presentDiscoveredMachine({ availability: "error", checkedAt: null, linkedAt, now })
        .reachability,
    ).toBe("Unreachable");
    expect(
      presentDiscoveredMachine({ availability: "checking", checkedAt: null, linkedAt: "?", now }),
    ).toEqual({ reachability: "Checking…", lastSeen: "Not seen recently" });
  });
});
