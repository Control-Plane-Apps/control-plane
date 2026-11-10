import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAutoAcceptArmed,
  PROJECT_STATUS_QUESTION_MAX,
  type ProjectStatus,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useServerConfigs, useThreadShellsForProjectRefs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  STATUS_GROUP_LABEL,
  canToggleAutoAccept,
  decisionKey,
  describeDecisionDeadline,
  describeLiveAgent,
  formatDeadlineShort,
  formatStatusAge,
  isRecommendationPending,
  groupProjectStatuses,
  isStatusStale,
  recommendationButtonLabel,
  showsFullRecommendation,
  summaryNeedsExpansion,
  type StatusGroup,
} from "./projectStatus.logic";
import { useQueuedMessages } from "../../queuedMessageStore";

const MINUTE_MS = 60_000;

export interface ProjectStatusActions {
  /** Puts a "Re: <title>" tag on the coordinator's composer, keeping its draft. */
  readonly onReply: (status: ProjectStatus) => void;
  /** The same tag, with a short question when the draft is empty. */
  readonly onAskForUpdate: (status: ProjectStatus) => void;
  /** Sends the recommendation through the composer's normal send path. */
  readonly onGoWithRecommendation: (status: ProjectStatus) => void;
  /** "Go with recommendation" messages already in the thread, by question version. */
  readonly sentRecommendations: ReadonlySet<string>;
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
  const groups = useMemo(
    () => groupProjectStatuses(project.assistant?.statuses ?? []),
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

  // Expanded rows, by workstream id. Session only: a reopened panel starts collapsed.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleRow = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section aria-label="Status" className="flex h-full min-h-0 flex-col text-sm">
      <ScrollArea className="min-h-0 flex-1">
        {groups.length === 0 ? (
          <div className="flex flex-col gap-1 px-3 py-4 text-muted-foreground">
            <p>No workstreams yet.</p>
            <p className="text-xs">
              The coordinator keeps one line per workstream here as agents report in, and flags
              anything that needs your call.
            </p>
          </div>
        ) : (
          <div className="flex flex-col pb-2">
            {groups.map(({ group, statuses: members }) => (
              <section key={group} aria-labelledby={`status-group-${group}`}>
                <h3
                  id={`status-group-${group}`}
                  className={cn(
                    "flex items-center gap-1.5 px-3 pt-3 pb-1.5 font-medium text-xs",
                    group === "needs-you" ? "text-warning-foreground" : "text-muted-foreground",
                  )}
                >
                  {STATUS_GROUP_LABEL[group]}
                  <span className="font-normal tabular-nums opacity-80">{members.length}</span>
                </h3>
                <ul className="flex flex-col">
                  {members.map((status) => (
                    <StatusRow
                      key={status.id}
                      status={status}
                      group={group}
                      now={now}
                      expanded={expanded.has(status.id)}
                      onToggle={() => toggleRow(status.id)}
                      sending={isRecommendationPending({
                        status,
                        queue: queuedMessages,
                        sentKeys: props.sentRecommendations,
                      })}
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
              </section>
            ))}
          </div>
        )}
      </ScrollArea>
    </section>
  );
}

const GROUP_DOT: Record<StatusGroup, string> = {
  "needs-you": "bg-amber-500",
  "in-progress": "bg-sky-500",
  queued: "bg-muted-foreground/40",
  done: "bg-emerald-500",
};

function StatusRow(props: {
  readonly status: ProjectStatus;
  readonly group: StatusGroup;
  readonly now: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
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
  const { status, group, now, expanded, actions } = props;
  const detailsId = useId();
  // Stale only means something for work still expected to move.
  const stale =
    (group === "needs-you" || group === "in-progress") && isStatusStale(status.updatedAt, now);
  const decision = status.decision;
  const deadline = decision === undefined ? null : describeDecisionDeadline(decision, now);
  const asking =
    decision !== undefined && decision.answeredAt === undefined && group === "needs-you";
  const answered = decision?.answeredAt !== undefined ? decision : undefined;
  return (
    <li className="border-border/50 border-t">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        className="flex w-full min-w-0 cursor-pointer flex-col gap-0.5 px-3 py-2.5 text-start hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={props.onToggle}
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", GROUP_DOT[group])} />
          <span className="min-w-0 flex-1 truncate font-medium text-sm">{status.title}</span>
          {stale ? <span className="shrink-0 text-warning-foreground text-xs">Stale</span> : null}
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
              expanded && "rotate-90",
            )}
          />
        </span>
        <span className="block w-full truncate ps-3.5 pe-5.5 text-[13px] text-muted-foreground">
          {status.summary}
        </span>
      </button>
      {expanded ? (
        <div
          id={detailsId}
          className="flex flex-col gap-1.5 ps-6.5 pe-3 pb-3 text-[13px] text-muted-foreground"
        >
          {summaryNeedsExpansion(status.summary) ? (
            <p className="text-foreground/80">{status.summary}</p>
          ) : null}
          {status.detail !== undefined ? <p>{status.detail}</p> : null}
          {decision?.why !== undefined ? <p>Why: {decision.why}</p> : null}
          {decision !== undefined && showsFullRecommendation(decision) ? (
            <p>Recommended: {decision.recommendation}</p>
          ) : null}
          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
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
            <span>updated {formatStatusAge(status.updatedAt, now)}</span>
            {deadline !== null ? (
              <>
                <span aria-hidden>·</span>
                <span
                  className={cn(
                    deadline.tone === "overdue"
                      ? "font-medium text-destructive-foreground"
                      : deadline.tone === "pending"
                        ? "text-warning-foreground"
                        : undefined,
                  )}
                >
                  {deadline.text}
                </span>
              </>
            ) : null}
          </p>
          {decision?.deadline !== undefined && canToggleAutoAccept(decision, now) ? (
            <label className="flex cursor-pointer items-center gap-2 text-xs">
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
          {stale ? (
            <div>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => actions.onAskForUpdate(status)}
              >
                Ask for update
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {asking ? (
        <div className="flex flex-col gap-2 ps-6.5 pe-3 pb-3">
          <p
            className={cn(
              "text-foreground text-sm",
              // Older, longer questions clamp until the row is expanded.
              !expanded && decision.question.length > PROJECT_STATUS_QUESTION_MAX && "line-clamp-2",
            )}
          >
            {decision.question}
          </p>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="xs"
              className="max-w-full"
              disabled={props.sending}
              onClick={() => actions.onGoWithRecommendation(status)}
            >
              <CheckIcon />
              <span className="truncate">
                {props.sending ? "Sending..." : recommendationButtonLabel(decision)}
              </span>
            </Button>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => actions.onReply(status)}
            >
              Reply
            </Button>
            <span className="text-muted-foreground text-xs">Recommended</span>
          </div>
        </div>
      ) : answered !== undefined ? (
        <div className="flex flex-col gap-2 ps-6.5 pe-3 pb-3">
          <p className="text-muted-foreground text-sm">{answered.question}</p>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-xs">
              You replied {formatStatusAge(answered.answeredAt!, now)}. Waiting on the coordinator.
            </span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => actions.onReply(status)}
            >
              Reply
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
