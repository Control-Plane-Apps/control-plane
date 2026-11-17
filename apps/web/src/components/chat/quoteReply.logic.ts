import type { TurnId } from "@t3tools/contracts";

/** Where "show the original" goes: a painted row, a folded turn to open first, or nowhere. */
export type QuoteJumpTarget =
  | { readonly kind: "row"; readonly index: number; readonly rowId: string }
  | { readonly kind: "folded"; readonly turnId: TurnId }
  | { readonly kind: "missing" };

interface RowLike {
  readonly id: string;
  readonly kind: string;
  readonly message?: { readonly id: string };
}

interface EntryLike {
  readonly kind: string;
  readonly message?: { readonly id: string; readonly turnId?: TurnId | null | undefined };
}

export function resolveQuoteJumpTarget(
  rows: ReadonlyArray<RowLike>,
  entries: ReadonlyArray<EntryLike>,
  messageId: string,
): QuoteJumpTarget {
  const index = rows.findIndex((row) => row.kind === "message" && row.message?.id === messageId);
  if (index >= 0) return { kind: "row", index, rowId: rows[index]!.id };
  const entry = entries.find(
    (candidate) => candidate.kind === "message" && candidate.message?.id === messageId,
  );
  const turnId = entry?.message?.turnId;
  return turnId ? { kind: "folded", turnId } : { kind: "missing" };
}

/** The newest assistant message a keyboard reply should quote, skipping streaming ones. */
export function latestReplyableAssistantMessage<
  T extends {
    readonly kind: string;
    readonly message?: {
      readonly role: string;
      readonly text: string;
      readonly streaming?: boolean | undefined;
    };
  },
>(entries: ReadonlyArray<T>): T | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const message = entry.message;
    if (
      entry.kind === "message" &&
      message?.role === "assistant" &&
      !message.streaming &&
      message.text.trim().length > 0
    ) {
      return entry;
    }
  }
  return null;
}

/** Briefly highlights a painted row; honours reduced motion with a static flash. */
export function flashTimelineRow(element: HTMLElement): void {
  const target = element.querySelector<HTMLElement>("[data-quote-reply-flash-target]") ?? element;
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  if (typeof target.animate !== "function") return;
  target.animate(
    [
      { boxShadow: "0 0 0 2px color-mix(in srgb, var(--primary) 55%, transparent)" },
      { boxShadow: "0 0 0 2px color-mix(in srgb, var(--primary) 55%, transparent)", offset: 0.6 },
      { boxShadow: "0 0 0 2px transparent" },
    ],
    { duration: reduced ? 900 : 1_400, easing: "ease-out" },
  );
}
