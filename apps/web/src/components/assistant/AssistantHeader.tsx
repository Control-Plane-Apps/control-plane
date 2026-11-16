import { BrainIcon, ClockIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { AssistantMark } from "./AssistantMark";

// Fork-owned. The Assistant's header: its mark and subtitle, a segmented
// control of channels (the coordinator is "Today", each pinned thread is a
// channel such as "Weekly review", then the ping Inbox), plus
// memory and schedules. Settings > Assistant lives in Settings and the
// command palette.

export interface AssistantChannel {
  readonly id: string;
  readonly label: string;
}

export interface AssistantHeaderProps {
  readonly subtitle: string;
  readonly channels: ReadonlyArray<AssistantChannel>;
  /** The channel on screen, or "inbox". */
  readonly selected: string;
  readonly inboxCount: number;
  readonly onSelect: (id: string) => void;
  readonly onOpenMemory: () => void;
  /** Opens the Assistant's Schedules panel; absent when its server has no schedules. */
  readonly onOpenSchedules?: (() => void) | undefined;
  /**
   * The app's panel toggles sit fixed over the header's right edge while the
   * right panel is closed, so the header leaves room for them (as ChatHeader does).
   */
  readonly rightPanelOpen: boolean;
}

export const ASSISTANT_INBOX_CHANNEL = "inbox";

export function AssistantHeader(props: AssistantHeaderProps) {
  const tabs = [
    ...props.channels,
    {
      id: ASSISTANT_INBOX_CHANNEL,
      label: props.inboxCount > 0 ? `Inbox ${props.inboxCount}` : "Inbox",
    },
  ];
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-3",
        props.rightPanelOpen ? "pr-0" : "pr-20 sm:pr-16",
      )}
      data-testid="assistant-header"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <AssistantMark className="size-5 text-attention-foreground" />
        {/* The design's 17px and 14px lines: the two rows sit centred with
            room above and below instead of filling the 52px bar. */}
        <div className="flex min-w-0 flex-col">
          <span className="text-sm leading-[17px] font-semibold text-foreground">Assistant</span>
          <span className="truncate text-xs leading-[14px] text-muted-foreground">
            {props.subtitle}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <div
          role="group"
          aria-label="Assistant channels"
          className="inline-flex h-7 items-center gap-0.5 rounded-lg bg-accent p-[3px]"
        >
          {tabs.map((tab) => {
            const pressed = tab.id === props.selected;
            return (
              <button
                key={tab.id}
                type="button"
                aria-pressed={pressed}
                className={cn(
                  "h-[22px] cursor-pointer rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap",
                  pressed
                    ? "bg-popover text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => props.onSelect(tab.id)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label="Memory"
          title="Memory"
          onClick={props.onOpenMemory}
        >
          <BrainIcon aria-hidden />
        </Button>
        {props.onOpenSchedules ? (
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label="Schedules"
            title="Schedules"
            onClick={props.onOpenSchedules}
          >
            <ClockIcon aria-hidden />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
