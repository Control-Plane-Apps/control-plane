import {
  parseQuoteReply,
  parseStatusReply,
  QUOTE_REPLY_ASSISTANT_LABEL,
  QUOTE_REPLY_SELF_LABEL,
  quoteReplyFirstLine,
  quoteReplyText,
  type QuoteReplyRef,
} from "@t3tools/contracts";

import { applyStatusReplyTag, type StatusReplyTag } from "../status/projectStatus.logic";

// Fork-owned. Quote-reply on mobile: which message a reply quotes, how its
// author reads, and the text a send carries. Pure, so it is testable.

/** A quote set on the composer: what the message stores, plus the chip's author name. */
export interface QuoteReplyDraft extends QuoteReplyRef {
  /** "Assistant", "Coordinator", "You" or an agent's name. */
  readonly displayLabel: string;
}

export type QuoteReplyAuthor =
  | { readonly kind: "assistant"; readonly coordinator: boolean }
  | { readonly kind: "agent"; readonly name: string }
  | { readonly kind: "self" };

/** The label the model reads and the name the UI shows, for a message's author. */
export function quoteReplyLabelsFor(author: QuoteReplyAuthor): {
  readonly label: string;
  readonly displayLabel: string;
} {
  switch (author.kind) {
    case "assistant":
      return {
        label: QUOTE_REPLY_ASSISTANT_LABEL,
        displayLabel: author.coordinator ? "Coordinator" : "Assistant",
      };
    case "agent":
      return { label: `${author.name}'s message`, displayLabel: author.name };
    case "self":
      return { label: QUOTE_REPLY_SELF_LABEL, displayLabel: "You" };
  }
}

const AGENT_LABEL = /^(.+)'s message$/;

/** The author name for a stored label, when the original is not in the loaded feed. */
export function quoteReplyDisplayLabelFromLabel(label: string): string {
  if (label === QUOTE_REPLY_ASSISTANT_LABEL) return "Assistant";
  if (label === QUOTE_REPLY_SELF_LABEL) return "You";
  const agent = AGENT_LABEL.exec(label);
  if (agent !== null) return agent[1]!.trim();
  return label;
}

/** A user message's own text, without the Status and quote headers it may carry. */
export function messageTextWithoutReplyHeaders(text: string): string {
  const afterStatus = parseStatusReply(text)?.body ?? text;
  return parseQuoteReply(afterStatus)?.body ?? afterStatus;
}

/** A whole-message reply: the first line of the message, its author labelled. */
export function wholeMessageQuote(input: {
  readonly messageId: string;
  readonly text: string;
  readonly author: QuoteReplyAuthor;
}): QuoteReplyDraft {
  const source =
    input.author.kind === "assistant" ? input.text : messageTextWithoutReplyHeaders(input.text);
  return {
    messageId: input.messageId,
    text: quoteReplyFirstLine(source),
    ...quoteReplyLabelsFor(input.author),
  };
}

/**
 * The text a send carries. The quote header wraps the body; the Status `Re:`
 * header, when set, always wraps outermost so Status parsing is unchanged.
 */
export function composeReplyText(
  body: string,
  quote: QuoteReplyRef | null,
  statusTag: StatusReplyTag | null,
): string {
  return applyStatusReplyTag(quote === null ? body : quoteReplyText(quote, body), statusTag);
}

/** The minimum a feed row needs for a quote's scroll-target lookup. */
export interface QuoteTargetFeedEntry {
  readonly type: string;
  readonly id: string;
  readonly message?: { readonly id: string; readonly turnId?: string | null | undefined };
}

export type QuoteScrollTarget<TTurnId extends string = string> =
  | { readonly kind: "visible"; readonly index: number }
  /** In the loaded feed but inside a collapsed turn: expand it, then scroll. */
  | { readonly kind: "folded"; readonly turnId: TTurnId }
  | { readonly kind: "missing" };

/** Where the quoted message is: a row on screen, a folded turn, or not loaded. */
export function findQuoteScrollTarget<TTurnId extends string>(input: {
  readonly messageId: string;
  readonly presentedFeed: ReadonlyArray<QuoteTargetFeedEntry>;
  readonly fullFeed: ReadonlyArray<QuoteTargetFeedEntry>;
}): QuoteScrollTarget<TTurnId> {
  const index = input.presentedFeed.findIndex(
    (entry) => entry.type === "message" && entry.message?.id === input.messageId,
  );
  if (index !== -1) return { kind: "visible", index };
  const hidden = input.fullFeed.find(
    (entry) => entry.type === "message" && entry.message?.id === input.messageId,
  );
  const turnId = hidden?.message?.turnId;
  if (turnId != null) return { kind: "folded", turnId: turnId as TTurnId };
  return { kind: "missing" };
}

/** Finds a loaded message by id, for the quote block's author name. */
export function findFeedMessage<TEntry extends QuoteTargetFeedEntry>(
  feed: ReadonlyArray<TEntry>,
  messageId: string,
): NonNullable<TEntry["message"]> | null {
  for (const entry of feed) {
    if (entry.type === "message" && entry.message?.id === messageId) {
      return entry.message as NonNullable<TEntry["message"]>;
    }
  }
  return null;
}

/**
 * Who wrote a feed message, as a reply names it. In a Project, an agent's
 * message (attributed or "replied") is that agent's; any other user-role
 * message from an agent names the agent too.
 */
export function quoteReplyAuthorOf(input: {
  readonly role: string;
  readonly presentation:
    | { readonly kind: "attributed-user" | "replied"; readonly displayName: string }
    | { readonly kind: "scheduled" | "default" };
  /** The sending agent's name when the message came from an agent, else null. */
  readonly agentName: string | null;
  readonly coordinatorThread: boolean;
}): QuoteReplyAuthor {
  if (input.role === "assistant") {
    return { kind: "assistant", coordinator: input.coordinatorThread };
  }
  if (input.presentation.kind === "attributed-user" || input.presentation.kind === "replied") {
    return { kind: "agent", name: input.presentation.displayName };
  }
  if (input.agentName !== null && input.presentation.kind !== "scheduled") {
    return { kind: "agent", name: input.agentName };
  }
  return { kind: "self" };
}

// The composer's per-thread quote, as plain record updates.

export type QuoteReplyDrafts = Readonly<Record<string, QuoteReplyDraft>>;

export function withQuoteReply(
  drafts: QuoteReplyDrafts,
  threadKey: string,
  quote: QuoteReplyDraft,
): QuoteReplyDrafts {
  return { ...drafts, [threadKey]: quote };
}

export function withoutQuoteReply(drafts: QuoteReplyDrafts, threadKey: string): QuoteReplyDrafts {
  if (!(threadKey in drafts)) return drafts;
  const { [threadKey]: _removed, ...rest } = drafts;
  return rest;
}
