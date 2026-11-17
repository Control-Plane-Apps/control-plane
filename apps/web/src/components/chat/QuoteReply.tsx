import { ReplyIcon, XIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { QuoteReplyDraft } from "./quoteReplyStore";

/** Hover action on a message: starts a quote reply in the composer. */
export const ReplyToMessageButton = memo(function ReplyToMessageButton(props: {
  readonly onReply: () => void;
  readonly shortcutLabel?: string | null;
  readonly className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-label="Reply to this message"
            data-quote-reply-button
            className={cn("text-muted-foreground hover:text-foreground", props.className)}
            onClick={(event) => {
              event.stopPropagation();
              props.onReply();
            }}
            onKeyDown={(event) => event.stopPropagation()}
          />
        }
      >
        <ReplyIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup>
        <p>
          Reply
          {props.shortcutLabel ? (
            <span className="ms-1.5 text-muted-foreground">{props.shortcutLabel}</span>
          ) : null}
        </p>
      </TooltipPopup>
    </Tooltip>
  );
});

/** The composer's "Replying to …" chip. Removing it keeps the draft text. */
export function QuoteReplyChip(props: {
  readonly draft: QuoteReplyDraft;
  readonly onRemove: () => void;
  readonly onJump?: (() => void) | undefined;
}) {
  const { draft } = props;
  const firstLine = draft.text.split("\n")[0] ?? "";
  return (
    <div className="mb-2 flex min-w-0" data-quote-reply-chip>
      <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/60 py-0.5 ps-2 pe-0.5 text-muted-foreground text-xs">
        <ReplyIcon aria-hidden className="size-3 shrink-0" />
        <button
          type="button"
          className="flex min-w-0 cursor-pointer items-center gap-1 rounded-sm text-start hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Show the message from ${draft.displayLabel}`}
          onClick={props.onJump}
          disabled={props.onJump === undefined}
        >
          <span className="shrink-0 font-medium text-foreground">{draft.displayLabel}</span>
          <span className="min-w-0 truncate">{draft.excerpt ? `"${firstLine}"` : firstLine}</span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-5 shrink-0"
          aria-label={`Stop replying to ${draft.displayLabel}`}
          onClick={props.onRemove}
        >
          <XIcon className="size-3" />
        </Button>
      </span>
    </div>
  );
}

/**
 * The compact quote above a sent reply. Clicking it shows the original; when
 * the original is gone it still shows the stored text, just not as a link.
 */
export function SentMessageQuote(props: {
  readonly displayLabel: string;
  readonly text: string;
  readonly onJump: (() => void) | null;
}) {
  const content = (
    <>
      <span className="flex min-w-0 items-center gap-1 text-xs">
        <ReplyIcon aria-hidden className="size-3 shrink-0" />
        <span className="truncate font-medium">{props.displayLabel}</span>
      </span>
      <span className="line-clamp-2 min-w-0 whitespace-pre-line break-words text-xs">
        {props.text}
      </span>
    </>
  );
  const className =
    "mb-2 flex w-full min-w-0 flex-col gap-0.5 border-s-2 border-current/25 ps-2 text-start opacity-70";
  return props.onJump === null ? (
    <div className={className} data-quote-reply-quote data-quote-reply-orphan>
      {content}
    </div>
  ) : (
    <button
      type="button"
      data-quote-reply-quote
      aria-label={`Show the message from ${props.displayLabel}`}
      className={cn(
        className,
        "cursor-pointer rounded-e-sm hover:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
      )}
      onClick={props.onJump}
    >
      {content}
    </button>
  );
}
