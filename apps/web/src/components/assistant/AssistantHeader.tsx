import { BookOpenIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { AssistantMark } from "./AssistantMark";

// Fork-owned. The Assistant's header: its mark and subtitle, a segmented
// control of channels (the coordinator is "Today", each pinned thread is a
// channel such as "Weekly review", then the ping Inbox), and new channel,
// memory and settings.

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
  readonly onOpenSettings: () => void;
}

export const ASSISTANT_INBOX_CHANNEL = "inbox";

export function AssistantHeader(props: AssistantHeaderProps) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const title = name.trim();
    if (title.length === 0) return;
    props.onCreateChannel(title);
    setName("");
    setNaming(false);
  };
  const tabs = [
    ...props.channels,
    {
      id: ASSISTANT_INBOX_CHANNEL,
      label: props.inboxCount > 0 ? `Inbox ${props.inboxCount}` : "Inbox",
    },
  ];
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3" data-testid="assistant-header">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <AssistantMark className="size-5 text-primary" />
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="text-sm font-semibold text-foreground">Assistant</span>
          <span className="truncate text-xs text-muted-foreground">{props.subtitle}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {naming ? (
          <form onSubmit={submit} className="flex items-center gap-1">
            <input
              autoFocus
              aria-label="Channel name"
              placeholder="Channel name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => {
                if (name.trim().length === 0) setNaming(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") setNaming(false);
              }}
              className="h-7 w-36 rounded-md border border-input bg-popover px-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </form>
        ) : null}
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
          aria-label="New channel"
          title="New channel"
          onClick={() => setNaming(true)}
        >
          <PlusIcon aria-hidden />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label="Memory"
          title="Memory"
          onClick={props.onOpenMemory}
        >
          <BookOpenIcon aria-hidden />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost-muted"
          aria-label="Assistant settings"
          title="Assistant settings"
          onClick={props.onOpenSettings}
        >
          <SettingsIcon aria-hidden />
        </Button>
      </div>
    </div>
  );
}
