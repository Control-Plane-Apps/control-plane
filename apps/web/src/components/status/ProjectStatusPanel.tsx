import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAutoAcceptArmed,
  sortProjectStatuses,
  type ProjectStatus,
  type ProjectStatusState,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { ClockIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useServerConfigs, useThreadShellsForProjectRefs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  STATUS_STATE_LABEL,
  canToggleAutoAccept,
  decisionKey,
  describeDecisionDeadline,
  describeLiveAgent,
  formatDeadlineShort,
  formatStatusAge,
  isRecommendationQueued,
  isStatusStale,
  statusCountLine,
} from "./projectStatus.logic";
import { useQueuedMessages } from "../../queuedMessageStore";

const MINUTE_MS = 60_000;

// The sidebar's status hues, so a row reads like the threads it summarizes.
const STATE_DOT: Record<ProjectStatusState, string> = {
  "needs-you": "bg-amber-500",
  working: "bg-sky-500",
  done: "bg-emerald-500",
  queued: "bg-muted-foreground/40",
};
const STATE_TEXT: Record<ProjectStatusState, string> = {
  "needs-you": "text-warning-foreground",
  working: "text-info-foreground",
  done: "text-success-foreground",
  queued: "text-muted-foreground",
};

export interface ProjectStatusActions {
  /** Puts a "Re: <title>" tag on the coordinator's composer, keeping its draft. */
  readonly onReply: (title: string) => void;
  /** The same tag, with a short question when the draft is empty. */
  readonly onAskForUpdate: (title: string) => void;
  /** Sends the recommendation through the composer's normal send path. */
  readonly onGoWithRecommendation: (status: ProjectStatus) => void;
}

/** A minute tick while `active`: ages and deadlines move, nothing animates. */
export function useMinuteNow(active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(interval);
  }, [active]);
  return now;
}

/**
 * The Status right-panel surface beside a Project's coordinator. Closes itself
 * when the thread's Project is gone or its server has no Status board.
 */
export function ProjectStatusPanel(
  props: {
    readonly threadRef: ScopedThreadRef;
    readonly project: EnvironmentProject | null;
  } & ProjectStatusActions,
) {
  const { threadRef, project } = props;
  const serverConfig = useServerConfigs().get(threadRef.environmentId) ?? null;
  const available =
    project?.assistant != null && serverConfig?.environment.capabilities.projectStatus === true;
  const settled = project !== null && serverConfig !== null;
  useEffect(() => {
    if (settled && !available) useRightPanelStore.getState().closeSurface(threadRef, "status");
  }, [available, settled, threadRef]);
  if (!available || project === null) return null;
  return <ProjectStatusPanelContent {...props} project={project} />;
}

function ProjectStatusPanelContent(
  props: {
    readonly threadRef: ScopedThreadRef;
    readonly project: EnvironmentProject;
  } & ProjectStatusActions,
) {
  const { project, threadRef } = props;
  const navigate = useNavigate();
  const now = useMinuteNow();
  const statuses = useMemo(
    () => sortProjectStatuses(project.assistant?.statuses ?? []),
    [project.assistant?.statuses],
  );
  const projectRefs = useMemo(
    () => [scopeProjectRef(project.environmentId, project.id)],
    [project.environmentId, project.id],
  );
  const threads = useThreadShellsForProjectRefs(projectRefs);
  const threadsById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads],
  );
  const threadKey = scopedThreadKey(threadRef);
  const queuedMessages = useQueuedMessages(threadKey);
  const automateStatus = useAtomCommand(projectEnvironment.automateStatus, {
    reportFailure: false,
  });
  // Toggles in flight, by decision version, so a second click waits for the first.
  const [automating, setAutomating] = useState<ReadonlySet<string>>(() => new Set());
  const setAutoAccept = async (status: ProjectStatus, enabled: boolean) => {
    const decision = status.decision;
    if (decision === undefined) return;
    const key = decisionKey(status, decision);
    setAutomating((current) => new Set(current).add(key));
    const result = await automateStatus({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        statusId: status.id,
        openedAt: decision.openedAt,
        enabled,
      },
    });
    setAutomating((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: `Could not change ${status.title}`,
      description:
        error instanceof Error
          ? error.message
          : "The decision changed since you saw it. Review it and try again.",
    });
  };
  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(project.environmentId, threadId)),
    });

  return (
    <section aria-label="Status" className="flex h-full min-h-0 flex-col text-sm">
      <div className="flex items-center gap-2 border-border/70 border-b px-3 py-2">
        <h2 className="shrink-0 font-medium">Status</h2>
        {statuses.length > 0 ? (
          <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
            {statusCountLine(statuses)}
          </span>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {statuses.length === 0 ? (
          <div className="flex flex-col gap-1 px-3 py-4 text-muted-foreground">
            <p>No workstreams yet.</p>
            <p className="text-xs">
              The coordinator keeps one line per workstream here as agents report in, and flags
              anything that needs your call.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col">
            {statuses.map((status) => (
              <StatusRow
                key={status.id}
                status={status}
                now={now}
                sending={isRecommendationQueued(queuedMessages, status)}
                automating={
                  status.decision !== undefined &&
                  automating.has(decisionKey(status, status.decision))
                }
                onSetAutoAccept={(enabled) => void setAutoAccept(status, enabled)}
                liveAgents={(status.agents ?? []).flatMap((threadId) => {
                  const live = describeLiveAgent(threadsById.get(threadId) ?? null, now);
                  return live === null ? [] : [{ threadId, ...live }];
                })}
                onOpenThread={openThread}
                actions={props}
              />
            ))}
          </ul>
        )}
      </ScrollArea>
    </section>
  );
}

function StatusRow(props: {
  readonly status: ProjectStatus;
  readonly now: number;
  readonly sending: boolean;
  readonly automating: boolean;
  readonly onSetAutoAccept: (enabled: boolean) => void;
  readonly liveAgents: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly label: string;
    readonly tone: "working" | "attention" | "idle";
  }>;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly actions: ProjectStatusActions;
}) {
  const { status, now, actions } = props;
  const stale = isStatusStale(status.updatedAt, now);
  const decision = status.decision;
  const deadline = decision === undefined ? null : describeDecisionDeadline(decision, now);
  return (
    <li className="flex flex-col gap-1.5 border-border/50 border-b px-3 py-3.5 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[status.state])}
        />
        <h3 className="min-w-0 flex-1 truncate font-medium">{status.title}</h3>
        <span className={cn("shrink-0 text-xs", STATE_TEXT[status.state])}>
          {STATUS_STATE_LABEL[status.state]}
        </span>
      </div>
      <div className="ms-3.5 flex flex-col gap-0.5 text-[13px] text-muted-foreground">
        <p className="text-foreground/80">{status.summary}</p>
        {status.detail !== undefined ? <p>{status.detail}</p> : null}
      </div>
      <div className="ms-3.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground text-xs">
        {props.liveAgents.map((agent) => (
          <span key={agent.threadId} className="inline-flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              className={cn(
                "inline-flex min-w-0 cursor-pointer items-center gap-1.5 underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none",
                agent.tone === "working"
                  ? "text-info-foreground"
                  : agent.tone === "attention"
                    ? "text-warning-foreground"
                    : "text-muted-foreground",
              )}
              onClick={() => props.onOpenThread(agent.threadId)}
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  agent.tone === "working"
                    ? "bg-sky-500"
                    : agent.tone === "attention"
                      ? "bg-amber-500"
                      : "bg-muted-foreground/40",
                )}
              />
              <span className="truncate">{agent.label}</span>
            </button>
            <span aria-hidden>·</span>
          </span>
        ))}
        <span>Updated {formatStatusAge(status.updatedAt, now)}</span>
        {stale ? (
          <>
            <Badge variant="warning" size="sm">
              Stale
            </Badge>
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto px-1 py-0 text-xs"
              onClick={() => actions.onAskForUpdate(status.title)}
            >
              Ask for update
            </Button>
          </>
        ) : null}
      </div>
      {decision !== undefined ? (
        <div className="ms-3.5 flex flex-col gap-1.5 rounded-lg border border-warning/20 bg-warning/8 px-2.5 py-2 dark:bg-warning/16">
          <p className="text-[13px] text-foreground">
            <span className="font-medium text-warning-foreground">Your call: </span>
            {decision.question}
          </p>
          <p className="text-muted-foreground text-xs">Recommends: {decision.recommendation}</p>
          {deadline !== null ? (
            <p
              className={cn(
                "flex items-start gap-1.5 text-xs",
                deadline.tone === "overdue"
                  ? "font-medium text-destructive-foreground"
                  : deadline.tone === "handled"
                    ? "text-muted-foreground"
                    : "text-warning-foreground",
              )}
            >
              <ClockIcon aria-hidden className="mt-px size-3 shrink-0" />
              <span>{deadline.text}</span>
            </p>
          ) : null}
          {decision.deadline !== undefined && canToggleAutoAccept(decision, now) ? (
            <label className="flex cursor-pointer items-center gap-2 text-muted-foreground text-xs">
              <Switch
                size="sm"
                checked={isAutoAcceptArmed(decision)}
                disabled={props.automating}
                onCheckedChange={(checked) => props.onSetAutoAccept(checked)}
              />
              <span>
                Go with the recommendation if I don't reply by{" "}
                {formatDeadlineShort(decision.deadline, now)}
              </span>
            </label>
          ) : null}
          {decision.answeredAt !== undefined ? (
            <p className="text-muted-foreground text-xs">
              You replied {formatStatusAge(decision.answeredAt, now)}. Waiting on the coordinator.
            </p>
          ) : null}
          <div className="mt-0.5 flex flex-wrap gap-1.5">
            {decision.answeredAt === undefined ? (
              <Button
                type="button"
                size="xs"
                disabled={props.sending}
                onClick={() => actions.onGoWithRecommendation(status)}
              >
                {props.sending ? "Queued" : "Go with recommendation"}
              </Button>
            ) : null}
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => actions.onReply(status.title)}
            >
              Reply
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
