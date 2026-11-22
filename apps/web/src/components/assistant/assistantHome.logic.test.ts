import type { AssistantHomeMachine, AssistantHomeStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  currentHome,
  LOCAL_HOME,
  moveBlockedReason,
  offlineHomeText,
  pendingMoveText,
  reclaimWarning,
  remoteReachGroups,
  runsOnOptions,
  toggleReach,
} from "./assistantHome.logic";

const machine = (patch: Partial<AssistantHomeMachine>): AssistantHomeMachine => ({
  id: "env-mini",
  label: "Mac mini",
  state: "online",
  hostsAssistant: false,
  linksBack: true,
  projects: [],
  ...patch,
});

const status = (patch: Partial<AssistantHomeStatus>): AssistantHomeStatus => ({
  here: true,
  elsewhere: null,
  conflicts: [],
  machines: [machine({})],
  addresses: [],
  ...patch,
});

describe("Runs on", () => {
  it("offers this machine and linked ones, blocking ones the Assistant cannot move to", () => {
    expect(moveBlockedReason(machine({}))).toBeNull();
    expect(moveBlockedReason(machine({ linksBack: false }))).toContain("link this machine back");
    expect(moveBlockedReason(machine({ state: "offline" }))).toContain("Offline");
    expect(moveBlockedReason(machine({ hostsAssistant: true }))).toContain("already runs");
    expect(
      runsOnOptions(status({}), "MacBook (this machine)").map((option) => [
        option.value,
        option.blocked,
      ]),
    ).toEqual([
      [LOCAL_HOME, null],
      ["env-mini", null],
    ]);
  });

  it("selects where it runs, and never blocks the current home", () => {
    const away = status({
      here: false,
      elsewhere: { id: "env-mini", label: "Mac mini" },
      machines: [machine({ hostsAssistant: true, state: "offline" })],
    });
    expect(currentHome(status({}))).toBe(LOCAL_HOME);
    expect(currentHome(away)).toBe("env-mini");
    expect(runsOnOptions(away, "MacBook")[1]?.blocked).toBeNull();
    expect(currentHome(status({ here: false }))).toBeNull();
  });

  it("says when the Assistant's machine is offline, instead of offering a new one", () => {
    const away = status({
      here: false,
      elsewhere: { id: "env-mini", label: "Mac mini" },
      machines: [machine({ hostsAssistant: true, state: "offline" })],
    });
    expect(offlineHomeText(away)).toBe("Your Assistant runs on Mac mini, which is offline.");
    expect(offlineHomeText(status({}))).toBeNull();
  });
});

describe("a move that has not finished", () => {
  it("says the Assistant is paused until the other machine confirms", () => {
    expect(pendingMoveText(status({}))).toBeNull();
    expect(
      pendingMoveText(
        status({ pendingMove: { label: "Mac mini", startedAt: "2026-11-21T09:00:00.000Z" } }),
      ),
    ).toBe(
      "Moving your Assistant to Mac mini. It is paused until Mac mini confirms, and finishes on its own when it answers.",
    );
  });
});

describe("taking the Assistant back", () => {
  it("is offered only while its machine cannot be reached, with what it costs", () => {
    const away = { here: false, elsewhere: { id: "env-mini", label: "Mac mini" } };
    expect(reclaimWarning(status(away))).toBeNull();
    expect(reclaimWarning(status({ canReclaim: true }))).toBeNull();
    const warning = reclaimWarning(status({ ...away, canReclaim: true }));
    expect(warning).toContain("anything it learned or said on Mac mini since stays there");
    expect(warning).toContain("When Mac mini is back online it pauses its copy");
  });
});

describe("reach on linked machines", () => {
  it("groups linked machines' Projects and toggles them with this machine's", () => {
    const groups = remoteReachGroups(
      status({
        machines: [
          machine({ projects: [{ projectId: "ht", title: "Hometrace" }] }),
          machine({ id: "env-empty", label: "Empty" }),
        ],
      }),
    );
    expect(groups.map((group) => [group.label, group.projects.length])).toEqual([["Mac mini", 1]]);
    const all = ["local-1", "ht"];
    expect(toggleReach(null, all, "ht")).toEqual(["local-1"]);
    expect(toggleReach(["local-1"], all, "ht")).toBeNull();
  });
});
