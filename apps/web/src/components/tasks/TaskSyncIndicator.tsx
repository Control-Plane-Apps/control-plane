import type { TaskSyncStatus } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CloudIcon, CloudOffIcon, LaptopIcon, RefreshCwIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import {
  Popover,
  PopoverTrigger,
  PopoverPopup,
  PopoverTitle,
  PopoverDescription,
} from "../ui/popover";

export type TaskSyncTone = "local" | "syncing" | "synced" | "offline";

export interface TaskSyncIndicator {
  readonly tone: TaskSyncTone;
  /** The header chip, e.g. "On this Mac", "Offline · 3 waiting". */
  readonly header: string;
  /** Status detail shown only inside the header popover. */
  readonly description: string;
  /** Optional subscription action in the header popover. */
  readonly action: string | null;
  /** Additional status detail, e.g. "3 changes waiting". */
  readonly detail?: string | null;
}

/**
 * Task Sync shown once in the header, with details in its popover:
 * not subscribed, syncing, synced, offline or coming soon.
 */
export function taskSyncIndicator(status: TaskSyncStatus | null): TaskSyncIndicator {
  if (status === null || status.state === "unavailable") {
    return { tone: "local", header: "On this Mac", description: "On this Mac", action: null };
  }
  switch (status.state) {
    case "coming-soon":
      return {
        tone: "local",
        header: "On this Mac",
        description: "Task Sync",
        action: "Coming soon",
      };
    case "signed-out":
    case "inactive":
      return {
        tone: "local",
        header: "On this Mac",
        description: "Task Sync",
        action: "Turn on · $5/month",
      };
    case "syncing":
      return { tone: "syncing", header: "Syncing", description: "Syncing", action: null };
    case "synced":
      return { tone: "synced", header: "Synced", description: "Synced with cloud", action: null };
    case "error": {
      const waiting = status.pendingChanges;
      return {
        tone: "offline",
        header: waiting > 0 ? `Offline · ${waiting} waiting` : "Offline",
        description: "Offline",
        action: null,
        detail: waiting > 0 ? `${waiting} ${waiting === 1 ? "change" : "changes"} waiting` : null,
      };
    }
  }
}

function ToneIcon(props: { readonly tone: TaskSyncTone; readonly className?: string }) {
  const className = cn("size-3.5 shrink-0", props.className);
  switch (props.tone) {
    case "local":
      return <LaptopIcon aria-hidden className={className} />;
    case "syncing":
      return <RefreshCwIcon aria-hidden className={cn(className, "animate-spin")} />;
    case "synced":
      return <CloudIcon aria-hidden className={className} />;
    case "offline":
      return <CloudOffIcon aria-hidden className={cn(className, "text-attention-foreground")} />;
  }
}

export function TaskSyncChip(props: { readonly indicator: TaskSyncIndicator }) {
  const { indicator } = props;
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Task Sync: ${indicator.header}`}
        className={cn(
          "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
          indicator.tone === "offline" ? "text-attention-foreground" : "text-muted-foreground",
        )}
      >
        <ToneIcon tone={indicator.tone} />
        {indicator.header}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-64">
        <PopoverTitle>Task Sync</PopoverTitle>
        <PopoverDescription>{indicator.description}</PopoverDescription>
        {indicator.detail ? (
          <p className="pt-1 text-muted-foreground text-sm">{indicator.detail}</p>
        ) : null}
        <Link
          to="/settings/task-sync"
          className="mt-3 inline-flex text-sm font-medium text-foreground hover:underline"
        >
          {indicator.action ?? "Task Sync settings"}
        </Link>
      </PopoverPopup>
    </Popover>
  );
}
