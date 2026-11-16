import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

// Fork-owned. The Assistant's right rail on desktop: whether it is collapsed,
// and the asks the user dismissed from "Working on". Kept on this device.

/** Dismissed asks kept; older ones fall off, since their activity is long gone from view. */
const DISMISSED_LIMIT = 200;

interface AssistantRailState {
  readonly collapsed: boolean;
  /** Ask ids the user dismissed from Working on, oldest first. */
  readonly dismissedAskIds: ReadonlyArray<string>;
  readonly toggleCollapsed: () => void;
  readonly dismissAsk: (askId: string) => void;
}

export const useAssistantRailStore = create<AssistantRailState>()(
  persist(
    (set) => ({
      collapsed: false,
      dismissedAskIds: [],
      toggleCollapsed: () => set((state) => ({ collapsed: !state.collapsed })),
      dismissAsk: (askId) =>
        set((state) =>
          state.dismissedAskIds.includes(askId)
            ? state
            : { dismissedAskIds: [...state.dismissedAskIds, askId].slice(-DISMISSED_LIMIT) },
        ),
    }),
    {
      name: "cplane:assistant-rail:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        collapsed: state.collapsed,
        dismissedAskIds: state.dismissedAskIds,
      }),
    },
  ),
);
