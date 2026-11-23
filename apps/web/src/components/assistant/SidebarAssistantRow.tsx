import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { AssistantMark } from "./AssistantMark";
import { useOpenAssistant } from "./useAssistant";

import { useAssistantNeedsYou } from "./useAssistantNeedsYou";

// Fork-owned. The sidebar's first row: the cross-Project Assistant, with how
// many Status questions wait on the user across every Project in its reach.

export function SidebarAssistantRow({
  isActive,
  hint,
}: {
  readonly isActive: boolean;
  /** The shortcut badge shown while the jump modifier is held. */
  readonly hint?: ReactNode;
}) {
  const { open, opening } = useOpenAssistant();
  const needsYou = useAssistantNeedsYou().length;
  return (
    <li className="relative mb-1.5 list-none" data-testid="sidebar-global-assistant">
      <button
        type="button"
        aria-current={isActive ? "page" : undefined}
        aria-busy={opening}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[length:1em] leading-tight text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-ring",
          isActive ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
        onClick={() => void open()}
      >
        <AssistantMark className="size-4 text-attention-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">Assistant</span>
        {needsYou > 0 ? (
          <span
            className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-sm bg-attention/12 px-1 text-[11px] font-medium text-attention-foreground tabular-nums"
            aria-label={`${needsYou} ${needsYou === 1 ? "question needs" : "questions need"} you`}
          >
            {needsYou}
          </span>
        ) : null}
      </button>
      {hint}
    </li>
  );
}
