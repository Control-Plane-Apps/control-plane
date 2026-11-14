import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  ASSISTANT_BRIEF_PROMPT,
  ASSISTANT_BRIEF_SCHEDULE_ID,
  ASSISTANT_CHECK_IN_PROMPT,
  ASSISTANT_CHECK_IN_SCHEDULE_ID,
  assistantBriefCron,
  assistantCheckInCron,
  type AssistantBriefDays,
  type AssistantCheckInHours,
  type AssistantSettings,
  type AssistantSettingsPatch,
  DEFAULT_SERVER_SETTINGS,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ClockIcon } from "lucide-react";
import { useMemo } from "react";

import { useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { usePrimaryEnvironment } from "~/state/environments";
import { ProjectFavicon } from "../ProjectFavicon";
import { useScheduleActions } from "../schedules/useScheduleActions";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { useGlobalAssistantProject, useProjectsWithoutAssistant } from "./useAssistant";

// Fork-owned. Settings, Assistant: the morning brief, what the Assistant can
// reach, and what it may do for the user. The brief and check-ins are
// schedules on the Assistant's Project, off until the user turns them on,
// since each run costs model usage.

const TIME_OPTIONS = ["06:00", "06:30", "07:00", "07:30", "08:00", "08:30", "09:00", "10:00"];

function formatTime(value: string): string {
  const [hours, minutes] = value.split(":").map((part) => Number.parseInt(part, 10));
  const date = new Date(2000, 0, 1, hours ?? 0, minutes ?? 0);
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

const DAYS_LABEL: Record<AssistantBriefDays, string> = {
  weekdays: "Weekdays",
  "every-day": "Every day",
};

const CHECK_IN_LABEL: Record<string, string> = {
  "0": "Off",
  "1": "Every hour",
  "2": "2 hours",
  "4": "4 hours",
};

export function AssistantSettingsPage() {
  const environment = usePrimaryEnvironment();
  const assistantProject = useGlobalAssistantProject();
  const projects = useProjectsWithoutAssistant();
  const scheduleActions = useScheduleActions();
  const environmentId = environment?.environmentId ?? null;
  const updateSettings = useUpdateEnvironmentSettings(
    environmentId ?? ("" as Parameters<typeof useUpdateEnvironmentSettings>[0]),
  );
  const settings: AssistantSettings =
    environment?.serverConfig?.settings.assistant ?? DEFAULT_SERVER_SETTINGS.assistant;
  const liveProjects = useMemo(
    () =>
      projects.filter(
        (project) =>
          project.environmentId === environmentId &&
          project.assistant != null &&
          project.assistant.archivedAt == null,
      ),
    [environmentId, projects],
  );

  const patch = (change: AssistantSettingsPatch) => {
    if (environmentId === null) return;
    void updateSettings({ assistant: change });
  };

  const schedules = assistantProject?.assistant?.schedules ?? [];
  const brief = schedules.find((schedule) => schedule.id === ASSISTANT_BRIEF_SCHEDULE_ID);
  const checkIn = schedules.find((schedule) => schedule.id === ASSISTANT_CHECK_IN_SCHEDULE_ID);
  const projectRef =
    assistantProject === null
      ? null
      : scopeProjectRef(assistantProject.environmentId, assistantProject.id);

  const saveBrief = (input: { enabled: boolean; time: string; days: AssistantBriefDays }) => {
    if (projectRef === null) return;
    void scheduleActions.save(projectRef, {
      id: ASSISTANT_BRIEF_SCHEDULE_ID,
      name: "Morning brief",
      cron: assistantBriefCron(input.time, input.days),
      target: "coordinator",
      enabled: input.enabled,
      ...(brief ? { updatedAt: brief.updatedAt } : { prompt: ASSISTANT_BRIEF_PROMPT }),
    });
  };

  const saveCheckIn = (hours: AssistantCheckInHours) => {
    patch({ checkInHours: hours });
    if (projectRef === null) return;
    const cron = assistantCheckInCron(hours);
    if (cron === null) {
      if (checkIn?.enabled) void scheduleActions.setEnabled(projectRef, checkIn.id, false);
      return;
    }
    void scheduleActions.save(projectRef, {
      id: ASSISTANT_CHECK_IN_SCHEDULE_ID,
      name: "Check-in",
      cron,
      target: "coordinator",
      enabled: true,
      ...(checkIn ? { updatedAt: checkIn.updatedAt } : { prompt: ASSISTANT_CHECK_IN_PROMPT }),
    });
  };

  const reach = settings.projects;
  const toggleProject = (projectId: string) => {
    const all = liveProjects.map((project) => project.id as string);
    const current = reach ?? all;
    const next = current.includes(projectId)
      ? current.filter((id) => id !== projectId)
      : [...current, projectId];
    patch({ projects: all.every((id) => next.includes(id)) ? null : next });
  };

  const navigate = useNavigate();
  const needsAssistant = assistantProject === null;
  const briefEnabled = brief?.enabled === true;

  return (
    <SettingsPageContainer>
      <h1 className="px-3 text-xl font-semibold text-foreground sm:px-4">Assistant</h1>

      <SettingsSection title="Morning brief">
        <SettingsRow
          title="Send a morning brief"
          description={
            needsAssistant
              ? "Open the Assistant once to set this up."
              : "Runs the Assistant on a schedule, which uses your model plan."
          }
          control={
            <Switch
              aria-label="Send a morning brief"
              checked={briefEnabled}
              disabled={needsAssistant}
              onCheckedChange={(checked) =>
                saveBrief({
                  enabled: checked === true,
                  time: settings.briefTime,
                  days: settings.briefDays,
                })
              }
            />
          }
        />
        <SettingsRow
          title="Time"
          control={
            <Select
              value={settings.briefTime}
              onValueChange={(value) => {
                const time = String(value);
                patch({ briefTime: time });
                if (brief) saveBrief({ enabled: brief.enabled, time, days: settings.briefDays });
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-32" aria-label="Brief time">
                <SelectValue>{formatTime(settings.briefTime)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {TIME_OPTIONS.map((time) => (
                  <SelectItem key={time} hideIndicator value={time}>
                    {formatTime(time)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Days"
          control={
            <Select
              value={settings.briefDays}
              onValueChange={(value) => {
                const days = value as AssistantBriefDays;
                patch({ briefDays: days });
                if (brief) saveBrief({ enabled: brief.enabled, time: settings.briefTime, days });
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-32" aria-label="Brief days">
                <SelectValue>{DAYS_LABEL[settings.briefDays]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="weekdays">
                  Weekdays
                </SelectItem>
                <SelectItem hideIndicator value="every-day">
                  Every day
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Reach">
        <SettingsRow
          title="Projects"
          control={
            <div className="flex flex-wrap justify-end gap-1.5">
              {liveProjects.length === 0 ? (
                <span className="text-xs text-muted-foreground">No Projects yet</span>
              ) : (
                liveProjects.map((project) => {
                  const on = reach === null || reach.includes(project.id);
                  return (
                    <button
                      key={project.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleProject(project.id)}
                      className={cn(
                        "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs",
                        on
                          ? "border-input bg-popover text-foreground"
                          : "border-dashed border-border text-muted-foreground line-through",
                      )}
                    >
                      <ProjectFavicon project={project} className="size-3.5" />
                      {project.title}
                    </button>
                  );
                })
              )}
            </div>
          }
        />
        <SettingsRow
          title="Workspaces"
          control={
            <Select
              value={settings.workspaces}
              onValueChange={(value) =>
                patch({ workspaces: value as AssistantSettings["workspaces"] })
              }
            >
              <SelectTrigger size="sm" className="w-full sm:w-36" aria-label="Workspaces">
                <SelectValue>{settings.workspaces === "read" ? "Read only" : "Off"}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="read">
                  Read only
                </SelectItem>
                <SelectItem hideIndicator value="off">
                  Off
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Tasks"
          control={
            <Select
              value={settings.tasks}
              onValueChange={(value) => patch({ tasks: value as AssistantSettings["tasks"] })}
            >
              <SelectTrigger size="sm" className="w-full sm:w-36" aria-label="Tasks">
                <SelectValue>
                  {settings.tasks === "edit"
                    ? "Read and edit"
                    : settings.tasks === "read"
                      ? "Read only"
                      : "Off"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="edit">
                  Read and edit
                </SelectItem>
                <SelectItem hideIndicator value="read">
                  Read only
                </SelectItem>
                <SelectItem hideIndicator value="off">
                  Off
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Acting for you">
        <SettingsRow
          title="Message Project coordinators"
          control={
            <Switch
              aria-label="Message Project coordinators"
              checked={settings.messageCoordinators}
              onCheckedChange={(checked) => patch({ messageCoordinators: checked === true })}
            />
          }
        />
        <SettingsRow
          title="New tasks"
          control={
            <Select
              value={settings.newTasks}
              onValueChange={(value) => patch({ newTasks: value as AssistantSettings["newTasks"] })}
            >
              <SelectTrigger size="sm" className="w-full sm:w-36" aria-label="New tasks">
                <SelectValue>
                  {settings.newTasks === "propose" ? "Propose first" : "Add directly"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="propose">
                  Propose first
                </SelectItem>
                <SelectItem hideIndicator value="create">
                  Add directly
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Answer questions for you"
          description="The Assistant never answers a Project's Status question for you."
          control={
            <Select value="never" disabled>
              <SelectTrigger size="sm" className="w-full sm:w-36" aria-label="Answer questions">
                <SelectValue>Never</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="never">
                  Never
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow
          title="Check in every"
          description="Each check-in runs the Assistant and any coordinator it asks."
          control={
            <Select
              value={String(settings.checkInHours)}
              disabled={needsAssistant}
              onValueChange={(value) => saveCheckIn(Number(value) as AssistantCheckInHours)}
            >
              <SelectTrigger size="sm" className="w-full sm:w-36" aria-label="Check in every">
                <SelectValue>{CHECK_IN_LABEL[String(settings.checkInHours)]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {(["0", "1", "2", "4"] as const).map((value) => (
                  <SelectItem key={value} hideIndicator value={value}>
                    {CHECK_IN_LABEL[value]}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection title="Schedules">
        <SettingsRow
          title="All schedules"
          description="Every schedule across your Projects and the Assistant, in one list."
          control={
            <Button
              size="sm"
              variant="outline"
              type="button"
              onClick={() => void navigate({ to: "/schedules" })}
            >
              <ClockIcon />
              Open
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Model">
        <SettingsRow
          title="Assistant model"
          description="New Assistant sessions use the default model for new threads."
          control={
            <span className="font-mono text-xs text-muted-foreground">
              {assistantProject?.defaultModelSelection?.model ??
                environment?.serverConfig?.settings.defaultModelSelection?.model ??
                "Default"}
            </span>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
