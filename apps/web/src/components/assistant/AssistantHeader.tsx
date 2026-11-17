import type { ReactNode } from "react";
import {
  BellIcon,
  BrainIcon,
  ClockIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AssistantMark } from "./AssistantMark";

// Fork-owned. Assistant identity and Inbox, Memory and Schedules actions.

export interface AssistantHeaderProps {
  /** What this thread is. Shown as a tooltip on the title, not as a second line. */
  readonly description: string;
  readonly inboxCount: number;
  readonly inbox: ReactNode;
  readonly onInboxOpenChange: (open: boolean) => void;
  readonly onOpenMemory: () => void;
  /** Opens the Assistant's Schedules panel; absent when its server has no schedules. */
  readonly onOpenSchedules?: (() => void) | undefined;
  /**
   * The app's panel toggles sit fixed over the header's right edge while the
   * right panel is closed, so the header leaves room for them (as ChatHeader does).
   */
  readonly rightPanelOpen: boolean;
  /** The Needs you / Working on / Today rail beside the conversation. */
  readonly rail?: {
    readonly collapsed: boolean;
    /** Shown on the toggle while collapsed, so nothing waiting goes unseen. */
    readonly needsYouCount: number;
    readonly shortcutLabel: string | null;
    readonly onToggle: () => void;
  };
}

function RailToggle(props: NonNullable<AssistantHeaderProps["rail"]>) {
  const action = props.collapsed
    ? "Show Needs you and Working on"
    : "Hide Needs you and Working on";
  const waiting = props.collapsed && props.needsYouCount > 0;
  return (
    <Button
      size="icon-sm"
      variant="ghost-muted"
      aria-label={waiting ? `${action}, ${props.needsYouCount} need you` : action}
      aria-pressed={!props.collapsed}
      title={props.shortcutLabel ? `${action} (${props.shortcutLabel})` : action}
      data-testid="assistant-rail-toggle"
      onClick={props.onToggle}
    >
      {props.collapsed ? <PanelRightOpenIcon aria-hidden /> : <PanelRightCloseIcon aria-hidden />}
      {waiting ? (
        <span
          aria-hidden
          data-testid="assistant-rail-needs-you-badge"
          className="absolute -top-1 -right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-1 text-[10px] font-semibold text-warning-foreground tabular-nums dark:text-background"
        >
          {props.needsYouCount > 9 ? "9+" : props.needsYouCount}
        </span>
      ) : null}
    </Button>
  );
}

export function AssistantHeader(props: AssistantHeaderProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-3",
        props.rightPanelOpen ? "pr-0" : "pr-20 sm:pr-16",
      )}
      data-testid="assistant-header"
    >
      <div className="flex min-w-0 flex-1 items-center">
        <Tooltip>
          <TooltipTrigger
            render={
              <div
                className="flex min-w-0 items-center gap-2"
                data-testid="assistant-header-title"
              />
            }
          >
            <AssistantMark className="size-5 shrink-0 text-attention-foreground" />
            <span className="truncate text-sm leading-[17px] font-semibold text-foreground">
              Assistant
            </span>
          </TooltipTrigger>
          {props.description !== "" ? (
            <TooltipPopup side="bottom" align="start">
              {props.description}
            </TooltipPopup>
          ) : null}
        </Tooltip>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Popover onOpenChange={props.onInboxOpenChange}>
          <PopoverTrigger
            render={
              <Button size="icon-sm" variant="ghost-muted" aria-label="Inbox" title="Inbox" />
            }
          >
            <BellIcon aria-hidden />
            {props.inboxCount > 0 ? (
              <span
                data-testid="assistant-inbox-badge"
                aria-label={`${props.inboxCount} unread pings`}
                className="absolute -top-1 -right-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-attention/12 px-1 text-[10px] font-semibold text-attention-foreground tabular-nums"
              >
                {props.inboxCount > 9 ? "9+" : props.inboxCount}
              </span>
            ) : null}
          </PopoverTrigger>
          <PopoverPopup
            side="bottom"
            align="end"
            className="w-[min(420px,calc(100vw-24px))]"
            viewportClassName="p-0"
          >
            <PopoverTitle className="px-4 pt-4 text-sm font-semibold">Inbox</PopoverTitle>
            {props.inbox}
          </PopoverPopup>
        </Popover>
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
        {props.rail ? <RailToggle {...props.rail} /> : null}
      </div>
    </div>
  );
}
