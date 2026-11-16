import type { TaskSyncStatus } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { CloudIcon, CloudOffIcon, LaptopIcon, RefreshCwIcon } from "lucide-react";

import { cn } from "../../lib/utils";

export type TaskSyncTone = "local" | "syncing" | "synced" | "offline";

export interface TaskSyncIndicator {
  readonly tone: TaskSyncTone;
  /** The header chip, e.g. "On this Mac", "Offline · 3 waiting". */
  readonly header: string;
  /** The margin line under the intent, e.g. "Synced with cloud". */
  readonly margin: string;
  /** A quiet call to action in the margin, linking to Task Sync settings. */
  readonly action: string | null;
  /** Plain text after the margin label, e.g. "3 changes waiting". */
  readonly detail?: string | null;
}

/**
 * Task Sync shown as a header chip and one margin line, never a banner:
 * not subscribed, syncing, synced, offline or coming soon.
 */
export function taskSyncIndicator(status: TaskSyncStatus | null): TaskSyncIndicator {
  if (status === null || status.state === "unavailable") {
    return { tone: "local", header: "On this Mac", margin: "On this Mac", action: null };
  }
  switch (status.state) {
    case "coming-soon":
      return { tone: "local", header: "On this Mac", margin: "Task Sync", action: "Coming soon" };
    case "signed-out":
    case "inactive":
      return {
        tone: "local",
        header: "On this Mac",
        margin: "Task Sync",
        action: "Turn on · $5/month",
      };
    case "syncing":
      return { tone: "syncing", header: "Syncing", margin: "Syncing", action: null };
    case "synced":
      return { tone: "synced", header: "Synced", margin: "Synced with cloud", action: null };
    case "error": {
      const waiting = status.pendingChanges;
      return {
        tone: "offline",
        header: waiting > 0 ? `Offline · ${waiting} waiting` : "Offline",
        margin: "Offline",
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
    <Link
      to="/settings/task-sync"
      aria-label={`Task Sync: ${indicator.header}`}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
        indicator.tone === "offline" ? "text-attention-foreground" : "text-muted-foreground",
      )}
    >
      <ToneIcon tone={indicator.tone} />
      {indicator.header}
    </Link>
  );
}

export function TaskSyncMarginLine(props: { readonly indicator: TaskSyncIndicator }) {
  const { indicator } = props;
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-x-1.5 text-sm",
        indicator.tone === "offline" ? "text-attention-foreground" : "text-muted-foreground",
      )}
    >
      <ToneIcon tone={indicator.tone} />
      <span>{indicator.margin}</span>
      {indicator.detail ? (
        <>
          <span aria-hidden>·</span>
          <span>{indicator.detail}</span>
        </>
      ) : null}
      {indicator.action !== null ? (
        <>
          <span aria-hidden>·</span>
          <Link to="/settings/task-sync" className="hover:text-foreground">
            {indicator.action}
          </Link>
        </>
      ) : null}
    </p>
  );
}
