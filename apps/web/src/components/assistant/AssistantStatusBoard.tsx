import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  countStatusesNeedingUser,
  type ProjectStatus,
  statusStallMinutesOf,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { useServerConfigs, useThreadShell } from "~/state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProjectFavicon } from "../ProjectFavicon";
import { ProjectStatusPanelContent } from "../status/ProjectStatusPanel";
import { recommendationKey } from "../status/projectStatus.logic";
import { statusReplyTagFor, useStatusReplyStore } from "../status/statusReplyStore";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useAssistantOverviewStore } from "./assistantOverviewStore";
import { recommendationTextFor, useSendToThread } from "./useAssistant";

// Fork-owned. The Status tab in the Assistant. The Assistant has no board of
// its own worth reading (its workstreams show under Overview's Working on), so
// the tab shows one Project's board at a time behind a picker, defaulting to
// the Project with the most waiting on the user. Every action goes to that
// Project's coordinator, the same way Overview's Needs you rows do.

const projectKey = (project: EnvironmentProject) => `${project.environmentId}:${project.id}`;

export function AssistantStatusBoard(props: {
  /** Projects in the Assistant's reach, excluding the Assistant itself. */
  readonly projects: ReadonlyArray<EnvironmentProject>;
}) {
  const storedKey = useAssistantOverviewStore((state) => state.statusProjectKey);
  const setStoredKey = useAssistantOverviewStore((state) => state.setStatusProjectKey);
  const options = useMemo(
    () =>
      props.projects
        .map((project) => ({
          project,
          waiting: countStatusesNeedingUser(project.assistant?.statuses),
        }))
        .toSorted(
          (a, b) => b.waiting - a.waiting || a.project.title.localeCompare(b.project.title),
        ),
    [props.projects],
  );
  const selected =
    options.find((option) => projectKey(option.project) === storedKey)?.project ??
    options[0]?.project ??
    null;

  if (selected === null) {
    return (
      <p className="px-3 py-4 text-sm text-muted-foreground">
        No Projects with a coordinator yet. Create one and its Status board shows here.
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="assistant-status-board">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Select
          value={projectKey(selected)}
          items={Object.fromEntries(
            options.map((option) => [projectKey(option.project), option.project.title]),
          )}
          onValueChange={(value) => {
            if (value) setStoredKey(value);
          }}
        >
          <SelectTrigger size="sm" aria-label="Project" className="w-auto min-w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {options.map((option) => (
              <SelectItem key={projectKey(option.project)} value={projectKey(option.project)}>
                <span className="flex items-center gap-1.5">
                  <ProjectFavicon project={option.project} className="size-3.5 shrink-0" />
                  {option.project.title}
                  {option.waiting > 0 ? (
                    <span className="text-xs text-warning-foreground tabular-nums">
                      {option.waiting}
                    </span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="min-h-0 flex-1">
        <CoordinatorBoard key={projectKey(selected)} project={selected} />
      </div>
    </div>
  );
}

function CoordinatorBoard({ project }: { project: EnvironmentProject }) {
  const navigate = useNavigate();
  const send = useSendToThread();
  const serverConfig = useServerConfigs().get(project.environmentId) ?? null;
  const coordinatorId = project.assistant!.coordinatorThreadId as ThreadId;
  const coordinatorRef = useMemo(
    () => scopeThreadRef(project.environmentId, coordinatorId),
    [coordinatorId, project.environmentId],
  );
  const coordinator = useThreadShell(coordinatorRef);
  // Recommendations sent from here this session; the row reads as pending
  // until the coordinator records the answer.
  const [sent, setSent] = useState<ReadonlySet<string>>(() => new Set());

  const openCoordinator = (status: ProjectStatus) => {
    useStatusReplyStore
      .getState()
      .setTag(scopedThreadKey(coordinatorRef), statusReplyTagFor(status));
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(coordinatorRef),
    });
  };

  const goWithRecommendation = async (status: ProjectStatus) => {
    const decision = status.decision;
    const text = recommendationTextFor(status);
    if (decision === undefined || text === null) return;
    const busy =
      coordinator?.session?.status === "running" || coordinator?.session?.status === "starting";
    // A busy coordinator would be steered mid-turn; its own composer queues instead.
    if (busy || coordinator === null) {
      openCoordinator(status);
      return;
    }
    const key = recommendationKey(status, decision);
    setSent((current) => new Set(current).add(key));
    const ok = await send({
      environmentId: project.environmentId,
      threadId: coordinatorId,
      text,
      runtimeMode: coordinator.runtimeMode,
    });
    if (!ok)
      setSent((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
  };

  if (serverConfig?.environment.capabilities.projectStatus !== true) {
    return (
      <p className="px-3 py-4 text-sm text-muted-foreground">
        This Project's server has no Status board.
      </p>
    );
  }

  return (
    <ProjectStatusPanelContent
      threadRef={coordinatorRef}
      project={project}
      stallMinutes={statusStallMinutesOf(serverConfig.settings?.statusStallMinutes)}
      onReply={openCoordinator}
      onAskForUpdate={openCoordinator}
      onGoWithRecommendation={(status) => void goWithRecommendation(status)}
      sentRecommendations={sent}
    />
  );
}
