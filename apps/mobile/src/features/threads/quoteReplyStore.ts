import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "../../state/atom-registry";
import {
  withoutQuoteReply,
  withQuoteReply,
  type QuoteReplyDraft,
  type QuoteReplyDrafts,
} from "./quoteReply.logic";

// Fork-owned. The composer's quote-reply chip, per thread, for this app
// session (like the Status "Re:" chip). The draft text stays in the drafts.

const quoteReplyDraftsAtom = Atom.make<QuoteReplyDrafts>({}).pipe(Atom.keepAlive);

export function setQuoteReply(threadKey: string, quote: QuoteReplyDraft): void {
  appAtomRegistry.set(
    quoteReplyDraftsAtom,
    withQuoteReply(appAtomRegistry.get(quoteReplyDraftsAtom), threadKey, quote),
  );
}

export function clearQuoteReply(threadKey: string): void {
  const current = appAtomRegistry.get(quoteReplyDraftsAtom);
  const next = withoutQuoteReply(current, threadKey);
  if (next !== current) appAtomRegistry.set(quoteReplyDraftsAtom, next);
}

export function readQuoteReply(threadKey: string): QuoteReplyDraft | null {
  return appAtomRegistry.get(quoteReplyDraftsAtom)[threadKey] ?? null;
}

export function useQuoteReply(threadKey: string | null): QuoteReplyDraft | null {
  const drafts = useAtomValue(quoteReplyDraftsAtom);
  return threadKey === null ? null : (drafts[threadKey] ?? null);
}
