import { collectNeedsYou } from "@t3tools/client-runtime/state/assistant-home";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import { usePrimaryEnvironment } from "~/state/environments";
import { useProjects } from "~/state/entities";
import { AssistantMark } from "./AssistantMark";
import { useOpenAssistant } from "./useAssistant";

// Fork-owned. The sidebar's first row: the cross-Project Assistant, with how
// many Status questions wait on the user across every Project in its reach.

export function SidebarAssistantRow({ isActive }: { readonly isActive: boolean }) {
  const { open, opening } = useOpenAssistant();
  const projects = useProjects();
  const reach = usePrimaryEnvironment()?.serverConfig?.settings.assistant?.projects ?? null;
  const needsYou = useMemo(() => collectNeedsYou(projects, reach).length, [projects, reach]);
  return (
    <li className="mb-1.5 list-none" data-testid="sidebar-global-assistant">
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
    </li>
  );
}
