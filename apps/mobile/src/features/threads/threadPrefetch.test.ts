import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { createPrefetchQueue, type PrefetchTarget, selectPrefetchTargets } from "./threadPrefetch";

const MACBOOK = EnvironmentId.make("macbook");
const MINI = EnvironmentId.make("mini");
const NOW = Date.parse("2026-11-24T12:00:00.000Z");

function thread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId: MACBOOK,
    updatedAt: "2026-11-24T10:00:00.000Z",
    archivedAt: null,
    settledAt: null,
    snoozedUntil: null,
    pinnedAt: null,
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

const ids = (targets: ReadonlyArray<PrefetchTarget>) => targets.map((target) => target.threadId);

describe("selectPrefetchTargets", () => {
  const connected = new Set([MACBOOK, MINI]);

  it("orders waiting and running threads, then pinned, then recently opened, then activity", () => {
    const targets = selectPrefetchTargets({
      threads: [
        thread("recent-activity", { updatedAt: "2026-11-24T11:59:00.000Z" }),
        thread("visited"),
        thread("pinned", { pinnedAt: "2026-11-20T00:00:00.000Z" }),
        thread("approval", { hasPendingApprovals: true }),
        thread("running", { session: { status: "running" } as EnvironmentThreadShell["session"] }),
      ],
      lastVisitedAtByKey: {
        [scopedThreadKey(MACBOOK, ThreadId.make("visited"))]: "2026-11-24T11:00:00.000Z",
      },
      connectedEnvironmentIds: connected,
      nowMs: NOW,
    });
    expect(ids(targets)).toEqual(["approval", "running", "pinned", "visited", "recent-activity"]);
  });

  it("leaves archived, settled, snoozed and disconnected threads cold", () => {
    const targets = selectPrefetchTargets({
      threads: [
        thread("archived", { archivedAt: "2026-11-23T00:00:00.000Z" }),
        thread("settled", { settledAt: "2026-11-23T00:00:00.000Z" }),
        thread("snoozed", { snoozedUntil: "2026-11-25T00:00:00.000Z" }),
        thread("snooze-over", { snoozedUntil: "2026-11-24T00:00:00.000Z" }),
        thread("offline", { environmentId: EnvironmentId.make("offline") }),
      ],
      lastVisitedAtByKey: {},
      connectedEnvironmentIds: connected,
      nowMs: NOW,
    });
    expect(ids(targets)).toEqual(["snooze-over"]);
  });

  it("caps the list and lists each thread once", () => {
    const threads = Array.from({ length: 20 }, (_, index) =>
      thread(`t${index}`, { pinnedAt: index < 3 ? "2026-11-20T00:00:00.000Z" : null }),
    );
    const targets = selectPrefetchTargets({
      threads,
      lastVisitedAtByKey: {},
      connectedEnvironmentIds: connected,
      nowMs: NOW,
      limit: 5,
    });
    expect(targets).toHaveLength(5);
    expect(new Set(ids(targets)).size).toBe(5);
  });
});

describe("createPrefetchQueue", () => {
  const target = (id: string): PrefetchTarget => ({
    environmentId: MACBOOK,
    threadId: ThreadId.make(id),
  });

  it("runs at most `concurrency` warms, puts pushes first and skips threads already warming", async () => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const queue = createPrefetchQueue(
      {
        warm: (next) =>
          new Promise<void>((resolve) => {
            started.push(next.threadId);
            releases.set(next.threadId, resolve);
          }),
      },
      2,
    );

    queue.enqueue([target("a"), target("b"), target("c")]);
    queue.enqueue([target("push")], { front: true });
    queue.enqueue([target("a")]);
    expect(started).toEqual(["a", "b"]);
    expect(queue.pending).toBe(4);

    releases.get("a")!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["a", "b", "push"]);
  });
});
