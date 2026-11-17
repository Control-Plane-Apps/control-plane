import {
  normalizeQuoteReplyText,
  parseQuoteReply,
  parseStatusReply,
  QUOTE_REPLY_ASSISTANT_LABEL,
  QUOTE_REPLY_SELF_LABEL,
  quoteReplyFirstLine,
  quoteReplyText,
} from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

/**
 * The composer's quote-reply chip, per thread, persisted so a reload keeps it.
 * Sits beside the Status "Re:" tag: a send wraps the text in the quote header
 * first, then the Status header outermost (see `@t3tools/contracts` quoteReply).
 */
export const QUOTE_REPLY_STORAGE_KEY = "t3code:quote-reply:v1";
const MAX_DRAFTS = 100;

export interface QuoteReplyDraft {
  readonly messageId: string;
  /** What the model reads, e.g. "your earlier message". */
  readonly label: string;
  /** What the chip and the sent quote show, e.g. "Assistant", "You", an agent's name. */
  readonly displayLabel: string;
  /** The first line, or the selected excerpt. */
  readonly text: string;
  readonly excerpt: boolean;
}

export interface QuoteReplyState {
  draftsByThreadKey: Record<string, QuoteReplyDraft>;
  setDraft: (threadKey: string, draft: QuoteReplyDraft) => void;
  clearDraft: (threadKey: string) => void;
}

function boundedRecord<T>(record: Record<string, T>, max: number): Record<string, T> {
  const entries = Object.entries(record);
  return entries.length <= max ? record : Object.fromEntries(entries.slice(-max));
}

export const useQuoteReplyStore = create<QuoteReplyState>()(
  persist(
    (set) => ({
      draftsByThreadKey: {},
      setDraft: (threadKey, draft) =>
        set((state) => {
          const { [threadKey]: _previous, ...rest } = state.draftsByThreadKey;
          return { draftsByThreadKey: boundedRecord({ ...rest, [threadKey]: draft }, MAX_DRAFTS) };
        }),
      clearDraft: (threadKey) =>
        set((state) => {
          if (!(threadKey in state.draftsByThreadKey)) return state;
          const { [threadKey]: _removed, ...rest } = state.draftsByThreadKey;
          return { draftsByThreadKey: rest };
        }),
    }),
    {
      name: QUOTE_REPLY_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ draftsByThreadKey: state.draftsByThreadKey }),
      merge: (persisted, current) => mergeQuoteReplyState(persisted, current),
    },
  ),
);

function readDraft(value: unknown): QuoteReplyDraft | null {
  if (value === null || typeof value !== "object") return null;
  const { messageId, label, displayLabel, text, excerpt } = value as Record<string, unknown>;
  if (
    typeof messageId !== "string" ||
    messageId.length === 0 ||
    typeof label !== "string" ||
    typeof displayLabel !== "string" ||
    typeof text !== "string"
  ) {
    return null;
  }
  return { messageId, label, displayLabel, text, excerpt: excerpt === true };
}

/** Keeps only well-formed persisted entries. */
export function mergeQuoteReplyState(
  persisted: unknown,
  current: QuoteReplyState,
): QuoteReplyState {
  if (persisted === null || typeof persisted !== "object") return current;
  const value = persisted as { draftsByThreadKey?: unknown };
  const drafts: Record<string, QuoteReplyDraft> = {};
  if (value.draftsByThreadKey !== null && typeof value.draftsByThreadKey === "object") {
    for (const [key, entry] of Object.entries(value.draftsByThreadKey)) {
      const draft = readDraft(entry);
      if (draft !== null) drafts[key] = draft;
    }
  }
  return { ...current, draftsByThreadKey: boundedRecord(drafts, MAX_DRAFTS) };
}

export function useQuoteReplyDraft(threadKey: string | null): QuoteReplyDraft | null {
  return useQuoteReplyStore((state) =>
    threadKey === null ? null : (state.draftsByThreadKey[threadKey] ?? null),
  );
}

export function readQuoteReplyDraft(threadKey: string | null): QuoteReplyDraft | null {
  return threadKey === null
    ? null
    : (useQuoteReplyStore.getState().draftsByThreadKey[threadKey] ?? null);
}

/** Who a message is from, as the reply needs it. */
export type QuoteReplyAuthor =
  | { readonly kind: "assistant"; readonly displayLabel: string }
  | { readonly kind: "self" }
  | { readonly kind: "agent"; readonly name: string };

/** A user message's own text without the headers a reply puts in front. */
export function quoteReplyMessageBody(text: string): string {
  const afterStatus = parseStatusReply(text)?.body ?? text;
  return parseQuoteReply(afterStatus)?.body ?? afterStatus;
}

/**
 * The draft a Reply starts: the message's first line, or `excerpt` when the
 * user selected part of it. Null when there is nothing to quote.
 */
export function quoteReplyDraftFor(input: {
  readonly messageId: string;
  readonly messageText: string;
  readonly author: QuoteReplyAuthor;
  readonly excerpt?: string | undefined;
}): QuoteReplyDraft | null {
  const excerpt = input.excerpt === undefined ? "" : normalizeQuoteReplyText(input.excerpt);
  const text =
    excerpt.length > 0
      ? excerpt
      : quoteReplyFirstLine(
          input.author.kind === "assistant"
            ? input.messageText
            : quoteReplyMessageBody(input.messageText),
        );
  if (text.length === 0) return null;
  const { label, displayLabel } =
    input.author.kind === "assistant"
      ? { label: QUOTE_REPLY_ASSISTANT_LABEL, displayLabel: input.author.displayLabel }
      : input.author.kind === "self"
        ? { label: QUOTE_REPLY_SELF_LABEL, displayLabel: "You" }
        : { label: `${input.author.name}'s message`, displayLabel: input.author.name };
  return { messageId: input.messageId, label, displayLabel, text, excerpt: excerpt.length > 0 };
}

/** The text a send carries: the composer text, under a quote header when a reply is set. */
export function applyQuoteReply(text: string, draft: QuoteReplyDraft | null): string {
  return draft === null ? text : quoteReplyText(draft, text);
}

/** The name a sent quote shows when its original is no longer in the thread. */
export function quoteReplyDisplayLabelFromStored(label: string, assistantLabel: string): string {
  if (label === QUOTE_REPLY_ASSISTANT_LABEL) return assistantLabel;
  if (label === QUOTE_REPLY_SELF_LABEL) return "You";
  return label.endsWith("'s message") ? label.slice(0, -"'s message".length) : label;
}

function sameQuote(
  reply: NonNullable<ReturnType<typeof parseQuoteReply>>,
  draft: QuoteReplyDraft,
): boolean {
  return reply.messageId === draft.messageId && reply.text === normalizeQuoteReplyText(draft.text);
}

/**
 * Queued prompts going back into the composer, after their Status headers were
 * handled. A quote header comes off when it matches the live reply, or becomes
 * the reply when there is none yet; any other quote stays in the text.
 */
export function restoreQuoteReplyPrompts(
  prompts: ReadonlyArray<string>,
  liveDraft: QuoteReplyDraft | null,
  displayLabelFor: (reply: NonNullable<ReturnType<typeof parseQuoteReply>>) => string,
): { readonly prompts: string[]; readonly draft: QuoteReplyDraft | null } {
  let adopted: QuoteReplyDraft | null = null;
  const next = prompts.map((prompt) => {
    const reply = parseQuoteReply(prompt);
    if (reply === null) return prompt;
    const live = liveDraft ?? adopted;
    if (live === null) {
      adopted = {
        messageId: reply.messageId,
        label: reply.label,
        displayLabel: displayLabelFor(reply),
        text: reply.text,
        excerpt: false,
      };
      return reply.body;
    }
    return sameQuote(reply, live) ? reply.body : prompt;
  });
  return { prompts: next, draft: adopted };
}
