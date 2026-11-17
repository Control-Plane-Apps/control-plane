import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AssistantAskCard,
  type AssistantNeedsYouItem,
  assistantWorkingOn,
  collectNeedsYou,
  pendingAskCards,
} from "@t3tools/client-runtime/state/assistant-home";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ProjectStatus, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProjectFavicon } from "../ProjectFavicon";
import { formatStatusAge, recommendationButtonLabel } from "../status/projectStatus.logic";
import { statusReplyTagFor, useStatusReplyStore } from "../status/statusReplyStore";
import { useMinuteNow } from "../status/ProjectStatusPanel";
import { Button } from "../ui/button";
import { useAssistantOverviewStore } from "./assistantOverviewStore";
import { AssistantTodayTasks } from "./AssistantTodayTasks";
import { recommendationTextFor, useSendToThread } from "./useAssistant";

// Fork-owned. The Assistant's Overview right-panel tab: what needs the user
// across every Project, what the Assistant is working on, and today's tasks.
// Computed on the client from the shell stream, so it costs no model run.

export interface AssistantOverviewProps {
  readonly assistant: EnvironmentProject;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  /** Null reaches every Project. */
  readonly reach: ReadonlyArray<string> | null;
  readonly asks: ReadonlyArray<AssistantAskCard>;
  /** Today's tasks once the Tasks feature is available; null hides the row. */
  readonly tasksToday?: { readonly count: number; readonly onOpen: () => void } | null;
}

export function AssistantOverview(props: AssistantOverviewProps) {
  const needsYou = useMemo(
    () => collectNeedsYou(props.projects, props.reach),
    [props.projects, props.reach],
  );
  const now = useMinuteNow();
  const dismissedAskIds = useAssistantOverviewStore((state) => state.dismissedAskIds);
  const dismissAsk = useAssistantOverviewStore((state) => state.dismissAsk);
  const working = useMemo(() => {
    const own = assistantWorkingOn(props.assistant).map((status) => ({
      key: `status:${status.id}`,
      title: status.title,
      detail: status.summary,
      tone: status.state === "queued" ? ("idle" as const) : ("working" as const),
      askId: null,
    }));
    const waiting = pendingAskCards(props.asks, new Set(dismissedAskIds))
      .toReversed()
      .map((ask) => {
        const pending = ask.targets.filter((target) => target.answer === null);
        const who =
          pending.length === 1
            ? `${pending[0]!.title} coordinator`
            : `${pending.length} coordinators`;
        return {
          key: `ask:${ask.askId}`,
          title: ask.title,
          detail: `Asked ${who} · ${formatStatusAge(ask.createdAt, now)}`,
          tone: "working" as const,
          askId: ask.askId,
        };
      });
    return [...waiting, ...own];
  }, [dismissedAskIds, now, props.asks, props.assistant]);

  return (
    <section
      aria-label="Overview"
      className="flex h-full min-h-0 flex-col gap-2.5 overflow-y-auto bg-sidebar px-4 pt-4 pb-4 [&>*]:shrink-0"
      data-testid="assistant-overview"
    >
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-warning-foreground">
        Needs you<span className="font-normal opacity-80 tabular-nums">{needsYou.length}</span>
      </h3>
      {needsYou.length === 0 ? (
        <p className="rounded-xl border border-border bg-card px-3.5 py-3 text-sm text-muted-foreground">
          Nothing needs you right now.
        </p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-border bg-card">
          {needsYou.map((item, index) => (
            <NeedsYouRow
              key={`${item.project.environmentId}:${item.project.id}:${item.status.id}`}
              item={item}
              first={index === 0}
            />
          ))}
        </ul>
      )}

      <h3 className="mt-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        Working on<span className="font-normal opacity-80 tabular-nums">{working.length}</span>
      </h3>
      {working.length === 0 ? (
        <p className="rounded-xl border border-border bg-card px-3.5 py-3 text-sm text-muted-foreground">
          Ask anything across your Projects and the Assistant picks it up here.
        </p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-border bg-card">
          {working.map((entry, index) => (
            <li
              key={entry.key}
              className={cn(
                "group/working flex gap-2.5 px-3.5 py-2.5",
                index > 0 && "border-t border-border",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 rounded-full",
                  entry.tone === "working" ? "bg-info" : "bg-muted-foreground/45",
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">{entry.title}</p>
                <p className="truncate text-xs text-muted-foreground">{entry.detail}</p>
              </div>
              {entry.askId !== null ? (
                // An ask that will never hear back (a coordinator archived, or
                // an answer lost) can be cleared by hand; the card in the
                // conversation keeps its history.
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="-me-1.5 shrink-0 text-muted-foreground opacity-0 group-hover/working:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                  aria-label={`Dismiss "${entry.title}" from Working on`}
                  onClick={() => dismissAsk(entry.askId!)}
                >
                  <XIcon />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {props.tasksToday ? <AssistantTodayTasks onOpenTasks={props.tasksToday.onOpen} /> : null}
    </section>
  );
}

function NeedsYouRow({
  item,
  first,
}: {
  item: AssistantNeedsYouItem<EnvironmentProject>;
  first: boolean;
}) {
  const navigate = useNavigate();
  const send = useSendToThread();
  const { project, status } = item;
  const coordinatorId = project.assistant!.coordinatorThreadId;
  const coordinatorRef = scopeThreadRef(project.environmentId, coordinatorId);
  const coordinator = useThreadShell(coordinatorRef);
  const [sent, setSent] = useState(false);
  const busy =
    coordinator?.session?.status === "running" || coordinator?.session?.status === "starting";

  const openCoordinator = (status: ProjectStatus) => {
    const key = scopedThreadKey(coordinatorRef);
    useStatusReplyStore.getState().setTag(key, statusReplyTagFor(status));
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(coordinatorRef),
    });
  };

  const accept = async () => {
    const text = recommendationTextFor(status);
    if (text === null) return;
    // A busy coordinator would be steered mid-turn; its own composer queues instead.
    if (busy || coordinator === null) {
      openCoordinator(status);
      return;
    }
    setSent(true);
    const ok = await send({
      environmentId: project.environmentId,
      threadId: coordinatorId as ThreadId,
      text,
      runtimeMode: coordinator.runtimeMode,
    });
    if (!ok) setSent(false);
  };

  return (
    <li
      className={cn("px-3.5 py-3", !first && "border-t border-border")}
      data-testid="assistant-needs-you-row"
    >
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <ProjectFavicon project={project} className="size-3.5 shrink-0" />
        <span className="shrink-0">{project.title}</span>
        <span aria-hidden>·</span>
        <span className="truncate font-medium text-foreground">{status.title}</span>
      </div>
      <p className="mt-1.5 mb-2 text-sm leading-snug text-foreground">{status.decision.question}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {/* An action for an open question; the check appears only once the user sent it. */}
        <Button
          size="sm"
          disabled={sent}
          aria-label={
            sent
              ? `Answer sent to ${status.title}`
              : `${recommendationButtonLabel(status.decision)}, the recommended answer to ${status.title}`
          }
          onClick={() => void accept()}
        >
          {sent ? <CheckIcon aria-hidden /> : null}
          {sent ? "You answered" : recommendationButtonLabel(status.decision)}
        </Button>
        <Button size="sm" variant="outline" onClick={() => openCoordinator(status)}>
          Reply
        </Button>
        {sent ? null : (
          <span className="text-xs text-muted-foreground">Recommended · not answered yet</span>
        )}
      </div>
    </li>
  );
}
