import {
  encodeTaskHighlight,
  resolveTaskProposalBlock,
  summarizeTaskProposalBlock,
  type TaskProposeCall,
} from "@t3tools/client-runtime/state/projects";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, ListTodoIcon } from "lucide-react";
import { useMemo } from "react";

import { cn } from "../../lib/utils";
import { useTaskToday, useTasks } from "../../state/tasks";

/**
 * Fork-owned. One turn's `cp_task_propose` calls, inline in the transcript
 * where the first call was made: "Proposed 6 tasks · This week", the first
 * titles, and where they stand now. Opens Tasks on their range with the
 * rows lit up.
 */
export function TaskProposalBlock(props: {
  readonly calls: ReadonlyArray<TaskProposeCall>;
  readonly threadId: string | null;
}) {
  const navigate = useNavigate();
  const { tasks } = useTasks();
  const today = useTaskToday();
  const summary = useMemo(
    () =>
      summarizeTaskProposalBlock(
        resolveTaskProposalBlock({ calls: props.calls }, tasks, props.threadId ?? ""),
        today,
      ),
    [props.calls, props.threadId, tasks, today],
  );
  const view = summary.view;
  const open =
    view === null
      ? undefined
      : () =>
          void navigate({
            to: "/tasks/$view",
            params: { view },
            search: { highlight: encodeTaskHighlight(summary.highlightIds) },
          });
  const settled = summary.waiting === 0;
  return (
    <section aria-label={summary.headline} className="my-1" data-testid="task-proposal-block">
      <button
        type="button"
        disabled={open === undefined}
        onClick={open}
        className={cn(
          "flex w-full min-w-0 flex-col rounded-xl border border-border bg-card px-3.5 py-2 text-left",
          open !== undefined && "cursor-pointer hover:bg-accent/40",
        )}
      >
        <span className="flex w-full min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          <ListTodoIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate font-medium text-foreground">{summary.headline}</span>
          <span className="flex-1" />
          {summary.status.length > 0 ? (
            <span className={cn("shrink-0 tabular-nums", !settled && "text-info-foreground")}>
              {summary.status}
            </span>
          ) : null}
          {open !== undefined ? (
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0" />
          ) : null}
        </span>
        {summary.items.length > 0 ? (
          <span className="flex min-w-0 flex-col gap-0.5 pt-1.5 pl-5">
            {summary.items.map((item) => (
              <span key={item.id} className="truncate text-[13px] text-foreground/85">
                {item.title}
              </span>
            ))}
            {summary.moreCount > 0 ? (
              <span className="text-muted-foreground text-xs">{summary.moreCount} more</span>
            ) : null}
          </span>
        ) : null}
      </button>
    </section>
  );
}
