import { BrainIcon, ClockIcon, PlusIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { AssistantMark } from "./AssistantMark";

// Fork-owned. The Assistant's header: its mark and subtitle, a segmented
// control of channels (the coordinator is "Today", each pinned thread is a
// channel such as "Weekly review", then the ping Inbox), and new channel,
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
  readonly onCreateChannel: (title: string) => void;
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

/** The new channel's title, or null while the name is still blank. */
export function newChannelTitle(name: string): string | null {
  const title = name.trim();
  return title.length === 0 ? null : title;
}

export function AssistantHeader(props: AssistantHeaderProps) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const setOpen = (open: boolean) => {
    setNaming(open);
    if (!open) setName("");
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const title = newChannelTitle(name);
    if (title === null) return;
    props.onCreateChannel(title);
    setOpen(false);
  };
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
        <Popover open={naming} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label="New channel"
                title="New channel"
              />
            }
          >
            <PlusIcon aria-hidden />
          </PopoverTrigger>
          <PopoverPopup side="bottom" align="end" sideOffset={6} className="w-64">
            <form onSubmit={submit} className="flex flex-col gap-2">
              <label
                htmlFor="assistant-new-channel"
                className="text-xs font-medium text-muted-foreground"
              >
                New channel
              </label>
              <input
                id="assistant-new-channel"
                autoFocus
                placeholder="e.g. Weekly review"
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <div className="flex justify-end gap-1.5">
                <Button size="xs" variant="ghost" type="button" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button size="xs" type="submit" disabled={newChannelTitle(name) === null}>
                  Create
                </Button>
              </div>
            </form>
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
      </div>
    </div>
  );
}
