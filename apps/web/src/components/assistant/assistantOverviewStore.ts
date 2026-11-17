import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

// Fork-owned. The Assistant's Overview tab on desktop: the asks the user
// dismissed from "Working on", which Assistant threads already got the
// Overview tab opened for them once, and the Project its Status tab shows.
// Kept on this device.

/** Dismissed asks kept; older ones fall off, since their activity is long gone from view. */
const DISMISSED_LIMIT = 200;
/** Seeded threads kept; the Assistant has a handful of channels, so this never trims in practice. */
const SEEDED_LIMIT = 100;

interface AssistantOverviewState {
  /** Ask ids the user dismissed from Working on, oldest first. */
  readonly dismissedAskIds: ReadonlyArray<string>;
  /**
   * Scoped thread keys whose right panel already got the Overview tab once.
   * The tab opens by default only the first time, so closing it sticks.
   */
  readonly seededThreadKeys: ReadonlyArray<string>;
  /** `environmentId:projectId` of the Project the Status tab last showed. */
  readonly statusProjectKey: string | null;
  readonly dismissAsk: (askId: string) => void;
  readonly markSeeded: (threadKey: string) => void;
  readonly setStatusProjectKey: (key: string) => void;
}

export const useAssistantOverviewStore = create<AssistantOverviewState>()(
  persist(
    (set) => ({
      dismissedAskIds: [],
      seededThreadKeys: [],
      statusProjectKey: null,
      dismissAsk: (askId) =>
        set((state) =>
          state.dismissedAskIds.includes(askId)
            ? state
            : { dismissedAskIds: [...state.dismissedAskIds, askId].slice(-DISMISSED_LIMIT) },
        ),
      markSeeded: (threadKey) =>
        set((state) =>
          state.seededThreadKeys.includes(threadKey)
            ? state
            : { seededThreadKeys: [...state.seededThreadKeys, threadKey].slice(-SEEDED_LIMIT) },
        ),
      setStatusProjectKey: (key) => set({ statusProjectKey: key }),
    }),
    {
      // The rail's key, so dismissed asks carry over from before it became a tab.
      name: "cplane:assistant-rail:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        dismissedAskIds: state.dismissedAskIds,
        seededThreadKeys: state.seededThreadKeys,
        statusProjectKey: state.statusProjectKey,
      }),
    },
  ),
);
