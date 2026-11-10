import { parseStatusReply, statusReplyText, type ProjectStatus } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

/**
 * The coordinator composer's "Re: <workstream>" tag, per thread, persisted so
 * a reload keeps it; the draft text itself stays in the composer draft store.
 */
export const STATUS_REPLY_STORAGE_KEY = "t3code:status-reply:v1";
const MAX_TAGS = 100;

/**
 * What a reply points at. `statusId` is the stable workstream id; `openedAt`
 * is the version of its question the user saw, absent when the row had none.
 * A tag persisted before ids existed has only a title.
 */
export interface StatusReplyTag {
  readonly title: string;
  readonly statusId?: string;
  readonly openedAt?: string;
}

export interface StatusReplyState {
  tagsByThreadKey: Record<string, StatusReplyTag>;
  setTag: (threadKey: string, tag: StatusReplyTag) => void;
  clearTag: (threadKey: string) => void;
}

function boundedRecord<T>(record: Record<string, T>, max: number): Record<string, T> {
  const entries = Object.entries(record);
  return entries.length <= max ? record : Object.fromEntries(entries.slice(-max));
}

function sameTag(a: StatusReplyTag | undefined, b: StatusReplyTag): boolean {
  return (
    a !== undefined && a.title === b.title && a.statusId === b.statusId && a.openedAt === b.openedAt
  );
}

export const useStatusReplyStore = create<StatusReplyState>()(
  persist(
    (set) => ({
      tagsByThreadKey: {},
      setTag: (threadKey, tag) =>
        set((state) => {
          if (sameTag(state.tagsByThreadKey[threadKey], tag)) return state;
          const { [threadKey]: _previous, ...rest } = state.tagsByThreadKey;
          return { tagsByThreadKey: boundedRecord({ ...rest, [threadKey]: tag }, MAX_TAGS) };
        }),
      clearTag: (threadKey) =>
        set((state) => {
          if (!(threadKey in state.tagsByThreadKey)) return state;
          const { [threadKey]: _removed, ...rest } = state.tagsByThreadKey;
          return { tagsByThreadKey: rest };
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

function readTag(value: unknown): StatusReplyTag | null {
  // Tags saved before workstream ids were plain titles: keep them title-only.
  if (typeof value === "string") return value.trim().length > 0 ? { title: value } : null;
  if (value === null || typeof value !== "object") return null;
  const { title, statusId, openedAt } = value as Record<string, unknown>;
  if (typeof title !== "string" || title.trim().length === 0) return null;
  return {
    title,
    ...(typeof statusId === "string" && statusId.length > 0 ? { statusId } : {}),
    ...(typeof statusId === "string" &&
    typeof openedAt === "string" &&
    Number.isFinite(Date.parse(openedAt))
      ? { openedAt }
      : {}),
  };
}

/** Keeps only well-formed persisted entries. */
export function mergeStatusReplyState(
  persisted: unknown,
  current: StatusReplyState,
): StatusReplyState {
  if (persisted === null || typeof persisted !== "object") return current;
  const value = persisted as { tagsByThreadKey?: unknown };
  const tags: Record<string, StatusReplyTag> = {};
  if (value.tagsByThreadKey !== null && typeof value.tagsByThreadKey === "object") {
    for (const [key, entry] of Object.entries(value.tagsByThreadKey)) {
      const tag = readTag(entry);
      if (tag !== null) tags[key] = tag;
    }
  }
  return { ...current, tagsByThreadKey: boundedRecord(tags, MAX_TAGS) };
}

export function useStatusReplyTag(threadKey: string | null): StatusReplyTag | null {
  return useStatusReplyStore((state) =>
    threadKey === null ? null : (state.tagsByThreadKey[threadKey] ?? null),
  );
}

/** The tag a Reply on `status` starts: its id, and its question's version when it has one. */
export function statusReplyTagFor(
  status: Pick<ProjectStatus, "id" | "title" | "decision">,
): StatusReplyTag {
  return {
    title: status.title,
    statusId: status.id,
    ...(status.decision !== undefined ? { openedAt: status.decision.openedAt } : {}),
  };
}

/** The text a send carries: the composer text, prefixed when a Re: tag is set. */
export function applyStatusReplyTag(text: string, tag: StatusReplyTag | null): string {
  if (tag === null) return text;
  return tag.statusId === undefined
    ? statusReplyText(tag.title, text)
    : statusReplyText(tag.title, text, {
        statusId: tag.statusId,
        ...(tag.openedAt !== undefined ? { openedAt: tag.openedAt } : {}),
      });
}

/** A header's reference, comparable to a tag's: title, id and question version. */
function referenceOf(tag: StatusReplyTag): string {
  return tag.statusId === undefined
    ? `title:${tag.title}`
    : `${tag.statusId}@${tag.openedAt === undefined ? "" : Date.parse(tag.openedAt)}`;
}

function tagOfReply(reply: NonNullable<ReturnType<typeof parseStatusReply>>): StatusReplyTag {
  return {
    title: reply.title,
    ...(reply.statusId !== undefined ? { statusId: reply.statusId } : {}),
    // `Date.parse` of this ISO string gives back the same revision the server compares.
    ...(reply.statusId !== undefined && reply.revision !== undefined
      ? { openedAt: new Date(reply.revision).toISOString() }
      : {}),
  };
}

/**
 * Whether the question a tag was started on is gone from the board
 * (`removed`) or was reworded or replaced since (`changed`). The reply still
 * sends; the chip just says so.
 */
export function statusReplyTagDrift(
  tag: StatusReplyTag,
  statuses: ReadonlyArray<Pick<ProjectStatus, "id" | "decision">>,
): "removed" | "changed" | null {
  if (tag.statusId === undefined) return null;
  const status = statuses.find((entry) => entry.id === tag.statusId);
  if (status === undefined) return "removed";
  if (tag.openedAt === undefined) return null;
  const current = status.decision?.openedAt;
  return current !== undefined && Date.parse(current) === Date.parse(tag.openedAt)
    ? null
    : "changed";
}

/**
 * Queued prompts going back into the composer. A header comes off only when
 * the composer's tag says the same thing, so a send never carries it twice;
 * every other header stays in the text, still naming its own workstream.
 * With no live tag and an empty draft, prompts that all reply to one
 * question give that question back as the tag; anything mixed keeps its
 * headers and no tag is adopted.
 */
export function restoreStatusReplyPrompts(
  prompts: ReadonlyArray<string>,
  liveTag: StatusReplyTag | null,
  draftEmpty: boolean,
): { readonly prompts: string[]; readonly tag: StatusReplyTag | null } {
  const replies = prompts.map((prompt) => parseStatusReply(prompt));
  let tag: StatusReplyTag | null = null;
  if (liveTag === null && draftEmpty && replies.length > 0 && replies.every((r) => r !== null)) {
    const first = tagOfReply(replies[0]!);
    if (replies.every((reply) => referenceOf(tagOfReply(reply!)) === referenceOf(first))) {
      tag = first;
    }
  }
  const strip = tag ?? liveTag;
  return {
    prompts: prompts.map((prompt, index) => {
      const reply = replies[index];
      return reply !== null &&
        reply !== undefined &&
        strip !== null &&
        referenceOf(tagOfReply(reply)) === referenceOf(strip)
        ? reply.body
        : prompt;
    }),
    tag,
  };
}
