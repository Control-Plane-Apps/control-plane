import { statusReplyText } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

/**
 * The coordinator composer's "Re: <workstream>" tag, per thread, persisted so
 * a reload keeps it; the draft text itself stays in the composer draft store.
 * Also the "Go with recommendation" clicks still on their way, session only:
 * once the server marks the decision answered, `answeredAt` takes over.
 */
export const STATUS_REPLY_STORAGE_KEY = "t3code:status-reply:v1";
const MAX_TAGS = 100;
const MAX_PENDING_DECISIONS = 200;

export interface StatusReplyState {
  /** Workstream title per thread key. */
  tagsByThreadKey: Record<string, string>;
  /** `${threadKey}|${decisionKey}` for recommendations sent from here, not yet answered. */
  pendingDecisions: string[];
  setTag: (threadKey: string, title: string) => void;
  clearTag: (threadKey: string) => void;
  markDecisionPending: (threadKey: string, decisionKey: string) => void;
}

function boundedRecord(record: Record<string, string>, max: number): Record<string, string> {
  const entries = Object.entries(record);
  return entries.length <= max ? record : Object.fromEntries(entries.slice(-max));
}

export const useStatusReplyStore = create<StatusReplyState>()(
  persist(
    (set) => ({
      tagsByThreadKey: {},
      pendingDecisions: [],
      setTag: (threadKey, title) =>
        set((state) => {
          if (state.tagsByThreadKey[threadKey] === title) return state;
          const { [threadKey]: _previous, ...rest } = state.tagsByThreadKey;
          return { tagsByThreadKey: boundedRecord({ ...rest, [threadKey]: title }, MAX_TAGS) };
        }),
      clearTag: (threadKey) =>
        set((state) => {
          if (!(threadKey in state.tagsByThreadKey)) return state;
          const { [threadKey]: _removed, ...rest } = state.tagsByThreadKey;
          return { tagsByThreadKey: rest };
        }),
      markDecisionPending: (threadKey, decisionKey) =>
        set((state) => {
          const key = `${threadKey}|${decisionKey}`;
          if (state.pendingDecisions.includes(key)) return state;
          return {
            pendingDecisions: [...state.pendingDecisions, key].slice(-MAX_PENDING_DECISIONS),
          };
        }),
    }),
    {
      name: STATUS_REPLY_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ tagsByThreadKey: state.tagsByThreadKey }),
      merge: (persisted, current) => mergeStatusReplyState(persisted, current),
    },
  ),
);

/** Keeps only well-formed persisted entries. */
export function mergeStatusReplyState(
  persisted: unknown,
  current: StatusReplyState,
): StatusReplyState {
  if (persisted === null || typeof persisted !== "object") return current;
  const value = persisted as { tagsByThreadKey?: unknown };
  const tags: Record<string, string> = {};
  if (value.tagsByThreadKey !== null && typeof value.tagsByThreadKey === "object") {
    for (const [key, title] of Object.entries(value.tagsByThreadKey)) {
      if (typeof title === "string" && title.trim().length > 0) tags[key] = title;
    }
  }
  return { ...current, tagsByThreadKey: boundedRecord(tags, MAX_TAGS) };
}

export function useStatusReplyTag(threadKey: string | null): string | null {
  return useStatusReplyStore((state) =>
    threadKey === null ? null : (state.tagsByThreadKey[threadKey] ?? null),
  );
}

/** The text a send carries: the composer text, prefixed when a Re: tag is set. */
export function applyStatusReplyTag(text: string, title: string | null): string {
  return title === null ? text : statusReplyText(title, text);
}
