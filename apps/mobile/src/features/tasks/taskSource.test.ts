import type { Task, TaskId, TaskPatch } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  cloudTaskSourceActive,
  layerMacFields,
  makeCloudTaskActions,
  MAC_CATCHING_UP_MESSAGE,
  NEEDS_MAC_MESSAGE,
  selectTaskSource,
  splitTaskPatch,
  WAITING_FOR_SYNC_MESSAGE,
  type CloudTaskWriter,
  type MacTaskBridge,
} from "./taskSource";

const AT = "2026-11-20T12:00:00.000Z";

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id: id as TaskId,
    title: `Task ${id}`,
    status: "todo",
    home: { kind: "date", date: "2026-11-20" },
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  };
}

describe("task source selection", () => {
  it("uses the phone's copy from launch when a signed-in account is saved", () => {
    expect(selectTaskSource(cloudTaskSourceActive(null, true))).toBe("cloud");
    expect(selectTaskSource(cloudTaskSourceActive(null, false))).toBe("mac");
  });

  it("stays on the phone's copy while syncing, synced or offline (error)", () => {
    for (const state of ["synced", "syncing", "error"] as const) {
      expect(selectTaskSource(cloudTaskSourceActive({ state }, true))).toBe("cloud");
    }
  });

  it("uses the Mac without Task Sync", () => {
    for (const state of ["signed-out", "unavailable", "coming-soon", "inactive"] as const) {
      expect(selectTaskSource(cloudTaskSourceActive({ state }, true))).toBe("mac");
    }
  });

  it("never depends on the Mac's connection (no switching mid-session)", () => {
    // The selector takes no Mac input at all: connecting or dropping cannot flip it.
    expect(selectTaskSource.length).toBe(1);
    expect(cloudTaskSourceActive.length).toBe(2);
  });
});

describe("layerMacFields", () => {
  it("lays the Mac's links, hand-off and proposal on the phone's records, never its task fields", () => {
    const phone = [task("a", { title: "Phone title", status: "completed" })];
    const mac = [
      task("a", {
        title: "Stale Mac title",
        links: { projectId: "p1" as never },
        handoff: { kind: "coordinator", threadId: "t1" as never, at: AT } as never,
      }),
    ];
    const [layered] = layerMacFields(phone, mac);
    expect(layered).toMatchObject({
      title: "Phone title",
      status: "completed",
      links: { projectId: "p1" },
      handoff: { threadId: "t1" },
    });
  });

  it("adds the Mac's proposals, but not Mac tasks the phone has deleted", () => {
    const proposal = task("p", { proposal: { projectId: "x" as never, proposedAt: AT } as never });
    const deletedOnPhone = task("gone");
    const layered = layerMacFields([task("a")], [proposal, deletedOnPhone]);
    expect(layered.map((t) => t.id)).toEqual(["a", "p"]);
  });
});

describe("splitTaskPatch", () => {
  it("sends links and the completion prompt to the Mac, everything else to the cloud", () => {
    const patch: TaskPatch = {
      title: "New" as never,
      status: "completed",
      links: null,
      completionPromptDismissedAt: AT as never,
    };
    expect(splitTaskPatch(patch)).toEqual({
      cloud: { title: "New", status: "completed" },
      mac: { links: null, completionPromptDismissedAt: AT },
    });
    expect(splitTaskPatch({ status: "todo" }).mac).toBeNull();
    expect(splitTaskPatch({ links: null }).cloud).toBeNull();
  });
});

function fakes(options: { connected?: boolean; macKnows?: boolean; pending?: number } = {}) {
  const phoneIds = new Set<string>(["a"]);
  const cloud: CloudTaskWriter & { calls: string[] } = {
    calls: [],
    has: (id) => phoneIds.has(id),
    create: async (input) => {
      cloud.calls.push(`create:${input.id}`);
      phoneIds.add(input.id);
    },
    patch: async (id, patch) => {
      cloud.calls.push(`patch:${id}:${Object.keys(patch).join(",")}`);
      return true;
    },
    delete: async (id) => {
      cloud.calls.push(`delete:${id}`);
    },
    setIntent: async () => {
      cloud.calls.push("intent");
    },
    syncNow: async () => {
      cloud.calls.push("sync");
      return { pendingChanges: options.pending ?? 0 };
    },
  };
  const macCalls: string[] = [];
  const mac: MacTaskBridge = {
    connected: options.connected ?? true,
    knows: (id) => (options.macKnows ?? true) || id === "p",
    syncNow: async () => {
      macCalls.push("mac-sync");
    },
    waitFor: async () => options.macKnows ?? true,
    update: async (id, patch) => {
      macCalls.push(`mac-update:${id}:${Object.keys(patch).join(",")}`);
      return { ok: true };
    },
    remove: async (id) => {
      macCalls.push(`mac-remove:${id}`);
      return { ok: true };
    },
    respond: async (id, accept) => {
      macCalls.push(`mac-respond:${id}:${accept}`);
      return { ok: true };
    },
    handOff: async (id) => {
      macCalls.push(`mac-handoff:${id}`);
      return { ok: true };
    },
  };
  const alert = vi.fn();
  const actions = makeCloudTaskActions({ cloud, mac, alert, newId: () => "new" as TaskId });
  return { actions, cloud, macCalls, alert };
}

describe("cloud task actions", () => {
  it("writes task fields to the phone's copy only, with the Mac connected or not", async () => {
    for (const connected of [true, false]) {
      const { actions, cloud, macCalls, alert } = fakes({ connected });
      expect(await actions.setCompleted(task("a"), true)).toBe(true);
      expect(await actions.move(task("a"), { kind: "backlog", horizon: null })).toBe(true);
      expect(await actions.create({ title: "x", home: { kind: "date", date: "2026-11-20" } })).toBe(
        "new",
      );
      expect(cloud.calls).toEqual(["patch:a:status", "patch:a:home", "create:new"]);
      expect(macCalls).toEqual([]);
      expect(alert).not.toHaveBeenCalled();
    }
  });

  it("says a hand-off needs the Mac when it is unreachable, without failing silently", async () => {
    const { actions, macCalls, alert } = fakes({ connected: false });
    expect(actions.macReachable).toBe(false);
    expect(await actions.handOff(task("a"), null)).toBe(false);
    expect(await actions.respond(task("p"), true)).toBe(false);
    expect(alert).toHaveBeenCalledTimes(2);
    expect(alert.mock.calls.every(([, message]) => message === NEEDS_MAC_MESSAGE)).toBe(true);
    expect(macCalls).toEqual([]);
  });

  it("pushes the phone's edits and lets the Mac pull before a Mac-only write", async () => {
    const { actions, cloud, macCalls } = fakes();
    expect(await actions.handOff(task("a"), null)).toBe(true);
    expect(cloud.calls[0]).toBe("sync");
    expect(macCalls).toEqual(["mac-sync", "mac-handoff:a"]);
  });

  it("refuses a Mac-only write while the phone still has unsynced edits", async () => {
    const { actions, macCalls, alert } = fakes({ pending: 2 });
    expect(await actions.patch(task("a"), { links: null })).toBe(false);
    expect(alert).toHaveBeenCalledWith(expect.any(String), WAITING_FOR_SYNC_MESSAGE);
    expect(macCalls).toEqual([]);
  });

  it("waits for the Mac to receive a task the phone just made", async () => {
    const { actions, macCalls, alert } = fakes({ macKnows: false });
    expect(await actions.handOff(task("a"), null)).toBe(false);
    expect(alert).toHaveBeenCalledWith(expect.any(String), MAC_CATCHING_UP_MESSAGE);
    expect(macCalls).toEqual(["mac-sync"]);
  });

  it("splits a patch: cloud fields locally, links through the Mac", async () => {
    const { actions, cloud, macCalls } = fakes();
    await actions.patch(task("a"), { title: "t" as never, links: null });
    expect(cloud.calls[0]).toBe("patch:a:title");
    expect(macCalls).toEqual(["mac-sync", "mac-update:a:links"]);
  });

  it("answers proposals through the Mac, then fetches the accepted task", async () => {
    const { actions, macCalls } = fakes();
    expect(await actions.respond(task("p"), true)).toBe(true);
    expect(macCalls[0]).toBe("mac-respond:p:true");
  });

  it("sends writes to a Mac-only proposal to the Mac", async () => {
    const { actions, cloud, macCalls } = fakes();
    await actions.delete(task("p"));
    expect(cloud.calls.filter((call) => call.startsWith("delete"))).toEqual([]);
    expect(macCalls).toEqual(["mac-remove:p"]);
  });
});
