import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { decideTaskAuthority, setTaskAuthority, withTaskAuthority } from "./taskAuthority.ts";

const mini = { id: "env-mini", label: "Mac mini", hasAssistant: true };
const macbook = { id: "env-macbook", label: "MacBook", hasAssistant: false };

describe("decideTaskAuthority", () => {
  it("keeps every server its own authority when no linked machine hosts the Assistant", () => {
    expect(
      decideTaskAuthority({ selfId: "env-macbook", localAssistant: false, linked: [] }),
    ).toEqual({ authority: true });
    expect(
      decideTaskAuthority({
        selfId: "env-mini",
        localAssistant: true,
        linked: [macbook],
      }),
    ).toEqual({ authority: true });
  });

  it("defers a server without the Assistant to the machine that hosts it", () => {
    expect(
      decideTaskAuthority({ selfId: "env-macbook", localAssistant: false, linked: [mini] }),
    ).toEqual({ authority: false, deferTo: { id: "env-mini", label: "Mac mini" } });
  });

  it("picks exactly one when both host an Assistant: the lower id, on both sides", () => {
    const onMini = decideTaskAuthority({
      selfId: "env-mini",
      localAssistant: true,
      linked: [{ ...macbook, hasAssistant: true }],
    });
    const onMacbook = decideTaskAuthority({
      selfId: "env-macbook",
      localAssistant: true,
      linked: [mini],
    });
    expect([onMini.authority, onMacbook.authority]).toEqual([false, true]);
  });
});

describe("withTaskAuthority", () => {
  afterEach(() => setTaskAuthority({ authority: true }));
  const descriptor = {
    environmentId: "env-macbook",
    capabilities: { tasks: true },
  } as unknown as ExecutionEnvironmentDescriptor;

  it("keeps Tasks but marks them deferred, so clients prefer the authority", () => {
    expect(withTaskAuthority(descriptor).capabilities.tasksDeferred).toBeUndefined();
    setTaskAuthority({ authority: false, deferTo: { id: "env-mini", label: "Mac mini" } });
    expect(withTaskAuthority(descriptor).capabilities).toEqual({
      tasks: true,
      tasksDeferred: true,
    });
  });
});
