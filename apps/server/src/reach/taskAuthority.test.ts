import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  ASSISTANT_ANSWER_TTL_MS,
  AUTHORITY_FRESH_MS,
  type AssistantAnswer,
  decideTaskAuthority,
  effectiveRollover,
  hostsAssistant,
  noteAssistantHost,
  knownAssistantHosts,
  onTaskDeferralChange,
  ROLL_CLAIM_TTL_MS,
  rolloverPermit,
  setTaskAuthority,
  setTaskAuthorityLiveState,
  taskListElsewhere,
  taskAuthorityStatus,
  noteRolloverGap,
  ROLLOVER_GAP_WARN_MS,
  UNSTAMPED_ROLLOVER_AT,
  withTaskAuthority,
} from "./taskAuthority.ts";

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
    ).toEqual({
      authority: false,
      deferTo: { id: "env-mini", label: "Mac mini" },
      reason: "assistant",
    });
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

describe("hostsAssistant", () => {
  it("lets a machine that stopped answering count as host for a while, then not", () => {
    const answer = { hosts: true, at: 1_000 };
    expect(hostsAssistant(answer, 1_000 + ASSISTANT_ANSWER_TTL_MS - 1)).toBe(true);
    // A retired machine no longer keeps everyone else from rolling commitments.
    expect(hostsAssistant(answer, 1_000 + ASSISTANT_ANSWER_TTL_MS)).toBe(false);
    expect(hostsAssistant({ hosts: false, at: 1_000 }, 1_000)).toBe(false);
    expect(hostsAssistant(undefined, 1_000)).toBe(false);
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

const ACCOUNT = "acct-nick";

describe("decideTaskAuthority with Task Sync", () => {
  it("never hands authority to the Assistant's server while it is not signed in", () => {
    // The bug: the Assistant moved to an unsynced mini, the synced MacBook deferred.
    const onMacbook = decideTaskAuthority({
      selfId: "env-macbook",
      localAssistant: false,
      selfAccount: ACCOUNT,
      linked: [{ ...mini, account: null }],
    });
    const onMini = decideTaskAuthority({
      selfId: "env-mini",
      localAssistant: true,
      selfAccount: null,
      linked: [{ ...macbook, account: ACCOUNT }],
    });
    expect(onMacbook).toEqual({ authority: true });
    expect(onMini).toEqual({
      authority: false,
      deferTo: { id: "env-macbook", label: "MacBook" },
      reason: "unsynced",
    });
  });

  it("moves authority to the Assistant's server once it is signed in, on both sides", () => {
    const onMacbook = decideTaskAuthority({
      selfId: "env-macbook",
      localAssistant: false,
      selfAccount: ACCOUNT,
      linked: [{ ...mini, account: ACCOUNT }],
    });
    const onMini = decideTaskAuthority({
      selfId: "env-mini",
      localAssistant: true,
      selfAccount: ACCOUNT,
      linked: [{ ...macbook, account: ACCOUNT }],
    });
    expect(onMini).toEqual({ authority: true });
    expect(onMacbook).toMatchObject({ authority: false, reason: "synced" });
  });

  it("picks the lowest id among synced servers when none runs the Assistant", () => {
    const a = decideTaskAuthority({
      selfId: "env-b",
      localAssistant: false,
      selfAccount: ACCOUNT,
      linked: [{ id: "env-a", label: "A", hasAssistant: false, account: ACCOUNT }],
    });
    const b = decideTaskAuthority({
      selfId: "env-a",
      localAssistant: false,
      selfAccount: ACCOUNT,
      linked: [{ id: "env-b", label: "B", hasAssistant: false, account: ACCOUNT }],
    });
    expect([a.authority, b.authority]).toEqual([false, true]);
  });

  it("ignores a server synced to another account", () => {
    expect(
      decideTaskAuthority({
        selfId: "env-macbook",
        localAssistant: false,
        selfAccount: ACCOUNT,
        linked: [{ ...mini, account: "acct-other" }],
      }),
    ).toEqual({ authority: true });
  });

  it("lets an older build that hosts the Assistant keep winning, so only one rolls", () => {
    // A 0.0.92 MacBook hosts the Assistant and rolls by the old rule; the
    // synced mini on this build must defer to it, not roll as well.
    const onMini = decideTaskAuthority({
      selfId: "env-mini",
      localAssistant: false,
      selfAccount: ACCOUNT,
      linked: [{ id: "env-old", label: "Old MacBook", hasAssistant: true }],
    });
    expect(onMini).toMatchObject({ authority: false, deferTo: { id: "env-old" } });
    // An older build that does not host it changes nothing.
    expect(
      decideTaskAuthority({
        selfId: "env-mini",
        localAssistant: false,
        selfAccount: ACCOUNT,
        linked: [{ id: "env-old", label: "Old MacBook", hasAssistant: false }],
      }),
    ).toEqual({ authority: true });
  });
});

describe("effectiveRollover", () => {
  it("takes the latest choice on any synced server", () => {
    expect(
      effectiveRollover({ enabled: false, setAt: "2026-11-23T10:00:00.000Z" }, [
        { enabled: true, setAt: "2026-11-20T10:00:00.000Z" },
      ]),
    ).toBe(false);
    expect(
      effectiveRollover({ enabled: false, setAt: null }, [
        { enabled: true, setAt: "2026-11-20T10:00:00.000Z" },
      ]),
    ).toBe(true);
  });

  it("lets an explicit stamped choice beat an unstamped one, either way round", () => {
    const stampedOff = { enabled: false, setAt: "2026-11-01T00:00:00.000Z" };
    const unstampedOn = { enabled: true, setAt: null };
    expect(effectiveRollover(stampedOff, [unstampedOn])).toBe(false);
    expect(effectiveRollover(unstampedOn, [stampedOff])).toBe(false);
    // A kept unstamped choice is older than any explicit one.
    expect(effectiveRollover({ enabled: true, setAt: UNSTAMPED_ROLLOVER_AT }, [stampedOff])).toBe(
      false,
    );
  });

  it("lets on win a tie, so a setting chosen before stamps existed carries over", () => {
    expect(
      effectiveRollover({ enabled: false, setAt: null }, [{ enabled: true, setAt: null }]),
    ).toBe(true);
    expect(
      effectiveRollover({ enabled: true, setAt: null }, [{ enabled: false, setAt: null }]),
    ).toBe(true);
  });
});

const NOW = 1_800_000_000_000;
const answer = (task: Partial<NonNullable<AssistantAnswer["task"]>> & { at?: number }) =>
  ({
    hosts: false,
    at: task.at ?? NOW,
    task: {
      at: task.at ?? NOW,
      account: ACCOUNT,
      rolls: false,
      rollover: { enabled: true, setAt: null },
      ...task,
    },
  }) satisfies AssistantAnswer;

describe("rolloverPermit (handover)", () => {
  const base = {
    selfAccount: ACCOUNT,
    local: { enabled: false, setAt: null },
    refreshedAt: NOW,
    nowMs: NOW,
  } as const;

  it("rolls on the authority with the account-wide setting, even when its own was off", () => {
    const permit = rolloverPermit({
      ...base,
      decision: { authority: true },
      linked: [{ id: "env-macbook", label: "MacBook", answer: answer({}) }],
    });
    expect(permit).toMatchObject({ enabled: true, rolls: true, stale: false });
  });

  it("waits while the old authority still says it rolls, then takes over", () => {
    const waiting = rolloverPermit({
      ...base,
      decision: { authority: true },
      linked: [{ id: "env-macbook", label: "MacBook", answer: answer({ rolls: true }) }],
    });
    expect(waiting).toMatchObject({
      rolls: false,
      waitingFor: { id: "env-macbook", label: "MacBook" },
    });
    // The old authority stepped down.
    expect(
      rolloverPermit({
        ...base,
        decision: { authority: true },
        linked: [{ id: "env-macbook", label: "MacBook", answer: answer({ rolls: false }) }],
      }).rolls,
    ).toBe(true);
    // Or it went quiet long enough to be asleep: it refreshes before rolling again.
    expect(
      rolloverPermit({
        ...base,
        nowMs: NOW + ROLL_CLAIM_TTL_MS,
        refreshedAt: NOW + ROLL_CLAIM_TTL_MS,
        decision: { authority: true },
        linked: [{ id: "env-macbook", label: "MacBook", answer: answer({ rolls: true }) }],
      }).rolls,
    ).toBe(true);
  });

  it("never rolls on a stale view, as right after waking from sleep", () => {
    const permit = rolloverPermit({
      ...base,
      refreshedAt: NOW - AUTHORITY_FRESH_MS - 1,
      decision: { authority: true },
      linked: [{ id: "env-mini", label: "Mac mini", answer: answer({}) }],
    });
    expect(permit).toMatchObject({ rolls: false, stale: true });
  });

  it("never rolls when not the authority, or with the setting off everywhere", () => {
    expect(
      rolloverPermit({
        ...base,
        decision: { authority: false, deferTo: { id: "env-mini", label: "Mac mini" } },
        linked: [{ id: "env-mini", label: "Mac mini", answer: answer({}) }],
      }).rolls,
    ).toBe(false);
    expect(
      rolloverPermit({
        ...base,
        decision: { authority: true },
        linked: [
          {
            id: "env-mini",
            label: "Mac mini",
            answer: answer({ rollover: { enabled: false, setAt: null } }),
          },
        ],
      }).rolls,
    ).toBe(false);
  });

  it("over a whole Assistant move and sign-in, exactly one server rolls at any step", () => {
    // Each step: what each server knows, then who may roll.
    const permits = (
      macbook: { account: string | null; assistant: boolean; claims: boolean },
      mini: { account: string | null; assistant: boolean; claims: boolean },
    ) => {
      const onMacbook = rolloverPermit({
        ...base,
        selfAccount: macbook.account,
        local: { enabled: true, setAt: null },
        decision: decideTaskAuthority({
          selfId: "env-macbook",
          localAssistant: macbook.assistant,
          selfAccount: macbook.account,
          linked: [
            {
              id: "env-mini",
              label: "Mac mini",
              hasAssistant: mini.assistant,
              account: mini.account,
            },
          ],
        }),
        linked: [
          {
            id: "env-mini",
            label: "Mac mini",
            answer: answer({ account: mini.account, rolls: mini.claims }),
          },
        ],
      });
      const onMini = rolloverPermit({
        ...base,
        selfAccount: mini.account,
        decision: decideTaskAuthority({
          selfId: "env-mini",
          localAssistant: mini.assistant,
          selfAccount: mini.account,
          linked: [
            {
              id: "env-macbook",
              label: "MacBook",
              hasAssistant: macbook.assistant,
              account: macbook.account,
            },
          ],
        }),
        linked: [
          {
            id: "env-macbook",
            label: "MacBook",
            answer: answer({ account: macbook.account, rolls: macbook.claims }),
          },
        ],
      });
      return [onMacbook.rolls, onMini.rolls];
    };
    // Before: Assistant on the MacBook, both synced, MacBook rolls.
    expect(
      permits(
        { account: ACCOUNT, assistant: true, claims: false },
        { account: ACCOUNT, assistant: false, claims: false },
      ),
    ).toEqual([true, false]);
    // Assistant moved to an unsynced mini: the MacBook keeps rolling (the bug: nobody did).
    expect(
      permits(
        { account: ACCOUNT, assistant: false, claims: true },
        { account: null, assistant: true, claims: false },
      ),
    ).toEqual([true, false]);
    // The mini signs in; the MacBook has not looked yet and still claims: the mini waits.
    expect(
      permits(
        { account: ACCOUNT, assistant: false, claims: true },
        { account: ACCOUNT, assistant: true, claims: false },
      )[1],
    ).toBe(false);
    // The MacBook looks again and steps down (it no longer claims); then the mini rolls.
    const [macbookAfter] = permits(
      { account: ACCOUNT, assistant: false, claims: true },
      { account: ACCOUNT, assistant: true, claims: false },
    );
    expect(macbookAfter).toBe(false);
    expect(
      permits(
        { account: ACCOUNT, assistant: false, claims: false },
        { account: ACCOUNT, assistant: true, claims: false },
      ),
    ).toEqual([false, true]);
  });
});

describe("live state", () => {
  afterEach(() => {
    setTaskAuthority({ authority: true });
    setTaskAuthorityLiveState(null);
    (knownAssistantHosts() as Map<string, AssistantAnswer>).clear();
  });

  it("refuses task tools only on an unsynced server whose linked server is synced", () => {
    setTaskAuthority({
      authority: false,
      deferTo: { id: "env-mini", label: "Mac mini" },
      reason: "assistant",
    });
    expect(taskListElsewhere()).toBeNull();
    setTaskAuthority({
      authority: false,
      deferTo: { id: "env-macbook", label: "MacBook" },
      reason: "unsynced",
    });
    expect(taskListElsewhere()).toEqual({ id: "env-macbook", label: "MacBook" });
  });

  it("tells listeners when the server starts or stops deferring", () => {
    let calls = 0;
    const off = onTaskDeferralChange(() => (calls += 1));
    setTaskAuthority({ authority: true });
    setTaskAuthority({ authority: false, deferTo: { id: "env-mini", label: "Mac mini" } });
    setTaskAuthority({ authority: false, deferTo: { id: "env-mini", label: "Mac mini" } });
    setTaskAuthority({ authority: true });
    off();
    expect(calls).toBe(2);
  });

  it("reports the sign-in the Assistant's server needs and warns about a rollover gap", () => {
    noteAssistantHost("env-macbook", answer({ rolls: false }));
    setTaskAuthorityLiveState({
      selfAccount: null,
      localAssistant: true,
      local: { enabled: false, setAt: null },
      machines: [{ id: "env-macbook", label: "MacBook" }],
      refreshedAt: NOW,
    });
    setTaskAuthority({
      authority: false,
      deferTo: { id: "env-macbook", label: "MacBook" },
      reason: "unsynced",
    });
    expect(noteRolloverGap(NOW)).toBeNull();
    expect(noteRolloverGap(NOW + ROLLOVER_GAP_WARN_MS)).toBe(NOW);
    expect(taskAuthorityStatus(NOW + ROLLOVER_GAP_WARN_MS)).toMatchObject({
      authority: false,
      synced: false,
      assistantHere: true,
      signInNeeded: true,
      rolls: false,
      rolloverEnabled: true,
      rolloverGap: true,
      machines: [{ id: "env-macbook", synced: true, rolls: false }],
    });
    // The MacBook rolls again: no gap.
    noteAssistantHost("env-macbook", answer({ rolls: true, at: NOW + ROLLOVER_GAP_WARN_MS }));
    expect(noteRolloverGap(NOW + ROLLOVER_GAP_WARN_MS)).toBeNull();
  });

  it("keeps a machine's task state when an answer without it arrives", () => {
    noteAssistantHost("env-mini", answer({ account: ACCOUNT }));
    noteAssistantHost("env-mini", { hosts: true, at: NOW + 1 });
    expect(knownAssistantHosts().get("env-mini")).toMatchObject({
      hosts: true,
      task: { account: ACCOUNT },
    });
  });
});
