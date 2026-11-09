import { sortProjectStatuses, type ProjectStatus } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useMemo } from "react";

import type { ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { Button } from "../ui/button";
import { formatDeadlineShort, isDeadlineOverdue } from "./projectStatus.logic";
import { useMinuteNow } from "./ProjectStatusPanel";

/**
 * The amber strip above the coordinator's composer while workstreams wait on
 * the user: one button per decision that starts a reply, and Open status when
 * the panel is closed. Null when nothing waits.
 */
export function useStatusComposerBanner(input: {
  readonly enabled: boolean;
  readonly threadKey: string | null;
  readonly statuses: ReadonlyArray<ProjectStatus>;
  readonly panelOpen: boolean;
  readonly onReply: (status: ProjectStatus) => void;
  readonly onOpenStatus: () => void;
}): ComposerBannerStackItem | null {
  const { enabled, threadKey, statuses, panelOpen, onReply, onOpenStatus } = input;
  return useMemo(() => {
    if (!enabled || threadKey === null) return null;
    // Same rule as the header and sidebar counts: a question already answered waits on the coordinator.
    const waiting = sortProjectStatuses(statuses).filter(
      (status) => status.state === "needs-you" && status.decision?.answeredAt === undefined,
    );
    if (waiting.length === 0) return null;
    return {
      id: `status-needs-you:${threadKey}`,
      variant: "warning",
      priority: "notice",
      icon: <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />,
      title: <StatusStripTitle waiting={waiting} onReply={onReply} />,
      ...(panelOpen
        ? {}
        : {
            actions: (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="text-warning-foreground"
                onClick={onOpenStatus}
              >
                Open status
              </Button>
            ),
          }),
    } satisfies ComposerBannerStackItem;
  }, [enabled, onOpenStatus, onReply, panelOpen, statuses, threadKey]);
}

/** Owns its minute tick, so a moving deadline re-renders the strip, not the chat. */
function StatusStripTitle(props: {
  readonly waiting: ReadonlyArray<ProjectStatus>;
  readonly onReply: (status: ProjectStatus) => void;
}) {
  const { waiting, onReply } = props;
  const now = useMinuteNow(waiting.some((status) => status.decision?.deadline !== undefined));
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="shrink-0 font-medium text-warning-foreground">
        {waiting.length} need{waiting.length === 1 ? "s" : ""} you
      </span>
      {waiting.map((status) => {
        const deadline = status.decision?.deadline;
        const replied = status.decision?.answeredAt !== undefined;
        const overdue = deadline !== undefined && isDeadlineOverdue(deadline, now);
        return (
          <Button
            key={status.id}
            type="button"
            size="xs"
            variant="outline"
            className="h-6 max-w-56 border-warning/24 font-normal"
            aria-label={`Reply to ${status.title}`}
            onClick={() => onReply(status)}
          >
            <span className="truncate">{status.title}</span>
            {replied ? (
              <span className="shrink-0 text-muted-foreground">replied</span>
            ) : deadline !== undefined ? (
              <span
                className={
                  overdue
                    ? "shrink-0 text-destructive-foreground"
                    : "shrink-0 text-muted-foreground"
                }
              >
                {overdue ? "overdue" : `by ${formatDeadlineShort(deadline, now)}`}
              </span>
            ) : null}
          </Button>
        );
      })}
    </span>
  );
}

/** The composer's "Re: <workstream>" tag. Removing it keeps the draft. */
export function StatusReplyChip(props: {
  readonly title: string;
  /** The question was reworded or replaced since this reply started. */
  readonly questionChanged: boolean;
  readonly onRemove: () => void;
}) {
  return (
    <div className="mb-2 flex">
      <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-warning/24 bg-warning/8 py-0.5 ps-2 pe-0.5 text-warning-foreground text-xs dark:bg-warning/16">
        <span className="min-w-0 truncate">Re: {props.title}</span>
        {props.questionChanged ? (
          <span
            className="shrink-0 text-muted-foreground"
            aria-label="The coordinator changed this question since you started replying"
          >
            · question changed
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-5 text-warning-foreground hover:bg-warning/16"
          aria-label={`Stop replying to ${props.title}`}
          onClick={props.onRemove}
        >
          <XIcon className="size-3" />
        </Button>
      </span>
    </div>
  );
}
